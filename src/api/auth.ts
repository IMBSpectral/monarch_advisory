/**
 * Auth server functions — signup, login, logout, org switching, member admin.
 *
 * These are the only functions in the app that may be called without an existing
 * session. Everything else in `src/api/` begins with `requireAuth()`.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  addMember,
  authenticate,
  changeMemberRole,
  changePassword,
  createSession,
  listMemberships,
  registerOwner,
  revokeAllSessions,
  revokeSession,
  switchActiveOrg,
  ROLES,
} from "@/server/auth";
import {
  clearSessionCookie,
  optionalAuth,
  requireAuth,
  requirePermission,
  requestContext,
  setSessionCookie,
} from "@/server/session";

/* ────────────────────────────────────────────────────────────────────────────
 * Who am I
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * The current principal plus their org list, or null when signed out.
 *
 * Returns null rather than throwing so the root route can use it to decide
 * between rendering the app and redirecting to /login.
 */
export const fetchMe = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await optionalAuth();
  if (!principal) return null;

  return {
    userId: principal.userId,
    email: principal.email,
    name: principal.name,
    orgId: principal.orgId,
    orgName: principal.orgName,
    baseCurrency: principal.baseCurrency,
    role: principal.role,
    permissions: principal.permissions,
    organizations: await listMemberships(principal.userId),
  };
});

/* ────────────────────────────────────────────────────────────────────────────
 * Signup / login / logout
 * ──────────────────────────────────────────────────────────────────────────*/

const signupSchema = z.object({
  name: z.string().trim().min(1, "Your name is required.").max(200),
  email: z.string().trim().email("Enter a valid email address.").max(320),
  password: z.string().min(1, "A password is required.").max(200),
  orgName: z.string().trim().min(1, "An organization name is required.").max(200),
});

/**
 * Create an owner, their org, and a live session in one go.
 *
 * Signing the user straight in is deliberate: bouncing someone to a login form
 * to retype credentials they just chose adds nothing, since registering already
 * proved they control them.
 */
export const signupFn = createServerFn({ method: "POST" })
  .validator(signupSchema)
  .handler(async ({ data }) => {
    const ctx = requestContext();

    const { userId, orgId } = await registerOwner({
      email: data.email,
      name: data.name,
      password: data.password,
      orgName: data.orgName,
      ...ctx,
    });

    const { token, expiresAt } = await createSession(userId, { orgId, ...ctx });
    setSessionCookie(token, expiresAt);

    return { userId, orgId };
  });

const loginSchema = z.object({
  email: z.string().trim().min(1, "Enter your email.").max(320),
  password: z.string().min(1, "Enter your password.").max(200),
});

/**
 * Exchange credentials for a session.
 *
 * The failure message is identical whether the email is unknown or the password
 * is wrong — pairing that with the constant-time path in `authenticate()` is
 * what stops this endpoint from confirming which emails have accounts.
 */
export const loginFn = createServerFn({ method: "POST" })
  .validator(loginSchema)
  .handler(async ({ data }) => {
    const result = await authenticate(data.email, data.password);
    if (!result) {
      return { ok: false as const, error: "Incorrect email or password." };
    }

    const ctx = requestContext();
    const { token, expiresAt } = await createSession(result.userId, ctx);
    setSessionCookie(token, expiresAt);

    return { ok: true as const };
  });

/**
 * End the session server-side, then drop the cookie.
 *
 * Revoking first matters: if the cookie were cleared but revocation failed, a
 * copy of the token taken earlier would still be a working credential.
 */
export const logoutFn = createServerFn({ method: "POST" }).handler(async () => {
  const principal = await optionalAuth();
  if (principal) {
    await revokeSession(principal.sessionId);
  }
  clearSessionCookie();
  return { ok: true };
});

/** Sign out of every device. */
export const logoutEverywhereFn = createServerFn({ method: "POST" }).handler(async () => {
  const principal = await requireAuth();
  await revokeAllSessions(principal.userId);
  clearSessionCookie();
  return { ok: true };
});

/* ────────────────────────────────────────────────────────────────────────────
 * Organization switching
 * ──────────────────────────────────────────────────────────────────────────*/

export const switchOrgFn = createServerFn({ method: "POST" })
  .validator(z.object({ orgId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const principal = await requireAuth();
    await switchActiveOrg(principal, data.orgId);
    return { ok: true };
  });

/* ────────────────────────────────────────────────────────────────────────────
 * Members
 * ──────────────────────────────────────────────────────────────────────────*/

export const fetchMembersFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await requirePermission("member:manage");
  const { db } = await import("@/db/client");
  const { memberships, users } = await import("@/db/schema");
  const { and, eq, isNull } = await import("drizzle-orm");

  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, principal.orgId), isNull(memberships.deletedAt)))
    .orderBy(memberships.createdAt);

  return rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
});

export const addMemberFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      email: z.string().trim().email().max(320),
      name: z.string().trim().min(1).max(200),
      role: z.enum(ROLES),
      password: z.string().max(200).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const principal = await requirePermission("member:manage");
    return addMember({
      orgId: principal.orgId,
      email: data.email,
      name: data.name,
      role: data.role,
      password: data.password,
      actorUserId: principal.userId,
    });
  });

export const changeMemberRoleFn = createServerFn({ method: "POST" })
  .validator(z.object({ userId: z.string().uuid(), role: z.enum(ROLES) }))
  .handler(async ({ data }) => {
    const principal = await requirePermission("member:manage");
    await changeMemberRole({
      orgId: principal.orgId,
      userId: data.userId,
      role: data.role,
      actorUserId: principal.userId,
    });
    return { ok: true };
  });

export const changePasswordFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      currentPassword: z.string().min(1).max(200),
      newPassword: z.string().min(1).max(200),
    }),
  )
  .handler(async ({ data }) => {
    const principal = await requireAuth();
    await changePassword({
      userId: principal.userId,
      currentPassword: data.currentPassword,
      newPassword: data.newPassword,
    });
    // Every session died, including this one. Issue a fresh cookie so the user
    // who just changed their password isn't the one person logged out by it.
    const ctx = requestContext();
    const { token, expiresAt } = await createSession(principal.userId, {
      orgId: principal.orgId,
      ...ctx,
    });
    setSessionCookie(token, expiresAt);
    return { ok: true };
  });
