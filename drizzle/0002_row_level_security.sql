-- Row-level security: make cross-tenant leakage structurally impossible.
--
-- Until now tenancy lived entirely in application code. Every query said
-- `where org_id = $1` by hand, which means one forgotten filter in one new
-- query silently serves another company's books. Code review is not a
-- sufficient control for that failure mode; the database should refuse.
--
-- HOW IT WORKS. The app sets a transaction-local `app.org_id` before running
-- tenant queries (see `withOrg()` in src/db/client.ts). Every policy below
-- compares `org_id` against that setting.
--
-- WHY IT FAILS CLOSED. `current_setting('app.org_id', true)` returns NULL when
-- the setting was never applied, and `org_id = NULL` is never true — so a query
-- that forgets to establish org context returns zero rows rather than every
-- row. A missed wrapper shows up immediately as an empty screen, which is a bug
-- you find in five minutes, instead of a leak you find in a breach report.
--
-- WHY A SEPARATE ROLE. Postgres exempts superusers from RLS unconditionally,
-- and table owners unless FORCE ROW LEVEL SECURITY is set. The app therefore
-- must not connect as either. `monarch_app` is an ordinary role holding only
-- DML rights; migrations and seeds keep using the owning role.

/* ────────────────────────────────────────────────────────────────────────────
 * The application role
 * ──────────────────────────────────────────────────────────────────────────*/

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monarch_app') THEN
    -- No password: local development authenticates by trust/peer. Production
    -- must set one (ALTER ROLE monarch_app WITH PASSWORD '…') and connect over
    -- TLS; this role is deliberately not a superuser and owns nothing.
    CREATE ROLE monarch_app LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO monarch_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO monarch_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO monarch_app;

-- Tables added by future migrations inherit these grants automatically, so a
-- new table is never accidentally unreachable (or, worse, granted by hand with
-- wider rights than intended).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO monarch_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO monarch_app;

/*
 * The audit log is append-only. Application code has no update or delete path,
 * but "no code path" is a convention; revoking the privilege is a guarantee.
 * A tampered audit trail is worse than no audit trail, because it is trusted.
 */
REVOKE UPDATE, DELETE ON audit_log FROM monarch_app;

/* ────────────────────────────────────────────────────────────────────────────
 * Policies on org-scoped tables
 * ──────────────────────────────────────────────────────────────────────────*/

DO $$
DECLARE
  t text;
  org_scoped text[] := ARRAY[
    'accounts', 'audit_log', 'bank_accounts', 'bank_transactions',
    'bill_lines', 'bills', 'contacts', 'document_sequences',
    'invoice_lines', 'invoices', 'items', 'journal_entries',
    'journal_lines', 'payment_allocations', 'payments', 'tax_rates'
  ];
BEGIN
  FOREACH t IN ARRAY org_scoped LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE also subjects the table owner to the policies, so a migration or
    -- an admin console session can't quietly read across tenants either.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);

    -- USING filters what is visible to SELECT/UPDATE/DELETE.
    -- WITH CHECK constrains what INSERT/UPDATE may write, which is what stops
    -- a caller writing a row *into* another tenant by supplying a foreign
    -- org_id. Reading and writing need separate guards; one without the other
    -- is a half-closed door.
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (org_id = current_setting(''app.org_id'', true)::uuid)
         WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)',
      t || '_tenant_isolation', t
    );
  END LOOP;
END
$$;

/*
 * `organizations` is keyed by `id`, not `org_id`, so it needs its own policy.
 * Without this, the org row itself (name, GSTIN, fiscal settings) would stay
 * globally readable while all of its data was protected.
 */
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organizations_tenant_isolation ON organizations;
CREATE POLICY organizations_tenant_isolation ON organizations
  USING (id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (id = current_setting('app.org_id', true)::uuid);

/*
 * IDENTITY TABLES ARE DELIBERATELY EXCLUDED: users, sessions, memberships.
 *
 * They are read *before* an org context can exist — resolving a cookie to a
 * user, and a user to the orgs they belong to, is precisely how `app.org_id`
 * gets decided. Putting them behind a policy keyed on that setting would make
 * login impossible: the lookup that establishes the tenant cannot itself
 * require the tenant.
 *
 * These three are guarded by application logic instead, and the constraint that
 * matters is narrow enough to state plainly: `resolveMembership()` in
 * src/server/auth.ts only ever returns an org the user provably belongs to,
 * so a tampered session cookie cannot widen access. Any new query against
 * `memberships` must filter by `user_id` for the same reason.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Bypass role for maintenance
 * ──────────────────────────────────────────────────────────────────────────*/

/*
 * Seeds, integrity verification and cross-tenant reporting legitimately need to
 * see everything. They connect as the owning role via DATABASE_ADMIN_URL rather
 * than being granted an exception here, so the escape hatch is a different
 * connection string an operator must choose — not a flag the app could set.
 */
