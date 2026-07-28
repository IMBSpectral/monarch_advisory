import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createInvoiceFn } from "@/api";
import { formatMinor } from "@/lib/money";
import { useIdempotencyKey } from "@/lib/idempotency";

/**
 * Create-invoice dialog.
 *
 * The money discipline of the whole app shows up here: the user types rupees,
 * but the server speaks integer paise, so every amount is converted to a
 * minor-unit *string* at the boundary (`toMinor`) and never touched by client
 * arithmetic beyond a display-only running total. The authoritative total is
 * whatever the ledger computes when the invoice posts — the figure shown here is
 * a courtesy, and is labelled as an estimate for exactly that reason.
 *
 * `postImmediately` is offered because most users want "create and send", but
 * that path needs the `ledger:post` capability, which the server enforces — an
 * accountant can tick it, a staff member's request would be refused server-side.
 */

type LineDraft = {
  description: string;
  quantity: string;
  unitPriceRupees: string;
  taxRateId: string;
};

type Customer = { id: string; displayName: string };
type TaxRate = { id: string; name: string; ratePercent: number };

const NO_TAX = "__none__";

function emptyLine(): LineDraft {
  return { description: "", quantity: "1", unitPriceRupees: "", taxRateId: NO_TAX };
}

/** Rupees string → minor-unit string. "1234.5" → "123450". */
function toMinor(rupees: string): string {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 100));
}

export function NewInvoiceDialog({
  customers,
  taxRates,
  canPost,
}: {
  customers: Customer[];
  taxRates: TaxRate[];
  /** Whether this user may post to the ledger (drives the "issue now" option). */
  canPost: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contactId, setContactId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(() => todayIso());
  const [dueDate, setDueDate] = useState("");
  const [postNow, setPostNow] = useState(false);
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const idem = useIdempotencyKey();

  const taxById = useMemo(() => new Map(taxRates.map((t) => [t.id, t])), [taxRates]);

  // Display-only estimate. The ledger computes the authoritative figure on post.
  const estimateMinor = useMemo(() => {
    let total = 0;
    for (const l of lines) {
      const net = (Number(l.quantity) || 0) * (Number(l.unitPriceRupees) || 0);
      const rate = l.taxRateId !== NO_TAX ? (taxById.get(l.taxRateId)?.ratePercent ?? 0) : 0;
      total += net * (1 + rate / 100);
    }
    return Math.round(total * 100);
  }, [lines, taxById]);

  function reset() {
    setContactId("");
    setInvoiceDate(todayIso());
    setDueDate("");
    setPostNow(false);
    setLines([emptyLine()]);
    setError(null);
  }

  function updateLine(index: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!contactId) {
      setError("Choose a customer.");
      return;
    }
    const usable = lines.filter((l) => l.description.trim() && Number(l.unitPriceRupees) > 0);
    if (usable.length === 0) {
      setError("Add at least one line with a description and a price.");
      return;
    }

    setPending(true);
    try {
      const result = await createInvoiceFn({
        data: {
          contactId,
          invoiceDate,
          dueDate: dueDate || undefined,
          postImmediately: postNow,
          idempotencyKey: idem.key,
          lines: usable.map((l) => ({
            description: l.description.trim(),
            quantity: l.quantity || "1",
            unitPriceMinor: toMinor(l.unitPriceRupees),
            taxRateId: l.taxRateId === NO_TAX ? null : l.taxRateId,
          })),
        },
      });
      idem.renew(); // observed success → the next invoice is a new operation
      setOpen(false);
      reset();
      toast.success(
        result.awaitingApproval
          ? `Invoice ${result.invoiceNumber} created — it needs approval from another user before it posts`
          : postNow
            ? `Invoice ${result.invoiceNumber} created and issued`
            : `Draft invoice ${result.invoiceNumber} created`,
      );
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the invoice.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="bg-gradient-brand text-white">
          <Plus className="mr-1.5 h-4 w-4" />
          New Invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New invoice</DialogTitle>
            <DialogDescription>A draft has no ledger impact until it is issued.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Customer</Label>
              <Select value={contactId} onValueChange={setContactId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a customer" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="inv-date">Invoice date</Label>
                <Input
                  id="inv-date"
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="inv-due">Due date (optional)</Label>
                <Input
                  id="inv-due"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Lines</Label>
              {lines.map((line, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_4rem_6rem_7rem_2rem] items-center gap-2"
                >
                  <Input
                    placeholder="Description"
                    value={line.description}
                    onChange={(e) => updateLine(i, { description: e.target.value })}
                  />
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    placeholder="Qty"
                    value={line.quantity}
                    onChange={(e) => updateLine(i, { quantity: e.target.value })}
                  />
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    placeholder="Unit ₹"
                    value={line.unitPriceRupees}
                    onChange={(e) => updateLine(i, { unitPriceRupees: e.target.value })}
                  />
                  <Select
                    value={line.taxRateId}
                    onValueChange={(v) => updateLine(i, { taxRateId: v })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_TAX}>No tax</SelectItem>
                      {taxRates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-8"
                    disabled={lines.length === 1}
                    onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setLines((prev) => [...prev, emptyLine()])}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                Add line
              </Button>
            </div>

            <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
              <span className="text-sm text-muted-foreground">Estimated total</span>
              <span className="font-semibold tabular-nums">
                {formatMinor(String(estimateMinor))}
              </span>
            </div>

            {canPost ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={postNow}
                  onChange={(e) => {
                    setPostNow(e.target.checked);
                    // Don't leave a stale validation error contradicting the new mode.
                    setError(null);
                  }}
                  className="size-4"
                />
                Issue immediately (posts to the ledger)
              </label>
            ) : null}
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
              ) : postNow ? (
                "Create & issue"
              ) : (
                "Create draft"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
