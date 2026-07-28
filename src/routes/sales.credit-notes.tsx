import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent } from "react";
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
import { fetchCreditNotes, createCreditNoteFn } from "@/api/vouchers";
import { fetchInvoices } from "@/api/index";
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

export const Route = createFileRoute("/sales/credit-notes")({
  loader: async () => {
    const [notes, invoices, items, taxRates] = await Promise.all([
      fetchCreditNotes(),
      fetchInvoices({ data: {} }),
      fetchItems(),
      fetchTaxRates(),
    ]);
    return { notes, invoices, items, taxRates };
  },
  component: CreditNotes,
});

function CreditNotes() {
  const { notes, invoices, items, taxRates } = Route.useLoaderData();
  const canPost = useCan("ledger:post");

  return (
    <>
      <PageHeader
        title="Credit Notes"
        subtitle="Sales returns and allowances"
        actions={
          canPost ? (
            <NewCreditNote invoices={invoices} items={items} taxRates={taxRates} />
          ) : undefined
        }
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Note #</TableHead>
                <TableHead>Customer</TableHead>
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
                    No credit notes yet. Raise one against an invoice when a customer returns goods.
                  </TableCell>
                </TableRow>
              ) : (
                notes.map((n) => (
                  <TableRow key={n.id} className="hover:bg-muted/40">
                    <TableCell className="text-brand font-medium">{n.number}</TableCell>
                    <TableCell>{n.name}</TableCell>
                    <TableCell className="text-muted-foreground">{n.date}</TableCell>
                    <TableCell className="text-muted-foreground">{n.reason ?? "—"}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMinor(n.total)}
                    </TableCell>
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

type Invoice = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  contactId: string;
  balance: string;
};

function NewCreditNote({
  invoices,
  items,
  taxRates,
}: {
  invoices: Invoice[];
  items: any[];
  taxRates: any[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [invoiceId, setInvoiceId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [restock, setRestock] = useState(true);
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);

  const invoice = useMemo(() => invoices.find((i) => i.id === invoiceId), [invoices, invoiceId]);

  function reset() {
    setInvoiceId("");
    setReason("");
    setRestock(true);
    setLines([emptyLine()]);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!invoice) return setError("Choose the invoice being credited.");
    const usable = toApiLines(lines);
    if (usable.length === 0) return setError("Add at least one line.");
    setPending(true);
    try {
      const r = await createCreditNoteFn({
        data: {
          contactId: invoice.contactId,
          relatedInvoiceId: invoice.id,
          creditNoteDate: date,
          reason: reason || undefined,
          restock,
          postImmediately: true,
          lines: usable,
        },
      });
      setOpen(false);
      reset();
      toast.success(`Credit note ${r.number} posted`);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the credit note.");
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
          New Credit Note
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New credit note</DialogTitle>
            <DialogDescription>
              Credit a customer for returned goods or an allowance.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Against invoice</Label>
                <Select value={invoiceId} onValueChange={setInvoiceId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose invoice" />
                  </SelectTrigger>
                  <SelectContent>
                    {invoices.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.invoiceNumber} · {i.customerName} · bal {formatMinor(i.balance)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cn-date">Date</Label>
                <Input
                  id="cn-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cn-reason">Reason</Label>
              <Input
                id="cn-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. damaged in transit"
              />
            </div>
            <LinesEditor
              lines={lines}
              setLines={setLines}
              items={items}
              taxRates={taxRates}
              priceField="salePrice"
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={restock}
                onChange={(e) => setRestock(e.target.checked)}
                className="size-4"
              />
              Return goods to stock (reverses COGS at average cost)
            </label>
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
                "Post credit note"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
