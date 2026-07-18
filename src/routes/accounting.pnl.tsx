import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { inr } from "@/data/mock";

export const Route = createFileRoute("/accounting/pnl")({ component: PnL });

const rows = [
  { section: "Revenue", items: [
    { l: "Product Sales", v: 38940000 },
    { l: "Services Revenue", v: 9785000 },
  ], total: 48725000, positive: true },
  { section: "Cost of Goods Sold", items: [
    { l: "Direct Materials", v: 15840000 },
    { l: "Manufacturing", v: 6300000 },
  ], total: 22140000 },
  { section: "Operating Expenses", items: [
    { l: "Salaries & Wages", v: 8940000 },
    { l: "Rent & Utilities", v: 2680000 },
    { l: "Marketing", v: 3120000 },
    { l: "Cloud & SaaS", v: 2005000 },
  ], total: 16745000 },
];

function PnL() {
  const revenue = rows[0].total;
  const gross = revenue - rows[1].total;
  const op = gross - rows[2].total;
  return (
    <>
      <PageHeader title="Profit & Loss Statement" subtitle="April 2026 – July 2026 (YTD)" />
      <div className="p-6">
        <Card className="p-8 max-w-4xl mx-auto shadow-elegant">
          <div className="text-center mb-6">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">IMB Labs LLP</p>
            <h2 className="text-2xl font-bold tracking-tight">Profit & Loss Statement</h2>
            <p className="text-sm text-muted-foreground">For period Apr 01 – Jul 18, 2026</p>
          </div>
          <div className="space-y-6">
            {rows.map((r) => (
              <div key={r.section}>
                <p className="font-semibold text-sm uppercase tracking-wider text-muted-foreground mb-2">{r.section}</p>
                {r.items.map((i) => (
                  <div key={i.l} className="flex justify-between py-1.5 text-sm border-b border-dashed border-border/50">
                    <span className="text-muted-foreground pl-4">{i.l}</span>
                    <span className="tabular-nums">{inr(i.v)}</span>
                  </div>
                ))}
                <div className={`flex justify-between py-2 font-semibold ${r.positive ? "text-success" : ""}`}>
                  <span>Total {r.section}</span>
                  <span className="tabular-nums">{inr(r.total)}</span>
                </div>
              </div>
            ))}
            <Separator />
            <div className="space-y-2">
              <div className="flex justify-between text-lg">
                <span className="font-semibold">Gross Profit</span>
                <span className="tabular-nums font-semibold text-brand">{inr(gross)}</span>
              </div>
              <div className="flex justify-between text-xl">
                <span className="font-bold">Net Operating Profit</span>
                <span className="tabular-nums font-bold text-brand">{inr(op)}</span>
              </div>
              <p className="text-xs text-muted-foreground text-right">Margin: {((op/revenue)*100).toFixed(1)}%</p>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
