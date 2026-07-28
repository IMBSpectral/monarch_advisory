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
  /** Goods Received Not Invoiced — clears when the vendor bill arrives. */
  "goods_received_clearing",
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
  "contra",
]);

/**
 * Sales/purchase order lifecycle. Orders are non-financial commitments — they
 * never touch the ledger; converting one to an invoice/bill is what posts.
 */
export const orderStatusEnum = pgEnum("order_status", [
  "draft",
  "confirmed",
  "partially_invoiced",
  "invoiced",
  "cancelled",
]);

export const contactTypeEnum = pgEnum("contact_type", ["customer", "vendor", "both"]);

/**
 * How an item's stock is valued when issued. Weighted-average is the default
 * (and the only one wired in Phase 1a); FIFO is reserved for a later milestone.
 */
export const valuationMethodEnum = pgEnum("valuation_method", ["weighted_average", "fifo"]);

/**
 * Why a stock movement happened. Mirrors `journal_source` for goods: it lets a
 * stock line be traced back to the document that caused it, and lets void/reverse
 * flows find exactly what to undo.
 */
export const stockMoveSourceEnum = pgEnum("stock_move_source", [
  "purchase", // bill post — goods in
  "sale", // invoice / POS post — goods out
  "sales_return", // credit note (later)
  "purchase_return", // debit note (later)
  "adjustment", // manual write-up / write-down
  "transfer_out", // warehouse -> warehouse
  "transfer_in",
  "opening_balance", // opening stock load
  "reversal", // restock from a void/reverse
]);

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

/** Credit/debit note lifecycle. Like invoices/bills: drafts have no ledger impact. */
export const noteStatusEnum = pgEnum("note_status", ["draft", "posted", "void"]);

export const depreciationMethodEnum = pgEnum("depreciation_method", ["straight_line"]);
export const assetStatusEnum = pgEnum("asset_status", ["active", "disposed"]);

export const recurringFrequencyEnum = pgEnum("recurring_frequency", [
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
]);
export const recurringStatusEnum = pgEnum("recurring_status", ["active", "paused", "ended"]);

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

/**
 * Server-side sessions.
 *
 * The cookie carries an opaque 256-bit random token; only its SHA-256 hash is
 * stored here. A leaked database dump therefore cannot be replayed as a login,
 * and the same constant-time-compare discipline as password checking applies.
 *
 * WHY A TABLE AND NOT A SEALED COOKIE. A self-contained encrypted cookie can't
 * be revoked before it expires — logout would be client-side theatre and an
 * admin could not evict a compromised session. For books that a business
 * actually relies on, revocation has to be real, so the server keeps the record.
 *
 * `activeOrgId` lives here because one human may belong to several orgs (owner
 * of their own company, read-only accountant on a client's). It is the acting
 * tenant for the request, and it is always re-checked against `memberships`
 * before use — a stale or tampered value must never widen access.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the cookie token, hex. Never the token itself. */
    tokenHash: text("token_hash").notNull(),
    activeOrgId: uuid("active_org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set on logout or admin eviction. Kept, not deleted, for the audit trail. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("session_token_idx").on(t.tokenHash), index("session_user_idx").on(t.userId)],
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
    /** COGS account credited-from on sale. Null → resolved by subtype. */
    cogsAccountId: uuid("cogs_account_id").references(() => accounts.id),
    defaultTaxRateId: uuid("default_tax_rate_id").references(() => taxRates.id),
    /** How issues are valued. Default weighted-average. */
    valuationMethod: valuationMethodEnum("valuation_method").notNull().default("weighted_average"),
    /** Alert threshold; null = not tracked for reordering. */
    reorderLevel: numeric("reorder_level", { precision: 18, scale: 4 }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("item_org_sku_idx").on(t.orgId, t.sku),
    index("item_org_name_idx").on(t.orgId, t.name),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Inventory — the perpetual stock ledger
 *
 * `stock_movements` is to inventory what `journal_lines` is to money: append-only
 * and signed (+ = received, − = issued). On-hand = Σ quantity; stock value =
 * Σ value_minor. The headline invariant the engine guarantees:
 *
 *   Σ item_stock_levels.value_minor  ==  balance of the Inventory control account
 *
 * because every goods move is posted in the same transaction as the money move it
 * rides on, at the same integer value. See `db/verify.ts`.
 * ──────────────────────────────────────────────────────────────────────────*/

/** Godowns / stock locations. */
export const warehouses = pgTable(
  "warehouses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("warehouse_org_code_idx").on(t.orgId, t.code)],
);

/**
 * The stock ledger. Signed like journal_lines: qty/value > 0 = in, < 0 = out.
 * Immutable — the app role is denied UPDATE/DELETE in the migration.
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    moveDate: date("move_date").notNull(),
    /** Signed. + = received, − = issued. numeric to allow 2.5 kg etc. */
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    /** Signed base-currency paise moved into/out of stock value. */
    valueMinor: money("value_minor").notNull(),
    /** Absolute unit cost applied to this move, for audit/trace. */
    unitCostMinor: money("unit_cost_minor").notNull(),
    source: stockMoveSourceEnum("source").notNull(),
    /** The document that caused the move (invoice/bill/adjustment id). */
    sourceDocumentId: uuid("source_document_id"),
    /** The journal entry posted alongside (null for pure relocations). */
    jeId: uuid("je_id").references(() => journalEntries.id),
    memo: text("memo"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("smove_org_item_wh_idx").on(t.orgId, t.itemId, t.warehouseId),
    index("smove_org_date_idx").on(t.orgId, t.moveDate),
    index("smove_source_doc_idx").on(t.source, t.sourceDocumentId),
    check("smove_nonzero_qty", sql`${t.quantity} <> 0`),
  ],
);

/**
 * Cached on-hand per (item, warehouse). Rebuildable from stock_movements; exists
 * for O(1) reads and to hold the weighted-average running value/qty. Mirrors the
 * "cached but reconciled" pattern used for A/R aging.
 */
export const itemStockLevels = pgTable(
  "item_stock_levels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    onHandQty: numeric("on_hand_qty", { precision: 18, scale: 4 }).notNull().default("0"),
    valueMinor: money("value_minor")
      .notNull()
      .default(sql`0`),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("stocklevel_item_wh_idx").on(t.itemId, t.warehouseId),
    index("stocklevel_org_idx").on(t.orgId),
    check("stocklevel_value_nonneg", sql`${t.valueMinor} >= 0`),
  ],
);

