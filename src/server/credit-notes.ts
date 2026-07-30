/**
 * Credit & debit notes — sales and purchase returns.
 *
 * A credit note is the mirror of an invoice; a debit note the mirror of a bill.
 * Both reuse the one posting chokepoint and the Phase-1 stock engine:
 *
 *   Credit note (sales return):
 *     Dr Revenue / Dr Output Tax / Cr A/R      (customer owes us less)
 *     Dr Inventory / Cr COGS                   (goods back in, at avg cost)
 *
 *   Debit note (purchase return):
 *     Dr A/P / Cr Inventory|Expense / Cr Input Tax   (we owe the vendor less)
 *     stock issued out at weighted-average cost
 *
 * The revenue/receivable side and the stock/COGS side each balance on their own,
 * so no variance account is needed: a customer is credited the SALE price, while
 * stock returns at its carrying cost.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { withOrg } from "@/db/client";
import type { DbOrTx } from "@/db/client";
import { mulDivRound, parseQuantity } from "@/lib/decimal";
import {
  bills,
  contacts,
  creditNoteLines,
  creditNotes,
  debitNoteLines,
  debitNotes,
  invoices,
  organizations,
  taxRates,
} from "@/db/schema";
import {
  LedgerError,
  claimNextNumber,
  credit,
  debit,
  postJournalEntry,
  resolveControlAccount,
  resolveInputTaxAccount,
  writeAudit,
  type PostingLine,
} from "./ledger";
import { splitOutputGst } from "./gst";
import {
  getCurrentAvgCost,
  getDefaultWarehouseId,
  getTrackedItem,
  receiveStock,
  planStockOut,
  commitStockOut,
  type IssueRequest,
} from "./inventory";

type DraftNoteLine = {
  itemId?: string | null;
  description: string;
  quantity?: string;
  unitPriceMinor: bigint;
  discountBps?: number;
  taxRateId?: string | null;
  accountId?: string | null; // revenue (credit note) or expense (debit note)
};

type ComputedLine = {
  quantity: string;
  lineTotalMinor: bigint;
  taxAmountMinor: bigint;
  taxRateId: string | null;
};

function computeLine(line: DraftNoteLine, rateBps: number | null): ComputedLine {
  const qtyStr = line.quantity ?? "1";
  const qtyScaled = parseQuantity(qtyStr);
  if (qtyScaled <= 0n) {
    throw new LedgerError(
      `Line "${line.description}" has quantity ${qtyStr}; must be positive.`,
      "INVALID_QUANTITY",
    );
  }
  const gross = mulDivRound(line.unitPriceMinor, qtyScaled, 10_000n);
  const discount = mulDivRound(gross, BigInt(line.discountBps ?? 0), 10_000n);
  const net = gross - discount;
  const tax = rateBps ? mulDivRound(net, BigInt(rateBps), 10_000n) : 0n;
  return {
    quantity: qtyStr,
    lineTotalMinor: net,
    taxAmountMinor: tax,
    taxRateId: line.taxRateId ?? null,
  };
}

async function resolveRates(tx: DbOrTx, orgId: string, lines: DraftNoteLine[]) {
  const ids = [...new Set(lines.map((l) => l.taxRateId).filter(Boolean))] as string[];
  const rates = ids.length
    ? await tx
        .select()
        .from(taxRates)
        .where(and(eq(taxRates.orgId, orgId), inArray(taxRates.id, ids)))
    : [];
  return new Map(rates.map((r) => [r.id, r]));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Credit notes (sales returns)
 * ──────────────────────────────────────────────────────────────────────────*/

export type CreateCreditNoteInput = {
  orgId: string;
  contactId: string;
  relatedInvoiceId: string;
  creditNoteDate: string;
  lines: DraftNoteLine[];
  restock?: boolean;
  reason?: string;
  currency?: string;
  exchangeRate?: string;
  userId?: string | null;
};

