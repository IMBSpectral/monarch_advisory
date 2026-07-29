/**
 * Integration test for POS checkout atomicity. Proves the fix for the orphaned-
 * draft bug: a checkout that can't be fulfilled (out of stock) now fails BEFORE
 * any invoice is created, so it leaves no draft behind and burns no invoice
 * number. Also proves the pre-flight doesn't over-block a valid sale, and that a
 * normal in-stock sale still completes end-to-end.
 *
 *   MONARCH_DB_ROLE=admin bun --env-file=.env src/db/test-pos.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { db, pgClient, withOrg } from "./client";
import {
  documentSequences,
  invoiceLines,
  invoices,
  journalEntries,
  journalLines,
  paymentAllocations,
  payments,
  stockMovements,
} from "./schema";
import { posCheckout } from "@/server/pos";
import { assertStockAvailable, getDefaultWarehouseId, toScaledQty } from "@/server/inventory";
import { LedgerError } from "@/server/ledger";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

async function invoiceSeqNext(orgId: string): Promise<bigint | null> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ n: documentSequences.nextNumber })
      .from(documentSequences)
      .where(
        and(eq(documentSequences.orgId, orgId), eq(documentSequences.documentType, "invoice")),
      ),
  );
  return row?.n ?? null;
}

async function invoiceCount(orgId: string): Promise<number> {
  const [row] = (await withOrg(orgId, (tx) =>
    tx.execute(sql`select count(*)::int as n from invoices where org_id = ${orgId}`),
  )) as unknown as Array<{ n: number }>;
  return row?.n ?? 0;
}

async function main() {
  // A tracked item that currently has stock, and the org it belongs to.
  const [pickd] = (await db.execute(sql`
    select i.org_id, i.id as item_id, l.on_hand_qty
    from items i
    join item_stock_levels l on l.item_id = i.id
    where i.is_inventory_tracked = true and l.on_hand_qty::numeric > 0
    order by l.on_hand_qty::numeric desc
    limit 1
  `)) as unknown as Array<{ org_id: string; item_id: string; on_hand_qty: string }>;
  if (!pickd) throw new Error("No tracked item with stock — run db:seed first.");
  const orgId = pickd.org_id;
  const itemId = pickd.item_id;
  const warehouseId = await withOrg(orgId, (tx) => getDefaultWarehouseId(tx, orgId));

  // ── Test 1: an out-of-stock checkout fails and leaves nothing behind ───────
  const seqBefore = await invoiceSeqNext(orgId);
  const countBefore = await invoiceCount(orgId);
  let threw = false;
  try {
    await posCheckout({
      orgId,
      saleDate: "2026-03-20",
      method: "Cash",
      lines: [
        {
          itemId,
          description: "TEST POS oversell",
          quantity: "100000", // far more than any seeded stock
          unitPriceMinor: 10_000n,
        },
      ],
    });
  } catch (e) {
    threw = e instanceof LedgerError && e.code === "INSUFFICIENT_STOCK";
  }
  check("an out-of-stock checkout throws INSUFFICIENT_STOCK", threw);
  check(
    "no invoice is created by the failed checkout",
    (await invoiceCount(orgId)) === countBefore,
  );
  check("the invoice number is not burned", (await invoiceSeqNext(orgId)) === seqBefore);

  // ── Test 2: the pre-flight allows a valid (in-stock) quantity ─────────────
  let allowed = true;
  try {
    await withOrg(orgId, (tx) =>
      assertStockAvailable(tx, orgId, warehouseId, [{ itemId, qtyScaled: toScaledQty("1") }]),
    );
  } catch {
    allowed = false;
  }
  check("the pre-flight allows an in-stock quantity", allowed);

  // ── Test 3: a normal in-stock sale completes end-to-end ───────────────────
  const res = await posCheckout({
    orgId,
    saleDate: "2026-03-20",
    method: "Cash",
    lines: [{ itemId, description: "TEST POS sale", quantity: "1", unitPriceMinor: 10_000n }],
  });
  check("an in-stock POS sale completes", typeof res.invoiceNumber === "string");
  const [inv] = await withOrg(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.invoiceNumber, res.invoiceNumber)),
  );
  check("the POS invoice is fully paid", !!inv && inv.status === "paid");

  if (inv) await cleanupSale(orgId, inv.id, inv.journalEntryId);

  console.log(`\n${failures === 0 ? "All POS checks passed." : `${failures} check(s) FAILED.`}`);
  await pgClient.end();
  process.exit(failures === 0 ? 0 : 1);
}

/** Reverse the one successful test sale: payment, invoice, entries, and stock. */
async function cleanupSale(orgId: string, invoiceId: string, issueEntryId: string | null) {
  await withOrg(orgId, async (tx) => {
    // The settling payment (found via its allocation to this invoice).
    const pays = await tx
      .select({ id: payments.id, entryId: payments.journalEntryId })
      .from(payments)
      .innerJoin(paymentAllocations, eq(paymentAllocations.paymentId, payments.id))
      .where(and(eq(payments.orgId, orgId), eq(paymentAllocations.invoiceId, invoiceId)));

    // Restore stock: the sale wrote a negative movement; add it back, then drop it.
    const moves = await tx
      .select({
        id: stockMovements.id,
        itemId: stockMovements.itemId,
        warehouseId: stockMovements.warehouseId,
        quantity: stockMovements.quantity,
        valueMinor: stockMovements.valueMinor,
      })
      .from(stockMovements)
      .where(and(eq(stockMovements.orgId, orgId), eq(stockMovements.sourceDocumentId, invoiceId)));
    for (const m of moves) {
      await tx.execute(sql`
        update item_stock_levels
        set on_hand_qty = on_hand_qty - ${m.quantity}::numeric,
            value_minor = value_minor - ${m.valueMinor},
            updated_at = now()
        where org_id = ${orgId} and item_id = ${m.itemId} and warehouse_id = ${m.warehouseId}
      `);
    }
    if (moves.length) {
      await tx.delete(stockMovements).where(eq(stockMovements.sourceDocumentId, invoiceId));
    }

    // Payment rows + their journal entry.
    for (const p of pays) {
      await tx.delete(paymentAllocations).where(eq(paymentAllocations.paymentId, p.id));
      await tx.delete(payments).where(eq(payments.id, p.id));
      if (p.entryId) {
        await tx.delete(journalLines).where(eq(journalLines.entryId, p.entryId));
        await tx.delete(journalEntries).where(eq(journalEntries.id, p.entryId));
      }
    }

    // Invoice + its issue journal entry.
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    await tx.delete(invoices).where(eq(invoices.id, invoiceId));
    if (issueEntryId) {
      await tx.delete(journalLines).where(eq(journalLines.entryId, issueEntryId));
      await tx.delete(journalEntries).where(eq(journalEntries.id, issueEntryId));
    }
  });
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
