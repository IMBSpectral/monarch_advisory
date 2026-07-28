/**
 * Idempotency for mutating server functions.
 *
 * A client sends a stable `idempotencyKey` with a mutation. The FIRST request
 * for a given (org, key) runs the operation and stores its result; any REPLAY —
 * a double-submit, a network retry, a resubmission after an unseen response —
 * returns that stored result instead of executing again. So a retry can never
 * create a second invoice, payment, import or journal entry.
 *
 * Wrap the mutation at the HANDLER level, where the return value is already the
 * plain JSON-safe object sent to the client (minor units as strings), so it
 * serialises straight into the jsonb result column with no bigint trouble.
 *
 * NOT fully atomic with the wrapped operation (the claim, the operation's own
 * transaction, and the result-write are separate), which is a deliberate
 * trade-off to avoid threading a tx through every service. The window is a
 * process crash *between* the operation committing and the result being
 * recorded; the key then stays `pending` and a retry waits, then surfaces a
 * clear "in progress" error rather than silently duplicating.
 */

import { and, eq } from "drizzle-orm";
import { withOrg } from "@/db/client";
import { idempotencyKeys } from "@/db/schema";
import { LedgerError } from "./ledger";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readRow(orgId: string, key: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.orgId, orgId), eq(idempotencyKeys.idempotencyKey, key)))
      .limit(1),
  );
  return row ?? null;
}

/**
 * Run `fn` once per (orgId, key). With no key, runs `fn` directly (opt-in).
 */
export async function withIdempotency<T>(
  orgId: string,
  key: string | undefined | null,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!key) return fn();

  // Claim the key. ON CONFLICT DO NOTHING → a returned row means WE own it.
  const claimed = await withOrg(orgId, (tx) =>
    tx
      .insert(idempotencyKeys)
      .values({ orgId, idempotencyKey: key, operation, status: "pending" })
      .onConflictDoNothing()
      .returning({ id: idempotencyKeys.id }),
  );

  if (claimed.length === 0) {
    // A concurrent/earlier request holds this key — wait for its result.
    for (let i = 0; i < 40; i++) {
      const row = await readRow(orgId, key);
      if (!row) break; // the holder failed and released it → fall through to retry
      if (row.status === "completed") return row.resultJson as T;
      await sleep(250); // ~10s total
    }
    // Either the holder is still running after the wait, or it released the key.
    const row = await readRow(orgId, key);
    if (row?.status === "completed") return row.resultJson as T;
    throw new LedgerError(
      "A request with the same idempotency key is already being processed. Please retry.",
      "IDEMPOTENCY_IN_PROGRESS",
    );
  }

  // We own the key: run the operation, then record its result.
  try {
    const result = await fn();
    await withOrg(orgId, (tx) =>
      tx
        .update(idempotencyKeys)
        .set({
          status: "completed",
          resultJson: result as unknown as object,
          updatedAt: new Date(),
        })
        .where(and(eq(idempotencyKeys.orgId, orgId), eq(idempotencyKeys.idempotencyKey, key))),
    );
    return result;
  } catch (err) {
    // Failed → release the key so the same key can be retried, then rethrow.
    await withOrg(orgId, (tx) =>
      tx
        .delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.orgId, orgId), eq(idempotencyKeys.idempotencyKey, key))),
    ).catch(() => {});
    throw err;
  }
}