export async function createCreditNote(
  input: CreateCreditNoteInput,
): Promise<{ creditNoteId: string; creditNoteNumber: string; totalMinor: bigint }> {
  if (input.lines.length === 0)
    throw new LedgerError("A credit note needs at least one line.", "NO_LINES");

  return withOrg(input.orgId, async (tx) => {
    const [customer] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.orgId, input.orgId)));
    if (!customer)
      throw new LedgerError(`Customer ${input.contactId} not found.`, "CONTACT_NOT_FOUND");

    const [org] = await tx
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, input.orgId));

    const rateById = await resolveRates(tx, input.orgId, input.lines);
    const computed = input.lines.map((l) =>
      computeLine(l, l.taxRateId ? (rateById.get(l.taxRateId)?.rateBps ?? null) : null),
    );
    const subtotal = computed.reduce((a, c) => a + c.lineTotalMinor, 0n);
    const taxTotal = computed.reduce((a, c) => a + c.taxAmountMinor, 0n);
    const total = subtotal + taxTotal;
    if (total <= 0n)
      throw new LedgerError(
        `Credit note total is ${total}; must be positive.`,
        "NON_POSITIVE_TOTAL",
      );

    const number = await claimNextNumber(tx, input.orgId, "credit_note");
    const [note] = await tx
      .insert(creditNotes)
      .values({
        orgId: input.orgId,
        contactId: input.contactId,
        creditNoteNumber: number,
        relatedInvoiceId: input.relatedInvoiceId,
        creditNoteDate: input.creditNoteDate,
        status: "draft",
        currency: input.currency ?? customer.currency ?? org.baseCurrency,
        exchangeRate: input.exchangeRate ?? "1",
        subtotalMinor: subtotal,
        taxTotalMinor: taxTotal,
        totalMinor: total,
        restock: input.restock ?? true,
        reason: input.reason ?? null,
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: creditNotes.id });

    await tx.insert(creditNoteLines).values(
      input.lines.map((l, i) => ({
        orgId: input.orgId,
        creditNoteId: note.id,
        lineNumber: i + 1,
        itemId: l.itemId ?? null,
        description: l.description,
        quantity: computed[i].quantity,
        unitPriceMinor: l.unitPriceMinor,
        discountBps: l.discountBps ?? 0,
        taxRateId: computed[i].taxRateId,
        taxAmountMinor: computed[i].taxAmountMinor,
        lineTotalMinor: computed[i].lineTotalMinor,
        revenueAccountId: l.accountId ?? null,
      })),
    );

    await writeAudit(tx, {
      orgId: input.orgId,
      userId: input.userId ?? null,
      action: "credit_note.created",
      entityType: "credit_note",
      entityId: note.id,
      after: { creditNoteNumber: number, totalMinor: total.toString(), status: "draft" },
    });

    return { creditNoteId: note.id, creditNoteNumber: number, totalMinor: total };
  });
}

