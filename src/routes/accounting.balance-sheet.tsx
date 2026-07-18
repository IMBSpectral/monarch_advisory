import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { inr } from "@/data/mock";

export const Route = createFileRoute("/accounting/balance-sheet")({ component: BS });

const assets = [
  { section: "Current Assets", items: [
    { l: "Cash & Bank", v: 18420000 },
    { l: "Accounts Receivable", v: 6285000 },
    { l: "Inventory", v: 12480000 },
  ]},
  { section: "Fixed Assets", items: [
    { l: "Equipment (net)", v: 8420000 },
    { l: "Furniture (net)", v: 3200000 },
    { l: "Intangibles", v: 2000000 },
  ]},
];

const liab = [
  { section: "Current Liabilities", items: [
    { l: "Accounts Payable", v: 3910000 },
    { l: "GST Payable", v: 1840000 },
  ]},
  { section: "Long-term Liabilities", items: [
    { l: "Bank Loan", v: 6730000 },
  ]},
];

const sum = (r: any[]) => r.reduce((s, x) => s + x.items.reduce((a: number, i: any) => a + i.v, 0), 0);

function BS() {
  const totalAssets = sum(assets);
  const totalLiab = sum(liab);
  const equity = totalAssets - totalLiab;
  return (
    <>
      <PageHeader title="Balance Sheet" subtitle="As of July 18, 2026" />
      <div className="p-6">
        <Card className="p-8 max-w-5xl mx-auto shadow-elegant">
          <div className="text-center mb-6">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">IMB Labs LLP</p>
            <h2 className="text-2xl font-bold tracking-tight">Balance Sheet</h2>
            <p className="text-sm text-muted-foreground">As of July 18, 2026</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <h3 className="font-bold text-brand border-b pb-2 mb-3">ASSETS</h3>
              {assets.map((s) => (
                <div key={s.section} className="mb-4">
                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-1">{s.section}</p>
                  {s.items.map((i) => (
                    <div key={i.l} className="flex justify-between py-1.5 text-sm border-b border-dashed">
                      <span className="pl-2">{i.l}</span>
                      <span className="tabular-nums">{inr(i.v)}</span>
                    </div>
                  ))}
                </div>
              ))}
              <Separator className="my-3" />
              <div className="flex justify-between text-lg font-bold">
                <span>Total Assets</span><span className="tabular-nums text-brand">{inr(totalAssets)}</span>
              </div>
            </div>
            <div>
              <h3 className="font-bold text-brand border-b pb-2 mb-3">LIABILITIES & EQUITY</h3>
              {liab.map((s) => (
                <div key={s.section} className="mb-4">
                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-1">{s.section}</p>
                  {s.items.map((i) => (
                    <div key={i.l} className="flex justify-between py-1.5 text-sm border-b border-dashed">
                      <span className="pl-2">{i.l}</span>
                      <span className="tabular-nums">{inr(i.v)}</span>
                    </div>
                  ))}
                </div>
              ))}
              <div className="mb-4">
                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-1">Equity</p>
                <div className="flex justify-between py-1.5 text-sm border-b border-dashed"><span className="pl-2">Partner Capital</span><span className="tabular-nums">{inr(20260000)}</span></div>
                <div className="flex justify-between py-1.5 text-sm border-b border-dashed"><span className="pl-2">Retained Earnings</span><span className="tabular-nums">{inr(equity - 20260000)}</span></div>
              </div>
              <Separator className="my-3" />
              <div className="flex justify-between text-lg font-bold">
                <span>Total L & E</span><span className="tabular-nums text-brand">{inr(totalAssets)}</span>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
