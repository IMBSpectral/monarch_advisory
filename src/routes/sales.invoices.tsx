import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Filter, Download, Search, MoreHorizontal } from "lucide-react";
import { invoices, inr } from "@/data/mock";

export const Route = createFileRoute("/sales/invoices")({ component: Invoices });

const statusStyle: Record<string, string> = {
  Paid: "bg-success/10 text-success border-success/20",
  Sent: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  Overdue: "bg-destructive/10 text-destructive border-destructive/20",
  Partial: "bg-warning/10 text-warning-foreground border-warning/30",
};

function Invoices() {
  const total = invoices.reduce((s, i) => s + i.amount, 0);
  const outstanding = invoices.reduce((s, i) => s + i.balance, 0);
  const overdue = invoices.filter(i => i.status === "Overdue").reduce((s, i) => s + i.balance, 0);
  const paid = total - outstanding;

  return (
    <>
      <PageHeader
        title="Invoices"
        subtitle="Manage customer invoices, payments, and reminders"
        actions={
          <>
            <Button variant="outline" size="sm"><Download className="h-4 w-4 mr-1.5" />Export</Button>
            <Button size="sm" className="bg-gradient-brand text-white"><Plus className="h-4 w-4 mr-1.5" />New Invoice</Button>
          </>
        }
      />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { l: "Total Invoiced", v: inr(total), c: "text-foreground" },
            { l: "Paid", v: inr(paid), c: "text-success" },
            { l: "Outstanding", v: inr(outstanding), c: "text-blue-600" },
            { l: "Overdue", v: inr(overdue), c: "text-destructive" },
          ].map((s) => (
            <Card key={s.l} className="p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">{s.l}</p>
              <p className={`text-xl font-semibold tabular-nums mt-1 ${s.c}`}>{s.v}</p>
            </Card>
          ))}
        </div>

        <Card>
          <div className="flex items-center gap-2 p-3 border-b">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search invoices…" className="pl-8 h-9" />
            </div>
            <Button variant="outline" size="sm"><Filter className="h-4 w-4 mr-1.5" />Status</Button>
            <Button variant="outline" size="sm">Customer</Button>
            <Button variant="outline" size="sm">Date range</Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice #</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Due Date</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((i) => (
                <TableRow key={i.id} className="hover:bg-muted/40">
                  <TableCell>
                    <Link to="/sales/invoices/$id" params={{ id: i.id }} className="font-medium text-brand hover:underline">{i.id}</Link>
                  </TableCell>
                  <TableCell>{i.customer}</TableCell>
                  <TableCell className="text-muted-foreground">{i.date}</TableCell>
                  <TableCell className="text-muted-foreground">{i.due}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{inr(i.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{inr(i.balance)}</TableCell>
                  <TableCell><Badge variant="outline" className={statusStyle[i.status]}>{i.status}</Badge></TableCell>
                  <TableCell><Button variant="ghost" size="icon" className="h-7 w-7"><MoreHorizontal className="h-4 w-4" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
