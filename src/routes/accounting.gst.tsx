import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, Download } from "lucide-react";
import { inr } from "@/data/mock";

export const Route = createFileRoute("/accounting/gst")({ component: GST });

const returns = [
  { name: "GSTR-1", desc: "Outward supplies", due: "Aug 11", status: "Ready", amount: 1840000 },
  { name: "GSTR-3B", desc: "Monthly summary", due: "Aug 20", status: "Draft", amount: 720000 },
  { name: "GSTR-2B", desc: "Auto-drafted ITC", due: "—", status: "Reconciled", amount: 620000 },
  { name: "GSTR-9", desc: "Annual return", due: "Dec 31", status: "Pending", amount: 0 },
];

const summary = [
  { l: "Output CGST", v: 920000 },
  { l: "Output SGST", v: 920000 },
  { l: "Output IGST", v: 0 },
  { l: "Input CGST", v: 310000 },
  { l: "Input SGST", v: 310000 },
  { l: "Input IGST", v: 0 },
  { l: "Net Payable", v: 1220000, hi: true },
];

function GST() {
  return (
    <>
      <PageHeader title="GST Returns" subtitle="Automated filing across GSTR-1, 3B, 2B & 9" />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {returns.map((r) => (
            <Card key={r.name} className="p-5">
              <div className="flex items-start justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-brand"><FileText className="h-4 w-4 text-white" /></div>
                <Badge variant={r.status === "Ready" ? "default" : "secondary"} className={r.status === "Ready" ? "bg-success text-success-foreground" : ""}>{r.status}</Badge>
              </div>
              <p className="font-semibold mt-3">{r.name}</p>
              <p className="text-xs text-muted-foreground">{r.desc}</p>
              <p className="text-sm text-muted-foreground mt-2">Due: <span className="text-foreground font-medium">{r.due}</span></p>
              {r.amount > 0 && <p className="text-lg font-semibold tabular-nums mt-1">{inr(r.amount)}</p>}
            </Card>
          ))}
        </div>
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold">GST Summary — July 2026</h3>
              <p className="text-xs text-muted-foreground">Ready to file GSTR-3B</p>
            </div>
            <Button size="sm" className="bg-gradient-brand text-white"><Download className="h-4 w-4 mr-1.5" />Download</Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
            {summary.map((s) => (
              <div key={s.l} className={`flex justify-between py-2 px-3 rounded-lg ${s.hi ? "bg-gradient-to-r from-brand/10 to-transparent border border-brand/20" : "border-b"}`}>
                <span className={s.hi ? "font-semibold" : "text-muted-foreground"}>{s.l}</span>
                <span className={`tabular-nums ${s.hi ? "font-bold text-brand" : ""}`}>{inr(s.v)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
