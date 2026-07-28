import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCan } from "@/components/SessionContext";
import { fetchGoodsReceipts, createGoodsReceiptFn, convertGrnToBillFn } from "@/api/vouchers";
import { fetchContacts, fetchItems } from "@/api/entities";
import { formatMinor } from "@/lib/money";
import {
  LinesEditor,
  emptyLine,
  noteStatusStyle,
  noteStatusLabel,
  NO_ITEM,
  type LineDraft,
} from "@/components/vouchers/LinesEditor";

export const Route = createFileRoute("/purchases/grn")({
  loader: async () => {
    const [receipts, vendors, items] = await Promise.all([
      fetchGoodsReceipts(),
      fetchContacts({ data: { type: "vendor" } }),
      fetchItems(),
    ]);
    return { receipts, vendors, items };
  },
  component: GRN,
});

function GRN() {
  const { receipts, vendors, items } = Route.useLoaderData();
  const router = useRouter();
  const canPost = useCan("ledger:post");
  const [busy, setBusy] = useState<string | null>(null);

  async function bill(id: string) {
    setBusy(id);
    try {
      const r = await convertGrnToBillFn({
        data: { goodsReceiptId: id, billDate: new Date().toISOString().slice(0, 10) },
      });
      toast.success(`Bill ${r.number} created (GRNI cleared)`);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not bill the receipt.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Goods Receipts"
        subtitle="Stock received before the vendor bill (GRN → GRNI clearing)"
        actions={canPost ? <NewGrn vendors={vendors} items={items} /> : undefined}
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>GRN #</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receipts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No goods receipts yet.
                  </TableCell>
                </TableRow>
              ) : (
                receipts.map((g) => (
                  <TableRow key={g.id} className="hover:bg-muted/40">
                    <TableCell className="text-brand font-medium">{g.number}</TableCell>
                    <TableCell>{g.name}</TableCell>
                    <TableCell className="text-muted-foreground">{g.date}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMinor(g.total)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={g.billId ? noteStatusStyle.invoiced : noteStatusStyle[g.status]}
                      >
                        {g.billId ? "Billed" : (noteStatusLabel[g.status] ?? g.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canPost && g.status === "posted" && !g.billId ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === g.id}
                          onClick={() => bill(g.id)}
                        >
                          {busy === g.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            "Raise bill"
                          )}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
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

function NewGrn({ vendors, items }: { vendors: any[]; items: any[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contactId, setContactId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);

  function reset() {
    setContactId("");
    setLines([emptyLine()]);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!contactId) return setError("Choose a vendor.");
    const usable = lines
      .filter((l) => l.itemId !== NO_ITEM && Number(l.unitPriceRupees) > 0)
      .map((l) => ({
        itemId: l.itemId,
        description: l.description.trim() || "Received item",
        quantity: l.quantity || "1",
        unitCostMinor: String(Math.round(Number(l.unitPriceRupees) * 100)),
      }));
    if (usable.length === 0) return setError("Add at least one stock item with a cost.");
    setPending(true);
    try {
      const r = await createGoodsReceiptFn({
        data: { contactId, receiptDate: date, lines: usable },
      });
      setOpen(false);
      reset();
      toast.success(`Goods receipt ${r.number} posted (stock in)`);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the receipt.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(n) => {
        setOpen(n);
        if (!n) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="bg-gradient-brand text-white">
          <Plus className="mr-1.5 h-4 w-4" />
          New Goods Receipt
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New goods receipt</DialogTitle>
            <DialogDescription>
              Receive stock now; the bill can follow. Posts Dr Inventory / Cr GRNI.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Vendor</Label>
                <Select value={contactId} onValueChange={setContactId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose" />
                  </SelectTrigger>
                  <SelectContent>
                    {vendors.map((c: any) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="grn-date">Receipt date</Label>
                <Input
                  id="grn-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </div>
            </div>
            <LinesEditor
              lines={lines}
              setLines={setLines}
              items={items}
              taxRates={[]}
              priceField="purchasePrice"
              showTax={false}
              requireItem
            />
          </div>
          {error ? (
            <p role="alert" className="mb-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Posting…
                </>
              ) : (
                "Receive stock"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
