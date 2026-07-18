/**
 * Monarch — core financial schema.
 *
 * Three rules govern everything in this file:
 *
 * 1. MONEY IS INTEGER MINOR UNITS (paise/cents), stored as bigint. Never float,
 *    never numeric-with-implicit-rounding. `amountMinor: 28500000n` is ₹2,85,000.00.
 *    Every monetary column carries a sibling currency + the FX rate used to convert
 *    it to the org's base currency at transaction time.
 *
 * 2. THE JOURNAL IS THE ONLY SOURCE OF TRUTH. Invoices, bills, and payments are
 *    *documents*; they describe intent. Balances, statements, and every report are
 *    derived by aggregating `journalLines` — never by reading a cached balance off
 *    a document. There is deliberately no `balance` column on `accounts`.
 *
 * 3. POSTED JOURNAL ENTRIES ARE IMMUTABLE. They are never updated or deleted.
 *    A mistake is corrected by posting a reversing entry that points back via
 *    `reversesEntryId`. This is what makes the ledger auditable.
 *
 * Multi-tenancy: every table carries `orgId`. There is no global data.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  bigint,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
  check,
  numeric,
} from "drizzle-orm/pg-core";
import { sql, relations } from "drizzle-orm";

/* ────────────────────────────────────────────────────────────────────────────
 * Enums
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * The five roots of any chart of accounts. `normalBalance` (which side increases
 * the account) is derived from this, not stored per-account:
 *   asset, expense      → debit-normal
 *   liability, equity, income → credit-normal
 */
export const accountTypeEnum = pgEnum("account_type", [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
]);

/**
 * Subtype drives statement placement and ordering. A balance sheet needs to know
 * that "Accounts Receivable" is current and "Buildings" is fixed; the root type
 * alone can't tell you that.
 */
export const accountSubtypeEnum = pgEnum("account_subtype", [
  // assets
  "cash_and_bank",
  "accounts_receivable",
  "inventory",
  "other_current_asset",
  "fixed_asset",
  "accumulated_depreciation",
  "other_asset",
  // liabilities
  "accounts_payable",
  "credit_card",
  "tax_payable",
  "other_current_liability",
  "long_term_liability",
  // equity
  "equity",
  "retained_earnings",
  // income
  "operating_revenue",
  "other_income",
  // expenses
  "cost_of_goods_sold",
  "operating_expense",
  "depreciation_expense",
  "other_expense",
]);

export const journalEntryStatusEnum = pgEnum("journal_entry_status", [
  "draft",
  "posted",
  "reversed",
]);

/**
 * Where a journal entry came from. Lets reports trace a ledger line back to the
 * document that produced it, and lets us block manual edits to system-generated
 * entries.
 */
export const journalSourceEnum = pgEnum("journal_source", [
  "manual",
  "invoice",
  "invoice_payment",
  "bill",
  "bill_payment",
  "credit_note",
  "vendor_credit",
  "expense",
  "bank_transaction",
  "inventory_adjustment",
  "depreciation",
  "fx_revaluation",
  "opening_balance",
  "period_close",
]);

export const contactTypeEnum = pgEnum("contact_type", ["customer", "vendor", "both"]);

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "sent",
  "partially_paid",
  "paid",
  "overdue",
  "void",
  "written_off",
]);

export const billStatusEnum = pgEnum("bill_status", [
  "draft",
  "awaiting_approval",
  "open",
  "partially_paid",
  "paid",
  "overdue",
  "void",
]);

export const paymentDirectionEnum = pgEnum("payment_direction", [
  "inbound", // customer pays us  — receipt
  "outbound", // we pay a vendor   — disbursement
]);

export const bankTxnStatusEnum = pgEnum("bank_txn_status", [
  "unreconciled",
  "categorized",
  "matched",
  "reconciled",
  "excluded",
]);

/* ────────────────────────────────────────────────────────────────────────────
 * Shared column builders
 * ──────────────────────────────────────────────────────────────────────────*/

/** Money. Always minor units. bigint because ₹92,23,37,20,368 should not overflow. */
const money = (name: string) => bigint(name, { mode: "bigint" });

/**
 * FX rate to the org's base currency, at transaction date.
 * numeric(20,10) because rates need precision that floats can't give
 * (JPY→INR is ~0.5479200000 and errors compound across thousands of lines).
 */
