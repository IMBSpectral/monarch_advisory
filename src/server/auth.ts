/**
 * Authentication and tenancy resolution.
 *
 * This module answers exactly one question, and every server function depends on
 * the answer: *who is making this request, and which org's books may they touch?*
 *
 * Before this existed, `currentOrgId()` returned the first organization in the
 * database. That meant there was no access control at all — any caller saw any
 * tenant's ledger. Everything here exists to close that hole.
 *
 * THE CHAIN. cookie token → session row → user → membership → org. Every link is
 * re-verified on every request. Nothing is trusted from the client, and the
 * session's cached `activeOrgId` is always re-checked against `memberships`
 * before it grants anything — a stale or tampered value must never widen access.
 *
 * PASSWORD HASHING uses PBKDF2-HMAC-SHA256 via WebCrypto at OWASP's recommended
 * 600,000 iterations. Argon2id is the stronger primitive and would be the right
 * call on a fixed Node deployment, but it needs a native module: ARCHITECTURE.md
 * records that the Nitro target is Cloudflare Workers, where native addons don't
 * run. PBKDF2 through WebCrypto is the strongest option that works identically
 * on Node, Bun and Workers, so the deployment decision can't silently break
 * everyone's ability to log in. Revisit if the target is settled as Node.
 */

import { and, eq, isNull, gt, sql as dsql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { db } from "@/db/client";
import { memberships, organizations, sessions, users } from "@/db/schema";
import { writeAudit } from "./ledger";
import { provisionOrgDefaults } from "./provisioning";

/* ────────────────────────────────────────────────────────────────────────────
 * Errors
 * ──────────────────────────────────────────────────────────────────────────*/

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Mapped to an HTTP status at the server-function boundary. */
    readonly status: number = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Roles
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Roles are ordered by breadth of authority. `rank` exists so a check can ask
 * "at least an accountant?" without enumerating every role above it.
 *
 * The split that matters is `accountant` vs `staff`: staff raise documents,
 * accountants post them to the ledger. Segregation of duties is an audit
 * requirement, not a nicety — the person who creates an invoice should not
 * necessarily be the person who can void it.
 */
export const ROLES = ["viewer", "staff", "accountant", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  staff: 1,
  accountant: 2,
  admin: 3,
  owner: 4,
};

/**
 * Capability → minimum role. Server functions check capabilities, never role
 * strings, so that widening or narrowing a permission is a one-line change here
 * rather than a grep across the codebase.
 */
export const CAPABILITIES = {
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
} as const satisfies Record<string, Role>;

export type Capability = keyof typeof CAPABILITIES;

/** Normalise whatever is in the DB to a known role, failing closed to `viewer`. */
export function normalizeRole(raw: string | null | undefined): Role {
  return (ROLES as readonly string[]).includes(raw ?? "") ? (raw as Role) : "viewer";
}

/* ────────────────────────────────────────────────────────────────────────────
 * The acting principal
 * ──────────────────────────────────────────────────────────────────────────*/

/** Who is acting, on whose books, with what authority. */
export type Principal = {
  userId: string;
  email: string;
  name: string;
  sessionId: string;
  orgId: string;
  orgName: string;
  baseCurrency: string;
  role: Role;
  /** Fine-grained grants layered on top of the role. */
  permissions: string[];
};

/**
 * Does this principal hold a capability?
 *
 * Two ways to qualify: the role outranks the requirement, or the capability is
 * granted explicitly in `memberships.permissions`. The explicit grant only ever
 * *adds* — there is deliberately no deny list, because a deny list that can be
 * bypassed by a role change is worse than no deny list at all.
 */
export function can(principal: Principal, capability: Capability): boolean {
  if (principal.permissions.includes(capability)) return true;
  const required = CAPABILITIES[capability];
  return ROLE_RANK[principal.role] >= ROLE_RANK[required];
}

/** Throwing form, for use at the top of every mutating server function. */
export function assertCan(principal: Principal, capability: Capability): void {
  if (!can(principal, capability)) {
    throw new AuthError(
      `Your role (${principal.role}) does not permit ${capability}.`,
      "forbidden",
      403,
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Password hashing
 * ──────────────────────────────────────────────────────────────────────────*/

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_KEY_BITS = 256;
const SALT_BYTES = 16;

/**
 * Stored format: `pbkdf2$<iterations>$<salt-b64>$<hash-b64>`.
 *
 * The iteration count travels with the hash so it can be raised later without
 * invalidating existing passwords — `verifyPassword` reads the cost from the
 * stored string rather than assuming today's constant.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

/**
 * Constant-time verification.
 *
 * Returns false rather than throwing on a malformed stored hash: a corrupted
 * row must read as "wrong password", never as an error that distinguishes this
 * account from any other.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = unb64(parts[2]);
    expected = unb64(parts[3]);
  } catch {
    return false;
  }

  const actual = await pbkdf2(password, salt, iterations, expected.length * 8);
  return timingSafeEqual(actual, expected);
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  bits: number = PBKDF2_KEY_BITS,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    bits,
  );
  return new Uint8Array(derived);
}

/**
 * Compare without leaking length or content through timing.
 *
 * The length check short-circuits, which leaks *length* — acceptable here
 * because both operands are fixed-width digests, so the length is not secret.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Session tokens
 * ──────────────────────────────────────────────────────────────────────────*/

export const SESSION_COOKIE = "monarch_session";
const SESSION_TTL_DAYS = 30;
/** Refresh `lastSeenAt` at most this often, to keep reads from writing constantly. */
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/** 256 bits of CSPRNG output, hex. This is the only form the client ever sees. */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SHA-256 of the token. Plain, unsalted, no stretching — deliberately.
 *
 * A session token is already 256 bits of uniform randomness, so it has no
 * structure to brute-force and nothing to salt against; the hash exists purely
 * so a database leak yields no usable credential. Stretching it would cost real
 * latency on every single request and buy nothing.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Issue a session. Returns the raw token for the cookie — it is never stored,
 * and this is the only moment it exists outside the client.
 */
export async function createSession(
  userId: string,
  opts: { orgId?: string | null; ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash,
      activeOrgId: opts.orgId ?? null,
      expiresAt,
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
    })
    .returning({ id: sessions.id });

  return { token, sessionId: row.id, expiresAt };
}

/**
 * Resolve a cookie token to a full principal, or null if it is invalid for any
 * reason (unknown, revoked, expired, user or membership since removed).
 *
 * Null rather than throw: an expired session is a normal condition that should
 * redirect to login, not surface as an error.
 */
export async function resolveSession(token: string | undefined): Promise<Principal | null> {
  if (!token) return null;

  const tokenHash = await hashToken(token);

  const [row] = await db
    .select({
      sessionId: sessions.id,
      activeOrgId: sessions.activeOrgId,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      email: users.email,
      name: users.name,
      userDeletedAt: users.deletedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row || row.userDeletedAt) return null;

  // The membership is the authority on tenancy, not the session's cached org.
  const membership = await resolveMembership(row.userId, row.activeOrgId);
  if (!membership) return null;

  // Heal a session pointing at an org the user has since left, so the next
  // request doesn't repeat this lookup.
  if (row.activeOrgId !== membership.orgId) {
    await db
      .update(sessions)
      .set({ activeOrgId: membership.orgId })
      .where(eq(sessions.id, row.sessionId));
  }

  if (Date.now() - row.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.sessionId));
  }

  return {
    userId: row.userId,
    email: row.email,
    name: row.name,
    sessionId: row.sessionId,
    orgId: membership.orgId,
    orgName: membership.orgName,
    baseCurrency: membership.baseCurrency,
    role: membership.role,
    permissions: membership.permissions,
  };
}

/**
 * Find the membership for a user, preferring `preferredOrgId` when they still
 * belong to it and falling back to their oldest membership otherwise.
 *
 * This is the single point where "which tenant?" is decided. It only ever
 * returns an org the user provably belongs to, which is what makes a tampered
 * session cookie harmless.
 */
async function resolveMembership(
  userId: string,
  preferredOrgId: string | null,
): Promise<{
  orgId: string;
  orgName: string;
  baseCurrency: string;
  role: Role;
  permissions: string[];
} | null> {
  const rows = await db
    .select({
      orgId: memberships.orgId,
      role: memberships.role,
      permissions: memberships.permissions,
      orgName: organizations.name,
      baseCurrency: organizations.baseCurrency,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), isNull(memberships.deletedAt)))
    .orderBy(memberships.createdAt);

  if (rows.length === 0) return null;

  const chosen = rows.find((r) => r.orgId === preferredOrgId) ?? rows[0];
  return {
    orgId: chosen.orgId,
    orgName: chosen.orgName,
    baseCurrency: chosen.baseCurrency,
    role: normalizeRole(chosen.role),
    permissions: chosen.permissions ?? [],
  };
}

/** All orgs this user may act on — powers the org switcher. */
export async function listMemberships(
  userId: string,
): Promise<Array<{ orgId: string; orgName: string; role: Role }>> {
  const rows = await db
    .select({
      orgId: memberships.orgId,
      orgName: organizations.name,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), isNull(memberships.deletedAt)))
    .orderBy(organizations.name);

  return rows.map((r) => ({ ...r, role: normalizeRole(r.role) }));
}

