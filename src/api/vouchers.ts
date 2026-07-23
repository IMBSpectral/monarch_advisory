/**
 * Server functions for the Phase-2 voucher set: credit/debit notes, contra
 * transfers, sales/purchase orders, goods receipts (GRN) and delivery notes.
 *
 * Reads need only a session. Creating a draft is `document:create` (staff);
 * anything that posts to the ledger — posting a note, recording a contra,
 * converting an order/GRN/delivery with autoPost — additionally needs
 * `ledger:post` (accountant), enforced here and again in the server layer.
 */

import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db/client";
import {
  bills,
  contacts,
  contraVouchers,
  creditNotes,
  debitNotes,
  deliveryNotes,
  goodsReceipts,
  invoices,
  purchaseOrders,
  salesOrders,
} from "@/db/schema";
import { requireAuth, requirePermission } from "@/server/session";
import { assertCan } from "@/server/auth";
import { createCreditNote, postCreditNote, createDebitNote, postDebitNote } from "@/server/credit-notes";
import { recordContra } from "@/server/contra";
import {
  createSalesOrder,
  convertSalesOrderToInvoice,
  createPurchaseOrder,
  convertPurchaseOrderToBill,
} from "@/server/orders";
import {
  createGoodsReceipt,
  postGoodsReceipt,
  convertGoodsReceiptToBill,
  createDeliveryNote,
  postDeliveryNote,
  convertDeliveryToInvoice,
} from "@/server/receipts";

const NO_TAX = "__none__";
const money = (n: string | number) => String(Math.round(Number(n) * 100));
const s = (v: bigint) => v.toString();

const noteLine = z.object({
  itemId: z.string().uuid().nullable().optional(),
  description: z.string().min(1),
  quantity: z.string().optional(),
  unitPriceMinor: z.string(),
  taxRateId: z.string().uuid().nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
});

/* ────────────────────────────────────────────────────────────────────────────
 * Reads
 * ──────────────────────────────────────────────────────────────────────────*/

export const fetchCreditNotes = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({
        id: creditNotes.id,
        number: creditNotes.creditNoteNumber,
        date: creditNotes.creditNoteDate,
        status: creditNotes.status,
        totalMinor: creditNotes.totalMinor,
        reason: creditNotes.reason,
        name: contacts.displayName,
      })
      .from(creditNotes)
      .innerJoin(contacts, eq(contacts.id, creditNotes.contactId))
      .where(eq(creditNotes.orgId, orgId))
      .orderBy(desc(creditNotes.creditNoteDate), desc(creditNotes.creditNoteNumber)),
  );
  return rows.map((r) => ({ ...r, total: s(r.totalMinor), totalMinor: undefined }));
});

export const fetchDebitNotes = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({
        id: debitNotes.id,
        number: debitNotes.debitNoteNumber,
        date: debitNotes.debitNoteDate,
        status: debitNotes.status,
        totalMinor: debitNotes.totalMinor,
        reason: debitNotes.reason,
        name: contacts.displayName,
      })
      .from(debitNotes)
      .innerJoin(contacts, eq(contacts.id, debitNotes.contactId))
      .where(eq(debitNotes.orgId, orgId))
      .orderBy(desc(debitNotes.debitNoteDate), desc(debitNotes.debitNoteNumber)),
  );
  return rows.map((r) => ({ ...r, total: s(r.totalMinor), totalMinor: undefined }));
});

export const fetchContras = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({
        id: contraVouchers.id,
        number: contraVouchers.voucherNumber,
        date: contraVouchers.voucherDate,
        amountMinor: contraVouchers.amountMinor,
        memo: contraVouchers.memo,
        fromAccountId: contraVouchers.fromAccountId,
        toAccountId: contraVouchers.toAccountId,
      })
      .from(contraVouchers)
      .where(eq(contraVouchers.orgId, orgId))
      .orderBy(desc(contraVouchers.voucherDate), desc(contraVouchers.voucherNumber)),
  );
  return rows.map((r) => ({ ...r, amount: s(r.amountMinor), amountMinor: undefined }));
});

const orderCols = (t: typeof salesOrders | typeof purchaseOrders) => ({
  id: t.id,
  number: t.orderNumber,
  date: t.orderDate,
  expected: t.expectedDate,
  status: t.status,
  totalMinor: t.totalMinor,
  name: contacts.displayName,
});

export const fetchSalesOrders = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select(orderCols(salesOrders))
      .from(salesOrders)
      .innerJoin(contacts, eq(contacts.id, salesOrders.contactId))
      .where(eq(salesOrders.orgId, orgId))
      .orderBy(desc(salesOrders.orderDate), desc(salesOrders.orderNumber)),
  );
  return rows.map((r) => ({ ...r, total: s(r.totalMinor), totalMinor: undefined }));
});

