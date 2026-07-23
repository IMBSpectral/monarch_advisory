import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: {
    /*
     * Migrations run as the owner, never as the application role. `monarch_app`
     * holds only DML rights by design, so it cannot create tables — and the
     * moment it could, the RLS policies it is subject to would be its own to
     * drop. Prefer the admin URL and fall back only for setups that haven't
     * split the roles yet.
     */
    url:
      process.env.DATABASE_ADMIN_URL ??
      process.env.DATABASE_URL ??
      "postgres://localhost:5432/monarch_dev",
  },
  verbose: true,
  strict: true,
});
