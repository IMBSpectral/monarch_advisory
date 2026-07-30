/**
 * GST posting — turns a transaction's total tax into the right ledger components
 * (CGST + SGST, or IGST) based on place of supply. The pure rules live in
 * `@/lib/gst`; this module resolves the org's GST accounts and its counterparty's
 * state, then produces the account/amount pairs to post.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { accounts, contacts, organizations } from "@/db/schema";
import { LedgerError } from "./ledger";
import { determineGstTreatment, splitGst, stateCodeOf } from "@/lib/gst";

/** Well-known account codes for the GST output components (provisioned, isSystem). */
const GST_OUTPUT_CODES = { unsplit: "2200", cgst: "2201", sgst: "2202", igst: "2203" } as const;

/** Resolve the org's output-GST accounts by their well-known codes. */
export async function resolveGstOutputAccounts(
  tx: DbOrTx,
  orgId: string,
): Promise<{ unsplit: string; cgst: string; sgst: string; igst: string }> {
  const rows = await tx
    .select({ code: accounts.code, id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.orgId, orgId),
        inArray(accounts.code, Object.values(GST_OUTPUT_CODES) as string[]),
      ),
    );
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  const need = (code: string, label: string) => {
    const id = byCode.get(code);
    if (!id) {
      throw new LedgerError(
        `GST account ${label} (${code}) is missing — provision the organisation's chart.`,
        "GST_ACCOUNT_MISSING",
      );
    }
    return id;
  };
  return {
    unsplit: need(GST_OUTPUT_CODES.unsplit, "GST Payable"),
    cgst: need(GST_OUTPUT_CODES.cgst, "Output CGST"),
    sgst: need(GST_OUTPUT_CODES.sgst, "Output SGST"),
    igst: need(GST_OUTPUT_CODES.igst, "Output IGST"),
  };
}

/**
 * Split a document's total output tax into per-component postings (account +
 * positive amount + a label). The caller applies the sign — a credit for an
 * invoice (tax collected), a debit for a credit note (tax reversed). Place of
 * supply is the contact's `placeOfSupplyCode`, falling back to the state in their
 * GSTIN; the supplier state comes from the org's GSTIN.
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
    .select({
      placeOfSupply: contacts.placeOfSupplyCode,
      gstin: contacts.taxRegistrationNumber,
    })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId)));

  const supplierState = stateCodeOf(org?.gstin);
  const placeOfSupply = contact?.placeOfSupply || stateCodeOf(contact?.gstin);
  const treatment = determineGstTreatment(supplierState, placeOfSupply);
  const split = splitGst(taxTotalMinor, treatment);
  const acc = await resolveGstOutputAccounts(tx, orgId);

  const lines: Array<{ accountId: string; amountMinor: bigint; label: string }> = [];
  if (split.cgst > 0n) lines.push({ accountId: acc.cgst, amountMinor: split.cgst, label: "CGST" });
  if (split.sgst > 0n) lines.push({ accountId: acc.sgst, amountMinor: split.sgst, label: "SGST" });
  if (split.igst > 0n) lines.push({ accountId: acc.igst, amountMinor: split.igst, label: "IGST" });
  if (split.unsplit > 0n)
    lines.push({ accountId: acc.unsplit, amountMinor: split.unsplit, label: "GST" });
  return lines;
}
