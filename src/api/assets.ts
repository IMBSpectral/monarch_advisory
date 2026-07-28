/**
 * Fixed-asset register, depreciation runs and disposals.
 */

import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db/client";
import { accounts } from "@/db/schema";
import { requireAuth, requirePermission } from "@/server/session";
import {
  createFixedAsset,
  runDepreciation,
  disposeFixedAsset,
  getAssetRegister,
} from "@/server/assets";

const today = () => new Date().toISOString().slice(0, 10);

export const fetchFixedAssets = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  const register = await withOrg(orgId, (tx) => getAssetRegister(tx, orgId));
  return register.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    acquisitionDate: r.acquisitionDate,
    cost: r.costMinor.toString(),
    accumulated: r.accumulatedMinor.toString(),
    nbv: r.netBookValueMinor.toString(),
    monthly: r.monthlyMinor.toString(),
    status: r.status,
  }));
});

/** Accounts the create/dispose forms pick from. */
export const fetchAssetAccounts = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: accounts.id,
        code: accounts.code,
        name: accounts.name,
        subtype: accounts.subtype,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.orgId, orgId),
          eq(accounts.isGroup, false),
          eq(accounts.isActive, true),
          inArray(accounts.subtype, [
            "fixed_asset",
            "cash_and_bank",
            "other_income",
            "other_expense",
          ]),
        ),
      )
      .orderBy(accounts.code);
    return {
      fixedAsset: rows
        .filter((r) => r.subtype === "fixed_asset")
        .map((r) => ({ id: r.id, name: r.name })),
      cash: rows
        .filter((r) => r.subtype === "cash_and_bank")
        .map((r) => ({ id: r.id, name: r.name })),
      gainLoss: rows
        .filter((r) => r.subtype === "other_income" || r.subtype === "other_expense")
        .map((r) => ({ id: r.id, name: r.name })),
    };
  });
});

export const createFixedAssetFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      assetAccountId: z.string().uuid(),
      acquisitionDate: z.string(),
      costMinor: z.string(),
      salvageValueMinor: z.string().optional(),
      usefulLifeMonths: z.number().int().positive(),
      fundingAccountId: z.string().uuid().nullable().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("ledger:post");
    const r = await createFixedAsset({
      orgId: p.orgId,
      code: data.code,
      name: data.name,
      assetAccountId: data.assetAccountId,
      acquisitionDate: data.acquisitionDate,
      costMinor: BigInt(data.costMinor),
      salvageValueMinor: data.salvageValueMinor ? BigInt(data.salvageValueMinor) : 0n,
      usefulLifeMonths: data.usefulLifeMonths,
      fundingAccountId: data.fundingAccountId ?? null,
      userId: p.userId,
    });
    return { id: r.fixedAssetId };
  });

export const runDepreciationFn = createServerFn({ method: "POST" }).handler(async () => {
  const p = await requirePermission("ledger:post");
  const r = await runDepreciation({ orgId: p.orgId, throughDate: today(), userId: p.userId });
  return {
    monthsPosted: r.monthsPosted,
    charged: r.chargedMinor.toString(),
    entryNumber: r.entryNumber,
  };
});

export const disposeFixedAssetFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      fixedAssetId: z.string().uuid(),
      disposalDate: z.string(),
      proceedsMinor: z.string(),
      proceedsAccountId: z.string().uuid().nullable().optional(),
      gainLossAccountId: z.string().uuid(),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("ledger:post");
    const r = await disposeFixedAsset({
      orgId: p.orgId,
      fixedAssetId: data.fixedAssetId,
      disposalDate: data.disposalDate,
      proceedsMinor: BigInt(data.proceedsMinor),
      proceedsAccountId: data.proceedsAccountId ?? null,
      gainLossAccountId: data.gainLossAccountId,
      userId: p.userId,
    });
    return { gainLoss: r.gainLossMinor.toString() };
  });
