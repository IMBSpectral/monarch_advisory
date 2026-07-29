/**
 * Integration test for the maker-checker approval queue (payments + manual
 * journals). Proves: a high-value operation is queued (not posted); the requester
 * can't approve their own; a different user's approval executes it; a rejected
 * item never posts and can't then be approved; and a below-threshold operation
 * posts immediately.
 *
 *   MONARCH_DB_ROLE=admin bun --env-file=.env src/db/test-approval-queue.ts
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db, pgClient, withOrg } from "./client";
import {
  accounts,
  contacts,
  journalEntries,
  journalLines,
  memberships,
  organizations,
  paymentAllocations,
  payments,
  pendingApprovals,
} from "./schema";
import {
  approvePending,
  executeOrQueue,
  rejectPending,
  type ApprovalOperation,
} from "@/server/approval-queue";
import { LedgerError } from "@/server/ledger";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

const MARK = "TEST-AQ";

async function countEntries(orgId: string, memo: string): Promise<number> {
  const [row] = (await withOrg(orgId, (tx) =>
    tx.execute(
      sql`select count(*)::int as n from journal_entries where org_id = ${orgId} and memo = ${memo}`,
    ),
  )) as unknown as Array<{ n: number }>;
  return row?.n ?? 0;
}

async function countPayments(orgId: string, ref: string): Promise<number> {
  const [row] = (await withOrg(orgId, (tx) =>
    tx.execute(
      sql`select count(*)::int as n from payments where org_id = ${orgId} and reference_number = ${ref}`,
    ),
  )) as unknown as Array<{ n: number }>;
  return row?.n ?? 0;
}

async function pendingRow(orgId: string, id: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)),
  );
  return row;
}

async function main() {
  const [orgRow] = (await db.execute(
    sql`select org_id, count(distinct user_id) as n from memberships
        group by org_id having count(distinct user_id) >= 2 order by n desc limit 1`,
  )) as unknown as Array<{ org_id: string }>;
  if (!orgRow) throw new Error("Need an org with ≥2 members — run db:seed first.");
  const orgId = orgRow.org_id;
  const members = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.orgId, orgId));
  const userA = members[0].userId;
  const userB = members.find((m) => m.userId !== userA)!.userId;

  const pick = (subtypeOrType: "cash" | "expense") =>
    withOrg(orgId, (tx) =>
      tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.orgId, orgId),
            subtypeOrType === "cash"
              ? eq(accounts.subtype, "cash_and_bank")
              : eq(accounts.type, "expense"),
            eq(accounts.isGroup, false),
            eq(accounts.isActive, true),
          ),
        )
        .limit(1),
    );
  const [cash] = await pick("cash");
  const [expense] = await pick("expense");
  const [customer] = await withOrg(orgId, (tx) =>
    tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), inArray(contacts.type, ["customer", "both"])))
      .limit(1),
  );
  if (!cash || !expense || !customer) throw new Error("Missing cash/expense account or customer.");

  const [orgBefore] = await withOrg(orgId, (tx) =>
    tx
      .select({ threshold: organizations.approvalThresholdMinor })
      .from(organizations)
      .where(eq(organizations.id, orgId)),
  );
  const originalThreshold = orgBefore?.threshold ?? null;
  const setThreshold = (v: bigint | null) =>
    withOrg(orgId, (tx) =>
      tx
        .update(organizations)
        .set({ approvalThresholdMinor: v, updatedAt: new Date() })
        .where(eq(organizations.id, orgId)),
    );

  const suffix = Math.random().toString(36).slice(2, 8);
  const journalPayload = (memo: string, amt: string) => ({
    entryDate: "2026-03-20",
    memo,
    lines: [
      { accountId: expense.id, side: "debit", amountMinor: amt },
      { accountId: cash.id, side: "credit", amountMinor: amt },
    ],
  });
  const queueJournal = (memo: string, amt: bigint, userId: string) =>
    executeOrQueue({
      orgId,
      operation: "journal.manual" as ApprovalOperation,
      payload: journalPayload(memo, amt.toString()),
      amountMinor: amt,
      summary: `Manual journal — ${memo}`,
      userId,
    });

  try {
    await setThreshold(100_000n); // ₹1,000

    // ── Manual journal: queue → self-approve blocked → approve executes ───────
    const jMemo = `${MARK}-j-${suffix}`;
    const q = await queueJournal(jMemo, 500_000n, userA);
    check("high-value journal is queued, not posted", q.pending === true && !!q.pendingId);
    check("queued journal has not posted", (await countEntries(orgId, jMemo)) === 0);

    let sod = false;
    try {
      await approvePending({ orgId, pendingId: q.pendingId!, approverId: userA });
    } catch (e) {
      sod = e instanceof LedgerError && e.code === "APPROVAL_SEPARATION_REQUIRED";
    }
    check("requester can't approve their own queued item", sod);
    check(
      "item is still pending after a self-approve attempt",
      (await pendingRow(orgId, q.pendingId!)).status === "pending",
    );

    const appr = await approvePending({ orgId, pendingId: q.pendingId!, approverId: userB });
    check("a different user's approval executes the journal", typeof appr.ref === "string");
    check("approved journal is now posted", (await countEntries(orgId, jMemo)) === 1);
    const jRow = await pendingRow(orgId, q.pendingId!);
    check(
      "pending row is approved with the result ref",
      jRow.status === "approved" && jRow.resultRef === appr.ref,
    );

    // ── Below threshold: posts immediately ───────────────────────────────────
    const jMemo2 = `${MARK}-j2-${suffix}`;
    const q2 = await queueJournal(jMemo2, 50_000n, userA); // ₹500 < ₹1,000
    check("below-threshold journal posts immediately", q2.pending === false && !!q2.ref);
    check("immediate journal is posted", (await countEntries(orgId, jMemo2)) === 1);

    // ── Reject flow ──────────────────────────────────────────────────────────
    const jMemo3 = `${MARK}-j3-${suffix}`;
    const q3 = await queueJournal(jMemo3, 500_000n, userA);
    await rejectPending({ orgId, pendingId: q3.pendingId!, userId: userB, reason: "test reject" });
    check("rejected item never posts", (await countEntries(orgId, jMemo3)) === 0);
    check(
      "rejected row is marked rejected",
      (await pendingRow(orgId, q3.pendingId!)).status === "rejected",
    );
    let notPending = false;
    try {
      await approvePending({ orgId, pendingId: q3.pendingId!, approverId: userB });
    } catch (e) {
      notPending = e instanceof LedgerError && e.code === "APPROVAL_NOT_PENDING";
    }
    check("a rejected item can't then be approved", notPending);

    // ── Payment: queue → approve executes ────────────────────────────────────
    const pRef = `${MARK}-p-${suffix}`;
    const pPayload = {
      contactId: customer.id,
      paymentDate: "2026-03-20",
      amountMinor: "500000",
      depositAccountId: cash.id,
      referenceNumber: pRef,
      allocations: [] as Array<{ invoiceId: string; amountMinor: string }>,
    };
    const pq = await executeOrQueue({
      orgId,
      operation: "payment.customer",
      payload: pPayload,
      amountMinor: 500_000n,
      summary: `Customer payment · ${pRef}`,
      userId: userA,
    });
    check("high-value payment is queued", pq.pending === true);
    check("queued payment is not recorded", (await countPayments(orgId, pRef)) === 0);
    await approvePending({ orgId, pendingId: pq.pendingId!, approverId: userB });
    check(
      "a different user's approval records the payment",
      (await countPayments(orgId, pRef)) === 1,
    );
  } finally {
    await setThreshold(originalThreshold);
    await cleanup(orgId);
  }

  console.log(
    `\n${failures === 0 ? "All approval-queue checks passed." : `${failures} check(s) FAILED.`}`,
  );
  await pgClient.end();
  process.exit(failures === 0 ? 0 : 1);
}

/** Remove every row this test created, and the ledger entries behind them. */
async function cleanup(orgId: string) {
  await withOrg(orgId, async (tx) => {
    // Payments (+ their allocations + journal entries).
    const testPayments = await tx
      .select({ id: payments.id, entryId: payments.journalEntryId })
      .from(payments)
      .where(and(eq(payments.orgId, orgId), like(payments.referenceNumber, `${MARK}-%`)));
    const entryIds: string[] = testPayments
      .map((p) => p.entryId)
      .filter((e): e is string => e !== null);
    if (testPayments.length) {
      const ids = testPayments.map((p) => p.id);
      await tx.delete(paymentAllocations).where(inArray(paymentAllocations.paymentId, ids));
      await tx.delete(payments).where(inArray(payments.id, ids));
    }
    // Manual journals this test posted (by memo marker).
    const testEntries = await tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.orgId, orgId), like(journalEntries.memo, `${MARK}-%`)));
    entryIds.push(...testEntries.map((e) => e.id));
    if (entryIds.length) {
      await tx.delete(journalLines).where(inArray(journalLines.entryId, entryIds));
      await tx.delete(journalEntries).where(inArray(journalEntries.id, entryIds));
    }
    // Pending rows.
    await tx
      .delete(pendingApprovals)
      .where(and(eq(pendingApprovals.orgId, orgId), like(pendingApprovals.summary, `%${MARK}-%`)));
  });
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
