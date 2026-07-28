/**
 * The posting engine.
 *
 * Every rupee that enters the system passes through `postJournalEntry`. Nothing
 * else in the codebase may insert into `journal_lines` directly. That single
 * chokepoint is what lets us guarantee, for the life of the product:
 *
 *   - every entry balances (debits == credits)
 *   - nothing posts into a closed period
 *   - nothing posts to a group/inactive account
 *   - posted entries are never mutated, only reversed
 *   - every post is audit-logged with who/when/why
 *
 * If you find yourself wanting to bypass this to "just fix one number", the
 * answer is a reversing entry. That's not bureaucracy — it's the difference
 * between books you can defend in an audit and books you can't.
 */

import { and, eq, sql, inArray, isNull, lte, gte, desc } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { withOrg } from "@/db/client";
import {
  accounts,
  auditLog,
  documentSequences,
  invoices,
  journalEntries,
  journalLines,
  organizations,
  paymentAllocations,
  type AccountSubtype,
} from "@/db/schema";

/* ────────────────────────────────────────────────────────────────────────────
 * Errors
 * ──────────────────────────────────────────────────────────────────────────*/

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * A line as callers express it. `amountMinor` is signed:
 *   positive = debit, negative = credit.
 * Use the `debit()` / `credit()` helpers rather than writing signs by hand —
 * a sign error is the single easiest way to corrupt a ledger.
 */
export type PostingLine = {
  accountId: string;
  amountMinor: bigint;
  memo?: string;
  contactId?: string | null;
  projectId?: string | null;
  costCenterId?: string | null;
  /** Defaults to the org's base currency at rate 1. */
  currency?: string;
  exchangeRate?: string;
  originalAmountMinor?: bigint;
};

export type PostEntryInput = {
  orgId: string;
  entryDate: string; // YYYY-MM-DD
  lines: PostingLine[];
  source?: (typeof journalEntries.$inferInsert)["source"];
  sourceDocumentId?: string | null;
  reference?: string | null;
  memo?: string | null;
  userId?: string | null;
};

/** Build a debit line. Amount must be positive; the sign is applied for you. */
export function debit(
  accountId: string,
  amountMinor: bigint,
  rest: Omit<PostingLine, "accountId" | "amountMinor"> = {},
): PostingLine {
  if (amountMinor < 0n) {
    throw new LedgerError(
      `debit() expects a positive amount, got ${amountMinor}. To credit, use credit().`,
      "NEGATIVE_DEBIT",
    );
  }
  return { accountId, amountMinor, ...rest };
}

