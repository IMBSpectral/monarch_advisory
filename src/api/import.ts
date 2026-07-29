/**
 * CSV import endpoints. The client parses the CSV (see `@/lib/csv`) and posts rows
 * as objects keyed by lower-cased header; the row-by-row logic lives in
 * `@/server/import` so it can be tested directly.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePermission } from "@/server/session";
import { importContacts, importItems } from "@/server/import";

export type { ImportResult } from "@/server/import";

const rowsValidator = z.object({
  rows: z.array(z.record(z.string(), z.string())).min(1).max(1000),
});

export const importContactsFn = createServerFn({ method: "POST" })
  .validator(rowsValidator)
  .handler(async ({ data }) => {
    const p = await requirePermission("contact:manage");
    return importContacts(p.orgId, data.rows, p.userId);
  });

export const importItemsFn = createServerFn({ method: "POST" })
  .validator(rowsValidator)
  .handler(async ({ data }) => {
    const p = await requirePermission("item:manage");
    return importItems(p.orgId, data.rows, p.userId);
  });
