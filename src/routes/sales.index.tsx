import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { fetchDashboard } from "@/api";
import { formatMinor, inr } from "@/lib/money";

export const Route = createFileRoute("/sales/")({
  // Real ledger figures, loaded on the server so the first paint has numbers.
  loader: async () => fetchDashboard({ data: {} }),
  component: SalesDashboard,
});

function SalesDashboard() {
  const { summary, trend, topDebtors, period } = Route.useLoaderData();

  // Recharts needs numbers, and these are display-only aggregates, so converting
  // to rupees here is safe. Never do this for anything that feeds a calculation.
  const revenueData = trend.map((t) => ({
    m: t.month,
    revenue: Number(BigInt(t.revenue) / 100n),
  }));

  const kpis = [
    {
      l: "Revenue (period)",
      v: formatMinor(summary.revenue, { compact: true }),
      d: `${period.from} → ${period.to}`,
    },
    {
      l: "Net Profit",
      v: formatMinor(summary.netProfit, { compact: true }),
      d: BigInt(summary.netProfit) < 0n ? "Operating at a loss" : "Period to date",
    },
    {
      l: "Receivables",
      v: formatMinor(summary.receivables, { compact: true }),
      d: `${formatMinor(summary.overdueReceivables, { compact: true })} overdue`,
    },
  ];

  return (
    <>
      <PageHeader title="Sales Dashboard" subtitle="Revenue trend and top receivables" />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {kpis.map((s) => (
            <Card key={s.l} className="p-5">
              <p className="text-xs uppercase tracking-widest text-muted-foreground">{s.l}</p>
              <p className="text-2xl font-semibold tabular-nums mt-1">{s.v}</p>
              <p className="text-xs text-success mt-1">{s.d}</p>
            </Card>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="p-5">
            <h3 className="font-semibold mb-4">Revenue Trend</h3>
            <p className="text-xs text-muted-foreground -mt-3 mb-4">
              Posted journal entries by month
            </p>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={revenueData}>
                <defs>
                  <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(0.55 0.14 165)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="oklch(0.55 0.14 165)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="oklch(0.92 0.01 255)"
                  vertical={false}
                />
                <XAxis dataKey="m" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`}
                />
                <Tooltip formatter={(v: number) => inr(v)} />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke="oklch(0.55 0.14 165)"
                  strokeWidth={2.5}
                  fill="url(#sg)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
          <Card className="p-5">
            <h3 className="font-semibold mb-4">Top Debtors</h3>
            <p className="text-xs text-muted-foreground -mt-3 mb-4">
              Customers with the largest outstanding balances
            </p>
            <div className="space-y-2">
              {topDebtors.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No outstanding receivables. Everyone's paid up.
                </p>
              ) : (
                topDebtors.map((c) => {
                  const total = Number(BigInt(c.total) / 100n);
                  const max = Number(BigInt(topDebtors[0].total) / 100n) || 1;
                  const pct = (total / max) * 100;
                  return (
                    <div key={c.contactId}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="font-medium">{c.name}</span>
                        <span className="tabular-nums font-medium">{formatMinor(c.total)}</span>
                      </div>
                      <div className="h-8 rounded-md bg-muted overflow-hidden">
                        <div
                          className="h-full bg-gradient-brand flex items-center justify-end px-2 text-xs text-white font-medium"
                          style={{ width: `${pct}%` }}
                        >
                          {BigInt(c.overdue) > 0n
                            ? `${formatMinor(c.overdue, { compact: true })} overdue`
                            : ""}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
