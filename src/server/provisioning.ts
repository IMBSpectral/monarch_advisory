/**
 * New-organization provisioning.
 *
 * A freshly-created org (via /signup) starts empty, and several things are
 * mandatory before anything can be posted:
 *   - the chart of accounts (else resolveControlAccount → CONTROL_ACCOUNT_MISSING),
 *   - document sequences (else nextDocumentNumber → SEQUENCE_MISSING, which even
 *     blocks saving a *draft* invoice/bill),
 *   - a cash/bank ledger account (else POS and cash/bank vouchers have nowhere
 *     to settle),
 *   - GST tax rates (else the per-line tax dropdown only offers "No tax"),
 *   - a bank account row so /banking isn't empty.
 * This module gives a brand-new org all of that, so every module works from the
 * first sign-in.
 *
 * IDEMPOTENT. `ensureOrgProvisioned` only fills what's missing (by account code,
 * sequence type, and "has any tax rate / bank account"), so it's safe to run at
 * signup AND as a backfill over orgs that were created before this existed or
 * that were seeded empty (e.g. Sentinel Foods).
 *
 * The demo seed (src/db/seed.ts) keeps its own richer, fixture-specific chart
 * for IMB Labs; this generic default carries no demo names or opening balances.
 *
 * MUST run inside a transaction that has already declared `app.org_id` — every
 * table it writes (accounts, document_sequences, tax_rates, bank_accounts) is
 * RLS-scoped. registerOwner and the seed set that before calling in.
 */

import { and, count, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import {
  accounts,
  bankAccounts,
  documentSequences,
  taxRates,
  type AccountSubtype,
  type AccountType,
} from "@/db/schema";

type AccountDef = {
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  isGroup?: boolean;
  /** Control account the posting engine resolves by (subtype + isSystem). */
  isSystem?: boolean;
  parent?: string;
};

/**
 * Exactly one `isSystem` account exists for each of the ten control subtypes the
 * posting engine resolves: accounts_receivable, inventory, accounts_payable,
 * goods_received_clearing, tax_payable, retained_earnings, operating_revenue,
 * other_income, cost_of_goods_sold, operating_expense. Dropping any of these
 * would break the corresponding posting flow.
 */
export const DEFAULT_CHART: AccountDef[] = [
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
  { code: "1110", name: "Cash on Hand", type: "asset", subtype: "cash_and_bank", parent: "1100" },
  { code: "1111", name: "Bank Account", type: "asset", subtype: "cash_and_bank", parent: "1100" },
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
  { code: "1210", name: "Equipment", type: "asset", subtype: "fixed_asset", parent: "1200" },
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
    code: "2150",
    name: "Goods Received Not Invoiced",
    type: "liability",
    subtype: "goods_received_clearing",
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

  // Equity
  { code: "3000", name: "Equity", type: "equity", subtype: "equity", isGroup: true },
  { code: "3100", name: "Owner's Capital", type: "equity", subtype: "equity", parent: "3000" },
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
    name: "Sales Revenue",
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
    code: "5800",
    name: "Depreciation",
    type: "expense",
    subtype: "depreciation_expense",
    parent: "5000",
  },
  {
    code: "5900",
    name: "General & Administrative",
    type: "expense",
    subtype: "operating_expense",
    isSystem: true,
    parent: "5000",
  },
];

type SequenceDef = { documentType: string; prefix: string; padWidth: number };

/** One counter per document type; every posting path needs its own. */
export const DEFAULT_SEQUENCES: SequenceDef[] = [
  { documentType: "invoice", prefix: "INV-", padWidth: 4 },
  { documentType: "bill", prefix: "BILL-", padWidth: 4 },
  { documentType: "payment", prefix: "PAY-", padWidth: 4 },
  { documentType: "journal", prefix: "JE-", padWidth: 6 },
  { documentType: "credit_note", prefix: "CN-", padWidth: 4 },
  { documentType: "debit_note", prefix: "DN-", padWidth: 4 },
  { documentType: "contra", prefix: "CTR-", padWidth: 4 },
  { documentType: "sales_order", prefix: "SO-", padWidth: 4 },
  { documentType: "purchase_order", prefix: "PO-", padWidth: 4 },
  { documentType: "grn", prefix: "GRN-", padWidth: 4 },
  { documentType: "delivery_note", prefix: "DC-", padWidth: 4 },
];

