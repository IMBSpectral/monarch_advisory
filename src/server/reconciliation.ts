/**
 * Bank reconciliation — turning a bank-feed line into a settled fact.
 *
 * A `bank_transactions` row is what the *bank* says happened. Reconciliation is
 * the act of proving each such line against the *books*, in one of two ways:
 *
 *   • MATCH — the line corresponds to a payment we already recorded (a customer
 *     receipt, a vendor payment). That payment already posted the cash movement
 *     to the GL, so matching creates NO new journal entry: it just links the feed
 *     line to the existing payment + its entry and marks it reconciled.
 *
 *   • CATEGORIZE — the line is bank-only (interest earned, bank charges, a fee)
 *     with no document behind it. Here we DO post a journal entry: the bank's GL
 *     cash account against an income/expense category, then link + reconcile.
 *
 * Either way the feed line ends up with `matched_entry_id` / `matched_payment_id`
 * set, `status = 'reconciled'`, and `reconciled_at` stamped — so the work is
 * durable and survives a reload, which the old client-only screen did not do.
 *
 * Unreconciling reverses a categorization (the entry we posted is reversed, never
 * deleted) or simply unlinks a match (the payment's own entry is left untouched).
 */

import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { withOrg } from "@/db/client";
import { accounts, bankAccounts, bankTransactions, payments } from "@/db/schema";
import {
  LedgerError,
  credit,
  debit,
  postJournalEntry,
  reverseJournalEntry,
  writeAudit,
} from "./ledger";

/** Load a feed line that must exist, belong to the org, and be unreconciled. */
async function loadUnreconciled(tx: DbOrTx, orgId: string, bankTransactionId: string) {
  const [txn] = await tx
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.id, bankTransactionId), eq(bankTransactions.orgId, orgId)));
  if (!txn) {
    throw new LedgerError("Bank transaction not found.", "BANK_TXN_NOT_FOUND");
  }
  if (txn.status !== "unreconciled") {
    throw new LedgerError(
      `This line is already ${txn.status}. Undo it first to change how it is reconciled.`,
      "BANK_TXN_NOT_UNRECONCILED",
    );
  }
  return txn;
}

/** The GL cash account paired with a bank account. */
async function bankGlAccountId(tx: DbOrTx, orgId: string, bankAccountId: string): Promise<string> {
  const [ba] = await tx
    .select({ accountId: bankAccounts.accountId })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.orgId, orgId)));
  if (!ba) throw new LedgerError("Bank account not found.", "BANK_ACCOUNT_NOT_FOUND");
  return ba.accountId;
}

/**
 * MATCH a feed line to a payment we already recorded. No GL entry is posted — the
 * payment already moved the cash — we only prove and link the two.
 */