/** Build a credit line. Amount must be positive; it is negated internally. */
export function credit(
  accountId: string,
  amountMinor: bigint,
  rest: Omit<PostingLine, "accountId" | "amountMinor"> = {},
): PostingLine {
  if (amountMinor < 0n) {
    throw new LedgerError(
      `credit() expects a positive amount, got ${amountMinor}. To debit, use debit().`,
      "NEGATIVE_CREDIT",
    );
  }
  return { accountId, amountMinor: -amountMinor, ...rest };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Guards
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * The core invariant. Debits and credits must cancel exactly.
 *
 * Note this runs on bigints, so there is no tolerance and no epsilon: it is
 * either zero or it is a bug. Floating-point money would force us to accept
 * "close enough", which is how ledgers drift.
 */
function assertBalanced(lines: PostingLine[]): void {
  if (lines.length < 2) {
    throw new LedgerError(
      `A journal entry needs at least two lines, got ${lines.length}. Single-sided postings are never valid double-entry.`,
      "UNBALANCED",
    );
  }

  const sum = lines.reduce((acc, l) => acc + l.amountMinor, 0n);
  if (sum !== 0n) {
    const debits = lines.filter((l) => l.amountMinor > 0n).reduce((a, l) => a + l.amountMinor, 0n);
    const credits = lines.filter((l) => l.amountMinor < 0n).reduce((a, l) => a - l.amountMinor, 0n);
    throw new LedgerError(
      `Entry does not balance. Debits ${debits}, credits ${credits}, difference ${sum} (minor units).`,
      "UNBALANCED",
    );
  }

  if (lines.some((l) => l.amountMinor === 0n)) {
    throw new LedgerError("Entry contains a zero-amount line. Drop the line instead.", "ZERO_LINE");
  }
}

/**
 * Period lock. `booksClosedThrough` is the last date that is frozen; anything on
 * or before it is immutable. Reopening is a deliberate, audited act.
 */
async function assertPeriodOpen(tx: DbOrTx, orgId: string, entryDate: string): Promise<void> {
  const [org] = await tx
    .select({ closedThrough: organizations.booksClosedThrough })
    .from(organizations)
    .where(eq(organizations.id, orgId));

  if (!org) {
    throw new LedgerError(`Organization ${orgId} not found.`, "ORG_NOT_FOUND");
  }

  if (org.closedThrough && entryDate <= org.closedThrough) {
    throw new LedgerError(
      `Cannot post to ${entryDate}: books are closed through ${org.closedThrough}. Post to a later date, or reopen the period.`,
      "PERIOD_CLOSED",
    );
  }
}

/**
 * Accounts must exist, belong to this org, be postable leaves, and be active.
 * Cross-org leakage is the failure mode that matters most here — one wrong
 * accountId would silently move money between tenants' books.
 */
async function assertAccountsPostable(
  tx: DbOrTx,
  orgId: string,
  accountIds: string[],
): Promise<void> {
  const unique = [...new Set(accountIds)];
  const found = await tx
    .select({
      id: accounts.id,
      orgId: accounts.orgId,
      code: accounts.code,
      name: accounts.name,
      isGroup: accounts.isGroup,
      isActive: accounts.isActive,
      deletedAt: accounts.deletedAt,
    })
    .from(accounts)
    .where(inArray(accounts.id, unique));

  const byId = new Map(found.map((a) => [a.id, a]));

  for (const id of unique) {
    const acct = byId.get(id);
    if (!acct) {
      throw new LedgerError(`Account ${id} does not exist.`, "ACCOUNT_NOT_FOUND");
    }
    if (acct.orgId !== orgId) {
      throw new LedgerError(
        `Account ${acct.code} belongs to a different organization. Refusing to post across tenants.`,
        "CROSS_TENANT_ACCOUNT",
      );
    }
    if (acct.deletedAt) {
      throw new LedgerError(`Account ${acct.code} (${acct.name}) is deleted.`, "ACCOUNT_DELETED");
    }
    if (acct.isGroup) {
      throw new LedgerError(
        `Account ${acct.code} (${acct.name}) is a group header. Post to a leaf account instead.`,
        "ACCOUNT_IS_GROUP",
      );
    }
    if (!acct.isActive) {
      throw new LedgerError(`Account ${acct.code} (${acct.name}) is inactive.`, "ACCOUNT_INACTIVE");
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Document numbering
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Claim the next number for a document type, gap-free.
 *
 * `FOR UPDATE` serialises concurrent claimants on this row: two simultaneous
 * invoice posts will queue rather than both reading `nextNumber = 42`. This is
 * why numbering lives in a table and not in a Postgres sequence — sequences are
 * non-transactional and leave gaps on rollback, which auditors flag.
 *
 * Must be called inside a transaction.
 */
export async function claimNextNumber(
  tx: DbOrTx,
  orgId: string,
  documentType:
    | "invoice"
    | "bill"
    | "payment"
    | "journal"
    | "credit_note"
    | "debit_note"
    | "contra"
    | "sales_order"
    | "purchase_order"
    | "grn"
    | "delivery_note",
): Promise<string> {
  const rows = await tx.execute(
    sql`select id, prefix, next_number, pad_width
        from document_sequences
        where org_id = ${orgId} and document_type = ${documentType}
        for update`,
  );

  const row = rows[0] as
    | { id: string; prefix: string; next_number: string; pad_width: number }
    | undefined;

  if (!row) {
    throw new LedgerError(
      `No document sequence configured for "${documentType}" in this organization.`,
      "SEQUENCE_MISSING",
    );
  }

  const current = BigInt(row.next_number);

  await tx
    .update(documentSequences)
    .set({ nextNumber: current + 1n, updatedAt: new Date() })
    .where(eq(documentSequences.id, row.id));

  return `${row.prefix}${current.toString().padStart(row.pad_width, "0")}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Posting
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Post a balanced entry to the general ledger.
 *
 * Runs every guard, claims an entry number, writes header + lines, and audit-logs
 * — all inside one transaction. Either the whole entry lands or none of it does;
 * there is no state where a half-posted entry exists.
 *
 * Pass an existing `tx` to compose this with other work (e.g. creating an invoice
 * and posting its GL impact atomically).
 */
export async function postJournalEntry(
  input: PostEntryInput,
  existingTx?: DbOrTx,
): Promise<{ entryId: string; entryNumber: string }> {
  const run = async (tx: DbOrTx) => {
    assertBalanced(input.lines);
    await assertPeriodOpen(tx, input.orgId, input.entryDate);
    await assertAccountsPostable(
      tx,
      input.orgId,
      input.lines.map((l) => l.accountId),
    );

    const [org] = await tx
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, input.orgId));

    const entryNumber = await claimNextNumber(tx, input.orgId, "journal");
    const now = new Date();

    const [entry] = await tx
      .insert(journalEntries)
      .values({
        orgId: input.orgId,
        entryNumber,
        entryDate: input.entryDate,
        status: "posted",
        source: input.source ?? "manual",
        sourceDocumentId: input.sourceDocumentId ?? null,
        reference: input.reference ?? null,
        memo: input.memo ?? null,
        postedAt: now,
        postedByUserId: input.userId ?? null,
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: journalEntries.id });

    await tx.insert(journalLines).values(
      input.lines.map((line, i) => ({
        orgId: input.orgId,
        entryId: entry.id,
        accountId: line.accountId,
        lineNumber: i + 1,
        amountMinor: line.amountMinor,
        originalAmountMinor: line.originalAmountMinor ?? line.amountMinor,
        currency: line.currency ?? org.baseCurrency,
        exchangeRate: line.exchangeRate ?? "1",
        memo: line.memo ?? null,
        contactId: line.contactId ?? null,
        projectId: line.projectId ?? null,
        costCenterId: line.costCenterId ?? null,
      })),
    );

    await writeAudit(tx, {
      orgId: input.orgId,
      userId: input.userId ?? null,
      action: "journal.posted",
      entityType: "journal_entry",
      entityId: entry.id,
      after: {
        entryNumber,
        entryDate: input.entryDate,
        source: input.source ?? "manual",
        lineCount: input.lines.length,
        totalDebitMinor: input.lines
          .filter((l) => l.amountMinor > 0n)
          .reduce((a, l) => a + l.amountMinor, 0n)
          .toString(),
      },
    });

    return { entryId: entry.id, entryNumber };
  };

  return existingTx ? run(existingTx) : withOrg(input.orgId, run);
}

/**
 * Reverse a posted entry by posting its mirror image.
 *
 * We do not delete or edit the original — it stays in the ledger forever, marked
 * `reversed`, with the new entry pointing back at it. Both entries appear in the
 * audit trail and net to zero.
 */
export async function reverseJournalEntry(args: {
  orgId: string;
  entryId: string;
  reversalDate?: string;
  reason: string;
  userId?: string | null;
}): Promise<{ entryId: string; entryNumber: string }> {
  if (!args.reason?.trim()) {
    throw new LedgerError(
      "A reversal requires a reason. This is recorded permanently in the audit log.",
      "REASON_REQUIRED",
    );
  }

  return withOrg(args.orgId, async (tx) => {
    const [original] = await tx
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, args.entryId), eq(journalEntries.orgId, args.orgId)));

    if (!original) {
      throw new LedgerError(`Entry ${args.entryId} not found.`, "ENTRY_NOT_FOUND");
    }
    if (original.status === "reversed") {
      throw new LedgerError(
        `Entry ${original.entryNumber} is already reversed.`,
        "ALREADY_REVERSED",
      );
    }
    if (original.status !== "posted") {
      throw new LedgerError(
        `Only posted entries can be reversed; ${original.entryNumber} is ${original.status}.`,
        "NOT_POSTED",
      );
    }

    const originalLines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, args.entryId));

    const reversalDate = args.reversalDate ?? original.entryDate;

    // Flip every sign. Balanced input guarantees balanced output.
    const reversed = await postJournalEntry(
      {
        orgId: args.orgId,
        entryDate: reversalDate,
        source: original.source,
        sourceDocumentId: original.sourceDocumentId,
        reference: original.reference,
        memo: `Reversal of ${original.entryNumber}: ${args.reason}`,
        userId: args.userId,
        lines: originalLines.map((l) => ({
          accountId: l.accountId,
          amountMinor: -l.amountMinor,
          originalAmountMinor: -l.originalAmountMinor,
          currency: l.currency,
          exchangeRate: l.exchangeRate,
          memo: l.memo ?? undefined,
          contactId: l.contactId,
          projectId: l.projectId,
          costCenterId: l.costCenterId,
        })),
      },
      tx,
    );

    await tx
      .update(journalEntries)
      .set({ status: "reversed", updatedAt: new Date() })
      .where(eq(journalEntries.id, args.entryId));

    await tx
      .update(journalEntries)
      .set({ reversesEntryId: args.entryId })
      .where(eq(journalEntries.id, reversed.entryId));

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "journal.reversed",
      entityType: "journal_entry",
      entityId: args.entryId,
      before: { status: original.status },
      after: { status: "reversed", reversalEntryId: reversed.entryId },
      reason: args.reason,
    });

    return reversed;
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Account resolution
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Find the org's control account for a given role (AR, AP, tax payable, …).
 *
 * Document posting must never hardcode account codes — a user renaming "1120" to
 * "1125" would silently break invoicing. Resolving by subtype means the chart of
 * accounts stays fully user-editable.
 */
export async function resolveControlAccount(
  tx: DbOrTx,
  orgId: string,
  subtype: AccountSubtype,
): Promise<string> {
  const [account] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.orgId, orgId),
        eq(accounts.subtype, subtype),
        eq(accounts.isSystem, true),
        eq(accounts.isActive, true),
        eq(accounts.isGroup, false),
        isNull(accounts.deletedAt),
      ),
    )
    .limit(1);

  if (!account) {
    throw new LedgerError(
      `No system control account configured for "${subtype}". Run chart-of-accounts setup for this organization.`,
      "CONTROL_ACCOUNT_MISSING",
    );
  }
  return account.id;
}

/**
 * The dedicated INPUT-tax (ITC) account — reclaimable GST paid on purchases, an
 * ASSET. Kept separate from the output-tax liability (tax_payable) so input and
 * output tax reconcile independently, which shared-account netting cannot do.
 *
 * It resolves to the org's system `other_current_asset` account (the "Input GST
 * Credit" account, code 1140), which is the only leaf account of that subtype
 * carrying `isSystem`.
 */
export async function resolveInputTaxAccount(tx: DbOrTx, orgId: string): Promise<string> {
  return resolveControlAccount(tx, orgId, "other_current_asset");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Audit
 * ──────────────────────────────────────────────────────────────────────────*/

export async function writeAudit(
  tx: DbOrTx,
  entry: {
    orgId: string;
    userId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    orgId: entry.orgId,
    userId: entry.userId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent ?? null,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Integrity checks
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Assert that every posted entry in the org balances to zero.
 *
 * The posting engine already guarantees this, so a non-empty result means
 * something wrote to `journal_lines` behind the engine's back. Worth running in
 * CI and on a schedule — it is the canary for the whole system.
 */
export async function findUnbalancedEntries(
  orgId: string,
): Promise<Array<{ entryId: string; entryNumber: string; differenceMinor: bigint }>> {
  const rows = await withOrg(orgId, (tx) =>
    tx.execute(sql`
    select je.id            as entry_id,
           je.entry_number  as entry_number,
           sum(jl.amount_minor) as difference
    from journal_entries je
    join journal_lines jl on jl.entry_id = je.id
    where je.org_id = ${orgId}
      and je.status in ('posted', 'reversed')
    group by je.id, je.entry_number
    having sum(jl.amount_minor) <> 0
  `),
  );

  return (rows as unknown as Array<Record<string, string>>).map((r) => ({
    entryId: r.entry_id,
    entryNumber: r.entry_number,
    differenceMinor: BigInt(r.difference),
  }));
}

/**
 * Assert that each invoice's cached `amountPaidMinor` equals the sum of its
 * allocations. Catches drift in the one denormalized column we allow.
 */
export async function verifyInvoiceBalances(orgId: string): Promise<
  Array<{
    invoiceId: string;
    invoiceNumber: string;
    cachedMinor: bigint;
    actualMinor: bigint;
  }>
> {
  const rows = await withOrg(orgId, (tx) =>
    tx.execute(sql`
    select i.id              as invoice_id,
           i.invoice_number  as invoice_number,
           i.amount_paid_minor as cached,
           coalesce(sum(pa.amount_minor), 0) as actual
    from invoices i
    left join payment_allocations pa
           on pa.invoice_id = i.id and pa.deleted_at is null
    where i.org_id = ${orgId}
      and i.deleted_at is null
    group by i.id, i.invoice_number, i.amount_paid_minor
    having i.amount_paid_minor <> coalesce(sum(pa.amount_minor), 0)
  `),
  );

  return (rows as unknown as Array<Record<string, string>>).map((r) => ({
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number,
    cachedMinor: BigInt(r.cached),
    actualMinor: BigInt(r.actual),
  }));
}
