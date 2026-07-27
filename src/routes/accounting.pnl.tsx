import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Download, Printer } from "lucide-react";
import { fetchProfitAndLoss } from "@/api";
import { formatMinor } from "@/lib/money";
import { downloadCsv } from "@/lib/export";
import { ReportPeriodPicker } from "@/components/ReportPeriodPicker";
import { DEFAULT_PRESET, type PresetKey } from "@/lib/report-periods";

type PnlSearch = { preset?: PresetKey; from?: string; to?: string };

export const Route = createFileRoute("/accounting/pnl")({
  // The reporting window lives in the URL, so a period is shareable, survives a
  // refresh, and the back button steps through periods.
  validateSearch: (search: Record<string, unknown>): PnlSearch => ({
    preset: typeof search.preset === "string" ? (search.preset as PresetKey) : undefined,
    from: typeof search.from === "string" ? search.from : undefined,
    to: typeof search.to === "string" ? search.to : undefined,
  }),
  loaderDeps: ({ search }) => ({ from: search.from, to: search.to }),
  loader: async ({ deps }) => fetchProfitAndLoss({ data: { from: deps.from, to: deps.to } }),
  component: PnL,
});

type Line = { code: string; name: string; subtype: string; amountMinor: string };

function Lines({ lines }: { lines: Line[] }) {
  if (lines.length === 0) {
    return (
      <div className="flex justify-between py-1.5 text-sm border-b border-dashed border-border/50">
        <span className="text-muted-foreground pl-4">No activity</span>
        <span className="tabular-nums text-muted-foreground">{formatMinor("0")}</span>
      </div>
    );
  }
  return (
    <>
      {lines.map((l) => (
        <div
          key={l.code}
          className="flex justify-between py-1.5 text-sm border-b border-dashed border-border/50"
        >
          <span className="text-muted-foreground pl-4">{l.name}</span>
          <span className="tabular-nums">{formatMinor(l.amountMinor)}</span>
        </div>
      ))}
    </>
  );
}

function Section({ title, lines, total }: { title: string; lines: Line[]; total: string }) {
  return (
    <div>
      <p className="font-semibold text-sm uppercase tracking-wider text-muted-foreground mb-2">
        {title}
      </p>
      <Lines lines={lines} />
      <div className="flex justify-between py-2 font-semibold">
        <span>Total {title}</span>
        <span className="tabular-nums">{formatMinor(total)}</span>
      </div>
    </div>
  );
}

function PnL() {
  const pnl = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const preset = search.preset ?? DEFAULT_PRESET;

  function exportCsv() {
    const rows: string[][] = [];
    const section = (title: string, lines: Line[]) => {
      for (const l of lines) rows.push([title, l.name, formatMinor(l.amountMinor)]);
    };
    section("Revenue", pnl.revenue);
    rows.push(["", "Total Revenue", formatMinor(pnl.totalRevenue)]);
    section("Cost of Goods Sold", pnl.costOfGoodsSold);
    rows.push(["", "Total Cost of Goods Sold", formatMinor(pnl.totalCogs)]);
    rows.push(["", "Gross Profit", formatMinor(pnl.grossProfit)]);
    section("Operating Expenses", pnl.operatingExpenses);
    rows.push(["", "Total Operating Expenses", formatMinor(pnl.totalOperatingExpense)]);
    rows.push(["", "Operating Profit", formatMinor(pnl.operatingProfit)]);
    section("Other Income", pnl.otherIncome);
    section("Other Expenses", pnl.otherExpenses);
    rows.push(["", "Net Profit", formatMinor(pnl.netProfit)]);
    downloadCsv(
      `profit-and-loss_${pnl.from}_to_${pnl.to}.csv`,
      ["Section", "Account", "Amount"],
      rows,
    );
  }

  const actions = (
    <div className="flex items-center gap-2 print:hidden">
      <ReportPeriodPicker
        mode="range"
        preset={preset}
        from={pnl.from}
        to={pnl.to}
        onApply={({ preset, from, to }) => navigate({ search: { preset, from, to } })}
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
      <PageHeader
        title="Profit & Loss Statement"
        subtitle={`${pnl.from} – ${pnl.to}`}
        actions={actions}
      />
      <div className="p-6">
        <Card className="p-8 max-w-4xl mx-auto shadow-elegant">
          <div className="text-center mb-6">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">IMB Labs LLP</p>
            <h2 className="text-2xl font-bold tracking-tight">Profit & Loss Statement</h2>
            <p className="text-sm text-muted-foreground">
              For period {pnl.from} – {pnl.to}
            </p>
          </div>
          <div className="space-y-6">
            <Section title="Revenue" lines={pnl.revenue} total={pnl.totalRevenue} />
            <Section title="Cost of Goods Sold" lines={pnl.costOfGoodsSold} total={pnl.totalCogs} />

            <div className="flex justify-between text-lg py-1 border-t border-border">
              <span className="font-semibold">Gross Profit</span>
              <span className="tabular-nums font-semibold text-brand">
                {formatMinor(pnl.grossProfit)}
              </span>
            </div>

            <Section
              title="Operating Expenses"
              lines={pnl.operatingExpenses}
              total={pnl.totalOperatingExpense}
            />

            <div className="flex justify-between text-lg py-1 border-t border-border">
              <span className="font-semibold">Operating Profit</span>
              <span className="tabular-nums font-semibold text-brand">
                {formatMinor(pnl.operatingProfit)}
              </span>
            </div>

            {pnl.otherIncome.length > 0 && (
              <div>
                <p className="font-semibold text-sm uppercase tracking-wider text-muted-foreground mb-2">
                  Other Income
                </p>
                <Lines lines={pnl.otherIncome} />
              </div>
            )}
            {pnl.otherExpenses.length > 0 && (
              <div>
                <p className="font-semibold text-sm uppercase tracking-wider text-muted-foreground mb-2">
                  Other Expenses
                </p>
                <Lines lines={pnl.otherExpenses} />
              </div>
            )}

            <Separator />
            <div className="flex justify-between text-xl">
              <span className="font-bold">Net Profit</span>
              <span className="tabular-nums font-bold text-brand">
                {formatMinor(pnl.netProfit)}
              </span>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