export async function matchTransactionToPayment(args: {
  orgId: string;
  bankTransactionId: string;
  paymentId: string;
  userId?: string | null;
}): Promise<{ bankTransactionId: string; matchedEntryId: string | null; paymentNumber: string }> {
  const { orgId, bankTransactionId, paymentId } = args;
  return withOrg(orgId, async (tx) => {
    const txn = await loadUnreconciled(tx, orgId, bankTransactionId);
    const glAccountId = await bankGlAccountId(tx, orgId, txn.bankAccountId);

    const [pmt] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.orgId, orgId)));
    if (!pmt) throw new LedgerError("Payment not found.", "PAYMENT_NOT_FOUND");

    // The payment must have moved money through *this* bank's GL account.
    if (pmt.depositAccountId !== glAccountId) {
      throw new LedgerError(
        "That payment settled through a different account, so it can't match this bank line.",
        "PAYMENT_ACCOUNT_MISMATCH",
      );
    }

    // Direction must agree: money in ↔ a receipt, money out ↔ a payment out.
    const feedIsInflow = txn.amountMinor > 0n;
    const paymentIsInflow = pmt.direction === "inbound";
    if (feedIsInflow !== paymentIsInflow) {
      throw new LedgerError(
        "The payment's direction is opposite to this bank line (one is money in, the other money out).",
        "PAYMENT_DIRECTION_MISMATCH",
      );
    }

    // Amounts must be equal to the paisa. A different amount is a different event.
    if (pmt.amountMinor !== (feedIsInflow ? txn.amountMinor : -txn.amountMinor)) {
      throw new LedgerError(
        "The payment amount does not equal this bank line. Record or adjust the payment first.",
        "PAYMENT_AMOUNT_MISMATCH",
      );
    }

    // A payment can back exactly one feed line.
    const [already] = await tx
      .select({ id: bankTransactions.id })
      .from(bankTransactions)
      .where(
        and(eq(bankTransactions.orgId, orgId), eq(bankTransactions.matchedPaymentId, paymentId)),
      );
    if (already) {
      throw new LedgerError(
        "That payment is already matched to another bank line.",
        "PAYMENT_ALREADY_MATCHED",
      );
    }

    const now = new Date();
    await tx
      .update(bankTransactions)
      .set({
        status: "reconciled",
        matchedPaymentId: paymentId,
        matchedEntryId: pmt.journalEntryId ?? null,
        reconciledAt: now,
        updatedAt: now,
      })
      .where(and(eq(bankTransactions.id, bankTransactionId), eq(bankTransactions.orgId, orgId)));

    await writeAudit(tx, {
      orgId,
      userId: args.userId ?? null,
      action: "bank_txn.matched",
      entityType: "bank_transaction",
      entityId: bankTransactionId,
      after: { paymentId, paymentNumber: pmt.paymentNumber, entryId: pmt.journalEntryId },
    });

    return {
      bankTransactionId,
      matchedEntryId: pmt.journalEntryId ?? null,
      paymentNumber: pmt.paymentNumber,
    };
  });
}

/**
 * CATEGORIZE a bank-only feed line (interest, charges, fees) by posting it against
 * an income/expense account, then linking + reconciling. Money in credits the
 * category (income); money out debits it (expense). Either way the bank's GL cash
 * account takes the opposite side, so the GL cash balance moves to match the feed.
 */
export async function categorizeTransaction(args: {
  orgId: string;
  bankTransactionId: string;
  categoryAccountId: string;
  memo?: string | null;
  userId?: string | null;
}): Promise<{ bankTransactionId: string; entryId: string; entryNumber: string }> {
  const { orgId, bankTransactionId, categoryAccountId } = args;
  return withOrg(orgId, async (tx) => {
    const txn = await loadUnreconciled(tx, orgId, bankTransactionId);
    const glAccountId = await bankGlAccountId(tx, orgId, txn.bankAccountId);

    if (categoryAccountId === glAccountId) {
      throw new LedgerError(
        "Pick an income or expense category, not the bank account itself.",
        "CATEGORY_IS_BANK",
      );
    }

    const amount = txn.amountMinor > 0n ? txn.amountMinor : -txn.amountMinor;
    const inflow = txn.amountMinor > 0n;
    const memo = args.memo?.trim() || txn.description;

    // Inflow: DR bank / CR category (income). Outflow: DR category (expense) / CR bank.
    const lines = inflow
      ? [debit(glAccountId, amount, { memo }), credit(categoryAccountId, amount, { memo })]
      : [debit(categoryAccountId, amount, { memo }), credit(glAccountId, amount, { memo })];

    const entry = await postJournalEntry(
      {
        orgId,
        entryDate: txn.transactionDate,
        lines,
        source: "bank_transaction",
        sourceDocumentId: bankTransactionId,
        reference: txn.description,
        memo,
        userId: args.userId ?? null,
      },
      tx,
    );

    const now = new Date();
    await tx
      .update(bankTransactions)
      .set({
        status: "reconciled",
        matchedEntryId: entry.entryId,
        matchedPaymentId: null,
        reconciledAt: now,
        updatedAt: now,
      })
      .where(and(eq(bankTransactions.id, bankTransactionId), eq(bankTransactions.orgId, orgId)));

    await writeAudit(tx, {
      orgId,
      userId: args.userId ?? null,
      action: "bank_txn.categorized",
      entityType: "bank_transaction",
      entityId: bankTransactionId,
      after: { categoryAccountId, entryId: entry.entryId, entryNumber: entry.entryNumber },
    });

    return { bankTransactionId, entryId: entry.entryId, entryNumber: entry.entryNumber };
  });
}

