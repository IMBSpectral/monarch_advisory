import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Landmark, Smartphone, ShieldCheck, Sparkles, CheckCircle2, Loader2, Plus,
  Building2, CreditCard, RefreshCw, Lock, Zap, FileDown, ArrowRight, QrCode,
  Clock, AlertTriangle, PlayCircle, PauseCircle, Bell,
} from "lucide-react";
import { toast } from "sonner";
import { inr } from "@/data/mock";

export const Route = createFileRoute("/banking/connect")({ component: ConnectAccounts });

type Linked = {
  id: string;
  kind: "bank" | "upi";
  name: string;
  handle: string;
  status: "syncing" | "connected" | "error";
  lastSync: string;
  txns: number;
  balance?: number;
  color: string;
};

const initialLinked: Linked[] = [
  { id: "1", kind: "bank", name: "HDFC Bank — Current A/C", handle: "XXXX 4521", status: "connected", lastSync: "2 min ago", txns: 1284, balance: 4820000, color: "bg-blue-500" },
  { id: "2", kind: "bank", name: "ICICI Bank — Savings", handle: "XXXX 8890", status: "connected", lastSync: "8 min ago", txns: 342, balance: 1245000, color: "bg-orange-500" },
  { id: "3", kind: "upi", name: "Google Pay", handle: "monarch@okhdfcbank", status: "connected", lastSync: "just now", txns: 891, color: "bg-emerald-500" },
  { id: "4", kind: "upi", name: "PhonePe Business", handle: "monarcherp@ybl", status: "syncing", lastSync: "syncing…", txns: 0, color: "bg-indigo-500" },
];

const bankOptions = [
  { name: "HDFC Bank", tag: "Instant", color: "bg-blue-600" },
  { name: "ICICI Bank", tag: "Instant", color: "bg-orange-600" },
  { name: "State Bank of India", tag: "Instant", color: "bg-blue-800" },
  { name: "Axis Bank", tag: "Instant", color: "bg-rose-600" },
  { name: "Kotak Mahindra", tag: "Instant", color: "bg-red-600" },
  { name: "Yes Bank", tag: "Beta", color: "bg-blue-500" },
  { name: "IndusInd Bank", tag: "Instant", color: "bg-amber-700" },
  { name: "IDFC First Bank", tag: "Instant", color: "bg-fuchsia-700" },
];

const upiApps = [
  { name: "Google Pay", handle: "@okhdfcbank / @okaxis", color: "bg-emerald-500" },
  { name: "PhonePe", handle: "@ybl / @ibl", color: "bg-indigo-600" },
  { name: "Paytm", handle: "@paytm", color: "bg-sky-500" },
  { name: "BHIM UPI", handle: "@upi", color: "bg-orange-500" },
  { name: "Amazon Pay", handle: "@apl", color: "bg-yellow-500" },
  { name: "CRED", handle: "@cred", color: "bg-slate-800" },
];

