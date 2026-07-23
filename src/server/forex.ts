/**
 * Multi-currency: exchange rates and forex revaluation.
 *
 * Foreign-currency accounts carry two balances on the ledger: `amount_minor` in
 * the org's base currency (what reports sum) and `original_amount_minor` in the
 * account's own currency. Over time the base value drifts from what the foreign
 * balance is worth at today's rate — that unrealised difference is a forex gain
 * or loss, recognised by posting a revaluation entry that trues up the base
 * carrying value against the foreign balance × current rate.
 */

import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { withOrg } from "@/db/client";
import type { DbOrTx } from "@/db/client";
import { accounts, exchangeRates, organizations } from "@/db/schema";
import {
  LedgerError,
  credit,
  debit,
  postJournalEntry,
  resolveControlAccount,
  writeAudit,
  type PostingLine,
} from "./ledger";

/** Latest rate for a currency on or before `asOf`. Base currency is always 1. */
export async function latestRate(
  tx: DbOrTx,
  orgId: string,
  currency: string,
  base: string,
  asOf: string,
): Promise<number | null> {
  if (currency === base) return 1;
  const [row] = await tx
    .select({ rate: exchangeRates.rateToBase })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.orgId, orgId),
        eq(exchangeRates.currencyCode, currency),
        lte(exchangeRates.asOfDate, asOf),
      ),
    )
    .orderBy(desc(exchangeRates.asOfDate))
    .limit(1);
  return row ? Number(row.rate) : null;
}

export type ForexExposureRow = {
  accountId: string;
  code: string;
  name: string;
  currency: string;
  foreignBalanceMinor: bigint;
  baseCarryingMinor: bigint;
  rate: number | null;
  revaluedMinor: bigint;
  unrealizedMinor: bigint; // revalued − carrying (>0 gain, <0 loss)
};

/** Every foreign-currency account's carrying value vs its value at today's rate. */
export async function getForexExposure(
  tx: DbOrTx,
  orgId: string,
  asOf: string,
): Promise<{ rows: ForexExposureRow[]; totalUnrealizedMinor: bigint; baseCurrency: string }> {
  const [org] = await tx
    .select({ baseCurrency: organizations.baseCurrency })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const base = org?.baseCurrency ?? "INR";

  const fxAccounts = await tx
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), isNotNull(accounts.currency)))
    .orderBy(accounts.code);

  const rows: ForexExposureRow[] = [];
  for (const a of fxAccounts) {
    if (!a.currency || a.currency === base) continue;
    const balRows = (await tx.execute(sql`
      select coalesce(sum(jl.amount_minor), 0) as base_bal,
             coalesce(sum(jl.original_amount_minor), 0) as fx_bal
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      where jl.account_id = ${a.id} and jl.org_id = ${orgId}
        and je.status in ('posted','reversed') and je.entry_date <= ${asOf}
    `)) as unknown as Array<{ base_bal: string; fx_bal: string }>;

    const baseCarrying = BigInt(balRows[0].base_bal);
    const foreignBalance = BigInt(balRows[0].fx_bal);
    const rate = await latestRate(tx, orgId, a.currency, base, asOf);
    // revalued base = foreign minor units × rate (minor→minor, so rate applies directly)
    const revalued = rate === null ? baseCarrying : BigInt(Math.round(Number(foreignBalance) * rate));
    rows.push({
      accountId: a.id,
      code: a.code,
      name: a.name,
      currency: a.currency,
      foreignBalanceMinor: foreignBalance,
      baseCarryingMinor: baseCarrying,
      rate,
      revaluedMinor: revalued,
      unrealizedMinor: revalued - baseCarrying,
    });
  }

  return {
    rows,
    totalUnrealizedMinor: rows.reduce((a, r) => a + r.unrealizedMinor, 0n),
    baseCurrency: base,
  };
}

/**
 * Post a revaluation entry that trues every foreign account's base carrying value
 * up (or down) to its value at `asOf`'s rate, with the net difference recognised
 * as forex gain/loss. The foreign balances are untouched (originalAmount 0).
 */
export async function postForexRevaluation(args: {
  orgId: string;
  asOf: string;
  userId?: string | null;
}): Promise<{ entryId: string; entryNumber: string; totalUnrealizedMinor: bigint }> {
  return withOrg(args.orgId, async (tx) => {
    const exposure = await getForexExposure(tx, args.orgId, args.asOf);
    const movers = exposure.rows.filter((r) => r.unrealizedMinor !== 0n);
    if (movers.length === 0) {
      throw new LedgerError("No unrealised forex gain or loss to revalue.", "NO_REVALUATION");
    }

    const forexAccount = await resolveControlAccount(tx, args.orgId, "other_income");
    const postings: PostingLine[] = [];
    let net = 0n;
    for (const r of movers) {
      const d = r.unrealizedMinor;
      net += d;
      const rest = { currency: r.currency, exchangeRate: String(r.rate ?? 1), originalAmountMinor: 0n, memo: `FX revaluation — ${r.code}` };
      postings.push(d > 0n ? debit(r.accountId, d, rest) : credit(r.accountId, -d, rest));
    }
    // Offset the net into forex gain/loss. Net gain → credit income; net loss → debit.
    postings.push(
      net > 0n
        ? credit(forexAccount, net, { memo: "Forex gain (unrealised)" })
        : debit(forexAccount, -net, { memo: "Forex loss (unrealised)" }),
    );

    const entry = await postJournalEntry(
      {
        orgId: args.orgId,
        entryDate: args.asOf,
        source: "fx_revaluation",
        memo: `Forex revaluation as of ${args.asOf}`,
        userId: args.userId,
        lines: postings,
      },
      tx,
    );

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "forex.revalued",
      entityType: "journal_entry",
      entityId: entry.entryId,
      after: { asOf: args.asOf, netUnrealizedMinor: net.toString(), accounts: movers.length },
    });

    return { entryId: entry.entryId, entryNumber: entry.entryNumber, totalUnrealizedMinor: net };
  });
}
