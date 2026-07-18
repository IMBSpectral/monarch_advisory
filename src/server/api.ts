/**
 * Server functions — the boundary between the UI and the ledger.
 *
 * TanStack Start runs these on the server only; the client gets a typed RPC stub.
 * That matters here because it means the database, the posting engine, and the
 * money math never ship to the browser.
 *
 * BIGINT SERIALIZATION: JSON can't represent bigint, so every function converts
 * minor units to strings at this boundary. The UI formats them with
 * `formatMinor()` from @/lib/money and never does arithmetic on them — money math
 * belongs on the server where it's exact.
 */

import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { accounts, contacts, invoices, journalEntries, organizations } from "@/db/schema";
import {
  getBalanceSheet,
  getDashboardSummary,
  getProfitAndLoss,
  getReceivablesAging,
  getTrialBalance,
} from "./reports";
import { createInvoice, postInvoice, recordCustomerPayment } from "./invoicing";

/* ────────────────────────────────────────────────────────────────────────────
 * Session
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Resolve the acting organization.
 *
 * PLACEHOLDER — returns the first org in the database. Real auth (session cookie
 * → user → membership → org) is the next thing to build. Every function below
 * already routes its tenancy through here, so swapping this out is a one-file
 * change rather than a rewrite.
 */
async function currentOrgId(): Promise<string> {
  const [org] = await db.select({ id: organizations.id }).from(organizations).limit(1);
  if (!org) {
    throw new Error("No organization found. Run `bun run db:seed`.");
  }
  return org.id;
}

/** Default reporting window: current Indian fiscal year to date. */
function defaultPeriod(): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const fyStart = now.getUTCMonth() + 1 >= 4 ? y : y - 1;
  return {
    from: `${fyStart}-04-01`,
    to: now.toISOString().slice(0, 10),
  };
}

const periodSchema = z
  .object({ from: z.string().optional(), to: z.string().optional() })
  .optional();

/* ────────────────────────────────────────────────────────────────────────────
 * Dashboard
 * ──────────────────────────────────────────────────────────────────────────*/

export const fetchDashboard = createServerFn({ method: "GET" })
  .validator(periodSchema)
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const period = defaultPeriod();
    const from = data?.from ?? period.from;
    const to = data?.to ?? period.to;

    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));

    const summary = await getDashboardSummary(orgId, from, to);

    // Revenue vs expense, month by month, straight from the ledger.
    const trend = (await db.execute(sql`
      select to_char(date_trunc('month', je.entry_date), 'Mon') as month,
             date_trunc('month', je.entry_date)                 as sort_key,
             coalesce(-sum(jl.amount_minor) filter (where a.type = 'income'), 0)  as revenue,
             coalesce(sum(jl.amount_minor)  filter (where a.type = 'expense'), 0) as expense
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a         on a.id = jl.account_id
      where jl.org_id = ${orgId}
        and je.status in ('posted', 'reversed')
        and je.entry_date between ${from} and ${to}
        and a.type in ('income', 'expense')
      group by 1, 2
      order by 2
    `)) as unknown as Array<Record<string, string>>;

    const aging = await getReceivablesAging(orgId, to);

    return {
      organization: {
        name: org.name,
        baseCurrency: org.baseCurrency,
        taxRegistrationNumber: org.taxRegistrationNumber,
      },
      period: { from, to },
      summary: {
        cash: summary.cashMinor.toString(),
        receivables: summary.receivablesMinor.toString(),
        payables: summary.payablesMinor.toString(),
        revenue: summary.revenueThisPeriodMinor.toString(),
        expenses: summary.expensesThisPeriodMinor.toString(),
        netProfit: summary.netProfitThisPeriodMinor.toString(),
        overdueReceivables: summary.overdueReceivablesMinor.toString(),
      },
      trend: trend.map((r) => ({
        month: r.month,
        revenue: r.revenue,
        expense: r.expense,
      })),
      topDebtors: aging.rows.slice(0, 5).map((r) => ({
        contactId: r.contactId,
        name: r.contactName,
        total: r.totalMinor.toString(),
        overdue: (
          r.days1to30Minor +
          r.days31to60Minor +
          r.days61to90Minor +
          r.over90Minor
        ).toString(),
      })),
    };
  });

/* ────────────────────────────────────────────────────────────────────────────
 * Reports
 * ──────────────────────────────────────────────────────────────────────────*/

export const fetchTrialBalance = createServerFn({ method: "GET" })
  .validator(z.object({ asOf: z.string() }).optional())
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const asOf = data?.asOf ?? defaultPeriod().to;
    const tb = await getTrialBalance(orgId, asOf);
    return {
      asOf,
      isBalanced: tb.isBalanced,
      totalDebit: tb.totalDebitMinor.toString(),
      totalCredit: tb.totalCreditMinor.toString(),
      rows: tb.rows.map((r) => ({
        ...r,
        debitMinor: r.debitMinor.toString(),
        creditMinor: r.creditMinor.toString(),
      })),
    };
  });

