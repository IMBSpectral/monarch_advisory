import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import { Landmark, Sparkles } from "lucide-react";
import { fetchBankSummary, fetchBankTransactions } from "@/api/entities";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/banking/")({
  loader: async () => {
    const [accounts, txns] = await Promise.all([
      fetchBankSummary(),
      fetchBankTransactions({ data: { limit: 50 } }),
    ]);
    return { accounts, txns };
  },
  component: Banking,
});

function statusBadge(status: string) {
  const s = status.toLowerCase();
  if (s === "matched" || s === "reconciled") {
    return (
      <Badge variant="outline" className="bg-success/10 text-success border-success/20">
        {status}
      </Badge>
    );
  }
  if (s === "suggested" || s === "pending") {
    return (
      <Badge variant="outline" className="bg-warning/10 text-warning-foreground border-warning/30">
        {status}
      </Badge>
    );
  }
  return <Badge variant="outline">{status}</Badge>;
}

function Banking() {
  const { accounts, txns } = Route.useLoaderData();

  function autoReconcile() {
    toast.info(
      "Automated reconciliation matching runs against the bank feed; connect a live feed to enable.",
    );
  }

  return (
    <>
      <PageHeader title="Banking" subtitle="Accounts, transactions, and AI reconciliation" />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {accounts.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground md:col-span-3">
              No bank accounts yet. Connect a feed to see balances here.
            </Card>
          ) : (
            accounts.map((a) => (
              <Card key={a.id} className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-brand">
                    <Landmark className="h-5 w-5 text-white" />
                  </div>
                  <Badge variant="secondary" className="text-[10px]">
                    {a.accountNumberMasked}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-3">{a.name}</p>
                <p className="text-[11px] text-muted-foreground">{a.institutionName}</p>
                <p className="text-2xl font-semibold tabular-nums mt-1">
                  {formatMinor(a.glBalance)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {a.feedBalance != null
                    ? `Bank feed: ${formatMinor(a.feedBalance)}`
                    : "No live feed"}
                </p>
                {a.unreconciledCount > 0 && (
                  <Badge
                    variant="outline"
                    className="mt-2 bg-warning/10 text-warning-foreground border-warning/30 text-[10px]"
                  >
                    {a.unreconciledCount} unreconciled
                  </Badge>
                )}
              </Card>
            ))
          )}
        </div>

        <Card>
          <div className="flex items-center justify-between p-4 border-b">
            <div>
              <h3 className="font-semibold">Recent Transactions</h3>
              <p className="text-xs text-muted-foreground">Latest bank feed activity</p>
            </div>
            <Button size="sm" className="bg-gradient-brand text-white" onClick={autoReconcile}>
              <Sparkles className="h-4 w-4 mr-1.5" />
              Auto-reconcile
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {txns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                    No transactions yet. Connect a bank feed to import activity.
                  </TableCell>
                </TableRow>
              ) : (
                txns.map((t) => {
                  const negative = t.amount.startsWith("-");
                  return (
                    <TableRow key={t.id} className="hover:bg-muted/40">
                      <TableCell className="text-muted-foreground">{t.transactionDate}</TableCell>
                      <TableCell className="font-medium">{t.description}</TableCell>
                      <TableCell
                        className={`text-right tabular-nums font-semibold ${negative ? "text-destructive" : "text-success"}`}
                      >
                        {negative ? "" : "+"}
                        {formatMinor(t.amount)}
                      </TableCell>
                      <TableCell>{statusBadge(t.status)}</TableCell>
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
