/**
 * GST place-of-supply and CGST/SGST/IGST determination — the pure rules, no DB.
 *
 * India splits a single GST rate into components based on WHERE the supply
 * happens relative to the supplier:
 *   • intra-state (place of supply == supplier's state) → CGST + SGST, half each
 *   • inter-state (different states)                    → IGST, the whole amount
 *
 * The state is the first two digits of a 15-char GSTIN. When the supplier isn't
 * GST-registered we can't split at all ("unregistered" → post as a single amount,
 * preserving the pre-engine behaviour); when the customer's state is unknown we
 * assume intra-state (the common same-state B2C case).
 */

export type GstTreatment = "intra" | "inter" | "unregistered";

/** The two-digit state code from a GSTIN, or null if it isn't a valid prefix. */
export function stateCodeOf(gstin: string | null | undefined): string | null {
  if (!gstin) return null;
  const code = gstin.trim().slice(0, 2);
  return /^\d{2}$/.test(code) ? code : null;
}

/**
 * Decide how to split GST given the supplier's state and the place of supply
 * (both two-digit state codes; either may be null).
 */
export function determineGstTreatment(
  supplierState: string | null,
  placeOfSupply: string | null,
): GstTreatment {
  if (!supplierState) return "unregistered";
  if (!placeOfSupply) return "intra";
  return placeOfSupply === supplierState ? "intra" : "inter";
}

/**
 * Split a total tax amount into components. CGST takes the floor of half and
 * SGST the remainder, so the two always sum back to the exact total (no lost
 * paisa on an odd amount). `unsplit` carries the amount when the supplier isn't
 * GST-registered.
 */
export function splitGst(
  taxTotalMinor: bigint,
  treatment: GstTreatment,
): { cgst: bigint; sgst: bigint; igst: bigint; unsplit: bigint } {
  if (treatment === "inter") return { cgst: 0n, sgst: 0n, igst: taxTotalMinor, unsplit: 0n };
  if (treatment === "unregistered") return { cgst: 0n, sgst: 0n, igst: 0n, unsplit: taxTotalMinor };
  const cgst = taxTotalMinor / 2n;
  return { cgst, sgst: taxTotalMinor - cgst, igst: 0n, unsplit: 0n };
}
