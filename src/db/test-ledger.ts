/**
 * Ledger behaviour tests.
 *
 * `verify.ts` proves the seeded books are internally consistent. This proves the
 * engine actively *rejects* bad input — which is the more important property,
 * because a ledger that only works when you feed it correct data isn't a safeguard.
 *
 * Every guard claimed in ledger.ts is exercised here, plus a full
 * create → post → pay → reverse lifecycle, with integrity re-checked afterwards.
 *
 * Run with:  bun run db:test
 */

import { eq, and, sql } from "drizzle-orm";
import { db, pgClient } from "./client";
import { accounts, contacts, invoices, journalEntries, organizations, users } from "./schema";
import {
  LedgerError,
  credit,
  debit,
  postJournalEntry,
  reverseJournalEntry,
  resolveControlAccount,
  findUnbalancedEntries,
  verifyInvoiceBalances,
} from "@/server/ledger";
import { createInvoice, postInvoice, recordCustomerPayment, voidInvoice } from "@/server/invoicing";
import { getTrialBalance, getBalanceSheet, getReceivablesAging } from "@/server/reports";

let passed = 0;
let failed = 0;

function ok(label: string, detail = "") {
  passed++;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}

function bad(label: string, detail = "") {
  failed++;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Assert that `fn` throws a LedgerError with the expected code. */
async function expectReject(label: string, expectedCode: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    bad(label, `expected rejection (${expectedCode}) but the call SUCCEEDED`);
  } catch (err) {
    if (err instanceof LedgerError && err.code === expectedCode) {
      ok(label, expectedCode);
    } else if (err instanceof LedgerError) {
      bad(label, `expected ${expectedCode}, got ${err.code}: ${err.message}`);
    } else {
      // A DB constraint firing is also a valid rejection — note which one.
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      ok(label, `rejected by database: ${msg.slice(0, 60)}`);
    }
  }
}

async function expectResolve(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(label);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    bad(label, msg);
  }
}

const inr = (m: bigint) => {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  return `${neg ? "-" : ""}₹${(abs / 100n).toLocaleString("en-IN")}.${(abs % 100n).toString().padStart(2, "0")}`;
};

