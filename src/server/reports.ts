/**
 * Financial reports.
 *
 * Every function here derives its numbers by aggregating `journal_lines`. None of
 * them read a cached balance off a document. That is the whole design: if the
 * ledger says it, the report says it, and the two can never disagree.
 *
 * Sign convention reminder: journal_lines.amount_minor is positive for debits,
 * negative for credits. So for any account:
 *
 *   SUM(amount_minor) > 0  → net debit balance  (normal for assets, expenses)
 *   SUM(amount_minor) < 0  → net credit balance (normal for liabilities, equity, income)
 *
 * Reports flip the sign on credit-normal accounts so users see positive numbers
 * where they expect them — revenue of ₹48L reads as 4875000000, not -4875000000.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db/client";

/** Reversed entries and their reversals both stay in the ledger and net to zero,
 *  so both are included. Only drafts are excluded. */
const POSTED = sql`je.status in ('posted', 'reversed')`;

type Row = Record<string, string | null>;

const toBig = (v: string | null | undefined): bigint => BigInt(v ?? "0");

/* ────────────────────────────────────────────────────────────────────────────
 * Trial balance
 * ──────────────────────────────────────────────────────────────────────────*/

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  debitMinor: bigint;
  creditMinor: bigint;
};

/**
 * Trial balance as of a date. The classic proof that the books are internally
 * consistent: total debits must equal total credits.
 *
 * `asOf` is inclusive.
 */
