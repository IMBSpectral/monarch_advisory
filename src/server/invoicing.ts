/**
 * Invoicing — turning sales documents into ledger entries.
 *
 * The accounting shape of an invoice, and why:
 *
 *   Dr  Accounts Receivable      total (what the customer now owes us)
 *     Cr  Revenue                subtotal (income earned)
 *     Cr  GST/VAT Payable        tax (collected on the state's behalf — a liability,
 *                                     never income, because we owe it onward)
 *
 * And a receipt against it:
 *
 *   Dr  Bank                     amount received
 *     Cr  Accounts Receivable    amount (extinguishing the claim)
 *
 * Note that revenue is recognised when the invoice is *issued*, not when it is
 * paid. That's accrual accounting, and it's why AR exists as an account at all.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { DbOrTx } from "@/db/client";
import {
  contacts,
  invoiceLines,
  invoices,
  items,
  organizations,
  paymentAllocations,
  payments,
  taxRates,
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

/* ────────────────────────────────────────────────────────────────────────────
 * Money helpers
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Round-half-up division for bigint money. Used for tax and discount math.
 *
 * Tax on ₹1,234.56 at 18% is ₹222.2208 — someone must decide the final paisa.
 * We round half away from zero, which matches Indian GST rules and what every
 * accountant expects. Doing this in floating point is how invoices end up
 * off-by-one-paisa from the customer's own calculation.
 */
