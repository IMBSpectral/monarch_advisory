import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeftRight,
  Sparkles,
  CheckCircle2,
  Search,
  FileText,
  Receipt,
  ArrowUpRight,
  ArrowDownLeft,
  Link2,
  Wand2,
  Building2,
  Smartphone,
  BookOpen,
  Send,
  AlertTriangle,
  Clock,
  Filter,
  Download,
  Printer,
  Split,
  Settings2,
  History,
  Undo2,
  Plus,
  Trash2,
  ShieldCheck,
  UserCheck,
  XCircle,
  MailCheck,
  ShieldAlert,
  Bell,
  BellRing,
  Pencil,
  Timer,
  Bookmark,
  Mail,
  RotateCcw,
  X,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useRole } from "@/components/RoleContext";
import { toast } from "sonner";
import { inr } from "@/lib/money";
import { fetchBankTransactions, fetchBankSummary } from "@/api/entities";
import { fetchInvoices } from "@/api";
import { fetchBills } from "@/api/bills";

export const Route = createFileRoute("/banking/reconcile")({
  loader: async () => {
    const [txns, invoices, bills, accounts] = await Promise.all([
      fetchBankTransactions({ data: { status: "unreconciled" } }),
      fetchInvoices({ data: {} }),
      fetchBills({ data: {} }),
      fetchBankSummary(),
    ]);
    return { txns, invoices, bills, accounts };
  },
  component: Reconcile,
});

type Allocation = {
  docId: string;
  docType: "invoice" | "bill";
  party: string;
  amount: number; // INR amount hitting the bank for this allocation
  // FX fields (present when the underlying doc is in a foreign currency)
  docCurrency?: string; // e.g. "USD"
  docAmount?: number; // amount in original currency
  fxAtDoc?: number; // INR per 1 unit at invoice/bill date (carrying value)
  fxAtSettle?: number; // INR per 1 unit at settlement date
};
type BankItem = {
  id: string;
  date: string;
  desc: string;
  source: string;
  kind: "bank" | "upi";
  amount: number; // INR amount as booked on the bank statement
  type: "credit" | "debit";
  currency?: string; // foreign currency of the underlying doc (INR default)
  fxAmount?: number; // amount in foreign currency
  fxAtSettle?: number; // settlement rate
  suggest?: {
    docId: string;
    docType: "invoice" | "bill";
    party: string;
    confidence: number;
    reason: string;
    docCurrency?: string;
    docAmount?: number;
    fxAtDoc?: number;
  };
  matched?: Allocation[]; // multiple = partial split
};

type DraftStatus = "draft" | "pending" | "approved" | "rejected" | "posted";
type Draft = {
  id: string;
  bankId: string;
  date: string;
  memo: string;
  ref: string;
  lines: { account: string; code: string; debit: number; credit: number }[];
  status: DraftStatus;
  source: string;
  amount: number;
  allocations: Allocation[];
  fx?: { currency: string; fxAtDoc: number; fxAtSettle: number; gain: number };
  approval?: {
    submittedBy?: string;
    submittedAt?: string;
    submittedTs?: number;
    approver?: string;
    decidedAt?: string;
    note?: string;
  };
  revision?: number;
  revisedFrom?: DraftStatus;
};

type Notification = {
  id: string;
  ts: string;
  kind: "submitted" | "approved" | "rejected" | "reminder" | "revised" | "posted";
  title: string;
  body: string;
  channel: ("email" | "in-app")[];
  toRole: "ceo" | "accountant" | "sales" | "all";
  read?: boolean;
  journalId?: string;
};

type SavedView = {
  id: string;
  name: string;
  statuses: DraftStatus[];
  submitter: string; // "" = all
  from: string; // "" = none
  to: string;
};

type AuditEvent = {
  ts: string;
  actor: string;
  action:
    | "match"
    | "auto-match"
    | "split"
    | "unmatch"
    | "post"
    | "rollback"
    | "rule-change"
    | "export"
    | "submit"
    | "approve"
    | "reject"
    | "recall"
    | "revise"
    | "notify"
    | "reminder";
  detail: string;
  bankId?: string;
  journalId?: string;
};

type Rule = {
  id: string;
  source: string; // e.g. HDFC XXXX8821 or "UPI"
  direction: "credit" | "debit" | "both";
  docType: "invoice" | "bill" | "auto";
  minConfidence: number;
  autoPost: boolean;
  enabled: boolean;
};

// Bank/UPI feed items are now built from real unreconciled bank transactions in
// the loader (see mapping inside Reconcile). The AI-suggestion metadata that the
// mock seed carried isn't available without a live feed, so real items arrive
// without `suggest` and are matched manually.

const seedRules: Rule[] = [
  {
    id: "R1",
    source: "HDFC XXXX8821",
    direction: "credit",
    docType: "invoice",
    minConfidence: 92,
    autoPost: false,
    enabled: true,
  },
  {
    id: "R2",
    source: "HDFC XXXX8821",
    direction: "debit",
    docType: "bill",
    minConfidence: 95,
    autoPost: true,
    enabled: true,
  },
  {
    id: "R3",
    source: "GPay monarch@okhdfc",
    direction: "both",
    docType: "auto",
    minConfidence: 90,
    autoPost: false,
    enabled: true,
  },
  {
    id: "R4",
    source: "ICICI XXXX4432",
    direction: "both",
    docType: "auto",
    minConfidence: 90,
    autoPost: false,
    enabled: true,
  },
  {
    id: "R5",
    source: "HDFC EEFC USD 9910",
    direction: "both",
    docType: "auto",
    minConfidence: 92,
    autoPost: false,
    enabled: true,
  },
];

function bankAccountOf(src: string) {
  if (src.startsWith("HDFC EEFC")) return "HDFC EEFC USD 9910";
  if (src.startsWith("ICICI EEFC")) return "ICICI EEFC EUR 3311";
  return src.startsWith("HDFC")
    ? "HDFC Current 8821"
    : src.startsWith("ICICI")
      ? "ICICI Current 4432"
      : "UPI Clearing";
}

function buildDraft(b: BankItem, allocs: Allocation[]): Draft {
  const bankAcc = bankAccountOf(b.source);
  const lines: Draft["lines"] = [];

  // FX carrying value: sum of (docAmount × fxAtDoc) across allocations that have FX metadata.
  // For rows without FX metadata, fall back to their INR amount (rate = 1).
  const carrying = allocs.reduce((s, a) => {
    if (a.docCurrency && a.docAmount && a.fxAtDoc) return s + a.docAmount * a.fxAtDoc;
    return s + a.amount;
  }, 0);
  const settled = b.amount; // INR actually hitting/leaving the bank
  // For a credit (receipt): if we receive more INR than the AR carrying value → FX gain.
  // For a debit (payment): if we pay more INR than the AP carrying value → FX loss.
  const gainSigned = b.type === "credit" ? settled - carrying : carrying - settled;
  const fxAbs = Math.abs(Math.round(gainSigned));
  const hasFx = allocs.some((a) => a.docCurrency) && fxAbs > 0;

  if (b.type === "credit") {
    lines.push({ account: bankAcc, code: "1110", debit: settled, credit: 0 });
    for (const a of allocs) {
      const arVal =
        a.docCurrency && a.docAmount && a.fxAtDoc ? Math.round(a.docAmount * a.fxAtDoc) : a.amount;
      const label = a.docCurrency
        ? `Accounts Receivable — ${a.party} (${a.docCurrency} ${a.docAmount?.toLocaleString()} @ ${a.fxAtDoc})`
        : `Accounts Receivable — ${a.party}`;
      lines.push({ account: label, code: "1120", debit: 0, credit: arVal });
    }
    if (hasFx) {
      if (gainSigned > 0)
        lines.push({ account: "FX Gain (Realized)", code: "4900", debit: 0, credit: fxAbs });
      else lines.push({ account: "FX Loss (Realized)", code: "5900", debit: fxAbs, credit: 0 });
    }
  } else {
    for (const a of allocs) {
      const apCarry =
        a.docCurrency && a.docAmount && a.fxAtDoc ? Math.round(a.docAmount * a.fxAtDoc) : a.amount;
      if (a.docCurrency) {
        // Foreign bills: no domestic GST split — post AP at carrying value
        lines.push({
          account: `Accounts Payable — ${a.party} (${a.docCurrency} ${a.docAmount?.toLocaleString()} @ ${a.fxAtDoc})`,
          code: "2100",
          debit: apCarry,
          credit: 0,
        });
      } else {
        const base = Math.round(a.amount / 1.18);
        const gst = a.amount - base;
        lines.push({
          account: `Accounts Payable — ${a.party}`,
          code: "2100",
          debit: base,
          credit: 0,
        });
        lines.push({ account: "GST Input Credit", code: "1140", debit: gst, credit: 0 });
      }
    }
    if (hasFx) {
      if (gainSigned > 0)
        lines.push({ account: "FX Gain (Realized)", code: "4900", debit: 0, credit: fxAbs });
      else lines.push({ account: "FX Loss (Realized)", code: "5900", debit: fxAbs, credit: 0 });
    }
    lines.push({ account: bankAcc, code: "1110", debit: 0, credit: settled });
  }

  const fxMeta = hasFx
    ? (() => {
        const fxAlloc = allocs.find((a) => a.docCurrency)!;
        return {
          currency: fxAlloc.docCurrency!,
          fxAtDoc: fxAlloc.fxAtDoc!,
          fxAtSettle: fxAlloc.fxAtSettle ?? b.fxAtSettle ?? 0,
          gain: Math.round(gainSigned),
        };
      })()
    : undefined;

  return {
    id: `JE-D-${b.id}`,
    bankId: b.id,
    date: b.date,
    memo:
      allocs.length > 1
        ? `${b.type === "credit" ? "Receipt from" : "Payment to"} ${allocs[0].party} — split across ${allocs.length} docs`
        : `${b.type === "credit" ? "Receipt from" : "Payment to"} ${allocs[0].party} against ${allocs[0].docId}${fxMeta ? ` · FX @ ${fxMeta.fxAtSettle}` : ""}`,
    ref: allocs.map((a) => a.docId).join(", "),
    status: "draft",
    source: b.desc,
    amount: b.amount,
    allocations: allocs,
    lines,
    fx: fxMeta,
  };
}

function nowStamp() {
  return new Date().toLocaleTimeString("en-IN", { hour12: false });
}

