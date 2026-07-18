import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, FunnelChart, Funnel, LabelList } from "recharts";
import { revenueSeries, salesFunnel, inr } from "@/data/mock";

export const Route = createFileRoute("/sales/")({ component: SalesDashboard });

function SalesDashboard() {
  return (
    <>
      <PageHeader title="Sales Dashboard" subtitle="Pipeline, revenue, and top performers" />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {[
            { l: "MTD Sales", v: "₹68.4L", d: "+18% MoM" },
            { l: "Deals Won", v: "41", d: "of 342 leads" },
            { l: "Avg Deal Size", v: "₹1.42L", d: "+9% QoQ" },
          ].map((s) => (
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
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={revenueSeries}>
                <defs>
                  <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(0.55 0.14 165)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="oklch(0.55 0.14 165)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0.01 255)" vertical={false} />
                <XAxis dataKey="m" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v/100000).toFixed(0)}L`} />
                <Tooltip formatter={(v: number) => inr(v)} />
                <Area type="monotone" dataKey="revenue" stroke="oklch(0.55 0.14 165)" strokeWidth={2.5} fill="url(#sg)" />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
          <Card className="p-5">
            <h3 className="font-semibold mb-4">Sales Funnel</h3>
            <div className="space-y-2">
              {salesFunnel.map((f, i) => {
                const pct = (f.value / salesFunnel[0].value) * 100;
                return (
                  <div key={f.stage}>
                    <div className="flex justify-between text-sm mb-1">
                      <span>{f.stage}</span>
                      <span className="tabular-nums font-medium">{f.value}</span>
                    </div>
                    <div className="h-8 rounded-md bg-muted overflow-hidden">
                      <div className="h-full bg-gradient-brand flex items-center justify-end px-2 text-xs text-white font-medium" style={{ width: `${pct}%` }}>
                        {pct.toFixed(0)}%
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