function mulDivRound(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scaled = abs * numerator;
  const quotient = scaled / denominator;
  const remainder = scaled % denominator;
  // Round half up: if remainder*2 >= denominator, bump.
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────────*/

export type DraftInvoiceLine = {
  itemId?: string | null;
  description: string;
  /** Decimal string, e.g. "2.5". Kept as string to avoid float on fractional qty. */
  quantity?: string;
  unitPriceMinor: bigint;
  discountBps?: number;
  taxRateId?: string | null;
  revenueAccountId?: string | null;
};

export type CreateInvoiceInput = {
  orgId: string;
  contactId: string;
  invoiceDate: string;
  /** Omitted → derived from the customer's payment terms. */
  dueDate?: string;
  lines: DraftInvoiceLine[];
  currency?: string;
  exchangeRate?: string;
  notes?: string;
  terms?: string;
  userId?: string | null;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Line math
 * ──────────────────────────────────────────────────────────────────────────*/

type ComputedLine = {
  lineTotalMinor: bigint;
  taxAmountMinor: bigint;
  taxRateId: string | null;
  quantity: string;
};

/**
 * Compute one line's net and tax.
 *
 * Tax is computed per line, not on the invoice total. Different lines carry
 * different rates (18% on goods, 5% on freight), so a total-level calculation
 * would be wrong the moment an invoice is mixed-rate.
 */
function computeLine(line: DraftInvoiceLine, rateBps: number | null): ComputedLine {
  const qtyStr = line.quantity ?? "1";
  // Quantity is decimal; scale to 4dp integer to keep the math exact.
  const qtyScaled = BigInt(Math.round(Number(qtyStr) * 10_000));
  if (qtyScaled <= 0n) {
    throw new LedgerError(
      `Line "${line.description}" has quantity ${qtyStr}; must be greater than zero.`,
      "INVALID_QUANTITY",
    );
  }

  const gross = mulDivRound(line.unitPriceMinor, qtyScaled, 10_000n);
  const discountBps = BigInt(line.discountBps ?? 0);
  const discount = mulDivRound(gross, discountBps, 10_000n);
  const net = gross - discount;

  const tax = rateBps ? mulDivRound(net, BigInt(rateBps), 10_000n) : 0n;

  return {
    lineTotalMinor: net,
    taxAmountMinor: tax,
    taxRateId: line.taxRateId ?? null,
    quantity: qtyStr,
  };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Create (draft)
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Create a draft invoice. Drafts have NO ledger impact — nothing is owed until
 * the invoice is issued. `postInvoice` is what touches the books.
 */
export async function createInvoice(
  input: CreateInvoiceInput,
): Promise<{ invoiceId: string; invoiceNumber: string; totalMinor: bigint }> {
  if (input.lines.length === 0) {
    throw new LedgerError("An invoice needs at least one line.", "NO_LINES");
  }

  return db.transaction(async (tx) => {
    const [customer] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.orgId, input.orgId)));

    if (!customer) {
      throw new LedgerError(
        `Customer ${input.contactId} not found in this organization.`,
        "CONTACT_NOT_FOUND",
      );
    }
    if (customer.type === "vendor") {
      throw new LedgerError(
        `${customer.displayName} is a vendor, not a customer. Create a bill instead.`,
        "CONTACT_WRONG_TYPE",
      );
    }

    const [org] = await tx
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, input.orgId));

    // Resolve tax rates up front — one query, not one per line.
    const taxIds = [...new Set(input.lines.map((l) => l.taxRateId).filter(Boolean))] as string[];
    const rates = taxIds.length
      ? await tx
          .select()
          .from(taxRates)
          .where(and(eq(taxRates.orgId, input.orgId), inArray(taxRates.id, taxIds)))
      : [];
    const rateById = new Map(rates.map((r) => [r.id, r]));

    const computed = input.lines.map((line) => {
      const rate = line.taxRateId ? rateById.get(line.taxRateId) : null;
      if (line.taxRateId && !rate) {
        throw new LedgerError(
          `Tax rate ${line.taxRateId} not found in this organization.`,
          "TAX_RATE_NOT_FOUND",
        );
      }
      return computeLine(line, rate?.rateBps ?? null);
    });

    const subtotal = computed.reduce((a, c) => a + c.lineTotalMinor, 0n);
    const taxTotal = computed.reduce((a, c) => a + c.taxAmountMinor, 0n);
    const total = subtotal + taxTotal;

    if (total <= 0n) {
      throw new LedgerError(
        `Invoice total is ${total}; must be positive. For refunds, issue a credit note.`,
        "NON_POSITIVE_TOTAL",
      );
    }

    const invoiceNumber = await claimNextNumber(tx, input.orgId, "invoice");
    const dueDate = input.dueDate ?? addDays(input.invoiceDate, customer.paymentTermDays);

    if (dueDate < input.invoiceDate) {
      throw new LedgerError(
        `Due date ${dueDate} precedes invoice date ${input.invoiceDate}.`,
        "INVALID_DUE_DATE",
      );
    }

    const [invoice] = await tx
      .insert(invoices)
      .values({
        orgId: input.orgId,
        contactId: input.contactId,
        invoiceNumber,
        invoiceDate: input.invoiceDate,
        dueDate,
        status: "draft",
        currency: input.currency ?? customer.currency ?? org.baseCurrency,
        exchangeRate: input.exchangeRate ?? "1",
        subtotalMinor: subtotal,
        taxTotalMinor: taxTotal,
        totalMinor: total,
        notes: input.notes ?? null,
        terms: input.terms ?? null,
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: invoices.id });

    await tx.insert(invoiceLines).values(
      input.lines.map((line, i) => ({
        orgId: input.orgId,
        invoiceId: invoice.id,
        lineNumber: i + 1,
        itemId: line.itemId ?? null,
        description: line.description,
        quantity: computed[i].quantity,
        unitPriceMinor: line.unitPriceMinor,
        discountBps: line.discountBps ?? 0,
        taxRateId: computed[i].taxRateId,
        taxAmountMinor: computed[i].taxAmountMinor,
        lineTotalMinor: computed[i].lineTotalMinor,
        revenueAccountId: line.revenueAccountId ?? null,
      })),
    );

    await writeAudit(tx, {
      orgId: input.orgId,
      userId: input.userId ?? null,
      action: "invoice.created",
      entityType: "invoice",
      entityId: invoice.id,
      after: { invoiceNumber, totalMinor: total.toString(), status: "draft" },
    });

    return { invoiceId: invoice.id, invoiceNumber, totalMinor: total };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Post (issue)
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Issue a draft invoice: recognise the revenue and the receivable.
 *
 * This is the moment the invoice becomes real money in the books.
 */
export async function postInvoice(args: {
  orgId: string;
  invoiceId: string;
  userId?: string | null;
}): Promise<{ entryId: string; entryNumber: string }> {
  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, args.invoiceId), eq(invoices.orgId, args.orgId)));

    if (!invoice) {
      throw new LedgerError(`Invoice ${args.invoiceId} not found.`, "INVOICE_NOT_FOUND");
    }
    if (invoice.status !== "draft") {
      throw new LedgerError(
        `Invoice ${invoice.invoiceNumber} is ${invoice.status}; only drafts can be posted.`,
        "INVOICE_NOT_DRAFT",
      );
    }

    const lines = await tx
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoice.id));

    const arAccountId = await resolveControlAccount(tx, args.orgId, "accounts_receivable");

    const postings: PostingLine[] = [];

    // One debit to AR for the full claim, tagged with the customer so aging works.
    postings.push(
      debit(arAccountId, invoice.totalMinor, {
        contactId: invoice.contactId,
        memo: `Invoice ${invoice.invoiceNumber}`,
        currency: invoice.currency,
        exchangeRate: invoice.exchangeRate,
      }),
    );

    // Credit revenue per line, so the P&L breaks down by revenue account.
    // Lines sharing an account are merged to keep entries readable.
    const revenueByAccount = new Map<string, bigint>();
    for (const line of lines) {
      const accountId =
        line.revenueAccountId ?? (await resolveControlAccount(tx, args.orgId, "operating_revenue"));
      revenueByAccount.set(
        accountId,
        (revenueByAccount.get(accountId) ?? 0n) + line.lineTotalMinor,
      );
    }
    for (const [accountId, amount] of revenueByAccount) {
      if (amount === 0n) continue;
      postings.push(
        credit(accountId, amount, {
          contactId: invoice.contactId,
          memo: `Revenue — ${invoice.invoiceNumber}`,
          currency: invoice.currency,
          exchangeRate: invoice.exchangeRate,
        }),
      );
    }

    // Tax collected is a liability to the tax authority, not revenue.
    if (invoice.taxTotalMinor > 0n) {
      const taxAccountId = await resolveControlAccount(tx, args.orgId, "tax_payable");
      postings.push(
        credit(taxAccountId, invoice.taxTotalMinor, {
          contactId: invoice.contactId,
          memo: `Output tax — ${invoice.invoiceNumber}`,
          currency: invoice.currency,
          exchangeRate: invoice.exchangeRate,
        }),
      );
    }

    const entry = await postJournalEntry(
      {
        orgId: args.orgId,
        entryDate: invoice.invoiceDate,
        source: "invoice",
        sourceDocumentId: invoice.id,
        reference: invoice.invoiceNumber,
        memo: `Invoice ${invoice.invoiceNumber}`,
        userId: args.userId,
        lines: postings,
      },
      tx,
    );

    await tx
      .update(invoices)
      .set({
        status: "sent",
        journalEntryId: entry.entryId,
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoice.id));

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "invoice.posted",
      entityType: "invoice",
      entityId: invoice.id,
      before: { status: "draft" },
      after: { status: "sent", journalEntryId: entry.entryId },
    });

    return entry;
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Payment
 * ──────────────────────────────────────────────────────────────────────────*/