/** EXCLUDE a feed line from reconciliation (e.g. a duplicate internal transfer). */
export async function excludeTransaction(args: {
  orgId: string;
  bankTransactionId: string;
  userId?: string | null;
}): Promise<{ bankTransactionId: string }> {
  const { orgId, bankTransactionId } = args;
  return withOrg(orgId, async (tx) => {
    await loadUnreconciled(tx, orgId, bankTransactionId);
    await tx
      .update(bankTransactions)
      .set({ status: "excluded", updatedAt: new Date() })
      .where(and(eq(bankTransactions.id, bankTransactionId), eq(bankTransactions.orgId, orgId)));
    await writeAudit(tx, {
      orgId,
      userId: args.userId ?? null,
      action: "bank_txn.excluded",
      entityType: "bank_transaction",
      entityId: bankTransactionId,
    });
    return { bankTransactionId };
  });
}

/**
 * UNDO a reconciliation. A categorization's posted entry is reversed (mirror
 * entry, never a delete); a match or exclusion is simply unlinked. The feed line
 * returns to `unreconciled` and can be handled again.
 */
export async function unreconcileTransaction(args: {
  orgId: string;
  bankTransactionId: string;
  reason: string;
  userId?: string | null;
}): Promise<{ bankTransactionId: string; reversedEntryId: string | null }> {
  const { orgId, bankTransactionId } = args;
  if (!args.reason?.trim()) {
    throw new LedgerError("Undoing a reconciliation needs a reason.", "REASON_REQUIRED");
  }

  // Read the row first so we know whether a posted entry must be reversed.
  const [txn] = await withOrg(orgId, (tx) =>
    tx
      .select()
      .from(bankTransactions)
      .where(and(eq(bankTransactions.id, bankTransactionId), eq(bankTransactions.orgId, orgId))),
  );
  if (!txn) throw new LedgerError("Bank transaction not found.", "BANK_TXN_NOT_FOUND");
  if (txn.status === "unreconciled") {
    throw new LedgerError("This line is already unreconciled.", "BANK_TXN_ALREADY_UNRECONCILED");
  }

  // A categorization owns its entry (entry set, no payment) → reverse it. A match
  // points at a payment's entry we don't own → leave that entry alone.
  const ownsEntry = txn.matchedEntryId !== null && txn.matchedPaymentId === null;
  let reversedEntryId: string | null = null;
  if (ownsEntry && txn.matchedEntryId) {
    await reverseJournalEntry({
      orgId,
      entryId: txn.matchedEntryId,
      reason: `Unreconciled bank line: ${args.reason.trim()}`,
      userId: args.userId ?? null,
    });
    reversedEntryId = txn.matchedEntryId;
  }

  await withOrg(orgId, async (tx) => {
    await tx
      .update(bankTransactions)
      .set({
        status: "unreconciled",
        matchedEntryId: null,
        matchedPaymentId: null,
        reconciledAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(bankTransactions.id, bankTransactionId), eq(bankTransactions.orgId, orgId)));
    await writeAudit(tx, {
      orgId,
      userId: args.userId ?? null,
      action: "bank_txn.unreconciled",
      entityType: "bank_transaction",
      entityId: bankTransactionId,
      before: { status: txn.status, matchedEntryId: txn.matchedEntryId },
      reason: args.reason.trim(),
    });
  });

  return { bankTransactionId, reversedEntryId };
}

/**
 * Everything the reconciliation workspace needs for one bank account: the feed-vs-
 * book summary, the lines still to reconcile, the lines already done, the payments
 * available to match against, and the income/expense categories to post bank-only
 * lines to.
 */
