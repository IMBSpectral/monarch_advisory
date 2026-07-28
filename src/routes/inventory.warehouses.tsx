import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Warehouse, MapPin } from "lucide-react";
import { fetchWarehouses } from "@/api";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/inventory/warehouses")({
  loader: async () => fetchWarehouses(),
  component: Warehouses,
});

function Warehouses() {
  const houses = Route.useLoaderData();

  return (
    <>
      <PageHeader title="Warehouses" subtitle="Stock locations and on-hand value" />
      <div className="p-6 space-y-4">
        {houses.length === 0 ? (
          <Card className="p-10 text-center text-sm text-muted-foreground">
            No warehouses yet. One is created automatically the first time stock is received.
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {houses.map((w) => (
              <Card key={w.id} className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-brand">
                      <Warehouse className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <h3 className="font-semibold">{w.name}</h3>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {w.code}
                      </p>
                    </div>
                  </div>
                  {w.isDefault && (
                    <Badge variant="secondary" className="text-[10px]">
                      Default
                    </Badge>
                  )}
                </div>
                <div className="mt-5 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Items in stock</p>
                    <p className="text-lg font-semibold tabular-nums">{w.itemCount}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Stock value</p>
                    <p className="text-lg font-semibold tabular-nums">
                      {formatMinor(w.stockValueMinor)}
                    </p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
