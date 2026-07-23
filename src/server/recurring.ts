/**
 * Recurring invoices.
 *
 * A template stores an invoice's shape and a schedule. The generator materialises
 * a real invoice each time the next-run date falls due, advances the schedule, and
 * repeats until it catches up to "today" — so a monthly template that hasn't run
 * in three months issues three invoices in one pass. Real invoices flow through
 * the normal create/post path, so nothing about the ledger is special-cased.
 */

import { and, eq, lte } from "drizzle-orm";
import { withOrg } from "@/db/client";
import type { DbOrTx } from "@/db/client";
import { contacts, recurringTemplateLines, recurringTemplates } from "@/db/schema";
import { LedgerError, writeAudit } from "./ledger";
import { createInvoice, postInvoice, type DraftInvoiceLine } from "./invoicing";

type Frequency = "weekly" | "monthly" | "quarterly" | "yearly";

/** The next occurrence of `dateStr` at the given cadence. */
export function advance(dateStr: string, frequency: Frequency): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (frequency === "weekly") dt.setUTCDate(dt.getUTCDate() + 7);
  else if (frequency === "monthly") dt.setUTCMonth(dt.getUTCMonth() + 1);
  else if (frequency === "quarterly") dt.setUTCMonth(dt.getUTCMonth() + 3);
  else dt.setUTCFullYear(dt.getUTCFullYear() + 1);
  return dt.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export type RecurringLineInput = {
  itemId?: string | null;
  description: string;
  quantity?: string;
  unitPriceMinor: bigint;
  discountBps?: number;
  taxRateId?: string | null;
  revenueAccountId?: string | null;
};

export async function createRecurringTemplate(input: {
  orgId: string;
  contactId: string;
  name: string;
  frequency: Frequency;
  startDate: string;
  endDate?: string | null;
  dueDays?: number;
  autoPost?: boolean;
  currency?: string;
  lines: RecurringLineInput[];
  userId?: string | null;
}): Promise<{ templateId: string }> {
  if (input.lines.length === 0) throw new LedgerError("A recurring template needs a line.", "NO_LINES");

  return withOrg(input.orgId, async (tx) => {
    const [customer] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.orgId, input.orgId)));
    if (!customer) throw new LedgerError(`Customer ${input.contactId} not found.`, "CONTACT_NOT_FOUND");

    const [tpl] = await tx
      .insert(recurringTemplates)
      .values({
        orgId: input.orgId,
        contactId: input.contactId,
        name: input.name,
        frequency: input.frequency,
        startDate: input.startDate,
        nextRunDate: input.startDate,
        endDate: input.endDate ?? null,
        dueDays: input.dueDays ?? customer.paymentTermDays ?? 30,
        autoPost: input.autoPost ?? true,
        currency: input.currency ?? customer.currency ?? "INR",
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: recurringTemplates.id });

    await tx.insert(recurringTemplateLines).values(
      input.lines.map((l, i) => ({
        orgId: input.orgId,
        templateId: tpl.id,
        lineNumber: i + 1,
        itemId: l.itemId ?? null,
        description: l.description,
        quantity: l.quantity ?? "1",
        unitPriceMinor: l.unitPriceMinor,
        discountBps: l.discountBps ?? 0,
        taxRateId: l.taxRateId ?? null,
        revenueAccountId: l.revenueAccountId ?? null,
      })),
    );

    return { templateId: tpl.id };
  });
}

/**
 * Generate every invoice due on or before `asOf` across all active templates.
 * Catches up multiple periods at once; ends a template once it passes its end
 * date. Returns how many invoices were created.
 */
export async function generateDueInvoices(args: {
  orgId: string;
  asOf: string;
  userId?: string | null;
}): Promise<{ generated: number; invoiceNumbers: string[] }> {
  const templates = await withOrg(args.orgId, (tx) =>
    tx
      .select()
      .from(recurringTemplates)
      .where(
        and(
          eq(recurringTemplates.orgId, args.orgId),
          eq(recurringTemplates.status, "active"),
          lte(recurringTemplates.nextRunDate, args.asOf),
        ),
      ),
  );

  const invoiceNumbers: string[] = [];

  for (const tpl of templates) {
    const lines = await withOrg(args.orgId, (tx) =>
      tx.select().from(recurringTemplateLines).where(eq(recurringTemplateLines.templateId, tpl.id)),
    );
    const draftLines: DraftInvoiceLine[] = lines
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((l) => ({
        itemId: l.itemId,
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
        discountBps: l.discountBps,
        taxRateId: l.taxRateId,
        revenueAccountId: l.revenueAccountId,
      }));

    let runDate = tpl.nextRunDate;
    let lastInvoiceId: string | null = tpl.lastInvoiceId;
    let guard = 0;

    while (runDate <= args.asOf && (!tpl.endDate || runDate <= tpl.endDate) && guard < 120) {
      guard += 1;
      const created = await createInvoice({
        orgId: args.orgId,
        contactId: tpl.contactId,
        invoiceDate: runDate,
        dueDate: addDays(runDate, tpl.dueDays),
        currency: tpl.currency,
        userId: args.userId,
        lines: draftLines,
      });
      if (tpl.autoPost) {
        await postInvoice({ orgId: args.orgId, invoiceId: created.invoiceId, userId: args.userId });
      }
      lastInvoiceId = created.invoiceId;
      invoiceNumbers.push(created.invoiceNumber);
      runDate = advance(runDate, tpl.frequency as Frequency);
      // Advance the schedule after EACH invoice, not once at the end. If a later
      // period throws (e.g. a stock-tracked line goes negative), the invoices
      // already issued stay counted and are never regenerated on the next run.
      const ended = tpl.endDate ? runDate > tpl.endDate : false;
      await withOrg(args.orgId, (tx) =>
        tx
          .update(recurringTemplates)
          .set({ nextRunDate: runDate, lastInvoiceId, status: ended ? "ended" : "active", updatedAt: new Date() })
          .where(eq(recurringTemplates.id, tpl.id)),
      );
    }

    await withOrg(args.orgId, (tx) =>
      writeAudit(tx, {
        orgId: args.orgId,
        userId: args.userId ?? null,
        action: "recurring.generated",
        entityType: "recurring_template",
        entityId: tpl.id,
        after: { nextRunDate: runDate, invoicesCreated: invoiceNumbers.length },
      }),
    );
  }

  return { generated: invoiceNumbers.length, invoiceNumbers };
}
