/**
 * Server functions for the payables side — bills and vendor payments.
 *
 * Reads (the bills list) need only a session. Creating a draft is a staff act;
 * posting it to the ledger needs `ledger:post`; paying a vendor needs
 * `payment:record`. Same permission split as the sales side in `index.ts`.
 */

import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db/client";
import { bills, contacts } from "@/db/schema";
import { createBill, postBill, recordVendorPayment, voidBill } from "@/server/bills";
import { requireAuth, requirePermission } from "@/server/session";
import { assertCan } from "@/server/auth";

/* ────────────────────────────────────────────────────────────────────────────
 * List
 * ──────────────────────────────────────────────────────────────────────────*/

export const fetchBills = createServerFn({ method: "GET" })
  .validator(z.object({ limit: z.number().max(200).optional() }).optional())
  .handler(async ({ data }) => {
    const { orgId } = await requireAuth();
    const rows = await withOrg(orgId, (tx) =>
      tx
        .select({
          id: bills.id,
          billNumber: bills.billNumber,
          vendorInvoiceNumber: bills.vendorInvoiceNumber,
          billDate: bills.billDate,
          dueDate: bills.dueDate,
          status: bills.status,
          currency: bills.currency,
          totalMinor: bills.totalMinor,
          amountPaidMinor: bills.amountPaidMinor,
          vendorName: contacts.displayName,
          contactId: contacts.id,
        })
        .from(bills)
        .innerJoin(contacts, eq(contacts.id, bills.contactId))
        .where(eq(bills.orgId, orgId))
        .orderBy(desc(bills.billDate), desc(bills.billNumber))
        .limit(data?.limit ?? 50),
    );

    return rows.map((r) => ({
      id: r.id,
      billNumber: r.billNumber,
      vendorInvoiceNumber: r.vendorInvoiceNumber,
      billDate: r.billDate,
      dueDate: r.dueDate,
      status: r.status,
      currency: r.currency,
      vendorName: r.vendorName,
      contactId: r.contactId,
      total: r.totalMinor.toString(),
      paid: r.amountPaidMinor.toString(),
      balance: (r.totalMinor - r.amountPaidMinor).toString(),
    }));
  });

/* ────────────────────────────────────────────────────────────────────────────
 * Mutations
 * ──────────────────────────────────────────────────────────────────────────*/

const billLineSchema = z.object({
  description: z.string().min(1),
  quantity: z.string().optional(),
  unitPriceMinor: z.string(),
  discountBps: z.number().int().min(0).max(10000).optional(),
  taxRateId: z.string().uuid().optional().nullable(),
  itemId: z.string().uuid().optional().nullable(),
  expenseAccountId: z.string().uuid().optional().nullable(),
});

export const createBillFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      contactId: z.string().uuid(),
      billDate: z.string(),
      dueDate: z.string().optional(),
      vendorInvoiceNumber: z.string().optional(),
      notes: z.string().optional(),
      lines: z.array(billLineSchema).min(1),
      postImmediately: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    // Raising a bill is staff-level; posting it needs the accountant capability.
    const principal = await requirePermission("document:create");
    if (data.postImmediately) assertCan(principal, "ledger:post");

    const result = await createBill({
      orgId: principal.orgId,
      contactId: data.contactId,
      billDate: data.billDate,
      dueDate: data.dueDate,
      vendorInvoiceNumber: data.vendorInvoiceNumber,
      notes: data.notes,
      userId: principal.userId,
      lines: data.lines.map((l) => ({
        ...l,
        unitPriceMinor: BigInt(l.unitPriceMinor),
      })),
    });

    if (data.postImmediately) {
      await postBill({ orgId: principal.orgId, billId: result.billId, userId: principal.userId });
    }

    return {
      billId: result.billId,
      billNumber: result.billNumber,
      total: result.totalMinor.toString(),
    };
  });

export const postBillFn = createServerFn({ method: "POST" })
  .validator(z.object({ billId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const principal = await requirePermission("ledger:post");
    const entry = await postBill({
      orgId: principal.orgId,
      billId: data.billId,
      userId: principal.userId,
    });
    return { entryId: entry.entryId, entryNumber: entry.entryNumber };
  });

export const payBillFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      contactId: z.string().uuid(),
      paymentDate: z.string(),
      amountMinor: z.string(),
      paymentAccountId: z.string().uuid(),
      method: z.string().optional(),
      referenceNumber: z.string().optional(),
      allocations: z
        .array(z.object({ billId: z.string().uuid(), amountMinor: z.string() }))
        .default([]),
    }),
  )
  .handler(async ({ data }) => {
    const principal = await requirePermission("payment:record");
    const result = await recordVendorPayment({
      orgId: principal.orgId,
      contactId: data.contactId,
      paymentDate: data.paymentDate,
      amountMinor: BigInt(data.amountMinor),
      depositAccountId: data.paymentAccountId,
      method: data.method,
      referenceNumber: data.referenceNumber,
      userId: principal.userId,
      allocations: data.allocations.map((a) => ({
        billId: a.billId,
        amountMinor: BigInt(a.amountMinor),
      })),
    });
    return {
      paymentId: result.paymentId,
      paymentNumber: result.paymentNumber,
    };
  });

export const voidBillFn = createServerFn({ method: "POST" })
  .validator(z.object({ billId: z.string().uuid(), reason: z.string().min(1) }))
  .handler(async ({ data }) => {
    const principal = await requirePermission("document:void");
    await voidBill({
      orgId: principal.orgId,
      billId: data.billId,
      reason: data.reason,
      userId: principal.userId,
    });
    return { ok: true };
  });
