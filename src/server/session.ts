/**
 * Request-scoped identity for server functions.
 *
 * Everything in `src/api/` that touches org data starts by calling `requireAuth()`
 * or `requirePermission()`. There is no other sanctioned way to learn the acting
 * org id — if a new server function invents its own, it has almost certainly
 * skipped an access check.
 *
 * WHY THIS LIVES IN src/server/. It reaches for request-scoped cookie and header
 * helpers, which only exist on the server. An earlier version sat in `src/api/`
 * next to the server functions that use it, and the build rejected it: files
 * under `src/api/` are imported directly by routes, so their top-level imports
 * reach the client bundle, and `@tanstack/react-start/server` cannot. Inside
 * `src/server/` it is only ever pulled in through a `.handler()` body, which the
 * build strips — the same reason `reports.ts` and `ledger.ts` live here.
 *
 * The practical rule: import this from `src/api/*` modules, never from a route.
 */

import {
  getCookie,
  getRequestHeader,
  getRequestIP,
  setCookie,
  deleteCookie,
} from "@tanstack/react-start/server";
import {
  AuthError,
  SESSION_COOKIE,
  assertCan,
  resolveSession,
  type Capability,
  type Principal,
} from "@/server/auth";

export type { Principal };

/**
 * Resolve the caller, or null when signed out.
 *
 * Use this only where anonymous access is genuinely valid (the login page's own
 * "am I already signed in?" check). Everywhere else, use `requireAuth`.
 */
export async function optionalAuth(): Promise<Principal | null> {
  return resolveSession(getCookie(SESSION_COOKIE));
}

/**
 * Resolve the caller, or throw 401.
 *
 * The thrown `AuthError` is what the router turns into a redirect to /login.
 */
export async function requireAuth(): Promise<Principal> {
  const principal = await optionalAuth();
  if (!principal) {
    throw new AuthError("You must sign in to continue.", "unauthenticated", 401);
  }
  return principal;
}

/**
 * Resolve the caller and assert a capability in one step.
 *
 * Mutating server functions should call this rather than `requireAuth` so the
 * permission check can't be forgotten — the thing you need (the principal) and
 * the thing you might skip (the check) arrive together.
 */
export async function requirePermission(capability: Capability): Promise<Principal> {
  const principal = await requireAuth();
  assertCan(principal, capability);
  return principal;
}

/**
 * The acting organization.
 *
 * Replaces the placeholder that returned the first org in the database. Kept as
 * a named function because every existing server function already routes its
 * tenancy through this call.
 */
export async function currentOrgId(): Promise<string> {
  const { orgId } = await requireAuth();
  return orgId;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cookie plumbing
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Attach the session cookie.
 *
 * `httpOnly` keeps it away from XSS. `sameSite: lax` blocks cross-site POSTs
 * from carrying it, which is the CSRF defence for every mutating server
 * function here. `secure` is conditional only so that plain-HTTP localhost
 * development still works — in production it is always on.
 */
export function setSessionCookie(token: string, expiresAt: Date): void {
  setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(): void {
  deleteCookie(SESSION_COOKIE, { path: "/" });
}

/** Request provenance, recorded on sessions and in the audit log. */
export function requestContext(): { ipAddress: string | null; userAgent: string | null } {
  return {
    // xForwardedFor is trusted here because production sits behind a proxy. If
    // this ever runs with a directly-exposed origin, drop the flag — a spoofed
    // header would otherwise poison the audit trail.
    ipAddress: getRequestIP({ xForwardedFor: true }) ?? null,
    userAgent: getRequestHeader("user-agent") ?? null,
  };
}