const fxRate = (name: string) => numeric(name, { precision: 20, scale: 10 });

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Soft delete. Financial records are never hard-deleted. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};

/* ────────────────────────────────────────────────────────────────────────────
 * Tenancy & identity
 * ──────────────────────────────────────────────────────────────────────────*/

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    /** ISO 3166-1 alpha-2. Drives which tax plugin applies. */
    countryCode: text("country_code").notNull().default("IN"),
    /** ISO 4217. Every report is presented in this currency. */
    baseCurrency: text("base_currency").notNull().default("INR"),
    /** Tax registration — GSTIN in India, VAT number in EU, EIN in US. */
    taxRegistrationNumber: text("tax_registration_number"),
    /** Month (1-12) the fiscal year starts. India = 4 (April). */
    fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(4),
    /**
     * Ledger is frozen on/before this date. Nothing may post into a closed
     * period — enforced in the posting engine, see `assertPeriodOpen`.
     */
    booksClosedThrough: date("books_closed_through"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    ...timestamps,
  },
  (t) => [check("fiscal_month_valid", sql`${t.fiscalYearStartMonth} between 1 and 12`)],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  ...timestamps,
});

/**
 * A user's role *within one org*. The same human can be an owner of their own
 * company and a read-only accountant on a client's — which is exactly the
 * multi-company requirement.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    /** Fine-grained overrides layered on top of the role, e.g. ["invoice:void"]. */
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [uniqueIndex("membership_org_user_idx").on(t.orgId, t.userId)],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Chart of accounts
 * ──────────────────────────────────────────────────────────────────────────*/

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Human-facing account number, e.g. "1120". Unique per org. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: accountTypeEnum("type").notNull(),
    subtype: accountSubtypeEnum("subtype").notNull(),
    /** Self-reference builds the tree. Null = top-level. */
    parentId: uuid("parent_id"),
    description: text("description"),
    /**
     * Non-postable rollup node (e.g. "Current Assets"). Postings are rejected
     * against these — you post to leaves, headers only aggregate.
     */
    isGroup: boolean("is_group").notNull().default(false),
    /**
     * Locked accounts are created and maintained by the system (AR control,
     * AP control, retained earnings) and cannot be deleted by users, because
     * the posting engine resolves them by subtype.
     */
    isSystem: boolean("is_system").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    /** Non-base-currency accounts (e.g. a USD bank account) pin their currency. */
    currency: text("currency"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("account_org_code_idx").on(t.orgId, t.code),
    index("account_org_type_idx").on(t.orgId, t.type),
    index("account_parent_idx").on(t.parentId),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * The general ledger — the heart of the system
 * ──────────────────────────────────────────────────────────────────────────*/

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Sequential per org, gap-free, assigned at post time. Auditors require this. */
    entryNumber: text("entry_number").notNull(),
    /** The accounting date — determines which period this lands in. NOT createdAt. */
    entryDate: date("entry_date").notNull(),
    status: journalEntryStatusEnum("status").notNull().default("draft"),
    source: journalSourceEnum("source").notNull().default("manual"),
    /**
     * The document that generated this entry (invoice id, payment id, …).
     * Untyped uuid rather than an FK because it points at one of many tables;
     * `source` tells you which.
     */
    sourceDocumentId: uuid("source_document_id"),
    /** Human reference — invoice number, cheque number, UTR. */
    reference: text("reference"),
    memo: text("memo"),
    /** Set on the *reversing* entry, pointing at the entry it cancels. */
    reversesEntryId: uuid("reverses_entry_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedByUserId: uuid("posted_by_user_id").references(() => users.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("journal_org_number_idx").on(t.orgId, t.entryNumber),
    // The workhorse index: every report scans by org + date + status.
    index("journal_org_date_idx").on(t.orgId, t.entryDate, t.status),
    index("journal_source_doc_idx").on(t.source, t.sourceDocumentId),
    // A posted entry must record when and by whom. Draft entries must not.
    check("posted_has_timestamp", sql`(${t.status} <> 'posted') or (${t.postedAt} is not null)`),
  ],
);

