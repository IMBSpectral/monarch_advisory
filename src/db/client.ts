import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

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
