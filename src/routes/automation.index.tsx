import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Zap, GitBranch, Mail, Clock, ChevronRight, Plus, CheckCircle2, AlertCircle,
  Play, RotateCcw, Loader2, Terminal,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/automation/")({ component: Automation });

const flows = [
  { name: "Overdue Invoice Reminder", trigger: "Invoice overdue > 3 days", action: "Send email + Slack", runs: 148, active: true },
  { name: "Large Bill Approval", trigger: "Bill amount > ₹1L", action: "Route to CFO approval", runs: 42, active: true },
  { name: "Low Stock Purchase", trigger: "Stock < reorder point", action: "Create draft PO", runs: 18, active: true },
  { name: "Customer Onboarding", trigger: "New customer created", action: "Welcome + KYC email", runs: 86, active: true },
  { name: "Weekly CFO Digest", trigger: "Every Monday 9 AM", action: "Email KPI summary", runs: 12, active: false },
];

type LogEntry = {
  ts: string;
  level: "trigger" | "condition" | "action" | "info" | "success" | "warn";
  msg: string;
  detail?: string;
};

const script: Omit<LogEntry, "ts">[] = [
  { level: "info", msg: "Workflow invoked", detail: "Overdue Invoice Reminder · manual simulation" },
  { level: "trigger", msg: "TRIGGER fired", detail: "cron:hourly · scanning 184 open invoices" },
  { level: "info", msg: "Query executed", detail: "SELECT * FROM invoices WHERE status='overdue' — 27 rows in 42ms" },
  { level: "condition", msg: "CONDITION evaluated", detail: "days_overdue > 3 AND balance > ₹10,000 → 9 matching invoices" },
  { level: "info", msg: "Loading customer contacts", detail: "9 recipients resolved from CRM" },
  { level: "action", msg: "ACTION dispatched", detail: "template=polite_reminder_v2 · channel=email + slack" },
  { level: "info", msg: "Rendering templates", detail: "9 personalised messages · GST-compliant footer" },
  { level: "success", msg: "8 emails delivered", detail: "SendGrid 202 · avg latency 312ms" },
  { level: "warn", msg: "1 delivery deferred", detail: "invoice INV-2087 · retry scheduled in 15m" },
  { level: "action", msg: "Escalation queued", detail: "INV-2039 unpaid 7+ days → Account Manager notified" },
  { level: "success", msg: "Workflow completed", detail: "9 processed · 8 succeeded · 1 retry · total 1.42s" },
];

const levelStyles: Record<LogEntry["level"], string> = {
  trigger: "text-brand",
  condition: "text-warning-foreground",
  action: "text-blue-400",
  info: "text-muted-foreground",
  success: "text-success",
  warn: "text-warning",
};

