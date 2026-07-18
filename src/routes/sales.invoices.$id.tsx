import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Send, Download, Printer, CreditCard, Copy, Crown } from "lucide-react";
import { invoices, inr, inrFull, company } from "@/data/mock";

export const Route = createFileRoute("/sales/invoices/$id")({ component: InvoiceDetail });

const lines = [
  { desc: "Monarch Mechanical Keyboard", qty: 20, rate: 6499, gst: 18 },
  { desc: '27" 4K UHD Monitor', qty: 5, rate: 32999, gst: 18 },
  { desc: "USB-C Hub 8-in-1", qty: 10, rate: 1799, gst: 18 },
];

function InvoiceDetail() {
  const { id } = useParams({ from: "/sales/invoices/$id" });
  const inv = invoices.find(i => i.id === id) ?? invoices[0];
  const subtotal = lines.reduce((s, l) => s + l.qty * l.rate, 0);
  const gst = lines.reduce((s, l) => s + (l.qty * l.rate * l.gst) / 100, 0);

  return (
    <>
      <PageHeader
        title={inv.id}
        subtitle={`Invoice to ${inv.customer}`}
        actions={
          <>
            <Button variant="outline" size="sm" asChild><Link to="/sales/invoices"><ArrowLeft className="h-4 w-4 mr-1.5" />Back</Link></Button>
            <Button variant="outline" size="sm"><Printer className="h-4 w-4 mr-1.5" />Print</Button>
            <Button variant="outline" size="sm"><Download className="h-4 w-4 mr-1.5" />PDF</Button>
            <Button size="sm" className="bg-gradient-brand text-white"><Send className="h-4 w-4 mr-1.5" />Send</Button>
          </>
        }
      />
      <div className="p-6 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <Card className="p-8 shadow-elegant">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-brand"><Crown className="h-5 w-5 text-white" /></div>
                <div>
                  <p className="font-semibold">{company.name}</p>
                  <p className="text-xs text-muted-foreground">Mumbai HQ · GSTIN {company.gstin}</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-3 max-w-xs">Level 12, Godrej BKC, Bandra East<br/>Mumbai 400051, Maharashtra, India</p>
            </div>
            <div className="text-right">
              <h2 className="text-3xl font-bold tracking-tight">INVOICE</h2>
              <p className="text-sm text-muted-foreground mt-1">{inv.id}</p>
              <Badge className="mt-2 bg-blue-500/10 text-blue-600 border-blue-500/20" variant="outline">{inv.status}</Badge>
            </div>
          </div>

          <Separator className="my-6" />

          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Bill To</p>
              <p className="font-semibold mt-1">{inv.customer}</p>
              <p className="text-sm text-muted-foreground">ap@customer.com<br/>Mumbai, MH · India</p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><p className="text-[11px] uppercase tracking-widest text-muted-foreground">Invoice Date</p><p className="font-medium mt-1">{inv.date}</p></div>
              <div><p className="text-[11px] uppercase tracking-widest text-muted-foreground">Due Date</p><p className="font-medium mt-1">{inv.due}</p></div>
              <div><p className="text-[11px] uppercase tracking-widest text-muted-foreground">Terms</p><p className="font-medium mt-1">Net 30</p></div>
              <div><p className="text-[11px] uppercase tracking-widest text-muted-foreground">PO Number</p><p className="font-medium mt-1">PO-88421</p></div>
            </div>
          </div>

          <Separator className="my-6" />

          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-muted-foreground border-b">
                <th className="text-left pb-2">Description</th>
                <th className="text-right pb-2 w-16">Qty</th>
                <th className="text-right pb-2 w-28">Rate</th>
                <th className="text-right pb-2 w-16">GST</th>
                <th className="text-right pb-2 w-32">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-3 font-medium">{l.desc}</td>
                  <td className="text-right tabular-nums">{l.qty}</td>
                  <td className="text-right tabular-nums">{inrFull(l.rate)}</td>
                  <td className="text-right tabular-nums">{l.gst}%</td>
                  <td className="text-right tabular-nums font-medium">{inr(l.qty * l.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex justify-end mt-6">
            <div className="w-72 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{inr(subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">CGST @ 9%</span><span className="tabular-nums">{inr(gst/2)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">SGST @ 9%</span><span className="tabular-nums">{inr(gst/2)}</span></div>
              <Separator />
              <div className="flex justify-between text-base font-semibold"><span>Total</span><span className="tabular-nums">{inr(subtotal + gst)}</span></div>
              <div className="flex justify-between text-brand font-semibold"><span>Balance Due</span><span className="tabular-nums">{inr(inv.balance)}</span></div>
            </div>
          </div>

          <Separator className="my-6" />
          <p className="text-xs text-muted-foreground">Payment via NEFT/RTGS · HDFC Bank · A/C 50100882100 · IFSC HDFC0000123<br/>Thank you for your business.</p>
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">Balance Due</p>
            <p className="text-3xl font-semibold tabular-nums mt-1 text-brand">{inr(inv.balance)}</p>
            <p className="text-xs text-muted-foreground mt-1">of {inr(inv.amount)} total</p>
            <Button className="w-full mt-4 bg-gradient-brand text-white"><CreditCard className="h-4 w-4 mr-2" />Record Payment</Button>
            <Button variant="outline" className="w-full mt-2"><Copy className="h-4 w-4 mr-2" />Duplicate</Button>
          </Card>
          <Card className="p-5">
            <p className="text-sm font-semibold mb-3">Activity</p>
            <div className="space-y-3 text-sm">
              {[
                { d: "Sent to customer", t: "2 hours ago" },
                { d: "Reminder scheduled", t: "Yesterday" },
                { d: "Invoice created", t: "Jul 15, 10:24 AM" },
              ].map((a, i) => (
                <div key={i} className="flex gap-3">
                  <div className="h-2 w-2 rounded-full bg-brand mt-1.5" />
                  <div><p>{a.d}</p><p className="text-xs text-muted-foreground">{a.t}</p></div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
