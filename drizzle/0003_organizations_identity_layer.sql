-- Move `organizations` out of RLS and into the identity layer.
--
-- Migration 0002 put a policy on `organizations` keyed on `app.org_id`. That
-- looked consistent, and it broke login outright.
--
-- THE ORDERING PROBLEM. `app.org_id` is decided by resolving a session cookie to
-- a user, then to their memberships, then to an organization. Resolving that
-- chain requires reading `organizations` — so the table needed to *establish*
-- the tenant cannot itself be gated on the tenant. Auth resolution ran with no
-- setting applied, the policy evaluated false, the join returned nothing, and
-- every signed-in user was bounced back to the login page.
--
-- This is the same reason `users`, `sessions` and `memberships` were excluded
-- from the start; `organizations` belongs with them and was misfiled.
--
-- WHAT IS AND ISN'T GIVEN UP. `organizations` holds tenant metadata — name,
-- GSTIN, fiscal year, timezone. It holds no transactions, balances or amounts.
-- Every table that carries financial data keeps its policy, so the leak that
-- actually matters stays impossible at the database level.
--
-- The guarantee that replaces it is narrow enough to audit by reading one
-- function: `resolveMembership()` in src/server/auth.ts returns only orgs the
-- user provably belongs to, and it is the sole path by which `app.org_id` is
-- chosen. Any new query against `organizations` must filter by an id obtained
-- that way, exactly as queries against `memberships` must filter by `user_id`.
--
-- The alternative considered was a policy allowing rows the current user is a
-- member of, via a second `app.user_id` setting. It works, but it puts a
-- subquery against `memberships` in the hot path of every organization read and
-- splits the tenancy rule across two mechanisms. A policy that is hard to reason
-- about is its own kind of risk; this is the more honest trade.

DROP POLICY IF EXISTS organizations_tenant_isolation ON organizations;
ALTER TABLE organizations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organizations DISABLE ROW LEVEL SECURITY;
