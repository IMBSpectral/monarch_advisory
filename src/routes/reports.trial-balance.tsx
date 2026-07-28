import { createFileRoute } from "@tanstack/react-router";
import { Fragment } from "react";
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
import { fetchTrialBalance } from "@/api/index";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/reports/trial-balance")({
  loader: async () => fetchTrialBalance({ data: undefined }),
  component: TrialBalance,
});

const TYPE_ORDER = ["asset", "liability", "equity", "income", "expense"];
const TYPE_LABEL: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

function TrialBalance() {
  const tb = Route.useLoaderData();
  const groups = TYPE_ORDER.map((t) => ({
    type: t,
    rows: tb.rows.filter((r) => r.type === t),
  })).filter((g) => g.rows.length > 0);

  return (
    <>
      <PageHeader
        title="Trial Balance"
        subtitle={`As of ${tb.asOf}`}
        actions={
          <Badge
            variant="outline"
            className={
              tb.isBalanced
                ? "border-success/20 bg-success/10 text-success"
                : "border-destructive/20 bg-destructive/10 text-destructive"
            }
          >
            {tb.isBalanced ? "Balanced" : "Out of balance"}
          </Badge>
        }
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => (
                <Fragment key={g.type}>
                  <TableRow className="bg-muted/40">
                    <TableCell
                      colSpan={4}
                      className="text-xs font-semibold uppercase tracking-widest text-brand"
                    >
                      {TYPE_LABEL[g.type]}
                    </TableCell>
                  </TableRow>
                  {g.rows.map((r) => (
                    <TableRow key={r.accountId} className="hover:bg-muted/40">
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.code}
                      </TableCell>
                      <TableCell>{r.name}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {Number(r.debitMinor) ? formatMinor(r.debitMinor) : ""}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {Number(r.creditMinor) ? formatMinor(r.creditMinor) : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
            <tfoot>
              <TableRow className="border-t-2 font-semibold">
                <TableCell colSpan={2}>Total</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMinor(tb.totalDebit)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMinor(tb.totalCredit)}
                </TableCell>
              </TableRow>
            </tfoot>
          </Table>
        </Card>
      </div>
    </>
  );
}
