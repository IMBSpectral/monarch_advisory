/**
 * GST posting — turns a transaction's total tax into the right ledger components
 * (CGST + SGST, or IGST) based on place of supply. The pure rules live in
 * `@/lib/gst`; this module resolves the org's GST accounts and its counterparty's
 * state, then produces the account/amount pairs to post.
 *
 * Two sides:
 *   • OUTPUT (sales) — supplier is the org, place of supply is the customer.
 *   • INPUT (purchases) — supplier is the vendor, recipient is the org; both must
 *     be known to split, otherwise the tax stays unsplit (no ITC / RCM here).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { accounts, contacts, organizations } from "@/db/schema";
import { LedgerError } from "./ledger";
import { determineGstTreatment, splitGst, stateCodeOf, type GstTreatment } from "@/lib/gst";

/** Well-known account codes for the GST components (provisioned, isSystem). */
const GST_OUTPUT_CODES = { unsplit: "2200", cgst: "2201", sgst: "2202", igst: "2203" } as const;
const GST_INPUT_CODES = { unsplit: "1140", cgst: "1141", sgst: "1142", igst: "1143" } as const;

type GstAccounts = { unsplit: string; cgst: string; sgst: string; igst: string };

async function resolveByCode(
  tx: DbOrTx,
  orgId: string,
  codes: Record<keyof GstAccounts, string>,
  labels: Record<keyof GstAccounts, string>,
): Promise<GstAccounts> {
  const rows = await tx
    .select({ code: accounts.code, id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), inArray(accounts.code, Object.values(codes))));
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  const need = (key: keyof GstAccounts) => {
    const id = byCode.get(codes[key]);
    if (!id) {
      throw new LedgerError(
        `GST account ${labels[key]} (${codes[key]}) is missing — provision the organisation's chart.`,
        "GST_ACCOUNT_MISSING",
      );
    }
    return id;
  };
  return { unsplit: need("unsplit"), cgst: need("cgst"), sgst: need("sgst"), igst: need("igst") };
}

/** Resolve the org's output-GST accounts by their well-known codes. */
export function resolveGstOutputAccounts(tx: DbOrTx, orgId: string): Promise<GstAccounts> {
  return resolveByCode(tx, orgId, GST_OUTPUT_CODES, {
    unsplit: "GST Payable",
    cgst: "Output CGST",
    sgst: "Output SGST",
    igst: "Output IGST",
  });
}

/** Resolve the org's input-GST (ITC) accounts by their well-known codes. */
export function resolveGstInputAccounts(tx: DbOrTx, orgId: string): Promise<GstAccounts> {
  return resolveByCode(tx, orgId, GST_INPUT_CODES, {
    unsplit: "Input GST Credit",
    cgst: "Input CGST",
    sgst: "Input SGST",
    igst: "Input IGST",
  });
}

/** The self-assessed reverse-charge (RCM) output liability account (code 2205). */
export async function resolveRcmOutputAccount(tx: DbOrTx, orgId: string): Promise<string> {
  const [row] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), eq(accounts.code, "2205")));
  if (!row) {
    throw new LedgerError(
      "GST account GST Payable (RCM) (2205) is missing — provision the organisation's chart.",
      "GST_ACCOUNT_MISSING",
    );
  }
  return row.id;
}

/** Split a total tax into per-component posting lines (account + positive amount). */
function buildLines(
  taxTotalMinor: bigint,
  treatment: GstTreatment,
  acc: GstAccounts,
): Array<{ accountId: string; amountMinor: bigint; label: string }> {
  const split = splitGst(taxTotalMinor, treatment);
  const lines: Array<{ accountId: string; amountMinor: bigint; label: string }> = [];
  if (split.cgst > 0n) lines.push({ accountId: acc.cgst, amountMinor: split.cgst, label: "CGST" });
  if (split.sgst > 0n) lines.push({ accountId: acc.sgst, amountMinor: split.sgst, label: "SGST" });
  if (split.igst > 0n) lines.push({ accountId: acc.igst, amountMinor: split.igst, label: "IGST" });
  if (split.unsplit > 0n)
    lines.push({ accountId: acc.unsplit, amountMinor: split.unsplit, label: "GST" });
  return lines;
}

/**
 * Split a sale's output tax. The caller applies the sign — a credit for an
 * invoice (tax collected), a debit for a credit note (tax reversed). Place of
 * supply is the customer's `placeOfSupplyCode`, falling back to their GSTIN's
 * state; the supplier state comes from the org's GSTIN.
 */
export async function splitOutputGst(
  tx: DbOrTx,
  orgId: string,
  contactId: string,
  taxTotalMinor: bigint,
): Promise<Array<{ accountId: string; amountMinor: bigint; label: string }>> {
  const [org] = await tx
    .select({ gstin: organizations.taxRegistrationNumber })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const [contact] = await tx
    .select({ placeOfSupply: contacts.placeOfSupplyCode, gstin: contacts.taxRegistrationNumber })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId)));

  const supplierState = stateCodeOf(org?.gstin);
  const placeOfSupply = contact?.placeOfSupply || stateCodeOf(contact?.gstin);
  const treatment = determineGstTreatment(supplierState, placeOfSupply);
  return buildLines(taxTotalMinor, treatment, await resolveGstOutputAccounts(tx, orgId));
}

/**
 * Split a purchase's input tax (ITC). The caller applies the sign — a debit for a
 * bill (tax reclaimable), a credit for a debit note (ITC reversed). The supplier
 * state comes from the vendor's GSTIN, the recipient state from the org's; if
 * either is unknown the tax stays unsplit (posted to the single Input GST Credit
 * account), since we can't determine intra- vs inter-state.
 */
export async function splitInputGst(
  tx: DbOrTx,
  orgId: string,
  vendorContactId: string,
  taxTotalMinor: bigint,
): Promise<Array<{ accountId: string; amountMinor: bigint; label: string }>> {
  const [org] = await tx
    .select({ gstin: organizations.taxRegistrationNumber })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const [vendor] = await tx
    .select({ placeOfSupply: contacts.placeOfSupplyCode, gstin: contacts.taxRegistrationNumber })
    .from(contacts)
    .where(and(eq(contacts.id, vendorContactId), eq(contacts.orgId, orgId)));

  const supplierState = vendor?.placeOfSupply || stateCodeOf(vendor?.gstin);
  const recipientState = stateCodeOf(org?.gstin);
  const treatment: GstTreatment =
    !supplierState || !recipientState
      ? "unregistered"
      : supplierState === recipientState
        ? "intra"
        : "inter";
  return buildLines(taxTotalMinor, treatment, await resolveGstInputAccounts(tx, orgId));
}
