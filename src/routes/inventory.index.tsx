import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Plus, QrCode, Package as PackageIcon } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { EntityFormDialog } from "@/components/EntityFormDialog";
import { useCan } from "@/components/SessionContext";
import { fetchItems, createItemFn } from "@/api/entities";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/inventory/")({
  loader: async () => fetchItems({ data: {} }),
  component: Inventory,
});

function Inventory() {
  const items = Route.useLoaderData();
  const canManage = useCan("item:manage");

  const trackedCount = items.filter((i) => i.isInventoryTracked).length;
  const activeCount = items.filter((i) => i.isActive).length;

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="Item master, stock levels, and valuation"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                toast.info("Barcode scanning connects to a hardware scanner in production.")
              }
            >
              <QrCode className="h-4 w-4 mr-1.5" />
              Scan
            </Button>
            {canManage ? <NewItemButton /> : null}
          </>
        }
      />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { l: "Total SKUs", v: items.length.toString() },
            { l: "Tracked Items", v: trackedCount.toString() },
            { l: "Untracked / Services", v: (items.length - trackedCount).toString() },
            { l: "Active Items", v: activeCount.toString() },
          ].map((s) => (
            <Card key={s.l} className="p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">{s.l}</p>
              <p className="text-xl font-semibold tabular-nums mt-1">{s.v}</p>
            </Card>
          ))}
        </div>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>UoM</TableHead>
                <TableHead className="text-right">Sale price</TableHead>
                <TableHead className="text-right">Stock</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No items yet. Add your first item to build out the catalogue.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((i) => (
                  <TableRow key={i.id} className="hover:bg-muted/40">
                    <TableCell className="font-mono text-xs">{i.sku ?? "—"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                          <PackageIcon className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <span className="font-medium">{i.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {i.unitOfMeasure ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {i.salePrice ? formatMinor(i.salePrice) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={i.isInventoryTracked ? "secondary" : "outline"}>
                        {i.isInventoryTracked ? "Tracked" : "Not tracked"}
                      </Badge>
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

/**
 * "New Item" — opens a dialog, writes through `createItemFn`, then invalidates
 * the router so the loader re-runs and the new row appears. Rupee price inputs
 * are converted to string minor units before hitting the server function.
 */
function NewItemButton() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [uom, setUom] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [hsn, setHsn] = useState("");
  const [tracked, setTracked] = useState(true);

  const toMinor = (rupees: string) => (rupees ? String(Math.round(Number(rupees) * 100)) : null);

  return (
    <EntityFormDialog
      trigger={
        <Button size="sm" className="bg-gradient-brand text-white">
          <Plus className="h-4 w-4 mr-1.5" />
          New Item
        </Button>
      }
      title="New item"
      description="Add a product or service to your catalogue."
      submitLabel="Create item"
      successMessage="Item created"
      onSubmit={async () => {
        await createItemFn({
          data: {
            name,
            sku: sku || null,
            unitOfMeasure: uom || undefined,
            salePrice: toMinor(salePrice),
            purchasePrice: toMinor(purchasePrice),
            hsnSacCode: hsn || null,
            isInventoryTracked: tracked,
          },
        });
        setName("");
        setSku("");
        setUom("");
        setSalePrice("");
        setPurchasePrice("");
        setHsn("");
        setTracked(true);
        await router.invalidate();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="item-name">Name</Label>
        <Input id="item-name" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="item-sku">SKU</Label>
          <Input id="item-sku" value={sku} onChange={(e) => setSku(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="item-uom">Unit of measure</Label>
          <Input id="item-uom" value={uom} onChange={(e) => setUom(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="item-sale">Sale price (₹)</Label>
          <Input
            id="item-sale"
            type="number"
            min={0}
            step="0.01"
            value={salePrice}
            onChange={(e) => setSalePrice(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="item-purchase">Purchase price (₹)</Label>
          <Input
            id="item-purchase"
            type="number"
            min={0}
            step="0.01"
            value={purchasePrice}
            onChange={(e) => setPurchasePrice(e.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="item-hsn">HSN / SAC code</Label>
        <Input id="item-hsn" value={hsn} onChange={(e) => setHsn(e.target.value)} />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="item-tracked"
          checked={tracked}
          onCheckedChange={(v) => setTracked(v === true)}
        />
        <Label htmlFor="item-tracked" className="font-normal">
          Track inventory for this item
        </Label>
      </div>
    </EntityFormDialog>
  );
}
