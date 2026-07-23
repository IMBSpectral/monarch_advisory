import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fetchCashFlow } from "@/api/index";
import { formatMinor, formatMinorSigned } from "@/lib/money";

export const Route = createFileRoute("/reports/cash-flow")({
  loader: async () => fetchCashFlow({ data: undefined }),
  component: CashFlow,
});

function Section({
  title,
  rows,
  total,
}: {
  title: string;
  rows: { label: string; amount: string }[];
  total: string;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-widest text-brand">{title}</h3>
      <div className="mt-2 space-y-1">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity.</p>
        ) : (
          rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{r.label}</span>
              <span className="tabular-nums">{formatMinorSigned(r.amount)}</span>
            </div>
          ))
        )}
      </div>
      <div className="mt-2 flex items-center justify-between border-t pt-2 font-semibold">
        <span>Net cash from {title.toLowerCase()}</span>
        <span className="tabular-nums">{formatMinorSigned(total)}</span>
      </div>
    </div>
  );
}

function CashFlow() {
  const cf = Route.useLoaderData();
  return (
    <>
      <PageHeader title="Cash Flow Statement" subtitle={`${cf.from} → ${cf.to}`} />
      <div className="p-6">
        <Card className="mx-auto max-w-2xl p-8">
          <div className="mb-6 text-center">
            <h2 className="text-xl font-bold">Cash Flow Statement</h2>
            <p className="text-sm text-muted-foreground">For period {cf.from} → {cf.to}</p>
            <Badge
              variant="outline"
              className={cf.reconciles ? "mt-2 border-success/20 bg-success/10 text-success" : "mt-2 border-destructive/20 bg-destructive/10 text-destructive"}
            >
              {cf.reconciles ? "Reconciled" : "Does not reconcile"}
            </Badge>
          </div>

          <div className="space-y-6">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Opening cash & bank</span>
              <span className="tabular-nums font-medium">{formatMinor(cf.openingCash)}</span>
            </div>

            <Section title="Operating" rows={cf.operating} total={cf.operatingTotal} />
            <Section title="Investing" rows={cf.investing} total={cf.investingTotal} />
            <Section title="Financing" rows={cf.financing} total={cf.financingTotal} />

            <div className="flex items-center justify-between border-t-2 pt-3 text-base font-bold">
              <span>Net change in cash</span>
              <span className="tabular-nums text-brand">{formatMinorSigned(cf.netCash)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Closing cash & bank</span>
              <span className="tabular-nums font-medium">{formatMinor(cf.closingCash)}</span>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