export async function postCreditNote(args: {
  orgId: string;
  creditNoteId: string;
  userId?: string | null;
}): Promise<{ entryId: string; entryNumber: string }> {
  return withOrg(args.orgId, async (tx) => {
    const [note] = await tx
      .select()
      .from(creditNotes)
      .where(and(eq(creditNotes.id, args.creditNoteId), eq(creditNotes.orgId, args.orgId)));
    if (!note)
      throw new LedgerError(`Credit note ${args.creditNoteId} not found.`, "CREDIT_NOTE_NOT_FOUND");
    if (note.status !== "draft")
      throw new LedgerError(
        `Credit note ${note.creditNoteNumber} is ${note.status}; only drafts post.`,
        "NOTE_NOT_DRAFT",
      );

    // The credit must not exceed what's still open on the invoice.
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, note.relatedInvoiceId!), eq(invoices.orgId, args.orgId)));
    if (!inv) throw new LedgerError(`Related invoice not found.`, "INVOICE_NOT_FOUND");
    const priorCredits = (
      (await tx.execute(sql`
        select coalesce(sum(total_minor), 0) as c
        from credit_notes
        where related_invoice_id = ${inv.id} and status = 'posted'
      `)) as unknown as Array<{ c: string }>
    )[0];
    const outstanding = inv.totalMinor - inv.amountPaidMinor - BigInt(priorCredits.c);
    if (note.totalMinor > outstanding) {
      throw new LedgerError(
        `Credit note ${note.creditNoteNumber} (${note.totalMinor}) exceeds the invoice's open balance (${outstanding}).`,
        "CREDIT_EXCEEDS_BALANCE",
      );
    }

    const lines = await tx
      .select()
      .from(creditNoteLines)
      .where(eq(creditNoteLines.creditNoteId, note.id));
    const arAccountId = await resolveControlAccount(tx, args.orgId, "accounts_receivable");
    const postings: PostingLine[] = [];

    // Reduce the receivable.
    postings.push(
      credit(arAccountId, note.totalMinor, {
        contactId: note.contactId,
        memo: `Credit note ${note.creditNoteNumber}`,
        currency: note.currency,
        exchangeRate: note.exchangeRate,
      }),
    );
    // Reverse revenue per line.
    const revByAccount = new Map<string, bigint>();
    for (const l of lines) {
      const acc =
        l.revenueAccountId ?? (await resolveControlAccount(tx, args.orgId, "operating_revenue"));
      revByAccount.set(acc, (revByAccount.get(acc) ?? 0n) + l.lineTotalMinor);
    }
    for (const [acc, amt] of revByAccount) {
      if (amt > 0n)
        postings.push(
          debit(acc, amt, {
            contactId: note.contactId,
            memo: `Revenue reversal — ${note.creditNoteNumber}`,
          }),
        );
    }
    // Reverse output tax — into the same CGST/SGST/IGST components the sale used.
    if (note.taxTotalMinor > 0n) {
      const gst = await splitOutputGst(tx, args.orgId, note.contactId, note.taxTotalMinor);
      for (const g of gst) {
        postings.push(
          debit(g.accountId, g.amountMinor, {
            contactId: note.contactId,
            memo: `Output ${g.label} reversal — ${note.creditNoteNumber}`,
          }),
        );
      }
    }

    // Restock returned goods at current average cost, reversing COGS.
    const restockPlan: Array<{
      itemId: string;
      warehouseId: string;
      quantity: string;
      valueMinor: bigint;
    }> = [];
    if (note.restock) {
      const warehouseId = await getDefaultWarehouseId(tx, args.orgId);
      const invByAccount = new Map<string, bigint>();
      const cogsByAccount = new Map<string, bigint>();
      for (const l of lines) {
        if (!l.itemId) continue;
        const tracked = await getTrackedItem(tx, args.orgId, l.itemId);
        if (!tracked) continue;
        const avg = await getCurrentAvgCost(tx, args.orgId, l.itemId, warehouseId);
        const qtyScaled = parseQuantity(l.quantity);
        const value = mulDivRound(avg, qtyScaled, 10_000n);
        if (value <= 0n) continue;
        const invAcc =
          tracked.inventoryAccountId ?? (await resolveControlAccount(tx, args.orgId, "inventory"));
        const cogsAcc =
          tracked.cogsAccountId ??
          (await resolveControlAccount(tx, args.orgId, "cost_of_goods_sold"));
        invByAccount.set(invAcc, (invByAccount.get(invAcc) ?? 0n) + value);
        cogsByAccount.set(cogsAcc, (cogsByAccount.get(cogsAcc) ?? 0n) + value);
        restockPlan.push({
          itemId: l.itemId,
          warehouseId,
          quantity: l.quantity,
          valueMinor: value,
        });
      }
      for (const [acc, amt] of invByAccount)
        postings.push(debit(acc, amt, { memo: `Stock returned — ${note.creditNoteNumber}` }));
      for (const [acc, amt] of cogsByAccount)
        postings.push(credit(acc, amt, { memo: `COGS reversal — ${note.creditNoteNumber}` }));
    }

    const entry = await postJournalEntry(
      {
        orgId: args.orgId,
        entryDate: note.creditNoteDate,
        source: "credit_note",
        sourceDocumentId: note.id,
        reference: note.creditNoteNumber,
        memo: `Credit note ${note.creditNoteNumber}`,
        userId: args.userId,
        lines: postings,
      },
      tx,
    );

    for (const r of restockPlan) {
      await receiveStock(tx, {
        orgId: args.orgId,
        itemId: r.itemId,
        warehouseId: r.warehouseId,
        moveDate: note.creditNoteDate,
        quantity: r.quantity,
        valueMinor: r.valueMinor,
        source: "sales_return",
        sourceDocumentId: note.id,
        jeId: entry.entryId,
        userId: args.userId,
      });
    }

    await tx
      .update(creditNotes)
      .set({ status: "posted", journalEntryId: entry.entryId, updatedAt: new Date() })
      .where(eq(creditNotes.id, note.id));

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "credit_note.posted",
      entityType: "credit_note",
      entityId: note.id,
      before: { status: "draft" },
      after: { status: "posted", journalEntryId: entry.entryId },
    });

    return entry;
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Debit notes (purchase returns)
 *
 * Tracked lines are valued at the item's current average cost (you return goods
 * at the cost you carry them at, so weighted-average stays correct and no
 * variance account is needed). Non-tracked lines use the supplied price.
 * ──────────────────────────────────────────────────────────────────────────*/

