import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles, Send, TrendingUp, AlertTriangle, Wand2, BarChart3 } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";

const suggestions = [
  "Show me overdue invoices",
  "Forecast next month cash flow",
  "Which customers owe the most?",
  "Top 5 selling items this quarter",
];

const messages = [
  { role: "user" as const, text: "What's my cash runway?" },
  {
    role: "ai" as const,
    text: "Based on current burn (₹47L/mo) and cash of ₹1.84 Cr, your runway is ~11.4 months. Inflows are trending +12%, extending forecast to 14+ months by Sep.",
  },
];

export function AIAssistant({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg p-0 flex flex-col">
        <SheetHeader className="border-b p-4">
          <SheetTitle className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-brand shadow-glow">
              <Sparkles className="h-4 w-4 text-white" />
            </div>
            Monarch AI
          </SheetTitle>
        </SheetHeader>
        <Tabs defaultValue="chat" className="flex-1 flex flex-col min-h-0">
          <TabsList className="mx-4 mt-3 grid grid-cols-3">
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="accountant">AI Accountant</TabsTrigger>
            <TabsTrigger value="cfo">AI CFO</TabsTrigger>
          </TabsList>
          <TabsContent value="chat" className="flex-1 flex flex-col min-h-0 mt-0">
            <div className="flex-1 overflow-auto p-4 space-y-4">
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                  <div className={m.role === "user"
                    ? "max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground"
                    : "max-w-[90%] rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-sm"}>
                    {m.text}
                  </div>
                </div>
              ))}
              <div className="grid grid-cols-2 gap-2 pt-2">
                {suggestions.map((s) => (
                  <button key={s} className="rounded-lg border bg-card px-3 py-2 text-left text-xs hover:border-brand hover:shadow-elegant transition-all">
                    <Sparkles className="h-3 w-3 text-brand inline mr-1.5" />{s}
                  </button>
                ))}
              </div>
            </div>
            <div className="border-t p-3 flex gap-2">
              <Input placeholder="Ask about your business…" className="bg-muted/40" />
              <Button size="icon" className="bg-gradient-brand"><Send className="h-4 w-4" /></Button>
            </div>
          </TabsContent>
          <TabsContent value="accountant" className="flex-1 overflow-auto p-4 space-y-3 mt-0">
            <Card className="p-4">
              <div className="flex items-start gap-3">
                <Wand2 className="h-5 w-5 text-brand mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Auto-journal ready</p>
                  <p className="text-xs text-muted-foreground mt-1">18 bank transactions categorized. Review 3 flagged entries before posting.</p>
                  <Button size="sm" variant="outline" className="mt-2">Review entries</Button>
                </div>
              </div>
            </Card>
            <Card className="p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-warning mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Anomaly detected</p>
                  <p className="text-xs text-muted-foreground mt-1">AWS spend up 22% vs 3-month average. Cause: EC2 spot instances in ap-south-1.</p>
                </div>
              </div>
            </Card>
            <Card className="p-4">
              <div className="flex items-start gap-3">
                <TrendingUp className="h-5 w-5 text-success mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Reconciliation suggestion</p>
                  <p className="text-xs text-muted-foreground mt-1">Match NEFT ₹2,85,000 with INV-2026-0148 (Reliance Retail). Confidence 98%.</p>
                  <Button size="sm" className="mt-2 bg-gradient-brand">Auto-match</Button>
                </div>
              </div>
            </Card>
          </TabsContent>
          <TabsContent value="cfo" className="flex-1 overflow-auto p-4 space-y-3 mt-0">
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <BarChart3 className="h-4 w-4 text-brand" />
                <p className="text-sm font-medium">CFO Narrative — Jan 2026</p>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Revenue grew <span className="text-foreground font-medium">12.4% MoM</span> to ₹6.8 Cr, driven by Peripherals (+28%) and Displays (+18%). Gross margin held at 42.3%. Operating cash flow of ₹2.1 Cr is strong; recommend deploying ₹80L into 90-day FD ladder. Watch: AR days rose to 41 (from 34) — trigger collection cadence on top-3 debtors.
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-sm font-medium mb-3">Budget variance</p>
              <div className="space-y-2 text-sm">
                {[
                  { k: "Marketing", v: "₹3.12L", d: "+8% over budget", warn: true },
                  { k: "Salaries", v: "₹89.4L", d: "on plan" },
                  { k: "Cloud & SaaS", v: "₹20.05L", d: "+22% over budget", warn: true },
                  { k: "Rent", v: "₹26.8L", d: "on plan" },
                ].map((r) => (
                  <div key={r.k} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{r.k}</span>
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums">{r.v}</span>
                      <span className={r.warn ? "text-warning text-xs" : "text-success text-xs"}>{r.d}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
