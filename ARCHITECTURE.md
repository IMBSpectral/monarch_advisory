# Monarch — Accounting Core

The financial foundation: a real double-entry ledger with Postgres persistence.
This is the spine that the rest of the platform hangs off.

## Running it

```bash
brew services start postgresql@17
createdb monarch_dev              # first time only
cp .env.example .env              # two URLs: app role + admin role

bun run db:migrate                # apply schema (also creates the monarch_app role)
bun run db:seed                   # load demo books from src/data/mock.ts
bun run db:verify                 # prove the seeded ledger is sound
bun run db:test                   # prove the engine rejects bad input
bun run dev
```

Two checks, and they test different things.

**`db:verify`** — the seeded books are internally consistent:

- every posted entry balances (debits = credits)
- the trial balance foots
- assets = liabilities + equity
- the A/R control account equals the aging subledger
- cached invoice payment totals match their allocations

**`db:test`** (34 assertions) — the engine actively _rejects_ bad input, which is
the more important property. A ledger that only works when fed correct data isn't
a safeguard. It covers: unbalanced and single-sided entries, posting to group
headers / nonexistent / cross-tenant accounts, closed-period posting, sign
inversion in `debit()`/`credit()`, draft invoices having no ledger impact,
double-posting, over-allocation beyond invoice balance and beyond cash received,
voiding an invoice that has payments, reversal without a reason, double-reversal,
and entry immutability — then re-checks every integrity invariant afterwards.

Both belong in CI. If either fails, the books are wrong and every report is wrong
with them.

## The three rules

Everything in `src/db/schema.ts` and `src/server/ledger.ts` follows from these.

**1. Money is integer minor units.** `bigint`, paise, never floats. `28500000n`
is ₹2,85,000.00. Floating-point money forces "close enough" comparisons, which is
how ledgers silently drift.

**2. The journal is the only source of truth.** Invoices, bills and payments are
_documents_ — they describe intent. Every balance, statement and report is derived
by aggregating `journal_lines`. There is deliberately no `balance` column on
`accounts`. If the ledger says it, the report says it, and the two cannot disagree.

**3. Posted entries are immutable.** Never updated, never deleted. A mistake is
corrected with a reversing entry that points back via `reverses_entry_id`. Both
entries stay in the ledger and net to zero. This is what makes the books auditable.

## Layout

```
src/db/
  schema.ts       tables, constraints, the three rules in comment form
  client.ts       pooled Drizzle client (HMR-safe)
  seed.ts         mock.ts → real posted transactions
  verify.ts       integrity checks + printed financial statements

src/server/
  ledger.ts       THE POSTING ENGINE — every rupee goes through here
  invoicing.ts    invoice create/post/void, payment allocation
  reports.ts      trial balance, P&L, balance sheet, aging, registers
  api.ts          TanStack server functions (the UI boundary)

src/lib/money.ts  display formatting — Indian grouping, lakh/crore compaction
```

### The posting engine

`postJournalEntry()` in `src/server/ledger.ts` is the single chokepoint. Nothing
else may insert into `journal_lines`. It enforces, in one transaction:

- the entry balances, on bigints, with no epsilon
- the period isn't closed (`organizations.books_closed_through`)
- accounts exist, are active, are leaves, and belong to this org
- a gap-free entry number, claimed with `SELECT … FOR UPDATE`
- an audit-log row

Use `debit()` / `credit()` helpers rather than writing signs by hand.

### Sign convention

`journal_lines.amount_minor` is signed: **positive = debit, negative = credit.**
One signed column instead of two means "does it balance" is `SUM(amount_minor) = 0`
— a cheap, total check — and every report is a plain `SUM` with no `CASE`.

Reports flip the sign for credit-normal accounts (liability, equity, income) so
revenue displays as a positive number.

### Account resolution

Document posting never hardcodes account codes. `resolveControlAccount()` finds
A/R, A/P and tax payable by `(subtype, is_system)`, so users can rename and
renumber their chart of accounts without breaking invoicing.

## A bug worth knowing about

The A/R aging report originally computed outstanding from
`invoices.amount_paid_minor` — a cached running total with no date dimension. An
aging report run "as of June" silently subtracted payments received in August, and
the total then disagreed with the A/R control account by exactly one partial
payment.

`verify.ts` caught it, because it cross-checks the control account against the
subledger. The fix was to derive outstanding from allocations joined to payments
with `payment_date <= asOf`. **This is rule 2 in miniature** — the moment a report
reads a cached document field instead of the ledger, it can disagree with the
ledger. Every new report should be checked against a control account.

## What exists vs. what doesn't

**Working, end to end:** chart of accounts, journal + posting engine, reversals,
period locking, contacts, invoices (create → post → pay → void), payment
allocation with over-allocation guards, tax on invoice lines, bank account
records, audit log, document numbering, trial balance, P&L, balance sheet, A/R
aging, account registers, dashboard.

