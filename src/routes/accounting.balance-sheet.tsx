import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { fetchBalanceSheet } from "@/api";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/accounting/balance-sheet")({
  loader: async () => fetchBalanceSheet({ data: undefined }),
  component: BS,
});

type Line = { code: string; name: string; amountMinor: string };

function LineRow({ l }: { l: Line }) {
  return (
    <div className="flex justify-between py-1.5 text-sm border-b border-dashed">
      <span className="pl-2">{l.name}</span>
      <span className="tabular-nums">{formatMinor(l.amountMinor)}</span>
    </div>
  );
}

function BS() {
  const bs = Route.useLoaderData();

  return (
    <>
      <PageHeader title="Balance Sheet" subtitle={`As of ${bs.asOf}`} />
      <div className="p-6">
        <Card className="p-8 max-w-5xl mx-auto shadow-elegant">
          <div className="text-center mb-6">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">IMB Labs LLP</p>
            <h2 className="text-2xl font-bold tracking-tight">Balance Sheet</h2>
            <p className="text-sm text-muted-foreground">As of {bs.asOf}</p>
            <div className="mt-2">
              {bs.isBalanced ? (
                <Badge variant="outline" className="bg-success/10 text-success border-success/20">
                  Balanced
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="bg-destructive/10 text-destructive border-destructive/20"
                >
                  Out of balance
                </Badge>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <h3 className="font-bold text-brand border-b pb-2 mb-3">ASSETS</h3>
              <div className="mb-4">
                {bs.assets.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-1.5">No assets recorded.</p>
                ) : (
                  bs.assets.map((l) => <LineRow key={l.code} l={l} />)
                )}
              </div>
              <Separator className="my-3" />
              <div className="flex justify-between text-lg font-bold">
                <span>Total Assets</span>
                <span className="tabular-nums text-brand">{formatMinor(bs.totalAssets)}</span>
              </div>
            </div>
            <div>
              <h3 className="font-bold text-brand border-b pb-2 mb-3">LIABILITIES & EQUITY</h3>
              <div className="mb-4">
                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                  Liabilities
                </p>
                {bs.liabilities.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-1.5">No liabilities recorded.</p>
                ) : (
                  bs.liabilities.map((l) => <LineRow key={l.code} l={l} />)
                )}
                <div className="flex justify-between py-2 text-sm font-semibold">
                  <span>Total Liabilities</span>
                  <span className="tabular-nums">{formatMinor(bs.totalLiabilities)}</span>
                </div>
              </div>
              <div className="mb-4">
                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                  Equity
                </p>
                {bs.equity.map((l) => (
                  <LineRow key={l.code} l={l} />
                ))}
                <div className="flex justify-between py-1.5 text-sm border-b border-dashed">
                  <span className="pl-2">Retained Earnings</span>
                  <span className="tabular-nums">{formatMinor(bs.retainedEarnings)}</span>
                </div>
                <div className="flex justify-between py-2 text-sm font-semibold">
                  <span>Total Equity</span>
                  <span className="tabular-nums">{formatMinor(bs.totalEquity)}</span>
                </div>
              </div>
              <Separator className="my-3" />
              <div className="flex justify-between text-lg font-bold">
                <span>Total L & E</span>
                <span className="tabular-nums text-brand">{formatMinor(bs.totalAssets)}</span>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
