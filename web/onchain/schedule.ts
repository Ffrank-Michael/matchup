/**
 * src/onchain/schedule.ts
 * ─────────────────────────────────────────────────────────────
 * Pure schedule math — no blockchain calls, no React, no imports.
 * Mirrors the PredictionArena.sol formulas exactly (Rules §2, §3):
 *
 *   lockTime(m, k)  = m.startOffset + k * m.roundLength          (rule 2)
 *   endTime(m, k)   = lockTime(m, k) + m.roundLength
 *   nextCallableRound(m, nowSec)
 *     = the smallest k whose lockTime is strictly > nowSec
 *       AND whose predecessor (k-1) has already locked
 *     = 0 if nowSec < m.startOffset
 *     = floor((nowSec - m.startOffset) / m.roundLength) + 1  otherwise
 *       (same formula the contract uses: at exactly a lock second the
 *        round is already closed, so we advance by 1)
 *
 * "Market" here is the minimum shape these functions need; the hooks
 * pass full Market objects but only these fields are read.
 */

export interface MarketSchedule {
  roundLength: number; // seconds
  startOffset: number; // seconds from epoch
}

/**
 * Unix seconds at which round `k` locks (no more calls accepted).
 * Mirrors `PredictionArena.lockTime(marketId, roundIndex)`.
 */
export function lockTime(m: MarketSchedule, k: number): number {
  return m.startOffset + k * m.roundLength;
}

/**
 * Unix seconds at which round `k` ends (settle window opens).
 * Mirrors `PredictionArena.endTime(marketId, roundIndex)`.
 */
export function endTime(m: MarketSchedule, k: number): number {
  return lockTime(m, k) + m.roundLength;
}

/**
 * The round index a user can call on RIGHT NOW.
 * Mirrors `PredictionArena.nextCallableRound(marketId)`.
 *
 * Contract logic (checked against Solidity source):
 *   if (block.timestamp < startOffset) return 0;
 *   uint256 elapsed = block.timestamp - startOffset;
 *   return (elapsed / roundLength) + 1;
 *
 * Note: at exactly a lock second, (elapsed / roundLength) + 1 advances
 * to the next round — matching the contract's "closed at the lock" rule.
 */
export function nextCallableRound(m: MarketSchedule, nowSec: number): number {
  if (nowSec < m.startOffset) return 0;
  const elapsed = nowSec - m.startOffset;
  return Math.floor(elapsed / m.roundLength) + 1;
}

/**
 * Seconds from `nowSec` until round `k` locks.
 * Returns 0 if the lock is in the past or right now.
 * Use this for countdown timers.
 */
export function secondsToLock(m: MarketSchedule, k: number, nowSec: number): number {
  return Math.max(0, lockTime(m, k) - nowSec);
}

/**
 * Seconds from `nowSec` until round `k` ends.
 * Returns 0 if already past the end.
 */
export function secondsToEnd(m: MarketSchedule, k: number, nowSec: number): number {
  return Math.max(0, endTime(m, k) - nowSec);
}
