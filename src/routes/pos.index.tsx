import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CreditCard, Banknote, Smartphone, Trash2, Plus, Minus } from "lucide-react";
import { items, inr, inrFull } from "@/data/mock";
import { useState } from "react";

export const Route = createFileRoute("/pos/")({ component: POS });

function POS() {
  const [cart, setCart] = useState([
    { sku: items[0].sku, qty: 2 },
    { sku: items[2].sku, qty: 1 },
    { sku: items[7].sku, qty: 3 },
  ]);

  const cartItems = cart.map(c => ({ ...items.find(i => i.sku === c.sku)!, qty: c.qty }));
  const subtotal = cartItems.reduce((s, i) => s + i.qty * i.price, 0);
  const tax = subtotal * 0.18;

  return (
    <>
      <PageHeader title="Point of Sale" subtitle="Bengaluru Store · Terminal 02" />
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-0 h-[calc(100vh-8.5rem)]">
        <div className="p-6 overflow-auto">
          <Input placeholder="Scan barcode or search item…" className="mb-4 h-11" />
          <div className="flex gap-2 mb-4 flex-wrap">
            {["All", "Peripherals", "Displays", "Laptops", "Audio", "Furniture"].map((c, i) => (
              <Button key={c} variant={i === 0 ? "default" : "outline"} size="sm" className={i === 0 ? "bg-gradient-brand text-white" : ""}>{c}</Button>
            ))}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
            {items.map((i) => (
              <Card key={i.sku} className="p-3 hover:shadow-elegant hover:border-brand cursor-pointer transition-all" onClick={() => setCart(c => {
                const ex = c.find(x => x.sku === i.sku);
                return ex ? c.map(x => x.sku === i.sku ? {...x, qty: x.qty + 1} : x) : [...c, {sku: i.sku, qty: 1}];
              })}>
                <div className="aspect-square rounded-lg bg-gradient-to-br from-brand/10 to-transparent mb-2 flex items-center justify-center text-2xl font-bold text-brand/30">{i.name.slice(0,1)}</div>
                <p className="text-xs font-medium line-clamp-2">{i.name}</p>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-sm font-semibold tabular-nums">{inr(i.price)}</span>
                  <Badge variant="secondary" className="text-[10px]">{i.stock}</Badge>
                </div>
              </Card>
            ))}
          </div>
        </div>

        <Card className="rounded-none border-l border-r-0 border-t-0 border-b-0 flex flex-col">
          <div className="p-4 border-b">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">Order #POS-8842</p>
            <p className="font-semibold mt-0.5">Walk-in Customer</p>
          </div>
          <div className="flex-1 overflow-auto p-4 space-y-3">
            {cartItems.map((i) => (
              <div key={i.sku} className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-sm font-semibold">{i.name.slice(0,1)}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{i.name}</p>
                  <p className="text-xs text-muted-foreground">{inr(i.price)} × {i.qty}</p>
                  <div className="flex items-center gap-1 mt-1">
                    <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setCart(c => c.map(x => x.sku === i.sku ? {...x, qty: Math.max(1, x.qty-1)} : x))}><Minus className="h-3 w-3" /></Button>
                    <span className="w-8 text-center text-sm tabular-nums">{i.qty}</span>
                    <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setCart(c => c.map(x => x.sku === i.sku ? {...x, qty: x.qty+1} : x))}><Plus className="h-3 w-3" /></Button>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold tabular-nums">{inr(i.qty * i.price)}</p>
                  <Button size="icon" variant="ghost" className="h-6 w-6 mt-1" onClick={() => setCart(c => c.filter(x => x.sku !== i.sku))}><Trash2 className="h-3 w-3 text-destructive" /></Button>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t p-4 space-y-2 bg-muted/30">
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{inrFull(subtotal)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">GST 18%</span><span className="tabular-nums">{inrFull(tax)}</span></div>
            <div className="flex justify-between text-lg font-semibold pt-2 border-t"><span>Total</span><span className="tabular-nums text-brand">{inrFull(subtotal + tax)}</span></div>
            <div className="grid grid-cols-3 gap-2 pt-3">
              <Button variant="outline" className="flex-col h-16"><Banknote className="h-4 w-4 mb-1" /><span className="text-[10px]">Cash</span></Button>
              <Button variant="outline" className="flex-col h-16"><CreditCard className="h-4 w-4 mb-1" /><span className="text-[10px]">Card</span></Button>
              <Button variant="outline" className="flex-col h-16"><Smartphone className="h-4 w-4 mb-1" /><span className="text-[10px]">UPI</span></Button>
            </div>
            <Button className="w-full h-11 bg-gradient-brand text-white mt-2">Charge {inrFull(subtotal + tax)}</Button>
          </div>
        </Card>
      </div>
    </>
  );
}