function ConnectAccounts() {
  const [linked, setLinked] = useState<Linked[]>(initialLinked);
  const [bankDialog, setBankDialog] = useState<string | null>(null);
  const [upiDialog, setUpiDialog] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [upiId, setUpiId] = useState("");
  const [frequency, setFrequency] = useState("15m");
  const [autoImport, setAutoImport] = useState(true);
  const [errorAlerts, setErrorAlerts] = useState(true);
  const [schedulerOn, setSchedulerOn] = useState(true);
  const [runningAll, setRunningAll] = useState(false);

  const syncNowAll = () => {
    setRunningAll(true);
    setLinked((l) => l.map((x) => ({ ...x, status: "syncing" as const, lastSync: "syncing…" })));
    toast("Manual sync across all accounts started", { icon: <RefreshCw className="h-4 w-4 animate-spin" /> });
    setTimeout(() => {
      setLinked((l) => l.map((x) => ({ ...x, status: "connected" as const, lastSync: "just now", txns: x.txns + Math.floor(Math.random() * 20) })));
      setRunningAll(false);
      toast.success("All accounts synced");
    }, 2200);
  };

  const syncHistory = [
    { time: "Today · 09:24", account: "HDFC Bank — Current", result: "ok", detail: "218 new txns" },
    { time: "Today · 09:24", account: "ICICI Bank — Savings", result: "ok", detail: "12 new txns" },
    { time: "Today · 09:24", account: "Google Pay", result: "ok", detail: "34 new UPI txns" },
    { time: "Today · 09:09", account: "PhonePe Business", result: "warn", detail: "AA consent expiring in 4 days" },
    { time: "Today · 08:54", account: "HDFC Bank — Current", result: "ok", detail: "3 new txns" },
    { time: "Today · 08:39", account: "Axis Corporate Card", result: "error", detail: "OTP timeout — retrying at next window" },
  ];


  const startBankConnect = (bank: string) => {
    setBankDialog(bank);
    setStep(0);
  };

  const advance = () => {
    if (step < 3) {
      setStep((s) => s + 1);
    } else {
      const bank = bankDialog!;
      setBankDialog(null);
      setStep(0);
      const id = String(Date.now());
      setLinked((l) => [
        { id, kind: "bank", name: `${bank} — Current A/C`, handle: "XXXX " + Math.floor(1000 + Math.random() * 8999), status: "syncing", lastSync: "syncing…", txns: 0, balance: 0, color: "bg-primary" },
        ...l,
      ]);
      toast.success(`${bank} account linked via Account Aggregator`);
      setTimeout(() => {
        setLinked((l) => l.map((x) => x.id === id ? { ...x, status: "connected", lastSync: "just now", txns: 218, balance: 1820000 } : x));
        toast.success(`Fetched 218 transactions from ${bank}`);
      }, 2200);
    }
  };

  const linkUpi = () => {
    if (!upiId.includes("@")) { toast.error("Enter a valid UPI ID"); return; }
    const app = upiDialog!;
    setUpiDialog(null);
    const id = String(Date.now());
    setLinked((l) => [
      { id, kind: "upi", name: app, handle: upiId, status: "syncing", lastSync: "verifying…", txns: 0, color: "bg-primary" },
      ...l,
    ]);
    toast.success(`Collect request sent to ${upiId}`);
    setTimeout(() => {
      setLinked((l) => l.map((x) => x.id === id ? { ...x, status: "connected", lastSync: "just now", txns: 47 } : x));
      toast.success(`${app} verified — expense records syncing`);
    }, 2500);
    setUpiId("");
  };

  const resync = (id: string, name: string) => {
    setLinked((l) => l.map((x) => x.id === id ? { ...x, status: "syncing", lastSync: "syncing…" } : x));
    toast(`Refreshing ${name}…`, { icon: <RefreshCw className="h-4 w-4 animate-spin" /> });
    setTimeout(() => {
      setLinked((l) => l.map((x) => x.id === id ? { ...x, status: "connected", lastSync: "just now", txns: x.txns + Math.floor(Math.random() * 12) } : x));
      toast.success(`${name} up to date`);
    }, 1600);
  };

  const totalBalance = linked.filter((l) => l.balance).reduce((s, l) => s + (l.balance ?? 0), 0);
  const totalTxns = linked.reduce((s, l) => s + l.txns, 0);
  const connectedCount = linked.filter((l) => l.status === "connected").length;

  const steps = ["Consent", "Authenticate", "Select accounts", "Fetch statements"];

  return (
    <>
      <PageHeader
        title="Connect Bank & UPI"
        subtitle="Securely link accounts via RBI Account Aggregator to auto-import statements and expenses"
      />
      <div className="p-6 space-y-6">
        {/* Trust strip */}
        <Card className="p-4 border-emerald-500/20 bg-gradient-to-r from-emerald-500/5 via-transparent to-primary/5">
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-5 w-5 text-emerald-500" />
              <span className="font-medium">RBI Account Aggregator</span>
              <Badge variant="secondary" className="text-[10px]">ISO 27001</Badge>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Lock className="h-4 w-4" /> 256-bit end-to-end encryption
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Zap className="h-4 w-4" /> Read-only access — no debits ever
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Sparkles className="h-4 w-4 text-primary" /> AI auto-categorizes every transaction
            </div>
          </div>
        </Card>

        {/* KPI cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="p-5">
            <p className="text-xs text-muted-foreground">Linked accounts</p>
            <p className="text-2xl font-semibold mt-1">{connectedCount}<span className="text-sm text-muted-foreground">/{linked.length}</span></p>
            <p className="text-[11px] text-emerald-600 mt-1">All syncing normally</p>
          </Card>
          <Card className="p-5">
            <p className="text-xs text-muted-foreground">Aggregated balance</p>
            <p className="text-2xl font-semibold tabular-nums mt-1">{inr(totalBalance)}</p>
            <p className="text-[11px] text-muted-foreground mt-1">Across {linked.filter((l) => l.kind === "bank").length} bank accounts</p>
          </Card>
          <Card className="p-5">
            <p className="text-xs text-muted-foreground">Transactions synced</p>
            <p className="text-2xl font-semibold tabular-nums mt-1">{totalTxns.toLocaleString("en-IN")}</p>
            <p className="text-[11px] text-muted-foreground mt-1">Last 90 days</p>
          </Card>
          <Card className="p-5">
            <p className="text-xs text-muted-foreground">Auto-categorized</p>
            <p className="text-2xl font-semibold mt-1">98.4%</p>
            <p className="text-[11px] text-primary mt-1">AI Accountant enabled</p>
          </Card>
        </div>

        {/* Linked accounts */}
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-base font-semibold">Linked accounts</h3>
              <p className="text-xs text-muted-foreground">Statements refresh every 15 minutes</p>
            </div>
            <Button variant="outline" size="sm"><FileDown className="h-4 w-4 mr-2" />Export all statements</Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {linked.map((l) => (
              <div key={l.id} className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:shadow-elegant transition-shadow">
                <div className={`h-11 w-11 rounded-lg ${l.color} flex items-center justify-center text-white shrink-0`}>
                  {l.kind === "bank" ? <Building2 className="h-5 w-5" /> : <Smartphone className="h-5 w-5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">{l.name}</p>
                    {l.status === "connected" && <Badge variant="secondary" className="text-[9px] bg-emerald-500/10 text-emerald-700 border-emerald-500/20"><CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />Live</Badge>}
                    {l.status === "syncing" && <Badge variant="secondary" className="text-[9px]"><Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />Sync</Badge>}
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">{l.handle} • {l.txns} txns • {l.lastSync}</p>
                </div>
                {l.balance !== undefined && l.balance > 0 && (
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold tabular-nums">{inr(l.balance)}</p>
                    <p className="text-[10px] text-muted-foreground">available</p>
                  </div>
                )}
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => resync(l.id, l.name)}>
                  <RefreshCw className={`h-4 w-4 ${l.status === "syncing" ? "animate-spin" : ""}`} />
                </Button>
              </div>
            ))}
          </div>
        </Card>

        {/* Sync scheduler */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="p-5 lg:col-span-1">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold flex items-center gap-2"><Clock className="h-4 w-4 text-primary" />Sync scheduler</h3>
                <p className="text-xs text-muted-foreground">Control how often statements & UPI fetch</p>
              </div>
              <Switch checked={schedulerOn} onCheckedChange={(v) => { setSchedulerOn(v); toast(v ? "Scheduler resumed" : "Scheduler paused"); }} />
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Fetch frequency</label>
                <Select value={frequency} onValueChange={(v) => { setFrequency(v); toast.success(`Sync frequency set to ${v}`); }}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="realtime">Real-time (webhook)</SelectItem>
                    <SelectItem value="15m">Every 15 minutes</SelectItem>
                    <SelectItem value="1h">Every hour</SelectItem>
                    <SelectItem value="6h">Every 6 hours</SelectItem>
                    <SelectItem value="daily">Daily at 06:00 IST</SelectItem>
                    <SelectItem value="weekly">Weekly (Mon 06:00)</SelectItem>
                    <SelectItem value="manual">Manual only</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between rounded-lg border p-2.5">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <div>
                    <p className="text-xs font-medium">Auto-import to ledger</p>
                    <p className="text-[10px] text-muted-foreground">Skip review for &gt;95% confidence matches</p>
                  </div>
                </div>
                <Switch checked={autoImport} onCheckedChange={setAutoImport} />
              </div>

              <div className="flex items-center justify-between rounded-lg border p-2.5">
                <div className="flex items-center gap-2">
                  <Bell className="h-4 w-4 text-amber-500" />
                  <div>
                    <p className="text-xs font-medium">Error alerts</p>
                    <p className="text-[10px] text-muted-foreground">Email + WhatsApp on failed syncs</p>
                  </div>
                </div>
                <Switch checked={errorAlerts} onCheckedChange={setErrorAlerts} />
              </div>

              <div className="pt-2 border-t space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">Last successful sync</span>
                  <span className="font-medium">Today, 09:24 IST</span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">Next scheduled run</span>
                  <span className="font-medium text-primary">In 6 min</span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant="secondary" className={schedulerOn ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/20 text-[10px]" : "text-[10px]"}>
                    {schedulerOn ? <><CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />Healthy</> : <><PauseCircle className="h-2.5 w-2.5 mr-0.5" />Paused</>}
                  </Badge>
                </div>
              </div>

              <Button className="w-full" variant="outline" onClick={syncNowAll} disabled={runningAll}>
                {runningAll ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Syncing all…</> : <><PlayCircle className="h-4 w-4 mr-2" />Sync all now</>}
              </Button>
            </div>
          </Card>

          <Card className="p-5 lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold">Recent sync activity</h3>
                <p className="text-xs text-muted-foreground">Live log of every fetch — errors highlighted</p>
              </div>
              <Badge variant="secondary" className="text-[10px]">Last 24h</Badge>
            </div>
            <div className="space-y-1.5">
              {syncHistory.map((h, i) => (
                <div key={i} className={`flex items-center gap-3 p-2.5 rounded-lg border text-sm ${h.result === "error" ? "border-destructive/30 bg-destructive/5" : h.result === "warn" ? "border-amber-500/30 bg-amber-500/5" : "bg-card"}`}>
                  {h.result === "ok" && <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />}
                  {h.result === "warn" && <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />}
                  {h.result === "error" && <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{h.account}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{h.detail}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">{h.time}</span>
                  {h.result === "error" && (
                    <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => toast.success("Retry queued")}>Retry</Button>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Add new */}
        <Tabs defaultValue="bank">
          <TabsList>
            <TabsTrigger value="bank"><Landmark className="h-4 w-4 mr-2" />Add bank account</TabsTrigger>
            <TabsTrigger value="upi"><Smartphone className="h-4 w-4 mr-2" />Add UPI</TabsTrigger>
            <TabsTrigger value="card"><CreditCard className="h-4 w-4 mr-2" />Corporate cards</TabsTrigger>
          </TabsList>

          <TabsContent value="bank" className="mt-4">
            <Card className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-base font-semibold">Choose your bank</h3>
                  <p className="text-xs text-muted-foreground">Powered by Sahamati AA network — 120+ banks supported</p>
                </div>
                <Badge variant="secondary" className="gap-1"><ShieldCheck className="h-3 w-3 text-emerald-500" />RBI regulated</Badge>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {bankOptions.map((b) => (
                  <button
                    key={b.name}
                    onClick={() => startBankConnect(b.name)}
                    className="group flex items-center gap-3 p-3 rounded-lg border bg-card hover:border-primary/50 hover:shadow-elegant transition-all text-left"
                  >
                    <div className={`h-10 w-10 rounded-lg ${b.color} flex items-center justify-center text-white text-xs font-bold`}>
                      {b.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{b.name}</p>
                      <p className="text-[10px] text-muted-foreground">{b.tag}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                ))}
              </div>
              <button className="mt-3 w-full flex items-center justify-center gap-2 p-3 rounded-lg border border-dashed text-sm text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                <Plus className="h-4 w-4" /> Search from 120+ other banks
              </button>
            </Card>
          </TabsContent>

          <TabsContent value="upi" className="mt-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card className="p-5 lg:col-span-2">
                <h3 className="text-base font-semibold mb-1">Link a UPI ID</h3>
                <p className="text-xs text-muted-foreground mb-4">Auto-fetch every UPI expense — perfect for petty cash and field spends</p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {upiApps.map((u) => (
                    <button
                      key={u.name}
                      onClick={() => setUpiDialog(u.name)}
                      className="group flex flex-col items-center gap-2 p-4 rounded-lg border bg-card hover:border-primary/50 hover:shadow-elegant transition-all"
                    >
                      <div className={`h-12 w-12 rounded-xl ${u.color} flex items-center justify-center text-white`}>
                        <Smartphone className="h-6 w-6" />
                      </div>
                      <p className="text-sm font-medium">{u.name}</p>
                      <p className="text-[10px] text-muted-foreground text-center">{u.handle}</p>
                    </button>
                  ))}
                </div>
              </Card>
              <Card className="p-5 flex flex-col items-center justify-center text-center bg-gradient-to-b from-primary/5 to-transparent">
                <div className="h-32 w-32 rounded-xl bg-white border-2 border-dashed border-primary/30 flex items-center justify-center mb-3">
                  <QrCode className="h-16 w-16 text-primary/60" />
                </div>
                <p className="text-sm font-medium">Scan to link mobile UPI</p>
                <p className="text-[11px] text-muted-foreground mt-1">Open any UPI app and scan — auto-syncs in 3 seconds</p>
                <Badge variant="secondary" className="mt-3 text-[10px]">NPCI verified</Badge>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="card" className="mt-4">
            <Card className="p-8 text-center">
              <CreditCard className="h-10 w-10 text-primary mx-auto mb-3" />
              <h3 className="text-base font-semibold">Corporate & credit card feeds</h3>
              <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
                Auto-import transactions from HDFC, Axis, ICICI corporate cards and consumer credit cards via secure card feeds.
              </p>
              <Button className="mt-4"><Plus className="h-4 w-4 mr-2" />Link a card</Button>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Bank connect dialog */}
      <Dialog open={!!bankDialog} onOpenChange={(o) => !o && setBankDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-500" />
              Connect {bankDialog}
            </DialogTitle>
            <DialogDescription>Secured by RBI Account Aggregator — read-only access</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <Progress value={((step + 1) / steps.length) * 100} className="h-1.5" />
            <div className="space-y-2">
              {steps.map((s, i) => (
                <div key={s} className={`flex items-center gap-3 p-2.5 rounded-lg border ${i === step ? "border-primary bg-primary/5" : i < step ? "border-emerald-500/30 bg-emerald-500/5" : "border-border"}`}>
                  {i < step ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> :
                    i === step ? <Loader2 className="h-4 w-4 text-primary animate-spin" /> :
                    <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30" />}
                  <span className={`text-sm ${i === step ? "font-medium" : ""}`}>{s}</span>
                </div>
              ))}
            </div>
            {step === 0 && (
              <p className="text-[11px] text-muted-foreground p-2 bg-muted rounded-lg">
                You'll be redirected to {bankDialog}'s AA portal to approve a <b>read-only</b> data-sharing consent for 12 months. Monarch can never initiate a debit.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBankDialog(null)}>Cancel</Button>
            <Button onClick={advance}>{step < 3 ? "Continue" : "Finish & fetch statements"}<ArrowRight className="h-4 w-4 ml-2" /></Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* UPI connect dialog */}
      <Dialog open={!!upiDialog} onOpenChange={(o) => !o && setUpiDialog(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="h-5 w-5 text-primary" />
              Link {upiDialog}
            </DialogTitle>
            <DialogDescription>Enter your UPI ID — we'll send a verification collect request</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">UPI ID</Label>
              <Input
                placeholder="yourname@okhdfcbank"
                value={upiId}
                onChange={(e) => setUpiId(e.target.value)}
                className="mt-1"
              />
            </div>
            <p className="text-[11px] text-muted-foreground">A ₹1 verification request will be sent. Approve on your UPI app to complete linking.</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUpiDialog(null)}>Cancel</Button>
            <Button onClick={linkUpi}>Send verification</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
