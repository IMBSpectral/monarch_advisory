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
import { Badge } from "@/components/ui/badge";
import { fetchChartOfAccounts } from "@/api";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/accounting/coa")({
  loader: async () => fetchChartOfAccounts(),
  component: CoA,
});

const typeColor: Record<string, string> = {
  asset: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  liability: "bg-orange-500/10 text-orange-600 border-orange-500/20",
  equity: "bg-violet-500/10 text-violet-600 border-violet-500/20",
  income: "bg-success/10 text-success border-success/20",
  expense: "bg-destructive/10 text-destructive border-destructive/20",
};

const typeLabel: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

function CoA() {
  const accounts = Route.useLoaderData();

  return (
    <>
      <PageHeader title="Chart of Accounts" subtitle="Hierarchical ledger structure" />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Code</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Subtype</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No accounts configured yet.
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((a) => (
                  <TableRow
                    key={a.id}
                    className={a.isGroup ? "bg-muted/30 font-semibold" : "hover:bg-muted/40"}
                  >
                    <TableCell className="font-mono text-xs">{a.code}</TableCell>
                    <TableCell
                      className={a.isGroup ? "text-muted-foreground" : ""}
                      style={{ paddingLeft: a.parentId ? "40px" : undefined }}
                    >
                      {a.name}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={typeColor[a.type]}>
                        {typeLabel[a.type] ?? a.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs capitalize">
                      {a.subtype ? a.subtype.replace(/_/g, " ") : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMinor(a.balance)}
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
