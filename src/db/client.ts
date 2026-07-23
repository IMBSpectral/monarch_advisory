import { drizzle } from "drizzle-orm/postgres-js";
import { sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * TWO CONNECTION STRINGS, ON PURPOSE.
 *
 * `DATABASE_URL` is the application's, and it authenticates as `monarch_app` —
 * an ordinary role that owns nothing and is subject to row-level security.
 *
 * `DATABASE_ADMIN_URL` is the owner's, used only by migrations, the seed, and
 * the integrity checks, which legitimately need to see every tenant at once.
 *
 * They are separate because Postgres exempts superusers from RLS entirely and
 * table owners unless FORCE is set. If the app connected as the owner, every
 * policy in migration 0002 would be decorative. Keeping the privileged
 * connection in a *different variable* means bypassing tenancy takes a
 * deliberate act by an operator, not a forgotten wrapper in a new query.
 */
/**
 * Which role this process connects as is decided by an explicit environment
 * flag, not by anything the request can influence. `MONARCH_DB_ROLE=admin` is
 * set only by the `db:seed`, `db:verify` and `db:test` scripts in package.json.
 * The dev server and production never set it, so they cannot reach the
 * privileged connection even if a bug tried to.
 */
const useAdminRole = process.env.MONARCH_DB_ROLE === "admin";
const connectionString = useAdminRole
  ? (process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL)
  : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and point it at your Postgres instance.",
  );
}

/**
 * One pooled client per process. In dev, Vite re-executes modules on HMR, so we
 * stash the client on globalThis — otherwise every save leaks a connection pool
 * and Postgres starts refusing connections after ~20 edits.
 */
const globalForDb = globalThis as unknown as {
  __monarchSql?: ReturnType<typeof postgres>;
};

const sql =
  globalForDb.__monarchSql ??
  postgres(connectionString, {
    max: 10,
    // bigint columns arrive as strings by default; the schema declares
    // mode: "bigint" so drizzle converts, but this keeps raw queries honest.
    transform: { undefined: null },
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__monarchSql = sql;
}

export const db = drizzle(sql, { schema, casing: "snake_case" });

/** Raw driver handle, for the rare query drizzle can't express. */
export { sql as pgClient };

export type Db = typeof db;

/**
 * Anything inside a transaction gets this type. The posting engine takes it so
 * that callers can compose several ledger operations into one atomic unit.
 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/* ────────────────────────────────────────────────────────────────────────────
 * Tenant context
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Run `fn` with row-level security scoped to one organization.
 *
 * Everything that reads or writes tenant data goes through here. The callback
 * receives a transaction with `app.org_id` established, and every RLS policy in
 * migration 0002 compares against it — so the database, not the query author,
 * decides which rows exist.
 *
 * WHY A TRANSACTION. `set_config(..., true)` is transaction-local. That matters
 * because postgres-js pools connections: a plain `SET` would persist on the
 * connection and leak one request's tenant into whoever is handed that
 * connection next, which is the precise bug this whole mechanism exists to
 * prevent. The transaction boundary is what makes the setting safe to use under
 * pooling, so this must never be "optimised" into a bare SET.
 *
 * FORGETTING TO USE THIS IS SAFE. Queries run on the bare `db` handle have no
 * `app.org_id`, `current_setting(…, true)` yields NULL, and every policy
 * evaluates false — the query returns nothing instead of returning everything.
 * The failure is loud and local, not silent and cross-tenant.
 */
export async function withOrg<T>(orgId: string, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** True when this process deliberately connected as the privileged role. */
export const isAdminConnection = useAdminRole;
