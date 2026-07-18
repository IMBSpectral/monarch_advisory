import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Presentation, ChevronLeft, ChevronRight, X, Play, Sparkles,
} from "lucide-react";

type Step = {
  route: string;
  title: string;
  narration: string;
  highlights: { label: string; value: string }[];
  tag: string;
};

const steps: Step[] = [
  {
    route: "/",
    tag: "01 · Executive Dashboard",
    title: "One command center for the entire business",
    narration:
      "Monarch unifies accounting, sales, inventory and cash into a single real-time view. Every KPI on this screen is computed from live transactions — no spreadsheets, no month-end scramble.",
    highlights: [
      { label: "MTD Revenue", value: "₹1.24 Cr" },
      { label: "Net Profit", value: "₹38.6L" },
      { label: "Cash on Hand", value: "₹2.14 Cr" },
    ],
  },
  {
    route: "/ai",
    tag: "02 · AI Foundation",
    title: "An AI CFO that actually understands your books",
    narration:
      "Our AI agents ingest journals, invoices and bank feeds to answer natural-language questions, forecast cash and auto-categorise expenses. This is our core moat versus legacy accounting tools.",
    highlights: [
      { label: "AI Agents Live", value: "6" },
      { label: "Auto-categorised", value: "94%" },
      { label: "Time saved / mo", value: "72 hrs" },
    ],
  },
  {
    route: "/sales/invoices",
    tag: "03 · Sales & Invoicing",
    title: "GST-ready invoicing with one-tap collections",
    narration:
      "Create, send and reconcile invoices in seconds. Payment reminders, IRN generation and multi-currency are built-in — the same workflow that costs ₹15K/mo across three SaaS tools today.",
    highlights: [
      { label: "Open Invoices", value: "184" },
      { label: "Avg Collection", value: "22 days" },
      { label: "Auto-reminders", value: "On" },
    ],
  },
  {
    route: "/inventory",
    tag: "04 · Multi-warehouse Inventory",
    title: "Stock intelligence across every location",
    narration:
      "Real-time stock levels, reorder points and batch tracking across warehouses. Inventory writes directly to the ledger — no reconciliation gap between ops and finance.",
    highlights: [
      { label: "SKUs Tracked", value: "1,842" },
      { label: "Warehouses", value: "4" },
      { label: "Stock Value", value: "₹94.2L" },
    ],
  },
  {
    route: "/pos",
    tag: "05 · Point of Sale",
    title: "Retail POS that syncs to the same ledger",
    narration:
      "The same platform powers offline retail with a lightning-fast POS. Every sale updates inventory, GST liability and revenue instantly — no nightly batch jobs.",
    highlights: [
      { label: "Terminals", value: "12" },
      { label: "Today's Sales", value: "₹4.8L" },
      { label: "Avg Ticket", value: "₹1,240" },
    ],
  },
  {
    route: "/banking",
    tag: "06 · Banking & Reconciliation",
    title: "Auto-matched bank transactions",
    narration:
      "Connected bank feeds are matched to invoices and bills with 92% accuracy. What used to take an accountant a week now takes fifteen minutes of review.",
    highlights: [
      { label: "Auto-matched", value: "92%" },
      { label: "Accounts Linked", value: "7" },
      { label: "Unreconciled", value: "23" },
    ],
  },
  {
    route: "/automation",
    tag: "07 · Workflow Automation",
    title: "No-code automations for finance ops",
    narration:
      "Trigger-condition-action workflows replace the manual chase — approvals, dunning, GST filing reminders. Customers activate 8 workflows on average in week one.",
    highlights: [
      { label: "Active Workflows", value: "24" },
      { label: "Runs / month", value: "3,412" },
      { label: "Success Rate", value: "99.4%" },
    ],
  },
  {
    route: "/accounting/gst",
    tag: "08 · Compliance",
    title: "GST filing on autopilot",
    narration:
      "GSTR-1, 3B and 9 pre-computed from live data with reconciliation against the GSTN portal. Compliance is where SMBs bleed — Monarch turns it into a one-click flow.",
    highlights: [
      { label: "Returns Filed", value: "36 / 36" },
      { label: "Notices Avoided", value: "12" },
      { label: "ITC Reclaimed", value: "₹6.2L" },
    ],
  },
  {
    route: "/",
    tag: "09 · The Ask",
    title: "Ready to scale — join us",
    narration:
      "Monarch replaces 5–7 tools for Indian SMBs at a third of the cost, with AI-native workflows built for the next decade. We're raising to accelerate go-to-market across 50 cities.",
    highlights: [
      { label: "Pilot Customers", value: "42" },
      { label: "ARR Committed", value: "₹1.8 Cr" },
      { label: "Raise", value: "$3M Seed" },
    ],
  },
];

