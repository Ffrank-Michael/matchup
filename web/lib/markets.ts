// The three markets and the round schedule. The schedule comes from docs/RULES.md (rule 2):
// the lock of round k is startOffset + k * roundLength, counted from the Unix epoch, so every
// market locks at a fixed clock time. Nothing here is a price; prices come from lib/price-feed.ts (Bitfinex).

/** Testnet: 10-minute rounds. The mainnet option is 3600 (1 hour, offsets 0 / 1200 / 2400). */
export const ROUND_SECONDS = 600;

export const MARKETS = [
  { key: "BTC", pair: "BTC/USD", lockOffset: 0 },
  { key: "ETH", pair: "ETH/USD", lockOffset: 180 },
  { key: "SOL", pair: "SOL/USD", lockOffset: 360 },
] as const;

export type Market = (typeof MARKETS)[number];
export type MarketKey = Market["key"];

/**
 * Seconds until the next lock. At the exact lock second the round is already locked,
 * so the countdown shows a full round length (same as the contract: calls close at the lock).
 */
export function secondsToNextLock(nowSec: number, lockOffset: number, roundSeconds = ROUND_SECONDS) {
  const intoRound = (((nowSec - lockOffset) % roundSeconds) + roundSeconds) % roundSeconds;
  return roundSeconds - intoRound;
}

export function formatCountdown(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const usdFormats = new Map<number, Intl.NumberFormat>();

/** US dollars: whole dollars from $10,000 up, cents below that (so a moving ETH or SOL price shows its cents). */
export function formatUsd(value: number) {
  const digits = value >= 10000 ? 0 : 2;
  let f = usdFormats.get(digits);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
    usdFormats.set(digits, f);
  }
  return f.format(value);
}
