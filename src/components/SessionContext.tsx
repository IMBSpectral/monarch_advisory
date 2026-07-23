import { createContext, useContext, type ReactNode } from "react";

/**
 * The signed-in user, their org, and their real membership role.
 *
 * This replaces the demo `RoleContext`, whose roles were invented personas
 * ("Arjun Kapoor, CEO") that any visitor could switch between. Here the role
 * comes from the `memberships` row and cannot be changed from the client.
 *
 * WHAT THIS IS FOR: hiding controls the user can't use. It is *not* a security
 * boundary. Anyone can edit client state, so every capability check here is
 * mirrored by `requirePermission()` on the server function behind the button.
 * Treat this as "don't show them a button that will fail", never as "this
 * stops them".
 */

export type Role = "viewer" | "staff" | "accountant" | "admin" | "owner";

export type SessionValue = {
  userId: string;
  email: string;
  name: string;
  orgId: string;
  orgName: string;
  baseCurrency: string;
  role: Role;
  permissions: string[];
  organizations: Array<{ orgId: string; orgName: string; role: Role }>;
};

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  staff: 1,
  accountant: 2,
  admin: 3,
  owner: 4,
};

/** Must stay in step with CAPABILITIES in src/server/auth.ts. */
const CAPABILITIES: Record<string, Role> = {
  "ledger:read": "viewer",
  "report:read": "viewer",
  "document:create": "staff",
  "document:edit": "staff",
  "payment:record": "staff",
  "ledger:post": "accountant",
  "ledger:reverse": "accountant",
  "document:void": "accountant",
  "period:close": "admin",
  "contact:manage": "staff",
  "item:manage": "staff",
  "bank:manage": "accountant",
  "bank:reconcile": "accountant",
  "settings:manage": "admin",
  "member:manage": "admin",
  "org:manage": "owner",
};

const SessionCtx = createContext<SessionValue | null>(null);

export function SessionProvider({
  value,
  children,
}: {
  value: SessionValue | null;
  children: ReactNode;
}) {
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

/** The session, or null on public pages. */
export function useSession(): SessionValue | null {
  return useContext(SessionCtx);
}

/**
 * The session, throwing if absent.
 *
 * For components that only ever render inside the authenticated shell — it
 * turns "session is somehow null here" into a loud error rather than a spray of
 * optional chaining that quietly renders an empty screen.
 */
export function useRequiredSession(): SessionValue {
  const session = useContext(SessionCtx);
  if (!session) {
    throw new Error("useRequiredSession called outside an authenticated route.");
  }
  return session;
}

/** Does the signed-in user hold this capability? False when signed out. */
export function useCan(capability: string): boolean {
  const session = useContext(SessionCtx);
  if (!session) return false;
  if (session.permissions.includes(capability)) return true;
  const required = CAPABILITIES[capability];
  if (!required) return false;
  return ROLE_RANK[session.role] >= ROLE_RANK[required];
}
