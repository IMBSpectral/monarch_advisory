# Monarch — Accounting Core

The financial foundation: a real double-entry ledger with Postgres persistence.
This is the spine that the rest of the platform hangs off.

## Running it

```bash
brew services start postgresql@17
createdb monarch_dev              # first time only
cp .env.example .env              # point DATABASE_URL at it

bun run db:migrate                # apply schema
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

**`db:test`** (34 assertions) — the engine actively *rejects* bad input, which is
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
*documents* — they describe intent. Every balance, statement and report is derived
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

**Stubbed, and it matters:**

- **Auth.** `currentOrgId()` in `src/server/api.ts` returns the first org in the
  database. Real session → user → membership → org resolution is the next thing to
  build. Every server function already routes tenancy through that one function,
  so it's a one-file swap. **Nothing is access-controlled until this is done.**
- **Bills** are posted directly to the ledger in the seed rather than through a
  bill service. `src/server/bills.ts` is the mirror of `invoicing.ts` and is the
  next service to write.
- **Row-level security.** Tenancy is enforced in application code, not by the
  database. A missed `orgId` filter in a new query leaks across tenants. Postgres
  RLS would make that structurally impossible.

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
2. `bun run db:generate && bun run db:migrate`.
3. A service in `src/server/` that posts through `postJournalEntry()` — never
   touch `journal_lines` directly.
4. Reports that aggregate `journal_lines`, never cached document columns.
5. A check in `verify.ts` cross-referencing the new subledger against its control
   account.
6. Server functions in `api.ts`, converting bigint → string at the boundary.
