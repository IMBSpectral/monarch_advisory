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
import { createBill, postBill, recordVendorPayment } from "@/server/bills";
import { credit, debit, postJournalEntry, resolveControlAccount } from "@/server/ledger";
import { recordOpeningStock } from "@/server/inventory";
import { createCreditNote, postCreditNote } from "@/server/credit-notes";
import { recordContra } from "@/server/contra";
import { createSalesOrder, createPurchaseOrder } from "@/server/orders";
import { createFixedAsset, runDepreciation } from "@/server/assets";
import { createRecurringTemplate } from "@/server/recurring";
import { warehouses, costCenters, budgets, exchangeRates } from "./schema";
import { hashPassword } from "@/server/auth";
import { ensureOrgProvisioned } from "@/server/provisioning";
import { DEMO_LOGINS, DEMO_PASSWORD, SEEDED_ORG_NAME, SEEDED_OTHER_ORG_NAME } from "./fixtures";
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
  /** Pins the account to a foreign currency (multi-currency). */
  currency?: string;
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
    code: "1113",
    name: "SVB USD Account",
    type: "asset",
    subtype: "cash_and_bank",
    parent: "1100",
    currency: "USD",
  },
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
    // isSystem so the posting engine resolves it as the dedicated INPUT-tax
    // (ITC) account — input tax stays an asset here, separate from the
    // output-tax liability (2200 GST Payable).
    code: "1140",
    name: "Input GST Credit",
    type: "asset",
    subtype: "other_current_asset",
    isSystem: true,
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
  // Output-GST components (place of supply → CGST+SGST intra, IGST inter).
  {
    code: "2201",
    name: "Output CGST",
    type: "liability",
    subtype: "tax_payable",
    isSystem: true,
    parent: "2000",
  },
  {
    code: "2202",
    name: "Output SGST",
    type: "liability",
    subtype: "tax_payable",
    isSystem: true,
    parent: "2000",
  },
  {
    code: "2203",
    name: "Output IGST",
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
  {
    code: "2150",
    name: "Goods Received Not Invoiced",
    type: "liability",
    subtype: "goods_received_clearing",
    isSystem: true,
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
  {
    code: "4910",
    name: "Forex Gain/Loss",
    type: "income",
    subtype: "other_income",
    isSystem: true,
    parent: "4000",
  },
  {
    code: "4920",
    name: "Gain/Loss on Asset Disposal",
    type: "income",
    subtype: "other_income",
    parent: "4000",
  },

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
  {
    // The system fallback for any expense line that isn't tied to an inventory
    // item or an explicitly chosen account — e.g. a bill for "office supplies".
    // resolveControlAccount(…, "operating_expense") needs exactly one isSystem
    // account of this subtype; without it, posting an expense bill throws
    // CONTROL_ACCOUNT_MISSING. Every other control subtype already has one.
    code: "5900",
    name: "General & Administrative",
    type: "expense",
    subtype: "operating_expense",
    isSystem: true,
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
      credit_note_lines, credit_notes, debit_note_lines, debit_notes,
      contra_vouchers, sales_order_lines, sales_orders,
      purchase_order_lines, purchase_orders,
      goods_receipt_lines, goods_receipts, delivery_note_lines, delivery_notes,
      cost_centers, projects, budgets, exchange_rates,
      depreciation_entries, fixed_assets,
      recurring_template_lines, recurring_templates,
      invoice_lines, invoices, bill_lines, bills, bank_transactions,
      bank_accounts, stock_movements, item_stock_levels, warehouses, items,
      tax_rates, contacts, accounts, document_sequences,
      sessions, memberships, organizations, users
    restart identity cascade
  `);

  /* ── Organization & user ────────────────────────────────────────────────*/

  const [org] = await db
    .insert(organizations)
    .values({
      name: SEEDED_ORG_NAME,
      legalName: "IMB Labs Limited Liability Partnership",
      countryCode: "IN",
      baseCurrency: "INR",
      taxRegistrationNumber: "27AABCI1234N1Z5",
      fiscalYearStartMonth: 4,
      timezone: "Asia/Kolkata",
    })
    .returning();
  console.log(`  org        ${org.name}`);

  // Demo credentials. Safe only because seeding refuses to run against a
  // production database (see the guard above) — never let this reach one.
  const demoPasswordHash = await hashPassword(DEMO_PASSWORD);

  const [user] = await db
    .insert(users)
    .values({
      email: "founder@imblabs.example",
      name: "Tanush",
      passwordHash: demoPasswordHash,
    })
    .returning();

  await db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });

  // One member per role, so permission gating can actually be exercised in the
  // UI rather than taken on faith.
  const staffRoles = [
    { email: "accountant@imblabs.example", name: "Priya (Accountant)", role: "accountant" },
    { email: "staff@imblabs.example", name: "Rahul (Staff)", role: "staff" },
    { email: "viewer@imblabs.example", name: "Anita (Viewer)", role: "viewer" },
  ] as const;

  for (const s of staffRoles) {
    const [u] = await db
      .insert(users)
      .values({ email: s.email, name: s.name, passwordHash: demoPasswordHash })
      .returning();
    await db.insert(memberships).values({ orgId: org.id, userId: u.id, role: s.role });
  }

  /*
   * A second tenant, with its own owner and no data.
   *
   * It exists to make cross-tenant leakage *visible*: sign in as this user and
   * every screen must be empty. If any of IMB Labs' figures show up here, the
   * tenancy filter that leaked them is broken, and a test that only ever looks
   * at one org would never have caught it.
   */
  const [otherOrg] = await db
    .insert(organizations)
    .values({ name: SEEDED_OTHER_ORG_NAME, countryCode: "IN", baseCurrency: "INR" })
    .returning();

  const [otherUser] = await db
    .insert(users)
    .values({
      email: "owner@sentinel.example",
      name: "Sentinel Owner",
      passwordHash: demoPasswordHash,
    })
    .returning();

  await db.insert(memberships).values({ orgId: otherOrg.id, userId: otherUser.id, role: "owner" });

  // The founder also sits on Sentinel's board (admin), so the consolidation
  // report has more than one entity to roll up. Sentinel carries the default
  // books (chart, sequences, tax rates, a bank account) but NO transactions —
  // so it's a functional-but-empty tenant you can actually post into, not a
  // dead org that errors on the first save.
  await db.insert(memberships).values({ orgId: otherOrg.id, userId: user.id, role: "admin" });
  await ensureOrgProvisioned(db, otherOrg.id);

  /* ── Document sequences ─────────────────────────────────────────────────*/

  await db.insert(documentSequences).values([
    { orgId: org.id, documentType: "invoice", prefix: "INV-2026-", nextNumber: 1n, padWidth: 4 },
    { orgId: org.id, documentType: "bill", prefix: "BILL-", nextNumber: 4516n, padWidth: 4 },
    { orgId: org.id, documentType: "payment", prefix: "PAY-", nextNumber: 1n, padWidth: 4 },
    { orgId: org.id, documentType: "journal", prefix: "JE-", nextNumber: 1n, padWidth: 6 },
    { orgId: org.id, documentType: "credit_note", prefix: "CN-", nextNumber: 1n, padWidth: 4 },
    { orgId: org.id, documentType: "debit_note", prefix: "DN-", nextNumber: 1n, padWidth: 4 },
    { orgId: org.id, documentType: "contra", prefix: "CTR-", nextNumber: 1n, padWidth: 4 },
    { orgId: org.id, documentType: "sales_order", prefix: "SO-", nextNumber: 1n, padWidth: 4 },
    { orgId: org.id, documentType: "purchase_order", prefix: "PO-", nextNumber: 1n, padWidth: 4 },
    { orgId: org.id, documentType: "grn", prefix: "GRN-", nextNumber: 1n, padWidth: 4 },
    { orgId: org.id, documentType: "delivery_note", prefix: "DC-", nextNumber: 1n, padWidth: 4 },
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
        currency: seed.currency ?? null,
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

  /* ── Cost centres ───────────────────────────────────────────────────────*/

  const ccByCode = new Map<string, string>();
  for (const c of [
    { code: "ENG", name: "Engineering" },
    { code: "SLS", name: "Sales & Marketing" },
    { code: "GNA", name: "General & Admin" },
  ]) {
    const [row] = await db
      .insert(costCenters)
      .values({ orgId: org.id, code: c.code, name: c.name })
      .returning({ id: costCenters.id });
    ccByCode.set(c.code, row.id);
  }
  console.log(`  cost ctrs  3`);

  // Annual FY2026 budgets for the main expense lines, so budget-vs-actual has
  // something to compare the posted ledger against.
  await db.insert(budgets).values([
    { orgId: org.id, accountId: acct("5200"), fiscalYear: 2026, amountMinor: toPaise(4_000_000) },
    { orgId: org.id, accountId: acct("5300"), fiscalYear: 2026, amountMinor: toPaise(400_000) },
    { orgId: org.id, accountId: acct("5400"), fiscalYear: 2026, amountMinor: toPaise(500_000) },
    { orgId: org.id, accountId: acct("5500"), fiscalYear: 2026, amountMinor: toPaise(500_000) },
    { orgId: org.id, accountId: acct("4100"), fiscalYear: 2026, amountMinor: toPaise(6_000_000) },
  ]);
  console.log(`  budgets    5`);

  // Exchange rates to INR. Two dated USD points so revaluation has movement.
  await db.insert(exchangeRates).values([
    { orgId: org.id, currencyCode: "USD", rateToBase: "83.0000000000", asOfDate: "2026-04-01" },
    { orgId: org.id, currencyCode: "USD", rateToBase: "86.5000000000", asOfDate: "2026-07-15" },
    { orgId: org.id, currencyCode: "EUR", rateToBase: "90.0000000000", asOfDate: "2026-04-01" },
    { orgId: org.id, currencyCode: "GBP", rateToBase: "105.0000000000", asOfDate: "2026-04-01" },
  ]);
  console.log(`  fx rates   4`);

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

  // A couple of SKUs use FIFO to exercise layer costing; the rest weighted-average.
  const FIFO_SKUS = new Set(["MON-LP-15", "MON-MN-27"]);
  const itemIdBySku = new Map<string, string>();
  for (const it of mockItems) {
    const [row] = await db
      .insert(items)
      .values({
        orgId: org.id,
        sku: it.sku,
        name: it.name,
        isInventoryTracked: true,
        unitOfMeasure: it.uom,
        salePriceMinor: toPaise(it.price),
        purchasePriceMinor: toPaise(it.cost),
        valuationMethod: FIFO_SKUS.has(it.sku) ? "fifo" : "weighted_average",
        salesAccountId: acct("4100"),
        purchaseAccountId: acct("5100"),
        inventoryAccountId: acct("1130"),
        defaultTaxRateId: gst18.id,
      })
      .returning({ id: items.id });
    itemIdBySku.set(it.sku, row.id);
  }
  console.log(`  items      ${mockItems.length} (2 FIFO)`);

  /* ── Warehouses & opening stock ─────────────────────────────────────────*/

  // The seed truncates orgs (cascading away the migration's default warehouse),
  // so recreate one per org here.
  await db
    .insert(warehouses)
    .values({ orgId: org.id, code: "MAIN", name: "Main Warehouse", isDefault: true });
  await db
    .insert(warehouses)
    .values({ orgId: otherOrg.id, code: "MAIN", name: "Main Warehouse", isDefault: true });

  // Opening stock: 60 units of each item at its purchase cost, contributed as
  // capital. This gives the balance sheet a real Inventory asset and gives POS /
  // item-based sales something to relieve. Dr Inventory / Cr Partner Capital.
  const opening = await recordOpeningStock({
    orgId: org.id,
    offsetAccountId: acct("3100"),
    moveDate: "2026-04-01",
    userId: user.id,
    lines: mockItems.map((it) => ({
      itemId: itemIdBySku.get(it.sku)!,
      quantity: "60",
      unitCostMinor: toPaise(it.cost),
    })),
  });
  console.log(
    `  stock      ${mockItems.length} items opened, value ${opening.totalValueMinor / 100n} INR`,
  );

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

  // A USD capital injection: $10,000 booked at ₹83 = ₹8,30,000. The USD account
  // carries the $10,000 (originalAmount) alongside its ₹8,30,000 base value, so
  // later forex revaluation has a foreign position to true up.
  const usdForeign = toPaise(10_000); // $10,000.00 in USD minor units
  const usdBase = toPaise(830_000); // ₹8,30,000.00 at the ₹83 booking rate
  await postJournalEntry({
    orgId: org.id,
    entryDate: "2026-04-01",
    source: "opening_balance",
    memo: "USD capital — $10,000 @ ₹83",
    userId: user.id,
    lines: [
      debit(acct("1113"), usdBase, {
        currency: "USD",
        exchangeRate: "83",
        originalAmountMinor: usdForeign,
        memo: "USD bank funded",
      }),
      credit(acct("3100"), usdBase, { memo: "Partner capital (USD)" }),
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

  /* ── An item-based sale, to exercise COGS & stock depletion ──────────────*/

  // Unlike the fixture invoices above (single generic service line), this one
  // sells real tracked items, so posting it relieves stock at weighted-average
  // cost and books Cost of Goods Sold — the demo's gross margin comes from here.
  const anyCustomerId = customerIdByName.values().next().value as string;
  const posSale = await createInvoice({
    orgId: org.id,
    contactId: anyCustomerId,
    invoiceDate: "2026-07-18",
    dueDate: "2026-08-17",
    currency: "INR",
    userId: user.id,
    lines: [
      {
        itemId: itemIdBySku.get("MON-MN-27")!,
        description: '27" 4K UHD Monitor',
        quantity: "8",
        unitPriceMinor: toPaise(mockItems.find((i) => i.sku === "MON-MN-27")!.price),
        taxRateId: gst18.id,
        revenueAccountId: acct("4100"),
      },
      {
        itemId: itemIdBySku.get("MON-KB-01")!,
        description: "Monarch Mechanical Keyboard",
        quantity: "15",
        unitPriceMinor: toPaise(mockItems.find((i) => i.sku === "MON-KB-01")!.price),
        taxRateId: gst18.id,
        revenueAccountId: acct("4100"),
      },
    ],
  });
  await postInvoice({ orgId: org.id, invoiceId: posSale.invoiceId, userId: user.id });
  console.log(`  item sale  ${posSale.invoiceNumber} posted (COGS booked)`);

  // A foreign-currency (USD) invoice: $5,000 of export services @ ₹86.50. Stored
  // in base (₹4,32,500) so the ledger and aging stay consistent; the $5,000 is
  // kept for the printed document.
  const usdInvoice = await createInvoice({
    orgId: org.id,
    contactId: customerIdByName.get("Flipkart Internet")!,
    invoiceDate: "2026-07-17",
    dueDate: "2026-08-16",
    currency: "USD",
    exchangeRate: "86.5",
    userId: user.id,
    lines: [
      {
        description: "Export consulting (USD)",
        quantity: "1",
        unitPriceMinor: toPaise(5_000),
        revenueAccountId: acct("4200"),
      },
    ],
  });
  await postInvoice({ orgId: org.id, invoiceId: usdInvoice.invoiceId, userId: user.id });
  console.log(`  fx invoice ${usdInvoice.invoiceNumber} posted ($5,000 @ ₹86.5)`);

  // A sales return against that sale: 2 monitors come back, restocked.
  const cn = await createCreditNote({
    orgId: org.id,
    contactId: anyCustomerId,
    relatedInvoiceId: posSale.invoiceId,
    creditNoteDate: "2026-07-20",
    userId: user.id,
    reason: "2 monitors returned — DOA",
    lines: [
      {
        itemId: itemIdBySku.get("MON-MN-27")!,
        description: '27" 4K UHD Monitor — return',
        quantity: "2",
        unitPriceMinor: toPaise(mockItems.find((i) => i.sku === "MON-MN-27")!.price),
        taxRateId: gst18.id,
      },
    ],
  });
  await postCreditNote({ orgId: org.id, creditNoteId: cn.creditNoteId, userId: user.id });
  console.log(`  credit note ${cn.creditNoteNumber} posted (2 monitors restocked)`);

  /* ── Contra transfer & open orders (demo data) ──────────────────────────*/

  await recordContra({
    orgId: org.id,
    fromAccountId: acct("1110"),
    toAccountId: acct("1111"),
    amountMinor: toPaise(500_000),
    voucherDate: "2026-07-16",
    memo: "Sweep surplus to ICICI",
    userId: user.id,
  });

  // Open orders that haven't been invoiced/billed yet — the fulfilment pipeline.
  await createSalesOrder({
    orgId: org.id,
    contactId: anyCustomerId,
    orderDate: "2026-07-19",
    expectedDate: "2026-07-26",
    userId: user.id,
    lines: [
      {
        itemId: itemIdBySku.get("MON-LP-15")!,
        description: "UltraBook Pro 15",
        quantity: "5",
        unitPriceMinor: toPaise(mockItems.find((i) => i.sku === "MON-LP-15")!.price),
        taxRateId: gst18.id,
        accountId: acct("4100"),
      },
    ],
  });
  await createPurchaseOrder({
    orgId: org.id,
    contactId: vendorIdByName.values().next().value as string,
    orderDate: "2026-07-19",
    expectedDate: "2026-07-27",
    userId: user.id,
    lines: [
      {
        itemId: itemIdBySku.get("MON-KB-01")!,
        description: "Monarch Mechanical Keyboard",
        quantity: "50",
        unitPriceMinor: toPaise(mockItems.find((i) => i.sku === "MON-KB-01")!.cost),
        taxRateId: gst18.id,
      },
    ],
  });
  console.log(`  vouchers   1 contra, 1 sales order, 1 purchase order`);

  /* ── Bills ──────────────────────────────────────────────────────────────*/

  // Bills now go through the real bill service, so they exist as documents (rows
  // in `bills`) the UI can list — not just as anonymous journal entries. The
  // fixture amount is GST-inclusive, so we back out the 18% base for the line and
  // let the service recompute the tax, exactly as the app does.
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
    const basePaise = (totalPaise * 10_000n) / 11_800n; // strip inclusive 18% GST
    const expenseAccount = acct(expenseCodeByVendor[bill.vendor] ?? "5600");
    const vendorId = vendorIdByName.get(bill.vendor)!;

    const created = await createBill({
      orgId: org.id,
      contactId: vendorId,
      billDate: bill.date,
      dueDate: bill.due,
      vendorInvoiceNumber: bill.id,
      userId: user.id,
      lines: [
        {
          description: `Services — ${bill.vendor}`,
          unitPriceMinor: basePaise,
          taxRateId: gst18.id,
          expenseAccountId: expenseAccount,
        },
      ],
    });

    await postBill({ orgId: org.id, billId: created.billId, userId: user.id });

    // Settle the ones the fixture marks paid, in full, through the payment path.
    if (bill.status === "Paid") {
      await recordVendorPayment({
        orgId: org.id,
        contactId: vendorId,
        paymentDate: bill.due,
        amountMinor: created.totalMinor,
        depositAccountId: acct("1110"),
        method: "Bank transfer",
        userId: user.id,
        allocations: [{ billId: created.billId, amountMinor: created.totalMinor }],
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
      debit(acct("5200"), payroll, {
        memo: "Salaries & wages July",
        costCenterId: ccByCode.get("ENG"),
      }),
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
    lines: [
      debit(acct("5400"), marketing, { costCenterId: ccByCode.get("SLS") }),
      credit(acct("1110"), marketing),
    ],
  });

  /* ── Fixed assets & depreciation ────────────────────────────────────────*/

  // Two assets bought from the HDFC account, then depreciated through July.
  await createFixedAsset({
    orgId: org.id,
    code: "FA-LAPTOPS",
    name: "MacBook Pro fleet (12)",
    assetAccountId: acct("1210"),
    accumulatedAccountId: acct("1290"),
    depreciationAccountId: acct("5800"),
    acquisitionDate: "2026-04-05",
    costMinor: toPaise(1_200_000),
    salvageValueMinor: toPaise(120_000),
    usefulLifeMonths: 36,
    fundingAccountId: acct("1110"),
    userId: user.id,
  });
  await createFixedAsset({
    orgId: org.id,
    code: "FA-FURNITURE",
    name: "Office furniture & fixtures",
    assetAccountId: acct("1220"),
    accumulatedAccountId: acct("1290"),
    depreciationAccountId: acct("5800"),
    acquisitionDate: "2026-04-10",
    costMinor: toPaise(600_000),
    salvageValueMinor: 0n,
    usefulLifeMonths: 60,
    fundingAccountId: acct("1110"),
    userId: user.id,
  });
  const dep = await runDepreciation({ orgId: org.id, throughDate: "2026-07-01", userId: user.id });
  console.log(
    `  assets     2 registered, depreciation ₹${dep.chargedMinor / 100n} (${dep.monthsPosted} charges)`,
  );

  /* ── A recurring invoice template (not yet generated) ───────────────────*/

  await createRecurringTemplate({
    orgId: org.id,
    contactId: customerIdByName.get("BigBasket")!,
    name: "BigBasket monthly retainer",
    frequency: "monthly",
    startDate: "2026-06-01",
    dueDays: 30,
    autoPost: true,
    userId: user.id,
    lines: [
      {
        description: "Managed services retainer",
        quantity: "1",
        unitPriceMinor: toPaise(150_000),
        taxRateId: gst18.id,
        revenueAccountId: acct("4200"),
      },
    ],
  });
  console.log(`  recurring  1 template`);

  console.log("\nSeed complete.\n");
  console.log(`Sign in with any of these — password: ${DEMO_PASSWORD}\n`);
  for (const login of DEMO_LOGINS) {
    console.log(`  ${login.email.padEnd(30)} ${login.role.padEnd(11)} ${login.org}`);
  }
  console.log(
    "\n  Sentinel Foods has default books but no transactions on purpose: sign in\n" +
      "  there and the transactional screens (invoices, bills, …) are empty, but you\n" +
      "  can post into it. Anything from IMB Labs showing up is a tenancy leak.\n",
  );
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