export type CreateDebitNoteInput = {
  orgId: string;
  contactId: string;
  relatedBillId: string;
  debitNoteDate: string;
  lines: DraftNoteLine[];
  restock?: boolean;
  reason?: string;
  currency?: string;
  exchangeRate?: string;
  userId?: string | null;
};

export async function createDebitNote(
  input: CreateDebitNoteInput,
): Promise<{ debitNoteId: string; debitNoteNumber: string }> {
  if (input.lines.length === 0)
    throw new LedgerError("A debit note needs at least one line.", "NO_LINES");

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

    // Draft amounts are provisional; postDebitNote finalises tracked lines at
    // weighted-average cost. Store the supplied figures for the draft view.
    const rateById = await resolveRates(tx, input.orgId, input.lines);
    const computed = input.lines.map((l) =>
      computeLine(l, l.taxRateId ? (rateById.get(l.taxRateId)?.rateBps ?? null) : null),
    );

    const number = await claimNextNumber(tx, input.orgId, "debit_note");
    const [note] = await tx
      .insert(debitNotes)
      .values({
        orgId: input.orgId,
        contactId: input.contactId,
        debitNoteNumber: number,
        relatedBillId: input.relatedBillId,
        debitNoteDate: input.debitNoteDate,
        status: "draft",
        currency: input.currency ?? vendor.currency ?? org.baseCurrency,
        exchangeRate: input.exchangeRate ?? "1",
        subtotalMinor: computed.reduce((a, c) => a + c.lineTotalMinor, 0n),
        taxTotalMinor: computed.reduce((a, c) => a + c.taxAmountMinor, 0n),
        totalMinor: computed.reduce((a, c) => a + c.lineTotalMinor + c.taxAmountMinor, 0n),
        restock: input.restock ?? true,
        reason: input.reason ?? null,
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: debitNotes.id });

    await tx.insert(debitNoteLines).values(
      input.lines.map((l, i) => ({
        orgId: input.orgId,
        debitNoteId: note.id,
        lineNumber: i + 1,
        itemId: l.itemId ?? null,
        description: l.description,
        quantity: computed[i].quantity,
        unitPriceMinor: l.unitPriceMinor,
        taxRateId: computed[i].taxRateId,
        taxAmountMinor: computed[i].taxAmountMinor,
        lineTotalMinor: computed[i].lineTotalMinor,
        expenseAccountId: l.accountId ?? null,
      })),
    );

    return { debitNoteId: note.id, debitNoteNumber: number };
  });
}