/**
 * One side of a double-entry transaction.
 *
 * SIGN CONVENTION: `amountMinor` is signed. Positive = DEBIT, negative = CREDIT.
 * A single signed column (rather than separate debit/credit columns) means
 * "the entry balances" is expressible as `sum(amount_minor) = 0`, which is a
 * cheap, total check — and it makes every report a plain SUM with no CASE.
 */
export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    lineNumber: integer("line_number").notNull(),
    /** Signed, in the ORG'S BASE CURRENCY. This is what reports sum. */
    amountMinor: money("amount_minor").notNull(),
    /** Signed, in the transaction's own currency. Equal to amountMinor when not FX. */
    originalAmountMinor: money("original_amount_minor").notNull(),
    currency: text("currency").notNull(),
    exchangeRate: fxRate("exchange_rate").notNull().default("1"),
    memo: text("memo"),
    /**
     * Subledger link. An AR line carries the customer; an AP line the vendor.
     * This is what makes aging reports and statements possible without
     * scanning documents.
     */
    contactId: uuid("contact_id"),
    /** Dimensional tags for cost-centre / department / project reporting. */
    projectId: uuid("project_id"),
    costCenterId: uuid("cost_center_id"),
    ...timestamps,
  },
  (t) => [
    index("jline_entry_idx").on(t.entryId),
    // Drives trial balance, P&L, balance sheet, and account registers.
    index("jline_org_account_idx").on(t.orgId, t.accountId),
    index("jline_contact_idx").on(t.orgId, t.contactId),
    uniqueIndex("jline_entry_line_idx").on(t.entryId, t.lineNumber),
    // A zero-amount ledger line is always a bug — reject it at the DB.
    check("jline_nonzero", sql`${t.amountMinor} <> 0`),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Contacts (customers & vendors share one table)
 * ──────────────────────────────────────────────────────────────────────────*/

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: contactTypeEnum("type").notNull().default("customer"),
    displayName: text("display_name").notNull(),
    legalName: text("legal_name"),
    email: text("email"),
    phone: text("phone"),
    /** GSTIN / VAT / ABN depending on country. */
    taxRegistrationNumber: text("tax_registration_number"),
    /** Two-letter Indian state code for GST place-of-supply (CGST+SGST vs IGST). */
    placeOfSupplyCode: text("place_of_supply_code"),
    currency: text("currency"),
    /** Net payment terms in days; drives due dates and aging buckets. */
    paymentTermDays: integer("payment_term_days").notNull().default(30),
    creditLimitMinor: money("credit_limit_minor"),
    billingAddress: jsonb("billing_address").$type<Address>(),
    shippingAddress: jsonb("shipping_address").$type<Address>(),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("contact_org_type_idx").on(t.orgId, t.type),
    index("contact_org_name_idx").on(t.orgId, t.displayName),
  ],
);

export type Address = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  stateCode?: string;
  postalCode?: string;
  country?: string;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Tax
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * A single tax rate. Composite taxes (GST = CGST 9% + SGST 9%) are modelled as a
 * parent with `isGroup` and children pointing at it, so an invoice line references
 * one tax and the engine expands it into the component postings.
 */
