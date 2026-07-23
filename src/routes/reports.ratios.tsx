import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { fetchFinancialRatios } from "@/api/index";
import { formatMinorSigned } from "@/lib/money";

export const Route = createFileRoute("/reports/ratios")({
  loader: async () => fetchFinancialRatios(),
  component: Ratios,
});

function display(value: number, format: "x" | "%" | "money"): string {
  if (format === "x") return `${value.toFixed(2)}×`;
  if (format === "%") return `${value.toFixed(1)}%`;
  return formatMinorSigned(String(Math.round(value)));
}

function Ratios() {
  const { ratios } = Route.useLoaderData();
  return (
    <>
      <PageHeader title="Financial Ratios" subtitle="Liquidity, leverage and profitability at a glance" />
      <div className="p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ratios.map((r) => (
            <Card key={r.label} className="p-5">
              <p className="text-xs uppercase tracking-widest text-muted-foreground">{r.label}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-brand">{display(r.value, r.format)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{r.hint}</p>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