/**
 * FIFO cost layers. One row per receipt of a FIFO-valued item; issues consume the
 * oldest layers first. Weighted-average items don't use this — they value from
 * the running `item_stock_levels` balance instead. The sum of a FIFO item's
 * remaining layer value always equals its cached level value.
 */
export const stockLayers = pgTable(
  "stock_layers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    receivedAt: date("received_at").notNull(),
    originalQty: numeric("original_qty", { precision: 18, scale: 4 }).notNull(),
    remainingQty: numeric("remaining_qty", { precision: 18, scale: 4 }).notNull(),
    unitCostMinor: money("unit_cost_minor").notNull(),
    /** Exact remaining value (paise). Issues draw this down so no rounding residue
     * strands value or misstates COGS — the last unit of a layer takes its exact
     * remaining value, not qty × rounded-unit-cost. */
    remainingValueMinor: money("remaining_value_minor").notNull(),
    sourceMovementId: uuid("source_movement_id").references(() => stockMovements.id),
    ...timestamps,
  },
  (t) => [
    // Consumption scans oldest-first within an item/warehouse.
    index("slayer_fifo_idx").on(t.orgId, t.itemId, t.warehouseId, t.receivedAt),
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
     * For a foreign-currency invoice, the total in the invoice's own currency
     * (the base-currency `totalMinor` above is what the ledger and every report
     * use). Null for base-currency invoices.
     */
    foreignTotalMinor: money("foreign_total_minor"),
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
    /**
     * True when a delivery note already relieved stock and booked COGS for this
     * invoice's goods. Posting then recognises revenue only — it must not relieve
     * stock a second time.
     */
    stockRelieved: boolean("stock_relieved").notNull().default(false),
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
    /**
     * True when a goods receipt (GRN) already received this bill's stock into
     * inventory against the clearing account. Posting then debits GRNI (clearing
     * it) instead of Inventory, and does not receive stock a second time.
     */
    stockReceived: boolean("stock_received").notNull().default(false),
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
 * Credit notes (sales returns / allowances) — the mirror image of an invoice.
 *
 *   Dr  Revenue                 subtotal (income reversed)
 *   Dr  GST/VAT Payable         tax (output tax reversed)
 *     Cr  Accounts Receivable   total (the customer owes us less)
 *
 * If goods come back, the same document also restocks and reverses COGS:
 *   Dr  Inventory / Cr  COGS    at the item's current average cost.
 * ──────────────────────────────────────────────────────────────────────────*/

export const creditNotes = pgTable(
  "credit_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    creditNoteNumber: text("credit_note_number").notNull(),
    /** The invoice being credited. Required — aging nets the note against it. */
    relatedInvoiceId: uuid("related_invoice_id").references(() => invoices.id),
    creditNoteDate: date("credit_note_date").notNull(),
    status: noteStatusEnum("status").notNull().default("draft"),
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
    /** Whether posting returns the lines' goods to stock. */
    restock: boolean("restock").notNull().default(true),
    reason: text("reason"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("cnote_org_number_idx").on(t.orgId, t.creditNoteNumber),
    index("cnote_org_contact_idx").on(t.orgId, t.contactId),
    index("cnote_invoice_idx").on(t.relatedInvoiceId),
  ],
);

export const creditNoteLines = pgTable(
  "credit_note_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    creditNoteId: uuid("credit_note_id")
      .notNull()
      .references(() => creditNotes.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    itemId: uuid("item_id").references(() => items.id),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default("1"),
    unitPriceMinor: money("unit_price_minor").notNull(),
    discountBps: integer("discount_bps").notNull().default(0),
    taxRateId: uuid("tax_rate_id").references(() => taxRates.id),
    taxAmountMinor: money("tax_amount_minor")
      .notNull()
      .default(sql`0`),
    lineTotalMinor: money("line_total_minor").notNull(),
    revenueAccountId: uuid("revenue_account_id").references(() => accounts.id),
    ...timestamps,
  },
  (t) => [
    index("cnline_note_idx").on(t.creditNoteId),
    uniqueIndex("cnline_note_line_idx").on(t.creditNoteId, t.lineNumber),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Debit notes (purchase returns / allowances) — the mirror image of a bill.
 *
 *   Dr  Accounts Payable        total (we owe the vendor less)
 *     Cr  Expense / Inventory   subtotal (cost reversed / goods returned)
 *     Cr  GST/VAT Input Credit  tax (input credit reversed)
 * ──────────────────────────────────────────────────────────────────────────*/

export const debitNotes = pgTable(
  "debit_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    debitNoteNumber: text("debit_note_number").notNull(),
    relatedBillId: uuid("related_bill_id").references(() => bills.id),
    debitNoteDate: date("debit_note_date").notNull(),
    status: noteStatusEnum("status").notNull().default("draft"),
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
    /** Whether posting removes the lines' goods from stock (returned to vendor). */
    restock: boolean("restock").notNull().default(true),
    reason: text("reason"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("dnote_org_number_idx").on(t.orgId, t.debitNoteNumber),
    index("dnote_org_contact_idx").on(t.orgId, t.contactId),
    index("dnote_bill_idx").on(t.relatedBillId),
  ],
);

export const debitNoteLines = pgTable(
  "debit_note_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    debitNoteId: uuid("debit_note_id")
      .notNull()
      .references(() => debitNotes.id, { onDelete: "cascade" }),
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
    expenseAccountId: uuid("expense_account_id").references(() => accounts.id),
    ...timestamps,
  },
  (t) => [
    index("dnline_note_idx").on(t.debitNoteId),
    uniqueIndex("dnline_note_line_idx").on(t.debitNoteId, t.lineNumber),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Dimensions — cost centres & projects.
 *
 * `journal_lines` already carries `cost_center_id` and `project_id`; these are
 * the masters they point at, so any posting can be tagged and reports can slice
 * the P&L by department or project.
 * ──────────────────────────────────────────────────────────────────────────*/

export const costCenters = pgTable(
  "cost_centers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("cc_org_code_idx").on(t.orgId, t.code)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("proj_org_code_idx").on(t.orgId, t.code)],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Recurring invoice templates — automation. A template holds an invoice's shape;
 * running the generator materialises real invoices on schedule and advances the
 * next run date.
 * ──────────────────────────────────────────────────────────────────────────*/

export const recurringTemplates = pgTable(
  "recurring_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    name: text("name").notNull(),
    frequency: recurringFrequencyEnum("frequency").notNull(),
    startDate: date("start_date").notNull(),
    nextRunDate: date("next_run_date").notNull(),
    endDate: date("end_date"),
    dueDays: integer("due_days").notNull().default(30),
    currency: text("currency").notNull().default("INR"),
    /** Post each generated invoice to the ledger immediately. */
    autoPost: boolean("auto_post").notNull().default(true),
    status: recurringStatusEnum("status").notNull().default("active"),
    lastInvoiceId: uuid("last_invoice_id").references(() => invoices.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("rtpl_org_name_idx").on(t.orgId, t.name),
    index("rtpl_org_status_idx").on(t.orgId, t.status),
  ],
);

export const recurringTemplateLines = pgTable(
  "recurring_template_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => recurringTemplates.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    itemId: uuid("item_id").references(() => items.id),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default("1"),
    unitPriceMinor: money("unit_price_minor").notNull(),
    discountBps: integer("discount_bps").notNull().default(0),
    taxRateId: uuid("tax_rate_id").references(() => taxRates.id),
    revenueAccountId: uuid("revenue_account_id").references(() => accounts.id),
    ...timestamps,
  },
  (t) => [
    index("rtplline_tpl_idx").on(t.templateId),
    uniqueIndex("rtplline_tpl_line_idx").on(t.templateId, t.lineNumber),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Fixed assets & depreciation.
 *
 * An asset points at three accounts — its gross-cost asset account, the
 * accumulated-depreciation contra, and the depreciation-expense account — so a
 * depreciation run is just Dr expense / Cr accumulated, and the register always
 * ties back to the ledger: Σ depreciation_entries == the accumulated-dep balance.
 * ──────────────────────────────────────────────────────────────────────────*/

export const fixedAssets = pgTable(
  "fixed_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    assetAccountId: uuid("asset_account_id")
      .notNull()
      .references(() => accounts.id),
    accumulatedAccountId: uuid("accumulated_account_id")
      .notNull()
      .references(() => accounts.id),
    depreciationAccountId: uuid("depreciation_account_id")
      .notNull()
      .references(() => accounts.id),
    acquisitionDate: date("acquisition_date").notNull(),
    costMinor: money("cost_minor").notNull(),
    salvageValueMinor: money("salvage_value_minor")
      .notNull()
      .default(sql`0`),
    usefulLifeMonths: integer("useful_life_months").notNull(),
    method: depreciationMethodEnum("method").notNull().default("straight_line"),
    status: assetStatusEnum("status").notNull().default("active"),
    disposedDate: date("disposed_date"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [uniqueIndex("asset_org_code_idx").on(t.orgId, t.code)],
);

/** One posted depreciation charge for one asset in one month. */
export const depreciationEntries = pgTable(
  "depreciation_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fixedAssetId: uuid("fixed_asset_id")
      .notNull()
      .references(() => fixedAssets.id, { onDelete: "cascade" }),
    /** The month depreciated, stored as its first day (YYYY-MM-01). */
    periodDate: date("period_date").notNull(),
    amountMinor: money("amount_minor").notNull(),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    ...timestamps,
  },
  (t) => [uniqueIndex("depentry_asset_period_idx").on(t.fixedAssetId, t.periodDate)],
);

/**
 * Exchange rates to the org's base currency. A currency can have many dated
 * rates; the effective rate for a transaction is the latest one on or before it.
 * `rateToBase` is how many base-currency units one unit of `currencyCode` buys
 * (USD→INR ≈ 83), and it multiplies minor units directly (1 cent = 83 paise).
 */
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    currencyCode: text("currency_code").notNull(),
    rateToBase: numeric("rate_to_base", { precision: 20, scale: 10 }).notNull(),
    asOfDate: date("as_of_date").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("fxrate_org_ccy_date_idx").on(t.orgId, t.currencyCode, t.asOfDate)],
);

/**
 * Annual budget for an account (optionally a cost centre). Budget-vs-actual is
 * derived by comparing this to the posted ledger for the fiscal year.
 */
export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    costCenterId: uuid("cost_center_id").references(() => costCenters.id),
    /** Fiscal year the budget applies to, e.g. 2026 for FY2026-27 (Apr start). */
    fiscalYear: integer("fiscal_year").notNull(),
    amountMinor: money("amount_minor").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("budget_org_acct_cc_year_idx").on(
      t.orgId,
      t.accountId,
      t.costCenterId,
      t.fiscalYear,
    ),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Contra vouchers — moving money between the org's own accounts.
 *
 * A pure two-line transfer (bank↔bank, bank↔cash): Dr destination, Cr source.
 * No contact, no tax, no subledger. The document exists so the transfer is a
 * first-class, numbered voucher rather than an anonymous manual entry.
 * ──────────────────────────────────────────────────────────────────────────*/

export const contraVouchers = pgTable(
  "contra_vouchers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    voucherNumber: text("voucher_number").notNull(),
    voucherDate: date("voucher_date").notNull(),
    fromAccountId: uuid("from_account_id")
      .notNull()
      .references(() => accounts.id),
    toAccountId: uuid("to_account_id")
      .notNull()
      .references(() => accounts.id),
    amountMinor: money("amount_minor").notNull(),
    memo: text("memo"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("contra_org_number_idx").on(t.orgId, t.voucherNumber),
    index("contra_org_date_idx").on(t.orgId, t.voucherDate),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Sales & purchase orders — commitments that convert into invoices/bills.
 * Non-financial: no journal entry until conversion.
 * ──────────────────────────────────────────────────────────────────────────*/

export const salesOrders = pgTable(
  "sales_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    orderNumber: text("order_number").notNull(),
    orderDate: date("order_date").notNull(),
    expectedDate: date("expected_date"),
    status: orderStatusEnum("status").notNull().default("draft"),
    currency: text("currency").notNull(),
    subtotalMinor: money("subtotal_minor")
      .notNull()
      .default(sql`0`),
    taxTotalMinor: money("tax_total_minor")
      .notNull()
      .default(sql`0`),
    totalMinor: money("total_minor")
      .notNull()
      .default(sql`0`),
    notes: text("notes"),
    /** Set when converted — the invoice this order produced. */
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("so_org_number_idx").on(t.orgId, t.orderNumber),
    index("so_org_contact_idx").on(t.orgId, t.contactId),
    index("so_org_status_idx").on(t.orgId, t.status),
  ],
);

export const salesOrderLines = pgTable(
  "sales_order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    salesOrderId: uuid("sales_order_id")
      .notNull()
      .references(() => salesOrders.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    itemId: uuid("item_id").references(() => items.id),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default("1"),
    unitPriceMinor: money("unit_price_minor").notNull(),
    discountBps: integer("discount_bps").notNull().default(0),
    taxRateId: uuid("tax_rate_id").references(() => taxRates.id),
    revenueAccountId: uuid("revenue_account_id").references(() => accounts.id),
    ...timestamps,
  },
  (t) => [
    index("soline_order_idx").on(t.salesOrderId),
    uniqueIndex("soline_order_line_idx").on(t.salesOrderId, t.lineNumber),
  ],
);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    orderNumber: text("order_number").notNull(),
    orderDate: date("order_date").notNull(),
    expectedDate: date("expected_date"),
    status: orderStatusEnum("status").notNull().default("draft"),
    currency: text("currency").notNull(),
    subtotalMinor: money("subtotal_minor")
      .notNull()
      .default(sql`0`),
    taxTotalMinor: money("tax_total_minor")
      .notNull()
      .default(sql`0`),
    totalMinor: money("total_minor")
      .notNull()
      .default(sql`0`),
    notes: text("notes"),
    /** Set when converted — the bill this order produced. */
    billId: uuid("bill_id").references(() => bills.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("po_org_number_idx").on(t.orgId, t.orderNumber),
    index("po_org_contact_idx").on(t.orgId, t.contactId),
    index("po_org_status_idx").on(t.orgId, t.status),
  ],
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    itemId: uuid("item_id").references(() => items.id),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default("1"),
    unitPriceMinor: money("unit_price_minor").notNull(),
    taxRateId: uuid("tax_rate_id").references(() => taxRates.id),
    expenseAccountId: uuid("expense_account_id").references(() => accounts.id),
    ...timestamps,
  },
  (t) => [
    index("poline_order_idx").on(t.purchaseOrderId),
    uniqueIndex("poline_order_line_idx").on(t.purchaseOrderId, t.lineNumber),
  ],
);

/* ────────────────────────────────────────────────────────────────────────────
 * Goods receipts (GRN) & delivery notes — goods moving without money (yet).
 *
 * GRN: stock arrives before the vendor bill.  Dr Inventory / Cr GRNI clearing.
 *      The later bill (flagged stockReceived) posts Dr GRNI / Cr A/P.
 * Delivery note: stock leaves before the invoice.  Dr COGS / Cr Inventory.
 *      The later invoice (flagged stockRelieved) recognises revenue only.
 * Both post a journal entry, so the stock ledger and the Inventory account never
 * disagree even though the money leg is deferred.
 * ──────────────────────────────────────────────────────────────────────────*/

export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    grnNumber: text("grn_number").notNull(),
    relatedPurchaseOrderId: uuid("related_purchase_order_id").references(() => purchaseOrders.id),
    receiptDate: date("receipt_date").notNull(),
    status: noteStatusEnum("status").notNull().default("draft"),
    currency: text("currency").notNull(),
    totalMinor: money("total_minor")
      .notNull()
      .default(sql`0`),
    notes: text("notes"),
    /** Set when a bill is raised against this receipt. */
    billId: uuid("bill_id").references(() => bills.id),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("grn_org_number_idx").on(t.orgId, t.grnNumber),
    index("grn_org_contact_idx").on(t.orgId, t.contactId),
  ],
);

export const goodsReceiptLines = pgTable(
  "goods_receipt_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    goodsReceiptId: uuid("goods_receipt_id")
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default("1"),
    /** Cost the goods enter stock at (from the PO, or expected cost). */
    unitCostMinor: money("unit_cost_minor").notNull(),
    taxRateId: uuid("tax_rate_id").references(() => taxRates.id),
    ...timestamps,
  },
  (t) => [
    index("grnline_grn_idx").on(t.goodsReceiptId),
    uniqueIndex("grnline_grn_line_idx").on(t.goodsReceiptId, t.lineNumber),
  ],
);

