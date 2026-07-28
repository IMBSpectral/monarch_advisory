import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  Plus,
  QrCode,
  Package as PackageIcon,
  MoreHorizontal,
  Pencil,
  Archive,
} from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EntityFormDialog } from "@/components/EntityFormDialog";
import { useCan } from "@/components/SessionContext";
import { fetchItems, createItemFn, updateItemFn } from "@/api/entities";
import { formatMinor } from "@/lib/money";

type Item = Awaited<ReturnType<typeof fetchItems>>[number];

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
                {canManage ? <TableHead className="w-10" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={canManage ? 6 : 5}
                    className="py-10 text-center text-muted-foreground"
                  >
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
                    {canManage ? (
                      <TableCell className="text-right">
                        <ItemRowActions item={i} />
                      </TableCell>
                    ) : null}
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
        // Surface the missing-name reason inline (via EntityFormDialog's error
        // area) instead of relying on the browser's silent native `required`
        // block, which gave no visible feedback.
        if (!name.trim()) throw new Error("Item name is required.");
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
        <Input id="item-name" value={name} onChange={(e) => setName(e.target.value)} />
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

/** Per-row Edit / Archive menu, shown only to users with `item:manage`. */
function ItemRowActions({ item }: { item: Item }) {
  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={`Actions for ${item.name}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>
            <Pencil className="mr-2 h-4 w-4" /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => setArchiveOpen(true)}
          >
            <Archive className="mr-2 h-4 w-4" /> Archive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <EditItemDialog item={item} open={editOpen} onOpenChange={setEditOpen} />
      <ArchiveItemDialog item={item} open={archiveOpen} onOpenChange={setArchiveOpen} />
    </>
  );
}

/** Edit dialog, pre-filled from the row and writing through `updateItemFn`. */
function EditItemDialog({
  item,
  open,
  onOpenChange,
}: {
  item: Item;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const rupees = (minor: string | null) => (minor ? String(Number(minor) / 100) : "");
  const [name, setName] = useState(item.name);
  const [sku, setSku] = useState(item.sku ?? "");
  const [uom, setUom] = useState(item.unitOfMeasure ?? "");
  const [salePrice, setSalePrice] = useState(rupees(item.salePrice));
  const [purchasePrice, setPurchasePrice] = useState(rupees(item.purchasePrice));
  const [hsn, setHsn] = useState(item.hsnSacCode ?? "");
  const [tracked, setTracked] = useState(item.isInventoryTracked);

  const toMinor = (r: string) => (r ? String(Math.round(Number(r) * 100)) : null);

  return (
    <EntityFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit item"
      description="Update this item's catalogue details."
      submitLabel="Save changes"
      successMessage="Item updated"
      onSubmit={async () => {
        if (!name.trim()) throw new Error("Item name is required.");
        await updateItemFn({
          data: {
            id: item.id,
            name,
            sku: sku || null,
            unitOfMeasure: uom || undefined,
            salePrice: toMinor(salePrice),
            purchasePrice: toMinor(purchasePrice),
            hsnSacCode: hsn || null,
            isInventoryTracked: tracked,
          },
        });
        await router.invalidate();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="edit-item-name">Name</Label>
        <Input id="edit-item-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="edit-item-sku">SKU</Label>
          <Input id="edit-item-sku" value={sku} onChange={(e) => setSku(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="edit-item-uom">Unit of measure</Label>
          <Input id="edit-item-uom" value={uom} onChange={(e) => setUom(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="edit-item-sale">Sale price (₹)</Label>
          <Input
            id="edit-item-sale"
            type="number"
            min={0}
            step="0.01"
            value={salePrice}
            onChange={(e) => setSalePrice(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="edit-item-purchase">Purchase price (₹)</Label>
          <Input
            id="edit-item-purchase"
            type="number"
            min={0}
            step="0.01"
            value={purchasePrice}
            onChange={(e) => setPurchasePrice(e.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="edit-item-hsn">HSN / SAC code</Label>
        <Input id="edit-item-hsn" value={hsn} onChange={(e) => setHsn(e.target.value)} />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="edit-item-tracked"
          checked={tracked}
          onCheckedChange={(v) => setTracked(v === true)}
        />
        <Label htmlFor="edit-item-tracked" className="font-normal">
          Track inventory for this item
        </Label>
      </div>
    </EntityFormDialog>
  );
}

/**
 * Archive confirmation. There is no hard delete for items on purpose — an item
 * can be referenced by posted invoices and stock history, so we deactivate it
 * (`isActive: false`) instead. `listItems` hides inactive items, so it drops off
 * the catalogue but its history stays intact and it can be restored later.
 */
function ArchiveItemDialog({
  item,
  open,
  onOpenChange,
}: {
  item: Item;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function archive() {
    setPending(true);
    try {
      await updateItemFn({ data: { id: item.id, isActive: false } });
      toast.success(`${item.name} archived`);
      onOpenChange(false);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not archive item.");
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive “{item.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            It will be hidden from the catalogue and can't be added to new documents. Existing
            invoices and stock history that reference it are unaffected, and you can restore it
            later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              archive();
            }}
            disabled={pending}
          >
            {pending ? "Archiving…" : "Archive"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
