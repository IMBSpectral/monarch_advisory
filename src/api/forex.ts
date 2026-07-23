/**
 * Multi-currency API: exchange-rate management and forex revaluation.
 */

import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db/client";
import { exchangeRates } from "@/db/schema";
import { requireAuth, requirePermission } from "@/server/session";
import { getForexExposure, postForexRevaluation } from "@/server/forex";

const today = () => new Date().toISOString().slice(0, 10);

export const fetchExchangeRates = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  return withOrg(orgId, (tx) =>
    tx
      .select({
        id: exchangeRates.id,
        currencyCode: exchangeRates.currencyCode,
        rateToBase: exchangeRates.rateToBase,
        asOfDate: exchangeRates.asOfDate,
      })
      .from(exchangeRates)
      .where(eq(exchangeRates.orgId, orgId))
      .orderBy(exchangeRates.currencyCode, desc(exchangeRates.asOfDate)),
  );
});

export const upsertExchangeRateFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      currencyCode: z.string().min(3).max(3),
      rateToBase: z.string(),
      asOfDate: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("settings:manage");
    const asOfDate = data.asOfDate || today();
    return withOrg(p.orgId, async (tx) => {
      await tx
        .insert(exchangeRates)
        .values({
          orgId: p.orgId,
          currencyCode: data.currencyCode.toUpperCase(),
          rateToBase: data.rateToBase,
          asOfDate,
        })
        .onConflictDoUpdate({
          target: [exchangeRates.orgId, exchangeRates.currencyCode, exchangeRates.asOfDate],
          set: { rateToBase: data.rateToBase, updatedAt: new Date() },
        });
      return { ok: true };
    });
  });

export const fetchForexExposure = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  return withOrg(orgId, async (tx) => {
    const ex = await getForexExposure(tx, orgId, today());
    return {
      baseCurrency: ex.baseCurrency,
      totalUnrealized: ex.totalUnrealizedMinor.toString(),
      rows: ex.rows.map((r) => ({
        code: r.code,
        name: r.name,
        currency: r.currency,
        foreignBalance: r.foreignBalanceMinor.toString(),
        baseCarrying: r.baseCarryingMinor.toString(),
        rate: r.rate,
        revalued: r.revaluedMinor.toString(),
        unrealized: r.unrealizedMinor.toString(),
      })),
    };
  });
});

export const postForexRevaluationFn = createServerFn({ method: "POST" }).handler(async () => {
  const p = await requirePermission("ledger:post");
  const r = await postForexRevaluation({ orgId: p.orgId, asOf: today(), userId: p.userId });
  return { entryNumber: r.entryNumber, net: r.totalUnrealizedMinor.toString() };
});