export async function getReconciliationData(orgId: string, bankAccountId: string) {
  return withOrg(orgId, async (tx) => {
    const [account] = await tx
      .select({
        id: bankAccounts.id,
        name: bankAccounts.name,
        accountId: bankAccounts.accountId,
        currency: bankAccounts.currency,
        feedBalanceMinor: bankAccounts.feedBalanceMinor,
      })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.orgId, orgId)));
    if (!account) throw new LedgerError("Bank account not found.", "BANK_ACCOUNT_NOT_FOUND");

    const txns = await tx
      .select({
        id: bankTransactions.id,
        date: bankTransactions.transactionDate,
        description: bankTransactions.description,
        amountMinor: bankTransactions.amountMinor,
        status: bankTransactions.status,
        matchedEntryId: bankTransactions.matchedEntryId,
        matchedPaymentId: bankTransactions.matchedPaymentId,
        reconciledAt: bankTransactions.reconciledAt,
      })
      .from(bankTransactions)
      .where(
        and(eq(bankTransactions.orgId, orgId), eq(bankTransactions.bankAccountId, bankAccountId)),
      )
      .orderBy(bankTransactions.transactionDate);

    // Payments settled through this bank's GL account that aren't matched yet.
    const matchedRows = await tx
      .select({ paymentId: bankTransactions.matchedPaymentId })
      .from(bankTransactions)
      .where(and(eq(bankTransactions.orgId, orgId), isNotNull(bankTransactions.matchedPaymentId)));
    const matchedPaymentIds = new Set(matchedRows.map((r) => r.paymentId));

    const pmtRows = await tx
      .select({
        id: payments.id,
        paymentNumber: payments.paymentNumber,
        direction: payments.direction,
        amountMinor: payments.amountMinor,
        paymentDate: payments.paymentDate,
        journalEntryId: payments.journalEntryId,
      })
      .from(payments)
      .where(and(eq(payments.orgId, orgId), eq(payments.depositAccountId, account.accountId)))
      .orderBy(payments.paymentDate);
    const candidatePayments = pmtRows.filter((p) => !matchedPaymentIds.has(p.id));

    // Income + expense leaves are the categories a bank-only line can post to.
    const cats = await tx
      .select({
        id: accounts.id,
        code: accounts.code,
        name: accounts.name,
        type: accounts.type,
      })
      .from(accounts)
      .where(
        and(eq(accounts.orgId, orgId), eq(accounts.isGroup, false), eq(accounts.isActive, true)),
      )
      .orderBy(accounts.code);
    const categoryAccounts = cats.filter((c) => c.type === "income" || c.type === "expense");

    // Book balance of the bank's GL account (all cash movements to date).
    const glBalance = await glBalanceFor(tx, orgId, account.accountId);

    const unreconciled = txns.filter((t) => t.status === "unreconciled");
    const reconciled = txns.filter((t) => t.status === "reconciled" || t.status === "excluded");

    const feedBalance = account.feedBalanceMinor ?? 0n;
    const unreconciledNet = unreconciled.reduce((s, t) => s + t.amountMinor, 0n);

    return {
      account: {
        id: account.id,
        name: account.name,
        glAccountId: account.accountId,
        currency: account.currency,
      },
      summary: {
        feedBalanceMinor: feedBalance.toString(),
        glBalanceMinor: glBalance.toString(),
        differenceMinor: (feedBalance - glBalance).toString(),
        unreconciledCount: unreconciled.length,
        unreconciledNetMinor: unreconciledNet.toString(),
      },
      unreconciled: unreconciled.map((t) => ({
        id: t.id,
        date: t.date,
        description: t.description,
        amountMinor: t.amountMinor.toString(),
      })),
      reconciled: reconciled.map((t) => ({
        id: t.id,
        date: t.date,
        description: t.description,
        amountMinor: t.amountMinor.toString(),
        status: t.status,
        kind: t.matchedPaymentId ? "match" : t.matchedEntryId ? "category" : "excluded",
        reconciledAt: t.reconciledAt,
      })),
      candidatePayments: candidatePayments.map((p) => ({
        id: p.id,
        paymentNumber: p.paymentNumber,
        direction: p.direction,
        amountMinor: p.amountMinor.toString(),
        paymentDate: p.paymentDate,
      })),
      categoryAccounts,
    };
  });
}

/** Sum of all GL lines on one account (its running book balance). */
async function glBalanceFor(tx: DbOrTx, orgId: string, accountId: string): Promise<bigint> {
  const rows = (await tx.execute(
    sql`select coalesce(sum(amount_minor), 0)::text as bal from journal_lines where org_id = ${orgId} and account_id = ${accountId}`,
  )) as unknown as Array<{ bal: string }>;
  return BigInt(rows[0]?.bal ?? "0");
}
