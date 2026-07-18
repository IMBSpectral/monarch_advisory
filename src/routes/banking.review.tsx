import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Sparkles, CheckCircle2, AlertTriangle, Link2, Search, FileDown,
  ArrowUpRight, ArrowDownLeft, Wand2, X, Building2, Smartphone, Percent,
} from "lucide-react";
import { toast } from "sonner";
import { inr, inrFull } from "@/data/mock";

export const Route = createFileRoute("/banking/review")({ component: ReviewTxns });

type Status = "matched" | "suggested" | "unmatched" | "duplicate";
type Txn = {
  id: string;
  date: string;
  desc: string;
  source: string;
  sourceKind: "bank" | "upi";
  amount: number;
  type: "credit" | "debit";
  category: string;
  aiConfidence: number;
  status: Status;
  match?: string;
  gst?: number;
};

const CATEGORIES = [
  "Sales Revenue", "Service Income", "Rent", "Salaries & Wages",
  "Office Supplies", "Travel & Conveyance", "Marketing", "Software Subscriptions",
  "Utilities", "Professional Fees", "GST Payable", "Bank Charges", "Uncategorized",
];

const seed: Txn[] = [
  { id: "T-1041", date: "2026-07-18", desc: "NEFT / ACME CORP LTD / INV-2041", source: "HDFC XXXX4521", sourceKind: "bank", amount: 285000, type: "credit", category: "Sales Revenue", aiConfidence: 98, status: "suggested", match: "INV-2041 · Acme Corp", gst: 18 },
  { id: "T-1042", date: "2026-07-18", desc: "UPI-ZOMATO-OFFICE LUNCH", source: "GPay monarch@okhdfc", sourceKind: "upi", amount: 2840, type: "debit", category: "Travel & Conveyance", aiConfidence: 74, status: "suggested" },
  { id: "T-1043", date: "2026-07-17", desc: "IMPS / TATA POWER / BILL 7789", source: "HDFC XXXX4521", sourceKind: "bank", amount: 48200, type: "debit", category: "Utilities", aiConfidence: 96, status: "suggested", match: "BILL-7789 · Tata Power" },
  { id: "T-1044", date: "2026-07-17", desc: "AWS INDIA — CLOUD SVCS", source: "ICICI XXXX8890", sourceKind: "bank", amount: 128400, type: "debit", category: "Software Subscriptions", aiConfidence: 99, status: "matched", match: "BILL-7791 · AWS India", gst: 18 },
  { id: "T-1045", date: "2026-07-17", desc: "UPI-OLA CABS", source: "PhonePe monarcherp@ybl", sourceKind: "upi", amount: 640, type: "debit", category: "Travel & Conveyance", aiConfidence: 92, status: "matched" },
  { id: "T-1046", date: "2026-07-16", desc: "NEFT / ZENITH INDUSTRIES / ADV", source: "HDFC XXXX4521", sourceKind: "bank", amount: 1250000, type: "credit", category: "Sales Revenue", aiConfidence: 88, status: "suggested", match: "SO-3021 · Zenith Industries", gst: 18 },
  { id: "T-1047", date: "2026-07-16", desc: "SALARY TRF — JUL BATCH 1", source: "HDFC XXXX4521", sourceKind: "bank", amount: 1840000, type: "debit", category: "Salaries & Wages", aiConfidence: 99, status: "matched" },
  { id: "T-1048", date: "2026-07-16", desc: "CHRG / SMS ALERTS Q2", source: "HDFC XXXX4521", sourceKind: "bank", amount: 118, type: "debit", category: "Bank Charges", aiConfidence: 97, status: "matched" },
  { id: "T-1049", date: "2026-07-15", desc: "UPI-UNKNOWN-9821XXXX23", source: "GPay monarch@okhdfc", sourceKind: "upi", amount: 12500, type: "debit", category: "Uncategorized", aiConfidence: 32, status: "unmatched" },
  { id: "T-1050", date: "2026-07-15", desc: "NEFT / ACME CORP LTD / INV-2041", source: "HDFC XXXX4521", sourceKind: "bank", amount: 285000, type: "credit", category: "Sales Revenue", aiConfidence: 60, status: "duplicate", match: "Possible duplicate of T-1041" },
  { id: "T-1051", date: "2026-07-15", desc: "GST PMT — GSTR-3B JUN", source: "HDFC XXXX4521", sourceKind: "bank", amount: 486000, type: "debit", category: "GST Payable", aiConfidence: 99, status: "matched" },
  { id: "T-1052", date: "2026-07-14", desc: "MEESHO SETTLEMENT", source: "ICICI XXXX8890", sourceKind: "bank", amount: 94200, type: "credit", category: "Sales Revenue", aiConfidence: 91, status: "suggested", match: "Payout · Meesho" },
  { id: "T-1053", date: "2026-07-14", desc: "UPI-BLINKIT-OFFICE PANTRY", source: "GPay monarch@okhdfc", sourceKind: "upi", amount: 1840, type: "debit", category: "Office Supplies", aiConfidence: 84, status: "suggested" },
  { id: "T-1054", date: "2026-07-13", desc: "GOOGLE ADS INDIA", source: "HDFC XXXX4521", sourceKind: "bank", amount: 62400, type: "debit", category: "Marketing", aiConfidence: 98, status: "matched", gst: 18 },
];

