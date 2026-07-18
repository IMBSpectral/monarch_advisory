import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  FileText, TrendingUp, Package, Users, Receipt, DollarSign, ShoppingBag,
  Truck, Search, BarChart3, PieChart, Landmark, Boxes,
} from "lucide-react";

export const Route = createFileRoute("/reports/")({ component: Reports });

const categories = [
  {
    name: "Financial", icon: DollarSign, reports: [
      "Profit & Loss", "Balance Sheet", "Cash Flow Statement", "Trial Balance",
      "General Ledger", "Journal Report", "Chart of Accounts Summary",
    ],
  },
  {
    name: "Sales", icon: TrendingUp, reports: [
      "Sales by Customer", "Sales by Item", "Sales by Salesperson",
      "Invoice Aging", "Recurring Invoices", "Sales Return", "Revenue by Region",
    ],
  },
  {
    name: "Purchase", icon: ShoppingBag, reports: [
      "Purchases by Vendor", "Purchases by Item", "Bill Aging",
      "Vendor Balance", "Debit Notes", "PO Status",
    ],
  },
  {
    name: "Inventory", icon: Package, reports: [
      "Stock Summary", "Stock Aging", "FIFO Valuation", "Weighted-Avg Valuation",
      "Warehouse Report", "Stock Movement", "Low Stock Alert",
    ],
  },
  {
    name: "Tax", icon: Receipt, reports: [
      "GSTR-1 Summary", "GSTR-3B Summary", "GSTR-2B Reconciliation",
      "TDS Payable", "TCS Report", "HSN Summary",
    ],
  },
  {
    name: "Banking", icon: Landmark, reports: [
      "Bank Reconciliation", "Cash Book", "Cheque Register",
      "Payment Register", "Receipt Register",
    ],
  },
];

function Reports() {
  return (
    <>
      <PageHeader title="Reports" subtitle="40+ business reports at your fingertips" />
      <div className="p-6 space-y-6">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search reports…" className="pl-9" />
        </div>
        {categories.map((cat) => (
          <div key={cat.name}>
            <div className="flex items-center gap-2 mb-3">
              <cat.icon className="h-4 w-4 text-brand" />
              <h3 className="font-semibold">{cat.name}</h3>
              <span className="text-xs text-muted-foreground">({cat.reports.length})</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {cat.reports.map((r) => (
                <Card key={r} className="p-4 hover:shadow-elegant hover:border-brand cursor-pointer transition-all group">
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted group-hover:bg-gradient-brand transition-all">
                      <FileText className="h-4 w-4 text-muted-foreground group-hover:text-white" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{r}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Updated today</p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
