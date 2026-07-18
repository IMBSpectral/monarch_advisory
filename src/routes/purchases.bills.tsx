import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { bills, inr } from "@/data/mock";

export const Route = createFileRoute("/purchases/bills")({ component: Bills });

const s: Record<string, string> = {
  Paid: "bg-success/10 text-success border-success/20",
  Open: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  Overdue: "bg-destructive/10 text-destructive border-destructive/20",
};

function Bills() {
  return (
    <>
      <PageHeader title="Bills" subtitle="Vendor bills, payments, and approvals"
        actions={<Button size="sm" className="bg-gradient-brand text-white"><Plus className="h-4 w-4 mr-1.5" />New Bill</Button>} />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Bill #</TableHead><TableHead>Vendor</TableHead><TableHead>Date</TableHead><TableHead>Due</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {bills.map((b) => (
                <TableRow key={b.id} className="hover:bg-muted/40">
                  <TableCell className="font-medium text-brand">{b.id}</TableCell>
                  <TableCell>{b.vendor}</TableCell>
                  <TableCell className="text-muted-foreground">{b.date}</TableCell>
                  <TableCell className="text-muted-foreground">{b.due}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{inr(b.amount)}</TableCell>
                  <TableCell><Badge variant="outline" className={s[b.status]}>{b.status}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