const statusStyle: Record<Status, string> = {
  matched: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  suggested: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  unmatched: "bg-destructive/10 text-destructive border-destructive/20",
  duplicate: "bg-fuchsia-500/10 text-fuchsia-700 border-fuchsia-500/20",
};

function ReviewTxns() {
  const [txns, setTxns] = useState<Txn[]>(seed);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Status | "all">("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Txn | null>(null);

  const filtered = useMemo(
    () => txns.filter((t) =>
      (filter === "all" || t.status === filter) &&
      (q === "" || t.desc.toLowerCase().includes(q.toLowerCase()) || t.source.toLowerCase().includes(q.toLowerCase()))
    ),
    [txns, filter, q],
  );

  const counts = useMemo(() => ({
    all: txns.length,
    matched: txns.filter((t) => t.status === "matched").length,
    suggested: txns.filter((t) => t.status === "suggested").length,
    unmatched: txns.filter((t) => t.status === "unmatched").length,
    duplicate: txns.filter((t) => t.status === "duplicate").length,
  }), [txns]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((t) => t.id)));
  };

  const update = (id: string, patch: Partial<Txn>) =>
    setTxns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const confirmMatch = (id: string) => {
    update(id, { status: "matched" });
    toast.success("Match confirmed — ready to import");
  };

  const bulkConfirm = () => {
    const ids = Array.from(selected);
    setTxns((ts) => ts.map((t) => (ids.includes(t.id) && t.status === "suggested" ? { ...t, status: "matched" } : t)));
    toast.success(`${ids.length} transactions confirmed`);
    setSelected(new Set());
  };

  const bulkImport = () => {
    const ready = txns.filter((t) => t.status === "matched").length;
    toast.success(`${ready} transactions imported to General Ledger`);
    setTxns((ts) => ts.filter((t) => t.status !== "matched"));
    setSelected(new Set());
  };

  const aiRecategorize = () => {
    setTxns((ts) => ts.map((t) => t.status === "unmatched" ? { ...t, category: "Office Supplies", aiConfidence: 81, status: "suggested" } : t));
    toast.success("AI re-categorized 1 unmatched transaction");
  };

  const ignore = (id: string) => {
    setTxns((ts) => ts.filter((t) => t.id !== id));
    setOpen(null);
    toast("Transaction ignored");
  };

  const readyCount = txns.filter((t) => t.status === "matched").length;

  return (
    <>
      <PageHeader
        title="Review Fetched Transactions"
        subtitle="Inspect, edit and confirm bank & UPI transactions before they hit your ledger"
      />
      <div className="p-6 space-y-5">
        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {([
            ["all", "Fetched", counts.all, "text-foreground"],
            ["matched", "Auto-matched", counts.matched, "text-emerald-600"],
            ["suggested", "Needs review", counts.suggested, "text-amber-600"],
            ["unmatched", "Unmatched", counts.unmatched, "text-destructive"],
            ["duplicate", "Duplicates", counts.duplicate, "text-fuchsia-600"],
          ] as const).map(([key, label, n, color]) => (
            <button
              key={key}
              onClick={() => setFilter(key as any)}
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
            <Sparkles className="h-3 w-3 text-primary" /> AI confidence avg{" "}
            {Math.round(filtered.reduce((s, t) => s + t.aiConfidence, 0) / (filtered.length || 1))}%
          </Badge>
          <Button variant="outline" size="sm" onClick={aiRecategorize}>
            <Wand2 className="h-4 w-4 mr-1.5" /> AI re-categorize
          </Button>
          <Button variant="outline" size="sm" disabled={selected.size === 0} onClick={bulkConfirm}>
            <CheckCircle2 className="h-4 w-4 mr-1.5" /> Confirm selected ({selected.size})
          </Button>
          <Button size="sm" onClick={bulkImport} disabled={readyCount === 0} className="bg-gradient-brand text-white">
            <FileDown className="h-4 w-4 mr-1.5" /> Import {readyCount} to ledger
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
                <TableHead>Source</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>AI</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t) => (
                <TableRow key={t.id} className="hover:bg-muted/40 cursor-pointer" onClick={() => setOpen(t)}>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selected.has(t.id)} onCheckedChange={() => toggle(t.id)} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{t.date}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {t.type === "credit"
                        ? <ArrowDownLeft className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                        : <ArrowUpRight className="h-3.5 w-3.5 text-destructive shrink-0" />}
                      <div>
                        <p className="text-sm font-medium truncate max-w-[280px]">{t.desc}</p>
                        {t.match && <p className="text-[10px] text-muted-foreground flex items-center gap-1"><Link2 className="h-2.5 w-2.5" />{t.match}</p>}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {t.sourceKind === "bank" ? <Building2 className="h-3 w-3" /> : <Smartphone className="h-3 w-3" />}
                      {t.source}
                    </div>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Select value={t.category} onValueChange={(v) => update(t.id, { category: v })}>
                      <SelectTrigger className="h-7 text-xs w-[170px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.map((c) => <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <div className="h-1.5 w-10 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full ${t.aiConfidence > 85 ? "bg-emerald-500" : t.aiConfidence > 60 ? "bg-amber-500" : "bg-destructive"}`}
                          style={{ width: `${t.aiConfidence}%` }}
                        />
                      </div>
                      <span className="text-[10px] tabular-nums text-muted-foreground">{t.aiConfidence}%</span>
                    </div>
                  </TableCell>
                  <TableCell className={`text-right tabular-nums font-semibold text-sm ${t.type === "credit" ? "text-emerald-600" : "text-destructive"}`}>
                    {t.type === "credit" ? "+" : "−"}{inr(t.amount)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-[10px] capitalize ${statusStyle[t.status]}`}>{t.status}</Badge>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {t.status === "suggested" && (
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => confirmMatch(t.id)}>
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-sm text-muted-foreground py-10">
                    Nothing here — all clear
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
          {open && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  {open.type === "credit" ? <ArrowDownLeft className="h-4 w-4 text-emerald-500" /> : <ArrowUpRight className="h-4 w-4 text-destructive" />}
                  {open.desc}
                </SheetTitle>
                <SheetDescription>
                  {open.date} · {open.source} · {open.id}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-6 space-y-4">
                {open.status === "suggested" && open.match && (
                  <Card className="p-3 border-primary/30 bg-primary/5">
                    <div className="flex items-start gap-2">
                      <Sparkles className="h-4 w-4 text-primary mt-0.5" />
                      <div className="flex-1">
                        <p className="text-xs font-medium">AI suggested match</p>
                        <p className="text-sm mt-0.5">{open.match}</p>
                        <p className="text-[10px] text-muted-foreground mt-1">Confidence {open.aiConfidence}% · based on amount, date & memo similarity</p>
                      </div>
                    </div>
                  </Card>
                )}
                {open.status === "duplicate" && (
                  <Card className="p-3 border-fuchsia-500/30 bg-fuchsia-500/5">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-fuchsia-600 mt-0.5" />
                      <div className="flex-1">
                        <p className="text-xs font-medium">Possible duplicate</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">{open.match}</p>
                      </div>
                    </div>
                  </Card>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Amount</label>
                    <Input
                      type="number"
                      value={open.amount}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        update(open.id, { amount: v });
                        setOpen({ ...open, amount: v });
                      }}
                      className="mt-1 tabular-nums"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">{inrFull(open.amount)}</p>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Type</label>
                    <Select value={open.type} onValueChange={(v: any) => { update(open.id, { type: v }); setOpen({ ...open, type: v }); }}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="credit">Credit (money in)</SelectItem>
                        <SelectItem value="debit">Debit (money out)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Category</label>
                  <Select value={open.category} onValueChange={(v) => { update(open.id, { category: v }); setOpen({ ...open, category: v }); }}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1"><Percent className="h-3 w-3" />GST rate</label>
                    <Select value={String(open.gst ?? 0)} onValueChange={(v) => { const g = Number(v); update(open.id, { gst: g }); setOpen({ ...open, gst: g }); }}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {[0, 5, 12, 18, 28].map((g) => <SelectItem key={g} value={String(g)}>{g}%</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground">GST amount</label>
                    <p className="text-sm font-semibold tabular-nums mt-3">
                      {inr(Math.round((open.amount * (open.gst ?? 0)) / (100 + (open.gst ?? 0))))}
                    </p>
                  </div>
                </div>

                <div className="pt-2 border-t space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Audit trail</p>
                  <div className="text-[11px] text-muted-foreground space-y-1">
                    <p>• Fetched via RBI AA · {open.date} 06:12 IST</p>
                    <p>• AI Accountant categorized as <span className="text-foreground font-medium">{open.category}</span></p>
                    {open.match && <p>• Matched against <span className="text-foreground font-medium">{open.match}</span></p>}
                  </div>
                </div>
              </div>
              <div className="flex gap-2 mt-6">
                <Button variant="ghost" className="flex-1" onClick={() => ignore(open.id)}>
                  <X className="h-4 w-4 mr-1.5" /> Ignore
                </Button>
                <Button
                  className="flex-1 bg-gradient-brand text-white"
                  onClick={() => { confirmMatch(open.id); setOpen(null); }}
                >
                  <CheckCircle2 className="h-4 w-4 mr-1.5" /> Confirm & import
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
