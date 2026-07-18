import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  TrendingUp,
  Wallet,
  Package,
  Users,
  FileText,
  Sparkles,
  AlertTriangle,
  Zap,
  Database,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { fetchDashboard } from "@/server/api";
import { formatMinor } from "@/lib/money";
import { aiInsights, inr } from "@/data/mock";

export const Route = createFileRoute("/")({
  // Loads on the server during SSR, so the first paint already has real numbers.
  loader: async () => fetchDashboard({ data: {} }),
  component: Dashboard,
});

/** A KPI sourced from the ledger. No delta unless we can actually compute one. */
function KPI({
  label,
  value,
  icon: Icon,
  accent,
  hint,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  accent: string;
  hint?: string;
}) {
  return (
    <Card className="p-5 relative overflow-hidden">
      <div className={`absolute -right-6 -top-6 h-24 w-24 rounded-full opacity-10 ${accent}`} />
      <div className="flex items-start justify-between relative">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
            {label}
          </p>
          <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight truncate">
            {value}
          </p>
          {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${accent}`}>
          <Icon className="h-4 w-4 text-white" />
        </div>
      </div>
    </Card>
  );
}

// Still fixtures — there is no inventory-valuation or category-revenue query yet.
// Kept visually so the demo reads complete, but labelled so nobody mistakes it
// for ledger data.
const pieData = [
  { name: "Peripherals", value: 32, color: "oklch(0.55 0.14 165)" },
  { name: "Displays", value: 24, color: "oklch(0.45 0.15 255)" },
  { name: "Laptops", value: 21, color: "oklch(0.7 0.15 55)" },
  { name: "Audio", value: 14, color: "oklch(0.65 0.2 320)" },
  { name: "Other", value: 9, color: "oklch(0.55 0.18 25)" },
];

function MockBadge() {
  return (
    <Badge variant="outline" className="text-[9px] uppercase tracking-wider text-muted-foreground">
      Sample data
    </Badge>
  );
}

function LiveBadge() {
  return (
    <Badge variant="secondary" className="gap-1 text-[9px] uppercase tracking-wider">
      <Database className="h-2.5 w-2.5" /> Ledger
    </Badge>
  );
}

function Dashboard() {
  const data = Route.useLoaderData();
  const { summary, trend, topDebtors, organization, period } = data;

  // Recharts needs numbers, and these are display-only aggregates, so converting
  // to rupees here is safe. Never do this for anything that feeds a calculation.
  const trendData = trend.map((t) => ({
    m: t.month,
    revenue: Number(BigInt(t.revenue) / 100n),
    expense: Number(BigInt(t.expense) / 100n),
  }));

  const netProfit = BigInt(summary.netProfit);

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-brand font-medium">
            Executive Dashboard
          </p>
          <h1 className="text-2xl font-semibold tracking-tight mt-1">{organization.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Fiscal period {period.from} → {period.to}
            {organization.taxRegistrationNumber && ` · GSTIN ${organization.taxRegistrationNumber}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LiveBadge />
          <Button variant="outline" size="sm">
            Export
          </Button>
          <Button size="sm" className="bg-gradient-brand text-white">
            This period ▾
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <KPI
          label="Revenue"
          value={formatMinor(summary.revenue, { compact: true })}
          icon={TrendingUp}
          accent="bg-gradient-brand"
          hint="Period to date"
        />
        <KPI
          label="Net Profit"
          value={formatMinor(summary.netProfit, { compact: true })}
          icon={Zap}
          accent="bg-gradient-gold"
          hint={netProfit < 0n ? "Operating at a loss" : "Period to date"}
        />
        <KPI
          label="Cash on Hand"
          value={formatMinor(summary.cash, { compact: true })}
          icon={Wallet}
          accent="bg-blue-600"
          hint="All bank accounts"
        />
        <KPI
          label="Receivables"
          value={formatMinor(summary.receivables, { compact: true })}
          icon={FileText}
          accent="bg-emerald-600"
          hint={`${formatMinor(summary.overdueReceivables, { compact: true })} overdue`}
        />
        <KPI
          label="Payables"
          value={formatMinor(summary.payables, { compact: true })}
          icon={Users}
          accent="bg-orange-600"
          hint="Owed to vendors"
        />
        <KPI
          label="Expenses"
          value={formatMinor(summary.expenses, { compact: true })}
          icon={Package}
          accent="bg-violet-600"
          hint="Period to date"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div>
                <h3 className="font-semibold">Revenue vs Expenses</h3>
                <p className="text-xs text-muted-foreground">Posted journal entries by month</p>
              </div>
              <LiveBadge />
            </div>
            <div className="flex gap-3 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-brand" />
                Revenue
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-chart-2" />
                Expenses
              </span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={trendData}>
              <defs>
                <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="oklch(0.55 0.14 165)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="oklch(0.55 0.14 165)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gExp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="oklch(0.45 0.15 255)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="oklch(0.45 0.15 255)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0.01 255)" vertical={false} />
              <XAxis dataKey="m" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis
                tick={{ fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`}
              />
              <Tooltip
                formatter={(v: number) => inr(v)}
                contentStyle={{ borderRadius: 8, border: "1px solid oklch(0.92 0.01 255)" }}
              />
              <Area
                type="monotone"
                dataKey="revenue"
                stroke="oklch(0.55 0.14 165)"
                strokeWidth={2.5}
                fill="url(#gRev)"
              />
              <Area
                type="monotone"
                dataKey="expense"
                stroke="oklch(0.45 0.15 255)"
                strokeWidth={2.5}
                fill="url(#gExp)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">Revenue by Category</h3>
            <MockBadge />
          </div>
          <p className="text-xs text-muted-foreground mb-4">Needs item-level revenue reporting</p>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={pieData}
                innerRadius={55}
                outerRadius={85}
                paddingAngle={2}
                dataKey="value"
              >
                {pieData.map((d, i) => (
                  <Cell key={i} fill={d.color} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <div className="space-y-1.5 mt-2">
            {pieData.map((d) => (
              <div key={d.name} className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: d.color }} />
                  {d.name}
                </span>
                <span className="tabular-nums font-medium">{d.value}%</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="h-4 w-4 text-brand" />
          <h3 className="font-semibold">AI Insights</h3>
          <MockBadge />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {aiInsights.map((ins, i) => (
            <div
              key={i}
              className="rounded-xl border bg-gradient-to-br from-brand/5 to-transparent p-4 hover:shadow-elegant transition-all"
            >
              <div className="flex items-start gap-2.5">
                {ins.icon === "trending" && <TrendingUp className="h-4 w-4 text-success mt-0.5" />}
                {ins.icon === "alert" && <AlertTriangle className="h-4 w-4 text-warning mt-0.5" />}
                {ins.icon === "sparkle" && <Sparkles className="h-4 w-4 text-brand mt-0.5" />}
                {ins.icon === "warn" && (
                  <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
                )}
                <div>
                  <p className="text-sm font-medium">{ins.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{ins.desc}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <div>
              <h3 className="font-semibold">Revenue vs Expenses</h3>
              <p className="text-xs text-muted-foreground">Monthly comparison</p>
            </div>
            <LiveBadge />
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0.01 255)" vertical={false} />
              <XAxis dataKey="m" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis
                tick={{ fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`}
              />
              <Tooltip
                formatter={(v: number) => inr(v)}
                contentStyle={{ borderRadius: 8, border: "1px solid oklch(0.92 0.01 255)" }}
              />
              <Bar dataKey="revenue" fill="oklch(0.55 0.14 165)" radius={[6, 6, 0, 0]} />
              <Bar dataKey="expense" fill="oklch(0.6 0.22 27)" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div>
                <h3 className="font-semibold">Outstanding Receivables</h3>
                <p className="text-xs text-muted-foreground">
                  Who owes the most, from the A/R subledger
                </p>
              </div>
              <LiveBadge />
            </div>
          </div>
          <div className="space-y-3">
            {topDebtors.length === 0 && (
              <p className="text-sm text-muted-foreground py-8 text-center">
                Nothing outstanding — every invoice is settled.
              </p>
            )}
            {topDebtors.map((c) => {
              const overdue = BigInt(c.overdue);
              return (
                <div key={c.contactId} className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-brand text-white text-sm font-semibold">
                    {c.name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {overdue > 0n ? (
                        <span className="text-destructive">
                          {formatMinor(c.overdue, { showPaise: false })} overdue
                        </span>
                      ) : (
                        "Within terms"
                      )}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold tabular-nums">
                      {formatMinor(c.total, { showPaise: false })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}