function Automation() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [stepIdx, setStepIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [logs]);

  const simulate = () => {
    setLogs([]);
    setRunning(true);
    setStepIdx(0);
    script.forEach((entry, i) => {
      setTimeout(() => {
        const now = new Date();
        const ts = now.toTimeString().slice(0, 8) + "." + String(now.getMilliseconds()).padStart(3, "0");
        setLogs((prev) => [...prev, { ...entry, ts }]);
        // update pipeline stage marker
        if (entry.level === "trigger") setStepIdx(0);
        if (entry.level === "condition") setStepIdx(1);
        if (entry.level === "action") setStepIdx(2);
        if (i === script.length - 1) {
          setStepIdx(3);
          setRunning(false);
        }
      }, i * 550);
    });
  };

  const reset = () => {
    setLogs([]);
    setStepIdx(null);
    setRunning(false);
  };

  const stages = [
    { label: "Trigger", icon: Zap, tone: "brand" },
    { label: "Condition", icon: GitBranch, tone: "warning" },
    { label: "Action", icon: Mail, tone: "success" },
    { label: "Escalate", icon: Clock, tone: "destructive" },
  ];

  return (
    <>
      <PageHeader title="Workflow Automation" subtitle="Visual builder for approvals, notifications & escalations"
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={reset} disabled={running || logs.length === 0}>
              <RotateCcw className="h-4 w-4 mr-1.5" /> Reset
            </Button>
            <Button size="sm" onClick={simulate} disabled={running} className="bg-gradient-brand text-white shadow-glow">
              {running ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Play className="h-4 w-4 mr-1.5" />}
              {running ? "Simulating…" : "Simulate Run"}
            </Button>
            <Button size="sm" variant="outline"><Plus className="h-4 w-4 mr-1.5" />New Workflow</Button>
          </div>
        } />
      <div className="p-6 space-y-6">
        {/* Visual builder canvas */}
        <Card className="p-6 bg-gradient-to-br from-muted/40 to-transparent">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold">Overdue Invoice Reminder</h3>
              <p className="text-xs text-muted-foreground">Auto-generated draft · last edited 2h ago</p>
            </div>
            <div className="flex items-center gap-2">
              {running && (
                <Badge className="bg-brand text-white gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Running
                </Badge>
              )}
              <Badge className="bg-success text-success-foreground">Active</Badge>
            </div>
          </div>
          <div className="flex items-center gap-3 overflow-x-auto pb-2">
            {stages.map((s, i) => {
              const active = stepIdx !== null && stepIdx >= i;
              const current = stepIdx === i && running;
              const toneBorder = {
                brand: "border-brand/40", warning: "border-warning/40",
                success: "border-success/40", destructive: "border-destructive/40",
              }[s.tone];
              const toneText = {
                brand: "text-brand", warning: "text-warning-foreground",
                success: "text-success", destructive: "text-destructive",
              }[s.tone];
              const details = [
                ["Invoice status = Overdue", "Every hour"],
                ["Days overdue > 3", "AND balance > ₹10K"],
                ["Send email reminder", "Template: Polite Reminder v2"],
                ["If unpaid in 7 days", "→ Notify Account Manager"],
              ][i];
              return (
                <Fragment key={s.label}>
                  <Card
                    className={`p-4 min-w-[220px] transition-all ${toneBorder} ${
                      active ? "shadow-elegant" : "opacity-70"
                    } ${current ? "ring-2 ring-brand/50 scale-[1.02]" : ""}`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <s.icon className={`h-4 w-4 ${toneText}`} />
                      <span className={`text-xs uppercase tracking-widest font-medium ${toneText}`}>{s.label}</span>
                      {active && !current && <CheckCircle2 className="h-3.5 w-3.5 text-success ml-auto" />}
                      {current && <Loader2 className="h-3.5 w-3.5 text-brand ml-auto animate-spin" />}
                    </div>
                    <p className="text-sm font-medium">{details[0]}</p>
                    <p className="text-xs text-muted-foreground mt-1">{details[1]}</p>
                  </Card>
                  {i < stages.length - 1 && (
                    <ChevronRight
                      className={`h-5 w-5 flex-shrink-0 transition-colors ${
                        stepIdx !== null && stepIdx > i ? "text-brand" : "text-muted-foreground"
                      }`}
                    />
                  )}
                </Fragment>
              );
            })}
          </div>
        </Card>

        {/* Live log console */}
        <Card className="overflow-hidden border-primary/20">
          <div className="flex items-center justify-between bg-primary text-primary-foreground px-4 py-2.5">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4" />
              <span className="text-sm font-medium">Execution Log</span>
              <Badge variant="secondary" className="text-[10px]">real-time</Badge>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] font-mono opacity-80">
              <span className={`h-2 w-2 rounded-full ${running ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/50"}`} />
              {running ? "streaming" : logs.length > 0 ? "completed" : "idle"}
            </div>
          </div>
          <div
            ref={scrollRef}
            className="h-64 overflow-y-auto bg-[oklch(0.15_0.02_255)] text-slate-200 font-mono text-[12px] p-4 space-y-1"
          >
            {logs.length === 0 && !running && (
              <div className="text-slate-500 italic">
                Press <span className="text-brand">Simulate Run</span> to execute this workflow and stream trigger → condition → action logs here.
              </div>
            )}
            {logs.map((l, i) => (
              <div key={i} className="flex gap-3 animate-in fade-in slide-in-from-left-2 duration-200">
                <span className="text-slate-500 tabular-nums shrink-0">{l.ts}</span>
                <span className={`uppercase tracking-wider text-[10px] font-semibold shrink-0 w-20 ${levelStyles[l.level]}`}>
                  {l.level}
                </span>
                <span className="flex-1">
                  <span className="text-slate-100">{l.msg}</span>
                  {l.detail && <span className="text-slate-400"> — {l.detail}</span>}
                </span>
              </div>
            ))}
            {running && (
              <div className="flex gap-3 text-slate-500 items-center">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>awaiting next event…</span>
              </div>
            )}
          </div>
        </Card>

        <div>
          <h3 className="font-semibold mb-3">All Workflows</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {flows.map((f) => (
              <Card key={f.name} className="p-4 hover:shadow-elegant transition-all">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      {f.active ? <CheckCircle2 className="h-4 w-4 text-success" /> : <AlertCircle className="h-4 w-4 text-muted-foreground" />}
                      <p className="font-medium text-sm">{f.name}</p>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
                      <p><span className="text-brand">When</span> {f.trigger}</p>
                      <p><span className="text-brand">Do</span> {f.action}</p>
                    </div>
                  </div>
                  <Badge variant="secondary">{f.runs} runs</Badge>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
