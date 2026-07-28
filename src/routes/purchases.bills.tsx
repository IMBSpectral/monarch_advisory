import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
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
import { useCan, useSession } from "@/components/SessionContext";
import { fetchBills, createBillFn, postBillFn } from "@/api/bills";
import { fetchApprovalSettings } from "@/api/settings";
import { useIdempotencyKey } from "@/lib/idempotency";
import { fetchContacts, fetchTaxRates } from "@/api/entities";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/purchases/bills")({
  loader: async () => {
    const [bills, vendors, taxRates, approval] = await Promise.all([
      fetchBills({ data: {} }),
      fetchContacts({ data: { type: "vendor" } }),
      fetchTaxRates(),
      fetchApprovalSettings(),
    ]);
    return { bills, vendors, taxRates, approval };
  },
  component: Bills,
});

const statusStyle: Record<string, string> = {
  paid: "bg-success/10 text-success border-success/20",
  open: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  partially_paid: "bg-warning/10 text-warning-foreground border-warning/30",
  overdue: "bg-destructive/10 text-destructive border-destructive/20",
  draft: "bg-muted text-muted-foreground border-border",
  awaiting_approval: "bg-warning/10 text-warning-foreground border-warning/30",
  void: "bg-muted text-muted-foreground border-border",
};

const statusLabel: Record<string, string> = {
  paid: "Paid",
  open: "Open",
  partially_paid: "Partial",
  overdue: "Overdue",
  draft: "Draft",
  awaiting_approval: "Awaiting approval",
  void: "Void",
};