function downloadCSV(name: string, rows: (string | number)[][]) {
  const csv = rows
    .map((r) =>
      r
        .map((c) => {
          const s = String(c ?? "");
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Reconcile() {
  const { meta } = useRole();
  const canApprove = meta.id === "ceo";
  const { txns, invoices: invRows, bills: billRows, accounts } = Route.useLoaderData();

  // Real unreconciled bank/UPI transactions → the BankItem shape this workspace
  // drives its feed from. No AI `suggest` metadata without a live feed.
  const [items, setItems] = useState<BankItem[]>(() => {
    const nameById = new Map(accounts.map((a) => [a.id, `${a.name} ${a.accountNumberMasked}`]));
    return txns.map((t) => {
      const val = Number(t.amount);
      return {
        id: t.id,
        date: t.transactionDate,
        desc: t.description,
        source: nameById.get(t.bankAccountId) ?? "Bank",
        kind: "bank" as const,
        amount: Math.abs(val) / 100,
        type: (val < 0 ? "debit" : "credit") as "credit" | "debit",
      };
    });
  });

  // Real open invoices / bills, mapped to the shape the matching UI expects
  // (amounts in rupees). Fully-settled docs drop out of the open pools.
  const loaderInvoices = useMemo(
    () =>
      invRows.map((i) => ({
        id: i.invoiceNumber,
        customer: i.customerName,
        date: i.invoiceDate,
        amount: Number(i.total) / 100,
        balance: Number(i.balance) / 100,
        status: i.status,
      })),
    [invRows],
  );
  const loaderBills = useMemo(
    () =>
      billRows.map((b) => ({
        id: b.billNumber,
        vendor: b.vendorName,
        date: b.billDate,
        amount: Number(b.balance) / 100,
        status: Number(b.balance) === 0 ? "Paid" : "Open",
      })),
    [billRows],
  );

  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [posted, setPosted] = useState<Draft[]>([]);
  const [q, setQ] = useState("");
  const [manual, setManual] = useState<BankItem | null>(null);
  const [manualQ, setManualQ] = useState("");
  const [split, setSplit] = useState<BankItem | null>(null);
  const [splitRows, setSplitRows] = useState<Allocation[]>([]);
  const [rules, setRules] = useState<Rule[]>(seedRules);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [range, setRange] = useState({ from: "2026-07-01", to: "2026-07-31" });
  const [audit, setAudit] = useState<AuditEvent[]>([
    {
      ts: nowStamp(),
      actor: "System",
      action: "auto-match",
      detail: "Loaded unreconciled bank/UPI transactions from feed",
    },
  ]);
  // per-invoice/bill mutable payment tracking
  const [invoicePaid, setInvoicePaid] = useState<Record<string, number>>({});
  const [billPaid, setBillPaid] = useState<Record<string, number>>({});
  // approval workflow dialogs
  const [decisionOn, setDecisionOn] = useState<{ draft: Draft; kind: "approve" | "reject" } | null>(
    null,
  );
  const [decisionNote, setDecisionNote] = useState("");
  // draft list filters + saved views
  const [draftFilters, setDraftFilters] = useState<{
    statuses: DraftStatus[];
    submitter: string;
    from: string;
    to: string;
  }>({
    statuses: ["draft", "pending", "approved", "rejected"],
    submitter: "",
    from: "",
    to: "",
  });
  const [savedViews, setSavedViews] = useState<SavedView[]>([
    {
      id: "sv-1",
      name: "My pending approvals",
      statuses: ["pending"],
      submitter: "",
      from: "",
      to: "",
    },
    {
      id: "sv-2",
      name: "Rejected this week",
      statuses: ["rejected"],
      submitter: "",
      from: "2026-07-13",
      to: "2026-07-19",
    },
    { id: "sv-3", name: "Ready to post", statuses: ["approved"], submitter: "", from: "", to: "" },
  ]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  // notifications + SLA
  const [notifications, setNotifications] = useState<Notification[]>([
    {
      id: "N-0",
      ts: nowStamp(),
      kind: "reminder",
      title: "Welcome",
      body: "Reconciliation notification center is live. Submissions & SLA alerts appear here.",
      channel: ["in-app"],
      toRole: "all",
      read: true,
    },
  ]);
  const [notifOpen, setNotifOpen] = useState(false);
  const [slaHours, setSlaHours] = useState(4);
  // edit / revision workflow
  const [editingDraft, setEditingDraft] = useState<Draft | null>(null);
  const [editMemo, setEditMemo] = useState("");
  const [editRef, setEditRef] = useState("");

  const logAudit = (e: Omit<AuditEvent, "ts" | "actor">) =>
    setAudit((a) => [{ ts: nowStamp(), actor: meta.name + ` (${meta.label})`, ...e }, ...a]);

  const pushNotification = (n: Omit<Notification, "id" | "ts" | "read">) => {
    const notif: Notification = {
      id: `N-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ts: nowStamp(),
      read: false,
      ...n,
    };
    setNotifications((ns) => [notif, ...ns]);
    if (n.channel.includes("email")) {
      toast(`📧 Email sent · ${n.title}`, {
        description: `To: ${n.toRole === "ceo" ? "ceo@monarc.io" : n.toRole === "accountant" ? "accounts@monarc.io" : "team@monarc.io"}`,
      });
    }
  };

  const openInvoices = useMemo(
    () =>
      loaderInvoices
        .map((i) => ({ ...i, remaining: Math.max(0, i.balance - (invoicePaid[i.id] || 0)) }))
        .filter((i) => i.remaining > 0),
    [loaderInvoices, invoicePaid],
  );
  const openBills = useMemo(
    () =>
      loaderBills
        .map((b) => ({
          ...b,
          paid: billPaid[b.id] || 0,
          remaining: Math.max(0, b.amount - (billPaid[b.id] || 0)),
        }))
        .filter((b) => b.status !== "Paid" && b.remaining > 0),
    [loaderBills, billPaid],
  );

  const filtered = useMemo(
    () => items.filter((t) => q === "" || t.desc.toLowerCase().includes(q.toLowerCase())),
    [items, q],
  );
  const unmatched = items.filter((i) => !i.matched);
  const matchedCount = items.length - unmatched.length;
  const progress = items.length ? (matchedCount / items.length) * 100 : 0;
  const totalDraftAmt = drafts.reduce((s, d) => s + d.amount, 0);

  const submitters = useMemo(
    () =>
      Array.from(new Set(drafts.map((d) => d.approval?.submittedBy).filter(Boolean) as string[])),
    [drafts],
  );
  const filteredDrafts = useMemo(
    () =>
      drafts.filter((d) => {
        if (draftFilters.statuses.length && !draftFilters.statuses.includes(d.status)) return false;
        if (draftFilters.submitter && d.approval?.submittedBy !== draftFilters.submitter)
          return false;
        if (draftFilters.from && d.date < draftFilters.from) return false;
        if (draftFilters.to && d.date > draftFilters.to) return false;
        return true;
      }),
    [drafts, draftFilters],
  );
  const unreadNotifs = notifications.filter((n) => !n.read).length;
  const overdueCount = drafts.filter(
    (d) =>
      d.status === "pending" &&
      d.approval?.submittedTs &&
      (Date.now() - d.approval.submittedTs) / 3_600_000 >= slaHours,
  ).length;

  const applyPayment = (allocs: Allocation[], sign: 1 | -1) => {
    setInvoicePaid((p) => {
      const n = { ...p };
      for (const a of allocs)
        if (a.docType === "invoice") n[a.docId] = (n[a.docId] || 0) + sign * a.amount;
      return n;
    });
    setBillPaid((p) => {
      const n = { ...p };
      for (const a of allocs)
        if (a.docType === "bill") n[a.docId] = (n[a.docId] || 0) + sign * a.amount;
      return n;
    });
  };

  const confirmMatch = (b: BankItem, allocs: Allocation[]) => {
    setItems((its) =>
      its.map((x) => (x.id === b.id ? { ...x, matched: allocs, suggest: undefined } : x)),
    );
    setDrafts((d) => [buildDraft(b, allocs), ...d]);
    applyPayment(allocs, 1);
    logAudit({
      action: allocs.length > 1 ? "split" : "match",
      detail: `${b.id} → ${allocs.map((a) => `${a.docId} (${inr(a.amount)})`).join(" + ")}`,
      bankId: b.id,
      journalId: `JE-D-${b.id}`,
    });
    toast.success(
      allocs.length > 1
        ? `Split ${b.id} across ${allocs.length} documents · multi-line journal drafted`
        : `Matched ${b.id} → ${allocs[0].docId} · draft journal created`,
    );
  };

  const autoMatchAll = () => {
    const enabledRules = rules.filter((r) => r.enabled);
    const eligible = items.filter((i) => {
      if (i.matched || !i.suggest) return false;
      const rule = enabledRules.find(
        (r) => r.source === i.source && (r.direction === "both" || r.direction === i.type),
      );
      const threshold = rule?.minConfidence ?? 90;
      const docOk = !rule || rule.docType === "auto" || rule.docType === i.suggest.docType;
      return i.suggest.confidence >= threshold && docOk;
    });
    if (!eligible.length) {
      toast("No transactions meet current rule thresholds");
      return;
    }
    const allocOf = (b: BankItem): Allocation => ({
      docId: b.suggest!.docId,
      docType: b.suggest!.docType,
      party: b.suggest!.party,
      amount: b.amount,
      docCurrency: b.suggest!.docCurrency,
      docAmount: b.suggest!.docAmount,
      fxAtDoc: b.suggest!.fxAtDoc,
      fxAtSettle: b.fxAtSettle,
    });
    setItems((its) =>
      its.map((x) => {
        if (!eligible.find((e) => e.id === x.id) || !x.suggest) return x;
        return { ...x, matched: [allocOf(x)], suggest: undefined };
      }),
    );
    const newDrafts = eligible.map((b) => buildDraft(b, [allocOf(b)]));
    setDrafts((d) => [...newDrafts, ...d]);
    for (const b of eligible) applyPayment([allocOf(b)], 1);
    logAudit({
      action: "auto-match",
      detail: `Rule engine matched ${eligible.length} txns using ${enabledRules.length} active rules`,
    });
    toast.success(
      `AI matched ${eligible.length} transactions via ${enabledRules.length} active rules`,
    );
  };

  const nowIso = () => new Date().toLocaleString("en-IN", { hour12: false });

  const submitForApproval = (ids?: string[]) => {
    const target = ids
      ? drafts.filter((d) => ids.includes(d.id))
      : drafts.filter((d) => d.status === "draft" || d.status === "rejected");
    if (!target.length) {
      toast("No drafts eligible for submission");
      return;
    }
    const ts = Date.now();
    setDrafts((ds) =>
      ds.map((d) =>
        target.find((t) => t.id === d.id)
          ? {
              ...d,
              status: "pending",
              approval: {
                ...(d.approval || {}),
                submittedBy: meta.name,
                submittedAt: nowIso(),
                submittedTs: ts,
                approver: undefined,
                decidedAt: undefined,
                note: undefined,
              },
            }
          : d,
      ),
    );
    for (const d of target) {
      logAudit({
        action: "submit",
        detail: `${d.id} submitted for approval · ${inr(d.amount)}`,
        journalId: d.id,
        bankId: d.bankId,
      });
      pushNotification({
        kind: "submitted",
        toRole: "ceo",
        channel: ["email", "in-app"],
        title: `Approval requested · ${d.id}`,
        body: `${meta.name} submitted ${d.id} (${inr(d.amount)}) for approval. SLA: ${slaHours}h.`,
        journalId: d.id,
      });
    }
    toast.success(
      `${target.length} draft${target.length > 1 ? "s" : ""} submitted · CEO notified by email + in-app`,
    );
  };

  const recallDraft = (id: string) => {
    setDrafts((ds) =>
      ds.map((d) =>
        d.id === id && d.status === "pending"
          ? { ...d, status: "draft", approval: { ...(d.approval || {}), submittedAt: undefined } }
          : d,
      ),
    );
    logAudit({ action: "recall", detail: `${id} recalled from approval queue`, journalId: id });
    toast(`${id} recalled — edit and re-submit`);
  };

  const decideDraft = (draft: Draft, kind: "approve" | "reject", note: string) => {
    setDrafts((ds) =>
      ds.map((d) =>
        d.id === draft.id
          ? {
              ...d,
              status: kind === "approve" ? "approved" : "rejected",
              approval: {
                ...(d.approval || {}),
                approver: meta.name,
                decidedAt: nowIso(),
                note: note || undefined,
              },
            }
          : d,
      ),
    );
    logAudit({
      action: kind,
      detail: `${draft.id} ${kind === "approve" ? "approved" : "rejected"} by ${meta.name}${note ? ` — "${note}"` : ""}`,
      journalId: draft.id,
      bankId: draft.bankId,
    });
    pushNotification({
      kind: kind === "approve" ? "approved" : "rejected",
      toRole: "accountant",
      channel: ["email", "in-app"],
      title: `${draft.id} ${kind === "approve" ? "approved" : "rejected"}`,
      body: `${meta.name} ${kind === "approve" ? "approved" : "rejected"} ${draft.id} (${inr(draft.amount)})${note ? ` — "${note}"` : ""}.`,
      journalId: draft.id,
    });
    toast.success(
      kind === "approve"
        ? `${draft.id} approved — accountant notified`
        : `${draft.id} rejected — accountant notified with reason`,
    );
  };

  const approveAllPending = () => {
    const pend = drafts.filter((d) => d.status === "pending");
    if (!pend.length) {
      toast("No pending drafts");
      return;
    }
    setDrafts((ds) =>
      ds.map((d) =>
        d.status === "pending"
          ? {
              ...d,
              status: "approved",
              approval: { ...(d.approval || {}), approver: meta.name, decidedAt: nowIso() },
            }
          : d,
      ),
    );
    for (const d of pend) {
      logAudit({
        action: "approve",
        detail: `${d.id} bulk-approved`,
        journalId: d.id,
        bankId: d.bankId,
      });
      pushNotification({
        kind: "approved",
        toRole: "accountant",
        channel: ["in-app"],
        title: `${d.id} approved`,
        body: `Bulk approval by ${meta.name}`,
        journalId: d.id,
      });
    }
    toast.success(`${pend.length} draft${pend.length > 1 ? "s" : ""} approved`);
  };

  const reviseDraft = (draftId: string, memo: string, ref: string) => {
    const d = drafts.find((x) => x.id === draftId);
    if (!d) return;
    const wasApproved = d.status === "approved";
    setDrafts((ds) =>
      ds.map((x) =>
        x.id === draftId
          ? {
              ...x,
              memo,
              ref,
              status: wasApproved ? "pending" : x.status,
              revision: (x.revision || 0) + 1,
              revisedFrom: wasApproved ? "approved" : x.revisedFrom,
              approval: wasApproved
                ? {
                    ...(x.approval || {}),
                    submittedBy: meta.name,
                    submittedAt: nowIso(),
                    submittedTs: Date.now(),
                    approver: undefined,
                    decidedAt: undefined,
                    note: `Re-submitted after revision (was approved)`,
                  }
                : x.approval,
            }
          : x,
      ),
    );
    logAudit({
      action: "revise",
      detail: `${draftId} edited by ${meta.name}${wasApproved ? " — reverted to Pending re-approval" : ""}`,
      journalId: draftId,
    });
    if (wasApproved) {
      pushNotification({
        kind: "revised",
        toRole: "ceo",
        channel: ["email", "in-app"],
        title: `Re-approval needed · ${draftId}`,
        body: `${meta.name} modified an already-approved draft. It is back in your queue.`,
        journalId: draftId,
      });
      toast.success(`${draftId} revised — sent back to CEO for re-approval`);
    } else {
      toast.success(`${draftId} updated`);
    }
  };

  const sendReminder = (draftId: string, silent = false) => {
    const d = drafts.find((x) => x.id === draftId && x.status === "pending");
    if (!d) return;
    logAudit({
      action: "reminder",
      detail: `SLA reminder sent for ${draftId}`,
      journalId: draftId,
    });
    pushNotification({
      kind: "reminder",
      toRole: "ceo",
      channel: ["email", "in-app"],
      title: `⏰ Reminder · ${draftId} awaiting approval`,
      body: `Pending ${slaHoursOverdue(d)}h — over ${slaHours}h SLA. Submitted by ${d.approval?.submittedBy}.`,
      journalId: draftId,
    });
    if (!silent) toast(`Reminder sent for ${draftId}`);
  };

  const sendAllOverdueReminders = () => {
    const overdueList = drafts.filter(
      (d) => d.status === "pending" && slaHoursOverdue(d) >= slaHours,
    );
    if (!overdueList.length) {
      toast("No overdue pending drafts");
      return;
    }
    overdueList.forEach((d) => sendReminder(d.id, true));
    toast.success(
      `${overdueList.length} SLA reminder${overdueList.length > 1 ? "s" : ""} sent to CEO`,
    );
  };

  const slaHoursOverdue = (d: Draft) => {
    if (!d.approval?.submittedTs) return 0;
    return Math.max(0, (Date.now() - d.approval.submittedTs) / 3_600_000);
  };
  const isOverdue = (d: Draft) => d.status === "pending" && slaHoursOverdue(d) >= slaHours;

  const applyView = (v: SavedView) => {
    setDraftFilters({ statuses: v.statuses, submitter: v.submitter, from: v.from, to: v.to });
    toast(`View applied · ${v.name}`);
  };
  const saveCurrentView = () => {
    const name = newViewName.trim();
    if (!name) return;
    const v: SavedView = { id: `sv-${Date.now()}`, name, ...draftFilters };
    setSavedViews((s) => [v, ...s]);
    setNewViewName("");
    toast.success(`Saved view · ${name}`);
  };

  const postAll = () => {
    const approved = drafts.filter((d) => d.status === "approved");
    if (!approved.length) {
      const stuck = drafts.length;
      toast(
        stuck
          ? `${stuck} draft${stuck > 1 ? "s" : ""} awaiting approval — submit & approve first`
          : "No approved drafts to post",
      );
      return;
    }
    const toPost = approved.map((x) => ({ ...x, status: "posted" as const }));
    setPosted((p) => [...toPost, ...p]);
    for (const d of toPost)
      logAudit({
        action: "post",
        detail: `Drafted post for ${d.id} · ${inr(d.amount)} · approved by ${d.approval?.approver || "—"}`,
        journalId: d.id,
        bankId: d.bankId,
      });
    setDrafts((ds) => ds.filter((d) => d.status !== "approved"));
    // Honest: these journals are prepared locally. Actual posting to the general
    // ledger runs through the banking service, which needs a connected feed.
    toast.info(
      "Reconciliation entries are drafted locally — posting to the general ledger requires the connected banking service.",
    );
  };

  const unmatch = (id: string) => {
    const it = items.find((x) => x.id === id);
    if (it?.matched) applyPayment(it.matched, -1);
    setItems((its) => its.map((x) => (x.id === id ? { ...x, matched: undefined } : x)));
    setDrafts((d) => d.filter((x) => x.bankId !== id));
    logAudit({ action: "unmatch", detail: `Removed match on ${id}`, bankId: id });
    toast("Match removed · draft cleared");
  };

  const rollbackPosted = (jid: string) => {
    const j = posted.find((p) => p.id === jid);
    if (!j) return;
    setPosted((p) => p.filter((x) => x.id !== jid));
    setDrafts((d) => [{ ...j, status: "draft" }, ...d]);
    logAudit({
      action: "rollback",
      detail: `Reverted ${jid} to Draft — payment allocations restored for review`,
      journalId: jid,
      bankId: j.bankId,
    });
    toast.success(`${jid} rolled back to Draft — re-match if needed`);
  };

  const openSplit = (b: BankItem) => {
    setSplit(b);
    const pool = b.type === "credit" ? openInvoices : openBills;
    const seed = pool.slice(0, 2).map((p) => ({
      docId: p.id,
      docType: b.type === "credit" ? ("invoice" as const) : ("bill" as const),
      party: "customer" in p ? p.customer : p.vendor,
      amount: 0,
    }));
    setSplitRows(
      seed.length
        ? seed
        : [{ docId: "", docType: b.type === "credit" ? "invoice" : "bill", party: "", amount: 0 }],
    );
  };

  const splitTotal = splitRows.reduce((s, r) => s + (r.amount || 0), 0);
  const splitDiff = split ? split.amount - splitTotal : 0;

  const manualCandidates = (b: BankItem) => {
    const pool =
      b.type === "credit"
        ? openInvoices.map((i) => ({
            docId: i.id,
            docType: "invoice" as const,
            party: i.customer,
            amount: i.remaining,
            date: i.date,
          }))
        : openBills.map((i) => ({
            docId: i.id,
            docType: "bill" as const,
            party: i.vendor,
            amount: i.remaining,
            date: i.date,
          }));
    return pool
      .filter(
        (p) =>
          manualQ === "" ||
          p.party.toLowerCase().includes(manualQ.toLowerCase()) ||
          p.docId.toLowerCase().includes(manualQ.toLowerCase()),
      )
      .map((p) => ({ ...p, diff: Math.abs(p.amount - b.amount) }))
      .sort((a, b) => a.diff - b.diff)
      .slice(0, 8);
  };

  // ==== Export report ====
  const inRange = (d: string) => d >= range.from && d <= range.to;
  const reportStats = useMemo(() => {
    const scoped = items.filter((i) => inRange(i.date));
    const matched = scoped.filter((i) => i.matched);
    const unmatchedS = scoped.filter((i) => !i.matched);
    const bankTotal = scoped.reduce((s, i) => s + (i.type === "credit" ? i.amount : -i.amount), 0);
    const bookTotal = matched.reduce((s, i) => s + (i.type === "credit" ? i.amount : -i.amount), 0);
    const draftScoped = drafts.filter((d) => inRange(d.date));
    const postedScoped = posted.filter((d) => inRange(d.date));
    return {
      scoped,
      matched,
      unmatched: unmatchedS,
      variance: bankTotal - bookTotal,
      bankTotal,
      bookTotal,
      drafts: draftScoped,
      posted: postedScoped,
    };
  }, [items, drafts, posted, range]);

  const fxSummary = useMemo(() => {
    const all = [...reportStats.drafts, ...reportStats.posted].filter((d) => d.fx);
    const gain = all.filter((d) => d.fx!.gain > 0).reduce((s, d) => s + d.fx!.gain, 0);
    const loss = all.filter((d) => d.fx!.gain < 0).reduce((s, d) => s + Math.abs(d.fx!.gain), 0);
    return { entries: all, gain, loss, net: gain - loss };
  }, [reportStats.drafts, reportStats.posted]);

  const exportCSV = () => {
    const fxTxn = (t: BankItem) =>
      t.currency ? `${t.currency} ${t.fxAmount?.toLocaleString() ?? ""}` : "";
    const fxRates = (t: BankItem) =>
      t.suggest?.fxAtDoc && t.fxAtSettle
        ? `doc ${t.suggest.fxAtDoc} → settle ${t.fxAtSettle}`
        : t.matched?.[0]?.fxAtDoc && t.matched[0].fxAtSettle
          ? `doc ${t.matched[0].fxAtDoc} → settle ${t.matched[0].fxAtSettle}`
          : "";
    const drAll = [...reportStats.drafts, ...reportStats.posted];
    const rows: (string | number)[][] = [
      ["Monarch ERP — Reconciliation Report"],
      ["Range", range.from, "to", range.to],
      ["Generated", new Date().toLocaleString("en-IN")],
      [],
      ["Summary"],
      ["Total transactions", reportStats.scoped.length],
      ["Matched", reportStats.matched.length],
      ["Unmatched", reportStats.unmatched.length],
      ["Bank net (₹)", reportStats.bankTotal],
      ["Book net (₹)", reportStats.bookTotal],
      ["Variance (₹)", reportStats.variance],
      ["Draft journals", reportStats.drafts.length],
      ["Posted journals", reportStats.posted.length],
      [],
      ["FX Gain/Loss Summary"],
      ["Realized FX gain (₹)", fxSummary.gain],
      ["Realized FX loss (₹)", fxSummary.loss],
      ["Net FX P&L (₹)", fxSummary.net],
      ["FX-linked journals", fxSummary.entries.length],
      [],
      ["FX Journals — per journal breakdown"],
      [
        "Journal",
        "Status",
        "Currency",
        "FX Amount",
        "Rate @ Doc",
        "Rate @ Settle",
        "Carrying value (₹)",
        "Settled INR",
        "Realized Gain/Loss (₹)",
        "Direction",
      ],
      ...fxSummary.entries.map((d) => {
        const a = d.allocations.find((x) => x.docCurrency)!;
        const carrying = Math.round((a.docAmount || 0) * (a.fxAtDoc || 0));
        return [
          d.id,
          d.status,
          d.fx!.currency,
          a.docAmount || 0,
          d.fx!.fxAtDoc,
          d.fx!.fxAtSettle,
          carrying,
          d.amount,
          d.fx!.gain,
          d.fx!.gain >= 0 ? "Gain" : "Loss",
        ];
      }),
      [],
      ["Transactions"],
      [
        "Bank ID",
        "Date",
        "Source",
        "Type",
        "Amount (₹)",
        "Currency",
        "FX Amount",
        "FX Rates",
        "Description",
        "Status",
        "Matched to",
      ],
      ...reportStats.scoped.map((t) => [
        t.id,
        t.date,
        t.source,
        t.type,
        t.amount,
        t.currency || "INR",
        t.fxAmount || "",
        fxRates(t),
        t.desc,
        t.matched ? "Matched" : "Unmatched",
        t.matched ? t.matched.map((a) => `${a.docId} (${a.amount})`).join(" | ") : "",
      ]),
      [],
      ["Draft & Posted Journals — header"],
      [
        "Journal",
        "Status",
        "Date",
        "Bank Ref",
        "Amount",
        "Allocations",
        "Currency",
        "Rate@Doc",
        "Rate@Settle",
        "FX Gain/Loss (₹)",
        "Submitted by",
        "Approved by",
        "Revision",
        "Memo",
      ],
      ...drAll.map((d) => [
        d.id,
        d.status,
        d.date,
        d.bankId,
        d.amount,
        d.allocations.length,
        d.fx?.currency || "INR",
        d.fx?.fxAtDoc || "",
        d.fx?.fxAtSettle || "",
        d.fx?.gain ?? 0,
        d.approval?.submittedBy || "",
        d.approval?.approver || "",
        d.revision || 0,
        d.memo,
      ]),
      [],
      ["Journal lines — full breakdown"],
      [
        "Journal",
        "Status",
        "Line #",
        "Code",
        "Account",
        "Debit (₹)",
        "Credit (₹)",
        "FX-linked",
        "Doc Currency",
        "Doc Amount",
        "Rate @ Doc",
      ],
      ...drAll.flatMap((d) =>
        d.lines.map((l, i) => {
          const alloc = d.allocations.find((a) => a.docCurrency && l.account.includes(a.party));
          const fxLinked = /FX (Gain|Loss)/.test(l.account) || !!alloc;
          return [
            d.id,
            d.status,
            i + 1,
            l.code,
            l.account,
            l.debit,
            l.credit,
            fxLinked ? "yes" : "no",
            alloc?.docCurrency || (/FX (Gain|Loss)/.test(l.account) ? d.fx?.currency || "" : ""),
            alloc?.docAmount || "",
            alloc?.fxAtDoc || (/FX (Gain|Loss)/.test(l.account) ? d.fx?.fxAtDoc || "" : ""),
          ];
        }),
      ),
    ];
    downloadCSV(`reconciliation_${range.from}_${range.to}.csv`, rows);
    logAudit({ action: "export", detail: `CSV export · ${range.from} → ${range.to} · FX incl.` });
    toast.success("Report downloaded · FX breakdown included");
  };

  const exportPDF = () => {
    logAudit({ action: "export", detail: `PDF export · ${range.from} → ${range.to}` });
    setTimeout(() => window.print(), 200);
  };

  return (
    <>
      <PageHeader
        title="Reconciliation"
        subtitle="Match bank & UPI transactions to invoices/bills — AI drafts journals, syncs balances"
      />
      <div className="p-6 space-y-5">
        {/* Honest banner — real data in, drafts stay local until a feed is wired */}
        <Card className="p-3 border-amber-500/30 bg-amber-500/5 flex items-start gap-2.5">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground">
            Reconciliation workspace — matches are drafted locally; posting requires a connected
            bank feed.
          </p>
        </Card>

        {/* Progress + KPIs */}
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-xl bg-gradient-brand flex items-center justify-center">
                <ArrowLeftRight className="h-5 w-5 text-white" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Reconciliation progress</p>
                <p className="text-lg font-semibold">
                  {matchedCount} of {items.length} matched
                </p>
              </div>
            </div>
            <div className="flex-1 min-w-[240px]">
              <Progress value={progress} className="h-2" />
              <p className="text-[10px] text-muted-foreground mt-1">
                Book vs bank variance:{" "}
                <span
                  className={
                    Math.abs(reportStats.variance) < 1
                      ? "text-emerald-600 font-medium"
                      : "text-amber-600 font-medium"
                  }
                >
                  {Math.abs(reportStats.variance) < 1
                    ? "In sync ₹0"
                    : `${inr(reportStats.variance)} open`}
                </span>
              </p>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Drafts</p>
                <p className="text-xl font-semibold tabular-nums">
                  {drafts.filter((d) => d.status === "draft" || d.status === "rejected").length}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Pending approval
                </p>
                <p className="text-xl font-semibold tabular-nums text-amber-600">
                  {drafts.filter((d) => d.status === "pending").length}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Approved
                </p>
                <p className="text-xl font-semibold tabular-nums text-primary">
                  {drafts.filter((d) => d.status === "approved").length}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Posted</p>
                <p className="text-xl font-semibold tabular-nums text-emerald-600">
                  {posted.length}
                </p>
              </div>
            </div>
          </div>
          <Separator className="my-4" />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={autoMatchAll}>
              <Wand2 className="h-3.5 w-3.5 mr-1.5" /> Run auto-match rules
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRulesOpen(true)}>
              <Settings2 className="h-3.5 w-3.5 mr-1.5" /> Match rules
              <Badge variant="secondary" className="ml-1.5 text-[9px]">
                {rules.filter((r) => r.enabled).length}
              </Badge>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAuditOpen(true)}>
              <History className="h-3.5 w-3.5 mr-1.5" /> Audit trail
              <Badge variant="secondary" className="ml-1.5 text-[9px]">
                {audit.length}
              </Badge>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
              <Download className="h-3.5 w-3.5 mr-1.5" /> Export report
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNotifOpen(true)}
              className="relative"
            >
              <Bell className="h-3.5 w-3.5 mr-1.5" /> Notifications
              {unreadNotifs > 0 && (
                <Badge className="ml-1.5 h-4 min-w-4 px-1 text-[9px] bg-destructive text-destructive-foreground">
                  {unreadNotifs}
                </Badge>
              )}
            </Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={overdueCount > 0 ? "border-destructive/40 text-destructive" : ""}
                >
                  <Timer className="h-3.5 w-3.5 mr-1.5" /> SLA {slaHours}h
                  {overdueCount > 0 && (
                    <Badge className="ml-1.5 h-4 min-w-4 px-1 text-[9px] bg-destructive text-destructive-foreground">
                      {overdueCount}
                    </Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-3" align="end">
                <p className="text-xs font-semibold mb-2">Approval SLA</p>
                <p className="text-[10px] text-muted-foreground mb-2">
                  Pending drafts breach after this many hours.
                </p>
                <div className="flex gap-1">
                  {[1, 4, 8, 24].map((h) => (
                    <Button
                      key={h}
                      size="sm"
                      variant={slaHours === h ? "default" : "outline"}
                      className="h-7 flex-1 text-[10px]"
                      onClick={() => setSlaHours(h)}
                    >
                      {h}h
                    </Button>
                  ))}
                </div>
                {overdueCount > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full mt-2 h-7 text-[10px] border-destructive/30 text-destructive"
                    onClick={() => sendAllOverdueReminders()}
                  >
                    <BellRing className="h-3 w-3 mr-1" />
                    Remind CEO on {overdueCount} overdue
                  </Button>
                )}
              </PopoverContent>
            </Popover>
            <div className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => submitForApproval()}
              disabled={
                drafts.filter((d) => d.status === "draft" || d.status === "rejected").length === 0
              }
            >
              <MailCheck className="h-3.5 w-3.5 mr-1.5" /> Submit{" "}
              {drafts.filter((d) => d.status === "draft" || d.status === "rejected").length} for
              approval
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={approveAllPending}
              disabled={!canApprove || drafts.filter((d) => d.status === "pending").length === 0}
              title={canApprove ? "" : "Only CEO can approve — switch role"}
            >
              <UserCheck className="h-3.5 w-3.5 mr-1.5" /> Approve all pending
            </Button>
            <Button
              className="bg-gradient-brand text-white"
              size="sm"
              onClick={postAll}
              disabled={drafts.filter((d) => d.status === "approved").length === 0}
            >
              <Send className="h-3.5 w-3.5 mr-1.5" /> Post{" "}
              {drafts.filter((d) => d.status === "approved").length} approved to ledger
            </Button>
          </div>
        </Card>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* Left: bank feed */}
          <Card className="xl:col-span-2 p-0 overflow-hidden">
            <div className="p-4 border-b flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-primary" />
                  Bank & UPI feed
                </h3>
                <p className="text-[11px] text-muted-foreground">
                  Confirm AI suggestions, split across docs, or match manually
                </p>
              </div>
              <div className="relative w-56">
                <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search…"
                  className="pl-8 h-8 text-xs"
                />
              </div>
            </div>
            <div className="divide-y max-h-[640px] overflow-auto">
              {filtered.map((b) => (
                <div key={b.id} className="p-4 hover:bg-muted/30 transition-colors">
                  <div className="flex items-start gap-3">
                    <div
                      className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${b.type === "credit" ? "bg-emerald-500/10 text-emerald-600" : "bg-destructive/10 text-destructive"}`}
                    >
                      {b.type === "credit" ? (
                        <ArrowDownLeft className="h-4 w-4" />
                      ) : (
                        <ArrowUpRight className="h-4 w-4" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium truncate">{b.desc}</p>
                        <p
                          className={`text-sm font-semibold tabular-nums shrink-0 ${b.type === "credit" ? "text-emerald-600" : "text-destructive"}`}
                        >
                          {b.type === "credit" ? "+" : "−"}
                          {inr(b.amount)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
                        {b.kind === "bank" ? (
                          <Building2 className="h-3 w-3" />
                        ) : (
                          <Smartphone className="h-3 w-3" />
                        )}
                        <span>{b.source}</span>
                        <span>·</span>
                        <span>{b.date}</span>
                        <span>·</span>
                        <span>{b.id}</span>
                      </div>

                      {b.matched && (
                        <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5">
                          <div className="flex items-center gap-2 mb-1.5">
                            <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                            <p className="text-xs font-medium">
                              {b.matched.length > 1
                                ? `Split across ${b.matched.length} documents`
                                : `Matched → ${b.matched[0].docId}`}
                            </p>
                            <Badge variant="outline" className="text-[9px] bg-white">
                              JE-D-{b.id}
                            </Badge>
                            <div className="flex-1" />
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 text-[10px]"
                              onClick={() => unmatch(b.id)}
                            >
                              Unmatch
                            </Button>
                          </div>
                          <div className="grid gap-1">
                            {b.matched.map((a, i) => (
                              <div
                                key={i}
                                className="flex items-center justify-between text-[11px]"
                              >
                                <span className="text-muted-foreground">
                                  {a.docType === "invoice" ? "→ Invoice" : "→ Bill"}{" "}
                                  <span className="text-foreground font-medium">{a.docId}</span> ·{" "}
                                  {a.party}
                                </span>
                                <span className="tabular-nums font-medium">{inr(a.amount)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {!b.matched && b.suggest && (
                        <div className="mt-2 rounded-lg border border-primary/30 bg-primary/5 p-2.5">
                          <div className="flex items-start gap-2">
                            <Sparkles className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                {b.suggest.docType === "invoice" ? (
                                  <FileText className="h-3 w-3 text-primary" />
                                ) : (
                                  <Receipt className="h-3 w-3 text-primary" />
                                )}
                                <p className="text-xs font-medium truncate">
                                  {b.suggest.docId} · {b.suggest.party}
                                </p>
                                <Badge variant="secondary" className="text-[9px]">
                                  {b.suggest.confidence}%
                                </Badge>
                              </div>
                              <p className="text-[10px] text-muted-foreground mt-0.5">
                                {b.suggest.reason}
                              </p>
                              {b.currency &&
                                b.suggest.docCurrency &&
                                b.suggest.fxAtDoc &&
                                b.fxAtSettle && (
                                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                    <Badge variant="outline" className="text-[9px] bg-white">
                                      {b.currency} {b.fxAmount?.toLocaleString()}
                                    </Badge>
                                    <Badge variant="outline" className="text-[9px] bg-white">
                                      Invoice @ ₹{b.suggest.fxAtDoc}
                                    </Badge>
                                    <Badge variant="outline" className="text-[9px] bg-white">
                                      Settle @ ₹{b.fxAtSettle}
                                    </Badge>
                                    {(() => {
                                      const g = Math.round(
                                        b.amount - b.suggest.docAmount! * b.suggest.fxAtDoc!,
                                      );
                                      const gain = b.type === "credit" ? g : -g;
                                      return (
                                        <Badge
                                          variant="outline"
                                          className={`text-[9px] ${gain >= 0 ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/20" : "bg-destructive/10 text-destructive border-destructive/20"}`}
                                        >
                                          FX {gain >= 0 ? "Gain" : "Loss"} {inr(Math.abs(gain))}
                                        </Badge>
                                      );
                                    })()}
                                  </div>
                                )}
                            </div>
                          </div>
                          <div className="flex gap-2 mt-2">
                            <Button
                              size="sm"
                              className="h-7 text-xs bg-gradient-brand text-white flex-1"
                              onClick={() =>
                                confirmMatch(b, [
                                  {
                                    docId: b.suggest!.docId,
                                    docType: b.suggest!.docType,
                                    party: b.suggest!.party,
                                    amount: b.amount,
                                    docCurrency: b.suggest!.docCurrency,
                                    docAmount: b.suggest!.docAmount,
                                    fxAtDoc: b.suggest!.fxAtDoc,
                                    fxAtSettle: b.fxAtSettle,
                                  },
                                ])
                              }
                            >
                              <Link2 className="h-3 w-3 mr-1" /> Confirm
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() => openSplit(b)}
                            >
                              <Split className="h-3 w-3 mr-1" /> Split
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() => {
                                setManual(b);
                                setManualQ("");
                              }}
                            >
                              Pick different
                            </Button>
                          </div>
                        </div>
                      )}

                      {!b.matched && !b.suggest && (
                        <div className="mt-2 rounded-lg border border-dashed border-destructive/30 bg-destructive/5 p-2 flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                          <p className="text-[11px] flex-1">
                            No candidate — match manually or split
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => openSplit(b)}
                          >
                            <Split className="h-3 w-3 mr-1" /> Split
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => {
                              setManual(b);
                              setManualQ("");
                            }}
                          >
                            <Filter className="h-3 w-3 mr-1" /> Find
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Right: drafts + posted */}
          <div className="space-y-4">
            <Card className="p-0 overflow-hidden">
              <div className="p-4 border-b space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      <BookOpen className="h-4 w-4 text-primary" />
                      Draft journals
                    </h3>
                    <p className="text-[11px] text-muted-foreground">
                      Review → submit → approve → post · re-approval required on edit
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Badge variant="outline" className="text-[9px]">
                      D{" "}
                      {drafts.filter((d) => d.status === "draft" || d.status === "rejected").length}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="text-[9px] bg-amber-500/10 text-amber-700 border-amber-500/20"
                    >
                      P {drafts.filter((d) => d.status === "pending").length}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="text-[9px] bg-primary/10 text-primary border-primary/20"
                    >
                      A {drafts.filter((d) => d.status === "approved").length}
                    </Badge>
                    {overdueCount > 0 && (
                      <Badge
                        variant="outline"
                        className="text-[9px] bg-destructive/10 text-destructive border-destructive/20"
                      >
                        <Timer className="h-2.5 w-2.5 mr-0.5" />
                        {overdueCount} overdue
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className="h-7 text-[10.5px]">
                        <Filter className="h-3 w-3 mr-1" />
                        Filters
                        <Badge variant="secondary" className="ml-1.5 text-[9px]">
                          {draftFilters.statuses.length}
                        </Badge>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72 p-3 space-y-3" align="start">
                      <div>
                        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Status
                        </Label>
                        <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                          {(
                            ["draft", "pending", "approved", "rejected", "posted"] as DraftStatus[]
                          ).map((s) => (
                            <label
                              key={s}
                              className="flex items-center gap-1.5 text-[11px] capitalize cursor-pointer"
                            >
                              <Checkbox
                                checked={draftFilters.statuses.includes(s)}
                                onCheckedChange={(v) => {
                                  setDraftFilters((f) => ({
                                    ...f,
                                    statuses: v
                                      ? [...f.statuses, s]
                                      : f.statuses.filter((x) => x !== s),
                                  }));
                                }}
                              />
                              {s}
                            </label>
                          ))}
                        </div>
                      </div>
                      <div>
                        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Submitter
                        </Label>
                        <Select
                          value={draftFilters.submitter || "__all"}
                          onValueChange={(v) =>
                            setDraftFilters((f) => ({ ...f, submitter: v === "__all" ? "" : v }))
                          }
                        >
                          <SelectTrigger className="h-8 text-xs mt-1">
                            <SelectValue placeholder="Any" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__all" className="text-xs">
                              Anyone
                            </SelectItem>
                            {submitters.map((s) => (
                              <SelectItem key={s} value={s} className="text-xs">
                                {s}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            From
                          </Label>
                          <Input
                            type="date"
                            value={draftFilters.from}
                            onChange={(e) =>
                              setDraftFilters((f) => ({ ...f, from: e.target.value }))
                            }
                            className="h-8 text-xs mt-1"
                          />
                        </div>
                        <div>
                          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            To
                          </Label>
                          <Input
                            type="date"
                            value={draftFilters.to}
                            onChange={(e) => setDraftFilters((f) => ({ ...f, to: e.target.value }))}
                            className="h-8 text-xs mt-1"
                          />
                        </div>
                      </div>
                      <Separator />
                      <div className="flex gap-1.5">
                        <Input
                          placeholder="Name this view…"
                          value={newViewName}
                          onChange={(e) => setNewViewName(e.target.value)}
                          className="h-8 text-xs"
                        />
                        <Button
                          size="sm"
                          className="h-8 text-[10.5px]"
                          onClick={saveCurrentView}
                          disabled={!newViewName.trim()}
                        >
                          <Bookmark className="h-3 w-3 mr-1" />
                          Save view
                        </Button>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-[10.5px] w-full"
                        onClick={() =>
                          setDraftFilters({
                            statuses: ["draft", "pending", "approved", "rejected"],
                            submitter: "",
                            from: "",
                            to: "",
                          })
                        }
                      >
                        <X className="h-3 w-3 mr-1" />
                        Reset filters
                      </Button>
                    </PopoverContent>
                  </Popover>
                  {savedViews.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => applyView(v)}
                      className="group inline-flex items-center gap-1 rounded-full border bg-muted/30 hover:bg-muted px-2 py-0.5 text-[10px]"
                    >
                      <Bookmark className="h-2.5 w-2.5 text-primary" />
                      {v.name}
                      <X
                        className="h-2.5 w-2.5 opacity-0 group-hover:opacity-60 hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSavedViews((s) => s.filter((x) => x.id !== v.id));
                        }}
                      />
                    </button>
                  ))}
                  <div className="flex-1" />
                  <span className="text-[10px] text-muted-foreground">
                    {filteredDrafts.length}/{drafts.length}
                  </span>
                </div>
              </div>
              <div className="max-h-[420px] overflow-auto">
                {drafts.length === 0 && (
                  <div className="p-8 text-center">
                    <BookOpen className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">
                      Confirm matches to draft journals
                    </p>
                  </div>
                )}
                {drafts.length > 0 && filteredDrafts.length === 0 && (
                  <div className="p-6 text-center">
                    <Filter className="h-6 w-6 text-muted-foreground/40 mx-auto mb-1.5" />
                    <p className="text-[11px] text-muted-foreground">
                      No drafts match current filters
                    </p>
                  </div>
                )}
                <div className="divide-y">
                  {filteredDrafts.map((d) => {
                    const statusMeta = {
                      draft: {
                        label: "Draft",
                        cls: "bg-muted text-muted-foreground border-border",
                        Icon: Clock,
                      },
                      pending: {
                        label: "Pending approval",
                        cls: "bg-amber-500/10 text-amber-700 border-amber-500/20",
                        Icon: MailCheck,
                      },
                      approved: {
                        label: "Approved",
                        cls: "bg-primary/10 text-primary border-primary/20",
                        Icon: UserCheck,
                      },
                      rejected: {
                        label: "Rejected",
                        cls: "bg-destructive/10 text-destructive border-destructive/20",
                        Icon: ShieldAlert,
                      },
                      posted: {
                        label: "Posted",
                        cls: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
                        Icon: CheckCircle2,
                      },
                    }[d.status];
                    const SIcon = statusMeta.Icon;
                    const overdue = isOverdue(d);
                    const hoursIn = d.approval?.submittedTs ? slaHoursOverdue(d) : 0;
                    return (
                      <div
                        key={d.id}
                        className={`p-3 ${d.status === "rejected" ? "bg-destructive/5" : d.status === "approved" ? "bg-primary/5" : ""}`}
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2 min-w-0 flex-wrap">
                            <span className="text-xs font-mono text-muted-foreground">{d.id}</span>
                            <Badge variant="outline" className={`text-[9px] ${statusMeta.cls}`}>
                              <SIcon className="h-2.5 w-2.5 mr-0.5" />
                              {statusMeta.label}
                            </Badge>
                            {d.allocations.length > 1 && (
                              <Badge variant="secondary" className="text-[9px]">
                                <Split className="h-2.5 w-2.5 mr-0.5" />
                                Split × {d.allocations.length}
                              </Badge>
                            )}
                            {d.fx && (
                              <Badge
                                variant="outline"
                                className={`text-[9px] ${d.fx.gain >= 0 ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/20" : "bg-destructive/10 text-destructive border-destructive/20"}`}
                              >
                                {d.fx.currency} · FX {d.fx.gain >= 0 ? "Gain" : "Loss"}{" "}
                                {inr(Math.abs(d.fx.gain))}
                              </Badge>
                            )}
                            {d.revision && d.revision > 0 && (
                              <Badge
                                variant="outline"
                                className="text-[9px] bg-primary/10 text-primary border-primary/20"
                              >
                                <RotateCcw className="h-2.5 w-2.5 mr-0.5" />
                                rev {d.revision}
                              </Badge>
                            )}
                            {overdue && (
                              <Badge
                                variant="outline"
                                className="text-[9px] bg-destructive/10 text-destructive border-destructive/20"
                              >
                                <Timer className="h-2.5 w-2.5 mr-0.5" />
                                SLA breach · {hoursIn.toFixed(1)}h
                              </Badge>
                            )}
                          </div>
                          <span className="text-[10px] text-muted-foreground">{d.date}</span>
                        </div>
                        <p className="text-xs font-medium truncate">{d.memo}</p>
                        <p className="text-[10px] text-muted-foreground truncate mb-1">
                          Ref: {d.ref}
                        </p>
                        {d.approval && (d.approval.submittedBy || d.approval.approver) && (
                          <div className="text-[10px] text-muted-foreground mb-2 space-y-0.5 rounded-md bg-muted/40 px-2 py-1 border">
                            {d.approval.submittedBy && (
                              <p>
                                <MailCheck className="h-2.5 w-2.5 inline mr-1" />
                                Submitted by{" "}
                                <span className="font-medium text-foreground">
                                  {d.approval.submittedBy}
                                </span>
                                {d.approval.submittedAt ? ` · ${d.approval.submittedAt}` : ""}
                              </p>
                            )}
                            {d.approval.approver && (
                              <p>
                                {d.status === "rejected" ? (
                                  <ShieldAlert className="h-2.5 w-2.5 inline mr-1 text-destructive" />
                                ) : (
                                  <UserCheck className="h-2.5 w-2.5 inline mr-1 text-primary" />
                                )}
                                {d.status === "rejected" ? "Rejected" : "Approved"} by{" "}
                                <span className="font-medium text-foreground">
                                  {d.approval.approver}
                                </span>
                                {d.approval.decidedAt ? ` · ${d.approval.decidedAt}` : ""}
                              </p>
                            )}
                            {d.approval.note && <p className="italic">"{d.approval.note}"</p>}
                          </div>
                        )}
                        <div className="rounded-md border overflow-hidden">
                          <Table>
                            <TableHeader>
                              <TableRow className="bg-muted/40">
                                <TableHead className="h-6 text-[10px]">Account</TableHead>
                                <TableHead className="h-6 text-[10px] text-right">Dr</TableHead>
                                <TableHead className="h-6 text-[10px] text-right">Cr</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {d.lines.map((l, i) => (
                                <TableRow key={i}>
                                  <TableCell className="py-1 text-[10.5px]">
                                    <span className="text-muted-foreground font-mono mr-1">
                                      {l.code}
                                    </span>
                                    {l.account}
                                  </TableCell>
                                  <TableCell className="py-1 text-[10.5px] text-right tabular-nums">
                                    {l.debit ? inr(l.debit) : "—"}
                                  </TableCell>
                                  <TableCell className="py-1 text-[10.5px] text-right tabular-nums">
                                    {l.credit ? inr(l.credit) : "—"}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {(d.status === "draft" || d.status === "rejected") && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-[10px]"
                              onClick={() => submitForApproval([d.id])}
                            >
                              <MailCheck className="h-3 w-3 mr-1" />
                              Submit for approval
                            </Button>
                          )}
                          {d.status === "pending" && (
                            <>
                              {canApprove ? (
                                <>
                                  <Button
                                    size="sm"
                                    className="h-6 text-[10px] bg-primary text-primary-foreground"
                                    onClick={() => {
                                      setDecisionOn({ draft: d, kind: "approve" });
                                      setDecisionNote("");
                                    }}
                                  >
                                    <UserCheck className="h-3 w-3 mr-1" />
                                    Approve
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 text-[10px] text-destructive border-destructive/30"
                                    onClick={() => {
                                      setDecisionOn({ draft: d, kind: "reject" });
                                      setDecisionNote("");
                                    }}
                                  >
                                    <XCircle className="h-3 w-3 mr-1" />
                                    Reject
                                  </Button>
                                </>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] bg-amber-500/10 text-amber-700 border-amber-500/20"
                                >
                                  <ShieldAlert className="h-2.5 w-2.5 mr-0.5" />
                                  Awaiting CEO (switch role)
                                </Badge>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 text-[10px]"
                                onClick={() => recallDraft(d.id)}
                              >
                                <Undo2 className="h-3 w-3 mr-1" />
                                Recall
                              </Button>
                              {overdue && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 text-[10px] border-destructive/30 text-destructive"
                                  onClick={() => sendReminder(d.id)}
                                >
                                  <BellRing className="h-3 w-3 mr-1" />
                                  Send reminder
                                </Button>
                              )}
                            </>
                          )}
                          {d.status === "approved" && (
                            <Badge
                              variant="outline"
                              className="text-[9px] bg-primary/10 text-primary border-primary/20"
                            >
                              Ready to post
                            </Badge>
                          )}
                          {(d.status === "draft" ||
                            d.status === "pending" ||
                            d.status === "approved" ||
                            d.status === "rejected") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 text-[10px]"
                              onClick={() => {
                                setEditingDraft(d);
                                setEditMemo(d.memo);
                                setEditRef(d.ref);
                              }}
                            >
                              <Pencil className="h-3 w-3 mr-1" />
                              Edit
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {drafts.length > 0 && (
                <div className="p-3 border-t bg-muted/20 flex items-center justify-between gap-2">
                  <p className="text-[10px] text-muted-foreground">
                    →{" "}
                    <Link to="/accounting/journal" className="text-primary hover:underline">
                      Journal
                    </Link>
                  </p>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => submitForApproval()}
                      disabled={
                        drafts.filter((d) => d.status === "draft" || d.status === "rejected")
                          .length === 0
                      }
                    >
                      <MailCheck className="h-3 w-3 mr-1" />
                      Submit all
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 text-xs bg-gradient-brand text-white"
                      onClick={postAll}
                      disabled={drafts.filter((d) => d.status === "approved").length === 0}
                    >
                      <Send className="h-3 w-3 mr-1" />
                      Post approved
                    </Button>
                  </div>
                </div>
              )}
            </Card>

            {/* Invoice/bill sync */}
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck className="h-4 w-4 text-emerald-600" />
                <h3 className="text-sm font-semibold">Ledger sync — balance updates</h3>
              </div>
              <div className="space-y-2 max-h-[220px] overflow-auto">
                {[
                  ...loaderInvoices.filter((i) => invoicePaid[i.id]),
                  ...loaderBills.filter((b) => billPaid[b.id]),
                ].length === 0 && (
                  <p className="text-[11px] text-muted-foreground py-3 text-center">
                    Post matched journals to see invoice/bill balances update in real time
                  </p>
                )}
                {loaderInvoices
                  .filter((i) => invoicePaid[i.id])
                  .map((i) => {
                    const paid = invoicePaid[i.id];
                    const remaining = Math.max(0, i.balance - paid);
                    const state = remaining === 0 ? "Paid" : "Partial";
                    return (
                      <div key={i.id} className="rounded-md border p-2 bg-muted/20">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-mono">{i.id}</span>
                          <Badge
                            variant="outline"
                            className={
                              state === "Paid"
                                ? "text-[9px] bg-emerald-500/10 text-emerald-700 border-emerald-500/20"
                                : "text-[9px] bg-amber-500/10 text-amber-700 border-amber-500/20"
                            }
                          >
                            {state}
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-0.5">
                          <span>{i.customer}</span>
                          <span className="tabular-nums">
                            {inr(paid)} / {inr(i.amount)}
                          </span>
                        </div>
                        <Progress value={(paid / i.amount) * 100} className="h-1 mt-1" />
                        <p className="text-[9.5px] text-muted-foreground mt-1">
                          Remaining:{" "}
                          <span className="text-foreground font-medium">{inr(remaining)}</span>
                        </p>
                      </div>
                    );
                  })}
                {loaderBills
                  .filter((b) => billPaid[b.id])
                  .map((b) => {
                    const paid = billPaid[b.id];
                    const remaining = Math.max(0, b.amount - paid);
                    const state = remaining === 0 ? "Paid" : "Partial";
                    return (
                      <div key={b.id} className="rounded-md border p-2 bg-muted/20">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-mono">{b.id}</span>
                          <Badge
                            variant="outline"
                            className={
                              state === "Paid"
                                ? "text-[9px] bg-emerald-500/10 text-emerald-700 border-emerald-500/20"
                                : "text-[9px] bg-amber-500/10 text-amber-700 border-amber-500/20"
                            }
                          >
                            {state}
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-0.5">
                          <span>{b.vendor}</span>
                          <span className="tabular-nums">
                            {inr(paid)} / {inr(b.amount)}
                          </span>
                        </div>
                        <Progress value={(paid / b.amount) * 100} className="h-1 mt-1" />
                        <p className="text-[9.5px] text-muted-foreground mt-1">
                          Remaining:{" "}
                          <span className="text-foreground font-medium">{inr(remaining)}</span>
                        </p>
                      </div>
                    );
                  })}
              </div>
            </Card>

            {/* Posted with rollback */}
            {posted.length > 0 && (
              <Card className="p-0 overflow-hidden">
                <div className="p-4 border-b flex items-center justify-between">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    Posted (rollback available)
                  </h3>
                  <Badge
                    variant="secondary"
                    className="text-[10px] bg-emerald-500/10 text-emerald-700"
                  >
                    {posted.length}
                  </Badge>
                </div>
                <div className="divide-y max-h-[200px] overflow-auto">
                  {posted.map((p) => (
                    <div key={p.id} className="p-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">
                          {p.id} · {inr(p.amount)}
                        </p>
                        <p className="text-[10px] text-muted-foreground truncate">{p.memo}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-[10px]"
                        onClick={() => rollbackPosted(p.id)}
                      >
                        <Undo2 className="h-3 w-3 mr-1" /> Rollback
                      </Button>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* Manual match dialog */}
      <Dialog open={!!manual} onOpenChange={(o) => !o && setManual(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5 text-primary" />
              Match manually
            </DialogTitle>
            <DialogDescription>
              {manual && (
                <>
                  Find an open {manual.type === "credit" ? "invoice" : "bill"} for{" "}
                  <span className="font-medium text-foreground">{inr(manual.amount)}</span>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {manual && (
            <div className="space-y-3">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={manualQ}
                  onChange={(e) => setManualQ(e.target.value)}
                  placeholder="Search…"
                  className="pl-8"
                />
              </div>
              <div className="border rounded-lg divide-y max-h-72 overflow-auto">
                {manualCandidates(manual).map((c) => (
                  <button
                    key={c.docId}
                    onClick={() => {
                      confirmMatch(manual, [
                        {
                          docId: c.docId,
                          docType: c.docType,
                          party: c.party,
                          amount: manual.amount,
                        },
                      ]);
                      setManual(null);
                    }}
                    className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/40 transition-colors"
                  >
                    {c.docType === "invoice" ? (
                      <FileText className="h-4 w-4 text-primary shrink-0" />
                    ) : (
                      <Receipt className="h-4 w-4 text-amber-600 shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {c.docId} · {c.party}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {c.date} · balance {inr(c.amount)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-semibold tabular-nums">{inr(c.amount)}</p>
                      {c.diff === 0 ? (
                        <Badge
                          variant="secondary"
                          className="text-[9px] bg-emerald-500/10 text-emerald-700 border-emerald-500/20"
                        >
                          Exact
                        </Badge>
                      ) : (
                        <p className="text-[9px] text-muted-foreground">Δ {inr(c.diff)}</p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setManual(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Split dialog */}
      <Dialog open={!!split} onOpenChange={(o) => !o && setSplit(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Split className="h-5 w-5 text-primary" />
              Split transaction across documents
            </DialogTitle>
            <DialogDescription>
              {split && (
                <>
                  Allocate <span className="font-medium text-foreground">{inr(split.amount)}</span>{" "}
                  from {split.id} across multiple {split.type === "credit" ? "invoices" : "bills"} —
                  a multi-line journal will be drafted.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {split && (
            <div className="space-y-3">
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead className="h-8 text-[10px]">Document</TableHead>
                      <TableHead className="h-8 text-[10px]">Party</TableHead>
                      <TableHead className="h-8 text-[10px] text-right">Allocated</TableHead>
                      <TableHead className="h-8 w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {splitRows.map((r, i) => {
                      const pool = split.type === "credit" ? openInvoices : openBills;
                      return (
                        <TableRow key={i}>
                          <TableCell className="py-1.5">
                            <Select
                              value={r.docId}
                              onValueChange={(v) => {
                                const doc = pool.find((p) => p.id === v);
                                if (!doc) return;
                                setSplitRows((rows) =>
                                  rows.map((x, idx) =>
                                    idx === i
                                      ? {
                                          ...x,
                                          docId: v,
                                          party: "customer" in doc ? doc.customer : doc.vendor,
                                          amount:
                                            x.amount ||
                                            Math.min(
                                              doc.remaining,
                                              split.amount - splitTotal + x.amount,
                                            ),
                                        }
                                      : x,
                                  ),
                                );
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue placeholder="Select…" />
                              </SelectTrigger>
                              <SelectContent>
                                {pool.map((p) => (
                                  <SelectItem key={p.id} value={p.id} className="text-xs">
                                    {p.id} · {inr(p.remaining)} open
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell className="py-1.5 text-xs text-muted-foreground">
                            {r.party || "—"}
                          </TableCell>
                          <TableCell className="py-1.5">
                            <Input
                              type="number"
                              value={r.amount || ""}
                              onChange={(e) =>
                                setSplitRows((rows) =>
                                  rows.map((x, idx) =>
                                    idx === i ? { ...x, amount: Number(e.target.value) } : x,
                                  ),
                                )
                              }
                              className="h-8 text-xs text-right tabular-nums"
                            />
                          </TableCell>
                          <TableCell className="py-1.5">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={() =>
                                setSplitRows((rows) => rows.filter((_, idx) => idx !== i))
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setSplitRows((r) => [
                      ...r,
                      {
                        docId: "",
                        docType: split.type === "credit" ? "invoice" : "bill",
                        party: "",
                        amount: 0,
                      },
                    ])
                  }
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add allocation
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const remaining = split.amount - splitTotal;
                    if (splitRows.length === 0 || remaining <= 0) return;
                    setSplitRows((rows) =>
                      rows.map((r, i) =>
                        i === rows.length - 1 ? { ...r, amount: r.amount + remaining } : r,
                      ),
                    );
                  }}
                >
                  Auto-fill remainder
                </Button>
                <div className="flex-1" />
                <div className="text-right text-xs">
                  <div>
                    Allocated: <span className="font-semibold tabular-nums">{inr(splitTotal)}</span>{" "}
                    / {inr(split.amount)}
                  </div>
                  <div className={splitDiff === 0 ? "text-emerald-600" : "text-amber-600"}>
                    {splitDiff === 0
                      ? "Balanced ✓"
                      : `${inr(Math.abs(splitDiff))} ${splitDiff > 0 ? "unallocated" : "over-allocated"}`}
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSplit(null)}>
              Cancel
            </Button>
            <Button
              className="bg-gradient-brand text-white"
              disabled={
                !split || splitDiff !== 0 || splitRows.some((r) => !r.docId || r.amount <= 0)
              }
              onClick={() => {
                if (split) {
                  confirmMatch(split, splitRows);
                  setSplit(null);
                }
              }}
            >
              <Link2 className="h-4 w-4 mr-1.5" /> Confirm split & draft journal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rules dialog */}
      <Dialog open={rulesOpen} onOpenChange={setRulesOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings2 className="h-5 w-5 text-primary" />
              Auto-match rules
            </DialogTitle>
            <DialogDescription>
              Per-source confidence thresholds and document-type mapping. Rules run top-down when
              you click "Run auto-match rules".
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {rules.map((r) => (
              <Card key={r.id} className="p-3">
                <div className="flex items-center gap-3 mb-2">
                  <Switch
                    checked={r.enabled}
                    onCheckedChange={(v) => {
                      setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)));
                      logAudit({
                        action: "rule-change",
                        detail: `${r.id} ${v ? "enabled" : "disabled"}`,
                      });
                    }}
                  />
                  <span className="text-xs font-mono text-muted-foreground">{r.id}</span>
                  <Input
                    value={r.source}
                    onChange={(e) =>
                      setRules((rs) =>
                        rs.map((x) => (x.id === r.id ? { ...x, source: e.target.value } : x)),
                      )
                    }
                    className="h-8 text-xs flex-1"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => setRules((rs) => rs.filter((x) => x.id !== r.id))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-[10px] text-muted-foreground">Direction</Label>
                    <Select
                      value={r.direction}
                      onValueChange={(v: "credit" | "debit" | "both") =>
                        setRules((rs) =>
                          rs.map((x) => (x.id === r.id ? { ...x, direction: v } : x)),
                        )
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="credit" className="text-xs">
                          Credit → Receipt
                        </SelectItem>
                        <SelectItem value="debit" className="text-xs">
                          Debit → Payment
                        </SelectItem>
                        <SelectItem value="both" className="text-xs">
                          Both directions
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground">Target doc type</Label>
                    <Select
                      value={r.docType}
                      onValueChange={(v: "invoice" | "bill" | "auto") =>
                        setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, docType: v } : x)))
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="invoice" className="text-xs">
                          Invoices only
                        </SelectItem>
                        <SelectItem value="bill" className="text-xs">
                          Bills only
                        </SelectItem>
                        <SelectItem value="auto" className="text-xs">
                          Auto (by direction)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end gap-2">
                    <Switch
                      checked={r.autoPost}
                      onCheckedChange={(v) =>
                        setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, autoPost: v } : x)))
                      }
                    />
                    <Label className="text-[11px] pb-1.5">Auto-post to ledger</Label>
                  </div>
                </div>
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1">
                    <Label className="text-[10px] text-muted-foreground">Minimum confidence</Label>
                    <span className="text-xs font-semibold tabular-nums">{r.minConfidence}%</span>
                  </div>
                  <Slider
                    value={[r.minConfidence]}
                    min={50}
                    max={100}
                    step={1}
                    onValueChange={([v]) =>
                      setRules((rs) =>
                        rs.map((x) => (x.id === r.id ? { ...x, minConfidence: v } : x)),
                      )
                    }
                  />
                </div>
              </Card>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setRules((rs) => [
                  ...rs,
                  {
                    id: `R${rs.length + 1}`,
                    source: "New source",
                    direction: "both",
                    docType: "auto",
                    minConfidence: 90,
                    autoPost: false,
                    enabled: true,
                  },
                ])
              }
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> Add rule
            </Button>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setRulesOpen(false);
                toast.success("Rules saved");
              }}
            >
              Save rules
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Audit trail */}
      <Dialog open={auditOpen} onOpenChange={setAuditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5 text-primary" />
              Audit trail
            </DialogTitle>
            <DialogDescription>
              Immutable log of every reconciliation action · rollback available on posted journals
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[420px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8 text-[10px]">Time</TableHead>
                  <TableHead className="h-8 text-[10px]">Actor</TableHead>
                  <TableHead className="h-8 text-[10px]">Action</TableHead>
                  <TableHead className="h-8 text-[10px]">Detail</TableHead>
                  <TableHead className="h-8 text-[10px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.map((e, i) => (
                  <TableRow key={i}>
                    <TableCell className="py-2 text-[10px] font-mono text-muted-foreground">
                      {e.ts}
                    </TableCell>
                    <TableCell className="py-2 text-[11px]">{e.actor}</TableCell>
                    <TableCell className="py-2">
                      <Badge variant="outline" className="text-[9px] capitalize">
                        {e.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-2 text-[11px]">{e.detail}</TableCell>
                    <TableCell className="py-2">
                      {e.action === "post" &&
                        e.journalId &&
                        posted.some((p) => p.id === e.journalId) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-[10px]"
                            onClick={() => rollbackPosted(e.journalId!)}
                          >
                            <Undo2 className="h-3 w-3 mr-1" /> Rollback
                          </Button>
                        )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>

      {/* Export dialog */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="h-5 w-5 text-primary" />
              Export reconciliation report
            </DialogTitle>
            <DialogDescription>
              Summary + full transaction & journal detail for the selected date range
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[10px]">From</Label>
              <Input
                type="date"
                value={range.from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-[10px]">To</Label>
              <Input
                type="date"
                value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                className="h-9"
              />
            </div>
          </div>
          <Card className="p-3 bg-muted/30">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              Preview
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">Transactions in range</span>
              <span className="text-right font-semibold tabular-nums">
                {reportStats.scoped.length}
              </span>
              <span className="text-muted-foreground">Matched</span>
              <span className="text-right font-semibold tabular-nums text-emerald-600">
                {reportStats.matched.length}
              </span>
              <span className="text-muted-foreground">Unmatched</span>
              <span className="text-right font-semibold tabular-nums text-amber-600">
                {reportStats.unmatched.length}
              </span>
              <span className="text-muted-foreground">Variance</span>
              <span className="text-right font-semibold tabular-nums">
                {inr(reportStats.variance)}
              </span>
              <span className="text-muted-foreground">Draft journals</span>
              <span className="text-right font-semibold tabular-nums">
                {reportStats.drafts.length}
              </span>
              <span className="text-muted-foreground">Posted journals</span>
              <span className="text-right font-semibold tabular-nums text-emerald-600">
                {reportStats.posted.length}
              </span>
            </div>
          </Card>
          <DialogFooter>
            <Button variant="outline" onClick={exportPDF}>
              <Printer className="h-4 w-4 mr-1.5" /> PDF
            </Button>
            <Button className="bg-gradient-brand text-white" onClick={exportCSV}>
              <Download className="h-4 w-4 mr-1.5" /> CSV
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve / Reject dialog */}
      <Dialog open={!!decisionOn} onOpenChange={(o) => !o && setDecisionOn(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {decisionOn?.kind === "approve" ? (
                <>
                  <UserCheck className="h-5 w-5 text-primary" />
                  Approve draft journal
                </>
              ) : (
                <>
                  <XCircle className="h-5 w-5 text-destructive" />
                  Reject draft journal
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              {decisionOn?.kind === "approve"
                ? "Approving marks this draft as ready to post to the General Ledger. Action is recorded in the audit trail."
                : "Rejecting sends the draft back to the accountant with your note. Nothing will be posted."}
            </DialogDescription>
          </DialogHeader>
          {decisionOn && (
            <div className="space-y-3">
              <div className="rounded-md border p-3 bg-muted/30 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-mono">{decisionOn.draft.id}</span>
                  <span className="tabular-nums font-semibold">{inr(decisionOn.draft.amount)}</span>
                </div>
                <p className="text-muted-foreground truncate">{decisionOn.draft.memo}</p>
                <p className="text-[10px] text-muted-foreground">
                  Submitted by {decisionOn.draft.approval?.submittedBy || "—"} ·{" "}
                  {decisionOn.draft.approval?.submittedAt || "—"}
                </p>
              </div>
              <div>
                <Label className="text-xs">
                  {decisionOn.kind === "approve" ? "Note (optional)" : "Reason for rejection"}
                </Label>
                <Input
                  value={decisionNote}
                  onChange={(e) => setDecisionNote(e.target.value)}
                  placeholder={
                    decisionOn.kind === "approve"
                      ? "Looks good — proceed"
                      : "GST classification looks off, please revise"
                  }
                  className="mt-1"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecisionOn(null)}>
              Cancel
            </Button>
            <Button
              className={
                decisionOn?.kind === "approve"
                  ? "bg-primary text-primary-foreground"
                  : "bg-destructive text-destructive-foreground"
              }
              disabled={decisionOn?.kind === "reject" && !decisionNote.trim()}
              onClick={() => {
                if (!decisionOn) return;
                decideDraft(decisionOn.draft, decisionOn.kind, decisionNote.trim());
                setDecisionOn(null);
              }}
            >
              {decisionOn?.kind === "approve" ? (
                <>
                  <UserCheck className="h-4 w-4 mr-1.5" />
                  Approve
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4 mr-1.5" />
                  Reject
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Notification center */}
      <Dialog
        open={notifOpen}
        onOpenChange={(v) => {
          setNotifOpen(v);
          if (!v) setNotifications((ns) => ns.map((n) => ({ ...n, read: true })));
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-primary" />
              Notifications
            </DialogTitle>
            <DialogDescription>
              Reconciliation approvals, revisions & SLA reminders — in-app + simulated email.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[420px] overflow-auto space-y-2">
            {notifications.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-6">
                No notifications yet.
              </p>
            )}
            {notifications.map((n) => (
              <div
                key={n.id}
                className={`p-2.5 rounded-lg border text-xs ${!n.read ? "bg-primary/5 border-primary/20" : "bg-muted/20"}`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Badge variant="outline" className="text-[9px] capitalize">
                      {n.kind}
                    </Badge>
                    <p className="font-medium truncate">{n.title}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">{n.ts}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">{n.body}</p>
                <div className="flex items-center gap-1 mt-1">
                  {n.channel.map((c) => (
                    <Badge key={c} variant="secondary" className="text-[9px]">
                      {c === "email" ? (
                        <>
                          <Mail className="h-2.5 w-2.5 mr-0.5" />
                          Email
                        </>
                      ) : (
                        <>
                          <Bell className="h-2.5 w-2.5 mr-0.5" />
                          In-app
                        </>
                      )}
                    </Badge>
                  ))}
                  <Badge variant="outline" className="text-[9px]">
                    → {n.toRole}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setNotifications([])}>
              Clear all
            </Button>
            <Button size="sm" onClick={() => setNotifOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit draft (triggers re-approval) */}
      <Dialog
        open={!!editingDraft}
        onOpenChange={(v) => {
          if (!v) setEditingDraft(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-4 w-4 text-primary" />
              Revise draft {editingDraft?.id}
            </DialogTitle>
            <DialogDescription>
              {editingDraft?.status === "approved"
                ? "This draft was approved — editing sends it back to pending re-approval."
                : "Update memo or reference. Approved edits require re-approval."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Memo</Label>
              <Textarea
                value={editMemo}
                onChange={(e) => setEditMemo(e.target.value)}
                className="text-xs mt-1"
                rows={2}
              />
            </div>
            <div>
              <Label className="text-xs">Bank reference</Label>
              <Input
                value={editRef}
                onChange={(e) => setEditRef(e.target.value)}
                className="text-xs mt-1"
              />
            </div>
            {editingDraft?.status === "approved" && (
              <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-2 flex gap-2 text-[11px] text-amber-800">
                <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>
                  Saving reverts this draft to <b>pending</b> and notifies the CEO for re-approval.
                </span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditingDraft(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-gradient-brand text-white"
              onClick={() => {
                if (!editingDraft) return;
                reviseDraft(editingDraft.id, editMemo, editRef);
                setEditingDraft(null);
              }}
            >
              Save revision
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