export const taxRates = pgTable(
  "tax_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Basis points — 1800 = 18.00%. Integer avoids float drift on tax math. */
    rateBps: integer("rate_bps").notNull(),
    isGroup: boolean("is_group").notNull().default(false),
    parentId: uuid("parent_id"),
    /** Where collected output tax accrues (a liability). */
    outputAccountId: uuid("output_account_id").references(() => accounts.id),
    /** Where paid input tax accrues (an asset — reclaimable). */
    inputAccountId: uuid("input_account_id").references(() => accounts.id),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("tax_org_idx").on(t.orgId),
    check("tax_rate_sane", sql`${t.rateBps} between 0 and 10000`),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Items
 * ──────────────────────────────────────────────────────────────────────────*/

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sku: text("sku"),
    name: text("name").notNull(),
    description: text("description"),
    /** Services don't hold stock and skip COGS/inventory postings. */
    isInventoryTracked: boolean("is_inventory_tracked").notNull().default(false),
    unitOfMeasure: text("unit_of_measure").notNull().default("PCS"),
    salePriceMinor: money("sale_price_minor"),
    purchasePriceMinor: money("purchase_price_minor"),
    /** HSN (goods) / SAC (services) code — required on Indian GST invoices. */
    hsnSacCode: text("hsn_sac_code"),
    salesAccountId: uuid("sales_account_id").references(() => accounts.id),
    purchaseAccountId: uuid("purchase_account_id").references(() => accounts.id),
    inventoryAccountId: uuid("inventory_account_id").references(() => accounts.id),
    defaultTaxRateId: uuid("default_tax_rate_id").references(() => taxRates.id),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("item_org_sku_idx").on(t.orgId, t.sku),
    index("item_org_name_idx").on(t.orgId, t.name),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Sales — invoices
 * ──────────────────────────────────────────────────────────────────────────*/

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    invoiceNumber: text("invoice_number").notNull(),
    invoiceDate: date("invoice_date").notNull(),
    dueDate: date("due_date").notNull(),
    status: invoiceStatusEnum("status").notNull().default("draft"),
    currency: text("currency").notNull(),
    exchangeRate: fxRate("exchange_rate").notNull().default("1"),
    subtotalMinor: money("subtotal_minor")
      .notNull()
      .default(sql`0`),
    taxTotalMinor: money("tax_total_minor")
      .notNull()
      .default(sql`0`),
    discountMinor: money("discount_minor")
      .notNull()
      .default(sql`0`),
    totalMinor: money("total_minor")
      .notNull()
      .default(sql`0`),
    /**
     * Cached sum of allocated payments. A denormalization, and the one place we
     * allow it — but it is only ever written by the payment allocation path
     * inside the same transaction that writes `paymentAllocations`, and
     * `verifyInvoiceBalances()` in ledger.ts reconciles it against the truth.
     */
    amountPaidMinor: money("amount_paid_minor")
      .notNull()
      .default(sql`0`),
    notes: text("notes"),
    terms: text("terms"),
    /** Set once posted, so we can find the GL impact of this document. */
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("invoice_org_number_idx").on(t.orgId, t.invoiceNumber),
    index("invoice_org_status_idx").on(t.orgId, t.status),
    index("invoice_org_contact_idx").on(t.orgId, t.contactId),
    index("invoice_org_due_idx").on(t.orgId, t.dueDate),
    check("invoice_paid_not_negative", sql`${t.amountPaidMinor} >= 0`),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    itemId: uuid("item_id").references(() => items.id),
    description: text("description").notNull(),
    /** numeric, not integer — you can invoice 2.5 hours or 1.75 kg. */
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default("1"),
    unitPriceMinor: money("unit_price_minor").notNull(),
    discountBps: integer("discount_bps").notNull().default(0),
    taxRateId: uuid("tax_rate_id").references(() => taxRates.id),
    taxAmountMinor: money("tax_amount_minor")
      .notNull()
      .default(sql`0`),
    /** quantity × unitPrice − discount. Excludes tax. */
    lineTotalMinor: money("line_total_minor").notNull(),
    /** Revenue account this line credits; falls back to the item's. */
    revenueAccountId: uuid("revenue_account_id").references(() => accounts.id),
    ...timestamps,
  },
  (t) => [
    index("iline_invoice_idx").on(t.invoiceId),
    uniqueIndex("iline_invoice_line_idx").on(t.invoiceId, t.lineNumber),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Purchases — bills
 * ──────────────────────────────────────────────────────────────────────────*/

export const bills = pgTable(
  "bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    billNumber: text("bill_number").notNull(),
    /** The vendor's own invoice number — needed for GST input credit matching. */
    vendorInvoiceNumber: text("vendor_invoice_number"),
    billDate: date("bill_date").notNull(),
    dueDate: date("due_date").notNull(),
    status: billStatusEnum("status").notNull().default("draft"),
    currency: text("currency").notNull(),
    exchangeRate: fxRate("exchange_rate").notNull().default("1"),
    subtotalMinor: money("subtotal_minor")
      .notNull()
      .default(sql`0`),
    taxTotalMinor: money("tax_total_minor")
      .notNull()
      .default(sql`0`),
    totalMinor: money("total_minor")
      .notNull()
      .default(sql`0`),
    amountPaidMinor: money("amount_paid_minor")
      .notNull()
      .default(sql`0`),
    notes: text("notes"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("bill_org_number_idx").on(t.orgId, t.billNumber),
    index("bill_org_status_idx").on(t.orgId, t.status),
    index("bill_org_contact_idx").on(t.orgId, t.contactId),
    index("bill_org_due_idx").on(t.orgId, t.dueDate),
  ],
);

export const billLines = pgTable(
  "bill_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    billId: uuid("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    itemId: uuid("item_id").references(() => items.id),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default("1"),
    unitPriceMinor: money("unit_price_minor").notNull(),
    taxRateId: uuid("tax_rate_id").references(() => taxRates.id),
    taxAmountMinor: money("tax_amount_minor")
      .notNull()
      .default(sql`0`),
    lineTotalMinor: money("line_total_minor").notNull(),
    /** Expense or asset account this line debits. */
    expenseAccountId: uuid("expense_account_id").references(() => accounts.id),
    ...timestamps,
  },
  (t) => [
    index("bline_bill_idx").on(t.billId),
    uniqueIndex("bline_bill_line_idx").on(t.billId, t.lineNumber),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Payments
 * ──────────────────────────────────────────────────────────────────────────*/

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    direction: paymentDirectionEnum("direction").notNull(),
    paymentNumber: text("payment_number").notNull(),
    paymentDate: date("payment_date").notNull(),
    /** Total tendered. May exceed allocations — the remainder sits as a credit. */
    amountMinor: money("amount_minor").notNull(),
    currency: text("currency").notNull(),
    exchangeRate: fxRate("exchange_rate").notNull().default("1"),
    /** Bank/cash account the money moved through. */
    depositAccountId: uuid("deposit_account_id")
      .notNull()
      .references(() => accounts.id),
    method: text("method"),
    referenceNumber: text("reference_number"),
    notes: text("notes"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("payment_org_number_idx").on(t.orgId, t.paymentNumber),
    index("payment_org_contact_idx").on(t.orgId, t.contactId),
    index("payment_org_date_idx").on(t.orgId, t.paymentDate),
    check("payment_positive", sql`${t.amountMinor} > 0`),
  ],
);

/**
 * Which document each slice of a payment settles. A ₹5L cheque covering three
 * invoices produces one payment and three allocations — this is what makes
 * partial and split settlement correct rather than approximate.
 */
export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    /** Exactly one of these is set — enforced by the check below. */
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    billId: uuid("bill_id").references(() => bills.id),
    amountMinor: money("amount_minor").notNull(),
    ...timestamps,
  },
  (t) => [
    index("alloc_payment_idx").on(t.paymentId),
    index("alloc_invoice_idx").on(t.invoiceId),
    index("alloc_bill_idx").on(t.billId),
    check("alloc_positive", sql`${t.amountMinor} > 0`),
    check(
      "alloc_exactly_one_target",
      sql`(${t.invoiceId} is not null)::int + (${t.billId} is not null)::int = 1`,
    ),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Banking
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * A real-world bank account, paired 1:1 with a GL cash account. Reconciliation is
 * the process of proving `bankAccounts` balance == GL account balance.
 */
export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    institutionName: text("institution_name"),
    accountNumberMasked: text("account_number_masked"),
    ifscCode: text("ifsc_code"),
    currency: text("currency").notNull(),
    /** Balance the *bank* reports, from the feed. May differ from GL — that gap is the point. */
    feedBalanceMinor: money("feed_balance_minor"),
    feedLastSyncedAt: timestamp("feed_last_synced_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("bank_org_idx").on(t.orgId)],
);

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    transactionDate: date("transaction_date").notNull(),
    description: text("description").notNull(),
    /** Signed: positive = money in, negative = money out. */
    amountMinor: money("amount_minor").notNull(),
    currency: text("currency").notNull(),
    status: bankTxnStatusEnum("status").notNull().default("unreconciled"),
    /**
     * Stable hash of (account, date, amount, description) from the feed.
     * Unique, so re-importing the same statement can't double-count.
     */
    externalId: text("external_id"),
    /** Set once this feed line is tied to a GL entry. */
    matchedEntryId: uuid("matched_entry_id").references(() => journalEntries.id),
    matchedPaymentId: uuid("matched_payment_id").references(() => payments.id),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    rawPayload: jsonb("raw_payload"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("banktxn_external_idx").on(t.bankAccountId, t.externalId),
    index("banktxn_org_status_idx").on(t.orgId, t.status),
    index("banktxn_account_date_idx").on(t.bankAccountId, t.transactionDate),
    check("banktxn_nonzero", sql`${t.amountMinor} <> 0`),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Audit
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Append-only. No update or delete path exists in application code, and the
 * migration revokes UPDATE/DELETE on this table from the app role.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id),
    /** e.g. "invoice.posted", "payment.voided", "period.closed". */
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    /** Field-level before/after. Null `before` = creation. */
    before: jsonb("before"),
    after: jsonb("after"),
    /** Why — required for reversals and period reopens. */
    reason: text("reason"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_org_time_idx").on(t.orgId, t.occurredAt),
    index("audit_entity_idx").on(t.entityType, t.entityId),
  ],
);

