import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { addMonths, format, parseISO } from "date-fns";
import { FileText, Download, Info, Printer } from "lucide-react";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchGstSummary, fetchGstr1Json } from "@/api";
import { formatMinor } from "@/lib/money";
import { downloadCsv } from "@/lib/export";
import { ReportPeriodPicker } from "@/components/ReportPeriodPicker";
import { DEFAULT_PRESET, type PresetKey } from "@/lib/report-periods";

type GstSearch = { preset?: PresetKey; from?: string; to?: string };

export const Route = createFileRoute("/accounting/gst")({
  // Same period model as the P&L: the window lives in the URL, so a GST period
  // is shareable, refresh-safe, and re-fetches when it changes.
  validateSearch: (search: Record<string, unknown>): GstSearch => ({
    preset: typeof search.preset === "string" ? (search.preset as PresetKey) : undefined,
    from: typeof search.from === "string" ? search.from : undefined,
    to: typeof search.to === "string" ? search.to : undefined,
  }),
  loaderDeps: ({ search }) => ({ from: search.from, to: search.to }),
  loader: async ({ deps }) => fetchGstSummary({ data: { from: deps.from, to: deps.to } }),
  component: GST,
});

/** GST filing due dates key off the month AFTER the period end. */
function dueDate(to: string, day: number): string {
  const next = addMonths(parseISO(to), 1);
  return format(new Date(next.getFullYear(), next.getMonth(), day), "dd MMM yyyy");
}

