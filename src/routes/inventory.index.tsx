import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus, QrCode, Package as PackageIcon } from "lucide-react";
import { items, inr } from "@/data/mock";

export const Route = createFileRoute("/inventory/")({ component: Inventory });

function Inventory() {
  const totalValue = items.reduce((s, i) => s + i.stock * i.cost, 0);
  return (
    <>
      <PageHeader title="Inventory" subtitle="Item master, stock levels, and valuation"
        actions={<>
          <Button variant="outline" size="sm"><QrCode className="h-4 w-4 mr-1.5" />Scan</Button>
          <Button size="sm" className="bg-gradient-brand text-white"><Plus className="h-4 w-4 mr-1.5" />New Item</Button>
        </>} />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { l: "Total SKUs", v: items.length.toString() },
            { l: "Total Stock Value", v: inr(totalValue) },
            { l: "Low Stock Alerts", v: "3", accent: "text-warning" },
            { l: "Warehouses", v: "4" },
          ].map((s) => (
            <Card key={s.l} className="p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">{s.l}</p>
              <p className={`text-xl font-semibold tabular-nums mt-1 ${s.accent ?? ""}`}>{s.v}</p>
            </Card>
          ))}
        </div>
        <Card>
          <Table>
            <TableHeader><TableRow>
              <TableHead>SKU</TableHead><TableHead>Item</TableHead><TableHead>Category</TableHead><TableHead>Warehouse</TableHead><TableHead className="text-right">Stock</TableHead><TableHead className="text-right">Cost</TableHead><TableHead className="text-right">Price</TableHead><TableHead className="text-right">Value</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.sku} className="hover:bg-muted/40">
                  <TableCell className="font-mono text-xs">{i.sku}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted"><PackageIcon className="h-4 w-4 text-muted-foreground" /></div>
                      <span className="font-medium">{i.name}</span>
                    </div>
                  </TableCell>
                  <TableCell><Badge variant="secondary">{i.category}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{i.warehouse}</TableCell>
                  <TableCell className={`text-right tabular-nums ${i.stock < 50 ? "text-warning font-semibold" : ""}`}>{i.stock} {i.uom}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{inr(i.cost)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{inr(i.price)}</TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">{inr(i.stock * i.cost)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