/**
 * Per-org, per-document-type counters. Lives in its own table so a number can be
 * claimed with `SELECT … FOR UPDATE` inside the posting transaction, which is
 * what guarantees invoice/journal numbers are gap-free under concurrency.
 */
export const documentSequences = pgTable(
  "document_sequences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** "invoice" | "bill" | "payment" | "journal" */
    documentType: text("document_type").notNull(),
    prefix: text("prefix").notNull().default(""),
    nextNumber: bigint("next_number", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
    padWidth: integer("pad_width").notNull().default(4),
    ...timestamps,
  },
  (t) => [uniqueIndex("seq_org_type_idx").on(t.orgId, t.documentType)],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Relations
 * ──────────────────────────────────────────────────────────────────────────*/

export const journalEntriesRelations = relations(journalEntries, ({ many, one }) => ({
  lines: many(journalLines),
  org: one(organizations, {
    fields: [journalEntries.orgId],
    references: [organizations.id],
  }),
}));

export const journalLinesRelations = relations(journalLines, ({ one }) => ({
  entry: one(journalEntries, {
    fields: [journalLines.entryId],
    references: [journalEntries.id],
  }),
  account: one(accounts, {
    fields: [journalLines.accountId],
    references: [accounts.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ many, one }) => ({
  lines: many(journalLines),
  parent: one(accounts, {
    fields: [accounts.parentId],
    references: [accounts.id],
    relationName: "account_tree",
  }),
  children: many(accounts, { relationName: "account_tree" }),
}));

export const invoicesRelations = relations(invoices, ({ many, one }) => ({
  lines: many(invoiceLines),
  contact: one(contacts, {
    fields: [invoices.contactId],
    references: [contacts.id],
  }),
  allocations: many(paymentAllocations),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceLines.invoiceId],
    references: [invoices.id],
  }),
  item: one(items, { fields: [invoiceLines.itemId], references: [items.id] }),
}));

export const billsRelations = relations(bills, ({ many, one }) => ({
  lines: many(billLines),
  contact: one(contacts, {
    fields: [bills.contactId],
    references: [contacts.id],
  }),
  allocations: many(paymentAllocations),
}));

export const paymentsRelations = relations(payments, ({ many, one }) => ({
  allocations: many(paymentAllocations),
  contact: one(contacts, {
    fields: [payments.contactId],
    references: [contacts.id],
  }),
}));

export const paymentAllocationsRelations = relations(paymentAllocations, ({ one }) => ({
  payment: one(payments, {
    fields: [paymentAllocations.paymentId],
    references: [payments.id],
  }),
  invoice: one(invoices, {
    fields: [paymentAllocations.invoiceId],
    references: [invoices.id],
  }),
  bill: one(bills, {
    fields: [paymentAllocations.billId],
    references: [bills.id],
  }),
}));

export const contactsRelations = relations(contacts, ({ many }) => ({
  invoices: many(invoices),
  bills: many(bills),
  payments: many(payments),
}));

/* ────────────────────────────────────────────────────────────────────────────
 * Inferred types
 * ──────────────────────────────────────────────────────────────────────────*/

export type Organization = typeof organizations.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type JournalLine = typeof journalLines.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type Bill = typeof bills.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type BankAccount = typeof bankAccounts.$inferSelect;
export type BankTransaction = typeof bankTransactions.$inferSelect;
export type AccountType = (typeof accountTypeEnum.enumValues)[number];
export type AccountSubtype = (typeof accountSubtypeEnum.enumValues)[number];
