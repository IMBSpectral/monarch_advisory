import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  BookOpen,
  FileText,
  ShoppingCart,
  Package,
  Users,
  Store,
  Landmark,
  BarChart3,
  Workflow,
  Sparkles,
  Settings,
  Receipt,
  Wallet,
  TrendingUp,
  Boxes,
  ClipboardList,
  Crown,
  ArrowLeftRight,
  Truck,
  PackageCheck,
  Undo2,
  Redo2,
  ClipboardCheck,
  Layers,
  Building2,
  Repeat,
  Upload,
  ShieldCheck,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { useSession, useCan, type Role } from "./SessionContext";
import { Badge } from "@/components/ui/badge";
import { Lock } from "lucide-react";

/**
 * Nav entries carry the capability needed to reach them, so the sidebar hides
 * what the signed-in role can't use. Items with no `capability` are readable by
 * anyone with a membership.
 *
 * This is presentation only. Hiding a link is not access control — the route's
 * server functions enforce the same capability independently.
 */
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
      { title: "Contra", url: "/accounting/contra", icon: ArrowLeftRight },
      { title: "Cost Centres", url: "/accounting/cost-centers", icon: Layers },
      { title: "Fixed Assets", url: "/accounting/fixed-assets", icon: Building2 },
      { title: "Exchange Rates", url: "/accounting/exchange-rates", icon: ArrowLeftRight },
      {
        title: "Period Close",
        url: "/accounting/period-close",
        icon: Lock,
        capability: "period:close",
      },
      {
        title: "Approvals",
        url: "/approvals",
        icon: ShieldCheck,
        capability: "payment:record",
      },
      { title: "P&L Statement", url: "/accounting/pnl", icon: TrendingUp },
      { title: "Balance Sheet", url: "/accounting/balance-sheet", icon: ClipboardList },
      { title: "GST Returns", url: "/accounting/gst", icon: Receipt },
    ],
  },
  {
    label: "Sales",
    items: [
      { title: "Invoices", url: "/sales/invoices", icon: FileText },
      { title: "Sales Orders", url: "/sales/orders", icon: ClipboardCheck },
      { title: "Deliveries", url: "/sales/deliveries", icon: Truck },
      { title: "Recurring", url: "/sales/recurring", icon: Repeat },
      { title: "Credit Notes", url: "/sales/credit-notes", icon: Undo2 },
      { title: "Customers", url: "/sales/customers", icon: Users },
      { title: "Sales Dashboard", url: "/sales", icon: BarChart3 },
    ],
  },
  {
    label: "Purchases",
    items: [
      { title: "Bills", url: "/purchases/bills", icon: Receipt },
      { title: "Purchase Orders", url: "/purchases/orders", icon: ClipboardCheck },
      { title: "Goods Receipts", url: "/purchases/grn", icon: PackageCheck },
      { title: "Debit Notes", url: "/purchases/debit-notes", icon: Redo2 },
      { title: "Vendors", url: "/purchases/vendors", icon: Users },
    ],
  },
  {
    label: "Operations",
    items: [
      { title: "Inventory", url: "/inventory", icon: Package },
      { title: "Warehouses", url: "/inventory/warehouses", icon: Boxes },
      { title: "CRM", url: "/crm", icon: ShoppingCart, capability: "contact:manage" },
      { title: "Point of Sale", url: "/pos", icon: Store, capability: "document:create" },
      { title: "Banking", url: "/banking", icon: Landmark },
      {
        title: "Import Statement",
        url: "/banking/import",
        icon: Upload,
        capability: "bank:reconcile",
      },
      {
        title: "Connect Accounts",
        url: "/banking/connect",
        icon: Wallet,
        capability: "bank:manage",
      },
      {
        title: "Review Transactions",
        url: "/banking/review",
        icon: ClipboardList,
        capability: "bank:reconcile",
      },
      {
        title: "Reconciliation",
        url: "/banking/reconcile",
        icon: ArrowLeftRight,
        capability: "bank:reconcile",
      },
      { title: "Reports", url: "/reports", icon: BarChart3 },
      { title: "Automation", url: "/automation", icon: Workflow },
    ],
  },
  {
    label: "System",
    items: [{ title: "Settings", url: "/settings", icon: Settings, capability: "settings:manage" }],
  },
];

/** Every nav destination, flattened — used to pick the single best-matching item. */
const ALL_NAV_URLS = groups.flatMap((g) => g.items.map((i) => i.url));

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  accountant: "Accountant",
  staff: "Staff",
  viewer: "Viewer",
};

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const session = useSession();

  // Highlight only the most specific matching nav item. A child route such as
  // /sales/invoices matches both "Invoices" (/sales/invoices) and "Sales
  // Dashboard" (/sales) by prefix; picking the longest match means the child
  // wins and the parent index route no longer lights up alongside it. "/" is an
  // exact match only, since it prefixes everything.
  const matchesPath = (url: string) =>
    url === "/" ? pathname === "/" : pathname === url || pathname.startsWith(url + "/");
  const activeUrl = ALL_NAV_URLS.filter(matchesPath).reduce<string | null>(
    (best, url) => (best && best.length >= url.length ? best : url),
    null,
  );
  const isActive = (url: string) => url === activeUrl;

  // Capability checks are hooks, so they must run unconditionally and in a
  // stable order — resolve them all up front rather than inside the map.
  const grants: Record<string, boolean> = {
    "settings:manage": useCan("settings:manage"),
    "bank:manage": useCan("bank:manage"),
    "bank:reconcile": useCan("bank:reconcile"),
    "document:create": useCan("document:create"),
    "contact:manage": useCan("contact:manage"),
    "period:close": useCan("period:close"),
  };

  const can = (capability?: string) => !capability || grants[capability] === true;

  const initials = (session?.name ?? "?")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();

  const isFullAccess = session?.role === "owner" || session?.role === "admin";

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader className="border-b border-sidebar-border/50 py-4">
        <div className="flex items-center gap-2.5 px-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-brand shadow-glow">
            <Crown className="h-5 w-5 text-white" />
          </div>
          <div className="flex flex-col group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">
              Monarch ERP
            </span>
            <span className="truncate text-[10px] uppercase tracking-widest text-sidebar-foreground/50">
              {session?.orgName ?? ""}
            </span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {groups.map((group) => {
          const visible = group.items.filter((i) => can(i.capability));
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
        {!isFullAccess && (
          <div className="mx-3 mt-2 rounded-lg border border-dashed border-sidebar-border/60 p-2.5 group-data-[collapsible=icon]:hidden">
            <div className="flex items-center gap-1.5 text-[10px] text-sidebar-foreground/60 uppercase tracking-widest">
              <Lock className="h-3 w-3" /> Restricted
            </div>
            <p className="text-[11px] text-sidebar-foreground/70 mt-1 leading-snug">
              Some modules are hidden by your{" "}
              <span className="font-medium">
                {session ? (ROLE_LABEL[session.role] ?? session.role) : ""}
              </span>{" "}
              role permissions.
            </p>
          </div>
        )}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border/50 p-3">
        <div className="flex items-center gap-2.5 group-data-[collapsible=icon]:hidden">
          <div className="bg-gradient-brand flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white">
            {initials}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs font-medium text-sidebar-foreground">
              {session?.name ?? "—"}
            </span>
            <span className="truncate text-[10px] text-sidebar-foreground/50">
              {session ? (ROLE_LABEL[session.role] ?? session.role) : ""}
              {session ? ` · ${session.orgName}` : ""}
            </span>
          </div>
          <Badge variant="secondary" className="text-[9px] uppercase tracking-wider">
            Live
          </Badge>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
