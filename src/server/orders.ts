/**
 * Sales & purchase orders.
 *
 * Orders are commitments, not accounting events — they never touch the ledger.
 * The financial impact happens on CONVERSION: a sales order becomes a draft
 * invoice, a purchase order a draft bill, each built through the same service the
 * app uses directly, then posted normally (which is what relieves/receives stock
 * and books revenue/COGS). So orders add the procurement/fulfilment lifecycle on
 * top of Phase 1 without duplicating any posting logic.
 */

import { and, eq, inArray } from "drizzle-orm";
import { withOrg } from "@/db/client";
import type { DbOrTx } from "@/db/client";
import {
  contacts,
  organizations,
  purchaseOrderLines,
  purchaseOrders,
  salesOrderLines,
  salesOrders,
  taxRates,
} from "@/db/schema";
import { LedgerError, claimNextNumber, writeAudit } from "./ledger";
import { createInvoice, postInvoice } from "./invoicing";
import { createBill, postBill } from "./bills";

function mulDivRound(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  const abs = amount < 0n ? -amount : amount;
  const scaled = abs * numerator;
  const q = scaled / denominator;
  const r = scaled % denominator;
  const rounded = r * 2n >= denominator ? q + 1n : q;
  return amount < 0n ? -rounded : rounded;
}

type OrderLine = {
  itemId?: string | null;
  description: string;
  quantity?: string;
  unitPriceMinor: bigint;
  discountBps?: number;
  taxRateId?: string | null;
  accountId?: string | null; // revenue (SO) or expense (PO)
};

/** Compute an order's subtotal / tax / total from its lines. */
async function totalsFor(tx: DbOrTx, orgId: string, lines: OrderLine[]) {
  const ids = [...new Set(lines.map((l) => l.taxRateId).filter(Boolean))] as string[];
  const rates = ids.length
    ? await tx.select().from(taxRates).where(and(eq(taxRates.orgId, orgId), inArray(taxRates.id, ids)))
    : [];
  const rateById = new Map(rates.map((r) => [r.id, r]));

  let subtotal = 0n;
  let tax = 0n;
  for (const l of lines) {
    const qtyScaled = BigInt(Math.round(Number(l.quantity ?? "1") * 10_000));
    if (qtyScaled <= 0n) throw new LedgerError(`Line "${l.description}" quantity must be positive.`, "INVALID_QUANTITY");
    const gross = mulDivRound(l.unitPriceMinor, qtyScaled, 10_000n);
    const net = gross - mulDivRound(gross, BigInt(l.discountBps ?? 0), 10_000n);
    const rateBps = l.taxRateId ? (rateById.get(l.taxRateId)?.rateBps ?? 0) : 0;
    subtotal += net;
    tax += rateBps ? mulDivRound(net, BigInt(rateBps), 10_000n) : 0n;
  }
  return { subtotal, tax, total: subtotal + tax };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Sales orders
 * ──────────────────────────────────────────────────────────────────────────*/

export type CreateSalesOrderInput = {
  orgId: string;
  contactId: string;
  orderDate: string;
  expectedDate?: string;
  lines: OrderLine[];
  status?: "draft" | "confirmed";
  currency?: string;
  notes?: string;
  userId?: string | null;
};

export async function createSalesOrder(
  input: CreateSalesOrderInput,
): Promise<{ salesOrderId: string; orderNumber: string; totalMinor: bigint }> {
  if (input.lines.length === 0) throw new LedgerError("A sales order needs at least one line.", "NO_LINES");

  return withOrg(input.orgId, async (tx) => {
    const [customer] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.orgId, input.orgId)));
    if (!customer) throw new LedgerError(`Customer ${input.contactId} not found.`, "CONTACT_NOT_FOUND");

    const [org] = await tx
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, input.orgId));

    const t = await totalsFor(tx, input.orgId, input.lines);
    const orderNumber = await claimNextNumber(tx, input.orgId, "sales_order");

    const [so] = await tx
      .insert(salesOrders)
      .values({
        orgId: input.orgId,
        contactId: input.contactId,
        orderNumber,
        orderDate: input.orderDate,
        expectedDate: input.expectedDate ?? null,
        status: input.status ?? "confirmed",
        currency: input.currency ?? customer.currency ?? org.baseCurrency,
        subtotalMinor: t.subtotal,
        taxTotalMinor: t.tax,
        totalMinor: t.total,
        notes: input.notes ?? null,
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: salesOrders.id });

    await tx.insert(salesOrderLines).values(
      input.lines.map((l, i) => ({
        orgId: input.orgId,
        salesOrderId: so.id,
        lineNumber: i + 1,
        itemId: l.itemId ?? null,
        description: l.description,
        quantity: l.quantity ?? "1",
        unitPriceMinor: l.unitPriceMinor,
        discountBps: l.discountBps ?? 0,
        taxRateId: l.taxRateId ?? null,
        revenueAccountId: l.accountId ?? null,
      })),
    );

    return { salesOrderId: so.id, orderNumber, totalMinor: t.total };
  });
}

