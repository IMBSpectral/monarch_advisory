import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Landmark, Sparkles } from "lucide-react";
import { bankAccounts, bankTxns, inr } from "@/data/mock";

export const Route = createFileRoute("/banking/")({ component: Banking });

function Banking() {
  return (
    <>
      <PageHeader title="Banking" subtitle="Accounts, transactions, and AI reconciliation" />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {bankAccounts.map((a) => (
            <Card key={a.name} className="p-5">
              <div className="flex items-start justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-brand"><Landmark className="h-5 w-5 text-white" /></div>
                <Badge variant="secondary" className="text-[10px]">{a.last}</Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-3">{a.name}</p>
              <p className="text-2xl font-semibold tabular-nums mt-1">{inr(a.balance)}</p>
              <p className="text-xs text-muted-foreground mt-1">{a.txns} transactions this month</p>
            </Card>
          ))}
        </div>

        <Card>
          <div className="flex items-center justify-between p-4 border-b">
            <div>
              <h3 className="font-semibold">Recent Transactions</h3>
              <p className="text-xs text-muted-foreground">HDFC Current 8821</p>
            </div>
            <Button size="sm" className="bg-gradient-brand text-white"><Sparkles className="h-4 w-4 mr-1.5" />Auto-reconcile</Button>
          </div>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead><TableHead>Description</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Match</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {bankTxns.map((t, i) => (
                <TableRow key={i} className="hover:bg-muted/40">
                  <TableCell className="text-muted-foreground">{t.date}</TableCell>
                  <TableCell className="font-medium">{t.desc}</TableCell>
                  <TableCell className={`text-right tabular-nums font-semibold ${t.type === "credit" ? "text-success" : "text-destructive"}`}>
                    {t.type === "credit" ? "+" : ""}{inr(t.amount)}
                  </TableCell>
                  <TableCell>
                    {t.matched
                      ? <Badge variant="outline" className="bg-success/10 text-success border-success/20">Matched</Badge>
                      : <Badge variant="outline" className="bg-warning/10 text-warning-foreground border-warning/30">Suggested</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