/**
 * Point a session at a different org. Refuses if the user has no membership
 * there — this is the guard that stops org switching from being a tenancy hole.
 */
export async function switchActiveOrg(principal: Principal, orgId: string): Promise<void> {
  const [membership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, principal.userId),
        eq(memberships.orgId, orgId),
        isNull(memberships.deletedAt),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new AuthError("You do not have access to that organization.", "forbidden", 403);
  }

  await db.update(sessions).set({ activeOrgId: orgId }).where(eq(sessions.id, principal.sessionId));
}

/** Revoke one session (logout). Idempotent. */
export async function revokeSession(sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/** Revoke every live session for a user — "log out everywhere", or eviction. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Registration & login
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Minimum password policy. Deliberately length-first: NIST SP 800-63B advises
 * length over composition rules, which mostly teach people to write `Passw0rd!`.
 */
export function validatePassword(password: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (password.length > 200) return "Password must be at most 200 characters.";
  return null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Verify an email/password pair.
 *
 * Runs a dummy hash comparison when the account doesn't exist so that a missing
 * user and a wrong password take the same time — otherwise the response time is
 * an account-enumeration oracle.
 */
export async function authenticate(
  email: string,
  password: string,
): Promise<{ userId: string } | null> {
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);

  if (!user || !user.passwordHash || user.deletedAt) {
    await verifyPassword(password, await dummyHash());
    return null;
  }

  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? { userId: user.id } : null;
}

/**
 * A real, syntactically valid hash used only to burn the same CPU time as a
 * genuine check when the account doesn't exist.
 *
 * Built once per process and reused. It must carry the *current* iteration
 * count, otherwise the decoy is cheaper than a real verify and the timing
 * signal it exists to erase comes straight back.
 */
let dummyHashPromise: Promise<string> | undefined;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(generateSessionToken());
  return dummyHashPromise;
}

