/**
 * Fixed assets & depreciation.
 *
 * Straight-line only for now: each month charges (cost − salvage) ÷ life to the
 * depreciation-expense account against accumulated depreciation, until the asset
 * is fully depreciated. Every charge is one `depreciation_entries` row plus its
 * share of a posted journal entry, so the register reconciles to the ledger.
 */

import { and, eq, sql } from "drizzle-orm";
import { withOrg } from "@/db/client";
import type { DbOrTx } from "@/db/client";
import { accounts, depreciationEntries, fixedAssets } from "@/db/schema";
import {
  LedgerError,
  credit,
  debit,
  postJournalEntry,
  writeAudit,
  type PostingLine,
} from "./ledger";

/** Round-half-up bigint division. */
function divRound(num: bigint, den: bigint): bigint {
  if (den <= 0n) return 0n;
  const q = num / den;
  const r = num % den;
  return r * 2n >= den ? q + 1n : q;
}

/** First-of-month strings from `fromYM` through `toYM` inclusive. */
function monthStarts(fromDate: string, toDate: string): string[] {
  const [fy, fm] = fromDate.split("-").map(Number);
  const [ty, tm] = toDate.split("-").map(Number);
  const out: string[] = [];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Register a fixed asset
 * ──────────────────────────────────────────────────────────────────────────*/

export async function createFixedAsset(input: {
  orgId: string;
  code: string;
  name: string;
  assetAccountId: string;
  /** Auto-resolved by subtype when omitted. */
  accumulatedAccountId?: string;
  depreciationAccountId?: string;
  acquisitionDate: string;
  costMinor: bigint;
  salvageValueMinor?: bigint;
  usefulLifeMonths: number;
  /** If given, post the acquisition: Dr asset / Cr this account (bank or payable). */
  fundingAccountId?: string | null;
  userId?: string | null;
}): Promise<{ fixedAssetId: string }> {
  if (input.costMinor <= 0n) throw new LedgerError("Asset cost must be positive.", "INVALID_COST");
  if (input.usefulLifeMonths <= 0)
    throw new LedgerError("Useful life must be positive.", "INVALID_LIFE");

  return withOrg(input.orgId, async (tx) => {
    const firstBySubtype = async (subtype: "accumulated_depreciation" | "depreciation_expense") => {
      const [a] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.orgId, input.orgId),
            eq(accounts.subtype, subtype),
            eq(accounts.isGroup, false),
          ),
        )
        .limit(1);
      if (!a) throw new LedgerError(`No ${subtype} account in the chart.`, "ACCOUNT_MISSING");
      return a.id;
    };
    const accumulatedAccountId =
      input.accumulatedAccountId ?? (await firstBySubtype("accumulated_depreciation"));
    const depreciationAccountId =
      input.depreciationAccountId ?? (await firstBySubtype("depreciation_expense"));
    let acquisitionJe: string | null = null;
    if (input.fundingAccountId) {
      const entry = await postJournalEntry(
        {
          orgId: input.orgId,
          entryDate: input.acquisitionDate,
          source: "manual",
          memo: `Acquired ${input.name}`,
          userId: input.userId,
          lines: [
            debit(input.assetAccountId, input.costMinor, { memo: `Asset ${input.code}` }),
            credit(input.fundingAccountId, input.costMinor, { memo: `Paid for ${input.code}` }),
          ],
        },
        tx,
      );
      acquisitionJe = entry.entryId;
    }

    const [row] = await tx
      .insert(fixedAssets)
      .values({
        orgId: input.orgId,
        code: input.code,
        name: input.name,
        assetAccountId: input.assetAccountId,
        accumulatedAccountId,
        depreciationAccountId,
        acquisitionDate: input.acquisitionDate,
        costMinor: input.costMinor,
        salvageValueMinor: input.salvageValueMinor ?? 0n,
        usefulLifeMonths: input.usefulLifeMonths,
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: fixedAssets.id });

    await writeAudit(tx, {
      orgId: input.orgId,
      userId: input.userId ?? null,
      action: "fixed_asset.created",
      entityType: "fixed_asset",
      entityId: row.id,
      after: { code: input.code, costMinor: input.costMinor.toString(), acquisitionJe },
    });

    return { fixedAssetId: row.id };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Depreciation run
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Post depreciation for every active asset through `throughDate` (a month key),
 * skipping months already charged. One journal entry per run; one
 * `depreciation_entries` row per asset-month. Idempotent — re-running charges
 * only the months that are newly due.
 */
export async function runDepreciation(args: {
  orgId: string;
  throughDate: string; // any date in the last month to charge
  userId?: string | null;
}): Promise<{
  entryId: string | null;
  entryNumber: string | null;
  chargedMinor: bigint;
  monthsPosted: number;
}> {
  return withOrg(args.orgId, async (tx) => {
    const assets = await tx
      .select()
      .from(fixedAssets)
      .where(and(eq(fixedAssets.orgId, args.orgId), eq(fixedAssets.status, "active")));

    const postings = new Map<string, bigint>(); // "dr:acct" / "cr:acct" → amount
    const toRecord: Array<{ assetId: string; period: string; amount: bigint }> = [];
    let total = 0n;

    for (const a of assets) {
      const monthly = divRound(a.costMinor - a.salvageValueMinor, BigInt(a.usefulLifeMonths));
      if (monthly <= 0n) continue;

      const priorRows = (await tx.execute(sql`
        select coalesce(sum(amount_minor), 0) as acc, coalesce(count(*), 0) as n
        from depreciation_entries where fixed_asset_id = ${a.id}
      `)) as unknown as Array<{ acc: string; n: string }>;
      let accumulated = BigInt(priorRows[0].acc);
      const maxDeprec = a.costMinor - a.salvageValueMinor;
      if (accumulated >= maxDeprec) continue;

      const existing = (await tx
        .select({ period: depreciationEntries.periodDate })
        .from(depreciationEntries)
        .where(eq(depreciationEntries.fixedAssetId, a.id))) as Array<{ period: string }>;
      const done = new Set(existing.map((e) => e.period));

      for (const period of monthStarts(a.acquisitionDate, args.throughDate)) {
        if (done.has(period)) continue;
        if (accumulated >= maxDeprec) break;
        const amount = accumulated + monthly > maxDeprec ? maxDeprec - accumulated : monthly;
        if (amount <= 0n) break;
        accumulated += amount;
        total += amount;
        postings.set(
          `dr:${a.depreciationAccountId}`,
          (postings.get(`dr:${a.depreciationAccountId}`) ?? 0n) + amount,
        );
        postings.set(
          `cr:${a.accumulatedAccountId}`,
          (postings.get(`cr:${a.accumulatedAccountId}`) ?? 0n) + amount,
        );
        toRecord.push({ assetId: a.id, period, amount });
      }
    }

    if (toRecord.length === 0) {
      return { entryId: null, entryNumber: null, chargedMinor: 0n, monthsPosted: 0 };
    }

    const lines: PostingLine[] = [];
    for (const [key, amt] of postings) {
      const [side, acct] = key.split(":");
      lines.push(
        side === "dr"
          ? debit(acct, amt, { memo: "Depreciation" })
          : credit(acct, amt, { memo: "Accumulated depreciation" }),
      );
    }

    const entry = await postJournalEntry(
      {
        orgId: args.orgId,
        entryDate: monthStarts(args.throughDate, args.throughDate)[0],
        source: "depreciation",
        memo: `Depreciation run through ${args.throughDate}`,
        userId: args.userId,
        lines,
      },
      tx,
    );

    await tx.insert(depreciationEntries).values(
      toRecord.map((r) => ({
        orgId: args.orgId,
        fixedAssetId: r.assetId,
        periodDate: r.period,
        amountMinor: r.amount,
        journalEntryId: entry.entryId,
      })),
    );

    return {
      entryId: entry.entryId,
      entryNumber: entry.entryNumber,
      chargedMinor: total,
      monthsPosted: toRecord.length,
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Disposal
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Retire an asset. Removes its gross cost and accumulated depreciation, brings in
 * any sale proceeds, and books the difference (proceeds − net book value) as a
 * gain or loss on disposal.
 */
export async function disposeFixedAsset(args: {
  orgId: string;
  fixedAssetId: string;
  disposalDate: string;
  proceedsMinor: bigint;
  proceedsAccountId?: string | null; // bank/cash the proceeds land in
  gainLossAccountId: string; // gains credit it, losses debit it
  userId?: string | null;
}): Promise<{ entryId: string; gainLossMinor: bigint }> {
  return withOrg(args.orgId, async (tx) => {
    const [asset] = await tx
      .select()
      .from(fixedAssets)
      .where(and(eq(fixedAssets.id, args.fixedAssetId), eq(fixedAssets.orgId, args.orgId)));
    if (!asset) throw new LedgerError("Fixed asset not found.", "ASSET_NOT_FOUND");
    if (asset.status === "disposed")
      throw new LedgerError(`${asset.code} is already disposed.`, "ALREADY_DISPOSED");
    if (args.proceedsMinor > 0n && !args.proceedsAccountId) {
      throw new LedgerError("Choose where the proceeds are received.", "NO_PROCEEDS_ACCOUNT");
    }

    const accRows = (await tx.execute(sql`
      select coalesce(sum(amount_minor), 0) as acc from depreciation_entries where fixed_asset_id = ${asset.id}
    `)) as unknown as Array<{ acc: string }>;
    const accumulated = BigInt(accRows[0].acc);
    const nbv = asset.costMinor - accumulated;
    const gainLoss = args.proceedsMinor - nbv; // >0 gain, <0 loss

    const lines: PostingLine[] = [
      credit(asset.assetAccountId, asset.costMinor, { memo: `Dispose ${asset.code}` }),
    ];
    if (accumulated > 0n)
      lines.push(
        debit(asset.accumulatedAccountId, accumulated, { memo: "Remove accumulated depreciation" }),
      );
    if (args.proceedsMinor > 0n)
      lines.push(debit(args.proceedsAccountId!, args.proceedsMinor, { memo: "Sale proceeds" }));
    if (gainLoss > 0n)
      lines.push(credit(args.gainLossAccountId, gainLoss, { memo: "Gain on disposal" }));
    else if (gainLoss < 0n)
      lines.push(debit(args.gainLossAccountId, -gainLoss, { memo: "Loss on disposal" }));

    const entry = await postJournalEntry(
      {
        orgId: args.orgId,
        entryDate: args.disposalDate,
        source: "manual",
        memo: `Disposal of ${asset.name}`,
        userId: args.userId,
        lines,
      },
      tx,
    );

    await tx
      .update(fixedAssets)
      .set({ status: "disposed", disposedDate: args.disposalDate, updatedAt: new Date() })
      .where(eq(fixedAssets.id, asset.id));

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "fixed_asset.disposed",
      entityType: "fixed_asset",
      entityId: asset.id,
      after: { proceedsMinor: args.proceedsMinor.toString(), gainLossMinor: gainLoss.toString() },
    });

    return { entryId: entry.entryId, gainLossMinor: gainLoss };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Register
 * ──────────────────────────────────────────────────────────────────────────*/

export type AssetRegisterRow = {
  id: string;
  code: string;
  name: string;
  acquisitionDate: string;
  costMinor: bigint;
  accumulatedMinor: bigint;
  netBookValueMinor: bigint;
  status: string;
  monthlyMinor: bigint;
};

export async function getAssetRegister(tx: DbOrTx, orgId: string): Promise<AssetRegisterRow[]> {
  const rows = (await tx.execute(sql`
    select fa.id, fa.code, fa.name, fa.acquisition_date::text as acq,
           fa.cost_minor, fa.salvage_value_minor, fa.useful_life_months, fa.status::text as status,
           coalesce((select sum(de.amount_minor) from depreciation_entries de where de.fixed_asset_id = fa.id), 0) as accumulated
    from fixed_assets fa
    where fa.org_id = ${orgId}
    order by fa.code
  `)) as unknown as Array<{
    id: string;
    code: string;
    name: string;
    acq: string;
    cost_minor: string;
    salvage_value_minor: string;
    useful_life_months: number;
    status: string;
    accumulated: string;
  }>;

  return rows.map((r) => {
    const cost = BigInt(r.cost_minor);
    const accumulated = BigInt(r.accumulated);
    const salvage = BigInt(r.salvage_value_minor);
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      acquisitionDate: r.acq,
      costMinor: cost,
      accumulatedMinor: accumulated,
      netBookValueMinor: cost - accumulated,
      status: r.status,
      monthlyMinor: divRound(cost - salvage, BigInt(r.useful_life_months)),
    };
  });
}

/**
 * Σ posted depreciation for assets still on the books, for the verify invariant
 * against the accumulated-depreciation balance. Disposed assets are excluded
 * because disposal removes their accumulated depreciation from the ledger.
 */
export async function getTotalDepreciation(tx: DbOrTx, orgId: string): Promise<bigint> {
  const rows = (await tx.execute(sql`
    select coalesce(sum(de.amount_minor), 0) as total
    from depreciation_entries de
    join fixed_assets fa on fa.id = de.fixed_asset_id
    where de.org_id = ${orgId} and fa.status <> 'disposed'
  `)) as unknown as Array<{ total: string }>;
  return BigInt(rows[0].total);
}
