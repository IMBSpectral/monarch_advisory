/**
 * Integration test for GST slice 4 — the GSTR-1 detail (rate-wise outward
 * supplies + HSN/SAC summary). Runs against the seeded books (read-only) and
 * checks the reports are internally consistent: each rate's CGST+SGST+IGST equals
 * its total tax, the intra split is 50/50 to the paisa, HSN codes are present, and
 * the two views (rate-wise and HSN) agree on the total tax since both derive from
 * the same invoice lines.
 *
 *   MONARCH_DB_ROLE=admin bun --env-file=.env src/db/test-gstr1.ts
 */
import { db, pgClient, withOrg } from "./client";
import { organizations } from "./schema";
import { getGstr1RateWise, getHsnSummary } from "@/server/reports";
import { stateCodeOf } from "@/lib/gst";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

async function main() {
  const orgs = await db
    .select({ id: organizations.id, gstin: organizations.taxRegistrationNumber })
    .from(organizations);
  const org = orgs.find((o) => stateCodeOf(o.gstin) !== null);
  if (!org) throw new Error("No GST-registered org — run db:seed first.");
  const orgId = org.id;
  const FROM = "2020-01-01";
  const TO = "2030-12-31";

  const rateWise = await withOrg(orgId, (tx) => getGstr1RateWise(tx, orgId, FROM, TO));
  const hsn = await withOrg(orgId, (tx) => getHsnSummary(tx, orgId, FROM, TO));

  check("rate-wise has at least one row", rateWise.length > 0);
  check(
    "each rate's CGST + SGST + IGST equals its total tax",
    rateWise.every((r) => r.cgstMinor + r.sgstMinor + r.igstMinor === r.totalTaxMinor),
  );

  const gst18 = rateWise.find((r) => r.rateBps === 1800);
  check("there is a GST 18% row with a taxable value", !!gst18 && gst18.taxableMinor > 0n);
  check(
    "GST 18% CGST and SGST are equal within a paisa",
    !!gst18 &&
      (gst18.sgstMinor - gst18.cgstMinor === 0n || gst18.sgstMinor - gst18.cgstMinor === 1n),
  );

  check("HSN summary has rows", hsn.length > 0);
  check(
    "at least one line carries a real HSN code",
    hsn.some((h) => h.hsn !== "—"),
  );

  const rateTax = rateWise.reduce((s, r) => s + r.totalTaxMinor, 0n);
  const hsnTax = hsn.reduce((s, h) => s + h.taxMinor, 0n);
  check("rate-wise total tax equals HSN total tax (same source lines)", rateTax === hsnTax);

  const rateTaxable = rateWise.reduce((s, r) => s + r.taxableMinor, 0n);
  const hsnTaxable = hsn.reduce((s, h) => s + h.taxableMinor, 0n);
  check("rate-wise taxable value equals HSN taxable value", rateTaxable === hsnTaxable);

  console.log(`\n${failures === 0 ? "All GSTR-1 checks passed." : `${failures} check(s) FAILED.`}`);
  await pgClient.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
