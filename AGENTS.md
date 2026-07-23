# Monarch Advisory — agent notes

Standalone TanStack Start + Drizzle/Postgres accounting app. No external editor
sync — commit and push on your own cadence.

- Money is integer minor units (paise, `bigint`). All journal entries post through
  the single `postJournalEntry` chokepoint and must sum to zero.
- Multi-tenancy is enforced by Postgres RLS via `withOrg(orgId, tx => ...)`.
- Tests: `bun run db:test` (ledger behavior), `bun run db:verify` (integrity
  invariants), `bun run e2e` (Playwright). Rebuild demo data with `bun run db:seed`.
