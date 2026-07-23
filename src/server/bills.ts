/**
 * Bills — turning purchase documents into ledger entries.
 *
 * The accounting shape of a bill (the mirror image of an invoice), and why:
 *
 *   Dr  Expense/Asset             subtotal (the cost we incurred)
 *   Dr  GST/VAT Input Credit      tax (reclaimable input tax — an ASSET, because
 *                                     the state owes it back to us, the opposite
 *                                     of output tax on a sale)
 *     Cr  Accounts Payable        total (what we now owe the vendor)
 *
 * And a disbursement against it:
 *
 *   Dr  Accounts Payable          amount (extinguishing what we owe)
 *     Cr  Bank                     amount paid
 *
 * As with invoicing, the expense is recognised when the bill is *posted*, not
 * when it is paid. That's accrual accounting, and it's why AP exists at all.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { withOrg } from "@/db/client";
import type { DbOrTx } from "@/db/client";
import {
  billLines,
  bills,
  contacts,
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
import { getDefaultWarehouseId, getTrackedItem, receiveStock, reverseDocumentStock } from "./inventory";

/* ────────────────────────────────────────────────────────────────────────────
 * Money helpers
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Round-half-up division for bigint money. Used for tax and discount math.
 *
 * Tax on ₹1,234.56 at 18% is ₹222.2208 — someone must decide the final paisa.
 * We round half away from zero, which matches Indian GST rules and what every
 * accountant expects. Doing this in floating point is how bills end up
 * off-by-one-paisa from the vendor's own calculation.
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

export type DraftBillLine = {
  itemId?: string | null;
  description: string;
  /** Decimal string, e.g. "2.5". Kept as string to avoid float on fractional qty. */
  quantity?: string;
  unitPriceMinor: bigint;
  discountBps?: number;
  taxRateId?: string | null;
  expenseAccountId?: string | null;
};

