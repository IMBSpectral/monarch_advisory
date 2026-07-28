/**
 * Period close/reopen and multi-entity consolidation.
 */

import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db/client";
import { memberships, organizations } from "@/db/schema";
import { requireAuth, requirePermission } from "@/server/session";
import { getPeriodStatus, closePeriod, reopenPeriod } from "@/server/period";
import { getBalanceSheet, getProfitAndLoss } from "@/server/reports";

function fiscalPeriod() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const from = now.getUTCMonth() + 1 >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
  return { from, to: now.toISOString().slice(0, 10) };
}

export const fetchPeriodStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  return withOrg(orgId, (tx) => getPeriodStatus(tx, orgId));
});

export const closePeriodFn = createServerFn({ method: "POST" })
  .validator(z.object({ throughDate: z.string() }))
  .handler(async ({ data }) => {
    const p = await requirePermission("period:close");
    const r = await closePeriod({
      orgId: p.orgId,
      throughDate: data.throughDate,
      userId: p.userId,
    });
    return { entryNumber: r.entryNumber, netProfit: r.netProfitMinor.toString() };
  });

export const reopenPeriodFn = createServerFn({ method: "POST" })
  .validator(z.object({ reason: z.string().min(1) }))
  .handler(async ({ data }) => {
    const p = await requirePermission("period:close");
    const r = await reopenPeriod({ orgId: p.orgId, reason: data.reason, userId: p.userId });
    return { reversed: r.reversedEntryNumber };
  });

/**
 * Roll every organisation the signed-in user belongs to into one view — a group
 * consolidation. Each entity is read in its own tenant-scoped transaction, so RLS
 * still applies per org; the API just aggregates the results the user is entitled
 * to see.
 */
export const fetchConsolidation = createServerFn({ method: "GET" }).handler(async () => {
  const { userId } = await requireAuth();
  const per = fiscalPeriod();

  // memberships is an identity table (deliberately outside RLS — it resolves the
  // tenant), so it's read on the bare handle, scoped by the authenticated user.
  // organizations IS under RLS, so its name is read inside each org's context.
  const { db } = await import("@/db/client");
  const orgIds = (
    await db
      .select({ orgId: memberships.orgId })
      .from(memberships)
      .where(eq(memberships.userId, userId))
  ).map((r) => r.orgId);

  const entities: Array<{
    name: string;
    assets: string;
    liabilities: string;
    equity: string;
    revenue: string;
    netProfit: string;
  }> = [];
  for (const orgId of orgIds) {
    const entity = await withOrg(orgId, async (tx) => {
      const [org] = await tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgId));
      const bs = await getBalanceSheet(tx, orgId, per.to);
      const pnl = await getProfitAndLoss(tx, orgId, per.from, per.to);
      return {
        name: org?.name ?? "—",
        assets: bs.totalAssetsMinor.toString(),
        liabilities: bs.totalLiabilitiesMinor.toString(),
        equity: bs.totalEquityMinor.toString(),
        revenue: pnl.totalRevenueMinor.toString(),
        netProfit: pnl.netProfitMinor.toString(),
      };
    });
    entities.push(entity);
  }

  const sum = (k: "assets" | "liabilities" | "equity" | "revenue" | "netProfit") =>
    entities.reduce((a, e) => a + BigInt(e[k]), 0n).toString();

  return {
    from: per.from,
    to: per.to,
    entities,
    consolidated: {
      assets: sum("assets"),
      liabilities: sum("liabilities"),
      equity: sum("equity"),
      revenue: sum("revenue"),
      netProfit: sum("netProfit"),
    },
  };
});
