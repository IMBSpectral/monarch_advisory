/**
 * Integration test for withIdempotency — runs against a real database (needs an
 * org to exist, so run after db:seed). Proves a replayed key returns the stored
 * result without re-executing, distinct keys are independent, and a failed
 * operation releases its key for retry.
 *
 *   MONARCH_DB_ROLE=admin bun --env-file=.env src/db/test-idempotency.ts
 */
import { and, eq, like } from "drizzle-orm";
import { db, pgClient, withOrg } from "./client";
import { idempotencyKeys, organizations } from "./schema";
import { withIdempotency } from "@/server/idempotency";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

async function main() {
  const [org] = await db.select({ id: organizations.id }).from(organizations).limit(1);
  if (!org) throw new Error("No organization found — run db:seed first.");

  const suffix = Math.random().toString(36).slice(2);
  const key = `test-idem-${suffix}`;

  let calls = 0;
  const op = async () => {
    calls++;
    return { value: 42, callNumber: calls };
  };

  const r1 = await withIdempotency(org.id, key, "test.op", op);
  const r2 = await withIdempotency(org.id, key, "test.op", op);
  check("same key executes the operation exactly once", calls === 1);
  check("a replay returns the first result", r1.callNumber === 1 && r2.callNumber === 1);

  const r3 = await withIdempotency(org.id, `${key}-other`, "test.op", op);
  check("a different key runs independently", calls === 2 && r3.callNumber === 2);

  const noKey = await withIdempotency(org.id, undefined, "test.op", op);
  check("no key → always runs (opt-in)", calls === 3 && noKey.callNumber === 3);

  // A failed operation must release its key so the same key can be retried.
  const failKey = `test-idem-fail-${suffix}`;
  let attempts = 0;
  const flaky = async () => {
    attempts++;
    if (attempts === 1) throw new Error("boom");
    return { recovered: true };
  };
  let threw = false;
  try {
    await withIdempotency(org.id, failKey, "test.op", flaky);
  } catch {
    threw = true;
  }
  const retried = await withIdempotency(org.id, failKey, "test.op", flaky);
  check(
    "a failed op releases its key so a retry re-runs",
    threw && attempts === 2 && retried.recovered,
  );

  // Cleanup any keys this test created.
  await withOrg(org.id, (tx) =>
    tx
      .delete(idempotencyKeys)
      .where(
        and(eq(idempotencyKeys.orgId, org.id), like(idempotencyKeys.idempotencyKey, "test-idem-%")),
      ),
  );

  console.log(
    `\n${failures === 0 ? "All idempotency checks passed." : `${failures} check(s) FAILED.`}`,
  );
  await pgClient.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
