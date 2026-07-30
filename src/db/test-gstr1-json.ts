/**
 * Integration test for the GSTR-1 JSON export (GST slice 4b). Builds the return
 * from the seeded books and checks it's a well-formed, internally-consistent GSTN
 * document: b2b + b2cs sections present, every invoice's line items split cleanly
 * into IGST xor CGST+SGST, and the taxable value reconciles across the b2b/b2cs
 * detail, the HSN summary, and the gross-turnover header.
 *
 *   MONARCH_DB_ROLE=admin bun --env-file=.env src/db/test-gstr1-json.ts
 */
import { db, pgClient, withOrg } from "./client";
import { organizations } from "./schema";
import { buildGstr1Json } from "@/server/gst-return";
import { stateCodeOf } from "@/lib/gst";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const orgs = await db
    .select({ id: organizations.id, gstin: organizations.taxRegistrationNumber })
    .from(organizations);
  const org = orgs.find((o) => stateCodeOf(o.gstin) !== null);
  if (!org) throw new Error("No GST-registered org — run db:seed first.");

  const j = await withOrg(org.id, (tx) => buildGstr1Json(tx, org.id, "2020-01-01", "2030-12-31"));

  check("gstin is the org's GSTIN", j.gstin === org.gstin);
  check("fp is a 6-digit MMYYYY period", /^\d{6}$/.test(j.fp));
  check("b2b (registered customers) is present", j.b2b.length > 0);
  check("b2cs (unregistered) is present", j.b2cs.length > 0);
  check("hsn summary is present", j.hsn.data.length > 0);

  // Every b2b line item splits cleanly: IGST (inter) XOR CGST+SGST (intra).
  const cleanSplit = j.b2b.every((c) =>
    c.inv.every((inv) =>
      inv.itms.every((it) => {
        const inter = it.itm_det.iamt > 0 && it.itm_det.camt === 0 && it.itm_det.samt === 0;
        const intra = it.itm_det.iamt === 0 && it.itm_det.camt >= 0 && it.itm_det.samt >= 0;
        return inter || intra;
      }),
    ),
  );
  check("every b2b line item is IGST xor CGST+SGST", cleanSplit);

  // Each b2b invoice's value = its taxable + tax across all items.
  const invValuesOk = j.b2b.every((c) =>
    c.inv.every((inv) => {
      const taxable = inv.itms.reduce((s, it) => s + it.itm_det.txval, 0);
      const tax = inv.itms.reduce(
        (s, it) => s + it.itm_det.iamt + it.itm_det.camt + it.itm_det.samt,
        0,
      );
      return round2(taxable + tax) === round2(inv.val);
    }),
  );
  check("each b2b invoice value equals taxable + tax", invValuesOk);

  // Taxable value reconciles across the three views.
  let detailTaxable = 0;
  for (const c of j.b2b)
    for (const inv of c.inv) for (const it of inv.itms) detailTaxable += it.itm_det.txval;
  for (const b of j.b2cs) detailTaxable += b.txval;
  const hsnTaxable = j.hsn.data.reduce((s, h) => s + h.txval, 0);

  check("b2b + b2cs taxable equals gross turnover", round2(detailTaxable) === round2(j.gt));
  check("HSN taxable equals gross turnover", round2(hsnTaxable) === round2(j.gt));

  console.log(
    `\n${failures === 0 ? "All GSTR-1 JSON checks passed." : `${failures} check(s) FAILED.`}`,
  );
  await pgClient.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