/**
 * Create a user, their organization, and an owner membership in one transaction.
 *
 * All three or none: a user with no org would be stranded at a dead end, and an
 * org with no owner would be unadministrable.
 */
export async function registerOwner(args: {
  email: string;
  name: string;
  password: string;
  orgName: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<{ userId: string; orgId: string }> {
  const email = normalizeEmail(args.email);

  const policyError = validatePassword(args.password);
  if (policyError) throw new AuthError(policyError, "weak_password", 400);

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    throw new AuthError("An account with that email already exists.", "email_taken", 409);
  }

  const passwordHash = await hashPassword(args.password);

  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: args.orgName })
      .returning({ id: organizations.id });

    // audit_log, accounts and document_sequences are all RLS-scoped
    // (WITH CHECK org_id = app.org_id), so the writes below are rejected unless
    // this transaction declares its tenant. The org row itself is exempt
    // (identity table), which is the only reason it could be inserted a line
    // above without this being set first.
    await tx.execute(dsql`select set_config('app.org_id', ${org.id}, true)`);

    // A new org has no books yet — provision a default chart of accounts and
    // document sequences so invoicing, billing, and every posting flow work
    // from the very first sign-in.
    await provisionOrgDefaults(tx, org.id);

    const [user] = await tx
      .insert(users)
      .values({ email, name: args.name, passwordHash })
      .returning({ id: users.id });

    await tx.insert(memberships).values({
      orgId: org.id,
      userId: user.id,
      role: "owner",
      permissions: [],
    });

    await writeAudit(tx, {
      orgId: org.id,
      userId: user.id,
      action: "org.created",
      entityType: "organization",
      entityId: org.id,
      after: { name: args.orgName },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });

    return { userId: user.id, orgId: org.id };
  });
}