export async function postDebitNote(args: {
  orgId: string;
  debitNoteId: string;
  userId?: string | null;
}): Promise<{ entryId: string; entryNumber: string }> {
  return withOrg(args.orgId, async (tx) => {
    const [note] = await tx
      .select()
      .from(debitNotes)
      .where(and(eq(debitNotes.id, args.debitNoteId), eq(debitNotes.orgId, args.orgId)));
    if (!note)
      throw new LedgerError(`Debit note ${args.debitNoteId} not found.`, "DEBIT_NOTE_NOT_FOUND");
    if (note.status !== "draft")
      throw new LedgerError(
        `Debit note ${note.debitNoteNumber} is ${note.status}; only drafts post.`,
        "NOTE_NOT_DRAFT",
      );

    const lines = await tx
      .select()
      .from(debitNoteLines)
      .where(eq(debitNoteLines.debitNoteId, note.id));
    const rateById = await resolveRates(
      tx,
      args.orgId,
      lines.map((l) => ({
        description: l.description,
        unitPriceMinor: l.unitPriceMinor,
        taxRateId: l.taxRateId,
      })),
    );

    const warehouseId = await getDefaultWarehouseId(tx, args.orgId);
    const creditByAccount = new Map<string, bigint>(); // Inventory or Expense

    // Plan the stock-out first, so the value the ledger credits to Inventory is
    // exactly the value the stock ledger removes (no rounding drift between the
    // two). planStockOut locks the levels; commitStockOut writes them after the JE.
    const issueRequests: IssueRequest[] = [];
    const trackedIdx = new Set<number>();
    const trackedInvAccount: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const tracked = l.itemId ? await getTrackedItem(tx, args.orgId, l.itemId) : null;
      if (tracked) {
        trackedIdx.add(i);
        trackedInvAccount.push(
          tracked.inventoryAccountId ?? (await resolveControlAccount(tx, args.orgId, "inventory")),
        );
        issueRequests.push({
          itemId: l.itemId!,
          quantity: l.quantity,
          memo: `Return — ${note.debitNoteNumber}`,
        });
      }
    }
    const plan = issueRequests.length
      ? await planStockOut(tx, args.orgId, warehouseId, issueRequests)
      : null;

    let subtotal = 0n;
    let taxTotal = 0n;
    let t = 0; // cursor into plan.lines / trackedInvAccount, in line order
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let lineValue: bigint;
      if (trackedIdx.has(i)) {
        lineValue = plan!.lines[t].valueMinor; // exact WA value
        const invAcc = trackedInvAccount[t];
        creditByAccount.set(invAcc, (creditByAccount.get(invAcc) ?? 0n) + lineValue);
        t++;
      } else {
        lineValue = l.lineTotalMinor;
        const acc =
          l.expenseAccountId ?? (await resolveControlAccount(tx, args.orgId, "operating_expense"));
        creditByAccount.set(acc, (creditByAccount.get(acc) ?? 0n) + lineValue);
      }
      const rate = l.taxRateId ? rateById.get(l.taxRateId) : null;
      const tax = rate ? mulDivRound(lineValue, BigInt(rate.rateBps), 10_000n) : 0n;
      subtotal += lineValue;
      taxTotal += tax;
    }
    const total = subtotal + taxTotal;

    // Guard against crediting the vendor more than the bill still owes.
    const [bill] = await tx
      .select()
      .from(bills)
      .where(and(eq(bills.id, note.relatedBillId!), eq(bills.orgId, args.orgId)));
    if (!bill) throw new LedgerError("Related bill not found.", "BILL_NOT_FOUND");
    const priorDebits = (
      (await tx.execute(sql`
        select coalesce(sum(total_minor), 0) as c from debit_notes
        where related_bill_id = ${bill.id} and status = 'posted'
      `)) as unknown as Array<{ c: string }>
    )[0];
    const outstanding = bill.totalMinor - bill.amountPaidMinor - BigInt(priorDebits.c);
    if (total > outstanding) {
      throw new LedgerError(
        `Debit note ${note.debitNoteNumber} (${total}) exceeds the bill's open balance (${outstanding}).`,
        "DEBIT_EXCEEDS_BALANCE",
      );
    }

    const apAccountId = await resolveControlAccount(tx, args.orgId, "accounts_payable");
    const postings: PostingLine[] = [];
    postings.push(
      debit(apAccountId, total, {
        contactId: note.contactId,
        memo: `Debit note ${note.debitNoteNumber}`,
        currency: note.currency,
        exchangeRate: note.exchangeRate,
      }),
    );
    for (const [acc, amt] of creditByAccount) {
      if (amt > 0n)
        postings.push(
          credit(acc, amt, { contactId: note.contactId, memo: `Return — ${note.debitNoteNumber}` }),
        );
    }
    if (taxTotal > 0n) {
      // Debit note = purchase return, so it reverses reclaimed INPUT tax (ITC),
      // crediting the Input GST Credit asset — not the output-tax liability.
      const taxAcc = await resolveInputTaxAccount(tx, args.orgId);
      postings.push(
        credit(taxAcc, taxTotal, {
          contactId: note.contactId,
          memo: `Input tax reversal — ${note.debitNoteNumber}`,
        }),
      );
    }

    const entry = await postJournalEntry(
      {
        orgId: args.orgId,
        entryDate: note.debitNoteDate,
        source: "vendor_credit",
        sourceDocumentId: note.id,
        reference: note.debitNoteNumber,
        memo: `Debit note ${note.debitNoteNumber}`,
        userId: args.userId,
        lines: postings,
      },
      tx,
    );

    if (plan) {
      await commitStockOut(tx, args.orgId, plan, {
        moveDate: note.debitNoteDate,
        source: "purchase_return",
        sourceDocumentId: note.id,
        jeId: entry.entryId,
        userId: args.userId,
      });
    }

    await tx
      .update(debitNotes)
      .set({
        status: "posted",
        journalEntryId: entry.entryId,
        subtotalMinor: subtotal,
        taxTotalMinor: taxTotal,
        totalMinor: total,
        updatedAt: new Date(),
      })
      .where(eq(debitNotes.id, note.id));

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "debit_note.posted",
      entityType: "debit_note",
      entityId: note.id,
      before: { status: "draft" },
      after: { status: "posted", journalEntryId: entry.entryId },
    });

    return entry;
  });
}