export type CreateBillInput = {
  orgId: string;
  contactId: string;
  billDate: string;
  /** Omitted → derived from the vendor's payment terms. */
  dueDate?: string;
  /** The vendor's own invoice number — needed for GST input credit matching. */
  vendorInvoiceNumber?: string;
  lines: DraftBillLine[];
  currency?: string;
  exchangeRate?: string;
  notes?: string;
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
 * Tax is computed per line, not on the bill total. Different lines carry
 * different rates (18% on goods, 5% on freight), so a total-level calculation
 * would be wrong the moment a bill is mixed-rate.
 */
function computeLine(line: DraftBillLine, rateBps: number | null): ComputedLine {
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
 * Create a draft bill. Drafts have NO ledger impact — nothing is owed until
 * the bill is posted. `postBill` is what touches the books.
 */
export async function createBill(
  input: CreateBillInput,
): Promise<{ billId: string; billNumber: string; totalMinor: bigint }> {
  if (input.lines.length === 0) {
    throw new LedgerError("A bill needs at least one line.", "NO_LINES");
  }

  return withOrg(input.orgId, async (tx) => {
    const [vendor] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.orgId, input.orgId)));

    if (!vendor) {
      throw new LedgerError(
        `Vendor ${input.contactId} not found in this organization.`,
        "CONTACT_NOT_FOUND",
      );
    }
    if (vendor.type === "customer") {
      throw new LedgerError(
        `${vendor.displayName} is a customer, not a vendor. Create an invoice instead.`,
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
        `Bill total is ${total}; must be positive. For refunds, issue a debit note.`,
        "NON_POSITIVE_TOTAL",
      );
    }

    const billNumber = await claimNextNumber(tx, input.orgId, "bill");
    const dueDate = input.dueDate ?? addDays(input.billDate, vendor.paymentTermDays);

    if (dueDate < input.billDate) {
      throw new LedgerError(
        `Due date ${dueDate} precedes bill date ${input.billDate}.`,
        "INVALID_DUE_DATE",
      );
    }

    const [bill] = await tx
      .insert(bills)
      .values({
        orgId: input.orgId,
        contactId: input.contactId,
        billNumber,
        vendorInvoiceNumber: input.vendorInvoiceNumber ?? null,
        billDate: input.billDate,
        dueDate,
        status: "draft",
        currency: input.currency ?? vendor.currency ?? org.baseCurrency,
        exchangeRate: input.exchangeRate ?? "1",
        subtotalMinor: subtotal,
        taxTotalMinor: taxTotal,
        totalMinor: total,
        notes: input.notes ?? null,
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: bills.id });

    await tx.insert(billLines).values(
      input.lines.map((line, i) => ({
        orgId: input.orgId,
        billId: bill.id,
        lineNumber: i + 1,
        itemId: line.itemId ?? null,
        description: line.description,
        quantity: computed[i].quantity,
        unitPriceMinor: line.unitPriceMinor,
        taxRateId: computed[i].taxRateId,
        taxAmountMinor: computed[i].taxAmountMinor,
        lineTotalMinor: computed[i].lineTotalMinor,
        expenseAccountId: line.expenseAccountId ?? null,
      })),
    );

    await writeAudit(tx, {
      orgId: input.orgId,
      userId: input.userId ?? null,
      action: "bill.created",
      entityType: "bill",
      entityId: bill.id,
      after: { billNumber, totalMinor: total.toString(), status: "draft" },
    });

    return { billId: bill.id, billNumber, totalMinor: total };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Post (issue)
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Post a draft bill: recognise the expense and the payable.
 *
 * This is the moment the bill becomes real money in the books.
 */
export async function postBill(args: {
  orgId: string;
  billId: string;
  userId?: string | null;
}): Promise<{ entryId: string; entryNumber: string }> {
  return withOrg(args.orgId, async (tx) => {
    const [bill] = await tx
      .select()
      .from(bills)
      .where(and(eq(bills.id, args.billId), eq(bills.orgId, args.orgId)));

    if (!bill) {
      throw new LedgerError(`Bill ${args.billId} not found.`, "BILL_NOT_FOUND");
    }
    if (bill.status !== "draft") {
      throw new LedgerError(
        `Bill ${bill.billNumber} is ${bill.status}; only drafts can be posted.`,
        "BILL_NOT_DRAFT",
      );
    }

    const lines = await tx.select().from(billLines).where(eq(billLines.billId, bill.id));

    const apAccountId = await resolveControlAccount(tx, args.orgId, "accounts_payable");

    const postings: PostingLine[] = [];

    // Debit expense (or, for stock-tracked lines, Inventory) per line, so the P&L
    // and balance sheet break down correctly. Lines sharing an account are merged
    // to keep entries readable. Tracked lines are collected for a stock receipt,
    // recorded after the entry is posted — at exactly the value debited here, so
    // the Inventory account and the stock value can never drift apart.
    type Receipt = { itemId: string; warehouseId: string; quantity: string; valueMinor: bigint };
    const debitByAccount = new Map<string, bigint>();
    const receipts: Receipt[] = [];
    let warehouseId: string | null = null;

    for (const line of lines) {
      const tracked = line.itemId ? await getTrackedItem(tx, args.orgId, line.itemId) : null;
      if (tracked && bill.stockReceived) {
        // Goods already received via a GRN (Dr Inventory / Cr GRNI). This bill
        // clears the GRNI liability rather than debiting Inventory again, and it
        // does not receive stock a second time.
        const grniAccount = await resolveControlAccount(tx, args.orgId, "goods_received_clearing");
        debitByAccount.set(grniAccount, (debitByAccount.get(grniAccount) ?? 0n) + line.lineTotalMinor);
      } else if (tracked) {
        const invAccount =
          tracked.inventoryAccountId ?? (await resolveControlAccount(tx, args.orgId, "inventory"));
        debitByAccount.set(invAccount, (debitByAccount.get(invAccount) ?? 0n) + line.lineTotalMinor);
        if (!warehouseId) warehouseId = await getDefaultWarehouseId(tx, args.orgId);
        receipts.push({
          itemId: tracked.id,
          warehouseId,
          quantity: line.quantity,
          valueMinor: line.lineTotalMinor,
        });
      } else {
        const accountId =
          line.expenseAccountId ??
          (await resolveControlAccount(tx, args.orgId, "operating_expense"));
        debitByAccount.set(accountId, (debitByAccount.get(accountId) ?? 0n) + line.lineTotalMinor);
      }
    }
    for (const [accountId, amount] of debitByAccount) {
      if (amount === 0n) continue;
      postings.push(
        debit(accountId, amount, {
          contactId: bill.contactId,
          memo: `Bill ${bill.billNumber}`,
          currency: bill.currency,
          exchangeRate: bill.exchangeRate,
        }),
      );
    }

    // Input tax paid is a reclaimable asset, not part of the expense.
    // NOTE: input credit ideally debits a dedicated input-tax asset account,
    // but this chart of accounts does not yet separate input tax from the
    // output-tax liability — both share the single "tax_payable" control
    // account. Debiting it here nets against output tax, which is the correct
    // GST settlement position even if it isn't the cleanest presentation.
    if (bill.taxTotalMinor > 0n) {
      const taxAccountId = await resolveControlAccount(tx, args.orgId, "tax_payable");
      postings.push(
        debit(taxAccountId, bill.taxTotalMinor, {
          contactId: bill.contactId,
          memo: `Input tax — ${bill.billNumber}`,
          currency: bill.currency,
          exchangeRate: bill.exchangeRate,
        }),
      );
    }

    // One credit to AP for the full obligation, tagged with the vendor so aging works.
    postings.push(
      credit(apAccountId, bill.totalMinor, {
        contactId: bill.contactId,
        memo: `Bill ${bill.billNumber}`,
        currency: bill.currency,
        exchangeRate: bill.exchangeRate,
      }),
    );

    const entry = await postJournalEntry(
      {
        orgId: args.orgId,
        entryDate: bill.billDate,
        source: "bill",
        sourceDocumentId: bill.id,
        reference: bill.billNumber,
        memo: `Bill ${bill.billNumber}`,
        userId: args.userId,
        lines: postings,
      },
      tx,
    );

    for (const r of receipts) {
      await receiveStock(tx, {
        orgId: args.orgId,
        itemId: r.itemId,
        warehouseId: r.warehouseId,
        moveDate: bill.billDate,
        quantity: r.quantity,
        valueMinor: r.valueMinor,
        source: "purchase",
        sourceDocumentId: bill.id,
        jeId: entry.entryId,
        userId: args.userId,
      });
    }

    await tx
      .update(bills)
      .set({
        status: "open",
        journalEntryId: entry.entryId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(bills.id, bill.id));

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "bill.posted",
      entityType: "bill",
      entityId: bill.id,
      before: { status: "draft" },
      after: { status: "open", journalEntryId: entry.entryId },
    });

    return entry;
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Payment
 * ──────────────────────────────────────────────────────────────────────────*/

export type RecordVendorPaymentInput = {
  orgId: string;
  contactId: string;
  paymentDate: string;
  amountMinor: bigint;
  /** Bank/cash account the money moved out of. */
  depositAccountId: string;
  /** Which bills this settles, and how much against each. */
  allocations: Array<{ billId: string; amountMinor: bigint }>;
  method?: string;
  referenceNumber?: string;
  notes?: string;
  userId?: string | null;
};

/**
 * Record a vendor disbursement and apply it to bills.
 *
 * Guards that matter here: an allocation may not exceed what the bill still
 * owes (double-applying a payment silently understates AP), and the allocations
 * may not exceed the cash actually paid out.
 */
export async function recordVendorPayment(
  input: RecordVendorPaymentInput,
): Promise<{ paymentId: string; paymentNumber: string; entryId: string }> {
  if (input.amountMinor <= 0n) {
    throw new LedgerError("Payment amount must be positive.", "NON_POSITIVE_PAYMENT");
  }

  const allocTotal = input.allocations.reduce((a, x) => a + x.amountMinor, 0n);
  if (allocTotal > input.amountMinor) {
    throw new LedgerError(
      `Allocations total ${allocTotal} but only ${input.amountMinor} was paid.`,
      "OVER_ALLOCATED",
    );
  }

  return withOrg(input.orgId, async (tx) => {
    const [org] = await tx
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, input.orgId));

    // Lock the target bills so two concurrent payments can't both see the
    // same outstanding balance and both allocate against it.
    for (const alloc of input.allocations) {
      const locked = await tx.execute(sql`
        select id, bill_number, org_id, status, total_minor, amount_paid_minor
        from bills
        where id = ${alloc.billId}
        for update
      `);
      const bill = locked[0] as
        | {
            id: string;
            bill_number: string;
            org_id: string;
            status: string;
            total_minor: string;
            amount_paid_minor: string;
          }
        | undefined;

      if (!bill) {
        throw new LedgerError(`Bill ${alloc.billId} not found.`, "BILL_NOT_FOUND");
      }
      if (bill.org_id !== input.orgId) {
        throw new LedgerError("Bill belongs to a different organization.", "CROSS_TENANT_BILL");
      }
      if (bill.status === "draft") {
        throw new LedgerError(
          `Bill ${bill.bill_number} is still a draft — post it before recording payment.`,
          "BILL_NOT_POSTED",
        );
      }
      if (bill.status === "void") {
        throw new LedgerError(`Bill ${bill.bill_number} is void.`, "BILL_VOID");
      }

      const outstanding = BigInt(bill.total_minor) - BigInt(bill.amount_paid_minor);
      if (alloc.amountMinor > outstanding) {
        throw new LedgerError(
          `Cannot apply ${alloc.amountMinor} to bill ${bill.bill_number}: only ${outstanding} is outstanding.`,
          "ALLOCATION_EXCEEDS_BALANCE",
        );
      }
      if (alloc.amountMinor <= 0n) {
        throw new LedgerError(
          `Allocation to ${bill.bill_number} must be positive.`,
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
        direction: "outbound",
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
          billId: a.billId,
          amountMinor: a.amountMinor,
        })),
      );
    }

    // Update each bill's cached paid amount and derived status.
    for (const alloc of input.allocations) {
      const [updated] = await tx
        .update(bills)
        .set({
          amountPaidMinor: sql`${bills.amountPaidMinor} + ${alloc.amountMinor}`,
          updatedAt: new Date(),
        })
        .where(eq(bills.id, alloc.billId))
        .returning({
          total: bills.totalMinor,
          paid: bills.amountPaidMinor,
          dueDate: bills.dueDate,
        });

      const fullyPaid = updated.paid >= updated.total;
      await tx
        .update(bills)
        .set({
          status: fullyPaid ? "paid" : updated.paid > 0n ? "partially_paid" : "open",
        })
        .where(eq(bills.id, alloc.billId));
    }

    const apAccountId = await resolveControlAccount(tx, input.orgId, "accounts_payable");

    // Payable down, cash out. Unallocated surplus still lands in AP, where it
    // sits as a vendor debit balance — which is exactly what it is (a prepayment).
    const entry = await postJournalEntry(
      {
        orgId: input.orgId,
        entryDate: input.paymentDate,
        source: "bill_payment",
        sourceDocumentId: payment.id,
        reference: paymentNumber,
        memo: `Disbursement ${paymentNumber}`,
        userId: input.userId,
        lines: [
          debit(apAccountId, input.amountMinor, {
            contactId: input.contactId,
            memo: `Applied to payables — ${paymentNumber}`,
          }),
          credit(input.depositAccountId, input.amountMinor, {
            contactId: input.contactId,
            memo: `Disbursement ${paymentNumber}`,
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
 * Void a posted bill by reversing its GL entry.
 *
 * Refuses if any payment has been applied — you cannot void a bill you have
 * partly paid, because that would strand the cash. Reverse the payment or issue
 * a debit note instead.
 */
export async function voidBill(args: {
  orgId: string;
  billId: string;
  reason: string;
  userId?: string | null;
}): Promise<void> {
  const { reverseJournalEntry } = await import("./ledger");

  const [bill] = await withOrg(args.orgId, (tx) =>
    tx
      .select()
      .from(bills)
      .where(and(eq(bills.id, args.billId), eq(bills.orgId, args.orgId))),
  );

  if (!bill) {
    throw new LedgerError(`Bill ${args.billId} not found.`, "BILL_NOT_FOUND");
  }
  if (bill.amountPaidMinor > 0n) {
    throw new LedgerError(
      `Bill ${bill.billNumber} has ${bill.amountPaidMinor} applied against it. Reverse the payment or issue a debit note instead of voiding.`,
      "BILL_HAS_PAYMENTS",
    );
  }

  if (bill.journalEntryId) {
    await reverseJournalEntry({
      orgId: args.orgId,
      entryId: bill.journalEntryId,
      reason: args.reason,
      userId: args.userId,
    });
  }

  await withOrg(args.orgId, async (tx) => {
    // Take the goods back out: the reversing entry already credited Inventory,
    // so this keeps the account/stock identity intact.
    await reverseDocumentStock(tx, {
      orgId: args.orgId,
      sourceDocumentId: args.billId,
      moveDate: new Date().toISOString().slice(0, 10),
      jeId: bill.journalEntryId,
      userId: args.userId,
    });

    await tx
      .update(bills)
      .set({ status: "void", updatedAt: new Date() })
      .where(eq(bills.id, args.billId));

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "bill.voided",
      entityType: "bill",
      entityId: args.billId,
      before: { status: bill.status },
      after: { status: "void" },
      reason: args.reason,
    });
  });
}