export const fetchProfitAndLoss = createServerFn({ method: "GET" })
  .validator(periodSchema)
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const period = defaultPeriod();
    const pnl = await getProfitAndLoss(orgId, data?.from ?? period.from, data?.to ?? period.to);
    const ser = (lines: typeof pnl.revenue) =>
      lines.map((l) => ({ ...l, amountMinor: l.amountMinor.toString() }));

    return {
      from: pnl.from,
      to: pnl.to,
      revenue: ser(pnl.revenue),
      costOfGoodsSold: ser(pnl.costOfGoodsSold),
      operatingExpenses: ser(pnl.operatingExpenses),
      otherIncome: ser(pnl.otherIncome),
      otherExpenses: ser(pnl.otherExpenses),
      totalRevenue: pnl.totalRevenueMinor.toString(),
      totalCogs: pnl.totalCogsMinor.toString(),
      grossProfit: pnl.grossProfitMinor.toString(),
      totalOperatingExpense: pnl.totalOperatingExpenseMinor.toString(),
      operatingProfit: pnl.operatingProfitMinor.toString(),
      netProfit: pnl.netProfitMinor.toString(),
    };
  });

export const fetchBalanceSheet = createServerFn({ method: "GET" })
  .validator(z.object({ asOf: z.string() }).optional())
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const bs = await getBalanceSheet(orgId, data?.asOf ?? defaultPeriod().to);
    const ser = (lines: typeof bs.assets) =>
      lines.map((l) => ({ ...l, amountMinor: l.amountMinor.toString() }));

    return {
      asOf: bs.asOf,
      isBalanced: bs.isBalanced,
      assets: ser(bs.assets),
      liabilities: ser(bs.liabilities),
      equity: ser(bs.equity),
      totalAssets: bs.totalAssetsMinor.toString(),
      totalLiabilities: bs.totalLiabilitiesMinor.toString(),
      totalEquity: bs.totalEquityMinor.toString(),
      retainedEarnings: bs.retainedEarningsMinor.toString(),
    };
  });

export const fetchReceivablesAging = createServerFn({ method: "GET" })
  .validator(z.object({ asOf: z.string() }).optional())
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const aging = await getReceivablesAging(orgId, data?.asOf ?? defaultPeriod().to);
    return {
      rows: aging.rows.map((r) => ({
        contactId: r.contactId,
        contactName: r.contactName,
        current: r.currentMinor.toString(),
        days1to30: r.days1to30Minor.toString(),
        days31to60: r.days31to60Minor.toString(),
        days61to90: r.days61to90Minor.toString(),
        over90: r.over90Minor.toString(),
        total: r.totalMinor.toString(),
      })),
      totals: {
        current: aging.totals.currentMinor.toString(),
        days1to30: aging.totals.days1to30Minor.toString(),
        days31to60: aging.totals.days31to60Minor.toString(),
        days61to90: aging.totals.days61to90Minor.toString(),
        over90: aging.totals.over90Minor.toString(),
        total: aging.totals.totalMinor.toString(),
      },
    };
  });

/* ────────────────────────────────────────────────────────────────────────────
 * Lists
 * ──────────────────────────────────────────────────────────────────────────*/

export const fetchInvoices = createServerFn({ method: "GET" })
  .validator(z.object({ limit: z.number().max(200).optional() }).optional())
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const rows = await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        invoiceDate: invoices.invoiceDate,
        dueDate: invoices.dueDate,
        status: invoices.status,
        currency: invoices.currency,
        totalMinor: invoices.totalMinor,
        amountPaidMinor: invoices.amountPaidMinor,
        customerName: contacts.displayName,
        contactId: contacts.id,
      })
      .from(invoices)
      .innerJoin(contacts, eq(contacts.id, invoices.contactId))
      .where(eq(invoices.orgId, orgId))
      .orderBy(desc(invoices.invoiceDate), desc(invoices.invoiceNumber))
      .limit(data?.limit ?? 50);

    return rows.map((r) => ({
      ...r,
      total: r.totalMinor.toString(),
      paid: r.amountPaidMinor.toString(),
      balance: (r.totalMinor - r.amountPaidMinor).toString(),
      totalMinor: undefined,
      amountPaidMinor: undefined,
    }));
  });

