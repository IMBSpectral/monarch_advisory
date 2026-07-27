/**
 * Server functions — the boundary between the UI and the ledger.
 *
 * TanStack Start runs these on the server only; the client gets a typed RPC stub.
 * That matters here because it means the database, the posting engine, and the
 * money math never ship to the browser.
 *
 * WHY THIS FILE ISN'T IN src/server/
 * Routes import from here, and TanStack Start's import-protection plugin denies
 * client-environment imports matching `**\/server\/**`. Server functions are
 * *designed* to be imported by client code — the build strips each `.handler()`
 * body and tree-shakes its server-only imports, leaving an RPC stub. So this file
 * lives outside the guarded directory while everything it calls (ledger, reports,
 * invoicing) stays in src/server/ and is only ever reached inside a handler.
 *
 * Importing `@/server/*` from a route will fail the client build — the SSR render
 * still succeeds, so it shows up as a broken client bundle rather than a 500.
 *
 * BIGINT SERIALIZATION: JSON can't represent bigint, so every function converts
 * minor units to strings at this boundary. The UI formats them with
 * `formatMinor()` from @/lib/money and never does arithmetic on them — money math
 * belongs on the server where it's exact.
 */

import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db/client";
import {
  accounts,
  contacts,
  invoiceLines,
  invoices,
  journalEntries,
  organizations,
} from "@/db/schema";
import {
  getBalanceSheet,
  getGstSummary,
  getCashFlow,
  getDashboardSummary,
  getDayBook,
  getFinancialRatios,
  getMonthlyPnl,
  getPayablesAging,
  getProfitAndLoss,
  getReceivablesAging,
  getTrialBalance,
} from "@/server/reports";
import { getStockSummary } from "@/server/inventory";
import { listContacts, listItems } from "@/server/entities";
import { createInvoice, postInvoice, recordCustomerPayment } from "@/server/invoicing";
import { assertCan } from "@/server/auth";
import { currentOrgId, requireAuth, requirePermission } from "@/server/session";

