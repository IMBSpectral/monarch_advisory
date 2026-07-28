import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Banknote, CreditCard, Loader2, Minus, Plus, Smartphone, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useCan } from "@/components/SessionContext";
import { fetchItems, fetchTaxRates } from "@/api/entities";
import { posCheckoutFn } from "@/api/pos";
import { formatMinor } from "@/lib/money";
import { useIdempotencyKey } from "@/lib/idempotency";

export const Route = createFileRoute("/pos/")({
  loader: async () => {
    const [items, taxRates] = await Promise.all([fetchItems({ data: {} }), fetchTaxRates()]);
    return { items, taxRates };
  },
  component: POS,
});

/** An item with a non-null sale price — the only kind the till can sell. */
type SellableItem = { id: string; name: string; sku: string | null; salePrice: string };

const TENDERS = [
  { key: "Cash", icon: Banknote },
  { key: "Card", icon: CreditCard },
  { key: "UPI", icon: Smartphone },
] as const;

/** The default GST rate to apply at the till, if one is configured. */
function POS() {
  const { items, taxRates } = Route.useLoaderData();
  const router = useRouter();
  const canCharge = useCan("payment:record");

  // Only sellable items (those with a price) can be rung up.
  const sellable = useMemo<SellableItem[]>(
    () =>
      items
        .filter((i) => i.salePrice != null)
        .map((i) => ({ id: i.id, name: i.name, sku: i.sku, salePrice: i.salePrice as string })),
    [items],
  );

  const [cart, setCart] = useState<Record<string, number>>({});
  const [search, setSearch] = useState("");
  const [tender, setTender] = useState<string>("Cash");
  const [charging, setCharging] = useState(false);
  const idem = useIdempotencyKey();

  const defaultTax = taxRates[0] ?? null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sellable;
    return sellable.filter(
      (i) => i.name.toLowerCase().includes(q) || (i.sku ?? "").toLowerCase().includes(q),
    );
  }, [sellable, search]);

  const cartLines = useMemo(
    () =>
      Object.entries(cart)
        .map(([id, qty]) => {
          const item = sellable.find((i) => i.id === id);
          return item ? { item, qty } : null;
        })
        .filter(Boolean) as Array<{ item: SellableItem; qty: number }>,
    [cart, sellable],
  );

  // Display-only running total. The ledger computes the authoritative figure.
  const subtotalMinor = cartLines.reduce((s, l) => s + Number(l.item.salePrice) * l.qty, 0);
  const taxMinor = defaultTax ? Math.round(subtotalMinor * (defaultTax.ratePercent / 100)) : 0;
  const totalMinor = subtotalMinor + taxMinor;

  function addToCart(id: string) {
    setCart((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }));
  }
  function setQty(id: string, qty: number) {
    setCart((c) => {
      if (qty <= 0) {
        // Drop the line entirely when its quantity hits zero.
        const next = { ...c };
        delete next[id];
        return next;
      }
      return { ...c, [id]: qty };
    });
  }

  async function charge() {
    if (cartLines.length === 0) {
      toast.error("The cart is empty.");
      return;
    }
    setCharging(true);
    try {
      const result = await posCheckoutFn({
        data: {
          method: tender,
          idempotencyKey: idem.key,
          lines: cartLines.map((l) => ({
            itemId: l.item.id,
            description: l.item.name,
            quantity: String(l.qty),
            unitPriceMinor: l.item.salePrice,
            taxRateId: defaultTax?.id ?? null,
          })),
        },
      });
      idem.renew();
      toast.success(
        `Sale complete — ${result.invoiceNumber} for ${formatMinor(result.totalMinor)}`,
      );
      setCart({});
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not complete the sale.");
    } finally {
      setCharging(false);
    }
  }

  return (
    <>
      <PageHeader title="Point of Sale" subtitle="Ring up a walk-in sale" />
      <div className="grid h-[calc(100vh-8.5rem)] grid-cols-1 gap-0 lg:grid-cols-[1fr_400px]">
        <div className="overflow-auto p-6">
          <Input
            placeholder="Search item by name or SKU…"
            className="mb-4 h-11"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {sellable.length === 0 ? (
            <p className="mt-10 text-center text-sm text-muted-foreground">
              No priced items yet. Add items with a sale price in Inventory to sell them here.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {filtered.map((i) => (
                <Card
                  key={i.id}
                  className="hover:shadow-elegant hover:border-brand cursor-pointer p-3 transition-all"
                  onClick={() => addToCart(i.id)}
                >
                  <div className="from-brand/10 text-brand/30 mb-2 flex aspect-square items-center justify-center rounded-lg bg-gradient-to-br to-transparent text-2xl font-bold">
                    {i.name.slice(0, 1)}
                  </div>
                  <p className="line-clamp-2 text-xs font-medium">{i.name}</p>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-sm font-semibold tabular-nums">
                      {formatMinor(i.salePrice)}
                    </span>
                    {i.sku ? (
                      <Badge variant="secondary" className="text-[10px]">
                        {i.sku}
                      </Badge>
                    ) : null}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        <Card className="flex flex-col rounded-none border-b-0 border-l border-r-0 border-t-0">
          <div className="border-b p-4">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">Current order</p>
            <p className="mt-0.5 font-semibold">Walk-in Customer</p>
          </div>
          <div className="flex-1 space-y-3 overflow-auto p-4">
            {cartLines.length === 0 ? (
              <p className="mt-8 text-center text-sm text-muted-foreground">
                Tap an item to add it to the order.
              </p>
            ) : (
              cartLines.map(({ item, qty }) => (
                <div key={item.id} className="flex items-start gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-sm font-semibold">
                    {item.name.slice(0, 1)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatMinor(item.salePrice)} × {qty}
                    </p>
                    <div className="mt-1 flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="outline"
                        className="h-6 w-6"
                        onClick={() => setQty(item.id, qty - 1)}
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <span className="w-8 text-center text-sm tabular-nums">{qty}</span>
                      <Button
                        size="icon"
                        variant="outline"
                        className="h-6 w-6"
                        onClick={() => setQty(item.id, qty + 1)}
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold tabular-nums">
                      {formatMinor(String(Number(item.salePrice) * qty))}
                    </p>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="mt-1 h-6 w-6"
                      onClick={() => setQty(item.id, 0)}
                    >
                      <Trash2 className="text-destructive h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="space-y-2 border-t bg-muted/30 p-4">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="tabular-nums">{formatMinor(String(subtotalMinor))}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{defaultTax ? defaultTax.name : "Tax"}</span>
              <span className="tabular-nums">{formatMinor(String(taxMinor))}</span>
            </div>
            <div className="flex justify-between border-t pt-2 text-lg font-semibold">
              <span>Total</span>
              <span className="text-brand tabular-nums">{formatMinor(String(totalMinor))}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-3">
              {TENDERS.map(({ key, icon: Icon }) => (
                <Button
                  key={key}
                  variant={tender === key ? "default" : "outline"}
                  className={`h-16 flex-col ${tender === key ? "bg-gradient-brand text-white" : ""}`}
                  onClick={() => setTender(key)}
                >
                  <Icon className="mb-1 h-4 w-4" />
                  <span className="text-[10px]">{key}</span>
                </Button>
              ))}
            </div>
            <Button
              className="bg-gradient-brand mt-2 h-11 w-full text-white"
              disabled={charging || cartLines.length === 0 || !canCharge}
              onClick={charge}
            >
              {charging ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Charging…
                </>
              ) : (
                `Charge ${formatMinor(String(totalMinor))} · ${tender}`
              )}
            </Button>
            {!canCharge ? (
              <p className="text-center text-[11px] text-muted-foreground">
                Your role can't take payments.
              </p>
            ) : null}
          </div>
        </Card>
      </div>
    </>
  );
}
