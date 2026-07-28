/**
 * Integration test for bank reconciliation — runs against a real seeded DB.
 * Proves a categorization posts a balanced journal entry and reconciles the feed
 * line, a re-categorization is blocked, an undo reverses that entry and restores
 * the balance, and (when the seed has an eligible payment) a match links without
 * posting anything new and an undo simply unlinks.
 *
 *   MONARCH_DB_ROLE=admin bun --env-file=.env src/db/test-reconciliation.ts
 */
import { and, eq, like, sql } from "drizzle-orm";
import { db, pgClient, withOrg } from "./client";
import {
  accounts,
  bankAccounts,
  bankTransactions,
  journalEntries,
  journalLines,
  payments,
} from "./schema";
import {
  categorizeTransaction,
  matchTransactionToPayment,
  unreconcileTransaction,
} from "@/server/reconciliation";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

async function glBalance(orgId: string, accountId: string): Promise<bigint> {
  const [row] = (await withOrg(orgId, (tx) =>
    tx.execute(
      sql`select coalesce(sum(amount_minor),0)::text as bal from journal_lines where org_id = ${orgId} and account_id = ${accountId}`,
    ),
  )) as unknown as Array<{ bal: string }>;
  return BigInt(row?.bal ?? "0");
}

async function insertTxn(
  orgId: string,
  bankAccountId: string,
  amountMinor: bigint,
  date: string,
  externalId: string,
): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(bankTransactions)
      .values({
        orgId,
        bankAccountId,
        transactionDate: date,
        description: "TEST reco line",
        amountMinor,
        currency: "INR",
        externalId,
      })
      .returning({ id: bankTransactions.id }),
  );
  return row.id;
}

