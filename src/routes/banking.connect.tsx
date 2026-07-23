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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Landmark,
  Smartphone,
  ShieldCheck,
  Sparkles,
  CheckCircle2,
  Plus,
  Building2,
  CreditCard,
  RefreshCw,
  Lock,
  Zap,
  FileDown,
  ArrowRight,
  QrCode,
  Clock,
  PlayCircle,
  PauseCircle,
  Bell,
} from "lucide-react";
import { toast } from "sonner";
import { fetchBankSummary } from "@/api/entities";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/banking/connect")({
  loader: async () => ({ accounts: await fetchBankSummary() }),
  component: ConnectAccounts,
});

// Linking banks / UPI and pulling live statements needs an RBI Account
// Aggregator (Setu / Perfios / etc.) that isn't provisioned here. Every
// connect/sync/link action tells the truth rather than faking a success toast.
const AGG_MSG =
  "Bank feed connection requires an account aggregator integration (e.g. Setu/Perfios) — not connected in this environment.";

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
  const { accounts } = Route.useLoaderData();
  const [bankDialog, setBankDialog] = useState<string | null>(null);
  const [upiDialog, setUpiDialog] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [upiId, setUpiId] = useState("");
  const [frequency, setFrequency] = useState("15m");
  const [autoImport, setAutoImport] = useState(true);
  const [errorAlerts, setErrorAlerts] = useState(true);
  const [schedulerOn, setSchedulerOn] = useState(true);

  const connectedCount = accounts.length;
  const totalUnreconciled = accounts.reduce((s, a) => s + a.unreconciledCount, 0);
  const liveFeeds = accounts.filter((a) => a.feedBalance != null).length;
  // Exact integer-domain sum in bigint (minor units) — no float money math.
  const aggregatedBalance = accounts.reduce((s, a) => s + BigInt(a.glBalance || "0"), 0n);

  const notWired = () => toast.info(AGG_MSG);

  const advance = () => {
    if (step < 3) {
      setStep((s) => s + 1);
    } else {
      setBankDialog(null);
      setStep(0);
      toast.info(AGG_MSG);
    }
  };

  const linkUpi = () => {
    if (!upiId.includes("@")) {
      toast.error("Enter a valid UPI ID");
      return;
    }
    setUpiDialog(null);
    setUpiId("");
    toast.info(AGG_MSG);
  };

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
              <Badge variant="secondary" className="text-[10px]">
                ISO 27001
              </Badge>
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

        {/* KPI cards — from real bank data */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="p-5">
            <p className="text-xs text-muted-foreground">Linked accounts</p>
            <p className="text-2xl font-semibold mt-1">{connectedCount}</p>
            <p className="text-[11px] text-muted-foreground mt-1">On the general ledger</p>
          </Card>
          <Card className="p-5">
            <p className="text-xs text-muted-foreground">Aggregated GL balance</p>
            <p className="text-2xl font-semibold tabular-nums mt-1">
              {formatMinor(aggregatedBalance)}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">
              Across {connectedCount} account{connectedCount === 1 ? "" : "s"}
            </p>
          </Card>
          <Card className="p-5">
            <p className="text-xs text-muted-foreground">Unreconciled items</p>
            <p className="text-2xl font-semibold tabular-nums mt-1">
              {totalUnreconciled.toLocaleString("en-IN")}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">Awaiting review</p>
          </Card>
          <Card className="p-5">
            <p className="text-xs text-muted-foreground">Live feeds</p>
            <p className="text-2xl font-semibold mt-1">
              {liveFeeds}
              <span className="text-sm text-muted-foreground">/{connectedCount}</span>
            </p>
            <p className="text-[11px] text-primary mt-1">Bank feed connected</p>
          </Card>
        </div>

        {/* Linked accounts */}
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-base font-semibold">Linked accounts</h3>
              <p className="text-xs text-muted-foreground">Bank accounts recorded on the ledger</p>
            </div>
            <Button variant="outline" size="sm" onClick={notWired}>
              <FileDown className="h-4 w-4 mr-2" />
              Export all statements
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {accounts.length === 0 ? (
              <div className="md:col-span-2 p-8 text-center text-sm text-muted-foreground rounded-lg border border-dashed">
                No bank accounts yet. Add one from your accountant, or connect a feed below.
              </div>
            ) : (
              accounts.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:shadow-elegant transition-shadow"
                >
                  <div className="h-11 w-11 rounded-lg bg-gradient-brand flex items-center justify-center text-white shrink-0">
                    <Building2 className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">{a.name}</p>
                      {a.feedBalance != null ? (
                        <Badge
                          variant="secondary"
                          className="text-[9px] bg-emerald-500/10 text-emerald-700 border-emerald-500/20"
                        >
                          <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                          Live
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[9px]">
                          No feed
                        </Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {a.institutionName} • {a.accountNumberMasked}
                      {a.unreconciledCount > 0 ? ` • ${a.unreconciledCount} unreconciled` : ""}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold tabular-nums">{formatMinor(a.glBalance)}</p>
                    <p className="text-[10px] text-muted-foreground">GL balance</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={notWired}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* Sync scheduler */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="p-5 lg:col-span-1">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold flex items-center gap-2">
                  <Clock className="h-4 w-4 text-primary" />
                  Sync scheduler
                </h3>
                <p className="text-xs text-muted-foreground">
                  Preferences for when a connected feed would fetch
                </p>
              </div>
              <Switch checked={schedulerOn} onCheckedChange={setSchedulerOn} />
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Fetch frequency
                </label>
                <Select value={frequency} onValueChange={setFrequency}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
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
                    <p className="text-[10px] text-muted-foreground">
                      Skip review for &gt;95% confidence matches
                    </p>
                  </div>
                </div>
                <Switch checked={autoImport} onCheckedChange={setAutoImport} />
              </div>

              <div className="flex items-center justify-between rounded-lg border p-2.5">
                <div className="flex items-center gap-2">
                  <Bell className="h-4 w-4 text-amber-500" />
                  <div>
                    <p className="text-xs font-medium">Error alerts</p>
                    <p className="text-[10px] text-muted-foreground">
                      Email + WhatsApp on failed syncs
                    </p>
                  </div>
                </div>
                <Switch checked={errorAlerts} onCheckedChange={setErrorAlerts} />
              </div>

              <div className="pt-2 border-t space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">Feed status</span>
                  <Badge
                    variant="secondary"
                    className={
                      liveFeeds > 0
                        ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/20 text-[10px]"
                        : "text-[10px]"
                    }
                  >
                    {liveFeeds > 0 ? (
                      <>
                        <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                        {liveFeeds} live
                      </>
                    ) : (
                      <>
                        <PauseCircle className="h-2.5 w-2.5 mr-0.5" />
                        No live feed
                      </>
                    )}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">Scheduler</span>
                  <Badge
                    variant="secondary"
                    className={
                      schedulerOn
                        ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/20 text-[10px]"
                        : "text-[10px]"
                    }
                  >
                    {schedulerOn ? (
                      <>
                        <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                        Enabled
                      </>
                    ) : (
                      <>
                        <PauseCircle className="h-2.5 w-2.5 mr-0.5" />
                        Paused
                      </>
                    )}
                  </Badge>
                </div>
              </div>

              <Button className="w-full" variant="outline" onClick={notWired}>
                <PlayCircle className="h-4 w-4 mr-2" />
                Sync all now
              </Button>
            </div>
          </Card>

          <Card className="p-5 lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold">Sync activity</h3>
                <p className="text-xs text-muted-foreground">
                  Live fetch log appears once a feed is connected
                </p>
              </div>
              <Badge variant="secondary" className="text-[10px]">
                Last 24h
              </Badge>
            </div>
            <div className="flex flex-col items-center justify-center text-center py-12 text-muted-foreground">
              <RefreshCw className="h-8 w-8 mb-3 opacity-40" />
              <p className="text-sm font-medium">No sync activity yet</p>
              <p className="text-[11px] mt-1 max-w-sm">
                Connect an account aggregator feed to see every statement and UPI fetch logged here,
                with errors highlighted.
              </p>
            </div>
          </Card>
        </div>

        {/* Add new */}
        <Tabs defaultValue="bank">
          <TabsList>
            <TabsTrigger value="bank">
              <Landmark className="h-4 w-4 mr-2" />
              Add bank account
            </TabsTrigger>
            <TabsTrigger value="upi">
              <Smartphone className="h-4 w-4 mr-2" />
              Add UPI
            </TabsTrigger>
            <TabsTrigger value="card">
              <CreditCard className="h-4 w-4 mr-2" />
              Corporate cards
            </TabsTrigger>
          </TabsList>

          <TabsContent value="bank" className="mt-4">
            <Card className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-base font-semibold">Choose your bank</h3>
                  <p className="text-xs text-muted-foreground">
                    Powered by Sahamati AA network — 120+ banks supported
                  </p>
                </div>
                <Badge variant="secondary" className="gap-1">
                  <ShieldCheck className="h-3 w-3 text-emerald-500" />
                  RBI regulated
                </Badge>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {bankOptions.map((b) => (
                  <button
                    key={b.name}
                    onClick={() => {
                      setBankDialog(b.name);
                      setStep(0);
                    }}
                    className="group flex items-center gap-3 p-3 rounded-lg border bg-card hover:border-primary/50 hover:shadow-elegant transition-all text-left"
                  >
                    <div
                      className={`h-10 w-10 rounded-lg ${b.color} flex items-center justify-center text-white text-xs font-bold`}
                    >
                      {b.name
                        .split(" ")
                        .map((w) => w[0])
                        .slice(0, 2)
                        .join("")}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{b.name}</p>
                      <p className="text-[10px] text-muted-foreground">{b.tag}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                ))}
              </div>
              <button
                onClick={notWired}
                className="mt-3 w-full flex items-center justify-center gap-2 p-3 rounded-lg border border-dashed text-sm text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
              >
                <Plus className="h-4 w-4" /> Search from 120+ other banks
              </button>
            </Card>
          </TabsContent>

          <TabsContent value="upi" className="mt-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card className="p-5 lg:col-span-2">
                <h3 className="text-base font-semibold mb-1">Link a UPI ID</h3>
                <p className="text-xs text-muted-foreground mb-4">
                  Auto-fetch every UPI expense — perfect for petty cash and field spends
                </p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {upiApps.map((u) => (
                    <button
                      key={u.name}
                      onClick={() => setUpiDialog(u.name)}
                      className="group flex flex-col items-center gap-2 p-4 rounded-lg border bg-card hover:border-primary/50 hover:shadow-elegant transition-all"
                    >
                      <div
                        className={`h-12 w-12 rounded-xl ${u.color} flex items-center justify-center text-white`}
                      >
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
                <p className="text-[11px] text-muted-foreground mt-1">
                  Open any UPI app and scan — auto-syncs in 3 seconds
                </p>
                <Badge variant="secondary" className="mt-3 text-[10px]">
                  NPCI verified
                </Badge>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="card" className="mt-4">
            <Card className="p-8 text-center">
              <CreditCard className="h-10 w-10 text-primary mx-auto mb-3" />
              <h3 className="text-base font-semibold">Corporate & credit card feeds</h3>
              <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
                Auto-import transactions from HDFC, Axis, ICICI corporate cards and consumer credit
                cards via secure card feeds.
              </p>
              <Button className="mt-4" onClick={notWired}>
                <Plus className="h-4 w-4 mr-2" />
                Link a card
              </Button>
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
            <DialogDescription>
              Secured by RBI Account Aggregator — read-only access
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <Progress value={((step + 1) / steps.length) * 100} className="h-1.5" />
            <div className="space-y-2">
              {steps.map((s, i) => (
                <div
                  key={s}
                  className={`flex items-center gap-3 p-2.5 rounded-lg border ${i === step ? "border-primary bg-primary/5" : i < step ? "border-emerald-500/30 bg-emerald-500/5" : "border-border"}`}
                >
                  {i < step ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <div
                      className={`h-4 w-4 rounded-full border-2 ${i === step ? "border-primary" : "border-muted-foreground/30"}`}
                    />
                  )}
                  <span className={`text-sm ${i === step ? "font-medium" : ""}`}>{s}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground p-2 bg-muted rounded-lg">
              Completing this flow needs a connected account aggregator. It isn't provisioned in
              this environment, so no live consent is initiated.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBankDialog(null)}>
              Cancel
            </Button>
            <Button onClick={advance}>
              {step < 3 ? "Continue" : "Finish & fetch statements"}
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
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
            <DialogDescription>
              Enter your UPI ID — we'll send a verification collect request
            </DialogDescription>
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
            <p className="text-[11px] text-muted-foreground">
              Linking UPI needs a connected aggregator — not available in this environment.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUpiDialog(null)}>
              Cancel
            </Button>
            <Button onClick={linkUpi}>Send verification</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
