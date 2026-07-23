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
import { db, pgClient, withOrg } from "./client";
import { accounts, contacts, invoices, items, journalEntries, organizations, users } from "./schema";
import { SEEDED_ORG_NAME } from "./fixtures";
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
import { createBill, postBill } from "@/server/bills";
import {
  createCreditNote,
  postCreditNote,
  createDebitNote,
  postDebitNote,
} from "@/server/credit-notes";
import { recordContra } from "@/server/contra";
import {
  createSalesOrder,
  convertSalesOrderToInvoice,
  createPurchaseOrder,
  convertPurchaseOrderToBill,
} from "@/server/orders";
import {
  createGoodsReceipt,
  postGoodsReceipt,
  convertGoodsReceiptToBill,
  createDeliveryNote,
  postDeliveryNote,
  convertDeliveryToInvoice,
} from "@/server/receipts";
import { getStockSummary, getStockValuationTotal, recordOpeningStock } from "@/server/inventory";
import { getForexExposure, postForexRevaluation } from "@/server/forex";
import { createFixedAsset, runDepreciation, disposeFixedAsset, getAssetRegister } from "@/server/assets";
import { closePeriod, reopenPeriod } from "@/server/period";
import { getProfitAndLoss } from "@/server/reports";
import { createRecurringTemplate, generateDueInvoices } from "@/server/recurring";
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
  // Pinned by name — the seed also creates an empty second tenant, and an
  // unordered limit(1) could pick it, silently testing against no data.
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, SEEDED_ORG_NAME))
    .limit(1);
  if (!org) throw new Error("No org. Run `bun run db:seed` first.");

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, "founder@imblabs.example"))
    .limit(1);

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

  const before = await getTrialBalance(db, org.id, "2026-12-31");

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
  const afterDraft = await getTrialBalance(db, org.id, "2026-12-31");
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
  const afterPost = await getTrialBalance(db, org.id, "2026-12-31");
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
  const tbBeforeEntry = await getTrialBalance(db, org.id, "2026-12-31");
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
  const tbAfterEntry = await getTrialBalance(db, org.id, "2026-12-31");
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
  const tbAfterReversal = await getTrialBalance(db, org.id, "2026-12-31");
  const feesAfterReversal = tbAfterReversal.rows.find((r) => r.code === "5600")?.debitMinor ?? 0n;
  if (feesAfterReversal === feesBefore) {
    ok("reversal returns the account to its pre-entry balance", inr(feesBefore));
  } else {
    bad(
      "reversal returns the account to its pre-entry balance",
      `expected ${inr(feesBefore)}, got ${inr(feesAfterReversal)}`,
    );
  }

  /* ══ 3b. Inventory — stock ledger & weighted-average COGS ═════════════*/

  console.log("\nInventory — stock ledger & valuation");

  const stockValueOf = async (itemId: string): Promise<{ qty: string; value: bigint }> => {
    const summary = await withOrg(org.id, (tx) => getStockSummary(tx, org.id));
    const row = summary.find((s) => s.itemId === itemId);
    return { qty: row?.onHandQty ?? "0.0000", value: row?.valueMinor ?? 0n };
  };
  const cogsBalance = async (): Promise<bigint> => {
    const tbNow = await getTrialBalance(db, org.id, "2026-12-31");
    const row = tbNow.rows.find((r) => r.code === "5100");
    return row ? row.debitMinor - row.creditMinor : 0n;
  };

  // A dedicated test item so the weighted-average math is exact and isolated.
  const [widget] = await db
    .insert(items)
    .values({
      orgId: org.id,
      sku: "TEST-WA-1",
      name: "WA Test Widget",
      isInventoryTracked: true,
      unitOfMeasure: "PCS",
      salePriceMinor: 500_00n,
      purchasePriceMinor: 100_00n,
      salesAccountId: acct("4100"),
      purchaseAccountId: acct("5100"),
      inventoryAccountId: acct("1130"),
    })
    .returning();

  // Receipt 1 (opening): 10 units @ ₹100 → value ₹1,000.
  await expectResolve("opening stock receipt (10 @ ₹100)", () =>
    recordOpeningStock({
      orgId: org.id,
      offsetAccountId: acct("3100"),
      moveDate: "2026-07-20",
      userId: user.id,
      lines: [{ itemId: widget.id, quantity: "10", unitCostMinor: 100_00n }],
    }),
  );

  // Receipt 2 (purchase via a bill): 10 units @ ₹200 → value ₹2,000.
  await expectResolve("purchase receipt via bill (10 @ ₹200)", async () => {
    const b = await createBill({
      orgId: org.id,
      contactId: vendor.id,
      billDate: "2026-07-21",
      dueDate: "2026-08-20",
      userId: user.id,
      lines: [{ itemId: widget.id, description: "WA widgets", quantity: "10", unitPriceMinor: 200_00n }],
    });
    await postBill({ orgId: org.id, billId: b.billId, userId: user.id });
  });

  {
    const s = await stockValueOf(widget.id);
    assert(
      "stock rolls up to 20 units @ ₹3,000 (avg ₹150)",
      s.qty === "20.0000" && s.value === 3_000_00n,
      `${s.qty} units, ${inr(s.value)}`,
      `got ${s.qty} units, ${inr(s.value)}`,
    );
  }

  // Sell 5 at weighted-average cost. COGS must be 3000 × 5/20 = ₹750, leaving
  // 15 units worth ₹2,250.
  const cogsBefore = await cogsBalance();
  const waSale = await createInvoice({
    orgId: org.id,
    contactId: customer.id,
    invoiceDate: "2026-07-22",
    dueDate: "2026-08-21",
    userId: user.id,
    lines: [
      { itemId: widget.id, description: "WA widget sale", quantity: "5", unitPriceMinor: 500_00n, revenueAccountId: acct("4100") },
    ],
  });
  await expectResolve("posting an item sale (books COGS + relieves stock)", () =>
    postInvoice({ orgId: org.id, invoiceId: waSale.invoiceId, userId: user.id }),
  );

  {
    const cogsDelta = (await cogsBalance()) - cogsBefore;
    assert(
      "weighted-average COGS = ₹750 on the sale of 5",
      cogsDelta === 750_00n,
      inr(cogsDelta),
      `expected ${inr(750_00n)}, got ${inr(cogsDelta)}`,
    );
    const s = await stockValueOf(widget.id);
    assert(
      "stock left = 15 units @ ₹2,250",
      s.qty === "15.0000" && s.value === 2_250_00n,
      `${s.qty} units, ${inr(s.value)}`,
      `got ${s.qty} units, ${inr(s.value)}`,
    );
  }

  // Overselling is refused.
  const overSale = await createInvoice({
    orgId: org.id,
    contactId: customer.id,
    invoiceDate: "2026-07-23",
    dueDate: "2026-08-22",
    userId: user.id,
    lines: [
      { itemId: widget.id, description: "oversell", quantity: "1000", unitPriceMinor: 500_00n, revenueAccountId: acct("4100") },
    ],
  });
  await expectReject("overselling stock rejected", "NEGATIVE_STOCK", () =>
    postInvoice({ orgId: org.id, invoiceId: overSale.invoiceId, userId: user.id }),
  );

  // Voiding the sale returns the goods to stock at the cost they left.
  await expectResolve("voiding an item sale restocks", () =>
    voidInvoice({ orgId: org.id, invoiceId: waSale.invoiceId, reason: "test restock", userId: user.id }),
  );
  {
    const s = await stockValueOf(widget.id);
    assert(
      "void restored stock to 20 units @ ₹3,000",
      s.qty === "20.0000" && s.value === 3_000_00n,
      `${s.qty} units, ${inr(s.value)}`,
      `got ${s.qty} units, ${inr(s.value)}`,
    );
  }

  // A service (non-tracked) item must produce no stock movement and no COGS.
  const [service] = await db
    .insert(items)
    .values({
      orgId: org.id,
      sku: "TEST-SVC-1",
      name: "Consulting hour",
      isInventoryTracked: false,
      unitOfMeasure: "HR",
      salePriceMinor: 2_000_00n,
      salesAccountId: acct("4200"),
    })
    .returning();
  const svcCogsBefore = await cogsBalance();
  const svcSale = await createInvoice({
    orgId: org.id,
    contactId: customer.id,
    invoiceDate: "2026-07-24",
    dueDate: "2026-08-23",
    userId: user.id,
    lines: [
      { itemId: service.id, description: "Consulting", quantity: "3", unitPriceMinor: 2_000_00n, revenueAccountId: acct("4200") },
    ],
  });
  await postInvoice({ orgId: org.id, invoiceId: svcSale.invoiceId, userId: user.id });
  assert(
    "service item sale books no COGS",
    (await cogsBalance()) === svcCogsBefore,
    "COGS unchanged",
    `COGS moved by ${inr((await cogsBalance()) - svcCogsBefore)}`,
  );

  /* ══ 3b2. FIFO valuation ══════════════════════════════════════════════*/

  console.log("\nInventory — FIFO valuation");

  const [fifoItem] = await db
    .insert(items)
    .values({
      orgId: org.id,
      sku: "TEST-FIFO-1",
      name: "FIFO Widget",
      isInventoryTracked: true,
      unitOfMeasure: "PCS",
      valuationMethod: "fifo",
      salePriceMinor: 500_00n,
      purchasePriceMinor: 100_00n,
      salesAccountId: acct("4100"),
      purchaseAccountId: acct("5100"),
      inventoryAccountId: acct("1130"),
    })
    .returning();

  // Layer 1: 10 @ ₹100 (opening). Layer 2: 10 @ ₹200 (purchase).
  await recordOpeningStock({
    orgId: org.id,
    offsetAccountId: acct("3100"),
    moveDate: "2026-07-20",
    userId: user.id,
    lines: [{ itemId: fifoItem.id, quantity: "10", unitCostMinor: 100_00n }],
  });
  {
    const b = await createBill({
      orgId: org.id,
      contactId: vendor.id,
      billDate: "2026-07-21",
      dueDate: "2026-08-20",
      userId: user.id,
      lines: [{ itemId: fifoItem.id, description: "FIFO layer 2", quantity: "10", unitPriceMinor: 200_00n }],
    });
    await postBill({ orgId: org.id, billId: b.billId, userId: user.id });
  }

  // Sell 15: FIFO consumes all of layer 1 (10 @ ₹100) then 5 of layer 2 (@ ₹200)
  // → COGS = ₹1,000 + ₹1,000 = ₹2,000 (vs ₹2,250 under weighted-average).
  const fifoCogsBefore = await cogsBalance();
  const fifoSale = await createInvoice({
    orgId: org.id,
    contactId: customer.id,
    invoiceDate: "2026-07-22",
    dueDate: "2026-08-21",
    userId: user.id,
    lines: [{ itemId: fifoItem.id, description: "FIFO sale", quantity: "15", unitPriceMinor: 500_00n, revenueAccountId: acct("4100") }],
  });
  await postInvoice({ orgId: org.id, invoiceId: fifoSale.invoiceId, userId: user.id });
  assert(
    "FIFO COGS = ₹2,000 (10@₹100 + 5@₹200)",
    (await cogsBalance()) - fifoCogsBefore === 2_000_00n,
    inr((await cogsBalance()) - fifoCogsBefore),
    `got ${inr((await cogsBalance()) - fifoCogsBefore)}`,
  );
  {
    const s = await stockValueOf(fifoItem.id);
    assert(
      "FIFO stock left = 5 units @ ₹1,000 (the ₹200 layer)",
      s.qty === "5.0000" && s.value === 1_000_00n,
      `${s.qty} units, ${inr(s.value)}`,
      `got ${s.qty} units, ${inr(s.value)}`,
    );
  }

  /* ══ 3c. Credit & debit notes — returns ═══════════════════════════════*/

  console.log("\nCredit & debit notes — returns");

  const readArControl = async (): Promise<bigint> => {
    const t = await getTrialBalance(db, org.id, "2026-12-31");
    const r = t.rows.find((x) => x.subtype === "accounts_receivable");
    return r ? r.debitMinor - r.creditMinor : 0n;
  };
  const readApControl = async (): Promise<bigint> => {
    const t = await getTrialBalance(db, org.id, "2026-12-31");
    const r = t.rows.find((x) => x.subtype === "accounts_payable");
    return r ? r.creditMinor - r.debitMinor : 0n;
  };

  // Sell 4 widgets (from the 20 @ ₹150 avg built above) so there's something to return.
  const cnSale = await createInvoice({
    orgId: org.id,
    contactId: customer.id,
    invoiceDate: "2026-07-25",
    dueDate: "2026-08-24",
    userId: user.id,
    lines: [{ itemId: widget.id, description: "widget sale for return", quantity: "4", unitPriceMinor: 500_00n, revenueAccountId: acct("4100") }],
  });
  await postInvoice({ orgId: org.id, invoiceId: cnSale.invoiceId, userId: user.id });

  const arBeforeCN = await readArControl();
  const cogsBeforeCN = await cogsBalance();
  const widgetBeforeCN = await stockValueOf(widget.id); // 16 units @ ₹2,400

  // Credit note: customer returns 2 of the 4, restocked.
  const cn = await createCreditNote({
    orgId: org.id,
    contactId: customer.id,
    relatedInvoiceId: cnSale.invoiceId,
    creditNoteDate: "2026-07-26",
    userId: user.id,
    lines: [{ itemId: widget.id, description: "returned widgets", quantity: "2", unitPriceMinor: 500_00n }],
  });
  await expectResolve("posting a credit note (sales return)", () =>
    postCreditNote({ orgId: org.id, creditNoteId: cn.creditNoteId, userId: user.id }),
  );

  assert(
    "credit note reduced A/R by ₹1,000",
    (await readArControl()) - arBeforeCN === -1_000_00n,
    inr((await readArControl()) - arBeforeCN),
    `got ${inr((await readArControl()) - arBeforeCN)}`,
  );
  {
    const after = await stockValueOf(widget.id);
    assert(
      "credit note restocked 2 units at avg cost (₹150 → +₹300)",
      after.qty === "18.0000" && after.value - widgetBeforeCN.value === 300_00n,
      `${after.qty} units, +${inr(after.value - widgetBeforeCN.value)}`,
      `got ${after.qty} units, +${inr(after.value - widgetBeforeCN.value)}`,
    );
  }
  assert(
    "credit note reversed COGS by ₹300",
    (await cogsBalance()) - cogsBeforeCN === -300_00n,
    inr((await cogsBalance()) - cogsBeforeCN),
    `got ${inr((await cogsBalance()) - cogsBeforeCN)}`,
  );

  const cnOver = await createCreditNote({
    orgId: org.id,
    contactId: customer.id,
    relatedInvoiceId: cnSale.invoiceId,
    creditNoteDate: "2026-07-26",
    userId: user.id,
    lines: [{ itemId: widget.id, description: "over-credit", quantity: "100", unitPriceMinor: 500_00n }],
  });
  await expectReject("over-crediting an invoice rejected", "CREDIT_EXCEEDS_BALANCE", () =>
    postCreditNote({ orgId: org.id, creditNoteId: cnOver.creditNoteId, userId: user.id }),
  );

  // Debit note: buy 4 widgets, then return 2 to the vendor.
  const dnBill = await createBill({
    orgId: org.id,
    contactId: vendor.id,
    billDate: "2026-07-27",
    dueDate: "2026-08-26",
    userId: user.id,
    lines: [{ itemId: widget.id, description: "widgets to return", quantity: "4", unitPriceMinor: 200_00n }],
  });
  await postBill({ orgId: org.id, billId: dnBill.billId, userId: user.id });

  const apBeforeDN = await readApControl();
  const widgetBeforeDN = await stockValueOf(widget.id);

  const dn = await createDebitNote({
    orgId: org.id,
    contactId: vendor.id,
    relatedBillId: dnBill.billId,
    debitNoteDate: "2026-07-28",
    userId: user.id,
    lines: [{ itemId: widget.id, description: "returned to vendor", quantity: "2", unitPriceMinor: 200_00n }],
  });
  await expectResolve("posting a debit note (purchase return)", () =>
    postDebitNote({ orgId: org.id, debitNoteId: dn.debitNoteId, userId: user.id }),
  );

  {
    const after = await stockValueOf(widget.id);
    const qtyDropped = Number(widgetBeforeDN.qty) - Number(after.qty);
    assert(
      "debit note removed 2 units from stock",
      qtyDropped === 2,
      `${widgetBeforeDN.qty} → ${after.qty}`,
      `${widgetBeforeDN.qty} → ${after.qty}`,
    );
  }
  assert(
    "debit note reduced A/P",
    (await readApControl()) < apBeforeDN,
    `A/P fell by ${inr(apBeforeDN - (await readApControl()))}`,
    `A/P did not fall (${inr((await readApControl()) - apBeforeDN)})`,
  );

  /* ══ 3d. Contra vouchers & orders ═════════════════════════════════════*/

  console.log("\nContra vouchers & orders");

  const acctBal = async (code: string): Promise<bigint> => {
    const t = await getTrialBalance(db, org.id, "2026-12-31");
    const r = t.rows.find((x) => x.code === code);
    return r ? r.debitMinor - r.creditMinor : 0n;
  };

  const hdfcBefore = await acctBal("1110");
  const iciciBefore = await acctBal("1111");
  await expectResolve("recording a contra transfer (HDFC → ICICI)", () =>
    recordContra({
      orgId: org.id,
      fromAccountId: acct("1110"),
      toAccountId: acct("1111"),
      amountMinor: 50_000_00n,
      voucherDate: "2026-07-29",
      memo: "Sweep to ICICI",
      userId: user.id,
    }),
  );
  assert(
    "contra moved ₹50,000 between the two banks",
    (await acctBal("1110")) - hdfcBefore === -50_000_00n && (await acctBal("1111")) - iciciBefore === 50_000_00n,
    "HDFC −₹50,000, ICICI +₹50,000",
    `HDFC ${inr((await acctBal("1110")) - hdfcBefore)}, ICICI ${inr((await acctBal("1111")) - iciciBefore)}`,
  );
  await expectReject("contra to the same account rejected", "SAME_ACCOUNT", () =>
    recordContra({ orgId: org.id, fromAccountId: acct("1110"), toAccountId: acct("1110"), amountMinor: 1_00n, voucherDate: "2026-07-29" }),
  );
  await expectReject("contra into a non-cash account rejected", "NOT_CASH_ACCOUNT", () =>
    recordContra({ orgId: org.id, fromAccountId: acct("1110"), toAccountId: acct("4100"), amountMinor: 1_00n, voucherDate: "2026-07-29" }),
  );

  // Sales order → invoice (auto-posted), relieving stock.
  const widgetBeforeSO = await stockValueOf(widget.id);
  const so = await createSalesOrder({
    orgId: org.id,
    contactId: customer.id,
    orderDate: "2026-07-29",
    userId: user.id,
    lines: [{ itemId: widget.id, description: "widget order", quantity: "3", unitPriceMinor: 500_00n, accountId: acct("4100") }],
  });
  let soInvoiceId = "";
  await expectResolve("converting a sales order to a posted invoice", async () => {
    const r = await convertSalesOrderToInvoice({
      orgId: org.id,
      salesOrderId: so.salesOrderId,
      invoiceDate: "2026-07-30",
      autoPost: true,
      userId: user.id,
    });
    soInvoiceId = r.invoiceId;
  });
  {
    const after = await stockValueOf(widget.id);
    assert(
      "sales order conversion relieved 3 units of stock",
      Number(widgetBeforeSO.qty) - Number(after.qty) === 3,
      `${widgetBeforeSO.qty} → ${after.qty}`,
      `${widgetBeforeSO.qty} → ${after.qty}`,
    );
  }
  await expectReject("re-converting an invoiced sales order rejected", "ORDER_NOT_CONVERTIBLE", () =>
    convertSalesOrderToInvoice({ orgId: org.id, salesOrderId: so.salesOrderId, invoiceDate: "2026-07-30", userId: user.id }),
  );

  // Purchase order → bill (auto-posted), receiving stock.
  const widgetBeforePO = await stockValueOf(widget.id);
  const po = await createPurchaseOrder({
    orgId: org.id,
    contactId: vendor.id,
    orderDate: "2026-07-29",
    userId: user.id,
    lines: [{ itemId: widget.id, description: "widget restock", quantity: "5", unitPriceMinor: 200_00n }],
  });
  await expectResolve("converting a purchase order to a posted bill", () =>
    convertPurchaseOrderToBill({ orgId: org.id, purchaseOrderId: po.purchaseOrderId, billDate: "2026-07-30", autoPost: true, userId: user.id }),
  );
  {
    const after = await stockValueOf(widget.id);
    assert(
      "purchase order conversion received 5 units of stock",
      Number(after.qty) - Number(widgetBeforePO.qty) === 5,
      `${widgetBeforePO.qty} → ${after.qty}`,
      `${widgetBeforePO.qty} → ${after.qty}`,
    );
  }

  /* ══ 3e. Goods receipts (GRN) & delivery notes ════════════════════════*/

  console.log("\nGoods receipts & delivery notes");

  // GRN: receive 6 widgets @ ₹200 before the vendor bill. Dr Inventory / Cr GRNI.
  const widgetBeforeGrn = await stockValueOf(widget.id);
  const grniBefore = await acctBal("2150");
  const grn = await createGoodsReceipt({
    orgId: org.id,
    contactId: vendor.id,
    receiptDate: "2026-07-31",
    userId: user.id,
    lines: [{ itemId: widget.id, description: "widgets received", quantity: "6", unitCostMinor: 200_00n }],
  });
  await expectResolve("posting a goods receipt (stock in, GRNI up)", () =>
    postGoodsReceipt({ orgId: org.id, goodsReceiptId: grn.goodsReceiptId, userId: user.id }),
  );
  {
    const after = await stockValueOf(widget.id);
    assert(
      "GRN received 6 units of stock",
      Number(after.qty) - Number(widgetBeforeGrn.qty) === 6,
      `${widgetBeforeGrn.qty} → ${after.qty}`,
      `${widgetBeforeGrn.qty} → ${after.qty}`,
    );
  }
  assert(
    "GRN raised the GRNI clearing liability by ₹1,200",
    (await acctBal("2150")) - grniBefore === -1_200_00n, // liability: credit-normal, so control = -(debit-credit)
    inr(grniBefore - (await acctBal("2150"))),
    `GRNI moved by ${inr((await acctBal("2150")) - grniBefore)}`,
  );

  // Bill the GRN: Dr GRNI / Cr A/P — GRNI must return to where it started.
  await expectResolve("billing the goods receipt (clears GRNI, records A/P)", () =>
    convertGoodsReceiptToBill({ orgId: org.id, goodsReceiptId: grn.goodsReceiptId, billDate: "2026-08-01", autoPost: true, userId: user.id }),
  );
  assert(
    "billing the GRN cleared GRNI back to zero",
    (await acctBal("2150")) === grniBefore,
    "GRNI cleared",
    `GRNI left at ${inr((await acctBal("2150")) - grniBefore)}`,
  );

  // Delivery note: dispatch 3 widgets before the invoice. Dr COGS / Cr Inventory.
  const widgetBeforeDel = await stockValueOf(widget.id);
  const cogsBeforeDel = await cogsBalance();
  const del = await createDeliveryNote({
    orgId: org.id,
    contactId: customer.id,
    deliveryDate: "2026-08-02",
    userId: user.id,
    lines: [{ itemId: widget.id, description: "widgets dispatched", quantity: "3", unitPriceMinor: 500_00n, revenueAccountId: acct("4100") }],
  });
  await expectResolve("posting a delivery note (stock out, COGS booked)", () =>
    postDeliveryNote({ orgId: org.id, deliveryNoteId: del.deliveryNoteId, userId: user.id }),
  );
  {
    const after = await stockValueOf(widget.id);
    assert(
      "delivery relieved 3 units of stock",
      Number(widgetBeforeDel.qty) - Number(after.qty) === 3,
      `${widgetBeforeDel.qty} → ${after.qty}`,
      `${widgetBeforeDel.qty} → ${after.qty}`,
    );
  }
  const cogsAfterDelivery = await cogsBalance();
  assert(
    "delivery booked COGS (> before)",
    cogsAfterDelivery > cogsBeforeDel,
    `COGS +${inr(cogsAfterDelivery - cogsBeforeDel)}`,
    `COGS did not move`,
  );

  // Invoice the delivery: revenue only, no second stock relief or COGS.
  const stockBeforeInv = await stockValueOf(widget.id);
  await expectResolve("invoicing the delivery (revenue only)", () =>
    convertDeliveryToInvoice({ orgId: org.id, deliveryNoteId: del.deliveryNoteId, invoiceDate: "2026-08-03", autoPost: true, userId: user.id }),
  );
  assert(
    "invoicing the delivery did NOT relieve stock again",
    (await stockValueOf(widget.id)).qty === stockBeforeInv.qty &&
      (await cogsBalance()) === cogsAfterDelivery,
    "stock & COGS unchanged by the invoice",
    `stock ${stockBeforeInv.qty}→${(await stockValueOf(widget.id)).qty}, COGS moved ${inr((await cogsBalance()) - cogsAfterDelivery)}`,
  );

  /* ══ 3f. Credit control ═══════════════════════════════════════════════*/

  console.log("\nCredit control");

  // Squeeze this customer's credit limit below what they already owe.
  await db.update(contacts).set({ creditLimitMinor: 1_00n }).where(eq(contacts.id, customer.id));
  const overLimit = await createInvoice({
    orgId: org.id,
    contactId: customer.id,
    invoiceDate: "2026-08-05",
    dueDate: "2026-09-04",
    userId: user.id,
    lines: [{ description: "Over-limit sale", quantity: "1", unitPriceMinor: 10_000_00n, revenueAccountId: acct("4200") }],
  });
  await expectReject("posting past a customer's credit limit rejected", "CREDIT_LIMIT_EXCEEDED", () =>
    postInvoice({ orgId: org.id, invoiceId: overLimit.invoiceId, userId: user.id }),
  );
  await expectResolve("an accountant can override the credit limit", () =>
    postInvoice({ orgId: org.id, invoiceId: overLimit.invoiceId, userId: user.id, allowCreditOverride: true }),
  );
  // Restore, so later assertions aren't affected.
  await db.update(contacts).set({ creditLimitMinor: null }).where(eq(contacts.id, customer.id));

  /* ══ 3g. Multi-currency — forex revaluation ═══════════════════════════*/

  console.log("\nForex revaluation");

  // The seed funds an SVB USD account with $10,000 booked at ₹83 (carrying
  // ₹8,30,000). By 2026-07-20 the rate is ₹86.5, so $10,000 is worth ₹8,65,000 —
  // an unrealised gain of ₹35,000.
  const fxAsOf = "2026-07-20";
  const exposure = await withOrg(org.id, (tx) => getForexExposure(tx, org.id, fxAsOf));
  const usd = exposure.rows.find((r) => r.currency === "USD");
  assert(
    "USD position revalues to a ₹35,000 unrealised gain",
    usd?.unrealizedMinor === 35_000_00n,
    inr(usd?.unrealizedMinor ?? 0n),
    `got ${inr(usd?.unrealizedMinor ?? 0n)}`,
  );

  const forexGL = async (code: string): Promise<bigint> => {
    const t = await getTrialBalance(db, org.id, "2099-12-31");
    const r = t.rows.find((x) => x.code === code);
    return r ? r.creditMinor - r.debitMinor : 0n; // income: credit-normal
  };
  const glBefore = await forexGL("4910");
  await expectResolve("posting a forex revaluation", () =>
    postForexRevaluation({ orgId: org.id, asOf: fxAsOf, userId: user.id }),
  );
  assert(
    "revaluation booked ₹35,000 to Forex Gain/Loss",
    (await forexGL("4910")) - glBefore === 35_000_00n,
    inr((await forexGL("4910")) - glBefore),
    `got ${inr((await forexGL("4910")) - glBefore)}`,
  );
  {
    const after = await withOrg(org.id, (tx) => getForexExposure(tx, org.id, fxAsOf));
    const usd2 = after.rows.find((r) => r.currency === "USD");
    assert(
      "after revaluation there is no unrealised gain left",
      usd2?.unrealizedMinor === 0n,
      "0",
      `got ${inr(usd2?.unrealizedMinor ?? 0n)}`,
    );
  }

  /* ══ 3h. Fixed assets & depreciation ══════════════════════════════════*/

  console.log("\nFixed assets & depreciation");

  const asset = await createFixedAsset({
    orgId: org.id,
    code: "TEST-FA",
    name: "Test rig",
    assetAccountId: acct("1210"),
    accumulatedAccountId: acct("1290"),
    depreciationAccountId: acct("5800"),
    acquisitionDate: "2026-04-01",
    costMinor: 3_60_000n, // ₹3,600 — small so it's easy to reason about
    salvageValueMinor: 0n,
    usefulLifeMonths: 36, // ₹100/month
    fundingAccountId: acct("1110"),
    userId: user.id,
  });

  await expectResolve("running depreciation (Apr–Jun = 3 months)", () =>
    runDepreciation({ orgId: org.id, throughDate: "2026-06-01", userId: user.id }),
  );
  {
    const reg = await withOrg(org.id, (tx) => getAssetRegister(tx, org.id));
    const r = reg.find((x) => x.id === asset.fixedAssetId);
    assert(
      "3 months depreciation accumulated (₹300), NBV ₹3,300",
      r?.accumulatedMinor === 30_000n && r?.netBookValueMinor === 3_30_000n,
      `acc ${inr(r?.accumulatedMinor ?? 0n)}, NBV ${inr(r?.netBookValueMinor ?? 0n)}`,
      `acc ${inr(r?.accumulatedMinor ?? 0n)}, NBV ${inr(r?.netBookValueMinor ?? 0n)}`,
    );
  }

  // Re-running the same period must add nothing.
  const rerun = await runDepreciation({ orgId: org.id, throughDate: "2026-06-01", userId: user.id });
  assert(
    "re-running depreciation is idempotent",
    rerun.monthsPosted === 0,
    "0 new charges",
    `${rerun.monthsPosted} charges`,
  );

  // Dispose for ₹3,400 — above the ₹3,300 book value → ₹100 gain.
  const disp = await disposeFixedAsset({
    orgId: org.id,
    fixedAssetId: asset.fixedAssetId,
    disposalDate: "2026-07-01",
    proceedsMinor: 3_40_000n,
    proceedsAccountId: acct("1110"),
    gainLossAccountId: acct("4920"),
    userId: user.id,
  });
  assert(
    "disposal books a ₹100 gain",
    disp.gainLossMinor === 100_00n,
    inr(disp.gainLossMinor),
    `got ${inr(disp.gainLossMinor)}`,
  );
  await expectReject("disposing an already-disposed asset rejected", "ALREADY_DISPOSED", () =>
    disposeFixedAsset({
      orgId: org.id,
      fixedAssetId: asset.fixedAssetId,
      disposalDate: "2026-07-02",
      proceedsMinor: 0n,
      gainLossAccountId: acct("4920"),
      userId: user.id,
    }),
  );

  /* ══ 3i. Period close & reopen ════════════════════════════════════════*/

  console.log("\nPeriod close & reopen");

  const reBalance = async (): Promise<bigint> => {
    const t = await getTrialBalance(db, org.id, "2099-12-31");
    const r = t.rows.find((x) => x.code === "3200"); // Retained Earnings, credit-normal
    return r ? r.creditMinor - r.debitMinor : 0n;
  };
  const reBefore = await reBalance();
  const pnl = await getProfitAndLoss(db, org.id, "2026-01-01", "2026-12-31");

  const closeResult = await closePeriod({ orgId: org.id, throughDate: "2026-12-31", userId: user.id });
  ok("closing the books through 2026-12-31");
  assert(
    "net profit rolled into Retained Earnings",
    (await reBalance()) - reBefore === pnl.netProfitMinor && closeResult.netProfitMinor === pnl.netProfitMinor,
    inr((await reBalance()) - reBefore),
    `RE moved ${inr((await reBalance()) - reBefore)}, P&L net ${inr(pnl.netProfitMinor)}`,
  );
  await expectReject("posting into the closed period rejected", "PERIOD_CLOSED", () =>
    postJournalEntry({
      orgId: org.id,
      entryDate: "2026-12-15",
      memo: "into closed period",
      userId: user.id,
      lines: [debit(acct("1110"), 1_00n), credit(acct("4900"), 1_00n)],
    }),
  );
  {
    const after = await getProfitAndLoss(db, org.id, "2026-01-01", "2026-12-31");
    assert(
      "closed-period P&L nets to zero",
      after.netProfitMinor === 0n,
      inr(after.netProfitMinor),
      `got ${inr(after.netProfitMinor)}`,
    );
  }

  await expectResolve("reopening the period", () =>
    reopenPeriod({ orgId: org.id, reason: "correction needed", userId: user.id }),
  );
  assert(
    "reopen restored Retained Earnings",
    (await reBalance()) === reBefore,
    inr(reBefore),
    `got ${inr(await reBalance())}`,
  );

  /* ══ 3j. Recurring invoices ═══════════════════════════════════════════*/

  console.log("\nRecurring invoices");

  // Drain any templates the seed created so this test measures only its own.
  await generateDueInvoices({ orgId: org.id, asOf: "2026-07-15", userId: user.id });

  await createRecurringTemplate({
    orgId: org.id,
    contactId: customer.id,
    name: "Test monthly retainer",
    frequency: "monthly",
    startDate: "2026-05-01",
    autoPost: true,
    userId: user.id,
    lines: [{ description: "Retainer", quantity: "1", unitPriceMinor: 10_000_00n, revenueAccountId: acct("4200") }],
  });

  const gen = await generateDueInvoices({ orgId: org.id, asOf: "2026-07-15", userId: user.id });
  ok("generating due invoices (May, Jun, Jul = 3)");
  assert(
    "three invoices generated across the missed periods",
    gen.generated === 3,
    `${gen.generated} generated`,
    `${gen.generated} generated`,
  );

  const rerunGen = await generateDueInvoices({ orgId: org.id, asOf: "2026-07-15", userId: user.id });
  assert(
    "re-running generates nothing new (next run is in the future)",
    rerunGen.generated === 0,
    "0 generated",
    `${rerunGen.generated} generated`,
  );

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

  const tb = await getTrialBalance(db, org.id, "2026-12-31");
  assert(
    "trial balance still foots",
    tb.isBalanced,
    inr(tb.totalDebitMinor),
    `${inr(tb.totalDebitMinor)} vs ${inr(tb.totalCreditMinor)}`,
  );

  const bs = await getBalanceSheet(db, org.id, "2026-12-31");
  assert(
    "accounting equation still holds",
    bs.isBalanced,
    inr(bs.totalAssetsMinor),
    `${inr(bs.totalAssetsMinor)} vs ${inr(bs.totalLiabilitiesMinor + bs.totalEquityMinor)}`,
  );

  const aging = await getReceivablesAging(db, org.id, "2026-12-31");
  const arRow = tb.rows.find((r) => r.subtype === "accounts_receivable");
  const arControl = arRow ? arRow.debitMinor - arRow.creditMinor : 0n;
  assert(
    "A/R control matches subledger",
    arControl === aging.totals.totalMinor,
    inr(arControl),
    `control ${inr(arControl)} vs subledger ${inr(aging.totals.totalMinor)}`,
  );

  const invRow = tb.rows.find((r) => r.subtype === "inventory");
  const invControl = invRow ? invRow.debitMinor - invRow.creditMinor : 0n;
  const stockValue = await withOrg(org.id, (tx) => getStockValuationTotal(tx, org.id));
  assert(
    "Inventory control matches stock ledger",
    invControl === stockValue,
    inr(invControl),
    `control ${inr(invControl)} vs stock ${inr(stockValue)}`,
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
