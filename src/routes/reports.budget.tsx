import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchBudgetVsActual } from "@/api/dimensions";
import { formatMinor, formatMinorSigned } from "@/lib/money";

export const Route = createFileRoute("/reports/budget")({
  loader: async () => fetchBudgetVsActual(),
  component: Budget,
});

function usage(actual: string, budget: string): number {
  const b = Number(budget);
  return b === 0 ? 0 : Math.min(100, Math.round((Number(actual) / b) * 100));
}

function Budget() {
  const rows = Route.useLoaderData();
  return (
    <>
      <PageHeader title="Budget vs Actual" subtitle="How the year is tracking against plan" />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Budget</TableHead>
                <TableHead className="text-right">Actual</TableHead>
                <TableHead className="text-right">Variance</TableHead>
                <TableHead className="w-40">Used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No budgets set for this year.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => {
                  const pct = usage(r.actual, r.budget);
                  const over = BigInt(r.variance) < 0n;
                  return (
                    <TableRow key={r.code} className="hover:bg-muted/40">
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMinor(r.budget)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMinor(r.actual)}</TableCell>
                      <TableCell className={`text-right font-medium tabular-nums ${over ? "text-destructive" : "text-success"}`}>
                        {formatMinorSigned(r.variance)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full rounded-full ${over ? "bg-destructive" : "bg-brand"}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
