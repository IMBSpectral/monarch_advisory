import { useState, useCallback } from "react";

/**
 * A stable idempotency key for one submission "intent".
 *
 * The key is generated once and reused across retries of the SAME submission —
 * so if the network drops the response and the user submits again, the server
 * recognises the replay and returns the first result instead of creating a
 * duplicate. Call `renew()` only after an OBSERVED success, so that a genuinely
 * new document gets a fresh key while a retry-after-uncertain-failure keeps the
 * old one.
 */
export function useIdempotencyKey() {
  const [key, setKey] = useState(() => crypto.randomUUID());
  const renew = useCallback(() => setKey(crypto.randomUUID()), []);
  return { key, renew };
}
