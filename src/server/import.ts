/**
 * CSV master-data import — the row-by-row logic, independent of the request so it
 * can be unit-tested directly. Each row is validated and created on its own: a bad
 * row becomes an error in the report rather than aborting the file, and a row that
 * already exists (same name/email, or same SKU) is skipped, so re-running a file
 * only adds what's new.
 */
import { eq } from "drizzle-orm";
import { withOrg } from "@/db/client";
import { contacts, items } from "@/db/schema";
import { createContact, createItem } from "./entities";
import { parseDecimalToScaled } from "@/lib/decimal";

export type ImportResult = {
  total: number;
  created: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
};

export type CsvRow = Record<string, string>;

/** First non-empty value among the given header aliases. */
function firstOf(r: CsvRow, keys: string[]): string {
  for (const k of keys) {
    const v = r[k];
    if (v != null && v.trim() !== "") return v.trim();
  }
  return "";
}

/** Rupees (optionally with thousands separators) → paise, or null when blank. */
function parseMoney(s: string): bigint | null {
  const t = s.replace(/,/g, "").trim();
  if (t === "") return null;
  return parseDecimalToScaled(t, 2);
}

const TRUTHY = new Set(["yes", "y", "true", "1", "tracked"]);

export async function importContacts(
  orgId: string,
  rows: CsvRow[],
  userId?: string | null,
): Promise<ImportResult> {
  const result: ImportResult = { total: rows.length, created: 0, skipped: 0, errors: [] };

  const existing = await withOrg(orgId, (tx) =>
    tx
      .select({ name: contacts.displayName, email: contacts.email })
      .from(contacts)
      .where(eq(contacts.orgId, orgId)),
  );
  const names = new Set(existing.map((e) => e.name.toLowerCase()));
  const emails = new Set(existing.filter((e) => e.email).map((e) => e.email!.toLowerCase()));

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 2; // header is line 1
    try {
      const name = firstOf(r, [
        "name",
        "displayname",
        "display name",
        "contact",
        "company",
        "company name",
      ]);
      if (!name) {
        result.errors.push({ row: line, message: "Missing name." });
        continue;
      }
      const email = firstOf(r, ["email"]).toLowerCase() || null;
      if (names.has(name.toLowerCase()) || (email && emails.has(email))) {
        result.skipped++;
        continue;
      }

      const typeRaw = firstOf(r, ["type"]).toLowerCase();
      const type =
        typeRaw === "vendor" || typeRaw === "supplier"
          ? "vendor"
          : typeRaw === "both"
            ? "both"
            : "customer";

      const termsRaw = firstOf(r, ["paymentterms", "payment terms", "terms", "paymenttermdays"]);
      let paymentTermDays: number | undefined;
      if (termsRaw) {
        const n = Number(termsRaw);
        if (!Number.isInteger(n) || n < 0) {
          result.errors.push({ row: line, message: `Invalid payment terms "${termsRaw}".` });
          continue;
        }
        paymentTermDays = n;
      }

      await createContact(
        orgId,
        {
          displayName: name,
          type,
          legalName: firstOf(r, ["legalname", "legal name"]) || null,
          email,
          phone: firstOf(r, ["phone", "mobile"]) || null,
          taxRegistrationNumber:
            firstOf(r, ["gstin", "gst", "gst no", "gstno", "gst number", "taxid", "tax id"]) ||
            null,
          paymentTermDays,
          notes: firstOf(r, ["notes", "note", "address", "billingaddress"]) || null,
        },
        userId,
      );
      names.add(name.toLowerCase());
      if (email) emails.add(email);
      result.created++;
    } catch (e) {
      result.errors.push({ row: line, message: e instanceof Error ? e.message : "Failed." });
    }
  }
  return result;
}

export async function importItems(
  orgId: string,
  rows: CsvRow[],
  userId?: string | null,
): Promise<ImportResult> {
  const result: ImportResult = { total: rows.length, created: 0, skipped: 0, errors: [] };

  const existing = await withOrg(orgId, (tx) =>
    tx.select({ name: items.name, sku: items.sku }).from(items).where(eq(items.orgId, orgId)),
  );
  const names = new Set(existing.map((e) => e.name.toLowerCase()));
  const skus = new Set(existing.filter((e) => e.sku).map((e) => e.sku!.toLowerCase()));

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 2;
    try {
      const name = firstOf(r, ["name", "item", "itemname", "item name"]);
      if (!name) {
        result.errors.push({ row: line, message: "Missing name." });
        continue;
      }
      const sku = firstOf(r, ["sku", "code"]) || null;
      // Dedup by SKU when present (it's uniquely indexed), else by name.
      if (sku ? skus.has(sku.toLowerCase()) : names.has(name.toLowerCase())) {
        result.skipped++;
        continue;
      }

      const salePriceMinor = parseMoney(
        firstOf(r, ["saleprice", "sale price", "price", "sellingprice"]),
      );
      const purchasePriceMinor = parseMoney(
        firstOf(r, ["purchaseprice", "purchase price", "cost", "buyprice"]),
      );
      const tracked = TRUTHY.has(
        firstOf(r, ["tracked", "inventory", "istracked", "inventorytracked"]).toLowerCase(),
      );

      await createItem(
        orgId,
        {
          name,
          sku,
          isInventoryTracked: tracked,
          unitOfMeasure: firstOf(r, ["uom", "unit", "unitofmeasure"]) || undefined,
          salePriceMinor,
          purchasePriceMinor,
          hsnSacCode: firstOf(r, ["hsn", "hsnsac", "hsn/sac", "hsncode"]) || null,
        },
        userId,
      );
      names.add(name.toLowerCase());
      if (sku) skus.add(sku.toLowerCase());
      result.created++;
    } catch (e) {
      result.errors.push({ row: line, message: e instanceof Error ? e.message : "Failed." });
    }
  }
  return result;
}
