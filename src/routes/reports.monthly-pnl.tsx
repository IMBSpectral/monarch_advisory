import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchMonthlyPnl } from "@/api/index";
import { formatMinorSigned, formatMinor } from "@/lib/money";

export const Route = createFileRoute("/reports/monthly-pnl")({
  loader: async () => fetchMonthlyPnl(),
  component: MonthlyPnl,
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => {
  const [y, mm] = m.split("-");
  return `${MONTHS[Number(mm) - 1]} ${y}`;
};

function MonthlyPnl() {
  const rows = Route.useLoaderData();
  const sum = (k: "revenue" | "cogs" | "grossProfit" | "expenses" | "netProfit") =>
    rows.reduce((a, r) => a + BigInt(r[k]), 0n).toString();

  return (
    <>
      <PageHeader title="Monthly P&L" subtitle="Revenue, cost and profit by month" />
      <div className="p-6">
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Metric</TableHead>
                {rows.map((r) => (
                  <TableHead key={r.month} className="text-right">{monthLabel(r.month)}</TableHead>
                ))}
                <TableHead className="text-right font-semibold">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <Line label="Revenue" rows={rows} k="revenue" total={sum("revenue")} />
              <Line label="Cost of goods sold" rows={rows} k="cogs" total={sum("cogs")} muted />
              <Line label="Gross profit" rows={rows} k="grossProfit" total={sum("grossProfit")} bold />
              <Line label="Operating expenses" rows={rows} k="expenses" total={sum("expenses")} muted />
              <Line label="Net profit" rows={rows} k="netProfit" total={sum("netProfit")} bold signed />
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}

function Line({
  label,
  rows,
  k,
  total,
  bold,
  muted,
  signed,
}: {
  label: string;
  rows: any[];
  k: string;
  total: string;
  bold?: boolean;
  muted?: boolean;
  signed?: boolean;
}) {
  const fmt = signed ? formatMinorSigned : formatMinor;
  return (
    <TableRow className={bold ? "border-t font-semibold" : ""}>
      <TableCell className={muted ? "text-muted-foreground" : ""}>{label}</TableCell>
      {rows.map((r) => (
        <TableCell key={r.month} className="text-right tabular-nums">{fmt(r[k])}</TableCell>
      ))}
      <TableCell className="text-right font-semibold tabular-nums">{fmt(total)}</TableCell>
    </TableRow>
  );
}
