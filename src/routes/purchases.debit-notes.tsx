import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent } from "react";
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
import { fetchDebitNotes, createDebitNoteFn } from "@/api/vouchers";
import { fetchBills } from "@/api/bills";
import { fetchItems, fetchTaxRates } from "@/api/entities";
import { formatMinor } from "@/lib/money";
import {
  LinesEditor,
  emptyLine,
  toApiLines,
  noteStatusStyle,
  noteStatusLabel,
  type LineDraft,
} from "@/components/vouchers/LinesEditor";

export const Route = createFileRoute("/purchases/debit-notes")({
  loader: async () => {
    const [notes, bills, items, taxRates] = await Promise.all([
      fetchDebitNotes(),
      fetchBills({ data: {} }),
      fetchItems(),
      fetchTaxRates(),
    ]);
    return { notes, bills, items, taxRates };
  },
  component: DebitNotes,
});

function DebitNotes() {
  const { notes, bills, items, taxRates } = Route.useLoaderData();
  const canPost = useCan("ledger:post");

  return (
    <>
      <PageHeader
        title="Debit Notes"
        subtitle="Purchase returns and allowances"
        actions={canPost ? <NewDebitNote bills={bills} items={items} taxRates={taxRates} /> : undefined}
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Note #</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {notes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No debit notes yet. Raise one against a bill when you return goods to a vendor.
                  </TableCell>
                </TableRow>
              ) : (
                notes.map((n) => (
                  <TableRow key={n.id} className="hover:bg-muted/40">
                    <TableCell className="text-brand font-medium">{n.number}</TableCell>
                    <TableCell>{n.name}</TableCell>
                    <TableCell className="text-muted-foreground">{n.date}</TableCell>
                    <TableCell className="text-muted-foreground">{n.reason ?? "—"}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatMinor(n.total)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={noteStatusStyle[n.status] ?? ""}>
                        {noteStatusLabel[n.status] ?? n.status}
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

type Bill = { id: string; billNumber: string; vendorName: string; contactId: string; balance: string };

function NewDebitNote({ bills, items, taxRates }: { bills: Bill[]; items: any[]; taxRates: any[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [billId, setBillId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);

  const bill = useMemo(() => bills.find((b) => b.id === billId), [bills, billId]);

  function reset() {
    setBillId("");
    setReason("");
    setLines([emptyLine()]);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!bill) return setError("Choose the bill being debited.");
    const usable = toApiLines(lines);
    if (usable.length === 0) return setError("Add at least one line.");
    setPending(true);
    try {
      const r = await createDebitNoteFn({
        data: {
          contactId: bill.contactId,
          relatedBillId: bill.id,
          debitNoteDate: date,
          reason: reason || undefined,
          postImmediately: true,
          lines: usable,
        },
      });
      setOpen(false);
      reset();
      toast.success(`Debit note ${r.number} posted`);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the debit note.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(n) => { setOpen(n); if (!n) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-gradient-brand text-white">
          <Plus className="mr-1.5 h-4 w-4" />
          New Debit Note
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New debit note</DialogTitle>
            <DialogDescription>
              Return goods to a vendor. Stock items are valued at their carrying (average) cost.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Against bill</Label>
                <Select value={billId} onValueChange={setBillId}>
                  <SelectTrigger><SelectValue placeholder="Choose bill" /></SelectTrigger>
                  <SelectContent>
                    {bills.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.billNumber} · {b.vendorName} · bal {formatMinor(b.balance)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="dn-date">Date</Label>
                <Input id="dn-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dn-reason">Reason</Label>
              <Input id="dn-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. defective units" />
            </div>
            <LinesEditor lines={lines} setLines={setLines} items={items} taxRates={taxRates} priceField="purchasePrice" />
          </div>
          {error ? <p role="alert" className="mb-2 text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>
              {pending ? <><Loader2 className="mr-2 size-4 animate-spin" />Posting…</> : "Post debit note"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