function GST() {
  const g = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const preset = search.preset ?? DEFAULT_PRESET;
  const periodLabel = `${g.from} – ${g.to}`;

  // Headline amount per return, straight from the period's ledger figures.
  const returns = [
    {
      name: "GSTR-1",
      desc: "Outward supplies",
      due: dueDate(g.to, 11),
      status: "Ready",
      amount: g.taxableSales,
    },
    {
      name: "GSTR-3B",
      desc: "Monthly summary",
      due: dueDate(g.to, 20),
      status: "Draft",
      amount: g.netPayable,
    },
    {
      name: "GSTR-2B",
      desc: "Auto-drafted ITC",
      due: "—",
      status: "Reconciled",
      amount: g.inputTax,
    },
    { name: "GSTR-9", desc: "Annual return", due: "31 Dec", status: "Pending", amount: "0" },
  ];

  // Output tax is split by place of supply (CGST/SGST intra-state, IGST inter-
  // state), read from the component accounts. The three sum to Output GST.
  const summary: { l: string; v: string; hi?: boolean; sub?: boolean }[] = [
    { l: "Taxable outward supplies", v: g.taxableSales },
    { l: "Output GST (on sales)", v: g.outputTax },
    { l: "— Output CGST", v: g.outputCgst, sub: true },
    { l: "— Output SGST", v: g.outputSgst, sub: true },
    { l: "— Output IGST", v: g.outputIgst, sub: true },
    ...(g.rcmPayable !== "0" ? [{ l: "GST under reverse charge (RCM)", v: g.rcmPayable }] : []),
    { l: "Input tax credit (ITC on purchases)", v: g.inputTax },
    { l: "— Input CGST", v: g.inputCgst, sub: true },
    { l: "— Input SGST", v: g.inputSgst, sub: true },
    { l: "— Input IGST", v: g.inputIgst, sub: true },
    { l: "Net GST Payable", v: g.netPayable, hi: true },
  ];

  async function downloadGstr1Json() {
    const json = await fetchGstr1Json({ data: { from: g.from, to: g.to } });
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `GSTR1_${json.fp}_${json.gstin || "return"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const actions = (
    <div className="flex items-center gap-2 print:hidden">
      <ReportPeriodPicker
        mode="range"
        preset={preset}
        from={g.from}
        to={g.to}
        onApply={({ preset, from, to }) => navigate({ search: { preset, from, to } })}
      />
      <Button variant="outline" size="sm" onClick={downloadGstr1Json}>
        <Download className="mr-1.5 h-4 w-4" />
        GSTR-1 JSON
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
        title="GST Returns"
        subtitle={`GSTR-1, 3B, 2B & 9 · ${periodLabel}`}
        actions={actions}
      />
      <div className="p-6 space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-brand/20 bg-brand/5 px-4 py-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Return-ready figures.</span> Output tax
            and ITC are split by place of supply (CGST/SGST intra-state, IGST inter-state), reverse
            charge is self-assessed, blocked credits are excluded from ITC, and the GSTR-1 rate-wise
            and HSN detail below is built from your invoices. Actual e-filing still needs a GSP
            integration — export any table to hand it to your CA.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {returns.map((r) => (
            <Card key={r.name} className="p-5">
              <div className="flex items-start justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-brand">
                  <FileText className="h-4 w-4 text-white" />
                </div>
                <Badge
                  variant={r.status === "Ready" ? "default" : "secondary"}
                  className={r.status === "Ready" ? "bg-success text-success-foreground" : ""}
                >
                  {r.status}
                </Badge>
              </div>
              <p className="font-semibold mt-3">{r.name}</p>
              <p className="text-xs text-muted-foreground">{r.desc}</p>
              <p className="text-sm text-muted-foreground mt-2">
                Due: <span className="text-foreground font-medium">{r.due}</span>
              </p>
              {r.amount !== "0" && (
                <p className="text-lg font-semibold tabular-nums mt-1">{formatMinor(r.amount)}</p>
              )}
            </Card>
          ))}
        </div>
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold">GST Summary — {periodLabel}</h3>
              <p className="text-xs text-muted-foreground">
                Output tax, input tax credit, and net payable
              </p>
            </div>
            <Button
              size="sm"
              className="bg-gradient-brand text-white print:hidden"
              onClick={() =>
                downloadCsv(
                  `gst-summary_${g.from}_to_${g.to}.csv`,
                  ["Line item", "Amount"],
                  summary.map((s) => [s.l, formatMinor(s.v)]),
                )
              }
            >
              <Download className="h-4 w-4 mr-1.5" />
              Download
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
            {summary.map((s) => (
              <div
                key={s.l}
                className={`flex justify-between py-2 px-3 rounded-lg ${s.hi ? "bg-gradient-to-r from-brand/10 to-transparent border border-brand/20" : "border-b"}`}
              >
                <span className={s.hi ? "font-semibold" : "text-muted-foreground"}>{s.l}</span>
                <span className={`tabular-nums ${s.hi ? "font-bold text-brand" : ""}`}>
                  {formatMinor(s.v)}
                </span>
              </div>
            ))}
          </div>
        </Card>

        {/* GSTR-1 — rate-wise outward supplies */}
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="font-semibold">GSTR-1 — rate-wise outward supplies</h3>
              <p className="text-xs text-muted-foreground">
                Taxable value and tax by rate, split by place of supply
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="print:hidden"
              onClick={() =>
                downloadCsv(
                  `gstr1-rate-wise_${g.from}_to_${g.to}.csv`,
                  ["Rate", "Taxable value", "CGST", "SGST", "IGST", "Total tax"],
                  g.rateWise.map((r) => [
                    r.rateName,
                    formatMinor(r.taxable),
                    formatMinor(r.cgst),
                    formatMinor(r.sgst),
                    formatMinor(r.igst),
                    formatMinor(r.totalTax),
                  ]),
                )
              }
            >
              <Download className="mr-1.5 h-4 w-4" />
              Export
            </Button>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rate</TableHead>
                  <TableHead className="text-right">Taxable value</TableHead>
                  <TableHead className="text-right">CGST</TableHead>
                  <TableHead className="text-right">SGST</TableHead>
                  <TableHead className="text-right">IGST</TableHead>
                  <TableHead className="text-right">Total tax</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.rateWise.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                      No outward supplies in this period.
                    </TableCell>
                  </TableRow>
                ) : (
                  g.rateWise.map((r) => (
                    <TableRow key={`${r.rateBps}-${r.rateName}`}>
                      <TableCell>{r.rateName}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMinor(r.taxable)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMinor(r.cgst)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMinor(r.sgst)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMinor(r.igst)}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatMinor(r.totalTax)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </Card>

        {/* HSN / SAC summary */}
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="font-semibold">HSN / SAC summary</h3>
              <p className="text-xs text-muted-foreground">
                Outward supplies grouped by HSN/SAC code
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="print:hidden"
              onClick={() =>
                downloadCsv(
                  `gst-hsn-summary_${g.from}_to_${g.to}.csv`,
                  ["HSN/SAC", "Description", "Quantity", "Taxable value", "Tax"],
                  g.hsn.map((h) => [
                    h.hsn,
                    h.description,
                    h.quantity,
                    formatMinor(h.taxable),
                    formatMinor(h.tax),
                  ]),
                )
              }
            >
              <Download className="mr-1.5 h-4 w-4" />
              Export
            </Button>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>HSN/SAC</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Taxable value</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.hsn.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      No outward supplies in this period.
                    </TableCell>
                  </TableRow>
                ) : (
                  g.hsn.map((h) => (
                    <TableRow key={h.hsn}>
                      <TableCell className="font-mono text-xs">{h.hsn}</TableCell>
                      <TableCell className="max-w-xs truncate">{h.description}</TableCell>
                      <TableCell className="text-right tabular-nums">{h.quantity}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMinor(h.taxable)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMinor(h.tax)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>
    </>
  );
}
