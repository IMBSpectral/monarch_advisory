/**
 * GSTR-1 JSON export — the file a taxpayer uploads to the GST portal (or hands to
 * their GSP). This does NOT file anything; it produces the return document in the
 * GSTN offline-tool schema, derived from the period's posted invoices.
 *
 * Sections produced: b2b (supplies to registered customers, per invoice, rate-
 * wise), b2cs (B2C small, aggregated by place of supply + rate), and hsn (the HSN
 * summary). Amounts are in rupees (2 decimals), as the GST portal expects; place
 * of supply decides IGST vs CGST+SGST, exactly as the ledger posts.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";

/** Minor units (paise) → rupees rounded to 2 decimals, as a number. */
function rupees(minor: bigint): number {
  return Number(minor) / 100;
}

/** "2026-03-13" → "13-03-2026" (the portal's date format). */
function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

type LineRow = {
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  total_minor: string;
  ctin: string | null;
  pos: string | null;
  org_state: string | null;
  rate_bps: number;
  taxable: string;
  tax: string;
  hsn: string | null;
  description: string;
  uqc: string;
  quantity: string;
};

type ItmDet = {
  rt: number;
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
};

export type Gstr1Json = {
  gstin: string;
  fp: string; // return period MMYYYY
  gt: number; // gross turnover (period taxable value), indicative
  cur_gt: number;
  b2b: Array<{
    ctin: string;
    inv: Array<{
      inum: string;
      idt: string;
      val: number;
      pos: string;
      rchrg: "N";
      inv_typ: "R";
      itms: Array<{ num: number; itm_det: ItmDet }>;
    }>;
  }>;
  b2cs: Array<{
    sply_ty: "INTRA" | "INTER";
    typ: "OE";
    pos: string;
    rt: number;
    txval: number;
    iamt: number;
    camt: number;
    samt: number;
    csamt: number;
  }>;
  hsn: {
    data: Array<{
      num: number;
      hsn_sc: string;
      desc: string;
      uqc: string;
      qty: number;
      txval: number;
      iamt: number;
      camt: number;
      samt: number;
      csamt: number;
    }>;
  };
};

/** Split a line's tax into components given whether it's an intra-state supply. */
function split(tax: bigint, intra: boolean): { iamt: bigint; camt: bigint; samt: bigint } {
  if (!intra) return { iamt: tax, camt: 0n, samt: 0n };
  const camt = tax / 2n;
  return { iamt: 0n, camt, samt: tax - camt };
}

