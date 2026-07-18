import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { customers, inr } from "@/data/mock";

export const Route = createFileRoute("/sales/customers")({ component: Customers });

function Customers() {
  return (
    <>
      <PageHeader title="Customers" subtitle="360° view of every buyer relationship"
        actions={<Button size="sm" className="bg-gradient-brand text-white"><Plus className="h-4 w-4 mr-1.5" />New Customer</Button>} />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>City</TableHead>
                <TableHead>GSTIN</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((c) => (
                <TableRow key={c.name} className="hover:bg-muted/40">
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-brand text-white text-xs font-semibold">{c.name.slice(0,1)}</div>
                      <span className="font-medium">{c.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.email}</TableCell>
                  <TableCell className="text-muted-foreground">{c.phone}</TableCell>
                  <TableCell>{c.city}</TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">{c.gstin}</TableCell>
                  <TableCell className={`text-right tabular-nums font-medium ${c.balance > 0 ? "text-brand" : "text-muted-foreground"}`}>{inr(c.balance)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
