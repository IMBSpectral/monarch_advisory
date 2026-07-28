import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
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
import {
  fetchRecurringTemplates,
  createRecurringTemplateFn,
  generateDueInvoicesFn,
} from "@/api/recurring";
import { fetchContacts, fetchItems, fetchTaxRates } from "@/api/entities";
import {
  LinesEditor,
  emptyLine,
  toApiLines,
  noteStatusStyle,
  noteStatusLabel,
  type LineDraft,
} from "@/components/vouchers/LinesEditor";

export const Route = createFileRoute("/sales/recurring")({
  loader: async () => {
    const [templates, customers, items, taxRates] = await Promise.all([
      fetchRecurringTemplates(),
      fetchContacts({ data: { type: "customer" } }),
      fetchItems(),
      fetchTaxRates(),
    ]);
    return { templates, customers, items, taxRates };
  },
  component: Recurring,
});

const freqLabel: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

function Recurring() {
  const { templates, customers, items, taxRates } = Route.useLoaderData();
  const router = useRouter();
  const canCreate = useCan("document:create");
  const canPost = useCan("ledger:post");
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      const r = await generateDueInvoicesFn();
      toast.success(
        r.generated
          ? `Generated ${r.generated} invoice(s): ${r.invoiceNumbers.join(", ")}`
          : "Nothing due right now",
      );
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not generate invoices.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Recurring Invoices"
        subtitle="Templates that issue invoices automatically on a schedule"
        actions={
          <div className="flex gap-2">
            {canPost ? (
              <Button size="sm" variant="outline" onClick={generate} disabled={busy}>
                {busy ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-4 w-4" />
                )}
                Generate due
              </Button>
            ) : null}
            {canCreate ? (
              <NewTemplate customers={customers} items={items} taxRates={taxRates} />
            ) : null}
          </div>
        }
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Template</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Frequency</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Ends</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No recurring templates yet.
                  </TableCell>
                </TableRow>
              ) : (
                templates.map((t) => (
                  <TableRow key={t.id} className="hover:bg-muted/40">
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell>{t.customer}</TableCell>
                    <TableCell>{freqLabel[t.frequency] ?? t.frequency}</TableCell>
                    <TableCell className="text-muted-foreground">{t.nextRunDate}</TableCell>
                    <TableCell className="text-muted-foreground">{t.endDate ?? "—"}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          noteStatusStyle[t.status] ??
                          (t.status === "active"
                            ? "border-success/20 bg-success/10 text-success"
                            : "")
                        }
                      >
                        {t.status === "active"
                          ? "Active"
                          : t.status === "ended"
                            ? "Ended"
                            : (noteStatusLabel[t.status] ?? t.status)}
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

function NewTemplate({
  customers,
  items,
  taxRates,
}: {
  customers: any[];
  items: any[];
  taxRates: any[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({
    contactId: "",
    name: "",
    frequency: "monthly",
    startDate: new Date().toISOString().slice(0, 10),
    endDate: "",
  });
  const set = (patch: Partial<typeof f>) => setF((p) => ({ ...p, ...patch }));
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!f.contactId || !f.name.trim()) return setError("Customer and template name are required.");
    const usable = toApiLines(lines);
    if (usable.length === 0) return setError("Add at least one line.");
    setPending(true);
    try {
      await createRecurringTemplateFn({
        data: {
          contactId: f.contactId,
          name: f.name.trim(),
          frequency: f.frequency as any,
          startDate: f.startDate,
          endDate: f.endDate || undefined,
          lines: usable.map((l) => ({
            itemId: l.itemId,
            description: l.description,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            taxRateId: l.taxRateId,
            revenueAccountId: null,
          })),
        },
      });
      setOpen(false);
      toast.success(`Recurring template "${f.name}" created`);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the template.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-gradient-brand text-white">
          <Plus className="mr-1.5 h-4 w-4" />
          New Template
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New recurring invoice</DialogTitle>
            <DialogDescription>
              Invoices are issued automatically each period when you run "Generate due".
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Customer</Label>
                <Select value={f.contactId} onValueChange={(v) => set({ contactId: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose" />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((c: any) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Template name</Label>
                <Input
                  value={f.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="Monthly retainer"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-2">
                <Label>Frequency</Label>
                <Select value={f.frequency} onValueChange={(v) => set({ frequency: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Starts</Label>
                <Input
                  type="date"
                  value={f.startDate}
                  onChange={(e) => set({ startDate: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label>Ends (optional)</Label>
                <Input
                  type="date"
                  value={f.endDate}
                  onChange={(e) => set({ endDate: e.target.value })}
                />
              </div>
            </div>
            <LinesEditor
              lines={lines}
              setLines={setLines}
              items={items}
              taxRates={taxRates}
              priceField="salePrice"
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
                  Saving…
                </>
              ) : (
                "Create template"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
