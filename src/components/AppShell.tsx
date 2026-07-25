import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bell,
  Plus,
  Sparkles,
  Building2,
  FileText,
  Package,
  Users,
  ReceiptText,
  Truck,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AIAssistant } from "./AIAssistant";
import { GlobalSearch } from "./GlobalSearch";
import { InvestorTour } from "./InvestorTour";
import { RoleProvider } from "./RoleContext";
import { UserMenu } from "./UserMenu";
import { useSession } from "./SessionContext";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <RoleProvider>
      <AppShellInner>{children}</AppShellInner>
    </RoleProvider>
  );
}

function AppShellInner({ children }: { children: ReactNode }) {
  const [aiOpen, setAiOpen] = useState(false);
  const session = useSession();
  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-muted/30">
        <AppSidebar />
        <div className="flex flex-1 flex-col min-w-0">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur-xl">
            <SidebarTrigger />
            {/*
              The org name, from the session — not a mock constant.

              This used to be a "Switch branch / Mumbai HQ" dropdown listing
              fictional branches. There is no branch entity in the schema, so
              every option was inert. Org switching is real and lives in the
              account menu; a branch picker returns when branches do.
            */}
            <div className="-ml-1 flex items-center gap-2 px-2">
              <Building2 className="text-brand h-4 w-4" />
              <span className="text-sm font-medium">{session?.orgName ?? "—"}</span>
            </div>
            <GlobalSearch />
            <div className="flex items-center gap-1.5 ml-auto">
              <UserMenu />
              <CreateMenu />
              <Button
                size="sm"
                onClick={() => setAiOpen(true)}
                className="gap-1.5 bg-gradient-brand text-white hover:opacity-90 shadow-glow"
              >
                <Sparkles className="h-4 w-4" /> Ask AI
              </Button>
              <Button variant="ghost" size="icon" className="relative">
                <Bell className="h-4 w-4" />
                <span className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-brand" />
              </Button>
            </div>
          </header>
          <main className="flex-1 min-w-0">{children}</main>
        </div>
      </div>
      <AIAssistant open={aiOpen} onOpenChange={setAiOpen} />
      <InvestorTour />
    </SidebarProvider>
  );
}

/**
 * The header "Create" menu. Each entry routes to the screen that owns the
 * relevant "New …" dialog, so the button is a real shortcut into the create
 * flows rather than a dead control.
 */
function CreateMenu() {
  const navigate = useNavigate();
  const items = [
    { icon: FileText, label: "Invoice", to: "/sales/invoices" as const },
    { icon: ReceiptText, label: "Bill", to: "/purchases/bills" as const },
    { icon: Package, label: "Item", to: "/inventory" as const },
    { icon: Users, label: "Customer", to: "/sales/customers" as const },
    { icon: Truck, label: "Vendor", to: "/purchases/vendors" as const },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 hidden md:flex">
          <Plus className="h-4 w-4" /> Create
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Create new</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((it) => (
          <DropdownMenuItem key={it.label} onSelect={() => navigate({ to: it.to })}>
            <it.icon className="mr-2 h-4 w-4 text-muted-foreground" />
            {it.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b bg-background px-6 py-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
