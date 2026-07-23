import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchConsolidation } from "@/api/period";
import { formatMinor, formatMinorSigned } from "@/lib/money";

export const Route = createFileRoute("/reports/consolidation")({
  loader: async () => fetchConsolidation(),
  component: Consolidation,
});

function Consolidation() {
  const c = Route.useLoaderData();
  return (
    <>
      <PageHeader
        title="Group Consolidation"
        subtitle={`Every entity you belong to, rolled up · ${c.from} → ${c.to}`}
      />
      <div className="p-6">
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entity</TableHead>
                <TableHead className="text-right">Assets</TableHead>
                <TableHead className="text-right">Liabilities</TableHead>
                <TableHead className="text-right">Equity</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Net profit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.entities.map((e) => (
                <TableRow key={e.name} className="hover:bg-muted/40">
                  <TableCell className="font-medium">{e.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMinor(e.assets)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMinor(e.liabilities)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMinor(e.equity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMinor(e.revenue)}</TableCell>
                  <TableCell className={`text-right font-medium tabular-nums ${BigInt(e.netProfit) < 0n ? "text-destructive" : "text-success"}`}>
                    {formatMinorSigned(e.netProfit)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <tfoot>
              <TableRow className="border-t-2 font-semibold">
                <TableCell>Consolidated</TableCell>
                <TableCell className="text-right tabular-nums">{formatMinor(c.consolidated.assets)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMinor(c.consolidated.liabilities)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMinor(c.consolidated.equity)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMinor(c.consolidated.revenue)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMinorSigned(c.consolidated.netProfit)}</TableCell>
              </TableRow>
            </tfoot>
          </Table>
        </Card>
      </div>
    </>
  );
}
