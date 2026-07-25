import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sparkles,
  Send,
  Brain,
  TrendingUp,
  AlertTriangle,
  FileCheck,
  MessageSquare,
  Cpu,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useState } from "react";
import { toast } from "sonner";
import { cashForecast, inr } from "@/data/mock";
import { useSession } from "@/components/SessionContext";

export const Route = createFileRoute("/ai/")({ component: AI });

type ChatMessage = { role: "user" | "assistant"; text: string };

const ASSISTANT_REPLY =
  "I'm a preview assistant — live AI analysis connects to the ledger in production.";

function AI() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const session = useSession();
  // Greet the actual signed-in user, not a hardcoded demo persona.
  const firstName = session?.name?.trim().split(/\s+/)[0] || "there";

  const send = () => {
    const text = input.trim();
    if (!text) return;
    setMessages((prev) => [
      ...prev,
      { role: "user", text },
      { role: "assistant", text: ASSISTANT_REPLY },
    ]);
    setInput("");
  };

  return (
    <>
      <PageHeader title="AI Foundation" subtitle="Chat, AI Accountant, AI CFO & Knowledge Base" />
      <div className="p-6 grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4">
        <div className="space-y-4">
          {/* Chat surface */}
          <Card className="p-0 overflow-hidden">
            <div className="p-4 border-b bg-gradient-to-r from-brand/5 to-transparent flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-brand shadow-glow">
                <Sparkles className="h-4 w-4 text-white" />
              </div>
              <div>
                <p className="font-semibold text-sm">Monarch AI Assistant</p>
                <p className="text-xs text-muted-foreground">
                  GPT-4.1 · Fine-tuned on Indian accounting
                </p>
              </div>
              <Badge className="ml-auto bg-success text-success-foreground">Online</Badge>
            </div>
            <div className="p-4 space-y-4 min-h-[420px]">
              <div>
                <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-muted px-4 py-3 text-sm">
                  Hi {firstName} 👋 I've reviewed today's activity. Ask me anything about your
                  books, cash position, or vendors.
                </div>
              </div>
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-primary px-4 py-3 text-sm text-primary-foreground">
                  Which invoices are overdue and by how much?
                </div>
              </div>
              <div>
                <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-muted px-4 py-3 text-sm space-y-2">
                  <p>
                    You have <span className="font-semibold">2 overdue invoices</span> totaling{" "}
                    <span className="font-semibold">₹2,57,400</span>:
                  </p>
                  <ul className="text-xs space-y-1 pl-2">
                    <li>• INV-2026-0145 — Zomato Ltd — ₹89,400 (3 days late)</li>
                    <li>• INV-2026-0140 — Myntra Designs — ₹1,68,000 (5 days late)</li>
                  </ul>
                  <div className="flex gap-2 pt-2">
                    <Button
                      size="sm"
                      className="bg-gradient-brand text-white h-7 text-xs"
                      onClick={() =>
                        toast.info(
                          "Preview action — reminder dispatch connects to the ledger in production.",
                        )
                      }
                    >
                      Send Reminders
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() =>
                        toast.info(
                          "Preview action — invoice drill-down connects to the ledger in production.",
                        )
                      }
                    >
                      View Details
                    </Button>
                  </div>
                </div>
              </div>
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-primary px-4 py-3 text-sm text-primary-foreground">
                  Forecast next 6 months cash position
                </div>
              </div>
              <div>
                <div className="max-w-[95%] rounded-2xl rounded-tl-sm bg-muted p-4">
                  <p className="text-sm mb-3">
                    Based on trailing 90-day trends and confirmed pipeline, here's your cash
                    forecast:
                  </p>
                  <ResponsiveContainer width="100%" height={160}>
                    <AreaChart data={cashForecast}>
                      <defs>
                        <linearGradient id="ai-g" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="oklch(0.55 0.14 165)" stopOpacity={0.4} />
                          <stop offset="100%" stopColor="oklch(0.55 0.14 165)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="oklch(0.92 0.01 255)"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="m"
                        tick={{ fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`}
                      />
                      <Tooltip formatter={(v: number) => inr(v)} />
                      <Area
                        type="monotone"
                        dataKey="forecast"
                        stroke="oklch(0.55 0.14 165)"
                        strokeWidth={2}
                        fill="url(#ai-g)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                  <p className="text-xs text-muted-foreground mt-2">
                    Projected to reach <span className="font-semibold text-brand">₹83L</span> by
                    July. Confidence 87%. <span className="italic">Sample forecast.</span>
                  </p>
                </div>
              </div>
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-primary px-4 py-3 text-sm text-primary-foreground">
                      {m.text}
                    </div>
                  </div>
                ) : (
                  <div key={i}>
                    <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-muted px-4 py-3 text-sm">
                      {m.text}
                    </div>
                  </div>
                ),
              )}
            </div>
            <form
              className="border-t p-3 flex gap-2 bg-background"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <Input
                placeholder="Ask about your business…"
                className="bg-muted/40"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
              <Button type="submit" className="bg-gradient-brand text-white">
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <Brain className="h-4 w-4 text-brand" />
              <h3 className="font-semibold text-sm">AI Agents</h3>
            </div>
            {[
              {
                i: FileCheck,
                n: "AI Accountant",
                d: "Auto-categorizes 94% of transactions",
                s: "18 pending review",
              },
              {
                i: TrendingUp,
                n: "AI CFO",
                d: "Weekly digest + variance alerts",
                s: "Next run: Monday 9 AM",
              },
              {
                i: MessageSquare,
                n: "Chat Assistant",
                d: "Natural language ERP queries",
                s: "412 queries this week",
              },
              {
                i: AlertTriangle,
                n: "Anomaly Detector",
                d: "Flags unusual spend patterns",
                s: "2 alerts today",
              },
            ].map((a) => (
              <div key={a.n} className="flex items-start gap-3 py-3 border-b last:border-0">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-brand">
                  <a.i className="h-4 w-4 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{a.n}</p>
                  <p className="text-xs text-muted-foreground">{a.d}</p>
                  <p className="text-xs text-brand mt-0.5">{a.s}</p>
                </div>
              </div>
            ))}
          </Card>
          <Card className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <Cpu className="h-4 w-4 text-brand" />
              <h3 className="font-semibold text-sm">Usage — This Month</h3>
            </div>
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span>Queries</span>
                  <span className="tabular-nums">1,842 / 10,000</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-gradient-brand" style={{ width: "18%" }} />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span>Tokens</span>
                  <span className="tabular-nums">2.4M / 20M</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-gradient-brand" style={{ width: "12%" }} />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span>Automations</span>
                  <span className="tabular-nums">306 runs</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-gradient-gold" style={{ width: "34%" }} />
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
