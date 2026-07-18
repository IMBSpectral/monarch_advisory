import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Building2, Users, Shield, Receipt, Coins, Globe, Plug, Bell, Palette } from "lucide-react";

export const Route = createFileRoute("/settings/")({ component: Settings });

const roles = [
  { r: "Admin", u: 3, perms: "Full access" },
  { r: "CFO", u: 1, perms: "All finance + reports" },
  { r: "Accountant", u: 4, perms: "Journals, invoices, bills" },
  { r: "Sales Manager", u: 6, perms: "CRM, quotes, invoices" },
  { r: "Warehouse", u: 8, perms: "Inventory, POs, GRN" },
  { r: "Viewer", u: 12, perms: "Read-only dashboards" },
];

const integrations = [
  { n: "Razorpay", d: "Payment gateway", c: true },
  { n: "Slack", d: "Notifications", c: true },
  { n: "Google Workspace", d: "SSO + Drive sync", c: true },
  { n: "Shopify", d: "E-commerce orders", c: false },
  { n: "Zoho CRM", d: "Contact sync", c: false },
  { n: "Tally Prime", d: "Legacy import", c: false },
];

function Settings() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Organization, users, taxes, and integrations" />
      <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4"><Building2 className="h-4 w-4 text-brand" /><h3 className="font-semibold">Organization</h3></div>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between border-b pb-2"><span className="text-muted-foreground">Legal Name</span><span className="font-medium">IMB Labs LLP</span></div>
            <div className="flex justify-between border-b pb-2"><span className="text-muted-foreground">GSTIN</span><span className="font-mono text-xs">27AABCI1234N1Z5</span></div>
            <div className="flex justify-between border-b pb-2"><span className="text-muted-foreground">PAN</span><span className="font-mono text-xs">AABCI1234N</span></div>
            <div className="flex justify-between border-b pb-2"><span className="text-muted-foreground">Base Currency</span><span>INR (₹)</span></div>
            <div className="flex justify-between border-b pb-2"><span className="text-muted-foreground">Fiscal Year</span><span>Apr – Mar</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Branches</span><span>4 active</span></div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4"><Shield className="h-4 w-4 text-brand" /><h3 className="font-semibold">Roles & Access (RBAC)</h3></div>
          <div className="space-y-2">
            {roles.map((r) => (
              <div key={r.r} className="flex items-center justify-between py-1.5 border-b last:border-0 text-sm">
                <div>
                  <p className="font-medium">{r.r}</p>
                  <p className="text-xs text-muted-foreground">{r.perms}</p>
                </div>
                <Badge variant="secondary">{r.u} users</Badge>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4"><Plug className="h-4 w-4 text-brand" /><h3 className="font-semibold">Integrations</h3></div>
          <div className="grid grid-cols-2 gap-2">
            {integrations.map((i) => (
              <div key={i.n} className="flex items-center justify-between p-3 rounded-lg border">
                <div>
                  <p className="text-sm font-medium">{i.n}</p>
                  <p className="text-[10px] text-muted-foreground">{i.d}</p>
                </div>
                <Switch defaultChecked={i.c} />
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4"><Receipt className="h-4 w-4 text-brand" /><h3 className="font-semibold">Tax & Currencies</h3></div>
          <div className="space-y-2 text-sm">
            {[
              { l: "GST 18% (Standard)", d: "Default output tax" },
              { l: "GST 12%", d: "Reduced rate" },
              { l: "GST 5%", d: "Essential goods" },
              { l: "IGST 18%", d: "Inter-state" },
              { l: "TDS 194J @ 10%", d: "Professional services" },
            ].map((t) => (
              <div key={t.l} className="flex items-center justify-between py-1.5 border-b last:border-0">
                <div><p className="font-medium">{t.l}</p><p className="text-xs text-muted-foreground">{t.d}</p></div>
                <Badge variant="outline" className="bg-success/10 text-success border-success/20">Active</Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
