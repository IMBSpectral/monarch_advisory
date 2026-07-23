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
import { fetchDeliveries, createDeliveryFn, convertDeliveryFn } from "@/api/vouchers";
import { fetchContacts, fetchItems } from "@/api/entities";
import {
  LinesEditor,
  emptyLine,
  noteStatusStyle,
  noteStatusLabel,
  NO_ITEM,
  type LineDraft,
} from "@/components/vouchers/LinesEditor";

export const Route = createFileRoute("/sales/deliveries")({
  loader: async () => {
    const [deliveries, customers, items] = await Promise.all([
      fetchDeliveries(),
      fetchContacts({ data: { type: "customer" } }),
      fetchItems(),
    ]);
    return { deliveries, customers, items };
  },
  component: Deliveries,
});

function Deliveries() {
  const { deliveries, customers, items } = Route.useLoaderData();
  const router = useRouter();
  const canPost = useCan("ledger:post");
  const [busy, setBusy] = useState<string | null>(null);

  async function invoice(id: string) {
    setBusy(id);
    try {
      const r = await convertDeliveryFn({ data: { deliveryNoteId: id, invoiceDate: new Date().toISOString().slice(0, 10) } });
      toast.success(`Invoice ${r.number} created (revenue only)`);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not invoice the delivery.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Delivery Notes"
        subtitle="Goods dispatched before the invoice (COGS booked on delivery)"
        actions={canPost ? <NewDelivery customers={customers} items={items} /> : undefined}
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Delivery #</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No delivery notes yet.
                  </TableCell>
                </TableRow>
              ) : (
                deliveries.map((d) => (
                  <TableRow key={d.id} className="hover:bg-muted/40">
                    <TableCell className="text-brand font-medium">{d.number}</TableCell>
                    <TableCell>{d.name}</TableCell>
                    <TableCell className="text-muted-foreground">{d.date}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={d.invoiceId ? noteStatusStyle.invoiced : noteStatusStyle[d.status]}>
                        {d.invoiceId ? "Invoiced" : noteStatusLabel[d.status] ?? d.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canPost && d.status === "posted" && !d.invoiceId ? (
                        <Button size="sm" variant="outline" disabled={busy === d.id} onClick={() => invoice(d.id)}>
                          {busy === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Raise invoice"}
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

function NewDelivery({ customers, items }: { customers: any[]; items: any[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contactId, setContactId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);

  function reset() { setContactId(""); setLines([emptyLine()]); setError(null); }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!contactId) return setError("Choose a customer.");
    const usable = lines
      .filter((l) => l.itemId !== NO_ITEM && Number(l.unitPriceRupees) > 0)
      .map((l) => ({
        itemId: l.itemId,
        description: l.description.trim() || "Delivered item",
        quantity: l.quantity || "1",
        unitPriceMinor: String(Math.round(Number(l.unitPriceRupees) * 100)),
      }));
    if (usable.length === 0) return setError("Add at least one stock item.");
    setPending(true);
    try {
      const r = await createDeliveryFn({ data: { contactId, deliveryDate: date, lines: usable } });
      setOpen(false); reset();
      toast.success(`Delivery ${r.number} posted (stock out)`);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the delivery.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(n) => { setOpen(n); if (!n) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-gradient-brand text-white">
          <Plus className="mr-1.5 h-4 w-4" />
          New Delivery Note
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New delivery note</DialogTitle>
            <DialogDescription>Dispatch stock now; invoice later. Posts Dr COGS / Cr Inventory.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Customer</Label>
                <Select value={contactId} onValueChange={setContactId}>
                  <SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c: any) => <SelectItem key={c.id} value={c.id}>{c.displayName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="dc-date">Delivery date</Label>
                <Input id="dc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
            </div>
            <LinesEditor lines={lines} setLines={setLines} items={items} taxRates={[]} priceField="salePrice" showTax={false} requireItem />
          </div>
          {error ? <p role="alert" className="mb-2 text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>
              {pending ? <><Loader2 className="mr-2 size-4 animate-spin" />Posting…</> : "Dispatch stock"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
