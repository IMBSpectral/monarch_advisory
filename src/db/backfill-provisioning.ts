/**
 * One-off backfill: ensure every existing org has complete books (chart,
 * sequences, tax rates, a bank account). Idempotent — a fully-provisioned org
 * is a no-op. Run with the owner connection (bypasses RLS):
 *
 *   MONARCH_DB_ROLE=admin DATABASE_ADMIN_URL=<owner url> bun src/db/backfill-provisioning.ts
 */
import { db, pgClient } from "./client";
import { organizations } from "./schema";
import { ensureOrgProvisioned } from "@/server/provisioning";

async function main() {
  const orgs = await db.select({ id: organizations.id, name: organizations.name }).from(organizations);
  for (const org of orgs) {
    await ensureOrgProvisioned(db, org.id);
    console.log(`  provisioned ${org.name}`);
  }
  console.log(`\nDone — ${orgs.length} org(s) checked.`);
  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
