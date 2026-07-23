import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCan } from "@/components/SessionContext";
import { fetchPurchaseOrders, createPurchaseOrderFn, convertPurchaseOrderFn } from "@/api/vouchers";
import { fetchContacts, fetchItems, fetchTaxRates } from "@/api/entities";
import { formatMinor } from "@/lib/money";
import {
  LinesEditor,
  emptyLine,
  toApiLines,
  noteStatusStyle,
  noteStatusLabel,
  type LineDraft,
} from "@/components/vouchers/LinesEditor";

export const Route = createFileRoute("/purchases/orders")({
  loader: async () => {
    const [orders, vendors, items, taxRates] = await Promise.all([
      fetchPurchaseOrders(),
      fetchContacts({ data: { type: "vendor" } }),
      fetchItems(),
      fetchTaxRates(),
    ]);
    return { orders, vendors, items, taxRates };
  },
  component: PurchaseOrders,
});

function PurchaseOrders() {
  const { orders, vendors, items, taxRates } = Route.useLoaderData();
  const router = useRouter();
  const canCreate = useCan("document:create");
  const canPost = useCan("ledger:post");
  const [busy, setBusy] = useState<string | null>(null);

  async function convert(id: string) {
    setBusy(id);
    try {
      const r = await convertPurchaseOrderFn({ data: { purchaseOrderId: id, billDate: new Date().toISOString().slice(0, 10) } });
      toast.success(`Bill ${r.number} created & posted`);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not convert the order.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Purchase Orders"
        subtitle="Orders raised on vendors awaiting receipt"
        actions={canCreate ? <NewOrder vendors={vendors} items={items} taxRates={taxRates} /> : undefined}
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order #</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Expected</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    No purchase orders yet.
                  </TableCell>
                </TableRow>
              ) : (
                orders.map((o) => (
                  <TableRow key={o.id} className="hover:bg-muted/40">
                    <TableCell className="text-brand font-medium">{o.number}</TableCell>
                    <TableCell>{o.name}</TableCell>
                    <TableCell className="text-muted-foreground">{o.date}</TableCell>
                    <TableCell className="text-muted-foreground">{o.expected ?? "—"}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatMinor(o.total)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={noteStatusStyle[o.status] ?? ""}>
                        {noteStatusLabel[o.status] ?? o.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canPost && o.status !== "invoiced" && o.status !== "cancelled" ? (
                        <Button size="sm" variant="outline" disabled={busy === o.id} onClick={() => convert(o.id)}>
                          {busy === o.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Convert to bill"}
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

function NewOrder({ vendors, items, taxRates }: { vendors: any[]; items: any[]; taxRates: any[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contactId, setContactId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [expected, setExpected] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);

  function reset() { setContactId(""); setExpected(""); setLines([emptyLine()]); setError(null); }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!contactId) return setError("Choose a vendor.");
    const usable = toApiLines(lines);
    if (usable.length === 0) return setError("Add at least one line.");
    setPending(true);
    try {
      const r = await createPurchaseOrderFn({
        data: { contactId, orderDate: date, expectedDate: expected || undefined, lines: usable },
      });
      setOpen(false); reset();
      toast.success(`Purchase order ${r.number} created`);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the order.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(n) => { setOpen(n); if (!n) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-gradient-brand text-white">
          <Plus className="mr-1.5 h-4 w-4" />
          New Purchase Order
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New purchase order</DialogTitle>
            <DialogDescription>A commitment — it posts nothing until you convert it to a bill.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-2 col-span-1">
                <Label>Vendor</Label>
                <Select value={contactId} onValueChange={setContactId}>
                  <SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
                  <SelectContent>
                    {vendors.map((c: any) => <SelectItem key={c.id} value={c.id}>{c.displayName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="po-date">Order date</Label>
                <Input id="po-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="po-exp">Expected</Label>
                <Input id="po-exp" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
              </div>
            </div>
            <LinesEditor lines={lines} setLines={setLines} items={items} taxRates={taxRates} priceField="purchasePrice" />
          </div>
          {error ? <p role="alert" className="mb-2 text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>
              {pending ? <><Loader2 className="mr-2 size-4 animate-spin" />Saving…</> : "Create order"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
