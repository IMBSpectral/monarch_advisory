/**
 * Seed — turns the demo fixtures in src/data/mock.ts into a real set of books.
 *
 * Every invoice, receipt, and bill here is created through the same service layer
 * the app uses, so the resulting ledger is genuinely balanced rather than
 * hand-written to look balanced. If the posting engine has a bug, this script
 * fails — which makes it a useful smoke test as well as a fixture loader.
 *
 * Run with:  bun run db:seed
 */

import { eq, sql } from "drizzle-orm";
import { db, pgClient } from "./client";
import {
  accounts,
  bankAccounts,
  contacts,
  documentSequences,
  items,
  memberships,
  organizations,
  taxRates,
  users,
  type AccountSubtype,
  type AccountType,
} from "./schema";
import { createInvoice, postInvoice, recordCustomerPayment } from "@/server/invoicing";
import { credit, debit, postJournalEntry, resolveControlAccount } from "@/server/ledger";
import {
  bankAccounts as mockBankAccounts,
  bills as mockBills,
  customers as mockCustomers,
  invoices as mockInvoices,
  items as mockItems,
  vendors as mockVendors,
} from "@/data/mock";

/** Rupees (as in mock.ts) → paise. */
const toPaise = (rupees: number): bigint => BigInt(Math.round(rupees * 100));

/* ────────────────────────────────────────────────────────────────────────────
 * Chart of accounts
 * ──────────────────────────────────────────────────────────────────────────*/

type AccountSeed = {
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  isGroup?: boolean;
  /** Control accounts the posting engine resolves by subtype. */
  isSystem?: boolean;
  parent?: string;
};

/**
 * A standard Indian small-business chart of accounts.
 *
 * The `isSystem` flags matter: `resolveControlAccount` finds AR, AP, and tax
 * payable by (subtype + isSystem), so exactly one account per control subtype
 * must carry the flag.
 */