export type RecordPaymentInput = {
  orgId: string;
  contactId: string;
  paymentDate: string;
  amountMinor: bigint;
  depositAccountId: string;
  /** Which invoices this settles, and how much against each. */
  allocations: Array<{ invoiceId: string; amountMinor: bigint }>;
  method?: string;
  referenceNumber?: string;
  notes?: string;
  userId?: string | null;
};

/**
 * Record a customer receipt and apply it to invoices.
 *
 * Guards that matter here: an allocation may not exceed what the invoice still
 * owes (double-applying a payment silently understates AR), and the allocations
 * may not exceed the cash actually received.
 */
export async function recordCustomerPayment(
  input: RecordPaymentInput,
): Promise<{ paymentId: string; paymentNumber: string; entryId: string }> {
  if (input.amountMinor <= 0n) {
    throw new LedgerError("Payment amount must be positive.", "NON_POSITIVE_PAYMENT");
  }

  const allocTotal = input.allocations.reduce((a, x) => a + x.amountMinor, 0n);
  if (allocTotal > input.amountMinor) {
    throw new LedgerError(
      `Allocations total ${allocTotal} but only ${input.amountMinor} was received.`,
      "OVER_ALLOCATED",
    );
  }

  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, input.orgId));

    // Lock the target invoices so two concurrent payments can't both see the
    // same outstanding balance and both allocate against it.
    for (const alloc of input.allocations) {
      const locked = await tx.execute(sql`
        select id, invoice_number, org_id, status, total_minor, amount_paid_minor
        from invoices
        where id = ${alloc.invoiceId}
        for update
      `);
      const inv = locked[0] as
        | {
            id: string;
            invoice_number: string;
            org_id: string;
            status: string;
            total_minor: string;
            amount_paid_minor: string;
          }
        | undefined;

      if (!inv) {
        throw new LedgerError(`Invoice ${alloc.invoiceId} not found.`, "INVOICE_NOT_FOUND");
      }
      if (inv.org_id !== input.orgId) {
        throw new LedgerError(
          "Invoice belongs to a different organization.",
          "CROSS_TENANT_INVOICE",
        );
      }
      if (inv.status === "draft") {
        throw new LedgerError(
          `Invoice ${inv.invoice_number} is still a draft — issue it before recording payment.`,
          "INVOICE_NOT_POSTED",
        );
      }
      if (inv.status === "void") {
        throw new LedgerError(`Invoice ${inv.invoice_number} is void.`, "INVOICE_VOID");
      }

      const outstanding = BigInt(inv.total_minor) - BigInt(inv.amount_paid_minor);
      if (alloc.amountMinor > outstanding) {
        throw new LedgerError(
          `Cannot apply ${alloc.amountMinor} to invoice ${inv.invoice_number}: only ${outstanding} is outstanding.`,
          "ALLOCATION_EXCEEDS_BALANCE",
        );
      }
      if (alloc.amountMinor <= 0n) {
        throw new LedgerError(
          `Allocation to ${inv.invoice_number} must be positive.`,
          "NON_POSITIVE_ALLOCATION",
        );
      }
    }

    const paymentNumber = await claimNextNumber(tx, input.orgId, "payment");

    const [payment] = await tx
      .insert(payments)
      .values({
        orgId: input.orgId,
        contactId: input.contactId,
        direction: "inbound",
        paymentNumber,
        paymentDate: input.paymentDate,
        amountMinor: input.amountMinor,
        currency: org.baseCurrency,
        depositAccountId: input.depositAccountId,
        method: input.method ?? null,
        referenceNumber: input.referenceNumber ?? null,
        notes: input.notes ?? null,
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: payments.id });

    if (input.allocations.length > 0) {
      await tx.insert(paymentAllocations).values(
        input.allocations.map((a) => ({
          orgId: input.orgId,
          paymentId: payment.id,
          invoiceId: a.invoiceId,
          amountMinor: a.amountMinor,
        })),
      );
    }

    // Update each invoice's cached paid amount and derived status.
    for (const alloc of input.allocations) {
      const [updated] = await tx
        .update(invoices)
        .set({
          amountPaidMinor: sql`${invoices.amountPaidMinor} + ${alloc.amountMinor}`,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, alloc.invoiceId))
        .returning({
          total: invoices.totalMinor,
          paid: invoices.amountPaidMinor,
          dueDate: invoices.dueDate,
        });

      const fullyPaid = updated.paid >= updated.total;
      await tx
        .update(invoices)
        .set({
          status: fullyPaid ? "paid" : updated.paid > 0n ? "partially_paid" : "sent",
        })
        .where(eq(invoices.id, alloc.invoiceId));
    }

    const arAccountId = await resolveControlAccount(tx, input.orgId, "accounts_receivable");

    // Cash in, receivable down. Unallocated surplus still lands in AR, where it
    // sits as a customer credit balance — which is exactly what it is.
    const entry = await postJournalEntry(
      {
        orgId: input.orgId,
        entryDate: input.paymentDate,
        source: "invoice_payment",
        sourceDocumentId: payment.id,
        reference: paymentNumber,
        memo: `Receipt ${paymentNumber}`,
        userId: input.userId,
        lines: [
          debit(input.depositAccountId, input.amountMinor, {
            contactId: input.contactId,
            memo: `Receipt ${paymentNumber}`,
          }),
          credit(arAccountId, input.amountMinor, {
            contactId: input.contactId,
            memo: `Applied to receivables — ${paymentNumber}`,
          }),
        ],
      },
      tx,
    );

    await tx
      .update(payments)
      .set({ journalEntryId: entry.entryId })
      .where(eq(payments.id, payment.id));

    await writeAudit(tx, {
      orgId: input.orgId,
      userId: input.userId ?? null,
      action: "payment.recorded",
      entityType: "payment",
      entityId: payment.id,
      after: {
        paymentNumber,
        amountMinor: input.amountMinor.toString(),
        allocationCount: input.allocations.length,
      },
    });

    return { paymentId: payment.id, paymentNumber, entryId: entry.entryId };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Void
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Void an issued invoice by reversing its GL entry.
 *
 * Refuses if any payment has been applied — you cannot void an invoice a
 * customer has partly paid, because that would strand the cash. Refund or
 * credit-note it instead.
 */