function Bills() {
  const { bills, vendors, taxRates, approval } = Route.useLoaderData();
  const canCreate = useCan("document:create");
  const canPost = useCan("ledger:post");
  const session = useSession();
  const router = useRouter();
  const [postingId, setPostingId] = useState<string | null>(null);

  const threshold = approval.approvalThresholdMinor
    ? BigInt(approval.approvalThresholdMinor)
    : null;
  const needsApproval = (b: (typeof bills)[number]) =>
    threshold !== null && BigInt(b.total) >= threshold;

  async function post(b: (typeof bills)[number]) {
    setPostingId(b.id);
    try {
      await postBillFn({ data: { billId: b.id } });
      toast.success(`${b.billNumber} posted.`);
      await router.invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not post the bill.");
    } finally {
      setPostingId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Bills"
        subtitle="Vendor bills, payments, and approvals"
        actions={
          canCreate ? (
            <NewBillDialog vendors={vendors} taxRates={taxRates} canPost={canPost} />
          ) : undefined
        }
      />
      <div className="p-6">
        {threshold !== null ? (
          <p className="mb-3 text-sm text-muted-foreground">
            Approvals on — a bill at or above{" "}
            <span className="font-medium">{formatMinor(threshold, { showPaise: false })}</span> must
            be posted by someone other than the person who raised it.
          </p>
        ) : null}
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bill #</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bills.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                    No bills yet. Record your first vendor bill.
                  </TableCell>
                </TableRow>
              ) : (
                bills.map((b) => {
                  const isDraft = b.status === "draft";
                  const gated = isDraft && needsApproval(b);
                  const ownBill = session?.userId === b.createdByUserId;
                  return (
                    <TableRow key={b.id} className="hover:bg-muted/40">
                      <TableCell className="text-brand font-medium">{b.billNumber}</TableCell>
                      <TableCell>{b.vendorName}</TableCell>
                      <TableCell className="text-muted-foreground">{b.billDate}</TableCell>
                      <TableCell className="text-muted-foreground">{b.dueDate}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatMinor(b.total)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMinor(b.balance)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Badge variant="outline" className={statusStyle[b.status] ?? ""}>
                            {statusLabel[b.status] ?? b.status}
                          </Badge>
                          {gated ? (
                            <Badge
                              variant="outline"
                              className="border-warning/30 bg-warning/10 text-warning-foreground"
                            >
                              Needs approval
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {isDraft && canPost ? (
                          gated && ownBill ? (
                            <span className="text-xs text-muted-foreground">
                              Another user must approve
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={postingId === b.id}
                              onClick={() => post(b)}
                            >
                              {postingId === b.id ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : null}
                              {gated ? "Approve & post" : "Post"}
                            </Button>
                          )
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}

type LineDraft = {
  description: string;
  quantity: string;
  unitPriceRupees: string;
  taxRateId: string;
};
type Vendor = { id: string; displayName: string };
type TaxRate = { id: string; name: string; ratePercent: number };

const NO_TAX = "__none__";
const emptyLine = (): LineDraft => ({
  description: "",
  quantity: "1",
  unitPriceRupees: "",
  taxRateId: NO_TAX,
});

/**
 * New-bill dialog — the payables mirror of the invoice dialog.
 *
 * Same money discipline: rupees typed here become integer-paise strings at the
 * server boundary, and the authoritative total is what the ledger computes on
 * post. "Approve & post" needs `ledger:post`, which the server enforces.
 */
function NewBillDialog({
  vendors,
  taxRates,
  canPost,
}: {
  vendors: Vendor[];
  taxRates: TaxRate[];
  canPost: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contactId, setContactId] = useState("");
  const [vendorInvoiceNumber, setVendorInvoiceNumber] = useState("");
  const [billDate, setBillDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState("");
  const [postNow, setPostNow] = useState(false);
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const idem = useIdempotencyKey();

  const taxById = useMemo(() => new Map(taxRates.map((t) => [t.id, t])), [taxRates]);

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
    setVendorInvoiceNumber("");
    setBillDate(new Date().toISOString().slice(0, 10));
    setDueDate("");
    setPostNow(false);
    setLines([emptyLine()]);
    setError(null);
  }

  function updateLine(i: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!contactId) {
      setError("Choose a vendor.");
      return;
    }
    const usable = lines.filter((l) => l.description.trim() && Number(l.unitPriceRupees) > 0);
    if (usable.length === 0) {
      setError("Add at least one line with a description and a price.");
      return;
    }

    setPending(true);
    try {
      const result = await createBillFn({
        data: {
          contactId,
          billDate,
          dueDate: dueDate || undefined,
          vendorInvoiceNumber: vendorInvoiceNumber || undefined,
          postImmediately: postNow,
          idempotencyKey: idem.key,
          lines: usable.map((l) => ({
            description: l.description.trim(),
            quantity: l.quantity || "1",
            unitPriceMinor: String(Math.round(Number(l.unitPriceRupees) * 100)),
            taxRateId: l.taxRateId === NO_TAX ? null : l.taxRateId,
          })),
        },
      });
      idem.renew();
      setOpen(false);
      reset();
      toast.success(
        result.awaitingApproval
          ? `Bill ${result.billNumber} saved — it needs approval from another user before it posts`
          : postNow
            ? `Bill ${result.billNumber} recorded and posted`
            : `Draft bill ${result.billNumber} saved`,
      );
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the bill.");
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
          New Bill
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New bill</DialogTitle>
            <DialogDescription>Record what you owe a vendor.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Vendor</Label>
                <Select value={contactId} onValueChange={setContactId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a vendor" />
                  </SelectTrigger>
                  <SelectContent>
                    {vendors.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="bill-vinv">Vendor invoice #</Label>
                <Input
                  id="bill-vinv"
                  value={vendorInvoiceNumber}
                  onChange={(e) => setVendorInvoiceNumber(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="bill-date">Bill date</Label>
                <Input
                  id="bill-date"
                  type="date"
                  value={billDate}
                  onChange={(e) => setBillDate(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="bill-due">Due date (optional)</Label>
                <Input
                  id="bill-due"
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
                    setError(null);
                  }}
                  className="size-4"
                />
                Approve &amp; post to the ledger now
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
                "Record & post"
              ) : (
                "Save draft"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
