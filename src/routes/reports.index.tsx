import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  FileText,
  TrendingUp,
  Package,
  Users,
  Receipt,
  DollarSign,
  ShoppingBag,
  Truck,
  Search,
  BarChart3,
  PieChart,
  Landmark,
  Boxes,
} from "lucide-react";

export const Route = createFileRoute("/reports/")({ component: Reports });

type Report = { title: string; to?: string };
type Category = { name: string; icon: typeof DollarSign; reports: Report[] };

const categories: Category[] = [
  {
    name: "Financial",
    icon: DollarSign,
    reports: [
      { title: "Profit & Loss", to: "/accounting/pnl" },
      { title: "Balance Sheet", to: "/accounting/balance-sheet" },
      { title: "Cash Flow Statement", to: "/reports/cash-flow" },
      { title: "Day Book", to: "/reports/day-book" },
      { title: "Trial Balance", to: "/reports/trial-balance" },
      { title: "Financial Ratios", to: "/reports/ratios" },
      { title: "Monthly P&L", to: "/reports/monthly-pnl" },
      { title: "Cost-Centre P&L", to: "/reports/cost-center-pnl" },
      { title: "Budget vs Actual", to: "/reports/budget" },
      { title: "Group Consolidation", to: "/reports/consolidation" },
      { title: "General Ledger" },
      { title: "Journal Report", to: "/accounting/journal" },
      { title: "Chart of Accounts Summary", to: "/accounting/coa" },
    ],
  },
  {
    name: "Sales",
    icon: TrendingUp,
    reports: [
      { title: "Sales by Customer", to: "/sales" },
      { title: "Sales by Item", to: "/sales" },
      { title: "Sales by Salesperson", to: "/sales" },
      { title: "Invoice Aging", to: "/sales" },
      { title: "Recurring Invoices", to: "/sales" },
      { title: "Sales Return", to: "/sales" },
      { title: "Revenue by Region", to: "/sales" },
    ],
  },
  {
    name: "Purchase",
    icon: ShoppingBag,
    reports: [
      { title: "Purchases by Vendor" },
      { title: "Purchases by Item" },
      { title: "Bill Aging", to: "/reports/payables-aging" },
      { title: "Vendor Balance", to: "/reports/payables-aging" },
      { title: "Debit Notes", to: "/purchases/debit-notes" },
      { title: "PO Status", to: "/purchases/orders" },
    ],
  },
  {
    name: "Inventory",
    icon: Package,
    reports: [
      { title: "Stock Summary", to: "/reports/stock" },
      { title: "Weighted-Avg Valuation", to: "/reports/stock" },
      { title: "Stock Aging" },
      { title: "FIFO Valuation" },
      { title: "Warehouse Report" },
      { title: "Stock Movement" },
      { title: "Low Stock Alert" },
    ],
  },
  {
    name: "Tax",
    icon: Receipt,
    reports: [
      { title: "GSTR-1 Summary", to: "/accounting/gst" },
      { title: "GSTR-3B Summary", to: "/accounting/gst" },
      { title: "GSTR-2B Reconciliation", to: "/accounting/gst" },
      { title: "TDS Payable" },
      { title: "TCS Report" },
      { title: "HSN Summary" },
    ],
  },
  {
    name: "Banking",
    icon: Landmark,
    reports: [
      { title: "Forex Revaluation", to: "/reports/forex" },
      { title: "Bank Reconciliation" },
      { title: "Cash Book" },
      { title: "Cheque Register" },
      { title: "Payment Register" },
      { title: "Receipt Register" },
    ],
  },
];

function ReportCard({ report }: { report: Report }) {
  const card = (
    <Card className="p-4 hover:shadow-elegant hover:border-brand cursor-pointer transition-all group h-full">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted group-hover:bg-gradient-brand transition-all">
          <FileText className="h-4 w-4 text-muted-foreground group-hover:text-white" />
        </div>
        <div>
          <p className="text-sm font-medium">{report.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {report.to ? "Open report" : "Updated today"}
          </p>
        </div>
      </div>
    </Card>
  );

  return report.to ? (
    <Link to={report.to} className="block">
      {card}
    </Link>
  ) : (
    card
  );
}

function Reports() {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const visible = categories
    .map((cat) => ({
      ...cat,
      reports: q ? cat.reports.filter((r) => r.title.toLowerCase().includes(q)) : cat.reports,
    }))
    .filter((cat) => cat.reports.length > 0);

  return (
    <>
      <PageHeader title="Reports" subtitle="40+ business reports at your fingertips" />
      <div className="p-6 space-y-6">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search reports…"
            className="pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reports match “{query}”.</p>
        ) : (
          visible.map((cat) => (
            <div key={cat.name}>
              <div className="flex items-center gap-2 mb-3">
                <cat.icon className="h-4 w-4 text-brand" />
                <h3 className="font-semibold">{cat.name}</h3>
                <span className="text-xs text-muted-foreground">({cat.reports.length})</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {cat.reports.map((r) => (
                  <ReportCard key={r.title} report={r} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
