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
import { fetchStockSummary } from "@/api/index";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/reports/stock")({
  loader: async () => fetchStockSummary(),
  component: StockSummary,
});

function StockSummary() {
  const rows = Route.useLoaderData();
  const totalValue = rows.reduce((a, r) => a + BigInt(r.value), 0n).toString();
  return (
    <>
      <PageHeader
        title="Stock Summary"
        subtitle="On-hand quantity and weighted-average valuation"
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Avg cost</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No stock-tracked items.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.name} className="hover:bg-muted/40">
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.sku ?? "—"}
                    </TableCell>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(r.onHandQty)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMinor(r.avgCost)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMinor(r.value)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
            {rows.length > 0 ? (
              <tfoot>
                <TableRow className="border-t-2">
                  <TableCell colSpan={4} className="font-semibold">
                    Total inventory value
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatMinor(totalValue)}
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
