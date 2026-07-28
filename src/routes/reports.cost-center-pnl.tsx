import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchCostCenterPnl } from "@/api/dimensions";
import { formatMinor, formatMinorSigned } from "@/lib/money";

export const Route = createFileRoute("/reports/cost-center-pnl")({
  loader: async () => fetchCostCenterPnl(),
  component: CostCenterPnl,
});

function CostCenterPnl() {
  const rows = Route.useLoaderData();
  const tot = (k: "revenue" | "expense" | "net") =>
    rows.reduce((a, r) => a + BigInt(r[k]), 0n).toString();

  return (
    <>
      <PageHeader
        title="Cost-Centre P&L"
        subtitle="Revenue and cost attributed by department / project"
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cost centre</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                    No P&L activity in this period.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.name} className="hover:bg-muted/40">
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMinor(r.revenue)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMinor(r.expense)}
                    </TableCell>
                    <TableCell
                      className={`text-right font-medium tabular-nums ${BigInt(r.net) < 0n ? "text-destructive" : "text-success"}`}
                    >
                      {formatMinorSigned(r.net)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
            {rows.length > 0 ? (
              <tfoot>
                <TableRow className="border-t-2 font-semibold">
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMinor(tot("revenue"))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMinor(tot("expense"))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMinorSigned(tot("net"))}
                  </TableCell>
                </TableRow>
              </tfoot>
            ) : null}
          </Table>
        </Card>
      </div>
    </>
  );
}
