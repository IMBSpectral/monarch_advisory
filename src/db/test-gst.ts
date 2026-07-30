/**
 * Integration test for the GST engine (E3 slices 1-2) — place-of-supply split of
 * BOTH output tax (invoices) and input tax / ITC (bills). Proves an intra-state
 * transaction posts CGST + SGST (half each, summing to the tax) and an inter-state
 * one posts IGST (the whole amount), on both the sales and purchase sides.
 *
 *   MONARCH_DB_ROLE=admin bun --env-file=.env src/db/test-gst.ts
 */
import { and, eq, inArray, ne, isNotNull, like, notLike } from "drizzle-orm";
import { db, pgClient, withOrg } from "./client";
import {
  accounts,
  billLines,
  bills,
  contacts,
  invoiceLines,
  invoices,
  journalEntries,
  journalLines,
  organizations,
  taxRates,
} from "./schema";
import { createInvoice, postInvoice } from "@/server/invoicing";
import { createBill, postBill } from "@/server/bills";
import { stateCodeOf } from "@/lib/gst";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

async function main() {
  // The org must be GST-registered (have a GSTIN) so a split is meaningful.
  const orgs = await db
    .select({ id: organizations.id, gstin: organizations.taxRegistrationNumber })
    .from(organizations);
  const org = orgs.find((o) => stateCodeOf(o.gstin) !== null);
  if (!org) throw new Error("No GST-registered org — run db:seed first.");
  const orgId = org.id;
  const orgState = stateCodeOf(org.gstin)!;

  const [rate] = await withOrg(orgId, (tx) =>
    tx
      .select({ id: taxRates.id })
      .from(taxRates)
      .where(and(eq(taxRates.orgId, orgId), eq(taxRates.rateBps, 1800)))
      .limit(1),
  );
  if (!rate) throw new Error("No GST 18% rate found.");

  const [intra] = await withOrg(orgId, (tx) =>
    tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.placeOfSupplyCode, orgState)))
      .limit(1),
  );
  const [inter] = await withOrg(orgId, (tx) =>
    tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.orgId, orgId),
          isNotNull(contacts.placeOfSupplyCode),
          ne(contacts.placeOfSupplyCode, orgState),
        ),
      )
      .limit(1),
  );
  if (!intra || !inter) throw new Error("Need one intra-state and one inter-state customer.");

  const acct = await withOrg(orgId, (tx) =>
    tx
      .select({ code: accounts.code, id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), inArray(accounts.code, ["2201", "2202", "2203"]))),
  );
  const idByCode = new Map(acct.map((a) => [a.code, a.id]));
  const cgstId = idByCode.get("2201")!;
  const sgstId = idByCode.get("2202")!;
  const igstId = idByCode.get("2203")!;

  // Vendors for the input side: one in-state (intra), one out-of-state (inter).
  const [intraVendor] = await withOrg(orgId, (tx) =>
    tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.orgId, orgId),
          inArray(contacts.type, ["vendor", "both"]),
          like(contacts.taxRegistrationNumber, `${orgState}%`),
        ),
      )
      .limit(1),
  );
  const [interVendor] = await withOrg(orgId, (tx) =>
    tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.orgId, orgId),
          inArray(contacts.type, ["vendor", "both"]),
          isNotNull(contacts.taxRegistrationNumber),
          notLike(contacts.taxRegistrationNumber, `${orgState}%`),
        ),
      )
      .limit(1),
  );
  const inAcct = await withOrg(orgId, (tx) =>
    tx
      .select({ code: accounts.code, id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), inArray(accounts.code, ["1141", "1142", "1143"]))),
  );
  const inByCode = new Map(inAcct.map((a) => [a.code, a.id]));
  const inCgstId = inByCode.get("1141")!;
  const inSgstId = inByCode.get("1142")!;
  const inIgstId = inByCode.get("1143")!;

  const madeInvoices: string[] = [];
  const madeBills: string[] = [];
  const madeEntries: string[] = [];

  async function sell(contactId: string) {
    const inv = await createInvoice({
      orgId,
      contactId,
      invoiceDate: "2026-03-22",
      dueDate: "2026-04-22",
      lines: [
        {
          description: "TEST GST line",
          quantity: "1",
          unitPriceMinor: 100_000n,
          taxRateId: rate.id,
        },
      ],
    });
    const entry = await postInvoice({ orgId, invoiceId: inv.invoiceId });
    madeInvoices.push(inv.invoiceId);
    madeEntries.push(entry.entryId);
    const lines = await withOrg(orgId, (tx) =>
      tx
        .select({ accountId: journalLines.accountId, amountMinor: journalLines.amountMinor })
        .from(journalLines)
        .where(eq(journalLines.entryId, entry.entryId)),
    );
    const amountOn = (id: string) =>
      lines.filter((l) => l.accountId === id).reduce((s, l) => s + l.amountMinor, 0n);
    return {
      tax: inv.totalMinor - 100_000n,
      cgst: amountOn(cgstId),
      sgst: amountOn(sgstId),
      igst: amountOn(igstId),
    };
  }

  async function buy(contactId: string) {
    const bill = await createBill({
      orgId,
      contactId,
      billDate: "2026-03-22",
      dueDate: "2026-04-22",
      lines: [
        {
          description: "TEST GST purchase",
          quantity: "1",
          unitPriceMinor: 100_000n,
          taxRateId: rate.id,
        },
      ],
    });
    const entry = await postBill({ orgId, billId: bill.billId });
    madeBills.push(bill.billId);
    madeEntries.push(entry.entryId);
    const lines = await withOrg(orgId, (tx) =>
      tx
        .select({ accountId: journalLines.accountId, amountMinor: journalLines.amountMinor })
        .from(journalLines)
        .where(eq(journalLines.entryId, entry.entryId)),
    );
    const amountOn = (id: string) =>
      lines.filter((l) => l.accountId === id).reduce((s, l) => s + l.amountMinor, 0n);
    return {
      tax: bill.totalMinor - 100_000n,
      cgst: amountOn(inCgstId),
      sgst: amountOn(inSgstId),
      igst: amountOn(inIgstId),
    };
  }

  try {
    // Tax on ₹1,000 @ 18% = ₹180 = 18000 paise.
    const i = await sell(intra.id);
    check("intra-state: tax is ₹180", i.tax === 18_000n);
    check(
      "intra-state: CGST + SGST are credited (negative), IGST is not",
      i.cgst < 0n && i.sgst < 0n && i.igst === 0n,
    );
    check("intra-state: CGST + SGST sum to the full tax", -(i.cgst + i.sgst) === i.tax);
    check(
      "intra-state: halves are equal within a paisa",
      i.sgst - i.cgst === 0n || i.sgst - i.cgst === -1n,
    );

    const e = await sell(inter.id);
    check(
      "inter-state: IGST takes the whole tax, CGST/SGST untouched",
      e.igst === -e.tax && e.cgst === 0n && e.sgst === 0n,
    );

    // ── Input side (bills / ITC) ──────────────────────────────────────────────
    if (!intraVendor || !interVendor) {
      throw new Error("Need one in-state and one out-of-state vendor with a GSTIN.");
    }
    const bi = await buy(intraVendor.id);
    check(
      "input intra: Input CGST + SGST debited (positive), IGST not",
      bi.cgst > 0n && bi.sgst > 0n && bi.igst === 0n,
    );
    check("input intra: Input CGST + SGST sum to the full ITC", bi.cgst + bi.sgst === bi.tax);

    const be = await buy(interVendor.id);
    check(
      "input inter: Input IGST takes the whole ITC, CGST/SGST untouched",
      be.igst === be.tax && be.cgst === 0n && be.sgst === 0n,
    );
  } finally {
    await withOrg(orgId, async (tx) => {
      if (madeInvoices.length) {
        await tx.delete(invoiceLines).where(inArray(invoiceLines.invoiceId, madeInvoices));
        await tx.delete(invoices).where(inArray(invoices.id, madeInvoices));
      }
      if (madeBills.length) {
        await tx.delete(billLines).where(inArray(billLines.billId, madeBills));
        await tx.delete(bills).where(inArray(bills.id, madeBills));
      }
      if (madeEntries.length) {
        await tx.delete(journalLines).where(inArray(journalLines.entryId, madeEntries));
        await tx.delete(journalEntries).where(inArray(journalEntries.id, madeEntries));
      }
    });
  }

  console.log(`\n${failures === 0 ? "All GST checks passed." : `${failures} check(s) FAILED.`}`);
  await pgClient.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