/**
 * Invite an existing-or-new user into an org with a role. Returns the user id.
 * Requires `member:manage` at the call site.
 */
export async function addMember(args: {
  orgId: string;
  email: string;
  name: string;
  role: Role;
  password?: string;
  actorUserId: string;
}): Promise<{ userId: string }> {
  const email = normalizeEmail(args.email);

  return db.transaction(async (tx) => {
    // Declare the tenant so the RLS-scoped audit_log write at the end passes.
    await tx.execute(dsql`select set_config('app.org_id', ${args.orgId}, true)`);

    let [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      if (!args.password) {
        throw new AuthError(
          "A password is required when inviting a brand-new user.",
          "password_required",
          400,
        );
      }
      const policyError = validatePassword(args.password);
      if (policyError) throw new AuthError(policyError, "weak_password", 400);

      const passwordHash = await hashPassword(args.password);
      [user] = await tx
        .insert(users)
        .values({ email, name: args.name, passwordHash })
        .returning({ id: users.id });
    }

    const [already] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.orgId, args.orgId), eq(memberships.userId, user.id)))
      .limit(1);

    if (already) {
      throw new AuthError("That person is already a member.", "already_member", 409);
    }

    await tx.insert(memberships).values({
      orgId: args.orgId,
      userId: user.id,
      role: args.role,
      permissions: [],
    });

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.actorUserId,
      action: "member.added",
      entityType: "membership",
      entityId: user.id,
      after: { email, role: args.role },
    });

    return { userId: user.id };
  });
}

/**
 * Change a member's role.
 *
 * Refuses to remove the last owner. An org with no owner cannot grant roles,
 * close periods, or manage billing — it is permanently stuck, and no
 * application path should be able to create that state.
 */
export async function changeMemberRole(args: {
  orgId: string;
  userId: string;
  role: Role;
  actorUserId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    // Declare the tenant so the RLS-scoped audit_log write at the end passes.
    await tx.execute(dsql`select set_config('app.org_id', ${args.orgId}, true)`);

    const [current] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.orgId, args.orgId), eq(memberships.userId, args.userId)))
      .limit(1);

    if (!current) throw new AuthError("No such member.", "not_found", 404);

    if (current.role === "owner" && args.role !== "owner") {
      const [{ count }] = await tx
        .select({ count: dsql<number>`count(*)::int` })
        .from(memberships)
        .where(
          and(
            eq(memberships.orgId, args.orgId),
            eq(memberships.role, "owner"),
            isNull(memberships.deletedAt),
          ),
        );
      if (count <= 1) {
        throw new AuthError(
          "This is the only owner. Promote someone else to owner first.",
          "last_owner",
          409,
        );
      }
    }

    await tx
      .update(memberships)
      .set({ role: args.role, updatedAt: new Date() })
      .where(and(eq(memberships.orgId, args.orgId), eq(memberships.userId, args.userId)));

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.actorUserId,
      action: "member.role_changed",
      entityType: "membership",
      entityId: args.userId,
      before: { role: current.role },
      after: { role: args.role },
    });
  });
}

/** Change your own password, and evict every other session as a side effect. */
export async function changePassword(args: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  keepSessionId?: string;
}): Promise<void> {
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, args.userId))
    .limit(1);

  if (!user?.passwordHash) throw new AuthError("No such user.", "not_found", 404);

  if (!(await verifyPassword(args.currentPassword, user.passwordHash))) {
    throw new AuthError("Current password is incorrect.", "bad_password", 403);
  }

  const policyError = validatePassword(args.newPassword);
  if (policyError) throw new AuthError(policyError, "weak_password", 400);

  const passwordHash = await hashPassword(args.newPassword);

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, args.userId));

    // A password change is how someone responds to a suspected compromise, so
    // every other session must die with it.
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, args.userId), isNull(sessions.revokedAt)));
  });
}

export type { DbOrTx };