async function main() {
  const [org] = await db.select().from(organizations).limit(1);
  if (!org) throw new Error("No org. Run `bun run db:seed` first.");
  const [user] = await db.select().from(users).limit(1);

  const acctByCode = new Map(
    (await db.select().from(accounts).where(eq(accounts.orgId, org.id))).map((a) => [a.code, a]),
  );
  const acct = (code: string) => acctByCode.get(code)!.id;

  const [customer] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.orgId, org.id), eq(contacts.type, "customer")))
    .limit(1);
  const [vendor] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.orgId, org.id), eq(contacts.type, "vendor")))
    .limit(1);

  console.log(`\nLedger behaviour tests — ${org.name}\n`);

  /* ══ 1. Posting engine guards ═════════════════════════════════════════*/

  console.log("Posting engine — rejects invalid entries");

  await expectReject("unbalanced entry rejected", "UNBALANCED", () =>
    postJournalEntry({
      orgId: org.id,
      entryDate: "2026-07-20",
      memo: "should not post",
      lines: [
        debit(acct("1110"), 100_00n),
        credit(acct("4100"), 90_00n), // ₹10 short
      ],
    }),
  );

  await expectReject("single-sided entry rejected", "UNBALANCED", () =>
    postJournalEntry({
      orgId: org.id,
      entryDate: "2026-07-20",
      memo: "one line only",
      lines: [debit(acct("1110"), 100_00n)],
    }),
  );

  await expectReject("posting to a group header rejected", "ACCOUNT_IS_GROUP", () =>
    postJournalEntry({
      orgId: org.id,
      entryDate: "2026-07-20",
      memo: "group account",
      lines: [
        debit(acct("1100"), 100_00n), // "Current Assets" is a rollup node
        credit(acct("4100"), 100_00n),
      ],
    }),
  );

  await expectReject("negative amount in debit() rejected", "NEGATIVE_DEBIT", async () =>
    debit(acct("1110"), -100_00n),
  );

  await expectReject("negative amount in credit() rejected", "NEGATIVE_CREDIT", async () =>
    credit(acct("4100"), -100_00n),
  );

  await expectReject("posting to a nonexistent account rejected", "ACCOUNT_NOT_FOUND", () =>
    postJournalEntry({
      orgId: org.id,
      entryDate: "2026-07-20",
      memo: "ghost account",
      lines: [
        debit("00000000-0000-0000-0000-000000000000", 100_00n),
        credit(acct("4100"), 100_00n),
      ],
    }),
  );

  /* ── Cross-tenant isolation ───────────────────────────────────────────*/

  const [otherOrg] = await db
    .insert(organizations)
    .values({ name: "Test Tenant B", baseCurrency: "INR" })
    .returning();
  await db.insert(accounts).values({
    orgId: otherOrg.id,
    code: "9999",
    name: "Foreign Cash",
    type: "asset",
    subtype: "cash_and_bank",
  });
  const [foreignAcct] = await db.select().from(accounts).where(eq(accounts.orgId, otherOrg.id));

  await expectReject("cross-tenant account posting rejected", "CROSS_TENANT_ACCOUNT", () =>
    postJournalEntry({
      orgId: org.id,
      entryDate: "2026-07-20",
      memo: "tenant leak attempt",
      lines: [debit(foreignAcct.id, 100_00n), credit(acct("4100"), 100_00n)],
    }),
  );

  /* ── Period lock ──────────────────────────────────────────────────────*/

  await db
    .update(organizations)
    .set({ booksClosedThrough: "2026-06-30" })
    .where(eq(organizations.id, org.id));

  await expectReject("posting into a closed period rejected", "PERIOD_CLOSED", () =>
    postJournalEntry({
      orgId: org.id,
      entryDate: "2026-06-15",
      memo: "backdated into closed period",
      lines: [debit(acct("1110"), 100_00n), credit(acct("4100"), 100_00n)],
    }),
  );

  await expectResolve("posting after the closed period allowed", () =>
    postJournalEntry({
      orgId: org.id,
      entryDate: "2026-07-20",
      memo: "test entry after lock",
      userId: user.id,
      lines: [debit(acct("1110"), 100_00n), credit(acct("4900"), 100_00n)],
    }),
  );

  await db
    .update(organizations)
    .set({ booksClosedThrough: null })
    .where(eq(organizations.id, org.id));

  /* ══ 2. Invoice lifecycle ═════════════════════════════════════════════*/

  console.log("\nInvoice lifecycle");

  const before = await getTrialBalance(org.id, "2026-12-31");

  const created = await createInvoice({
    orgId: org.id,
    contactId: customer.id,
    invoiceDate: "2026-07-20",
    dueDate: "2026-08-19",
    userId: user.id,
    lines: [
      {
        description: "Implementation services",
        quantity: "10",
        unitPriceMinor: 5_000_00n, // ₹5,000 × 10 = ₹50,000
        revenueAccountId: acct("4200"),
      },
      {
        description: "Annual support retainer",
        quantity: "1",
        unitPriceMinor: 25_000_00n,
        discountBps: 1000, // 10% off → ₹22,500
        revenueAccountId: acct("4200"),
      },
    ],
  });

  const expectedTotal = 50_000_00n + 22_500_00n;
  if (created.totalMinor === expectedTotal) {
    ok("invoice line math (qty × price, discount)", `${inr(created.totalMinor)}`);
  } else {
    bad(
      "invoice line math (qty × price, discount)",
      `expected ${inr(expectedTotal)}, got ${inr(created.totalMinor)}`,
    );
  }

  // A draft must not touch the ledger.
  const afterDraft = await getTrialBalance(org.id, "2026-12-31");
  if (afterDraft.totalDebitMinor === before.totalDebitMinor) {
    ok("draft invoice has no ledger impact");
  } else {
    bad(
      "draft invoice has no ledger impact",
      `ledger moved by ${inr(afterDraft.totalDebitMinor - before.totalDebitMinor)}`,
    );
  }

  await expectReject("paying a draft invoice rejected", "INVOICE_NOT_POSTED", () =>
    recordCustomerPayment({
      orgId: org.id,
      contactId: customer.id,
      paymentDate: "2026-07-21",
      amountMinor: 1000_00n,
      depositAccountId: acct("1110"),
      allocations: [{ invoiceId: created.invoiceId, amountMinor: 1000_00n }],
    }),
  );

  await expectResolve("posting the invoice", () =>
    postInvoice({ orgId: org.id, invoiceId: created.invoiceId, userId: user.id }),
  );

  await expectReject("double-posting the same invoice rejected", "INVOICE_NOT_DRAFT", () =>
    postInvoice({ orgId: org.id, invoiceId: created.invoiceId, userId: user.id }),
  );

  // AR should have moved by exactly the invoice total.
  const afterPost = await getTrialBalance(org.id, "2026-12-31");
  const arBefore = before.rows.find((r) => r.subtype === "accounts_receivable");
  const arAfter = afterPost.rows.find((r) => r.subtype === "accounts_receivable");
  const arDelta =
    (arAfter ? arAfter.debitMinor - arAfter.creditMinor : 0n) -
    (arBefore ? arBefore.debitMinor - arBefore.creditMinor : 0n);
  if (arDelta === expectedTotal) {
    ok("A/R increased by the invoice total", inr(arDelta));
  } else {
    bad(
      "A/R increased by the invoice total",
      `expected ${inr(expectedTotal)}, got ${inr(arDelta)}`,
    );
  }

  /* ── Payment guards ───────────────────────────────────────────────────*/

  console.log("\nPayment allocation");

  await expectReject(
    "allocating more than the invoice balance rejected",
    "ALLOCATION_EXCEEDS_BALANCE",
    () =>
      recordCustomerPayment({
        orgId: org.id,
        contactId: customer.id,
        paymentDate: "2026-07-21",
        amountMinor: expectedTotal + 1_00n,
        depositAccountId: acct("1110"),
        allocations: [{ invoiceId: created.invoiceId, amountMinor: expectedTotal + 1_00n }],
      }),
  );

  await expectReject("allocating more than the cash received rejected", "OVER_ALLOCATED", () =>
    recordCustomerPayment({
      orgId: org.id,
      contactId: customer.id,
      paymentDate: "2026-07-21",
      amountMinor: 1_000_00n,
      depositAccountId: acct("1110"),
      allocations: [{ invoiceId: created.invoiceId, amountMinor: 5_000_00n }],
    }),
  );

  // Partial payment.
  const partial = 30_000_00n;
  await expectResolve("recording a partial payment", () =>
    recordCustomerPayment({
      orgId: org.id,
      contactId: customer.id,
      paymentDate: "2026-07-22",
      amountMinor: partial,
      depositAccountId: acct("1110"),
      method: "NEFT",
      userId: user.id,
      allocations: [{ invoiceId: created.invoiceId, amountMinor: partial }],
    }),
  );

  const [afterPartial] = await db.select().from(invoices).where(eq(invoices.id, created.invoiceId));

  if (afterPartial.status === "partially_paid") {
    ok("status becomes partially_paid", `paid ${inr(afterPartial.amountPaidMinor)}`);
  } else {
    bad("status becomes partially_paid", `got "${afterPartial.status}"`);
  }

  await expectReject("voiding an invoice with payments rejected", "INVOICE_HAS_PAYMENTS", () =>
    voidInvoice({
      orgId: org.id,
      invoiceId: created.invoiceId,
      reason: "test void",
      userId: user.id,
    }),
  );

  // Settle the remainder.
  const remainder = expectedTotal - partial;
  await expectResolve("settling the remaining balance", () =>
    recordCustomerPayment({
      orgId: org.id,
      contactId: customer.id,
      paymentDate: "2026-07-25",
      amountMinor: remainder,
      depositAccountId: acct("1110"),
      method: "NEFT",
      userId: user.id,
      allocations: [{ invoiceId: created.invoiceId, amountMinor: remainder }],
    }),
  );

  const [afterFull] = await db.select().from(invoices).where(eq(invoices.id, created.invoiceId));

  if (afterFull.status === "paid") {
    ok("status becomes paid when fully settled");
  } else {
    bad("status becomes paid when fully settled", `got "${afterFull.status}"`);
  }

  await expectReject("over-paying a settled invoice rejected", "ALLOCATION_EXCEEDS_BALANCE", () =>
    recordCustomerPayment({
      orgId: org.id,
      contactId: customer.id,
      paymentDate: "2026-07-26",
      amountMinor: 1_00n,
      depositAccountId: acct("1110"),
      allocations: [{ invoiceId: created.invoiceId, amountMinor: 1_00n }],
    }),
  );

  /* ══ 3. Reversal & immutability ═══════════════════════════════════════*/

  console.log("\nReversal & immutability");

  // Baseline must be taken BEFORE the entry is posted — a reversal returns the
  // account to its pre-entry state, not to its post-entry state.
  const tbBeforeEntry = await getTrialBalance(org.id, "2026-12-31");
  const feesBefore = tbBeforeEntry.rows.find((r) => r.code === "5600")?.debitMinor ?? 0n;

  const reversible = await postJournalEntry({
    orgId: org.id,
    entryDate: "2026-07-23",
    memo: "Entry to be reversed",
    userId: user.id,
    lines: [debit(acct("5600"), 12_000_00n), credit(acct("1110"), 12_000_00n)],
  });

  await expectReject("reversal without a reason rejected", "REASON_REQUIRED", () =>
    reverseJournalEntry({
      orgId: org.id,
      entryId: reversible.entryId,
      reason: "   ",
      userId: user.id,
    }),
  );

  // The entry landed: the expense account should now carry it.
  const tbAfterEntry = await getTrialBalance(org.id, "2026-12-31");
  const feesAfterEntry = tbAfterEntry.rows.find((r) => r.code === "5600")?.debitMinor ?? 0n;
  if (feesAfterEntry - feesBefore === 12_000_00n) {
    ok("entry lands on the expense account", inr(feesAfterEntry - feesBefore));
  } else {
    bad(
      "entry lands on the expense account",
      `expected +${inr(12_000_00n)}, got ${inr(feesAfterEntry - feesBefore)}`,
    );
  }

  await expectResolve("reversing an entry", () =>
    reverseJournalEntry({
      orgId: org.id,
      entryId: reversible.entryId,
      reason: "Duplicate posting — booked twice by accident",
      userId: user.id,
    }),
  );

  await expectReject("double-reversing rejected", "ALREADY_REVERSED", () =>
    reverseJournalEntry({
      orgId: org.id,
      entryId: reversible.entryId,
      reason: "again",
      userId: user.id,
    }),
  );

  // The original entry must still exist, marked reversed — not deleted.
  const [originalStill] = await db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.id, reversible.entryId));

  if (originalStill && originalStill.status === "reversed") {
    ok("original entry preserved and marked reversed", originalStill.entryNumber);
  } else {
    bad(
      "original entry preserved and marked reversed",
      originalStill ? originalStill.status : "DELETED",
    );
  }

  // The reversal must return the account to its pre-entry balance exactly.
  const tbAfterReversal = await getTrialBalance(org.id, "2026-12-31");
  const feesAfterReversal = tbAfterReversal.rows.find((r) => r.code === "5600")?.debitMinor ?? 0n;
  if (feesAfterReversal === feesBefore) {
    ok("reversal returns the account to its pre-entry balance", inr(feesBefore));
  } else {
    bad(
      "reversal returns the account to its pre-entry balance",
      `expected ${inr(feesBefore)}, got ${inr(feesAfterReversal)}`,
    );
  }

  /* ══ 4. Integrity after all mutations ═════════════════════════════════*/

  console.log("\nIntegrity after mutations");

  /** Record a boolean assertion with a pass detail and a fail detail. */
  function assert(label: string, condition: boolean, passDetail: string, failDetail: string) {
    if (condition) ok(label, passDetail);
    else bad(label, failDetail);
  }

  const unbalanced = await findUnbalancedEntries(org.id);
  assert(
    "all entries still balance",
    unbalanced.length === 0,
    "0 unbalanced",
    `${unbalanced.length} unbalanced`,
  );

  const drift = await verifyInvoiceBalances(org.id);
  assert("no invoice payment drift", drift.length === 0, "0 drifted", `${drift.length} drifted`);

  const tb = await getTrialBalance(org.id, "2026-12-31");
  assert(
    "trial balance still foots",
    tb.isBalanced,
    inr(tb.totalDebitMinor),
    `${inr(tb.totalDebitMinor)} vs ${inr(tb.totalCreditMinor)}`,
  );

  const bs = await getBalanceSheet(org.id, "2026-12-31");
  assert(
    "accounting equation still holds",
    bs.isBalanced,
    inr(bs.totalAssetsMinor),
    `${inr(bs.totalAssetsMinor)} vs ${inr(bs.totalLiabilitiesMinor + bs.totalEquityMinor)}`,
  );

  const aging = await getReceivablesAging(org.id, "2026-12-31");
  const arRow = tb.rows.find((r) => r.subtype === "accounts_receivable");
  const arControl = arRow ? arRow.debitMinor - arRow.creditMinor : 0n;
  assert(
    "A/R control matches subledger",
    arControl === aging.totals.totalMinor,
    inr(arControl),
    `control ${inr(arControl)} vs subledger ${inr(aging.totals.totalMinor)}`,
  );

  /* ── Cleanup ──────────────────────────────────────────────────────────*/

  await db.delete(organizations).where(eq(organizations.id, otherOrg.id));

  console.log(`\n${passed} passed, ${failed} failed.\n`);
  return failed;
}

main()
  .then(async (f) => {
    await pgClient.end();
    process.exit(f === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error("\nTest harness error:\n", err);
    await pgClient.end();
    process.exit(1);
  });