export async function buildGstr1Json(
  tx: DbOrTx,
  orgId: string,
  from: string,
  to: string,
): Promise<Gstr1Json> {
  const rows = (await tx.execute(sql`
    select
      i.id::text as invoice_id,
      i.invoice_number,
      i.invoice_date::text as invoice_date,
      i.total_minor::text as total_minor,
      c.tax_registration_number as ctin,
      coalesce(nullif(c.place_of_supply_code, ''), left(c.tax_registration_number, 2),
               left(o.tax_registration_number, 2)) as pos,
      left(o.tax_registration_number, 2) as org_state,
      coalesce(tr.rate_bps, 0) as rate_bps,
      il.line_total_minor::text as taxable,
      il.tax_amount_minor::text as tax,
      it.hsn_sac_code as hsn,
      coalesce(it.name, il.description) as description,
      coalesce(it.unit_of_measure, 'OTH') as uqc,
      il.quantity::text as quantity
    from invoice_lines il
    join invoices i      on i.id = il.invoice_id
    join contacts c      on c.id = i.contact_id
    join organizations o on o.id = i.org_id
    left join tax_rates tr on tr.id = il.tax_rate_id
    left join items it     on it.id = il.item_id
    where i.org_id = ${orgId}
      and i.journal_entry_id is not null
      and i.status <> 'void'
      and i.invoice_date between ${from} and ${to}
    order by i.invoice_number
  `)) as unknown as LineRow[];

  const [org] = (await tx.execute(
    sql`select tax_registration_number as gstin from organizations where id = ${orgId}`,
  )) as unknown as Array<{ gstin: string | null }>;

  // fp = MMYYYY of the period end.
  const [ey, em] = to.split("-");
  const fp = `${em}${ey}`;

  const isIntra = (r: LineRow) => !r.pos || r.pos === r.org_state;

  // ── b2b: registered customers, per invoice, rate-wise ─────────────────────
  const b2bByCtin = new Map<string, Map<string, LineRow[]>>();
  // ── b2cs: unregistered, aggregated by (place of supply, rate, intra/inter) ─
  const b2csAgg = new Map<
    string,
    { r: LineRow; taxable: bigint; iamt: bigint; camt: bigint; samt: bigint }
  >();
  // ── hsn: by code + rate ───────────────────────────────────────────────────
  const hsnAgg = new Map<
    string,
    { r: LineRow; qty: number; taxable: bigint; iamt: bigint; camt: bigint; samt: bigint }
  >();
  let grossTaxable = 0n;

  for (const r of rows) {
    grossTaxable += BigInt(r.taxable);
    const comp = split(BigInt(r.tax), isIntra(r));

    if (r.ctin) {
      if (!b2bByCtin.has(r.ctin)) b2bByCtin.set(r.ctin, new Map());
      const byInv = b2bByCtin.get(r.ctin)!;
      if (!byInv.has(r.invoice_id)) byInv.set(r.invoice_id, []);
      byInv.get(r.invoice_id)!.push(r);
    } else {
      const key = `${r.pos}|${r.rate_bps}|${isIntra(r) ? "I" : "X"}`;
      const cur = b2csAgg.get(key) ?? { r, taxable: 0n, iamt: 0n, camt: 0n, samt: 0n };
      cur.taxable += BigInt(r.taxable);
      cur.iamt += comp.iamt;
      cur.camt += comp.camt;
      cur.samt += comp.samt;
      b2csAgg.set(key, cur);
    }

    const hsnKey = `${r.hsn ?? "—"}|${r.rate_bps}`;
    const h = hsnAgg.get(hsnKey) ?? { r, qty: 0, taxable: 0n, iamt: 0n, camt: 0n, samt: 0n };
    h.qty += Number(r.quantity);
    h.taxable += BigInt(r.taxable);
    h.iamt += comp.iamt;
    h.camt += comp.camt;
    h.samt += comp.samt;
    hsnAgg.set(hsnKey, h);
  }

  const b2b = [...b2bByCtin.entries()].map(([ctin, byInv]) => ({
    ctin,
    inv: [...byInv.values()].map((lines) => {
      const first = lines[0];
      // Group the invoice's lines by rate into itms.
      const byRate = new Map<number, LineRow[]>();
      for (const l of lines) {
        if (!byRate.has(l.rate_bps)) byRate.set(l.rate_bps, []);
        byRate.get(l.rate_bps)!.push(l);
      }
      const itms = [...byRate.entries()].map(([rateBps, ls], idx) => {
        const taxable = ls.reduce((s, l) => s + BigInt(l.taxable), 0n);
        const tax = ls.reduce((s, l) => s + BigInt(l.tax), 0n);
        const comp = split(tax, isIntra(first));
        return {
          num: idx + 1,
          itm_det: {
            rt: rateBps / 100,
            txval: rupees(taxable),
            iamt: rupees(comp.iamt),
            camt: rupees(comp.camt),
            samt: rupees(comp.samt),
            csamt: 0,
          },
        };
      });
      return {
        inum: first.invoice_number,
        idt: ddmmyyyy(first.invoice_date),
        val: rupees(BigInt(first.total_minor)),
        pos: first.pos ?? first.org_state ?? "",
        rchrg: "N" as const,
        inv_typ: "R" as const,
        itms,
      };
    }),
  }));

  const b2cs = [...b2csAgg.values()].map((v) => ({
    sply_ty: (isIntra(v.r) ? "INTRA" : "INTER") as "INTRA" | "INTER",
    typ: "OE" as const,
    pos: v.r.pos ?? v.r.org_state ?? "",
    rt: v.r.rate_bps / 100,
    txval: rupees(v.taxable),
    iamt: rupees(v.iamt),
    camt: rupees(v.camt),
    samt: rupees(v.samt),
    csamt: 0,
  }));

  const hsn = {
    data: [...hsnAgg.values()].map((h, idx) => ({
      num: idx + 1,
      hsn_sc: h.r.hsn ?? "",
      desc: h.r.description,
      uqc: h.r.uqc,
      qty: h.qty,
      txval: rupees(h.taxable),
      iamt: rupees(h.iamt),
      camt: rupees(h.camt),
      samt: rupees(h.samt),
      csamt: 0,
    })),
  };

  return {
    gstin: org?.gstin ?? "",
    fp,
    gt: rupees(grossTaxable),
    cur_gt: rupees(grossTaxable),
    b2b,
    b2cs,
    hsn,
  };
}
