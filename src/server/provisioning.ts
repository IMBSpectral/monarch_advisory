/**
 * New-organization provisioning.
 *
 * A freshly-created org (via /signup) starts with no chart of accounts and no
 * document sequences — and both are mandatory for posting: resolveControlAccount
 * throws CONTROL_ACCOUNT_MISSING without the system accounts, and
 * nextDocumentNumber throws SEQUENCE_MISSING without the sequence rows. This
 * module gives a brand-new org a minimal but complete, control-account-complete
 * set of books so every module works from the first sign-in.
 *
 * The demo seed (src/db/seed.ts) keeps its own richer, fixture-specific chart —
 * this one is the generic default for real self-service signups, so it carries
 * no demo bank names or opening balances.
 *
 * MUST run inside a transaction that has already declared `app.org_id` (accounts
 * and document_sequences are both RLS-scoped) — registerOwner does this before
 * calling in.
 */

import { eq } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import {
  accounts,
  documentSequences,
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
  { code: "1100", name: "Current Assets", type: "asset", subtype: "other_current_asset", isGroup: true, parent: "1000" },
  { code: "1110", name: "Cash on Hand", type: "asset", subtype: "cash_and_bank", parent: "1100" },
  { code: "1111", name: "Bank Account", type: "asset", subtype: "cash_and_bank", parent: "1100" },
  { code: "1120", name: "Accounts Receivable", type: "asset", subtype: "accounts_receivable", isSystem: true, parent: "1100" },
  { code: "1130", name: "Inventory", type: "asset", subtype: "inventory", isSystem: true, parent: "1100" },
  { code: "1140", name: "Input GST Credit", type: "asset", subtype: "other_current_asset", parent: "1100" },
  { code: "1200", name: "Fixed Assets", type: "asset", subtype: "fixed_asset", isGroup: true, parent: "1000" },
  { code: "1210", name: "Equipment", type: "asset", subtype: "fixed_asset", parent: "1200" },
  { code: "1290", name: "Accumulated Depreciation", type: "asset", subtype: "accumulated_depreciation", parent: "1200" },

  // Liabilities
  { code: "2000", name: "Liabilities", type: "liability", subtype: "other_current_liability", isGroup: true },
  { code: "2100", name: "Accounts Payable", type: "liability", subtype: "accounts_payable", isSystem: true, parent: "2000" },
  { code: "2150", name: "Goods Received Not Invoiced", type: "liability", subtype: "goods_received_clearing", isSystem: true, parent: "2000" },
  { code: "2200", name: "GST Payable", type: "liability", subtype: "tax_payable", isSystem: true, parent: "2000" },
  { code: "2210", name: "TDS Payable", type: "liability", subtype: "tax_payable", parent: "2000" },

  // Equity
  { code: "3000", name: "Equity", type: "equity", subtype: "equity", isGroup: true },
  { code: "3100", name: "Owner's Capital", type: "equity", subtype: "equity", parent: "3000" },
  { code: "3200", name: "Retained Earnings", type: "equity", subtype: "retained_earnings", isSystem: true, parent: "3000" },

  // Income
  { code: "4000", name: "Revenue", type: "income", subtype: "operating_revenue", isGroup: true },
  { code: "4100", name: "Sales Revenue", type: "income", subtype: "operating_revenue", isSystem: true, parent: "4000" },
  { code: "4200", name: "Service Revenue", type: "income", subtype: "operating_revenue", parent: "4000" },
  { code: "4900", name: "Other Income", type: "income", subtype: "other_income", parent: "4000" },
  { code: "4910", name: "Forex Gain/Loss", type: "income", subtype: "other_income", isSystem: true, parent: "4000" },
  { code: "4920", name: "Gain/Loss on Asset Disposal", type: "income", subtype: "other_income", parent: "4000" },

  // Expenses
  { code: "5000", name: "Expenses", type: "expense", subtype: "operating_expense", isGroup: true },
  { code: "5100", name: "Cost of Goods Sold", type: "expense", subtype: "cost_of_goods_sold", isSystem: true, parent: "5000" },
  { code: "5200", name: "Salaries & Wages", type: "expense", subtype: "operating_expense", parent: "5000" },
  { code: "5300", name: "Rent & Utilities", type: "expense", subtype: "operating_expense", parent: "5000" },
  { code: "5400", name: "Marketing", type: "expense", subtype: "operating_expense", parent: "5000" },
  { code: "5800", name: "Depreciation", type: "expense", subtype: "depreciation_expense", parent: "5000" },
  { code: "5900", name: "General & Administrative", type: "expense", subtype: "operating_expense", isSystem: true, parent: "5000" },
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

/**
 * Give a brand-new org its default chart of accounts and document sequences.
 * Idempotent guard is unnecessary — this runs once, inside the same transaction
 * that creates the org, so a failure rolls the whole signup back.
 */
export async function provisionOrgDefaults(tx: DbOrTx, orgId: string): Promise<void> {
  await tx
    .insert(documentSequences)
    .values(DEFAULT_SEQUENCES.map((s) => ({ orgId, documentType: s.documentType, prefix: s.prefix, padWidth: s.padWidth })));

  // Two passes so a parent row exists before its children reference it.
  const idByCode = new Map<string, string>();
  for (const a of DEFAULT_CHART) {
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
  for (const a of DEFAULT_CHART) {
    if (!a.parent) continue;
    await tx
      .update(accounts)
      .set({ parentId: idByCode.get(a.parent) })
      .where(eq(accounts.id, idByCode.get(a.code)!));
  }
}
