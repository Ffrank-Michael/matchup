/**
 * onchain/resultPolling.ts
 * How often the round states are read (useAllRounds): every 5 s, and every 2 s while one of the connected wallet's rounds is
 * about to end or has just ended without a result yet (from 5 s before its end until 5 minutes after it), so a settle shows
 * up in "Your calls" within seconds. After those 5 minutes it goes back to 5 s even if no result came (the runner retries).
 * Only the Arc RPC is read more often: no price source and no AI.
 *
 * useMyPositions records here the end times of the wallet's rounds that are still waiting (locked or ended, not settled,
 * not claimed) each time it reads; useAllRounds asks for its interval after each of its own reads.
 */
export const NORMAL_POLL_MS = 5_000;
export const WAITING_POLL_MS = 2_000;
const FAST_BEFORE_SEC = 5;
const FAST_FOR_SEC = 300;

let waitingEnds: number[] = [];

/** The end times (seconds) of the connected wallet's rounds still waiting for a result. */
export function setWaitingEnds(ends: number[]): void {
  waitingEnds = ends;
}

/** The interval for reading the round states, in ms. */
export function roundsPollMs(ends: number[] = waitingEnds, nowSec: number = Date.now() / 1000): number {
  return ends.some((e) => nowSec >= e - FAST_BEFORE_SEC && nowSec < e + FAST_FOR_SEC) ? WAITING_POLL_MS : NORMAL_POLL_MS;
}
