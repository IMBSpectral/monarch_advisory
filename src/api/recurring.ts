/**
 * Recurring invoice templates and the "generate due" runner.
 */

import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db/client";
import { contacts, recurringTemplates } from "@/db/schema";
import { requireAuth, requirePermission } from "@/server/session";
import { createRecurringTemplate, generateDueInvoices } from "@/server/recurring";

const line = z.object({
  itemId: z.string().uuid().nullable().optional(),
  description: z.string().min(1),
  quantity: z.string().optional(),
  unitPriceMinor: z.string(),
  taxRateId: z.string().uuid().nullable().optional(),
  revenueAccountId: z.string().uuid().nullable().optional(),
});

export const fetchRecurringTemplates = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  return withOrg(orgId, (tx) =>
    tx
      .select({
        id: recurringTemplates.id,
        name: recurringTemplates.name,
        frequency: recurringTemplates.frequency,
        nextRunDate: recurringTemplates.nextRunDate,
        endDate: recurringTemplates.endDate,
        status: recurringTemplates.status,
        autoPost: recurringTemplates.autoPost,
        customer: contacts.displayName,
      })
      .from(recurringTemplates)
      .innerJoin(contacts, eq(contacts.id, recurringTemplates.contactId))
      .where(eq(recurringTemplates.orgId, orgId))
      .orderBy(desc(recurringTemplates.nextRunDate)),
  );
});

export const createRecurringTemplateFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      contactId: z.string().uuid(),
      name: z.string().min(1),
      frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
      startDate: z.string(),
      endDate: z.string().optional(),
      autoPost: z.boolean().optional(),
      lines: z.array(line).min(1),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("document:create");
    const r = await createRecurringTemplate({
      orgId: p.orgId,
      contactId: data.contactId,
      name: data.name,
      frequency: data.frequency,
      startDate: data.startDate,
      endDate: data.endDate || null,
      autoPost: data.autoPost ?? true,
      userId: p.userId,
      lines: data.lines.map((l) => ({ ...l, unitPriceMinor: BigInt(l.unitPriceMinor) })),
    });
    return { id: r.templateId };
  });

export const generateDueInvoicesFn = createServerFn({ method: "POST" }).handler(async () => {
  const p = await requirePermission("ledger:post");
  const r = await generateDueInvoices({
    orgId: p.orgId,
    asOf: new Date().toISOString().slice(0, 10),
    userId: p.userId,
  });
  return { generated: r.generated, invoiceNumbers: r.invoiceNumbers };
});