export const fetchChartOfAccounts = createServerFn({ method: "GET" }).handler(async () => {
  const orgId = await currentOrgId();

  // Balances come from the ledger, joined on — never stored on the account.
  const rows = (await db.execute(sql`
      select a.id, a.code, a.name, a.type::text as type, a.subtype::text as subtype,
             a.is_group, a.is_system, a.parent_id,
             coalesce(sum(jl.amount_minor), 0) as net_minor
      from accounts a
      left join journal_lines jl   on jl.account_id = a.id
      left join journal_entries je on je.id = jl.entry_id
                                  and je.status in ('posted', 'reversed')
      where a.org_id = ${orgId}
        and a.deleted_at is null
      group by a.id, a.code, a.name, a.type, a.subtype, a.is_group, a.is_system, a.parent_id
      order by a.code
    `)) as unknown as Array<Record<string, string | boolean | null>>;

  return rows.map((r) => {
    const net = BigInt((r.net_minor as string) ?? "0");
    const creditNormal = r.type === "liability" || r.type === "equity" || r.type === "income";
    return {
      id: r.id as string,
      code: r.code as string,
      name: r.name as string,
      type: r.type as string,
      subtype: r.subtype as string,
      isGroup: r.is_group as boolean,
      isSystem: r.is_system as boolean,
      parentId: r.parent_id as string | null,
      // Present each account positive in its own normal direction.
      balance: (creditNormal ? -net : net).toString(),
    };
  });
});

export const fetchJournal = createServerFn({ method: "GET" })
  .validator(z.object({ limit: z.number().max(200).optional() }).optional())
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const rows = (await db.execute(sql`
      select je.id, je.entry_number, je.entry_date, je.status::text as status,
             je.source::text as source, je.reference, je.memo,
             coalesce(sum(jl.amount_minor) filter (where jl.amount_minor > 0), 0) as total_debit,
             count(jl.id) as line_count
      from journal_entries je
      left join journal_lines jl on jl.entry_id = je.id
      where je.org_id = ${orgId}
      group by je.id
      order by je.entry_date desc, je.entry_number desc
      limit ${data?.limit ?? 50}
    `)) as unknown as Array<Record<string, string>>;

    return rows.map((r) => ({
      id: r.id,
      entryNumber: r.entry_number,
      entryDate: r.entry_date,
      status: r.status,
      source: r.source,
      reference: r.reference,
      memo: r.memo,
      amount: r.total_debit,
      lineCount: Number(r.line_count),
    }));
  });

/* ────────────────────────────────────────────────────────────────────────────
 * Mutations
 * ──────────────────────────────────────────────────────────────────────────*/

const draftLineSchema = z.object({
  description: z.string().min(1),
  quantity: z.string().optional(),
  /** Minor units as a string, because JSON has no bigint. */
  unitPriceMinor: z.string(),
  discountBps: z.number().int().min(0).max(10000).optional(),
  taxRateId: z.string().uuid().nullable().optional(),
  revenueAccountId: z.string().uuid().nullable().optional(),
  itemId: z.string().uuid().nullable().optional(),
});

export const createInvoiceFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      contactId: z.string().uuid(),
      invoiceDate: z.string(),
      dueDate: z.string().optional(),
      notes: z.string().optional(),
      terms: z.string().optional(),
      lines: z.array(draftLineSchema).min(1),
      /** Post immediately rather than leaving it a draft. */
      postImmediately: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();

    const result = await createInvoice({
      orgId,
      contactId: data.contactId,
      invoiceDate: data.invoiceDate,
      dueDate: data.dueDate,
      notes: data.notes,
      terms: data.terms,
      lines: data.lines.map((l) => ({
        ...l,
        unitPriceMinor: BigInt(l.unitPriceMinor),
      })),
    });

    if (data.postImmediately) {
      await postInvoice({ orgId, invoiceId: result.invoiceId });
    }

    return {
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      total: result.totalMinor.toString(),
    };
  });

export const postInvoiceFn = createServerFn({ method: "POST" })
  .validator(z.object({ invoiceId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const entry = await postInvoice({ orgId, invoiceId: data.invoiceId });
    return { entryId: entry.entryId, entryNumber: entry.entryNumber };
  });

export const recordPaymentFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      contactId: z.string().uuid(),
      paymentDate: z.string(),
      amountMinor: z.string(),
      depositAccountId: z.string().uuid(),
      method: z.string().optional(),
      referenceNumber: z.string().optional(),
      allocations: z
        .array(
          z.object({
            invoiceId: z.string().uuid(),
            amountMinor: z.string(),
          }),
        )
        .default([]),
    }),
  )
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const result = await recordCustomerPayment({
      orgId,
      contactId: data.contactId,
      paymentDate: data.paymentDate,
      amountMinor: BigInt(data.amountMinor),
      depositAccountId: data.depositAccountId,
      method: data.method,
      referenceNumber: data.referenceNumber,
      allocations: data.allocations.map((a) => ({
        invoiceId: a.invoiceId,
        amountMinor: BigInt(a.amountMinor),
      })),
    });
    return {
      paymentId: result.paymentId,
      paymentNumber: result.paymentNumber,
      entryId: result.entryId,
    };
  });
