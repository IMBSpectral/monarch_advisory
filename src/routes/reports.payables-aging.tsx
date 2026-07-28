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
import { fetchPayablesAging } from "@/api/index";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/reports/payables-aging")({
  loader: async () => fetchPayablesAging({ data: undefined }),
  component: PayablesAging,
});

const cell = (v: string) => (Number(v) ? formatMinor(v) : "—");

function PayablesAging() {
  const aging = Route.useLoaderData();
  return (
    <>
      <PageHeader title="Payables Aging" subtitle="What you owe vendors, by how overdue" />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">Current</TableHead>
                <TableHead className="text-right">1–30</TableHead>
                <TableHead className="text-right">31–60</TableHead>
                <TableHead className="text-right">61–90</TableHead>
                <TableHead className="text-right">90+</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {aging.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    Nothing outstanding to vendors.
                  </TableCell>
                </TableRow>
              ) : (
                aging.rows.map((r) => (
                  <TableRow key={r.contactName} className="hover:bg-muted/40">
                    <TableCell className="font-medium">{r.contactName}</TableCell>
                    <TableCell className="text-right tabular-nums">{cell(r.current)}</TableCell>
                    <TableCell className="text-right tabular-nums">{cell(r.days1to30)}</TableCell>
                    <TableCell className="text-right tabular-nums">{cell(r.days31to60)}</TableCell>
                    <TableCell className="text-right tabular-nums">{cell(r.days61to90)}</TableCell>
                    <TableCell className="text-right tabular-nums text-destructive">
                      {cell(r.over90)}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {formatMinor(r.total)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
            {aging.rows.length > 0 ? (
              <tfoot>
                <TableRow className="border-t-2">
                  <TableCell className="font-semibold">Total</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {cell(aging.totals.current)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {cell(aging.totals.days1to30)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {cell(aging.totals.days31to60)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {cell(aging.totals.days61to90)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {cell(aging.totals.over90)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatMinor(aging.totals.total)}
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
