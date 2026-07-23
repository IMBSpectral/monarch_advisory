import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent } from "react";
import { Loader2, Plus, ArrowRight } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { fetchContras, recordContraFn } from "@/api/vouchers";
import { fetchDepositAccounts } from "@/api/index";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/accounting/contra")({
  loader: async () => {
    const [contras, accounts] = await Promise.all([fetchContras(), fetchDepositAccounts()]);
    return { contras, accounts };
  },
  component: Contra,
});

type Account = { id: string; code: string; name: string };

function Contra() {
  const { contras, accounts } = Route.useLoaderData();
  const canPost = useCan("ledger:post");
  const nameById = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  return (
    <>
      <PageHeader
        title="Contra Vouchers"
        subtitle="Transfers between your own cash & bank accounts"
        actions={canPost ? <NewContra accounts={accounts} /> : undefined}
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Voucher #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>From → To</TableHead>
                <TableHead>Memo</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contras.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No transfers yet. Move money between two of your bank accounts.
                  </TableCell>
                </TableRow>
              ) : (
                contras.map((c) => (
                  <TableRow key={c.id} className="hover:bg-muted/40">
                    <TableCell className="text-brand font-medium">{c.number}</TableCell>
                    <TableCell className="text-muted-foreground">{c.date}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-sm">
                        {nameById.get(c.fromAccountId) ?? "—"}
                        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                        {nameById.get(c.toAccountId) ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.memo ?? "—"}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatMinor(c.amount)}</TableCell>
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

function NewContra({ accounts }: { accounts: Account[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");

  function reset() {
    setFromId(""); setToId(""); setAmount(""); setMemo(""); setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!fromId || !toId) return setError("Choose both accounts.");
    if (fromId === toId) return setError("From and To must differ.");
    if (!(Number(amount) > 0)) return setError("Enter an amount.");
    setPending(true);
    try {
      const r = await recordContraFn({
        data: {
          fromAccountId: fromId,
          toAccountId: toId,
          amountMinor: String(Math.round(Number(amount) * 100)),
          voucherDate: date,
          memo: memo || undefined,
        },
      });
      setOpen(false);
      reset();
      toast.success(`Contra ${r.number} recorded`);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the transfer.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(n) => { setOpen(n); if (!n) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-gradient-brand text-white">
          <Plus className="mr-1.5 h-4 w-4" />
          New Transfer
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New contra transfer</DialogTitle>
            <DialogDescription>Move funds between two cash/bank accounts.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>From</Label>
                <Select value={fromId} onValueChange={setFromId}>
                  <SelectTrigger><SelectValue placeholder="Source" /></SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>To</Label>
                <Select value={toId} onValueChange={setToId}>
                  <SelectTrigger><SelectValue placeholder="Destination" /></SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="ct-amt">Amount (₹)</Label>
                <Input id="ct-amt" type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ct-date">Date</Label>
                <Input id="ct-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ct-memo">Memo</Label>
              <Input id="ct-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. sweep to reserve" />
            </div>
          </div>
          {error ? <p role="alert" className="mb-2 text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>
              {pending ? <><Loader2 className="mr-2 size-4 animate-spin" />Recording…</> : "Record transfer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
