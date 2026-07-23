import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Sparkles,
  CheckCircle2,
  Link2,
  Search,
  FileDown,
  ArrowUpRight,
  ArrowDownLeft,
  Wand2,
  X,
  Building2,
} from "lucide-react";
import { toast } from "sonner";
import { fetchBankSummary, fetchBankTransactions } from "@/api/entities";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/banking/review")({
  loader: async () => {
    const [txns, accounts] = await Promise.all([
      fetchBankTransactions({ data: { limit: 100 } }),
      fetchBankSummary(),
    ]);
    return { txns, accounts };
  },
  component: ReviewTxns,
});

type Txn = Awaited<ReturnType<typeof fetchBankTransactions>>[number];
type Filter = "all" | "unreconciled" | "categorized" | "matched" | "reconciled" | "excluded";

// Categorization and ledger posting flow through the banking service, which
// depends on a live bank-feed / aggregator integration that isn't wired in this
// environment. Every write-shaped action tells the truth about that instead of
// faking success.
const FEED_MSG =
  "Transaction categorization posts to the ledger via the banking service; live feed integration required.";

const statusStyle: Record<string, string> = {
  reconciled: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  matched: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  categorized: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  unreconciled: "bg-destructive/10 text-destructive border-destructive/20",
  excluded: "bg-muted text-muted-foreground border-border",
};