async function main() {
  // Pick the (org, bank account) pairing with the most payments settling through
  // its GL account, so the match test has real data to work with; fall back to
  // any org's first bank account otherwise. (Admin read — just choosing a target.)
  const [best] = (await db.execute(
    sql`select ba.org_id, ba.id as bank_id, ba.account_id, count(p.id) as pmts
        from bank_accounts ba
        left join payments p
          on p.deposit_account_id = ba.account_id and p.org_id = ba.org_id
        group by ba.org_id, ba.id, ba.account_id
        order by pmts desc
        limit 1`,
  )) as unknown as Array<{ org_id: string; bank_id: string; account_id: string }>;
  if (!best) throw new Error("No bank account found — run db:seed first.");
  const orgId = best.org_id;
  const bank = { id: best.bank_id, accountId: best.account_id };

  const [expense] = await withOrg(orgId, (tx) =>
    tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.orgId, orgId),
          eq(accounts.type, "expense"),
          eq(accounts.isGroup, false),
          eq(accounts.isActive, true),
        ),
      )
      .limit(1),
  );
  if (!expense) throw new Error("No postable expense account found.");

  const suffix = Math.random().toString(36).slice(2);

  // ── Test A: categorize an outflow (bank charges) ──────────────────────────
  const glBefore = await glBalance(orgId, bank.accountId);
  const chargeTxn = await insertTxn(
    orgId,
    bank.id,
    -50_000n,
    "2026-03-15",
    `test-reco-a-${suffix}`,
  );
  const cat = await categorizeTransaction({
    orgId,
    bankTransactionId: chargeTxn,
    categoryAccountId: expense.id,
    memo: "test charges",
  });

  const [afterCat] = await withOrg(orgId, (tx) =>
    tx.select().from(bankTransactions).where(eq(bankTransactions.id, chargeTxn)),
  );
  const catLines = await withOrg(orgId, (tx) =>
    tx.select().from(journalLines).where(eq(journalLines.entryId, cat.entryId)),
  );
  const bankLine = catLines.find((l) => l.accountId === bank.accountId);
  const expLine = catLines.find((l) => l.accountId === expense.id);
  const glAfterCat = await glBalance(orgId, bank.accountId);

  check("categorize marks the line reconciled", afterCat.status === "reconciled");
  check("categorize links the posted entry", afterCat.matchedEntryId === cat.entryId);
  check("categorize posts no payment link", afterCat.matchedPaymentId === null);
  check(
    "outflow debits the category and credits the bank",
    expLine?.amountMinor === 50_000n && bankLine?.amountMinor === -50_000n,
  );
  check("bank GL balance drops by the outflow", glAfterCat === glBefore - 50_000n);

  // ── Test B: a reconciled line can't be re-categorized ─────────────────────
  let blocked = false;
  try {
    await categorizeTransaction({
      orgId,
      bankTransactionId: chargeTxn,
      categoryAccountId: expense.id,
    });
  } catch {
    blocked = true;
  }
  check("re-categorizing a reconciled line is blocked", blocked);

  // ── Test C: undo reverses the entry and restores the balance ──────────────
  const undo = await unreconcileTransaction({
    orgId,
    bankTransactionId: chargeTxn,
    reason: "test undo",
  });
  const [afterUndo] = await withOrg(orgId, (tx) =>
    tx.select().from(bankTransactions).where(eq(bankTransactions.id, chargeTxn)),
  );
  const [origEntry] = await withOrg(orgId, (tx) =>
    tx.select().from(journalEntries).where(eq(journalEntries.id, cat.entryId)),
  );
  const glAfterUndo = await glBalance(orgId, bank.accountId);

  check("undo returns the line to unreconciled", afterUndo.status === "unreconciled");
  check("undo clears the entry link", afterUndo.matchedEntryId === null);
  check("undo reverses (not deletes) the original entry", origEntry.status === "reversed");
  check("undo restores the bank GL balance", glAfterUndo === glBefore);
  check("undo reports the reversed entry", undo.reversedEntryId === cat.entryId);

  // ── Test D: match to an existing payment (conditional on seed data) ────────
  const pmtCandidates = await withOrg(orgId, (tx) =>
    tx
      .select({
        id: payments.id,
        direction: payments.direction,
        amountMinor: payments.amountMinor,
        paymentDate: payments.paymentDate,
        journalEntryId: payments.journalEntryId,
      })
      .from(payments)
      .where(and(eq(payments.orgId, orgId), eq(payments.depositAccountId, bank.accountId))),
  );
  const matchedRows = await withOrg(orgId, (tx) =>
    tx
      .select({ pid: bankTransactions.matchedPaymentId })
      .from(bankTransactions)
      .where(eq(bankTransactions.orgId, orgId)),
  );
  const takenIds = new Set(matchedRows.map((r) => r.pid).filter(Boolean));
  const candidate = pmtCandidates.find((p) => !takenIds.has(p.id) && p.journalEntryId);

  if (!candidate) {
    console.log("  SKIP  match test — no eligible payment on this bank account in the seed");
  } else {
    const [{ n: entriesBefore }] = (await withOrg(orgId, (tx) =>
      tx.execute(sql`select count(*)::int as n from journal_entries where org_id = ${orgId}`),
    )) as unknown as Array<{ n: number }>;

    const signed =
      candidate.direction === "inbound" ? candidate.amountMinor : -candidate.amountMinor;
    const matchTxn = await insertTxn(
      orgId,
      bank.id,
      signed,
      candidate.paymentDate,
      `test-reco-d-${suffix}`,
    );
    const m = await matchTransactionToPayment({
      orgId,
      bankTransactionId: matchTxn,
      paymentId: candidate.id,
    });
    const [afterMatch] = await withOrg(orgId, (tx) =>
      tx.select().from(bankTransactions).where(eq(bankTransactions.id, matchTxn)),
    );
    const [{ n: entriesAfter }] = (await withOrg(orgId, (tx) =>
      tx.execute(sql`select count(*)::int as n from journal_entries where org_id = ${orgId}`),
    )) as unknown as Array<{ n: number }>;

    check("match reconciles the line", afterMatch.status === "reconciled");
    check("match links the payment", afterMatch.matchedPaymentId === candidate.id);
    check(
      "match links the payment's existing entry",
      m.matchedEntryId === candidate.journalEntryId,
    );
    check("match posts no new journal entry", entriesAfter === entriesBefore);

    await unreconcileTransaction({
      orgId,
      bankTransactionId: matchTxn,
      reason: "test unmatch",
    });
    const [afterUnmatch] = await withOrg(orgId, (tx) =>
      tx.select().from(bankTransactions).where(eq(bankTransactions.id, matchTxn)),
    );
    const [payEntry] = await withOrg(orgId, (tx) =>
      tx
        .select({ status: journalEntries.status })
        .from(journalEntries)
        .where(eq(journalEntries.id, candidate.journalEntryId!)),
    );
    check("unmatch returns the line to unreconciled", afterUnmatch.status === "unreconciled");
    check("unmatch leaves the payment's own entry posted", payEntry.status === "posted");
  }

  // Cleanup the feed lines this test inserted (entries left as-is: a reversal
  // pair nets to zero, exactly like a real undo would).
  await withOrg(orgId, (tx) =>
    tx
      .delete(bankTransactions)
      .where(
        and(eq(bankTransactions.orgId, orgId), like(bankTransactions.externalId, "test-reco-%")),
      ),
  );

  console.log(
    `\n${failures === 0 ? "All reconciliation checks passed." : `${failures} check(s) FAILED.`}`,
  );
  await pgClient.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