export const fetchPurchaseOrders = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select(orderCols(purchaseOrders))
      .from(purchaseOrders)
      .innerJoin(contacts, eq(contacts.id, purchaseOrders.contactId))
      .where(eq(purchaseOrders.orgId, orgId))
      .orderBy(desc(purchaseOrders.orderDate), desc(purchaseOrders.orderNumber)),
  );
  return rows.map((r) => ({ ...r, total: s(r.totalMinor), totalMinor: undefined }));
});

export const fetchGoodsReceipts = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({
        id: goodsReceipts.id,
        number: goodsReceipts.grnNumber,
        date: goodsReceipts.receiptDate,
        status: goodsReceipts.status,
        totalMinor: goodsReceipts.totalMinor,
        billId: goodsReceipts.billId,
        name: contacts.displayName,
      })
      .from(goodsReceipts)
      .innerJoin(contacts, eq(contacts.id, goodsReceipts.contactId))
      .where(eq(goodsReceipts.orgId, orgId))
      .orderBy(desc(goodsReceipts.receiptDate), desc(goodsReceipts.grnNumber)),
  );
  return rows.map((r) => ({ ...r, total: s(r.totalMinor), totalMinor: undefined }));
});

export const fetchDeliveries = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({
        id: deliveryNotes.id,
        number: deliveryNotes.deliveryNumber,
        date: deliveryNotes.deliveryDate,
        status: deliveryNotes.status,
        invoiceId: deliveryNotes.invoiceId,
        name: contacts.displayName,
      })
      .from(deliveryNotes)
      .innerJoin(contacts, eq(contacts.id, deliveryNotes.contactId))
      .where(eq(deliveryNotes.orgId, orgId))
      .orderBy(desc(deliveryNotes.deliveryDate), desc(deliveryNotes.deliveryNumber)),
  );
  return rows;
});

/* ────────────────────────────────────────────────────────────────────────────
 * Credit / debit notes
 * ──────────────────────────────────────────────────────────────────────────*/

export const createCreditNoteFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      contactId: z.string().uuid(),
      relatedInvoiceId: z.string().uuid(),
      creditNoteDate: z.string(),
      reason: z.string().optional(),
      restock: z.boolean().optional(),
      lines: z.array(noteLine).min(1),
      postImmediately: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("document:create");
    if (data.postImmediately) assertCan(p, "ledger:post");
    const r = await createCreditNote({
      orgId: p.orgId,
      contactId: data.contactId,
      relatedInvoiceId: data.relatedInvoiceId,
      creditNoteDate: data.creditNoteDate,
      reason: data.reason,
      restock: data.restock,
      userId: p.userId,
      lines: data.lines.map((l) => ({ ...l, unitPriceMinor: BigInt(l.unitPriceMinor) })),
    });
    if (data.postImmediately) await postCreditNote({ orgId: p.orgId, creditNoteId: r.creditNoteId, userId: p.userId });
    return { number: r.creditNoteNumber };
  });

export const createDebitNoteFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      contactId: z.string().uuid(),
      relatedBillId: z.string().uuid(),
      debitNoteDate: z.string(),
      reason: z.string().optional(),
      lines: z.array(noteLine).min(1),
      postImmediately: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("document:create");
    if (data.postImmediately) assertCan(p, "ledger:post");
    const r = await createDebitNote({
      orgId: p.orgId,
      contactId: data.contactId,
      relatedBillId: data.relatedBillId,
      debitNoteDate: data.debitNoteDate,
      reason: data.reason,
      userId: p.userId,
      lines: data.lines.map((l) => ({ ...l, unitPriceMinor: BigInt(l.unitPriceMinor) })),
    });
    if (data.postImmediately) await postDebitNote({ orgId: p.orgId, debitNoteId: r.debitNoteId, userId: p.userId });
    return { number: r.debitNoteNumber };
  });

/* ────────────────────────────────────────────────────────────────────────────
 * Contra
 * ──────────────────────────────────────────────────────────────────────────*/

export const recordContraFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      fromAccountId: z.string().uuid(),
      toAccountId: z.string().uuid(),
      amountMinor: z.string(),
      voucherDate: z.string(),
      memo: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("ledger:post");
    const r = await recordContra({
      orgId: p.orgId,
      fromAccountId: data.fromAccountId,
      toAccountId: data.toAccountId,
      amountMinor: BigInt(data.amountMinor),
      voucherDate: data.voucherDate,
      memo: data.memo,
      userId: p.userId,
    });
    return { number: r.voucherNumber };
  });

/* ────────────────────────────────────────────────────────────────────────────
 * Orders
 * ──────────────────────────────────────────────────────────────────────────*/

export const createSalesOrderFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      contactId: z.string().uuid(),
      orderDate: z.string(),
      expectedDate: z.string().optional(),
      lines: z.array(noteLine).min(1),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("document:create");
    const r = await createSalesOrder({
      orgId: p.orgId,
      contactId: data.contactId,
      orderDate: data.orderDate,
      expectedDate: data.expectedDate,
      userId: p.userId,
      lines: data.lines.map((l) => ({ ...l, unitPriceMinor: BigInt(l.unitPriceMinor) })),
    });
    return { number: r.orderNumber };
  });

