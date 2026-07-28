/**
 * Integration test for maker-checker bill approvals — runs against a seeded DB.
 * Proves: with an org approval threshold set, a bill at or above it cannot be
 * posted by the person who created it (separation of duties), a different user
 * CAN post it and is recorded as the approver, a below-threshold bill posts
 * freely, and with the threshold off the creator can post their own bill.
 *
 *   MONARCH_DB_ROLE=admin bun --env-file=.env src/db/test-approvals.ts
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db, pgClient, withOrg } from "./client";
import {
  accounts,
  billLines,
  bills,
  contacts,
  journalEntries,
  journalLines,
  memberships,
  organizations,
} from "./schema";
import { createBill, postBill } from "@/server/bills";
import { LedgerError } from "@/server/ledger";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

const MARK = "TEST-APPR";

async function main() {
  // Need an org with at least two distinct members to exercise separation of duties.
  const [orgRow] = (await db.execute(
    sql`select org_id, count(distinct user_id) as n
        from memberships group by org_id having count(distinct user_id) >= 2
        order by n desc limit 1`,
  )) as unknown as Array<{ org_id: string; n: number }>;
  if (!orgRow) throw new Error("Need an org with ≥2 members — run db:seed first.");
  const orgId = orgRow.org_id;

  const memberRows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.orgId, orgId));
  const userA = memberRows[0].userId;
  const userB = memberRows.find((m) => m.userId !== userA)!.userId;

  const [vendor] = await withOrg(orgId, (tx) =>
    tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), inArray(contacts.type, ["vendor", "both"])))
      .limit(1),
  );
  if (!vendor) throw new Error("No vendor contact in this org.");

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
  if (!expense) throw new Error("No postable expense account.");

  // Remember the current threshold so we can restore it no matter what.
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

  const makeBill = (unitMinor: bigint, userId: string) =>
    createBill({
      orgId,
      contactId: vendor.id,
      billDate: "2026-03-20",
      dueDate: "2026-04-20",
      vendorInvoiceNumber: `${MARK}-${Math.random().toString(36).slice(2, 8)}`,
      userId,
      lines: [
        {
          description: "TEST approval line",
          quantity: "1",
          unitPriceMinor: unitMinor,
          expenseAccountId: expense.id,
        },
      ],
    });

  const billStatus = async (billId: string) => {
    const [b] = await withOrg(orgId, (tx) => tx.select().from(bills).where(eq(bills.id, billId)));
    return b;
  };

  try {
    // Threshold = ₹1,000 (100000 paise).
    await setThreshold(100_000n);

    // ── Test 1: the creator cannot self-post a bill at/above the threshold ────
    const big = await makeBill(500_000n, userA); // ₹5,000 ≥ ₹1,000
    let sodBlocked = false;
    try {
      await postBill({ orgId, billId: big.billId, userId: userA });
    } catch (e) {
      sodBlocked = e instanceof LedgerError && e.code === "APPROVAL_SEPARATION_REQUIRED";
    }
    const afterBlock = await billStatus(big.billId);
    check("creator can't post their own ≥threshold bill", sodBlocked);
    check("blocked bill stays a draft", afterBlock.status === "draft");
    check("blocked bill has no journal entry", afterBlock.journalEntryId === null);

    // ── Test 2: a different user (checker) can post it ────────────────────────
    await postBill({ orgId, billId: big.billId, userId: userB });
    const afterApprove = await billStatus(big.billId);
    check("a different user can post (approve) it", afterApprove.status === "open");
    check("the approver is recorded", afterApprove.approvedByUserId === userB);
    check("posting created a journal entry", afterApprove.journalEntryId !== null);

    // ── Test 3: a below-threshold bill can be self-posted ─────────────────────
    const small = await makeBill(50_000n, userA); // ₹500 < ₹1,000
    await postBill({ orgId, billId: small.billId, userId: userA });
    const afterSmall = await billStatus(small.billId);
    check("creator can self-post a below-threshold bill", afterSmall.status === "open");

    // ── Test 4: with approvals off, the creator can post any amount ───────────
    await setThreshold(null);
    const off = await makeBill(500_000n, userA);
    await postBill({ orgId, billId: off.billId, userId: userA });
    const afterOff = await billStatus(off.billId);
    check("approvals off → creator can self-post any amount", afterOff.status === "open");
  } finally {
    // Restore the threshold and remove every bill (and its ledger entry) this test made.
    await setThreshold(originalThreshold);
    await cleanup(orgId);
  }

  console.log(
    `\n${failures === 0 ? "All approval checks passed." : `${failures} check(s) FAILED.`}`,
  );
  await pgClient.end();
  process.exit(failures === 0 ? 0 : 1);
}

/** Delete the test bills and any journal entries they posted (admin, seed-safe). */
async function cleanup(orgId: string) {
  await withOrg(orgId, async (tx) => {
    const testBills = await tx
      .select({ id: bills.id, entryId: bills.journalEntryId })
      .from(bills)
      .where(and(eq(bills.orgId, orgId), like(bills.vendorInvoiceNumber, `${MARK}-%`)));
    if (testBills.length === 0) return;
    const billIds = testBills.map((b) => b.id);
    const entryIds = testBills.map((b) => b.entryId).filter((e): e is string => e !== null);

    await tx.delete(billLines).where(inArray(billLines.billId, billIds));
    await tx.delete(bills).where(inArray(bills.id, billIds));
    if (entryIds.length) {
      await tx.delete(journalLines).where(inArray(journalLines.entryId, entryIds));
      await tx.delete(journalEntries).where(inArray(journalEntries.id, entryIds));
    }
  });
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
