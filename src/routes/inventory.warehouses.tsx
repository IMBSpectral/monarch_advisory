import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Warehouse, MapPin, Info } from "lucide-react";
import { inr } from "@/data/mock";

export const Route = createFileRoute("/inventory/warehouses")({ component: Warehouses });

const houses = [
  { name: "Mumbai HQ", zones: 4, bins: 128, items: 1240, value: 6820000, util: 78 },
  { name: "Bengaluru", zones: 3, bins: 96, items: 892, value: 3410000, util: 62 },
  { name: "Delhi NCR", zones: 3, bins: 84, items: 640, value: 1980000, util: 54 },
  { name: "Dubai FZ", zones: 2, bins: 42, items: 210, value: 270000, util: 28 },
];

function Warehouses() {
  return (
    <>
      <PageHeader title="Warehouses" subtitle="Multi-warehouse topology: zones, bins, and stock" />
      <div className="p-6 space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-brand/20 bg-brand/5 px-4 py-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Sample data</span> — multi-warehouse
            tracking is on the roadmap. These figures illustrate the layout and are not yet wired to
            live stock.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {houses.map((w) => (
            <Card key={w.name} className="p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-brand">
                    <Warehouse className="h-5 w-5 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold">{w.name}</h3>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      India
                    </p>
                  </div>
                </div>
                <Badge variant="secondary">{w.util}% used</Badge>
              </div>
              <div className="grid grid-cols-3 gap-4 mt-5">
                <div>
                  <p className="text-xs text-muted-foreground">Zones</p>
                  <p className="text-lg font-semibold tabular-nums">{w.zones}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Bins</p>
                  <p className="text-lg font-semibold tabular-nums">{w.bins}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Items</p>
                  <p className="text-lg font-semibold tabular-nums">{w.items}</p>
                </div>
              </div>
              <div className="mt-4 pt-4 border-t flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Stock value</span>
                <span className="font-semibold tabular-nums">{inr(w.value)}</span>
              </div>
              <div className="mt-3 h-2 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-gradient-brand" style={{ width: `${w.util}%` }} />
              </div>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
