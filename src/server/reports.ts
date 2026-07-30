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
 *
 * EVERY FUNCTION TAKES A TENANT-SCOPED `tx`. Row-level security keys off a
 * transaction-local `app.org_id`, so these queries must run inside the
 * transaction that `withOrg()` established rather than on the shared `db`
 * handle. The `orgId` argument stays as well: RLS is the backstop, and an
 * explicit filter is still the primary intent. If you ever see a report come
 * back empty for data you know exists, the first thing to check is whether the
 * caller wrapped it in `withOrg`.
 */

import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";

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
  tx: DbOrTx,
  orgId: string,
  asOf: string,
): Promise<{
  rows: TrialBalanceRow[];
  totalDebitMinor: bigint;
  totalCreditMinor: bigint;
  isBalanced: boolean;
}> {
  const result = await tx.execute(sql`
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
  tx: DbOrTx,
  orgId: string,
  from: string,
  to: string,
): Promise<ProfitAndLoss> {
  const result = await tx.execute(sql`
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
export async function getBalanceSheet(
  tx: DbOrTx,
  orgId: string,
  asOf: string,
): Promise<BalanceSheet> {
  const result = await tx.execute(sql`
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
  const [profitRow] = (await tx.execute(sql`
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
 * GST summary
 * ──────────────────────────────────────────────────────────────────────────*/

export type GstSummary = {
  from: string;
  to: string;
  /** Taxable value of outward supplies (sales, excl. tax) in the period. */
  taxableSalesMinor: bigint;
  /** GST collected on sales — the output-tax liability that accrued (all components). */
  outputTaxMinor: bigint;
  /** Output tax split by place of supply. Sums (with any legacy unsplit) to outputTax. */
  outputCgstMinor: bigint;
  outputSgstMinor: bigint;
  outputIgstMinor: bigint;
  /** Input tax credit availed on purchases in the period. */
  inputTaxMinor: bigint;
  /** Output tax net of ITC — what is owed to the authority for the period. */
  netPayableMinor: bigint;
};

/**
 * GST for a period, derived from the ledger — not a stored figure.
 *
 * Output and input tax now live in SEPARATE accounts: sales credit the system
 * `tax_payable` account (GST Payable, output-tax liability) and purchases debit
 * the system `other_current_asset` account (Input GST Credit / ITC, an asset).
 * We read each as a NET balance for the period — the net of the output account
 * is output tax, the net of the input account is ITC — which stays correct even
 * if a reclassification entry touches an account, unlike sign-splitting a single
 * shared account. TDS Payable shares the tax_payable subtype but is excluded by
 * `is_system`.
 *
 * Output tax is now split by place of supply into CGST/SGST (intra-state) and
 * IGST (inter-state) — read from the dedicated component accounts (codes
 * 2201/2202/2203) — while `outputTaxMinor` remains the total of all output-tax
 * system accounts (including any legacy pre-engine balance on 2200). Still a
 * ledger summary, not a filed return: reverse charge and ITC eligibility, and the
 * component split on the INPUT side, are not yet modelled (E3 slices 2-4).
 */
export async function getGstSummary(
  tx: DbOrTx,
  orgId: string,
  from: string,
  to: string,
): Promise<GstSummary> {
  const [taxRow] = (await tx.execute(sql`
    select
      -- Net credit of the output-tax liability = output tax collected (all components).
      coalesce(-sum(jl.amount_minor) filter (where a.subtype = 'tax_payable' and a.is_system), 0) as output_tax,
      -- Output split by place of supply, from the component accounts.
      coalesce(-sum(jl.amount_minor) filter (where a.code = '2201'), 0) as output_cgst,
      coalesce(-sum(jl.amount_minor) filter (where a.code = '2202'), 0) as output_sgst,
      coalesce(-sum(jl.amount_minor) filter (where a.code = '2203'), 0) as output_igst,
      -- Net debit of the input-tax asset = ITC availed.
      coalesce( sum(jl.amount_minor) filter (where a.subtype = 'other_current_asset' and a.is_system), 0) as input_tax
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a         on a.id = jl.account_id
    where jl.org_id = ${orgId}
      and ${POSTED}
      and je.entry_date between ${from} and ${to}
      and a.is_system = true
      and a.subtype in ('tax_payable', 'other_current_asset')
  `)) as unknown as Row[];

  const [salesRow] = (await tx.execute(sql`
    select coalesce(-sum(jl.amount_minor), 0) as taxable_sales
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a         on a.id = jl.account_id
    where jl.org_id = ${orgId}
      and ${POSTED}
      and je.entry_date between ${from} and ${to}
      and a.subtype = 'operating_revenue'
  `)) as unknown as Row[];

  const outputTaxMinor = toBig(taxRow?.output_tax);
  const inputTaxMinor = toBig(taxRow?.input_tax);

  return {
    from,
    to,
    taxableSalesMinor: toBig(salesRow?.taxable_sales),
    outputTaxMinor,
    outputCgstMinor: toBig(taxRow?.output_cgst),
    outputSgstMinor: toBig(taxRow?.output_sgst),
    outputIgstMinor: toBig(taxRow?.output_igst),
    inputTaxMinor,
    netPayableMinor: outputTaxMinor - inputTaxMinor,
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
  tx: DbOrTx,
  orgId: string,
  asOf: string,
): Promise<{ rows: AgingRow[]; totals: Omit<AgingRow, "contactId" | "contactName"> }> {
  const result = await tx.execute(sql`
    with paid_as_of as (
      select pa.invoice_id,
             sum(pa.amount_minor) as paid_minor
      from payment_allocations pa
      join payments p on p.id = pa.payment_id
      where pa.deleted_at is null
        and p.payment_date <= ${asOf}
      group by pa.invoice_id
    ),
    -- Posted credit notes reduce what the customer owes on their invoice. They
    -- credit the A/R control account, so aging must net them too or the control
    -- account and this subledger would disagree (verify.ts asserts they don't).
    credited_as_of as (
      select cn.related_invoice_id as invoice_id,
             sum(cn.total_minor)    as credited_minor
      from credit_notes cn
      where cn.status = 'posted'
        and cn.related_invoice_id is not null
        and cn.credit_note_date <= ${asOf}
      group by cn.related_invoice_id
    ),
    outstanding as (
      select i.contact_id,
             c.display_name,
             i.total_minor - coalesce(pao.paid_minor, 0) - coalesce(cno.credited_minor, 0) as balance_minor,
             ${asOf}::date - i.due_date                  as days_overdue
      from invoices i
      join contacts c        on c.id = i.contact_id
      left join paid_as_of pao on pao.invoice_id = i.id
      left join credited_as_of cno on cno.invoice_id = i.id
      where i.org_id = ${orgId}
        and i.deleted_at is null
        and i.status not in ('draft', 'void', 'written_off')
        and i.invoice_date <= ${asOf}
        and i.total_minor - coalesce(pao.paid_minor, 0) - coalesce(cno.credited_minor, 0) > 0
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

/**
 * Accounts payable aging — the mirror of receivables. Outstanding is bill total
 * less vendor payments and less posted debit notes (which reduce what we owe),
 * both as-of `asOf`. Nets to the A/P control account for the same reason the
 * receivables report nets to A/R.
 */
export async function getPayablesAging(
  tx: DbOrTx,
  orgId: string,
  asOf: string,
): Promise<{ rows: AgingRow[]; totals: Omit<AgingRow, "contactId" | "contactName"> }> {
  const result = await tx.execute(sql`
    with paid_as_of as (
      select pa.bill_id, sum(pa.amount_minor) as paid_minor
      from payment_allocations pa
      join payments p on p.id = pa.payment_id
      where pa.deleted_at is null and pa.bill_id is not null and p.payment_date <= ${asOf}
      group by pa.bill_id
    ),
    debited_as_of as (
      select dn.related_bill_id as bill_id, sum(dn.total_minor) as debited_minor
      from debit_notes dn
      where dn.status = 'posted' and dn.related_bill_id is not null and dn.debit_note_date <= ${asOf}
      group by dn.related_bill_id
    ),
    outstanding as (
      select b.contact_id, c.display_name,
             b.total_minor - coalesce(pao.paid_minor, 0) - coalesce(dno.debited_minor, 0) as balance_minor,
             ${asOf}::date - b.due_date as days_overdue
      from bills b
      join contacts c on c.id = b.contact_id
      left join paid_as_of pao on pao.bill_id = b.id
      left join debited_as_of dno on dno.bill_id = b.id
      where b.org_id = ${orgId}
        and b.deleted_at is null
        and b.status not in ('draft', 'void')
        and b.bill_date <= ${asOf}
        and b.total_minor - coalesce(pao.paid_minor, 0) - coalesce(dno.debited_minor, 0) > 0
    )
    select contact_id, display_name,
           coalesce(sum(balance_minor) filter (where days_overdue <= 0), 0)              as current,
           coalesce(sum(balance_minor) filter (where days_overdue between 1 and 30), 0)  as d1_30,
           coalesce(sum(balance_minor) filter (where days_overdue between 31 and 60), 0) as d31_60,
           coalesce(sum(balance_minor) filter (where days_overdue between 61 and 90), 0) as d61_90,
           coalesce(sum(balance_minor) filter (where days_overdue > 90), 0)              as over90,
           coalesce(sum(balance_minor), 0)                                               as total
    from outstanding group by contact_id, display_name order by total desc
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
 * Day book — every voucher, chronologically
 * ──────────────────────────────────────────────────────────────────────────*/

export type DayBookRow = {
  entryId: string;
  entryNumber: string;
  entryDate: string;
  source: string;
  reference: string | null;
  memo: string | null;
  status: string;
  amountMinor: bigint; // total debits of the entry
};

/**
 * The day book: one row per journal entry in the range, with its gross value
 * (total debits). This is the chronological register auditors read first.
 */
export async function getDayBook(
  tx: DbOrTx,
  orgId: string,
  from: string,
  to: string,
): Promise<{ rows: DayBookRow[]; totalMinor: bigint }> {
  const result = await tx.execute(sql`
    select je.id as entry_id, je.entry_number, je.entry_date::text as entry_date,
           je.source::text as source, je.reference, je.memo, je.status::text as status,
           coalesce(sum(jl.amount_minor) filter (where jl.amount_minor > 0), 0) as debits
    from journal_entries je
    join journal_lines jl on jl.entry_id = je.id
    where je.org_id = ${orgId}
      and je.status in ('posted', 'reversed')
      and je.entry_date between ${from} and ${to}
    group by je.id, je.entry_number, je.entry_date, je.source, je.reference, je.memo, je.status
    order by je.entry_date desc, je.entry_number desc
  `);

  const rows: DayBookRow[] = (result as unknown as Row[]).map((r) => ({
    entryId: r.entry_id!,
    entryNumber: r.entry_number!,
    entryDate: r.entry_date!,
    source: r.source!,
    reference: r.reference,
    memo: r.memo,
    status: r.status!,
    amountMinor: toBig(r.debits),
  }));

  return { rows, totalMinor: rows.reduce((a, r) => a + r.amountMinor, 0n) };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cash flow statement (direct, by counterpart)
 *
 * For any entry that touches a cash/bank account, the sum of its lines is zero,
 * so the cash movement equals the NEGATED sum of the entry's non-cash lines.
 * Classifying each non-cash line by its account then partitions the exact cash
 * delta into operating / investing / financing — the statement always reconciles
 * to (closing cash − opening cash), by construction.
 * ──────────────────────────────────────────────────────────────────────────*/

export type CashFlow = {
  from: string;
  to: string;
  operating: { label: string; amountMinor: bigint }[];
  investing: { label: string; amountMinor: bigint }[];
  financing: { label: string; amountMinor: bigint }[];
  operatingTotalMinor: bigint;
  investingTotalMinor: bigint;
  financingTotalMinor: bigint;
  netCashMinor: bigint;
  openingCashMinor: bigint;
  closingCashMinor: bigint;
  reconciles: boolean;
};

export async function getCashFlow(
  tx: DbOrTx,
  orgId: string,
  from: string,
  to: string,
): Promise<CashFlow> {
  // Cash delta per category, from the non-cash legs of cash-touching entries.
  const rows = (await tx.execute(sql`
    with cash_entries as (
      select distinct jl.entry_id
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      join journal_entries je on je.id = jl.entry_id
      where jl.org_id = ${orgId} and a.subtype = 'cash_and_bank'
        and je.status in ('posted','reversed') and je.entry_date between ${from} and ${to}
    )
    select
      case
        when a.subtype in ('fixed_asset','accumulated_depreciation') then 'investing'
        when a.type = 'equity' or a.subtype = 'long_term_liability' then 'financing'
        when a.subtype = 'cash_and_bank' then 'transfer'
        else 'operating'
      end as category,
      a.name as label,
      -sum(jl.amount_minor) as cash_effect
    from journal_lines jl
    join accounts a on a.id = jl.account_id
    join journal_entries je on je.id = jl.entry_id
    where jl.entry_id in (select entry_id from cash_entries)
      and a.subtype <> 'cash_and_bank'
    group by category, a.name
    having -sum(jl.amount_minor) <> 0
    order by a.name
  `)) as unknown as Array<{ category: string; label: string; cash_effect: string }>;

  const bucket = (cat: string) =>
    rows
      .filter((r) => r.category === cat)
      .map((r) => ({ label: r.label, amountMinor: toBig(r.cash_effect) }));

  const operating = bucket("operating");
  const investing = bucket("investing");
  const financing = bucket("financing");
  const sum = (l: { amountMinor: bigint }[]) => l.reduce((a, x) => a + x.amountMinor, 0n);
  const operatingTotalMinor = sum(operating);
  const investingTotalMinor = sum(investing);
  const financingTotalMinor = sum(financing);
  const netCashMinor = operatingTotalMinor + investingTotalMinor + financingTotalMinor;

  const cashBalance = async (asOf: string, upTo = true): Promise<bigint> => {
    const r = (await tx.execute(sql`
      select coalesce(sum(jl.amount_minor), 0) as bal
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      join journal_entries je on je.id = jl.entry_id
      where jl.org_id = ${orgId} and a.subtype = 'cash_and_bank'
        and je.status in ('posted','reversed')
        and je.entry_date ${upTo ? sql`<= ${asOf}` : sql`< ${asOf}`}
    `)) as unknown as Array<{ bal: string }>;
    return toBig(r[0].bal);
  };

  const openingCashMinor = await cashBalance(from, false);
  const closingCashMinor = await cashBalance(to, true);

  return {
    from,
    to,
    operating,
    investing,
    financing,
    operatingTotalMinor,
    investingTotalMinor,
    financingTotalMinor,
    netCashMinor,
    openingCashMinor,
    closingCashMinor,
    // Proof: classified cash flow equals the actual movement in cash balances.
    reconciles: netCashMinor === closingCashMinor - openingCashMinor,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Financial ratios
 * ──────────────────────────────────────────────────────────────────────────*/

export type RatioRow = { label: string; value: number; format: "x" | "%" | "money"; hint: string };

const CURRENT_ASSET_SUBTYPES = [
  "cash_and_bank",
  "accounts_receivable",
  "inventory",
  "other_current_asset",
];
const CURRENT_LIABILITY_SUBTYPES = [
  "accounts_payable",
  "tax_payable",
  "credit_card",
  "other_current_liability",
  "goods_received_clearing",
];

/**
 * Headline liquidity, leverage and profitability ratios, from the same balance
 * sheet and P&L the rest of the app shows — so the ratios can never disagree with
 * the statements they summarise.
 */
export async function getFinancialRatios(
  tx: DbOrTx,
  orgId: string,
  from: string,
  asOf: string,
): Promise<{ ratios: RatioRow[]; currentAssetsMinor: bigint; currentLiabilitiesMinor: bigint }> {
  const bs = await getBalanceSheet(tx, orgId, asOf);
  const pnl = await getProfitAndLoss(tx, orgId, from, asOf);

  const sumBy = (lines: { subtype: string; amountMinor: bigint }[], subs: string[]) =>
    lines.filter((l) => subs.includes(l.subtype)).reduce((a, l) => a + l.amountMinor, 0n);

  const currentAssets = sumBy(bs.assets, CURRENT_ASSET_SUBTYPES);
  const inventory = sumBy(bs.assets, ["inventory"]);
  const currentLiabilities = sumBy(bs.liabilities, CURRENT_LIABILITY_SUBTYPES);
  const totalLiab = bs.totalLiabilitiesMinor;
  const totalEquity = bs.totalEquityMinor;
  const revenue = pnl.totalRevenueMinor;

  const ratio = (num: bigint, den: bigint) => (den === 0n ? 0 : Number(num) / Number(den));
  const pct = (num: bigint, den: bigint) => (den === 0n ? 0 : (Number(num) / Number(den)) * 100);

  const ratios: RatioRow[] = [
    {
      label: "Current ratio",
      value: ratio(currentAssets, currentLiabilities),
      format: "x",
      hint: "Current assets ÷ current liabilities",
    },
    {
      label: "Quick ratio",
      value: ratio(currentAssets - inventory, currentLiabilities),
      format: "x",
      hint: "Liquid assets (ex-inventory) ÷ current liabilities",
    },
    {
      label: "Working capital",
      value: Number(currentAssets - currentLiabilities),
      format: "money",
      hint: "Current assets − current liabilities",
    },
    {
      label: "Gross margin",
      value: pct(pnl.grossProfitMinor, revenue),
      format: "%",
      hint: "Gross profit ÷ revenue",
    },
    {
      label: "Net margin",
      value: pct(pnl.netProfitMinor, revenue),
      format: "%",
      hint: "Net profit ÷ revenue",
    },
    {
      label: "Debt to equity",
      value: ratio(totalLiab, totalEquity),
      format: "x",
      hint: "Total liabilities ÷ total equity",
    },
    {
      label: "Return on equity",
      value: pct(pnl.netProfitMinor, totalEquity),
      format: "%",
      hint: "Net profit ÷ total equity",
    },
  ];

  return { ratios, currentAssetsMinor: currentAssets, currentLiabilitiesMinor: currentLiabilities };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Monthly P&L (multi-period comparative)
 * ──────────────────────────────────────────────────────────────────────────*/

export type MonthlyPnlRow = {
  month: string; // YYYY-MM
  revenueMinor: bigint;
  cogsMinor: bigint;
  grossProfitMinor: bigint;
  expensesMinor: bigint;
  netProfitMinor: bigint;
};

/**
 * Revenue / COGS / expenses / net profit per calendar month in [from, to].
 * The side-by-side comparative that turns a single P&L into a trend.
 */
export async function getMonthlyPnl(
  tx: DbOrTx,
  orgId: string,
  from: string,
  to: string,
): Promise<MonthlyPnlRow[]> {
  const rows = (await tx.execute(sql`
    select to_char(je.entry_date, 'YYYY-MM') as month,
           a.type::text as type,
           a.subtype::text as subtype,
           sum(jl.amount_minor) as net
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where jl.org_id = ${orgId} and ${POSTED}
      and je.entry_date between ${from} and ${to}
      and a.type in ('income', 'expense')
    group by month, a.type, a.subtype
    order by month
  `)) as unknown as Array<{ month: string; type: string; subtype: string; net: string }>;

  const byMonth = new Map<string, MonthlyPnlRow>();
  for (const r of rows) {
    const m = byMonth.get(r.month) ?? {
      month: r.month,
      revenueMinor: 0n,
      cogsMinor: 0n,
      grossProfitMinor: 0n,
      expensesMinor: 0n,
      netProfitMinor: 0n,
    };
    const net = toBig(r.net);
    if (r.type === "income")
      m.revenueMinor += -net; // income is credit-normal
    else if (r.subtype === "cost_of_goods_sold") m.cogsMinor += net;
    else m.expensesMinor += net;
    byMonth.set(r.month, m);
  }

  return [...byMonth.values()]
    .map((m) => ({
      ...m,
      grossProfitMinor: m.revenueMinor - m.cogsMinor,
      netProfitMinor: m.revenueMinor - m.cogsMinor - m.expensesMinor,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Budget vs actual
 * ──────────────────────────────────────────────────────────────────────────*/

export type BudgetVsActualRow = {
  accountId: string;
  code: string;
  name: string;
  budgetMinor: bigint;
  actualMinor: bigint;
  varianceMinor: bigint; // budget − actual (positive = under budget for an expense)
};

/**
 * Budget vs actual for a fiscal year. Actual is the account's posted movement in
 * the period, taken with its natural sign (expenses debit-positive, income shown
 * as its earned amount) so it lines up with the budgeted figure.
 */
export async function getBudgetVsActual(
  tx: DbOrTx,
  orgId: string,
  fiscalYear: number,
  from: string,
  to: string,
): Promise<BudgetVsActualRow[]> {
  const rows = (await tx.execute(sql`
    select b.account_id, a.code, a.name, a.type::text as type,
           b.amount_minor as budget,
           coalesce((
             select sum(jl.amount_minor)
             from journal_lines jl
             join journal_entries je on je.id = jl.entry_id
             where jl.account_id = b.account_id and jl.org_id = ${orgId}
               and je.status in ('posted','reversed')
               and je.entry_date between ${from} and ${to}
           ), 0) as actual_signed
    from budgets b
    join accounts a on a.id = b.account_id
    where b.org_id = ${orgId} and b.fiscal_year = ${fiscalYear}
    order by a.code
  `)) as unknown as Array<{
    account_id: string;
    code: string;
    name: string;
    type: string;
    budget: string;
    actual_signed: string;
  }>;

  return rows.map((r) => {
    // Expenses are debit-positive already; income is credit-negative, so flip it
    // to its earned (positive) amount to compare against a positive budget.
    const signed = toBig(r.actual_signed);
    const actual = r.type === "income" ? -signed : signed;
    const budget = toBig(r.budget);
    return {
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      budgetMinor: budget,
      actualMinor: actual,
      varianceMinor: budget - actual,
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cost-centre P&L (dimensional)
 * ──────────────────────────────────────────────────────────────────────────*/

export type CostCenterPnlRow = {
  costCenterId: string | null;
  name: string;
  revenueMinor: bigint;
  expenseMinor: bigint;
  netMinor: bigint;
};

/**
 * Income and expense for the period, split by cost centre. Lines with no cost
 * centre roll into an "Unassigned" bucket, so every rupee of P&L is accounted
 * for and the columns still tie back to the P&L totals.
 */
export async function getCostCenterPnl(
  tx: DbOrTx,
  orgId: string,
  from: string,
  to: string,
): Promise<CostCenterPnlRow[]> {
  const rows = (await tx.execute(sql`
    select jl.cost_center_id as cc_id,
           coalesce(cc.name, 'Unassigned') as name,
           a.type::text as type,
           sum(jl.amount_minor) as net
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    left join cost_centers cc on cc.id = jl.cost_center_id
    where jl.org_id = ${orgId} and ${POSTED}
      and je.entry_date between ${from} and ${to}
      and a.type in ('income','expense')
    group by jl.cost_center_id, cc.name, a.type
  `)) as unknown as Array<{ cc_id: string | null; name: string; type: string; net: string }>;

  const byCc = new Map<string, CostCenterPnlRow>();
  for (const r of rows) {
    const key = r.cc_id ?? "__unassigned__";
    const row = byCc.get(key) ?? {
      costCenterId: r.cc_id,
      name: r.name,
      revenueMinor: 0n,
      expenseMinor: 0n,
      netMinor: 0n,
    };
    const net = toBig(r.net);
    if (r.type === "income")
      row.revenueMinor += -net; // credit-normal
    else row.expenseMinor += net;
    byCc.set(key, row);
  }

  return [...byCc.values()]
    .map((r) => ({ ...r, netMinor: r.revenueMinor - r.expenseMinor }))
    .sort((a, b) => Number(b.netMinor - a.netMinor));
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
  tx: DbOrTx,
  orgId: string,
  accountId: string,
  from: string,
  to: string,
): Promise<LedgerEntryRow[]> {
  const result = await tx.execute(sql`
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
  tx: DbOrTx,
  orgId: string,
  from: string,
  to: string,
): Promise<DashboardSummary> {
  const [balances] = (await tx.execute(sql`
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

  const [period] = (await tx.execute(sql`
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
  const [overdue] = (await tx.execute(sql`
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
