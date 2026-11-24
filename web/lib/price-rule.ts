// How the runner takes a round's start and end price, in one place, so every page says the same thing (audit part 2, P2-04
// and P2-01). Keep these in step with runner/config.mjs (startAfter, endMargin) and runner/exchangePrices.mjs (WINDOWS); a test
// checks they match.

/** The start window opens this many seconds after calling closes (the lock). */
export const START_AFTER_SECONDS = 2;

/** The end price is taken from this many seconds before the round ends: price moves after that do not count. */
export const END_TAKEN_SECONDS_BEFORE = 60;

/**
 * Coins whose start and end are the MEDIAN of all Bitfinex trades in a short window (P2-01): one trade can no longer set the
 * price. With fewer than minTrades trades in a window there is no price and the round refunds. SOL trades too rarely on
 * Bitfinex for this, so it keeps the single trade (a known limit, docs/RUNBOOK.md).
 */
export const WINDOWS: Record<string, { seconds: number; minTrades: number }> = {
  BTC: { seconds: 60, minTrades: 3 },
  ETH: { seconds: 90, minTrades: 3 },
};

/** The median of a list of numbers (the mean of the middle two for an even count). */
export function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** The start price, in plain words. */
export const START_RULE =
  "The start price is the middle price of all Bitfinex trades in the first 60 seconds after calling closes (90 seconds for ETH). For SOL it is the first trade after calling closes.";

/** The end price, in plain words. */
export const END_RULE =
  "The end price is the middle price of the trades in the 60 seconds (90 for ETH) before the last minute of the round; for SOL, the last trade about one minute before the end. The last minute does not count.";

/** When there are too few trades, in plain words. */
export const TOO_FEW_RULE =
  "If BTC or ETH has fewer than 3 trades in one of these windows, there is no price and everyone gets their money back.";

/** Shown on a live round once its end price is being taken. */
export const END_BEING_TAKEN = "The end price is being taken now. Moves from here to the end do not count.";

/** Is the end price already being taken for a round that ends at endSec? */
export function endBeingTaken(nowSec: number, endSec: number): boolean {
  return nowSec < endSec && endSec - nowSec <= END_TAKEN_SECONDS_BEFORE;
}
