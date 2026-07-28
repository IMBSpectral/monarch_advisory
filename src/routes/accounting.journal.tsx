import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent } from "react";
import { Plus, Trash2, Loader2 } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { fetchJournal, fetchChartOfAccounts } from "@/api";
import { fetchCostCenters, createManualEntryFn } from "@/api/dimensions";
import { useCan } from "@/components/SessionContext";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/accounting/journal")({
  loader: async () => {
    const [journals, accounts, costCenters] = await Promise.all([
      fetchJournal({ data: {} }),
      fetchChartOfAccounts(),
      fetchCostCenters(),
    ]);
    return { journals, accounts, costCenters };
  },
  component: Journals,
});

const statusStyle: Record<string, string> = {
  posted: "bg-success/10 text-success border-success/20",
  draft: "bg-muted text-muted-foreground border-border",
  reversed: "bg-destructive/10 text-destructive border-destructive/20",
};

function Journals() {
  const { journals, accounts, costCenters } = Route.useLoaderData();
  const canPost = useCan("ledger:post");

  return (
    <>
      <PageHeader
        title="Journal Entries"
        subtitle="Double-entry postings across all accounts"
        actions={canPost ? <NewEntry accounts={accounts} costCenters={costCenters} /> : undefined}
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entry #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Memo</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {journals.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    No journal entries yet.
                  </TableCell>
                </TableRow>
              ) : (
                journals.map((j) => (
                  <TableRow key={j.id} className="hover:bg-muted/40">
                    <TableCell className="font-mono text-xs text-brand">{j.entryNumber}</TableCell>
                    <TableCell className="text-muted-foreground">{j.entryDate}</TableCell>
                    <TableCell>{j.memo ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-xs capitalize">
                      {j.source ? j.source.replace(/_/g, " ") : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`capitalize ${statusStyle[j.status] ?? ""}`}
                      >
                        {j.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {j.lineCount}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMinor(j.amount)}
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

type Account = { id: string; code: string; name: string; isGroup?: boolean };
type CostCenter = { id: string; name: string };
type Line = { accountId: string; side: "debit" | "credit"; amount: string; costCenterId: string };

const NO_CC = "__none__";
const emptyLine = (): Line => ({ accountId: "", side: "debit", amount: "", costCenterId: NO_CC });

function NewEntry({ accounts, costCenters }: { accounts: Account[]; costCenters: CostCenter[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);

  const postable = useMemo(() => accounts.filter((a) => !a.isGroup), [accounts]);
  const totals = useMemo(() => {
    let dr = 0;
    let cr = 0;
    for (const l of lines) {
      const amt = Number(l.amount) || 0;
      if (l.side === "debit") dr += amt;
      else cr += amt;
    }
    return { dr, cr, balanced: dr > 0 && Math.abs(dr - cr) < 0.005 };
  }, [lines]);

  const update = (i: number, patch: Partial<Line>) =>
    setLines((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  function reset() {
    setDate(new Date().toISOString().slice(0, 10));
    setMemo("");
    setLines([emptyLine(), emptyLine()]);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const usable = lines.filter((l) => l.accountId && Number(l.amount) > 0);
    if (usable.length < 2) return setError("Add at least two lines with an account and amount.");
    if (!totals.balanced)
      return setError(`Debits (₹${totals.dr}) must equal credits (₹${totals.cr}).`);
    setPending(true);
    try {
      const r = await createManualEntryFn({
        data: {
          entryDate: date,
          memo: memo || undefined,
          lines: usable.map((l) => ({
            accountId: l.accountId,
            side: l.side,
            amountMinor: String(Math.round(Number(l.amount) * 100)),
            costCenterId: l.costCenterId === NO_CC ? null : l.costCenterId,
          })),
        },
      });
      setOpen(false);
      reset();
      toast.success(`Journal entry ${r.entryNumber} posted`);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post the entry.");
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
          New Entry
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New journal entry</DialogTitle>
            <DialogDescription>
              A manual double-entry posting. Debits must equal credits.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Date</Label>
                <Input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label>Memo</Label>
                <Input
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="What is this for?"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Lines</Label>
              {lines.map((line, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1.6fr_5.5rem_6rem_1.4fr_2rem] items-center gap-2"
                >
                  <Select value={line.accountId} onValueChange={(v) => update(i, { accountId: v })}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Account" />
                    </SelectTrigger>
                    <SelectContent>
                      {postable.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} · {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={line.side}
                    onValueChange={(v) => update(i, { side: v as "debit" | "credit" })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="debit">Debit</SelectItem>
                      <SelectItem value="credit">Credit</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    placeholder="₹"
                    value={line.amount}
                    onChange={(e) => update(i, { amount: e.target.value })}
                  />
                  <Select
                    value={line.costCenterId}
                    onValueChange={(v) => update(i, { costCenterId: v })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_CC}>No cost centre</SelectItem>
                      {costCenters.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-8"
                    disabled={lines.length <= 2}
                    onClick={() => setLines((p) => p.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setLines((p) => [...p, emptyLine()])}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                Add line
              </Button>
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                Debits ₹{totals.dr.toLocaleString("en-IN")} · Credits ₹
                {totals.cr.toLocaleString("en-IN")}
              </span>
              <Badge
                variant="outline"
                className={
                  totals.balanced
                    ? "border-success/20 bg-success/10 text-success"
                    : "border-destructive/20 bg-destructive/10 text-destructive"
                }
              >
                {totals.balanced ? "Balanced" : "Out of balance"}
              </Badge>
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
            <Button type="submit" disabled={pending || !totals.balanced}>
              {pending ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Posting…
                </>
              ) : (
                "Post entry"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