type TaxRateDef = { name: string; rateBps: number };

/**
 * Standard Indian GST rates. Each posts output tax to GST Payable (2200) and
 * reclaims input tax against Input GST Credit (1140) — the accounts the chart
 * above provisions. IGST uses the same accounts here (place of supply isn't
 * modelled). TDS is a withholding mechanism, not a GST rate, so it's omitted.
 */
export const DEFAULT_TAX_RATES: TaxRateDef[] = [
  { name: "GST 18%", rateBps: 1800 },
  { name: "GST 12%", rateBps: 1200 },
  { name: "GST 5%", rateBps: 500 },
  { name: "IGST 18%", rateBps: 1800 },
  { name: "GST 0% (Exempt)", rateBps: 0 },
];

/**
 * Ensure an org has everything it needs to operate: chart of accounts, document
 * sequences, GST tax rates, and a default bank account. Fills only what's
 * missing, so it's safe to run at signup and as an idempotent backfill.
 */
export async function ensureOrgProvisioned(tx: DbOrTx, orgId: string): Promise<void> {
  /* ── Chart of accounts (insert missing codes, then link parents) ─────────*/
  const existing = await tx
    .select({ id: accounts.id, code: accounts.code })
    .from(accounts)
    .where(eq(accounts.orgId, orgId));
  const idByCode = new Map(existing.map((r) => [r.code, r.id]));

  for (const a of DEFAULT_CHART) {
    if (idByCode.has(a.code)) continue;
    const [row] = await tx
      .insert(accounts)
      .values({
        orgId,
        code: a.code,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        isGroup: a.isGroup ?? false,
        isSystem: a.isSystem ?? false,
      })
      .returning({ id: accounts.id });
    idByCode.set(a.code, row.id);
  }
  // Link parents for any managed account whose parent isn't set yet — covers
  // both freshly inserted rows and pre-existing orphans (e.g. a backfilled 5900).
  for (const a of DEFAULT_CHART) {
    if (!a.parent) continue;
    await tx
      .update(accounts)
      .set({ parentId: idByCode.get(a.parent) })
      .where(and(eq(accounts.id, idByCode.get(a.code)!), isNull(accounts.parentId)));
  }

  /* ── Document sequences (insert missing types) ───────────────────────────*/
  const haveSeq = new Set(
    (
      await tx
        .select({ documentType: documentSequences.documentType })
        .from(documentSequences)
        .where(eq(documentSequences.orgId, orgId))
    ).map((r) => r.documentType),
  );
  const missingSeq = DEFAULT_SEQUENCES.filter((s) => !haveSeq.has(s.documentType));
  if (missingSeq.length > 0) {
    await tx.insert(documentSequences).values(
      missingSeq.map((s) => ({
        orgId,
        documentType: s.documentType,
        prefix: s.prefix,
        padWidth: s.padWidth,
      })),
    );
  }

  /* ── GST tax rates (only if the org has none) ────────────────────────────*/
  const [{ count: taxCount }] = await tx
    .select({ count: count() })
    .from(taxRates)
    .where(eq(taxRates.orgId, orgId));
  if (Number(taxCount) === 0) {
    const outputAccountId = idByCode.get("2200")!;
    const inputAccountId = idByCode.get("1140")!;
    await tx.insert(taxRates).values(
      DEFAULT_TAX_RATES.map((t) => ({
        orgId,
        name: t.name,
        rateBps: t.rateBps,
        outputAccountId,
        inputAccountId,
      })),
    );
  }

  /* ── A default bank account for /banking (only if none) ──────────────────*/
  const [{ count: bankCount }] = await tx
    .select({ count: count() })
    .from(bankAccounts)
    .where(eq(bankAccounts.orgId, orgId));
  if (Number(bankCount) === 0) {
    // Link to the "Bank Account" ledger account (1111); it always exists after
    // the chart step above.
    await tx.insert(bankAccounts).values({
      orgId,
      accountId: idByCode.get("1111")!,
      name: "Bank Account",
      currency: "INR",
    });
  }
}

/** @deprecated call {@link ensureOrgProvisioned} — kept as an alias for callers. */
export const provisionOrgDefaults = ensureOrgProvisioned;