export const deliveryNotes = pgTable(
  "delivery_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    deliveryNumber: text("delivery_number").notNull(),
    relatedSalesOrderId: uuid("related_sales_order_id").references(() => salesOrders.id),
    deliveryDate: date("delivery_date").notNull(),
    status: noteStatusEnum("status").notNull().default("draft"),
    currency: text("currency").notNull(),
    notes: text("notes"),
    /** Set when an invoice is raised for these delivered goods. */
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("dnote_delivery_org_number_idx").on(t.orgId, t.deliveryNumber),
    index("dnote_delivery_org_contact_idx").on(t.orgId, t.contactId),
  ],
);

export const deliveryNoteLines = pgTable(
  "delivery_note_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deliveryNoteId: uuid("delivery_note_id")
      .notNull()
      .references(() => deliveryNotes.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default("1"),
    /** The sale price, carried so conversion to an invoice keeps pricing. */
    unitPriceMinor: money("unit_price_minor").notNull(),
    taxRateId: uuid("tax_rate_id").references(() => taxRates.id),
    revenueAccountId: uuid("revenue_account_id").references(() => accounts.id),
    ...timestamps,
  },
  (t) => [
    index("dnline_delivery_idx").on(t.deliveryNoteId),
    uniqueIndex("dnline_delivery_line_idx").on(t.deliveryNoteId, t.lineNumber),
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
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Session = typeof sessions.$inferSelect;
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
export type Item = typeof items.$inferSelect;
export type Warehouse = typeof warehouses.$inferSelect;
export type StockMovement = typeof stockMovements.$inferSelect;
export type ItemStockLevel = typeof itemStockLevels.$inferSelect;
export type ValuationMethod = (typeof valuationMethodEnum.enumValues)[number];
export type CreditNote = typeof creditNotes.$inferSelect;
export type CreditNoteLine = typeof creditNoteLines.$inferSelect;
export type DebitNote = typeof debitNotes.$inferSelect;
export type DebitNoteLine = typeof debitNoteLines.$inferSelect;
export type ContraVoucher = typeof contraVouchers.$inferSelect;
export type SalesOrder = typeof salesOrders.$inferSelect;
export type SalesOrderLine = typeof salesOrderLines.$inferSelect;
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;
export type GoodsReceipt = typeof goodsReceipts.$inferSelect;
export type GoodsReceiptLine = typeof goodsReceiptLines.$inferSelect;
export type DeliveryNote = typeof deliveryNotes.$inferSelect;
export type DeliveryNoteLine = typeof deliveryNoteLines.$inferSelect;
export type CostCenter = typeof costCenters.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Budget = typeof budgets.$inferSelect;
export type ExchangeRate = typeof exchangeRates.$inferSelect;
export type FixedAsset = typeof fixedAssets.$inferSelect;
export type DepreciationEntry = typeof depreciationEntries.$inferSelect;
export type RecurringTemplate = typeof recurringTemplates.$inferSelect;
export type RecurringTemplateLine = typeof recurringTemplateLines.$inferSelect;
export type StockLayer = typeof stockLayers.$inferSelect;
