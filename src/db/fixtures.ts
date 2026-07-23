/**
 * Constants shared between the seed and the scripts that check it.
 *
 * These live apart from `seed.ts` because that file runs `main()` on import —
 * importing a name from it would wipe and rebuild the database as a side effect.
 */

/** The org that carries the demo books. `verify.ts` and `test-ledger.ts` pin to it. */
export const SEEDED_ORG_NAME = "IMB Labs LLP";

/**
 * The empty second tenant. Its whole purpose is to be empty: if a query ever
 * leaks across orgs, data shows up here, and that is the signal.
 */
export const SEEDED_OTHER_ORG_NAME = "Sentinel Foods Pvt Ltd";

/** Password for every seeded account. Development fixtures only. */
export const DEMO_PASSWORD = "monarch-demo-2026";

export const DEMO_LOGINS = [
  { email: "founder@imblabs.example", role: "owner", org: SEEDED_ORG_NAME },
  { email: "accountant@imblabs.example", role: "accountant", org: SEEDED_ORG_NAME },
  { email: "staff@imblabs.example", role: "staff", org: SEEDED_ORG_NAME },
  { email: "viewer@imblabs.example", role: "viewer", org: SEEDED_ORG_NAME },
  { email: "owner@sentinel.example", role: "owner", org: SEEDED_OTHER_ORG_NAME },
] as const;
