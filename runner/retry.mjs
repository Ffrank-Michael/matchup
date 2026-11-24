// How long the runner waits before trying a failed action again.
//   pushPrice  5 s: the start price waits for the first trade after the lock, so "failed" is usually "not yet"
//   settle     15 s, then 30 s, 60 s, 120 s, and at most 240 s while it keeps failing: the contract allows settling for only
//              1 hour, and every minute of waiting is a minute a winner cannot claim. A settle only talks to the chain
//              (no price source, no AI), so trying again soon costs nothing but gas on a transaction that would fail anyway.
//   others     5 minutes, as before
export const SETTLE_RETRY_FIRST_MS = 15_000;
export const SETTLE_RETRY_MAX_MS = 240_000;
/** A FINAL failure (e.final: a price window with too few trades, which can never change) is not tried again for this long. */
export const FINAL_WAIT_MS = 2 * 60 * 60_000;

/** `failures` is how many times in a row this action has failed, this time included (1 for the first failure). */
export function retryAfterMs(type, failures = 1) {
  if (type === 'pushPrice') return 5_000;
  if (type === 'settle') return Math.min(SETTLE_RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1), SETTLE_RETRY_MAX_MS);
  return 5 * 60_000;
}

/**
 * Did the contract refuse a settle because a start or end id was wrong? Then the runner's remembered feed history may be
 * missing an update, so it is read again from scratch before the next try (audit part 2, P2-15).
 */
export function wrongSettleIds(e) {
  return /InvalidStartRound|InvalidEndRound/.test(`${e?.shortMessage ?? ''} ${e?.message ?? ''}`);
}