**Auth — built.** `currentOrgId()` no longer returns the first org in the
database. The chain is cookie → `sessions` row → user → membership → org, and
every link is re-verified per request:

- `src/server/auth.ts` — password hashing (PBKDF2-HMAC-SHA256, 600k iterations
  via WebCrypto, so it works identically on Node, Bun and Workers), session
  issue/resolve/revoke, roles and capabilities, member administration.
- `src/server/session.ts` — `requireAuth()`, `requirePermission(capability)`,
  `currentOrgId()`, and the httpOnly / SameSite=Lax cookie plumbing.
- `src/api/auth.ts` — signup, login, logout, org switching, member management.
- `src/routes/__root.tsx` — `beforeLoad` gate with a public-route **allowlist**,
  so a newly added route is private by default.

Sessions are server-side rows, not sealed cookies, so logout and admin eviction
are real; only the SHA-256 of the token is stored. Five roles
(viewer → staff → accountant → admin → owner) map to capabilities in one table,
and mutating server functions call `requirePermission` rather than checking role
strings. The UI's `useCan()` hides controls but is **not** the boundary — the
server re-checks every time.

The seed creates one user per role plus an intentionally empty second tenant
("Sentinel Foods"), so cross-org leakage is visible rather than theoretical.

**Still stubbed, and it matters:**

- **Bills** are posted directly to the ledger in the seed rather than through a
  bill service. `src/server/bills.ts` is the mirror of `invoicing.ts` and is the
  next service to write.
  **Row-level security — built.** Tenancy is no longer application convention.

Every financial table (16 of them) has an RLS policy comparing `org_id` against a
transaction-local `app.org_id`, set by `withOrg()` in `src/db/client.ts`. Both
halves are covered: `USING` filters reads, `WITH CHECK` stops a caller writing a
row _into_ another tenant.

Three properties make this worth the plumbing:

1. **It fails closed.** `current_setting('app.org_id', true)` is NULL when unset,
   and `org_id = NULL` is never true — so a query that forgets its tenant scope
   returns _zero_ rows, not _all_ rows. A missed wrapper is an empty screen you
   find in minutes, not a leak you find in a breach report.
2. **The app can't bypass it.** Postgres exempts superusers unconditionally and
   owners unless `FORCE` is set. The app connects as `monarch_app`, an ordinary
   role that owns nothing; `FORCE` is on. Migrations and seeds use a _separate_
   `DATABASE_ADMIN_URL`, so bypassing tenancy takes a different connection string
   an operator must choose.
3. **The audit log is append-only in the database.** `UPDATE` and `DELETE` are
   revoked from `monarch_app`, so "no code path deletes audit rows" is a
   guarantee rather than a convention.

**Identity tables are deliberately exempt:** `users`, `sessions`, `memberships`,
`organizations`. Reading them is _how_ `app.org_id` gets decided, so gating them
on it is circular — migration 0002 tried it for `organizations` and broke login
outright, which migration 0003 undoes with the reasoning written down. These
carry no financial data, and the rule replacing RLS for them is small enough to
audit by reading one function: `resolveMembership()` returns only orgs the user
provably belongs to.

**CSRF:** server functions are covered by `createCsrfMiddleware` in `src/start.ts`.
The session cookie is `SameSite=Lax` as well — Lax is a browser-side mitigation
with known gaps, so origin verification on the server backs it up.

**Not started:** inventory valuation (FIFO/WAC), COGS on sale, credit notes,
vendor credits, expenses/receipts, bank feed ingestion and reconciliation
matching, recurring documents, approval workflows, projects, payroll, GST return
filing, e-invoicing, multi-currency revaluation, the AI layer.

## Deployment note

`vite.config.ts` builds Nitro targeting **Cloudflare Workers**. `postgres-js` needs
TCP, so production will need Hyperdrive, Neon's serverless driver, or a different
Nitro target. Local dev on Node is unaffected. Decide this before the first deploy
— it changes the driver in `src/db/client.ts`.

## Adding a module

1. Tables in `schema.ts`, `orgId` on every one, money as `bigint` minor units.
2. `bun run db:generate && bun run db:migrate`, then **add the new table to the
   RLS policy list** — copy the block in `drizzle/0002_row_level_security.sql`.
   A new table without a policy is readable across every tenant.
3. Reads and writes go through `withOrg(orgId, tx => …)`. If a query comes back
   mysteriously empty, that wrapper is the first thing to check.
4. A service in `src/server/` that posts through `postJournalEntry()` — never
   touch `journal_lines` directly.
5. Reports that aggregate `journal_lines`, never cached document columns.
6. A check in `verify.ts` cross-referencing the new subledger against its control
   account.
7. Server functions in `api.ts`, converting bigint → string at the boundary,
   guarded by `requireAuth`/`requirePermission`.
