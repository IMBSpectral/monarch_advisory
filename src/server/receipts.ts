/**
 * Goods receipts (GRN) and delivery notes — the goods legs that happen before
 * (or without) the money legs.
 *
 *   GRN            Dr Inventory / Cr GRNI     (stock in, vendor not yet billed)
 *   → its bill     Dr GRNI / Cr A/P           (clears GRNI, records the payable)
 *
 *   Delivery note  Dr COGS / Cr Inventory     (stock out, customer not yet invoiced)
 *   → its invoice  Dr A/R / Cr Revenue+Tax    (revenue only; stock already relieved)
 *
 * Each of the four posts a balanced journal entry, so the stock ledger and the
 * Inventory control account stay equal even while the money leg is deferred.
 */

import { and, eq } from "drizzle-orm";
import { withOrg } from "@/db/client";
import {
  bills,
  deliveryNoteLines,
  deliveryNotes,
  goodsReceiptLines,
  goodsReceipts,
  invoices,
} from "@/db/schema";
import {
  LedgerError,
  claimNextNumber,
  credit,
  debit,
  postJournalEntry,
  resolveControlAccount,
  writeAudit,
  type PostingLine,
} from "./ledger";
import {
  commitStockOut,
  getDefaultWarehouseId,
  getTrackedItem,
  planStockOut,
  receiveStock,
  type IssueRequest,
} from "./inventory";
import { createBill, postBill } from "./bills";
import { createInvoice, postInvoice } from "./invoicing";

function mulDivRound(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  const abs = amount < 0n ? -amount : amount;
  const scaled = abs * numerator;
  const q = scaled / denominator;
  const r = scaled % denominator;
  const rounded = r * 2n >= denominator ? q + 1n : q;
  return amount < 0n ? -rounded : rounded;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Goods receipts (GRN)
 * ──────────────────────────────────────────────────────────────────────────*/

export type GrnLine = {
  itemId: string;
  description: string;
  quantity: string;
  unitCostMinor: bigint;
  taxRateId?: string | null;
};

export async function createGoodsReceipt(input: {
  orgId: string;
  contactId: string;
  receiptDate: string;
  lines: GrnLine[];
  relatedPurchaseOrderId?: string | null;
  currency?: string;
  userId?: string | null;
}): Promise<{ goodsReceiptId: string; grnNumber: string; totalMinor: bigint }> {
  if (input.lines.length === 0)
    throw new LedgerError("A goods receipt needs at least one line.", "NO_LINES");

  return withOrg(input.orgId, async (tx) => {
    const total = input.lines.reduce(
      (a, l) =>
        a + mulDivRound(l.unitCostMinor, BigInt(Math.round(Number(l.quantity) * 10_000)), 10_000n),
      0n,
    );
    const grnNumber = await claimNextNumber(tx, input.orgId, "grn");
    const [grn] = await tx
      .insert(goodsReceipts)
      .values({
        orgId: input.orgId,
        contactId: input.contactId,
        grnNumber,
        relatedPurchaseOrderId: input.relatedPurchaseOrderId ?? null,
        receiptDate: input.receiptDate,
        status: "draft",
        currency: input.currency ?? "INR",
        totalMinor: total,
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: goodsReceipts.id });

    await tx.insert(goodsReceiptLines).values(
      input.lines.map((l, i) => ({
        orgId: input.orgId,
        goodsReceiptId: grn.id,
        lineNumber: i + 1,
        itemId: l.itemId,
        description: l.description,
        quantity: l.quantity,
        unitCostMinor: l.unitCostMinor,
        taxRateId: l.taxRateId ?? null,
      })),
    );

    return { goodsReceiptId: grn.id, grnNumber, totalMinor: total };
  });
}

export async function postGoodsReceipt(args: {
  orgId: string;
  goodsReceiptId: string;
  userId?: string | null;
}): Promise<{ entryId: string; entryNumber: string }> {
  return withOrg(args.orgId, async (tx) => {
    const [grn] = await tx
      .select()
      .from(goodsReceipts)
      .where(and(eq(goodsReceipts.id, args.goodsReceiptId), eq(goodsReceipts.orgId, args.orgId)));
    if (!grn)
      throw new LedgerError(`Goods receipt ${args.goodsReceiptId} not found.`, "GRN_NOT_FOUND");
    if (grn.status !== "draft")
      throw new LedgerError(`GRN ${grn.grnNumber} is ${grn.status}.`, "GRN_NOT_DRAFT");

    const lines = await tx
      .select()
      .from(goodsReceiptLines)
      .where(eq(goodsReceiptLines.goodsReceiptId, grn.id));
    const warehouseId = await getDefaultWarehouseId(tx, args.orgId);
    const inventoryAcct = await resolveControlAccount(tx, args.orgId, "inventory");
    const grniAcct = await resolveControlAccount(tx, args.orgId, "goods_received_clearing");

    const receipts = lines.map((l) => ({
      itemId: l.itemId,
      quantity: l.quantity,
      valueMinor: mulDivRound(
        l.unitCostMinor,
        BigInt(Math.round(Number(l.quantity) * 10_000)),
        10_000n,
      ),
    }));
    const total = receipts.reduce((a, r) => a + r.valueMinor, 0n);

    const entry = await postJournalEntry(
      {
        orgId: args.orgId,
        entryDate: grn.receiptDate,
        source: "bill",
        sourceDocumentId: grn.id,
        reference: grn.grnNumber,
        memo: `Goods receipt ${grn.grnNumber}`,
        userId: args.userId,
        lines: [
          debit(inventoryAcct, total, { memo: `Stock received — ${grn.grnNumber}` }),
          credit(grniAcct, total, { contactId: grn.contactId, memo: `GRNI — ${grn.grnNumber}` }),
        ],
      },
      tx,
    );

    for (const r of receipts) {
      await receiveStock(tx, {
        orgId: args.orgId,
        itemId: r.itemId,
        warehouseId,
        moveDate: grn.receiptDate,
        quantity: r.quantity,
        valueMinor: r.valueMinor,
        source: "purchase",
        sourceDocumentId: grn.id,
        jeId: entry.entryId,
        userId: args.userId,
      });
    }

    await tx
      .update(goodsReceipts)
      .set({ status: "posted", journalEntryId: entry.entryId, updatedAt: new Date() })
      .where(eq(goodsReceipts.id, grn.id));

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "grn.posted",
      entityType: "goods_receipt",
      entityId: grn.id,
      after: { grnNumber: grn.grnNumber, totalMinor: total.toString() },
    });

    return entry;
  });
}