const CHART: AccountSeed[] = [
  // Assets
  { code: "1000", name: "Assets", type: "asset", subtype: "other_asset", isGroup: true },
  {
    code: "1100",
    name: "Current Assets",
    type: "asset",
    subtype: "other_current_asset",
    isGroup: true,
    parent: "1000",
  },
  {
    code: "1110",
    name: "HDFC Current 8821",
    type: "asset",
    subtype: "cash_and_bank",
    parent: "1100",
  },
  {
    code: "1111",
    name: "ICICI Current 4432",
    type: "asset",
    subtype: "cash_and_bank",
    parent: "1100",
  },
  {
    code: "1112",
    name: "Axis Escrow 1104",
    type: "asset",
    subtype: "cash_and_bank",
    parent: "1100",
  },
  { code: "1115", name: "Petty Cash", type: "asset", subtype: "cash_and_bank", parent: "1100" },
  {
    code: "1120",
    name: "Accounts Receivable",
    type: "asset",
    subtype: "accounts_receivable",
    isSystem: true,
    parent: "1100",
  },
  {
    code: "1130",
    name: "Inventory",
    type: "asset",
    subtype: "inventory",
    isSystem: true,
    parent: "1100",
  },
  {
    code: "1140",
    name: "Input GST Credit",
    type: "asset",
    subtype: "other_current_asset",
    parent: "1100",
  },
  {
    code: "1200",
    name: "Fixed Assets",
    type: "asset",
    subtype: "fixed_asset",
    isGroup: true,
    parent: "1000",
  },
  {
    code: "1210",
    name: "Computers & Equipment",
    type: "asset",
    subtype: "fixed_asset",
    parent: "1200",
  },
  {
    code: "1220",
    name: "Furniture & Fixtures",
    type: "asset",
    subtype: "fixed_asset",
    parent: "1200",
  },
  {
    code: "1290",
    name: "Accumulated Depreciation",
    type: "asset",
    subtype: "accumulated_depreciation",
    parent: "1200",
  },

  // Liabilities
  {
    code: "2000",
    name: "Liabilities",
    type: "liability",
    subtype: "other_current_liability",
    isGroup: true,
  },
  {
    code: "2100",
    name: "Accounts Payable",
    type: "liability",
    subtype: "accounts_payable",
    isSystem: true,
    parent: "2000",
  },
  {
    code: "2200",
    name: "GST Payable",
    type: "liability",
    subtype: "tax_payable",
    isSystem: true,
    parent: "2000",
  },
  { code: "2210", name: "TDS Payable", type: "liability", subtype: "tax_payable", parent: "2000" },
  {
    code: "2300",
    name: "Long-term Loans",
    type: "liability",
    subtype: "long_term_liability",
    parent: "2000",
  },
  {
    code: "2400",
    name: "Salaries Payable",
    type: "liability",
    subtype: "other_current_liability",
    parent: "2000",
  },

  // Equity
  { code: "3000", name: "Equity", type: "equity", subtype: "equity", isGroup: true },
  { code: "3100", name: "Partner Capital", type: "equity", subtype: "equity", parent: "3000" },
  {
    code: "3200",
    name: "Retained Earnings",
    type: "equity",
    subtype: "retained_earnings",
    isSystem: true,
    parent: "3000",
  },

  // Income
  { code: "4000", name: "Revenue", type: "income", subtype: "operating_revenue", isGroup: true },
  {
    code: "4100",
    name: "Product Sales",
    type: "income",
    subtype: "operating_revenue",
    isSystem: true,
    parent: "4000",
  },
  {
    code: "4200",
    name: "Service Revenue",
    type: "income",
    subtype: "operating_revenue",
    parent: "4000",
  },
  { code: "4900", name: "Other Income", type: "income", subtype: "other_income", parent: "4000" },

  // Expenses
  { code: "5000", name: "Expenses", type: "expense", subtype: "operating_expense", isGroup: true },
  {
    code: "5100",
    name: "Cost of Goods Sold",
    type: "expense",
    subtype: "cost_of_goods_sold",
    isSystem: true,
    parent: "5000",
  },
  {
    code: "5200",
    name: "Salaries & Wages",
    type: "expense",
    subtype: "operating_expense",
    parent: "5000",
  },
  {
    code: "5300",
    name: "Rent & Utilities",
    type: "expense",
    subtype: "operating_expense",
    parent: "5000",
  },
  {
    code: "5400",
    name: "Marketing",
    type: "expense",
    subtype: "operating_expense",
    parent: "5000",
  },
  {
    code: "5500",
    name: "Cloud & SaaS",
    type: "expense",
    subtype: "operating_expense",
    parent: "5000",
  },
  {
    code: "5600",
    name: "Professional Fees",
    type: "expense",
    subtype: "operating_expense",
    parent: "5000",
  },
  {
    code: "5700",
    name: "Travel & Conveyance",
    type: "expense",
    subtype: "operating_expense",
    parent: "5000",
  },
  {
    code: "5800",
    name: "Depreciation",
    type: "expense",
    subtype: "depreciation_expense",
    parent: "5000",
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Seed
 * ──────────────────────────────────────────────────────────────────────────*/

async function main() {
  console.log("Seeding Monarch…\n");

  // Idempotent: wipe and rebuild. Safe because this only ever runs against dev.
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed a production database.");
  }

  await db.execute(sql`
    truncate table
      audit_log, journal_lines, journal_entries, payment_allocations, payments,
      invoice_lines, invoices, bill_lines, bills, bank_transactions,
      bank_accounts, items, tax_rates, contacts, accounts, document_sequences,
      memberships, organizations, users
    restart identity cascade
  `);

  /* ── Organization & user ────────────────────────────────────────────────*/

  const [org] = await db
    .insert(organizations)
    .values({
      name: "IMB Labs LLP",
      legalName: "IMB Labs Limited Liability Partnership",
      countryCode: "IN",
      baseCurrency: "INR",
      taxRegistrationNumber: "27AABCI1234N1Z5",
      fiscalYearStartMonth: 4,
      timezone: "Asia/Kolkata",
    })
    .returning();
  console.log(`  org        ${org.name}`);

  const [user] = await db
    .insert(users)
    .values({ email: "founder@imblabs.example", name: "Tanush" })
    .returning();

  await db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });

  /* ── Document sequences ─────────────────────────────────────────────────*/

  await db.insert(documentSequences).values([
    { orgId: org.id, documentType: "invoice", prefix: "INV-2026-", nextNumber: 1n, padWidth: 4 },
    { orgId: org.id, documentType: "bill", prefix: "BILL-", nextNumber: 4516n, padWidth: 4 },
    { orgId: org.id, documentType: "payment", prefix: "PAY-", nextNumber: 1n, padWidth: 4 },
    { orgId: org.id, documentType: "journal", prefix: "JE-", nextNumber: 1n, padWidth: 6 },
  ]);

  /* ── Chart of accounts ──────────────────────────────────────────────────*/

  const accountIdByCode = new Map<string, string>();
  // Two passes so parents exist before children reference them.
  for (const seed of CHART) {
    const [row] = await db
      .insert(accounts)
      .values({
        orgId: org.id,
        code: seed.code,
        name: seed.name,
        type: seed.type,
        subtype: seed.subtype,
        isGroup: seed.isGroup ?? false,
        isSystem: seed.isSystem ?? false,
      })
      .returning({ id: accounts.id });
    accountIdByCode.set(seed.code, row.id);
  }
  for (const seed of CHART) {
    if (!seed.parent) continue;
    await db
      .update(accounts)
      .set({ parentId: accountIdByCode.get(seed.parent) })
      .where(eq(accounts.id, accountIdByCode.get(seed.code)!));
  }
  console.log(`  accounts   ${CHART.length}`);

  const acct = (code: string) => accountIdByCode.get(code)!;

  /* ── Tax rates ──────────────────────────────────────────────────────────*/

  const [gst18] = await db
    .insert(taxRates)
    .values({
      orgId: org.id,
      name: "GST 18%",
      rateBps: 1800,
      outputAccountId: acct("2200"),
      inputAccountId: acct("1140"),
    })
    .returning();

  await db.insert(taxRates).values([
    {
      orgId: org.id,
      name: "GST 12%",
      rateBps: 1200,
      outputAccountId: acct("2200"),
      inputAccountId: acct("1140"),
    },
    {
      orgId: org.id,
      name: "GST 5%",
      rateBps: 500,
      outputAccountId: acct("2200"),
      inputAccountId: acct("1140"),
    },
    {
      orgId: org.id,
      name: "GST 0% (Exempt)",
      rateBps: 0,
      outputAccountId: acct("2200"),
      inputAccountId: acct("1140"),
    },
  ]);
  console.log(`  tax rates  4`);

  /* ── Contacts ───────────────────────────────────────────────────────────*/

  const customerIdByName = new Map<string, string>();
  for (const c of mockCustomers) {
    const [row] = await db
      .insert(contacts)
      .values({
        orgId: org.id,
        type: "customer",
        displayName: c.name,
        email: c.email,
        phone: c.phone,
        taxRegistrationNumber: c.gstin,
        placeOfSupplyCode: c.gstin.slice(0, 2),
        currency: "INR",
        paymentTermDays: 30,
        billingAddress: { city: c.city, country: "IN" },
      })
      .returning({ id: contacts.id });
    customerIdByName.set(c.name, row.id);
  }

  // Invoices reference a few customers that aren't in the customers fixture.
  for (const name of new Set(mockInvoices.map((i) => i.customer))) {
    if (customerIdByName.has(name)) continue;
    const [row] = await db
      .insert(contacts)
      .values({
        orgId: org.id,
        type: "customer",
        displayName: name,
        currency: "INR",
        paymentTermDays: 30,
      })
      .returning({ id: contacts.id });
    customerIdByName.set(name, row.id);
  }

  const vendorIdByName = new Map<string, string>();
  for (const v of [
    ...mockVendors,
    ...mockBills.map((b) => ({
      name: b.vendor,
      email: null,
      phone: null,
      city: null,
      gstin: null,
    })),
  ]) {
    if (vendorIdByName.has(v.name)) continue;
    const [row] = await db
      .insert(contacts)
      .values({
        orgId: org.id,
        type: "vendor",
        displayName: v.name,
        email: v.email ?? null,
        phone: v.phone ?? null,
        taxRegistrationNumber: v.gstin ?? null,
        currency: "INR",
        paymentTermDays: 30,
        billingAddress: v.city ? { city: v.city, country: "IN" } : null,
      })
      .returning({ id: contacts.id });
    vendorIdByName.set(v.name, row.id);
  }
  console.log(`  contacts   ${customerIdByName.size} customers, ${vendorIdByName.size} vendors`);

  /* ── Items ──────────────────────────────────────────────────────────────*/

  for (const it of mockItems) {
    await db.insert(items).values({
      orgId: org.id,
      sku: it.sku,
      name: it.name,
      isInventoryTracked: true,
      unitOfMeasure: it.uom,
      salePriceMinor: toPaise(it.price),
      purchasePriceMinor: toPaise(it.cost),
      salesAccountId: acct("4100"),
      purchaseAccountId: acct("5100"),
      inventoryAccountId: acct("1130"),
      defaultTaxRateId: gst18.id,
    });
  }
  console.log(`  items      ${mockItems.length}`);

  /* ── Bank accounts ──────────────────────────────────────────────────────*/

  const bankCodeByName: Record<string, string> = {
    "HDFC Current 8821": "1110",
    "ICICI Current 4432": "1111",
    "Axis Escrow 1104": "1112",
  };
  for (const b of mockBankAccounts) {
    await db.insert(bankAccounts).values({
      orgId: org.id,
      accountId: acct(bankCodeByName[b.name]),
      name: b.name,
      institutionName: b.name.split(" ")[0],
      accountNumberMasked: `••••${b.name.slice(-4)}`,
      currency: "INR",
      feedBalanceMinor: toPaise(b.balance),
      feedLastSyncedAt: new Date(),
    });
  }
  console.log(`  banks      ${mockBankAccounts.length}`);

  /* ── Opening balances ───────────────────────────────────────────────────*/

  // Capital injection and opening cash. Without this the bank accounts would go
  // negative as soon as we post bills, and the balance sheet would look absurd.
  const openingCash = toPaise(15_000_000);
  await postJournalEntry({
    orgId: org.id,
    entryDate: "2026-04-01",
    source: "opening_balance",
    memo: "Opening balance — partner capital",
    userId: user.id,
    lines: [
      debit(acct("1110"), openingCash, { memo: "Opening bank balance" }),
      credit(acct("3100"), openingCash, { memo: "Partner capital introduced" }),
    ],
  });

  /* ── Invoices ───────────────────────────────────────────────────────────*/

  // mock.ts amounts are tax-inclusive totals. Back out an 18% GST base so the
  // posted total matches the fixture: base = total / 1.18.
  const invoiceIdByNumber = new Map<string, string>();
  let invoiceCount = 0;

  for (const inv of [...mockInvoices].reverse()) {
    const totalPaise = toPaise(inv.amount);
    const basePaise = (totalPaise * 10_000n) / 11_800n;

    const { invoiceId, invoiceNumber } = await createInvoice({
      orgId: org.id,
      contactId: customerIdByName.get(inv.customer)!,
      invoiceDate: inv.date,
      dueDate: inv.due,
      currency: "INR",
      userId: user.id,
      lines: [
        {
          description: "Professional services & product supply",
          quantity: "1",
          unitPriceMinor: basePaise,
          taxRateId: gst18.id,
          revenueAccountId: acct("4100"),
        },
      ],
    });

    await postInvoice({ orgId: org.id, invoiceId, userId: user.id });
    invoiceIdByNumber.set(inv.id, invoiceId);
    invoiceCount++;

    /* ── Receipts ─────────────────────────────────────────────────────────*/

    // Fixture `balance` is what's still owed; total − balance is what was paid.
    const paidPaise = totalPaise - toPaise(inv.balance);
    if (paidPaise > 0n) {
      // Re-read the posted total: rounding on the tax base can shift it by a
      // paisa, and over-allocating would (correctly) be rejected.
      const [posted] = (await db.execute(sql`
        select total_minor from invoices where id = ${invoiceId}
      `)) as unknown as Array<{ total_minor: string }>;
      const actualTotal = BigInt(posted.total_minor);
      const applied = paidPaise > actualTotal ? actualTotal : paidPaise;

      await recordCustomerPayment({
        orgId: org.id,
        contactId: customerIdByName.get(inv.customer)!,
        paymentDate: inv.due,
        amountMinor: applied,
        depositAccountId: acct("1110"),
        method: "NEFT",
        referenceNumber: `NEFT-${invoiceNumber}`,
        userId: user.id,
        allocations: [{ invoiceId, amountMinor: applied }],
      });
    }
  }
  console.log(`  invoices   ${invoiceCount} posted`);

  /* ── Bills ──────────────────────────────────────────────────────────────*/

  // Bills are posted directly to the ledger here rather than through a bill
  // service — that service is the next thing to build. Shape is the mirror of an
  // invoice: expense + input tax debited, AP credited.
  const apAccountId = await resolveControlAccount(db, org.id, "accounts_payable");
  const expenseCodeByVendor: Record<string, string> = {
    "Amazon Web Services": "5500",
    "Google Cloud India": "5500",
    "WeWork India": "5300",
    "Tanla Platforms": "5500",
    "Freshworks Inc": "5500",
    "Blue Dart Express": "5700",
  };

  for (const bill of mockBills) {
    const totalPaise = toPaise(bill.amount);
    const basePaise = (totalPaise * 10_000n) / 11_800n;
    const taxPaise = totalPaise - basePaise;
    const expenseAccount = acct(expenseCodeByVendor[bill.vendor] ?? "5600");
    const vendorId = vendorIdByName.get(bill.vendor)!;

    await postJournalEntry({
      orgId: org.id,
      entryDate: bill.date,
      source: "bill",
      reference: bill.id,
      memo: `Bill ${bill.id} — ${bill.vendor}`,
      userId: user.id,
      lines: [
        debit(expenseAccount, basePaise, { contactId: vendorId, memo: bill.vendor }),
        debit(acct("1140"), taxPaise, { contactId: vendorId, memo: "Input GST credit" }),
        credit(apAccountId, totalPaise, { contactId: vendorId, memo: `Payable — ${bill.id}` }),
      ],
    });

    // Settle the ones the fixture marks paid.
    if (bill.status === "Paid") {
      await postJournalEntry({
        orgId: org.id,
        entryDate: bill.due,
        source: "bill_payment",
        reference: bill.id,
        memo: `Payment of ${bill.id}`,
        userId: user.id,
        lines: [
          debit(apAccountId, totalPaise, { contactId: vendorId }),
          credit(acct("1110"), totalPaise, { contactId: vendorId, memo: `Paid ${bill.vendor}` }),
        ],
      });
    }
  }
  console.log(`  bills      ${mockBills.length} posted`);

  /* ── Payroll & rent accruals ────────────────────────────────────────────*/

  // A few operating expenses so the P&L isn't just cloud bills.
  const payroll = toPaise(3_420_000);
  await postJournalEntry({
    orgId: org.id,
    entryDate: "2026-07-13",
    source: "manual",
    reference: "SAL-JUL",
    memo: "Salary disbursement — July 2026",
    userId: user.id,
    lines: [
      debit(acct("5200"), payroll, { memo: "Salaries & wages July" }),
      credit(acct("1110"), payroll, { memo: "Salary batch JUL-01" }),
    ],
  });

  const marketing = toPaise(480_000);
  await postJournalEntry({
    orgId: org.id,
    entryDate: "2026-07-09",
    source: "manual",
    reference: "MKT-JUL",
    memo: "Digital marketing spend — July",
    userId: user.id,
    lines: [debit(acct("5400"), marketing), credit(acct("1110"), marketing)],
  });

  console.log("\nSeed complete.\n");
}

main()
  .then(async () => {
    await pgClient.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\nSeed failed:\n", err);
    await pgClient.end();
    process.exit(1);
  });
