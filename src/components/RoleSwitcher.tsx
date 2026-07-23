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
import { ChevronDown, ShieldCheck, Check } from "lucide-react";
import { ROLES, useRole, type Role } from "./RoleContext";
import { toast } from "sonner";

export function RoleSwitcher() {
  const { role, setRole, meta } = useRole();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 h-9 border-dashed">
          <span
            className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-semibold text-white ${meta.accent}`}
          >
            {meta.initials}
          </span>
          <span className="hidden sm:inline text-xs font-medium">{meta.label}</span>
          <Badge
            variant="secondary"
            className="text-[9px] uppercase tracking-wider hidden md:inline-flex"
          >
            Demo RBAC
          </Badge>
          <ChevronDown className="h-3.5 w-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-center gap-2">
          <ShieldCheck className="h-3.5 w-3.5 text-brand" />
          Switch role (demo)
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(Object.values(ROLES) as (typeof ROLES)[Role][]).map((r) => (
          <DropdownMenuItem
            key={r.id}
            onClick={() => {
              setRole(r.id);
              toast.success(`Switched to ${r.label}`, {
                description: r.allow.includes("*")
                  ? "Full access to every module."
                  : `Access limited to ${r.allow.length} module groups.`,
              });
            }}
            className="flex items-start gap-2.5 py-2"
          >
            <span
              className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-[11px] font-semibold text-white ${r.accent}`}
            >
              {r.initials}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium leading-tight">{r.name}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{r.title}</p>
            </div>
            {role === r.id && <Check className="h-4 w-4 text-brand mt-1" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