/** Raise the vendor bill against a posted GRN — clears GRNI, records A/P. */
export async function convertGoodsReceiptToBill(args: {
  orgId: string;
  goodsReceiptId: string;
  billDate: string;
  dueDate?: string;
  vendorInvoiceNumber?: string;
  taxRateId?: string | null;
  autoPost?: boolean;
  userId?: string | null;
}): Promise<{ billId: string; billNumber: string }> {
  const loaded = await withOrg(args.orgId, async (tx) => {
    const [grn] = await tx
      .select()
      .from(goodsReceipts)
      .where(and(eq(goodsReceipts.id, args.goodsReceiptId), eq(goodsReceipts.orgId, args.orgId)));
    if (!grn)
      throw new LedgerError(`Goods receipt ${args.goodsReceiptId} not found.`, "GRN_NOT_FOUND");
    if (grn.status !== "posted")
      throw new LedgerError(`GRN ${grn.grnNumber} must be posted first.`, "GRN_NOT_POSTED");
    if (grn.billId)
      throw new LedgerError(`GRN ${grn.grnNumber} is already billed.`, "GRN_ALREADY_BILLED");
    const ls = await tx
      .select()
      .from(goodsReceiptLines)
      .where(eq(goodsReceiptLines.goodsReceiptId, grn.id));
    return { grn, ls };
  });

  // Bill lines are priced at the GRN's receipt cost, so the bill's Dr GRNI
  // exactly clears the GRN's Cr GRNI.
  const created = await createBill({
    orgId: args.orgId,
    contactId: loaded.grn.contactId,
    billDate: args.billDate,
    dueDate: args.dueDate ?? args.billDate,
    vendorInvoiceNumber: args.vendorInvoiceNumber,
    userId: args.userId,
    lines: loaded.ls
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((l) => ({
        itemId: l.itemId,
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: l.unitCostMinor,
        taxRateId: args.taxRateId ?? l.taxRateId,
      })),
  });

  await withOrg(args.orgId, async (tx) => {
    await tx
      .update(bills)
      .set({ stockReceived: true, updatedAt: new Date() })
      .where(eq(bills.id, created.billId));
    await tx
      .update(goodsReceipts)
      .set({ billId: created.billId, updatedAt: new Date() })
      .where(eq(goodsReceipts.id, args.goodsReceiptId));
  });

  if (args.autoPost) {
    await postBill({ orgId: args.orgId, billId: created.billId, userId: args.userId });
  }

  return created;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Delivery notes
 * ──────────────────────────────────────────────────────────────────────────*/

export type DeliveryLine = {
  itemId: string;
  description: string;
  quantity: string;
  unitPriceMinor: bigint;
  taxRateId?: string | null;
  revenueAccountId?: string | null;
};

export async function createDeliveryNote(input: {
  orgId: string;
  contactId: string;
  deliveryDate: string;
  lines: DeliveryLine[];
  relatedSalesOrderId?: string | null;
  currency?: string;
  userId?: string | null;
}): Promise<{ deliveryNoteId: string; deliveryNumber: string }> {
  if (input.lines.length === 0)
    throw new LedgerError("A delivery note needs at least one line.", "NO_LINES");

  return withOrg(input.orgId, async (tx) => {
    const deliveryNumber = await claimNextNumber(tx, input.orgId, "delivery_note");
    const [dn] = await tx
      .insert(deliveryNotes)
      .values({
        orgId: input.orgId,
        contactId: input.contactId,
        deliveryNumber,
        relatedSalesOrderId: input.relatedSalesOrderId ?? null,
        deliveryDate: input.deliveryDate,
        status: "draft",
        currency: input.currency ?? "INR",
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: deliveryNotes.id });

    await tx.insert(deliveryNoteLines).values(
      input.lines.map((l, i) => ({
        orgId: input.orgId,
        deliveryNoteId: dn.id,
        lineNumber: i + 1,
        itemId: l.itemId,
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
        taxRateId: l.taxRateId ?? null,
        revenueAccountId: l.revenueAccountId ?? null,
      })),
    );

    return { deliveryNoteId: dn.id, deliveryNumber };
  });
}

/** Post a delivery: relieve stock and book COGS at weighted-average cost. */
export async function postDeliveryNote(args: {
  orgId: string;
  deliveryNoteId: string;
  userId?: string | null;
}): Promise<{ entryId: string; entryNumber: string }> {
  return withOrg(args.orgId, async (tx) => {
    const [dn] = await tx
      .select()
      .from(deliveryNotes)
      .where(and(eq(deliveryNotes.id, args.deliveryNoteId), eq(deliveryNotes.orgId, args.orgId)));
    if (!dn)
      throw new LedgerError(
        `Delivery note ${args.deliveryNoteId} not found.`,
        "DELIVERY_NOT_FOUND",
      );
    if (dn.status !== "draft")
      throw new LedgerError(
        `Delivery note ${dn.deliveryNumber} is ${dn.status}.`,
        "DELIVERY_NOT_DRAFT",
      );

    const lines = await tx
      .select()
      .from(deliveryNoteLines)
      .where(eq(deliveryNoteLines.deliveryNoteId, dn.id));
    const warehouseId = await getDefaultWarehouseId(tx, args.orgId);

    const issueRequests: IssueRequest[] = [];
    const itemAccounts = new Map<string, { invAcct: string; cogsAcct: string }>();
    for (const l of lines) {
      const tracked = await getTrackedItem(tx, args.orgId, l.itemId);
      if (!tracked) {
        throw new LedgerError(
          `Item on delivery ${dn.deliveryNumber} is not stock-tracked.`,
          "ITEM_NOT_TRACKED",
        );
      }
      itemAccounts.set(l.itemId, {
        invAcct:
          tracked.inventoryAccountId ?? (await resolveControlAccount(tx, args.orgId, "inventory")),
        cogsAcct:
          tracked.cogsAccountId ??
          (await resolveControlAccount(tx, args.orgId, "cost_of_goods_sold")),
      });
      issueRequests.push({
        itemId: l.itemId,
        quantity: l.quantity,
        memo: `Delivery — ${dn.deliveryNumber}`,
      });
    }

    const plan = await planStockOut(tx, args.orgId, warehouseId, issueRequests);
    const cogsByAccount = new Map<string, bigint>();
    const invByAccount = new Map<string, bigint>();
    for (const pl of plan.lines) {
      const a = itemAccounts.get(pl.itemId)!;
      cogsByAccount.set(a.cogsAcct, (cogsByAccount.get(a.cogsAcct) ?? 0n) + pl.valueMinor);
      invByAccount.set(a.invAcct, (invByAccount.get(a.invAcct) ?? 0n) + pl.valueMinor);
    }
    const postings: PostingLine[] = [];
    for (const [acc, amt] of cogsByAccount)
      postings.push(debit(acc, amt, { memo: `COGS — ${dn.deliveryNumber}` }));
    for (const [acc, amt] of invByAccount)
      postings.push(credit(acc, amt, { memo: `Stock out — ${dn.deliveryNumber}` }));

    const entry = await postJournalEntry(
      {
        orgId: args.orgId,
        entryDate: dn.deliveryDate,
        source: "invoice",
        sourceDocumentId: dn.id,
        reference: dn.deliveryNumber,
        memo: `Delivery ${dn.deliveryNumber}`,
        userId: args.userId,
        lines: postings,
      },
      tx,
    );

    await commitStockOut(tx, args.orgId, plan, {
      moveDate: dn.deliveryDate,
      source: "sale",
      sourceDocumentId: dn.id,
      jeId: entry.entryId,
      userId: args.userId,
    });

    await tx
      .update(deliveryNotes)
      .set({ status: "posted", journalEntryId: entry.entryId, updatedAt: new Date() })
      .where(eq(deliveryNotes.id, dn.id));

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "delivery.posted",
      entityType: "delivery_note",
      entityId: dn.id,
      after: { deliveryNumber: dn.deliveryNumber, cogsMinor: plan.totalValueMinor.toString() },
    });

    return entry;
  });
}

