import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Building2, Check, ChevronDown, LogOut, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { logoutFn, switchOrgFn } from "@/api/auth";
import { useSession } from "./SessionContext";

/**
 * The signed-in user's account menu.
 *
 * Replaces `RoleSwitcher`, which let anyone assume an invented persona
 * ("Arjun Kapoor, CEO · Full Access") and rewrite their own permissions from the
 * client. Role here is read-only and comes from the `memberships` row; the only
 * way to change it is for an admin to do so server-side.
 *
 * Org switching is a real action, not a client toggle: it updates the session
 * row and every loader re-runs against the new tenant.
 */

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  accountant: "Accountant",
  staff: "Staff",
  viewer: "Viewer",
};

/** Initials for the avatar chip, from the user's display name. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function UserMenu() {
  const session = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  // The shell can render for a beat before the session context lands; showing
  // nothing is better than flashing a wrong identity.
  if (!session) return null;

  async function onLogout() {
    setBusy(true);
    try {
      await logoutFn();
      await router.invalidate();
      await router.navigate({ to: "/login" });
    } catch {
      toast.error("Could not sign out. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onSwitchOrg(orgId: string) {
    if (orgId === session!.orgId) return;
    setBusy(true);
    try {
      await switchOrgFn({ data: { orgId } });
      // Every loader on screen is showing the previous tenant's data.
      await router.invalidate();
      toast.success("Switched organization");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not switch organization.");
    } finally {
      setBusy(false);
    }
  }

  const hasMultipleOrgs = session.organizations.length > 1;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-2">
          <span className="bg-gradient-brand flex h-5 w-5 items-center justify-center rounded text-[10px] font-semibold text-white">
            {initialsOf(session.name)}
          </span>
          <span className="hidden text-xs font-medium sm:inline">{session.name}</span>
          <Badge
            variant="secondary"
            className="hidden text-[9px] uppercase tracking-wider md:inline-flex"
          >
            {ROLE_LABEL[session.role] ?? session.role}
          </Badge>
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin opacity-50" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 opacity-50" />
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-sm font-medium leading-tight">{session.name}</span>
          <span className="text-[11px] font-normal text-muted-foreground">{session.email}</span>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        {hasMultipleOrgs ? (
          <>
            <DropdownMenuLabel className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              <Building2 className="h-3.5 w-3.5" />
              Organizations
            </DropdownMenuLabel>
            {session.organizations.map((org) => (
              <DropdownMenuItem
                key={org.orgId}
                disabled={busy}
                onClick={() => onSwitchOrg(org.orgId)}
                className="flex items-center gap-2 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm leading-tight">{org.orgName}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {ROLE_LABEL[org.role] ?? org.role}
                  </p>
                </div>
                {org.orgId === session.orgId && (
                  <Check className="text-brand h-4 w-4 flex-shrink-0" />
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : (
          <>
            <DropdownMenuLabel className="flex items-center gap-2 text-[11px] font-normal text-muted-foreground">
              <Building2 className="h-3.5 w-3.5" />
              {session.orgName}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuItem disabled={busy} onClick={onLogout} className="gap-2">
          <LogOut className="h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