/** Turn a sales order into an invoice (draft, or posted when autoPost). */
export async function convertSalesOrderToInvoice(args: {
  orgId: string;
  salesOrderId: string;
  invoiceDate: string;
  dueDate?: string;
  autoPost?: boolean;
  userId?: string | null;
}): Promise<{ invoiceId: string; invoiceNumber: string }> {
  const lines = await withOrg(args.orgId, async (tx) => {
    const [so] = await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.id, args.salesOrderId), eq(salesOrders.orgId, args.orgId)));
    if (!so) throw new LedgerError(`Sales order ${args.salesOrderId} not found.`, "ORDER_NOT_FOUND");
    if (so.status === "invoiced" || so.status === "cancelled") {
      throw new LedgerError(`Sales order ${so.orderNumber} is ${so.status}; cannot convert.`, "ORDER_NOT_CONVERTIBLE");
    }
    const ls = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, so.id));
    return { so, ls };
  });

  const created = await createInvoice({
    orgId: args.orgId,
    contactId: lines.so.contactId,
    invoiceDate: args.invoiceDate,
    dueDate: args.dueDate,
    currency: lines.so.currency,
    userId: args.userId,
    lines: lines.ls
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((l) => ({
        itemId: l.itemId,
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
        discountBps: l.discountBps,
        taxRateId: l.taxRateId,
        revenueAccountId: l.revenueAccountId,
      })),
  });

  if (args.autoPost) {
    await postInvoice({ orgId: args.orgId, invoiceId: created.invoiceId, userId: args.userId });
  }

  await withOrg(args.orgId, async (tx) => {
    await tx
      .update(salesOrders)
      .set({ status: "invoiced", invoiceId: created.invoiceId, updatedAt: new Date() })
      .where(eq(salesOrders.id, args.salesOrderId));
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "sales_order.converted",
      entityType: "sales_order",
      entityId: args.salesOrderId,
      after: { invoiceId: created.invoiceId, invoiceNumber: created.invoiceNumber },
    });
  });

  return created;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Purchase orders
 * ──────────────────────────────────────────────────────────────────────────*/

export type CreatePurchaseOrderInput = {
  orgId: string;
  contactId: string;
  orderDate: string;
  expectedDate?: string;
  lines: OrderLine[];
  status?: "draft" | "confirmed";
  currency?: string;
  notes?: string;
  userId?: string | null;
};

export async function createPurchaseOrder(
  input: CreatePurchaseOrderInput,
): Promise<{ purchaseOrderId: string; orderNumber: string; totalMinor: bigint }> {
  if (input.lines.length === 0) throw new LedgerError("A purchase order needs at least one line.", "NO_LINES");

  return withOrg(input.orgId, async (tx) => {
    const [vendor] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.orgId, input.orgId)));
    if (!vendor) throw new LedgerError(`Vendor ${input.contactId} not found.`, "CONTACT_NOT_FOUND");

    const [org] = await tx
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, input.orgId));

    const t = await totalsFor(tx, input.orgId, input.lines);
    const orderNumber = await claimNextNumber(tx, input.orgId, "purchase_order");

    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        orgId: input.orgId,
        contactId: input.contactId,
        orderNumber,
        orderDate: input.orderDate,
        expectedDate: input.expectedDate ?? null,
        status: input.status ?? "confirmed",
        currency: input.currency ?? vendor.currency ?? org.baseCurrency,
        subtotalMinor: t.subtotal,
        taxTotalMinor: t.tax,
        totalMinor: t.total,
        notes: input.notes ?? null,
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: purchaseOrders.id });

    await tx.insert(purchaseOrderLines).values(
      input.lines.map((l, i) => ({
        orgId: input.orgId,
        purchaseOrderId: po.id,
        lineNumber: i + 1,
        itemId: l.itemId ?? null,
        description: l.description,
        quantity: l.quantity ?? "1",
        unitPriceMinor: l.unitPriceMinor,
        taxRateId: l.taxRateId ?? null,
        expenseAccountId: l.accountId ?? null,
      })),
    );

    return { purchaseOrderId: po.id, orderNumber, totalMinor: t.total };
  });
}

/** Turn a purchase order into a bill (draft, or posted when autoPost). */
export async function convertPurchaseOrderToBill(args: {
  orgId: string;
  purchaseOrderId: string;
  billDate: string;
  dueDate?: string;
  vendorInvoiceNumber?: string;
  autoPost?: boolean;
  userId?: string | null;
}): Promise<{ billId: string; billNumber: string }> {
  const loaded = await withOrg(args.orgId, async (tx) => {
    const [po] = await tx
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, args.purchaseOrderId), eq(purchaseOrders.orgId, args.orgId)));
    if (!po) throw new LedgerError(`Purchase order ${args.purchaseOrderId} not found.`, "ORDER_NOT_FOUND");
    if (po.status === "invoiced" || po.status === "cancelled") {
      throw new LedgerError(`Purchase order ${po.orderNumber} is ${po.status}; cannot convert.`, "ORDER_NOT_CONVERTIBLE");
    }
    const ls = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
    return { po, ls };
  });

  const created = await createBill({
    orgId: args.orgId,
    contactId: loaded.po.contactId,
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
        unitPriceMinor: l.unitPriceMinor,
        taxRateId: l.taxRateId,
        expenseAccountId: l.expenseAccountId,
      })),
  });

  if (args.autoPost) {
    await postBill({ orgId: args.orgId, billId: created.billId, userId: args.userId });
  }

  await withOrg(args.orgId, async (tx) => {
    await tx
      .update(purchaseOrders)
      .set({ status: "invoiced", billId: created.billId, updatedAt: new Date() })
      .where(eq(purchaseOrders.id, args.purchaseOrderId));
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "purchase_order.converted",
      entityType: "purchase_order",
      entityId: args.purchaseOrderId,
      after: { billId: created.billId, billNumber: created.billNumber },
    });
  });

  return created;
}