export async function getTrialBalance(
  orgId: string,
  asOf: string,
): Promise<{
  rows: TrialBalanceRow[];
  totalDebitMinor: bigint;
  totalCreditMinor: bigint;
  isBalanced: boolean;
}> {
  const result = await db.execute(sql`
    select a.id      as account_id,
           a.code    as code,
           a.name    as name,
           a.type::text    as type,
           a.subtype::text as subtype,
           sum(jl.amount_minor) as net
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a         on a.id = jl.account_id
    where jl.org_id = ${orgId}
      and ${POSTED}
      and je.entry_date <= ${asOf}
    group by a.id, a.code, a.name, a.type, a.subtype
    having sum(jl.amount_minor) <> 0
    order by a.code
  `);

  const rows: TrialBalanceRow[] = (result as unknown as Row[]).map((r) => {
    const net = toBig(r.net);
    return {
      accountId: r.account_id!,
      code: r.code!,
      name: r.name!,
      type: r.type!,
      subtype: r.subtype!,
      // A net debit shows in the debit column, a net credit in the credit column.
      debitMinor: net > 0n ? net : 0n,
      creditMinor: net < 0n ? -net : 0n,
    };
  });

  const totalDebitMinor = rows.reduce((a, r) => a + r.debitMinor, 0n);
  const totalCreditMinor = rows.reduce((a, r) => a + r.creditMinor, 0n);

  return {
    rows,
    totalDebitMinor,
    totalCreditMinor,
    // Should be structurally impossible to fail, given the posting engine.
    isBalanced: totalDebitMinor === totalCreditMinor,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Profit & Loss
 * ──────────────────────────────────────────────────────────────────────────*/

export type PnlLine = {
  accountId: string;
  code: string;
  name: string;
  subtype: string;
  amountMinor: bigint;
};

export type ProfitAndLoss = {
  from: string;
  to: string;
  revenue: PnlLine[];
  costOfGoodsSold: PnlLine[];
  operatingExpenses: PnlLine[];
  otherIncome: PnlLine[];
  otherExpenses: PnlLine[];
  totalRevenueMinor: bigint;
  totalCogsMinor: bigint;
  grossProfitMinor: bigint;
  totalOperatingExpenseMinor: bigint;
  operatingProfitMinor: bigint;
  netProfitMinor: bigint;
};

/**
 * P&L for a period. Income and expense accounts only — balance sheet accounts
 * carry forward, P&L accounts reset each fiscal year.
 */
export async function getProfitAndLoss(
  orgId: string,
  from: string,
  to: string,
): Promise<ProfitAndLoss> {
  const result = await db.execute(sql`
    select a.id      as account_id,
           a.code    as code,
           a.name    as name,
           a.type::text    as type,
           a.subtype::text as subtype,
           sum(jl.amount_minor) as net
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a         on a.id = jl.account_id
    where jl.org_id = ${orgId}
      and ${POSTED}
      and je.entry_date between ${from} and ${to}
      and a.type in ('income', 'expense')
    group by a.id, a.code, a.name, a.type, a.subtype
    having sum(jl.amount_minor) <> 0
    order by a.code
  `);

  const revenue: PnlLine[] = [];
  const costOfGoodsSold: PnlLine[] = [];
  const operatingExpenses: PnlLine[] = [];
  const otherIncome: PnlLine[] = [];
  const otherExpenses: PnlLine[] = [];

  for (const r of result as unknown as Row[]) {
    const net = toBig(r.net);
    // Income is credit-normal (negative net) — flip so revenue reads positive.
    // Expenses are debit-normal (positive net) — already positive.
    const amountMinor = r.type === "income" ? -net : net;
    const line: PnlLine = {
      accountId: r.account_id!,
      code: r.code!,
      name: r.name!,
      subtype: r.subtype!,
      amountMinor,
    };

    switch (r.subtype) {
      case "operating_revenue":
        revenue.push(line);
        break;
      case "other_income":
        otherIncome.push(line);
        break;
      case "cost_of_goods_sold":
        costOfGoodsSold.push(line);
        break;
      case "operating_expense":
      case "depreciation_expense":
        operatingExpenses.push(line);
        break;
      default:
        otherExpenses.push(line);
    }
  }

  const sum = (lines: PnlLine[]) => lines.reduce((a, l) => a + l.amountMinor, 0n);

  const totalRevenueMinor = sum(revenue);
  const totalCogsMinor = sum(costOfGoodsSold);
  const grossProfitMinor = totalRevenueMinor - totalCogsMinor;
  const totalOperatingExpenseMinor = sum(operatingExpenses);
  const operatingProfitMinor = grossProfitMinor - totalOperatingExpenseMinor;
  const netProfitMinor = operatingProfitMinor + sum(otherIncome) - sum(otherExpenses);

  return {
    from,
    to,
    revenue,
    costOfGoodsSold,
    operatingExpenses,
    otherIncome,
    otherExpenses,
    totalRevenueMinor,
    totalCogsMinor,
    grossProfitMinor,
    totalOperatingExpenseMinor,
    operatingProfitMinor,
    netProfitMinor,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Balance sheet
 * ──────────────────────────────────────────────────────────────────────────*/

export type BalanceSheetLine = {
  accountId: string;
  code: string;
  name: string;
  subtype: string;
  amountMinor: bigint;
};

export type BalanceSheet = {
  asOf: string;
  assets: BalanceSheetLine[];
  liabilities: BalanceSheetLine[];
  equity: BalanceSheetLine[];
  totalAssetsMinor: bigint;
  totalLiabilitiesMinor: bigint;
  totalEquityMinor: bigint;
  /** Cumulative net profit, which is equity but lives in P&L accounts until closed. */
  retainedEarningsMinor: bigint;
  isBalanced: boolean;
};

/**
 * Balance sheet as of a date.
 *
 * The subtlety: current-year profit belongs in equity, but it lives in income and
 * expense accounts until a year-end close moves it. So we compute it on the fly
 * and add it to equity — otherwise the sheet would not balance. This is why
 * "Retained Earnings" appears here as a computed line rather than a queried one.
 */
export async function getBalanceSheet(orgId: string, asOf: string): Promise<BalanceSheet> {
  const result = await db.execute(sql`
    select a.id      as account_id,
           a.code    as code,
           a.name    as name,
           a.type::text    as type,
           a.subtype::text as subtype,
           sum(jl.amount_minor) as net
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a         on a.id = jl.account_id
    where jl.org_id = ${orgId}
      and ${POSTED}
      and je.entry_date <= ${asOf}
      and a.type in ('asset', 'liability', 'equity')
    group by a.id, a.code, a.name, a.type, a.subtype
    having sum(jl.amount_minor) <> 0
    order by a.code
  `);

  const assets: BalanceSheetLine[] = [];
  const liabilities: BalanceSheetLine[] = [];
  const equity: BalanceSheetLine[] = [];

  for (const r of result as unknown as Row[]) {
    const net = toBig(r.net);
    // Assets are debit-normal; liabilities and equity are credit-normal.
    const amountMinor = r.type === "asset" ? net : -net;
    const line: BalanceSheetLine = {
      accountId: r.account_id!,
      code: r.code!,
      name: r.name!,
      subtype: r.subtype!,
      amountMinor,
    };
    if (r.type === "asset") assets.push(line);
    else if (r.type === "liability") liabilities.push(line);
    else equity.push(line);
  }

  // Net profit from the beginning of time through asOf. Not year-scoped, because
  // any pre-close profit from prior years is equally unclosed.
  const [profitRow] = (await db.execute(sql`
    select coalesce(sum(jl.amount_minor), 0) as net
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a         on a.id = jl.account_id
    where jl.org_id = ${orgId}
      and ${POSTED}
      and je.entry_date <= ${asOf}
      and a.type in ('income', 'expense')
  `)) as unknown as Row[];

  // Income/expense net is debit-positive; profit is the credit side, so negate.
  const retainedEarningsMinor = -toBig(profitRow?.net);

  const sum = (l: BalanceSheetLine[]) => l.reduce((a, x) => a + x.amountMinor, 0n);

  const totalAssetsMinor = sum(assets);
  const totalLiabilitiesMinor = sum(liabilities);
  const totalEquityMinor = sum(equity) + retainedEarningsMinor;

  return {
    asOf,
    assets,
    liabilities,
    equity,
    totalAssetsMinor,
    totalLiabilitiesMinor,
    totalEquityMinor,
    retainedEarningsMinor,
    // The accounting equation. If this is ever false, the ledger is corrupt.
    isBalanced: totalAssetsMinor === totalLiabilitiesMinor + totalEquityMinor,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Aging
 * ──────────────────────────────────────────────────────────────────────────*/

export type AgingRow = {
  contactId: string;
  contactName: string;
  currentMinor: bigint;
  days1to30Minor: bigint;
  days31to60Minor: bigint;
  days61to90Minor: bigint;
  over90Minor: bigint;
  totalMinor: bigint;
};

/**
 * Accounts receivable aging — who owes us, and how late.
 *
 * Buckets are by days past *due date*, not invoice date, which is what
 * collections teams actually chase on.
 *
 * AS-OF CORRECTNESS: outstanding is computed from allocations whose payment
 * settled on or before `asOf` — NOT from `invoices.amount_paid_minor`, which is a
 * running total with no date dimension. Using the cached column makes an aging
 * report run for June silently subtract payments received in August, and the
 * total then disagrees with the A/R control account in the trial balance.
 * `verify.ts` asserts those two agree, which is how this was caught.
 */
export async function getReceivablesAging(
  orgId: string,
  asOf: string,
): Promise<{ rows: AgingRow[]; totals: Omit<AgingRow, "contactId" | "contactName"> }> {
  const result = await db.execute(sql`
    with paid_as_of as (
      select pa.invoice_id,
             sum(pa.amount_minor) as paid_minor
      from payment_allocations pa
      join payments p on p.id = pa.payment_id
      where pa.deleted_at is null
        and p.payment_date <= ${asOf}
      group by pa.invoice_id
    ),
    outstanding as (
      select i.contact_id,
             c.display_name,
             i.total_minor - coalesce(pao.paid_minor, 0) as balance_minor,
             ${asOf}::date - i.due_date                  as days_overdue
      from invoices i
      join contacts c        on c.id = i.contact_id
      left join paid_as_of pao on pao.invoice_id = i.id
      where i.org_id = ${orgId}
        and i.deleted_at is null
        and i.status not in ('draft', 'void', 'written_off')
        and i.invoice_date <= ${asOf}
        and i.total_minor - coalesce(pao.paid_minor, 0) > 0
    )
    select contact_id,
           display_name,
           coalesce(sum(balance_minor) filter (where days_overdue <= 0), 0)                as current,
           coalesce(sum(balance_minor) filter (where days_overdue between 1 and 30), 0)    as d1_30,
           coalesce(sum(balance_minor) filter (where days_overdue between 31 and 60), 0)   as d31_60,
           coalesce(sum(balance_minor) filter (where days_overdue between 61 and 90), 0)   as d61_90,
           coalesce(sum(balance_minor) filter (where days_overdue > 90), 0)                as over90,
           coalesce(sum(balance_minor), 0)                                                 as total
    from outstanding
    group by contact_id, display_name
    order by total desc
  `);

  const rows: AgingRow[] = (result as unknown as Row[]).map((r) => ({
    contactId: r.contact_id!,
    contactName: r.display_name!,
    currentMinor: toBig(r.current),
    days1to30Minor: toBig(r.d1_30),
    days31to60Minor: toBig(r.d31_60),
    days61to90Minor: toBig(r.d61_90),
    over90Minor: toBig(r.over90),
    totalMinor: toBig(r.total),
  }));

  const totals = rows.reduce(
    (acc, r) => ({
      currentMinor: acc.currentMinor + r.currentMinor,
      days1to30Minor: acc.days1to30Minor + r.days1to30Minor,
      days31to60Minor: acc.days31to60Minor + r.days31to60Minor,
      days61to90Minor: acc.days61to90Minor + r.days61to90Minor,
      over90Minor: acc.over90Minor + r.over90Minor,
      totalMinor: acc.totalMinor + r.totalMinor,
    }),
    {
      currentMinor: 0n,
      days1to30Minor: 0n,
      days31to60Minor: 0n,
      days61to90Minor: 0n,
      over90Minor: 0n,
      totalMinor: 0n,
    },
  );

  return { rows, totals };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Account register / general ledger
 * ──────────────────────────────────────────────────────────────────────────*/

export type LedgerEntryRow = {
  entryId: string;
  entryNumber: string;
  entryDate: string;
  reference: string | null;
  memo: string | null;
  source: string;
  amountMinor: bigint;
  runningBalanceMinor: bigint;
};

/**
 * Transaction-level detail for one account, with a running balance — the drill-down
 * behind every report figure. Window function does the running total in the DB so
 * pagination stays correct.
 */
export async function getAccountLedger(
  orgId: string,
  accountId: string,
  from: string,
  to: string,
): Promise<LedgerEntryRow[]> {
  const result = await db.execute(sql`
    select je.id           as entry_id,
           je.entry_number as entry_number,
           je.entry_date   as entry_date,
           je.reference    as reference,
           coalesce(jl.memo, je.memo) as memo,
           je.source::text as source,
           jl.amount_minor as amount_minor,
           sum(jl.amount_minor) over (
             order by je.entry_date, je.entry_number, jl.line_number
             rows between unbounded preceding and current row
           ) as running_balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    where jl.org_id = ${orgId}
      and jl.account_id = ${accountId}
      and ${POSTED}
      and je.entry_date between ${from} and ${to}
    order by je.entry_date, je.entry_number, jl.line_number
  `);

  return (result as unknown as Row[]).map((r) => ({
    entryId: r.entry_id!,
    entryNumber: r.entry_number!,
    entryDate: r.entry_date!,
    reference: r.reference,
    memo: r.memo,
    source: r.source!,
    amountMinor: toBig(r.amount_minor),
    runningBalanceMinor: toBig(r.running_balance),
  }));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Dashboard
 * ──────────────────────────────────────────────────────────────────────────*/

export type DashboardSummary = {
  cashMinor: bigint;
  receivablesMinor: bigint;
  payablesMinor: bigint;
  revenueThisPeriodMinor: bigint;
  expensesThisPeriodMinor: bigint;
  netProfitThisPeriodMinor: bigint;
  overdueReceivablesMinor: bigint;
};

/**
 * The numbers behind the dashboard tiles. One round trip, all from the ledger.
 */
export async function getDashboardSummary(
  orgId: string,
  from: string,
  to: string,
): Promise<DashboardSummary> {
  const [balances] = (await db.execute(sql`
    select
      coalesce(-sum(jl.amount_minor) filter (where a.subtype = 'accounts_payable'), 0)     as payables,
      coalesce(sum(jl.amount_minor)  filter (where a.subtype = 'accounts_receivable'), 0)  as receivables,
      coalesce(sum(jl.amount_minor)  filter (where a.subtype = 'cash_and_bank'), 0)        as cash
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a         on a.id = jl.account_id
    where jl.org_id = ${orgId}
      and ${POSTED}
      and je.entry_date <= ${to}
  `)) as unknown as Row[];

  const [period] = (await db.execute(sql`
    select
      coalesce(-sum(jl.amount_minor) filter (where a.type = 'income'), 0)  as revenue,
      coalesce(sum(jl.amount_minor)  filter (where a.type = 'expense'), 0) as expenses
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a         on a.id = jl.account_id
    where jl.org_id = ${orgId}
      and ${POSTED}
      and je.entry_date between ${from} and ${to}
  `)) as unknown as Row[];

  // Same as-of discipline as the aging report: settle-by-date, not cached total.
  const [overdue] = (await db.execute(sql`
    with paid_as_of as (
      select pa.invoice_id, sum(pa.amount_minor) as paid_minor
      from payment_allocations pa
      join payments p on p.id = pa.payment_id
      where pa.deleted_at is null and p.payment_date <= ${to}
      group by pa.invoice_id
    )
    select coalesce(sum(i.total_minor - coalesce(pao.paid_minor, 0)), 0) as overdue
    from invoices i
    left join paid_as_of pao on pao.invoice_id = i.id
    where i.org_id = ${orgId}
      and i.deleted_at is null
      and i.status not in ('draft', 'void', 'written_off')
      and i.due_date < ${to}
      and i.total_minor - coalesce(pao.paid_minor, 0) > 0
  `)) as unknown as Row[];

  const revenueThisPeriodMinor = toBig(period?.revenue);
  const expensesThisPeriodMinor = toBig(period?.expenses);

  return {
    cashMinor: toBig(balances?.cash),
    receivablesMinor: toBig(balances?.receivables),
    payablesMinor: toBig(balances?.payables),
    revenueThisPeriodMinor,
    expensesThisPeriodMinor,
    netProfitThisPeriodMinor: revenueThisPeriodMinor - expensesThisPeriodMinor,
    overdueReceivablesMinor: toBig(overdue?.overdue),
  };
}