export function InvestorTour() {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const navigate = useNavigate();
  const step = steps[idx];

  useEffect(() => {
    if (!open) return;
    navigate({ to: step.route });
  }, [open, idx, step.route, navigate]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setIdx((i) => Math.min(i + 1, steps.length - 1));
      if (e.key === "ArrowLeft") setIdx((i) => Math.max(i - 1, 0));
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) {
    return (
      <Button
        onClick={() => { setIdx(0); setOpen(true); }}
        size="sm"
        variant="outline"
        className="fixed bottom-5 right-5 z-40 gap-1.5 shadow-elegant bg-background/95 backdrop-blur border-brand/30 hover:border-brand"
      >
        <Presentation className="h-4 w-4 text-brand" />
        <span className="font-medium">Investor Tour</span>
      </Button>
    );
  }

  const isLast = idx === steps.length - 1;
  const isFirst = idx === 0;

  return (
    <>
      {/* Dim backdrop that lets the page peek through */}
      <div
        className="fixed inset-0 z-40 bg-primary/40 backdrop-blur-[2px] pointer-events-none"
        aria-hidden
      />
      {/* Floating narration card */}
      <div className="fixed bottom-6 right-6 z-50 w-[min(440px,calc(100vw-3rem))] animate-in fade-in slide-in-from-bottom-4 duration-300">
        <div className="rounded-2xl border border-brand/30 bg-background shadow-elegant overflow-hidden">
          <div className="bg-gradient-brand px-5 py-3 flex items-center justify-between text-white">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              <span className="text-[11px] uppercase tracking-widest font-medium opacity-90">
                {step.tag}
              </span>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-full p-1 hover:bg-white/15 transition"
              aria-label="Close tour"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-5 space-y-4">
            <div>
              <h3 className="text-lg font-semibold leading-snug tracking-tight">
                {step.title}
              </h3>
              <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                {step.narration}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {step.highlights.map((h) => (
                <div
                  key={h.label}
                  className="rounded-lg border bg-gradient-to-br from-brand/5 to-transparent px-2.5 py-2"
                >
                  <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium truncate">
                    {h.label}
                  </p>
                  <p className="text-sm font-semibold tabular-nums mt-0.5">{h.value}</p>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {steps.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setIdx(i)}
                  className={`h-1.5 rounded-full transition-all ${
                    i === idx ? "w-6 bg-brand" : "w-1.5 bg-muted hover:bg-muted-foreground/40"
                  }`}
                  aria-label={`Go to step ${i + 1}`}
                />
              ))}
              <Badge variant="secondary" className="ml-auto text-[10px]">
                {idx + 1} / {steps.length}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOpen(false)}
                className="text-muted-foreground"
              >
                Skip tour
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isFirst}
                  onClick={() => setIdx((i) => Math.max(i - 1, 0))}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" /> Back
                </Button>
                {isLast ? (
                  <Button
                    size="sm"
                    onClick={() => setOpen(false)}
                    className="bg-gradient-brand text-white"
                  >
                    <Play className="h-4 w-4 mr-1" /> Finish
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => setIdx((i) => Math.min(i + 1, steps.length - 1))}
                    className="bg-gradient-brand text-white"
                  >
                    Next <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
        <p className="text-[10px] text-center text-white/70 mt-2 tracking-wide">
          Use ← → to navigate · Esc to close
        </p>
      </div>
    </>
  );
}
