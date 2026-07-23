import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Bell, Plus, Sparkles, Building2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AIAssistant } from "./AIAssistant";
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
            <div className="relative flex-1 max-w-md ml-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search invoices, items, customers…"
                className="pl-9 h-9 bg-muted/40 border-0"
              />
              <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 hidden md:inline-flex h-5 items-center gap-0.5 rounded border bg-background px-1.5 text-[10px] text-muted-foreground">
                ⌘K
              </kbd>
            </div>
            <div className="flex items-center gap-1.5 ml-auto">
              <UserMenu />
              <Button variant="outline" size="sm" className="gap-1.5 hidden md:flex">
                <Plus className="h-4 w-4" /> Create
              </Button>
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
