import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchDayBook } from "@/api/index";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/reports/day-book")({
  loader: async () => fetchDayBook({ data: undefined }),
  component: DayBook,
});

const sourceLabel: Record<string, string> = {
  manual: "Journal",
  invoice: "Invoice",
  invoice_payment: "Receipt",
  bill: "Bill",
  bill_payment: "Payment",
  credit_note: "Credit Note",
  vendor_credit: "Debit Note",
  contra: "Contra",
  opening_balance: "Opening",
  inventory_adjustment: "Inventory",
  depreciation: "Depreciation",
};

function DayBook() {
  const db = Route.useLoaderData();
  return (
    <>
      <PageHeader title="Day Book" subtitle="Every posted voucher, most recent first" />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entry #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Memo</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {db.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No entries in this period.
                  </TableCell>
                </TableRow>
              ) : (
                db.rows.map((r, i) => (
                  <TableRow key={i} className="hover:bg-muted/40">
                    <TableCell className="text-brand font-medium">{r.entryNumber}</TableCell>
                    <TableCell className="text-muted-foreground">{r.entryDate}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{sourceLabel[r.source] ?? r.source}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.reference ?? "—"}</TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {r.memo ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMinor(r.amount)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
