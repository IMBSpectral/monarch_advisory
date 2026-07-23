/**
 * Cost centres, and manual journal entries that can carry them.
 *
 * The posting engine already threads `costCenterId` on every line, so a manual
 * entry tagged with a cost centre flows straight into the dimensional P&L with no
 * special handling.
 */

import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db/client";
import { costCenters } from "@/db/schema";
import { requireAuth, requirePermission } from "@/server/session";
import { credit, debit, postJournalEntry } from "@/server/ledger";
import { getCostCenterPnl, getBudgetVsActual } from "@/server/reports";

function period() {
  // Fiscal year to date. Matches the app's default reporting window.
  const now = new Date();
  const y = now.getUTCFullYear();
  const fyStart = now.getUTCMonth() + 1 >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
  return { from: fyStart, to: now.toISOString().slice(0, 10) };
}

export const fetchCostCenters = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  return withOrg(orgId, (tx) =>
    tx
      .select({ id: costCenters.id, code: costCenters.code, name: costCenters.name, isActive: costCenters.isActive })
      .from(costCenters)
      .where(eq(costCenters.orgId, orgId))
      .orderBy(costCenters.code),
  );
});

export const createCostCenterFn = createServerFn({ method: "POST" })
  .validator(z.object({ code: z.string().min(1).max(40), name: z.string().min(1).max(120) }))
  .handler(async ({ data }) => {
    const p = await requirePermission("settings:manage");
    return withOrg(p.orgId, async (tx) => {
      const [row] = await tx
        .insert(costCenters)
        .values({ orgId: p.orgId, code: data.code.trim(), name: data.name.trim() })
        .returning({ id: costCenters.id });
      return { id: row.id };
    });
  });

export const fetchCostCenterPnl = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  const per = period();
  return withOrg(orgId, async (tx) => {
    const rows = await getCostCenterPnl(tx, orgId, per.from, per.to);
    return rows.map((r) => ({
      name: r.name,
      revenue: r.revenueMinor.toString(),
      expense: r.expenseMinor.toString(),
      net: r.netMinor.toString(),
    }));
  });
});

export const fetchBudgetVsActual = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  const per = period();
  const fiscalYear = Number(per.from.slice(0, 4));
  return withOrg(orgId, async (tx) => {
    const rows = await getBudgetVsActual(tx, orgId, fiscalYear, per.from, per.to);
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      budget: r.budgetMinor.toString(),
      actual: r.actualMinor.toString(),
      variance: r.varianceMinor.toString(),
    }));
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Manual journal entry
 * ──────────────────────────────────────────────────────────────────────────*/

export const createManualEntryFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      entryDate: z.string(),
      memo: z.string().optional(),
      reference: z.string().optional(),
      lines: z
        .array(
          z.object({
            accountId: z.string().uuid(),
            side: z.enum(["debit", "credit"]),
            amountMinor: z.string(),
            costCenterId: z.string().uuid().nullable().optional(),
            memo: z.string().optional(),
          }),
        )
        .min(2),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("ledger:post");
    const lines = data.lines.map((l) => {
      const amt = BigInt(l.amountMinor);
      const rest = { costCenterId: l.costCenterId ?? null, memo: l.memo };
      return l.side === "debit" ? debit(l.accountId, amt, rest) : credit(l.accountId, amt, rest);
    });
    const entry = await postJournalEntry({
      orgId: p.orgId,
      entryDate: data.entryDate,
      source: "manual",
      reference: data.reference ?? null,
      memo: data.memo ?? null,
      userId: p.userId,
      lines,
    });
    return { entryNumber: entry.entryNumber };
  });