/** Invoice the delivered goods — revenue only, since stock is already relieved. */
export async function convertDeliveryToInvoice(args: {
  orgId: string;
  deliveryNoteId: string;
  invoiceDate: string;
  dueDate?: string;
  autoPost?: boolean;
  userId?: string | null;
}): Promise<{ invoiceId: string; invoiceNumber: string }> {
  const loaded = await withOrg(args.orgId, async (tx) => {
    const [dn] = await tx
      .select()
      .from(deliveryNotes)
      .where(and(eq(deliveryNotes.id, args.deliveryNoteId), eq(deliveryNotes.orgId, args.orgId)));
    if (!dn)
      throw new LedgerError(
        `Delivery note ${args.deliveryNoteId} not found.`,
        "DELIVERY_NOT_FOUND",
      );
    if (dn.status !== "posted")
      throw new LedgerError(
        `Delivery ${dn.deliveryNumber} must be posted first.`,
        "DELIVERY_NOT_POSTED",
      );
    if (dn.invoiceId)
      throw new LedgerError(
        `Delivery ${dn.deliveryNumber} is already invoiced.`,
        "DELIVERY_ALREADY_INVOICED",
      );
    const ls = await tx
      .select()
      .from(deliveryNoteLines)
      .where(eq(deliveryNoteLines.deliveryNoteId, dn.id));
    return { dn, ls };
  });

  const created = await createInvoice({
    orgId: args.orgId,
    contactId: loaded.dn.contactId,
    invoiceDate: args.invoiceDate,
    dueDate: args.dueDate,
    currency: loaded.dn.currency,
    userId: args.userId,
    lines: loaded.ls
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((l) => ({
        itemId: l.itemId,
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
        taxRateId: l.taxRateId,
        revenueAccountId: l.revenueAccountId,
      })),
  });

  await withOrg(args.orgId, async (tx) => {
    // Stock and COGS were already booked by the delivery — the invoice must
    // recognise revenue only.
    await tx
      .update(invoices)
      .set({ stockRelieved: true, updatedAt: new Date() })
      .where(eq(invoices.id, created.invoiceId));
    await tx
      .update(deliveryNotes)
      .set({ invoiceId: created.invoiceId, updatedAt: new Date() })
      .where(eq(deliveryNotes.id, args.deliveryNoteId));
  });

  if (args.autoPost) {
    await postInvoice({ orgId: args.orgId, invoiceId: created.invoiceId, userId: args.userId });
  }

  return created;
}
