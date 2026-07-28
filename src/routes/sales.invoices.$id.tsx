import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { ArrowLeft, CreditCard, Loader2, Printer, Send } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
import { fetchInvoiceDetail, fetchDepositAccounts, postInvoiceFn, recordPaymentFn } from "@/api";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/sales/invoices/$id")({
  loader: async ({ params }) => {
    const [invoice, depositAccounts] = await Promise.all([
      fetchInvoiceDetail({ data: { id: params.id } }),
      fetchDepositAccounts(),
    ]);
    return { invoice, depositAccounts };
  },
  component: InvoiceDetail,
});

const statusStyle: Record<string, string> = {
  paid: "bg-success/10 text-success border-success/20",
  sent: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  overdue: "bg-destructive/10 text-destructive border-destructive/20",
  partially_paid: "bg-warning/10 text-warning-foreground border-warning/30",
  draft: "bg-muted text-muted-foreground border-border",
  void: "bg-muted text-muted-foreground border-border",
};

function InvoiceDetail() {
  const { invoice, depositAccounts } = Route.useLoaderData();
  const session = useSession();
  const router = useRouter();
  const canPost = useCan("ledger:post");
  const canPay = useCan("payment:record");

  const isDraft = invoice.status === "draft";
  const isVoid = invoice.status === "void";
  const outstanding = BigInt(invoice.balance) > 0n;

  const [sending, setSending] = useState(false);

  async function onIssue() {
    setSending(true);
    try {
      await postInvoiceFn({ data: { invoiceId: invoice.id } });
      toast.success("Invoice issued to the ledger");
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not issue the invoice.");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <PageHeader
        title={invoice.invoiceNumber}
        subtitle={`Invoice to ${invoice.customer?.name ?? "—"}`}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to="/sales/invoices">
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                Back
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="mr-1.5 h-4 w-4" />
              Print / PDF
            </Button>
            {isDraft && canPost ? (
              <Button
                size="sm"
                className="bg-gradient-brand text-white"
                onClick={onIssue}
                disabled={sending}
              >
                {sending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-1.5 h-4 w-4" />
                )}
                Issue invoice
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-[1fr_320px]">
        <Card className="shadow-elegant p-8">
          <div className="flex items-start justify-between">
            <div>
              <p className="font-semibold">{session?.orgName ?? "—"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {invoice.foreignTotal
                  ? `${invoice.currency} invoice @ ₹${Number(invoice.exchangeRate).toFixed(2)}`
                  : `${invoice.currency ?? "INR"} invoice`}
              </p>
            </div>
            <div className="text-right">
              <h2 className="text-3xl font-bold tracking-tight">INVOICE</h2>
              <p className="mt-1 text-sm text-muted-foreground">{invoice.invoiceNumber}</p>
              <Badge className={`mt-2 ${statusStyle[invoice.status] ?? ""}`} variant="outline">
                {invoice.status}
              </Badge>
            </div>
          </div>

          <Separator className="my-6" />

          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Bill To</p>
              <p className="mt-1 font-semibold">{invoice.customer?.name ?? "—"}</p>
              <p className="text-sm text-muted-foreground">
                {invoice.customer?.email ?? ""}
                {invoice.customer?.taxRegistrationNumber ? (
                  <>
                    <br />
                    GSTIN {invoice.customer.taxRegistrationNumber}
                  </>
                ) : null}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  Invoice Date
                </p>
                <p className="mt-1 font-medium">{invoice.invoiceDate}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                  Due Date
                </p>
                <p className="mt-1 font-medium">{invoice.dueDate}</p>
              </div>
            </div>
          </div>

          <Separator className="my-6" />

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs uppercase tracking-wider text-muted-foreground">
                <th className="pb-2 text-left">Description</th>
                <th className="w-16 pb-2 text-right">Qty</th>
                <th className="w-28 pb-2 text-right">Rate</th>
                <th className="w-24 pb-2 text-right">Tax</th>
                <th className="w-32 pb-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((l) => (
                <tr key={l.id} className="border-b last:border-0">
                  <td className="py-3 font-medium">{l.description}</td>
                  <td className="text-right tabular-nums">{l.quantity}</td>
                  <td className="text-right tabular-nums">{formatMinor(l.unitPrice)}</td>
                  <td className="text-right tabular-nums">{formatMinor(l.taxAmount)}</td>
                  <td className="text-right font-medium tabular-nums">
                    {formatMinor(l.lineTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-6 flex justify-end">
            <div className="w-72 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="tabular-nums">{formatMinor(invoice.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tax</span>
                <span className="tabular-nums">{formatMinor(invoice.taxTotal)}</span>
              </div>
              <Separator />
              <div className="flex justify-between text-base font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{formatMinor(invoice.total)}</span>
              </div>
              {invoice.foreignTotal ? (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>In {invoice.currency}</span>
                  <span className="tabular-nums">
                    {invoice.currency}{" "}
                    {(Number(invoice.foreignTotal) / 100).toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                    })}
                  </span>
                </div>
              ) : null}
              <div className="text-brand flex justify-between font-semibold">
                <span>Balance Due</span>
                <span className="tabular-nums">{formatMinor(invoice.balance)}</span>
              </div>
            </div>
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">Balance Due</p>
            <p className="text-brand mt-1 text-3xl font-semibold tabular-nums">
              {formatMinor(invoice.balance)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              of {formatMinor(invoice.total)} total
            </p>

            {isDraft ? (
              <p className="mt-4 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                This invoice is a draft. Issue it before recording a payment.
              </p>
            ) : isVoid ? (
              <p className="mt-4 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                This invoice is void.
              </p>
            ) : outstanding && canPay ? (
              <RecordPaymentDialog
                invoice={invoice}
                depositAccounts={depositAccounts}
                onDone={() => router.invalidate()}
              />
            ) : !outstanding ? (
              <p className="text-success mt-4 rounded-md bg-success/10 px-3 py-2 text-xs">
                Fully paid.
              </p>
            ) : null}
          </Card>

          {invoice.payments.length > 0 ? (
            <Card className="p-5">
              <p className="mb-3 text-sm font-semibold">Payments</p>
              <div className="space-y-3 text-sm">
                {invoice.payments.map((p, i) => (
                  <div key={i} className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{p.paymentNumber}</p>
                      <p className="text-xs text-muted-foreground">
                        {p.paymentDate}
                        {p.method ? ` · ${p.method}` : ""}
                      </p>
                    </div>
                    <span className="text-success tabular-nums">{formatMinor(p.amount)}</span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

/**
 * Record a receipt against this invoice.
 *
 * The amount defaults to the full outstanding balance — the common case — but is
 * editable for partial payments. The server enforces that the allocation can't
 * exceed the balance, so an over-payment here is refused rather than silently
 * mis-posted.
 */
function RecordPaymentDialog({
  invoice,
  depositAccounts,
  onDone,
}: {
  invoice: {
    id: string;
    invoiceNumber: string;
    balance: string;
    customer: { id: string } | null;
  };
  depositAccounts: Array<{ id: string; code: string; name: string }>;
  onDone: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const balanceRupees = (Number(invoice.balance) / 100).toString();
  const [amountRupees, setAmountRupees] = useState(balanceRupees);
  const [depositAccountId, setDepositAccountId] = useState(depositAccounts[0]?.id ?? "");
  const [method, setMethod] = useState("Bank transfer");
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!invoice.customer) {
      setError("This invoice has no customer to receive from.");
      return;
    }
    if (!depositAccountId) {
      setError("Choose the account the money landed in.");
      return;
    }
    const amountMinor = String(Math.round(Number(amountRupees) * 100));
    if (Number(amountMinor) <= 0) {
      setError("Enter a positive amount.");
      return;
    }

    setPending(true);
    try {
      await recordPaymentFn({
        data: {
          contactId: invoice.customer.id,
          paymentDate,
          amountMinor,
          depositAccountId,
          method,
          allocations: [{ invoiceId: invoice.id, amountMinor }],
        },
      });
      setOpen(false);
      toast.success(`Payment recorded against ${invoice.invoiceNumber}`);
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the payment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-gradient-brand mt-4 w-full text-white">
          <CreditCard className="mr-2 h-4 w-4" />
          Record Payment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Record payment</DialogTitle>
            <DialogDescription>
              Against {invoice.invoiceNumber} — {formatMinor(invoice.balance)} outstanding.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="pay-amount">Amount (₹)</Label>
              <Input
                id="pay-amount"
                type="number"
                min="0"
                step="any"
                value={amountRupees}
                onChange={(e) => setAmountRupees(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pay-date">Date</Label>
              <Input
                id="pay-date"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>Deposit to</Label>
              <Select value={depositAccountId} onValueChange={setDepositAccountId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an account" />
                </SelectTrigger>
                <SelectContent>
                  {depositAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pay-method">Method</Label>
              <Input
                id="pay-method"
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                placeholder="Bank transfer, UPI, cheque…"
              />
            </div>
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
                  Recording…
                </>
              ) : (
                "Record payment"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