export const convertSalesOrderFn = createServerFn({ method: "POST" })
  .validator(z.object({ salesOrderId: z.string().uuid(), invoiceDate: z.string() }))
  .handler(async ({ data }) => {
    const p = await requirePermission("ledger:post");
    const r = await convertSalesOrderToInvoice({
      orgId: p.orgId,
      salesOrderId: data.salesOrderId,
      invoiceDate: data.invoiceDate,
      autoPost: true,
      userId: p.userId,
    });
    return { number: r.invoiceNumber };
  });

export const createPurchaseOrderFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      contactId: z.string().uuid(),
      orderDate: z.string(),
      expectedDate: z.string().optional(),
      lines: z.array(noteLine).min(1),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("document:create");
    const r = await createPurchaseOrder({
      orgId: p.orgId,
      contactId: data.contactId,
      orderDate: data.orderDate,
      expectedDate: data.expectedDate,
      userId: p.userId,
      lines: data.lines.map((l) => ({ ...l, unitPriceMinor: BigInt(l.unitPriceMinor) })),
    });
    return { number: r.orderNumber };
  });

export const convertPurchaseOrderFn = createServerFn({ method: "POST" })
  .validator(z.object({ purchaseOrderId: z.string().uuid(), billDate: z.string() }))
  .handler(async ({ data }) => {
    const p = await requirePermission("ledger:post");
    const r = await convertPurchaseOrderToBill({
      orgId: p.orgId,
      purchaseOrderId: data.purchaseOrderId,
      billDate: data.billDate,
      autoPost: true,
      userId: p.userId,
    });
    return { number: r.billNumber };
  });

/* ────────────────────────────────────────────────────────────────────────────
 * GRN & delivery notes
 * ──────────────────────────────────────────────────────────────────────────*/

export const createGoodsReceiptFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      contactId: z.string().uuid(),
      receiptDate: z.string(),
      lines: z
        .array(
          z.object({
            itemId: z.string().uuid(),
            description: z.string().min(1),
            quantity: z.string().optional(),
            unitCostMinor: z.string(),
          }),
        )
        .min(1),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("ledger:post");
    const r = await createGoodsReceipt({
      orgId: p.orgId,
      contactId: data.contactId,
      receiptDate: data.receiptDate,
      userId: p.userId,
      lines: data.lines.map((l) => ({ ...l, quantity: l.quantity ?? "1", unitCostMinor: BigInt(l.unitCostMinor) })),
    });
    await postGoodsReceipt({ orgId: p.orgId, goodsReceiptId: r.goodsReceiptId, userId: p.userId });
    return { number: r.grnNumber };
  });

export const convertGrnToBillFn = createServerFn({ method: "POST" })
  .validator(z.object({ goodsReceiptId: z.string().uuid(), billDate: z.string() }))
  .handler(async ({ data }) => {
    const p = await requirePermission("ledger:post");
    const r = await convertGoodsReceiptToBill({
      orgId: p.orgId,
      goodsReceiptId: data.goodsReceiptId,
      billDate: data.billDate,
      autoPost: true,
      userId: p.userId,
    });
    return { number: r.billNumber };
  });

export const createDeliveryFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      contactId: z.string().uuid(),
      deliveryDate: z.string(),
      lines: z
        .array(
          z.object({
            itemId: z.string().uuid(),
            description: z.string().min(1),
            quantity: z.string().optional(),
            unitPriceMinor: z.string(),
            revenueAccountId: z.string().uuid().nullable().optional(),
          }),
        )
        .min(1),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("ledger:post");
    const r = await createDeliveryNote({
      orgId: p.orgId,
      contactId: data.contactId,
      deliveryDate: data.deliveryDate,
      userId: p.userId,
      lines: data.lines.map((l) => ({ ...l, quantity: l.quantity ?? "1", unitPriceMinor: BigInt(l.unitPriceMinor) })),
    });
    await postDeliveryNote({ orgId: p.orgId, deliveryNoteId: r.deliveryNoteId, userId: p.userId });
    return { number: r.deliveryNumber };
  });

export const convertDeliveryFn = createServerFn({ method: "POST" })
  .validator(z.object({ deliveryNoteId: z.string().uuid(), invoiceDate: z.string() }))
  .handler(async ({ data }) => {
    const p = await requirePermission("ledger:post");
    const r = await convertDeliveryToInvoice({
      orgId: p.orgId,
      deliveryNoteId: data.deliveryNoteId,
      invoiceDate: data.invoiceDate,
      autoPost: true,
      userId: p.userId,
    });
    return { number: r.invoiceNumber };
  });

export { NO_TAX, money };