export async function voidInvoice(args: {
  orgId: string;
  invoiceId: string;
  reason: string;
  userId?: string | null;
}): Promise<void> {
  const { reverseJournalEntry } = await import("./ledger");

  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, args.invoiceId), eq(invoices.orgId, args.orgId)));

  if (!invoice) {
    throw new LedgerError(`Invoice ${args.invoiceId} not found.`, "INVOICE_NOT_FOUND");
  }
  if (invoice.amountPaidMinor > 0n) {
    throw new LedgerError(
      `Invoice ${invoice.invoiceNumber} has ${invoice.amountPaidMinor} applied against it. Refund the payment or issue a credit note instead of voiding.`,
      "INVOICE_HAS_PAYMENTS",
    );
  }

  if (invoice.journalEntryId) {
    await reverseJournalEntry({
      orgId: args.orgId,
      entryId: invoice.journalEntryId,
      reason: args.reason,
      userId: args.userId,
    });
  }

  await db.transaction(async (tx) => {
    await tx
      .update(invoices)
      .set({ status: "void", voidedAt: new Date(), updatedAt: new Date() })
      .where(eq(invoices.id, args.invoiceId));

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "invoice.voided",
      entityType: "invoice",
      entityId: args.invoiceId,
      before: { status: invoice.status },
      after: { status: "void" },
      reason: args.reason,
    });
  });
}
