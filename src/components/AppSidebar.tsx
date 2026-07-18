import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard, BookOpen, FileText, ShoppingCart, Package, Users, Store,
  Landmark, BarChart3, Workflow, Sparkles, Settings, Receipt, Wallet,
  TrendingUp, Boxes, ClipboardList, Crown, ArrowLeftRight,
} from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarFooter,
} from "@/components/ui/sidebar";
import { useRole } from "./RoleContext";
import { Badge } from "@/components/ui/badge";
import { Lock } from "lucide-react";

const groups = [
  {
    label: "Overview",
    items: [
      { title: "Dashboard", url: "/", icon: LayoutDashboard },
      { title: "AI Assistant", url: "/ai", icon: Sparkles },
    ],
  },
  {
    label: "Accounting",
    items: [
      { title: "Chart of Accounts", url: "/accounting/coa", icon: BookOpen },
      { title: "Journal Entries", url: "/accounting/journal", icon: FileText },
      { title: "P&L Statement", url: "/accounting/pnl", icon: TrendingUp },
      { title: "Balance Sheet", url: "/accounting/balance-sheet", icon: ClipboardList },
      { title: "GST Returns", url: "/accounting/gst", icon: Receipt },
    ],
  },
  {
    label: "Sales",
    items: [
      { title: "Invoices", url: "/sales/invoices", icon: FileText },
      { title: "Customers", url: "/sales/customers", icon: Users },
      { title: "Sales Dashboard", url: "/sales", icon: BarChart3 },
    ],
  },
  {
    label: "Purchases",
    items: [
      { title: "Bills", url: "/purchases/bills", icon: Receipt },
      { title: "Vendors", url: "/purchases/vendors", icon: Users },
    ],
  },
  {
    label: "Operations",
    items: [
      { title: "Inventory", url: "/inventory", icon: Package },
      { title: "Warehouses", url: "/inventory/warehouses", icon: Boxes },
      { title: "CRM", url: "/crm", icon: ShoppingCart },
      { title: "Point of Sale", url: "/pos", icon: Store },
      { title: "Banking", url: "/banking", icon: Landmark },
      { title: "Connect Accounts", url: "/banking/connect", icon: Wallet },
      { title: "Review Transactions", url: "/banking/review", icon: ClipboardList },
      { title: "Reconciliation", url: "/banking/reconcile", icon: ArrowLeftRight },
      { title: "Reports", url: "/reports", icon: BarChart3 },
      { title: "Automation", url: "/automation", icon: Workflow },
    ],
  },
  {
    label: "System",
    items: [
      { title: "Settings", url: "/settings", icon: Settings },
    ],
  },
];

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { can, meta } = useRole();
  const isActive = (url: string) => (url === "/" ? pathname === "/" : pathname.startsWith(url));

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader className="border-b border-sidebar-border/50 py-4">
        <div className="flex items-center gap-2.5 px-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-brand shadow-glow">
            <Crown className="h-5 w-5 text-white" />
          </div>
          <div className="flex flex-col group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">Monarch ERP</span>
            <span className="text-[10px] uppercase tracking-widest text-sidebar-foreground/50">IMB Labs LLP</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {groups.map((group) => {
          const visible = group.items.filter((i) => can(i.url));
          if (visible.length === 0) return null;
          return (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel className="text-[10px] uppercase tracking-widest text-sidebar-foreground/40">
                {group.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {visible.map((item) => (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive(item.url)}
                        className="data-[active=true]:bg-sidebar-primary/15 data-[active=true]:text-sidebar-primary data-[active=true]:font-medium"
                      >
                        <Link to={item.url}>
                          <item.icon className="h-4 w-4" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
        {meta.id !== "ceo" && (
          <div className="mx-3 mt-2 rounded-lg border border-dashed border-sidebar-border/60 p-2.5 group-data-[collapsible=icon]:hidden">
            <div className="flex items-center gap-1.5 text-[10px] text-sidebar-foreground/60 uppercase tracking-widest">
              <Lock className="h-3 w-3" /> Restricted
            </div>
            <p className="text-[11px] text-sidebar-foreground/70 mt-1 leading-snug">
              Some modules are hidden by <span className="font-medium">{meta.label}</span> role permissions.
            </p>
          </div>
        )}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border/50 p-3">
        <div className="flex items-center gap-2.5 group-data-[collapsible=icon]:hidden">
          <div className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white ${meta.accent}`}>
            {meta.initials}
          </div>
          <div className="flex flex-col flex-1 min-w-0">
            <span className="text-xs font-medium text-sidebar-foreground truncate">{meta.name}</span>
            <span className="text-[10px] text-sidebar-foreground/50">{meta.title}</span>
          </div>
          <Badge variant="secondary" className="text-[9px] uppercase tracking-wider">Live</Badge>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
