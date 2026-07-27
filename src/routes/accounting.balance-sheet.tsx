import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Download, Printer } from "lucide-react";
import { fetchBalanceSheet } from "@/api";
import { formatMinor } from "@/lib/money";
import { downloadCsv } from "@/lib/export";
import { ReportPeriodPicker } from "@/components/ReportPeriodPicker";
import { DEFAULT_PRESET, type PresetKey } from "@/lib/report-periods";

type BsSearch = { preset?: PresetKey; asOf?: string };

export const Route = createFileRoute("/accounting/balance-sheet")({
  // The "as of" date lives in the URL — shareable, refresh-safe, and steppable
  // with the back button. The balance sheet is a point-in-time snapshot, so only
  // the end date matters; each range preset maps to its end date.
  validateSearch: (search: Record<string, unknown>): BsSearch => ({
    preset: typeof search.preset === "string" ? (search.preset as PresetKey) : undefined,
    asOf: typeof search.asOf === "string" ? search.asOf : undefined,
  }),
  loaderDeps: ({ search }) => ({ asOf: search.asOf }),
  loader: async ({ deps }) =>
    fetchBalanceSheet({ data: deps.asOf ? { asOf: deps.asOf } : undefined }),
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
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const preset = search.preset ?? DEFAULT_PRESET;

  function exportCsv() {
    const rows: string[][] = [];
    for (const l of bs.assets) rows.push(["Assets", l.name, formatMinor(l.amountMinor)]);
    rows.push(["", "Total Assets", formatMinor(bs.totalAssets)]);
    for (const l of bs.liabilities) rows.push(["Liabilities", l.name, formatMinor(l.amountMinor)]);
    rows.push(["", "Total Liabilities", formatMinor(bs.totalLiabilities)]);
    for (const l of bs.equity) rows.push(["Equity", l.name, formatMinor(l.amountMinor)]);
    rows.push(["Equity", "Retained Earnings", formatMinor(bs.retainedEarnings)]);
    rows.push(["", "Total Equity", formatMinor(bs.totalEquity)]);
    downloadCsv(`balance-sheet_as-of_${bs.asOf}.csv`, ["Section", "Account", "Amount"], rows);
  }

  const actions = (
    <div className="flex items-center gap-2 print:hidden">
      <ReportPeriodPicker
        mode="asOf"
        preset={preset}
        asOf={bs.asOf}
        onApply={({ preset, asOf }) => navigate({ search: { preset, asOf } })}
      />
      <Button variant="outline" size="sm" onClick={exportCsv}>
        <Download className="mr-1.5 h-4 w-4" />
        CSV
      </Button>
      <Button variant="outline" size="sm" onClick={() => window.print()}>
        <Printer className="mr-1.5 h-4 w-4" />
        Print / PDF
      </Button>
    </div>
  );

  return (
    <>
      <PageHeader title="Balance Sheet" subtitle={`As of ${bs.asOf}`} actions={actions} />
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
