/**
 * Integration test for CSV master-data import (contacts + items). Drives the real
 * parse → import pipeline against a seeded DB, proving: valid rows are created,
 * bad rows become errors (without aborting the batch), duplicates are skipped,
 * re-running the same file adds nothing, header aliases resolve, and prices parse
 * to paise.
 *
 *   MONARCH_DB_ROLE=admin bun --env-file=.env src/db/test-import.ts
 */
import { and, eq, like } from "drizzle-orm";
import { db, pgClient, withOrg } from "./client";
import { contacts, items, organizations } from "./schema";
import { parseCsv } from "@/lib/csv";
import { importContacts, importItems } from "@/server/import";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

const MARK = "ZZTEST";

async function main() {
  const [org] = await db.select({ id: organizations.id }).from(organizations).limit(1);
  if (!org) throw new Error("No organization found — run db:seed first.");
  const orgId = org.id;

  try {
    // ── Contacts: a good row, a duplicate, and a bad row in one file ─────────
    // Aliases exercised: "Company Name" → name, "GST No" → gstin, "Terms" → terms.
    const contactsCsv = [
      "Company Name,type,email,phone,GST No,Terms",
      `${MARK} Traders,vendor,zz@test.example,9990001111,29ABCDE1234F1Z5,45`,
      `${MARK} Traders,vendor,zz@test.example,,,`, // duplicate name + email
      `,customer,noname@test.example,,,`, // missing name → error
    ].join("\n");
    const contactRows = parseCsv(contactsCsv);
    check("CSV parses to the expected row count", contactRows.length === 3);
    check("header 'Company Name' aliases to name", contactRows[0].name === undefined); // no 'name' header

    const cRes = await importContacts(orgId, contactRows, null);
    check(
      "one contact created, one skipped as dup, one errored",
      cRes.created === 1 && cRes.skipped === 1 && cRes.errors.length === 1,
    );
    check("the error names the right line (line 4)", cRes.errors[0].row === 4);

    const [saved] = await withOrg(orgId, (tx) =>
      tx
        .select({ terms: contacts.paymentTermDays, gstin: contacts.taxRegistrationNumber })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), eq(contacts.displayName, `${MARK} Traders`))),
    );
    check(
      "contact fields persisted via aliases (Terms=45, GST No)",
      saved?.terms === 45 && saved?.gstin === "29ABCDE1234F1Z5",
    );

    // Re-running the same file adds nothing (idempotent by dedup).
    const cRes2 = await importContacts(orgId, contactRows, null);
    check(
      "re-import adds nothing (idempotent by dedup)",
      cRes2.created === 0 && cRes2.skipped === 2,
    );

    // ── Items: price → paise, tracked flag, duplicate SKU skipped ────────────
    const itemsCsv = [
      "name,sku,Sale Price,tracked",
      `${MARK} Widget,${MARK}-SKU-1,"1,250.50",yes`,
      `${MARK} Widget Two,${MARK}-SKU-1,99,no`, // duplicate SKU → skipped
      `${MARK} Bad Price,${MARK}-SKU-2,not-a-number,no`, // bad price → error
    ].join("\n");
    const itemRows = parseCsv(itemsCsv);
    const iRes = await importItems(orgId, itemRows, null);
    check(
      "one item created, dup SKU skipped, bad price errored",
      iRes.created === 1 && iRes.skipped === 1 && iRes.errors.length === 1,
    );

    const [item] = await withOrg(orgId, (tx) =>
      tx
        .select({ price: items.salePriceMinor, tracked: items.isInventoryTracked })
        .from(items)
        .where(and(eq(items.orgId, orgId), eq(items.sku, `${MARK}-SKU-1`))),
    );
    check("₹1,250.50 parsed to 125050 paise", item?.price === 125050n);
    check("tracked=yes parsed to true", item?.tracked === true);
  } finally {
    await withOrg(orgId, async (tx) => {
      await tx
        .delete(contacts)
        .where(and(eq(contacts.orgId, orgId), like(contacts.displayName, `${MARK}%`)));
      await tx.delete(items).where(and(eq(items.orgId, orgId), like(items.name, `${MARK}%`)));
    });
  }

  console.log(`\n${failures === 0 ? "All import checks passed." : `${failures} check(s) FAILED.`}`);
  await pgClient.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