/* ────────────────────────────────────────────────────────────────────────────
 * Session
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Tenancy and permissions now resolve from the real session chain
 * (cookie → session row → user → membership → org). See `./session`.
 *
 * Read functions call `requireAuth`/`currentOrgId`; mutating functions call
 * `requirePermission`, which resolves the caller and asserts a capability in one
 * step so the check can't be omitted by accident.
 */

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

    return withOrg(orgId, async (tx) => {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));

      const summary = await getDashboardSummary(tx, orgId, from, to);

      // Revenue vs expense, month by month, straight from the ledger.
      const trend = (await tx.execute(sql`
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

      const aging = await getReceivablesAging(tx, orgId, to);

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
  });

/* ────────────────────────────────────────────────────────────────────────────
 * Reports
 * ──────────────────────────────────────────────────────────────────────────*/

export const fetchTrialBalance = createServerFn({ method: "GET" })
  .validator(z.object({ asOf: z.string() }).optional())
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const asOf = data?.asOf ?? defaultPeriod().to;

    return withOrg(orgId, async (tx) => {
      const tb = await getTrialBalance(tx, orgId, asOf);
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
  });

export const fetchProfitAndLoss = createServerFn({ method: "GET" })
  .validator(periodSchema)
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const period = defaultPeriod();

    return withOrg(orgId, async (tx) => {
      const pnl = await getProfitAndLoss(
        tx,
        orgId,
        data?.from ?? period.from,
        data?.to ?? period.to,
      );
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
  });

export const fetchBalanceSheet = createServerFn({ method: "GET" })
  .validator(z.object({ asOf: z.string() }).optional())
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();

    return withOrg(orgId, async (tx) => {
      const bs = await getBalanceSheet(tx, orgId, data?.asOf ?? defaultPeriod().to);
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
  });

export const fetchGstSummary = createServerFn({ method: "GET" })
  .validator(periodSchema)
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const period = defaultPeriod();

    return withOrg(orgId, async (tx) => {
      const g = await getGstSummary(tx, orgId, data?.from ?? period.from, data?.to ?? period.to);
      // Intra-state presentational split (place of supply isn't modelled): halve
      // the total into CGST/SGST, giving the odd paisa to CGST so the two sum
      // back exactly. IGST (inter-state) can't be derived, so it stays zero.
      const half = (v: bigint) => {
        const cgst = (v + 1n) / 2n;
        return { cgst: cgst.toString(), sgst: (v - cgst).toString() };
      };
      return {
        from: g.from,
        to: g.to,
        taxableSales: g.taxableSalesMinor.toString(),
        outputTax: g.outputTaxMinor.toString(),
        inputTax: g.inputTaxMinor.toString(),
        netPayable: g.netPayableMinor.toString(),
        output: half(g.outputTaxMinor),
        input: half(g.inputTaxMinor),
      };
    });
  });

export const fetchReceivablesAging = createServerFn({ method: "GET" })
  .validator(z.object({ asOf: z.string() }).optional())
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();

    return withOrg(orgId, async (tx) => {
      const aging = await getReceivablesAging(tx, orgId, data?.asOf ?? defaultPeriod().to);
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
  });

export const fetchPayablesAging = createServerFn({ method: "GET" })
  .validator(z.object({ asOf: z.string() }).optional())
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    return withOrg(orgId, async (tx) => {
      const aging = await getPayablesAging(tx, orgId, data?.asOf ?? defaultPeriod().to);
      return {
        rows: aging.rows.map((r) => ({
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
  });

export const fetchDayBook = createServerFn({ method: "GET" })
  .validator(z.object({ from: z.string(), to: z.string() }).optional())
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const period = defaultPeriod();
    return withOrg(orgId, async (tx) => {
      const db = await getDayBook(tx, orgId, data?.from ?? period.from, data?.to ?? period.to);
      return {
        rows: db.rows.map((r) => ({
          entryNumber: r.entryNumber,
          entryDate: r.entryDate,
          source: r.source,
          reference: r.reference,
          memo: r.memo,
          status: r.status,
          amount: r.amountMinor.toString(),
        })),
        total: db.totalMinor.toString(),
      };
    });
  });

export const fetchCashFlow = createServerFn({ method: "GET" })
  .validator(z.object({ from: z.string(), to: z.string() }).optional())
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const period = defaultPeriod();
    return withOrg(orgId, async (tx) => {
      const cf = await getCashFlow(tx, orgId, data?.from ?? period.from, data?.to ?? period.to);
      const ser = (l: { label: string; amountMinor: bigint }[]) =>
        l.map((x) => ({ label: x.label, amount: x.amountMinor.toString() }));
      return {
        from: cf.from,
        to: cf.to,
        operating: ser(cf.operating),
        investing: ser(cf.investing),
        financing: ser(cf.financing),
        operatingTotal: cf.operatingTotalMinor.toString(),
        investingTotal: cf.investingTotalMinor.toString(),
        financingTotal: cf.financingTotalMinor.toString(),
        netCash: cf.netCashMinor.toString(),
        openingCash: cf.openingCashMinor.toString(),
        closingCash: cf.closingCashMinor.toString(),
        reconciles: cf.reconciles,
      };
    });
  });

export const fetchFinancialRatios = createServerFn({ method: "GET" }).handler(async () => {
  const orgId = await currentOrgId();
  const period = defaultPeriod();
  return withOrg(orgId, async (tx) => {
    const r = await getFinancialRatios(tx, orgId, period.from, period.to);
    return {
      ratios: r.ratios,
      currentAssets: r.currentAssetsMinor.toString(),
      currentLiabilities: r.currentLiabilitiesMinor.toString(),
    };
  });
});

export const fetchMonthlyPnl = createServerFn({ method: "GET" }).handler(async () => {
  const orgId = await currentOrgId();
  const period = defaultPeriod();
  return withOrg(orgId, async (tx) => {
    const rows = await getMonthlyPnl(tx, orgId, period.from, period.to);
    return rows.map((m) => ({
      month: m.month,
      revenue: m.revenueMinor.toString(),
      cogs: m.cogsMinor.toString(),
      grossProfit: m.grossProfitMinor.toString(),
      expenses: m.expensesMinor.toString(),
      netProfit: m.netProfitMinor.toString(),
    }));
  });
});

export const fetchStockSummary = createServerFn({ method: "GET" }).handler(async () => {
  const orgId = await currentOrgId();
  return withOrg(orgId, async (tx) => {
    const rows = await getStockSummary(tx, orgId);
    return rows.map((r) => ({
      name: r.name,
      sku: r.sku,
      onHandQty: r.onHandQty,
      avgCost: r.avgCostMinor.toString(),
      value: r.valueMinor.toString(),
    }));
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Lists
 * ──────────────────────────────────────────────────────────────────────────*/

export const fetchInvoices = createServerFn({ method: "GET" })
  .validator(z.object({ limit: z.number().max(200).optional() }).optional())
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();
    const rows = await withOrg(orgId, (tx) =>
      tx
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
        .limit(data?.limit ?? 50),
    );

    return rows.map((r) => ({
      ...r,
      total: r.totalMinor.toString(),
      paid: r.amountPaidMinor.toString(),
      balance: (r.totalMinor - r.amountPaidMinor).toString(),
      totalMinor: undefined,
      amountPaidMinor: undefined,
    }));
  });

/**
 * Global header search — a small, unified lookup across invoices, items and
 * contacts for the ⌘K box in the app shell. Read-only, tenant-scoped, and
 * capped at a handful of rows per group so the dropdown stays snappy. Returns
 * everything the client needs to render a row and route to it on click.
 */
export const globalSearch = createServerFn({ method: "GET" })
  .validator(z.object({ q: z.string() }))
  .handler(async ({ data }) => {
    const q = data.q.trim();
    // Below two chars the result set is too broad to be useful; skip the queries.
    if (q.length < 2) return { invoices: [], items: [], contacts: [] };

    const orgId = await currentOrgId();

    const [itemRows, contactRows, invoiceRows] = await Promise.all([
      listItems(orgId, { search: q }),
      listContacts(orgId, { search: q }),
      withOrg(orgId, (tx) =>
        tx
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            customerName: contacts.displayName,
            status: invoices.status,
          })
          .from(invoices)
          .innerJoin(contacts, eq(contacts.id, invoices.contactId))
          .where(
            and(
              eq(invoices.orgId, orgId),
              or(ilike(invoices.invoiceNumber, `%${q}%`), ilike(contacts.displayName, `%${q}%`)),
            ),
          )
          .orderBy(desc(invoices.invoiceDate))
          .limit(6),
      ),
    ]);

    return {
      invoices: invoiceRows.map((r) => ({
        id: r.id,
        label: r.invoiceNumber,
        sub: r.customerName,
        status: r.status,
      })),
      items: itemRows.slice(0, 6).map((i) => ({
        id: i.id,
        label: i.name,
        sub: i.sku ?? "",
      })),
      contacts: contactRows.slice(0, 6).map((c) => ({
        id: c.id,
        label: c.displayName,
        sub: c.type,
      })),
    };
  });

/**
 * One invoice with everything the detail page renders: header, the customer,
 * its lines, and the payments applied so far. All in a single tenant-scoped
 * transaction so the picture is internally consistent.
 */
export const fetchInvoiceDetail = createServerFn({ method: "GET" })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const orgId = await currentOrgId();

    return withOrg(orgId, async (tx) => {
      const [inv] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, data.id), eq(invoices.orgId, orgId)));
      if (!inv) throw new Error("Invoice not found.");

      const [customer] = await tx.select().from(contacts).where(eq(contacts.id, inv.contactId));

      const lines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, inv.id))
        .orderBy(invoiceLines.lineNumber);

      const paymentRows = await tx.execute(sql`
        select p.payment_number, p.payment_date, p.method, pa.amount_minor
        from payment_allocations pa
        join payments p on p.id = pa.payment_id
        where pa.invoice_id = ${inv.id} and pa.org_id = ${orgId}
        order by p.payment_date
      `);

      return {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        status: inv.status,
        currency: inv.currency,
        exchangeRate: inv.exchangeRate,
        foreignTotal: inv.foreignTotalMinor != null ? inv.foreignTotalMinor.toString() : null,
        notes: inv.notes,
        terms: inv.terms,
        subtotal: inv.subtotalMinor.toString(),
        taxTotal: inv.taxTotalMinor.toString(),
        total: inv.totalMinor.toString(),
        paid: inv.amountPaidMinor.toString(),
        balance: (inv.totalMinor - inv.amountPaidMinor).toString(),
        customer: customer
          ? {
              id: customer.id,
              name: customer.displayName,
              email: customer.email,
              taxRegistrationNumber: customer.taxRegistrationNumber,
            }
          : null,
        lines: lines.map((l) => ({
          id: l.id,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPriceMinor.toString(),
          taxAmount: l.taxAmountMinor.toString(),
          lineTotal: l.lineTotalMinor.toString(),
        })),
        payments: (paymentRows as unknown as Array<Record<string, string>>).map((p) => ({
          paymentNumber: p.payment_number,
          paymentDate: p.payment_date,
          method: p.method,
          amount: p.amount_minor,
        })),
      };
    });
  });

/**
 * Cash and bank accounts a receipt can be deposited into — the "which account
 * did the money land in" dropdown on the payment form.
 */
export const fetchDepositAccounts = createServerFn({ method: "GET" }).handler(async () => {
  const orgId = await currentOrgId();
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(accounts)
      .where(
        and(
          eq(accounts.orgId, orgId),
          eq(accounts.subtype, "cash_and_bank"),
          eq(accounts.isGroup, false),
          eq(accounts.isActive, true),
        ),
      )
      .orderBy(accounts.code);
    return rows;
  });
});

export const fetchChartOfAccounts = createServerFn({ method: "GET" }).handler(async () => {
  const orgId = await currentOrgId();

  // Balances come from the ledger, joined on — never stored on the account.
  const rows = (await withOrg(orgId, (tx) =>
    tx.execute(sql`
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
    `),
  )) as unknown as Array<Record<string, string | boolean | null>>;

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
    const rows = (await withOrg(orgId, (tx) =>
      tx.execute(sql`
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
    `),
    )) as unknown as Array<Record<string, string>>;

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
    // Raising a draft is a staff-level act; posting it to the ledger is not.
    // When the caller asks for both in one step, they need both capabilities.
    const principal = await requirePermission("document:create");
    if (data.postImmediately) assertCan(principal, "ledger:post");
    const orgId = principal.orgId;

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
      await postInvoice({ orgId, invoiceId: result.invoiceId, userId: principal.userId });
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
    const principal = await requirePermission("ledger:post");
    const entry = await postInvoice({
      orgId: principal.orgId,
      invoiceId: data.invoiceId,
      userId: principal.userId,
    });
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
    const principal = await requirePermission("payment:record");
    const orgId = principal.orgId;
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
