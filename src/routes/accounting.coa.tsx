import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { chartOfAccounts, inr } from "@/data/mock";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/accounting/coa")({ component: CoA });

const typeColor: Record<string, string> = {
  Assets: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  Liabilities: "bg-orange-500/10 text-orange-600 border-orange-500/20",
  Equity: "bg-violet-500/10 text-violet-600 border-violet-500/20",
  Income: "bg-success/10 text-success border-success/20",
  Expenses: "bg-destructive/10 text-destructive border-destructive/20",
};

function CoA() {
  return (
    <>
      <PageHeader title="Chart of Accounts" subtitle="Hierarchical ledger structure" />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader><TableRow>
              <TableHead className="w-24">Code</TableHead><TableHead>Account</TableHead><TableHead>Type</TableHead><TableHead className="text-right">Balance</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {chartOfAccounts.map((a) => (
                <TableRow key={a.code} className={a.group ? "bg-muted/30 font-semibold" : ""}>
                  <TableCell className="font-mono text-xs">{a.code}</TableCell>
                  <TableCell style={{ paddingLeft: `${(a.indent ?? 0) * 24 + 16}px` }}>{a.name}</TableCell>
                  <TableCell><Badge variant="outline" className={typeColor[a.type]}>{a.type}</Badge></TableCell>
                  <TableCell className="text-right tabular-nums">{inr(a.balance)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
