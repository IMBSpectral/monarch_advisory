import { createContext, useContext, useState, type ReactNode } from "react";

export type Role = "ceo" | "accountant" | "sales";

type RoleMeta = {
  id: Role;
  label: string;
  title: string;
  initials: string;
  name: string;
  accent: string;
  allow: string[]; // sidebar url prefixes visible
};

export const ROLES: Record<Role, RoleMeta> = {
  ceo: {
    id: "ceo",
    label: "CEO",
    title: "CEO · Full Access",
    initials: "AK",
    name: "Arjun Kapoor",
    accent: "bg-gradient-brand",
    allow: ["*"],
  },
  accountant: {
    id: "accountant",
    label: "Accountant",
    title: "Accountant · Finance",
    initials: "PN",
    name: "Priya Nair",
    accent: "bg-emerald-600",
    allow: ["/", "/accounting", "/purchases", "/banking", "/reports", "/sales/invoices"],
  },
  sales: {
    id: "sales",
    label: "Sales Lead",
    title: "Sales · Pipeline & POS",
    initials: "RM",
    name: "Rohan Mehta",
    accent: "bg-blue-600",
    allow: ["/", "/sales", "/crm", "/pos", "/inventory"],
  },
};

const RoleCtx = createContext<{
  role: Role;
  setRole: (r: Role) => void;
  can: (url: string) => boolean;
  meta: RoleMeta;
}>({ role: "ceo", setRole: () => {}, can: () => true, meta: ROLES.ceo });

export function RoleProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<Role>("ceo");
  const meta = ROLES[role];
  const can = (url: string) => {
    if (meta.allow.includes("*")) return true;
    return meta.allow.some((p) => (p === "/" ? url === "/" : url.startsWith(p)));
  };
  return <RoleCtx.Provider value={{ role, setRole, can, meta }}>{children}</RoleCtx.Provider>;
}

export const useRole = () => useContext(RoleCtx);