function ReviewTxns() {
  const { txns, accounts } = Route.useLoaderData();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Txn | null>(null);

  const accountName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) m.set(a.id, `${a.name} · ${a.accountNumberMasked}`);
    return m;
  }, [accounts]);

  const filtered = useMemo(
    () =>
      txns.filter(
        (t) =>
          (filter === "all" || t.status === filter) &&
          (q === "" ||
            t.description.toLowerCase().includes(q.toLowerCase()) ||
            (accountName.get(t.bankAccountId) ?? "").toLowerCase().includes(q.toLowerCase())),
      ),
    [txns, filter, q, accountName],
  );

  const counts = useMemo(
    () => ({
      all: txns.length,
      unreconciled: txns.filter((t) => t.status === "unreconciled").length,
      categorized: txns.filter((t) => t.status === "categorized").length,
      matched: txns.filter((t) => t.status === "matched").length,
      reconciled: txns.filter((t) => t.status === "reconciled").length,
      excluded: txns.filter((t) => t.status === "excluded").length,
    }),
    [txns],
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((t) => t.id)));
  };

  // Write-shaped actions — honest placeholders, no fake success.
  const notWired = () => toast.info(FEED_MSG);

  return (
    <>
      <PageHeader
        title="Review Fetched Transactions"
        subtitle="Inspect bank & UPI transactions before they hit your ledger"
      />
      <div className="p-6 space-y-5">
        {/* KPIs — click to filter */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {(
            [
              ["all", "Fetched", counts.all, "text-foreground"],
              ["reconciled", "Reconciled", counts.reconciled, "text-emerald-600"],
              ["matched", "Matched", counts.matched, "text-emerald-600"],
              ["categorized", "Categorized", counts.categorized, "text-amber-600"],
              ["unreconciled", "Unreconciled", counts.unreconciled, "text-destructive"],
            ] as const
          ).map(([key, label, n, color]) => (
            <button
              key={key}
              onClick={() => setFilter(key as Filter)}
              className={`text-left p-4 rounded-xl border bg-card hover:shadow-elegant transition-all ${filter === key ? "border-primary ring-1 ring-primary/30" : ""}`}
            >
              <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
              <p className={`text-2xl font-semibold tabular-nums mt-1 ${color}`}>{n}</p>
            </button>
          ))}
        </div>

        {/* Toolbar */}
        <Card className="p-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search description or account…"
              className="pl-8 h-9"
            />
          </div>
          <Badge variant="secondary" className="gap-1 py-1.5">
            <Sparkles className="h-3 w-3 text-primary" /> {filtered.length} shown
          </Badge>
          <Button variant="outline" size="sm" onClick={notWired}>
            <Wand2 className="h-4 w-4 mr-1.5" /> AI re-categorize
          </Button>
          <Button variant="outline" size="sm" disabled={selected.size === 0} onClick={notWired}>
            <CheckCircle2 className="h-4 w-4 mr-1.5" /> Confirm selected ({selected.size})
          </Button>
          <Button size="sm" onClick={notWired} className="bg-gradient-brand text-white">
            <FileDown className="h-4 w-4 mr-1.5" /> Import to ledger
          </Button>
        </Card>

        {/* Table */}
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={selected.size === filtered.length && filtered.length > 0}
                    onCheckedChange={toggleAll}
                  />
                </TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t) => {
                const negative = t.amount.startsWith("-");
                return (
                  <TableRow
                    key={t.id}
                    className="hover:bg-muted/40 cursor-pointer"
                    onClick={() => setOpen(t)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={selected.has(t.id)} onCheckedChange={() => toggle(t.id)} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {t.transactionDate}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {negative ? (
                          <ArrowUpRight className="h-3.5 w-3.5 text-destructive shrink-0" />
                        ) : (
                          <ArrowDownLeft className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                        )}
                        <div>
                          <p className="text-sm font-medium truncate max-w-[320px]">
                            {t.description}
                          </p>
                          {t.matchedEntryId && (
                            <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                              <Link2 className="h-2.5 w-2.5" />
                              Matched to journal entry
                            </p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Building2 className="h-3 w-3" />
                        {accountName.get(t.bankAccountId) ?? "—"}
                      </div>
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums font-semibold text-sm ${negative ? "text-destructive" : "text-emerald-600"}`}
                    >
                      {negative ? "" : "+"}
                      {formatMinor(t.amount, { currency: t.currency })}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`text-[10px] capitalize ${statusStyle[t.status] ?? ""}`}
                      >
                        {t.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-sm text-muted-foreground py-10"
                  >
                    {txns.length === 0
                      ? "No transactions yet. Connect a bank feed to import activity."
                      : "Nothing here — all clear"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      {/* Detail sheet */}
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="sm:max-w-md">
          {open &&
            (() => {
              const negative = open.amount.startsWith("-");
              return (
                <>
                  <SheetHeader>
                    <SheetTitle className="flex items-center gap-2">
                      {negative ? (
                        <ArrowUpRight className="h-4 w-4 text-destructive" />
                      ) : (
                        <ArrowDownLeft className="h-4 w-4 text-emerald-500" />
                      )}
                      {open.description}
                    </SheetTitle>
                    <SheetDescription>
                      {open.transactionDate} · {accountName.get(open.bankAccountId) ?? "—"}
                    </SheetDescription>
                  </SheetHeader>
                  <div className="mt-6 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Amount
                        </label>
                        <p
                          className={`text-lg font-semibold tabular-nums mt-1 ${negative ? "text-destructive" : "text-emerald-600"}`}
                        >
                          {negative ? "" : "+"}
                          {formatMinor(open.amount, { currency: open.currency })}
                        </p>
                      </div>
                      <div>
                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Status
                        </label>
                        <div className="mt-1.5">
                          <Badge
                            variant="outline"
                            className={`text-[10px] capitalize ${statusStyle[open.status] ?? ""}`}
                          >
                            {open.status}
                          </Badge>
                        </div>
                      </div>
                    </div>

                    <div className="pt-2 border-t space-y-2">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Details
                      </p>
                      <div className="text-[11px] text-muted-foreground space-y-1">
                        <p>
                          • Currency{" "}
                          <span className="text-foreground font-medium">{open.currency}</span>
                        </p>
                        <p>
                          • Account{" "}
                          <span className="text-foreground font-medium">
                            {accountName.get(open.bankAccountId) ?? "—"}
                          </span>
                        </p>
                        {open.matchedEntryId && (
                          <p>
                            • Linked to journal entry{" "}
                            <span className="text-foreground font-medium">
                              {open.matchedEntryId}
                            </span>
                          </p>
                        )}
                        {open.matchedPaymentId && (
                          <p>
                            • Linked to payment{" "}
                            <span className="text-foreground font-medium">
                              {open.matchedPaymentId}
                            </span>
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-6">
                    <Button variant="ghost" className="flex-1" onClick={() => toast.info(FEED_MSG)}>
                      <X className="h-4 w-4 mr-1.5" /> Ignore
                    </Button>
                    <Button
                      className="flex-1 bg-gradient-brand text-white"
                      onClick={() => toast.info(FEED_MSG)}
                    >
                      <CheckCircle2 className="h-4 w-4 mr-1.5" /> Confirm & import
                    </Button>
                  </div>
                </>
              );
            })()}
        </SheetContent>
      </Sheet>
    </>
  );
}
