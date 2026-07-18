import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { vendors, inr } from "@/data/mock";

export const Route = createFileRoute("/purchases/vendors")({ component: Vendors });

function Vendors() {
  return (
    <>
      <PageHeader title="Vendors" subtitle="Suppliers, contracts, and outstanding payables"
        actions={<Button size="sm" className="bg-gradient-brand text-white"><Plus className="h-4 w-4 mr-1.5" />New Vendor</Button>} />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Vendor</TableHead><TableHead>Email</TableHead><TableHead>Phone</TableHead><TableHead>City</TableHead><TableHead>GSTIN</TableHead><TableHead className="text-right">Balance</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {vendors.map((v) => (
                <TableRow key={v.name} className="hover:bg-muted/40">
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-gold text-primary text-xs font-semibold">{v.name.slice(0,1)}</div>
                      <span className="font-medium">{v.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{v.email}</TableCell>
                  <TableCell className="text-muted-foreground">{v.phone}</TableCell>
                  <TableCell>{v.city}</TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">{v.gstin}</TableCell>
                  <TableCell className={`text-right tabular-nums font-medium ${v.balance > 0 ? "text-orange-600" : "text-muted-foreground"}`}>{inr(v.balance)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
