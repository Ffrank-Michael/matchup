import deployment from "./deployment.generated.json";

// The coins, the markets and the round schedule. The coins are the three on the page; the MARKETS (one per coin and time
// frame) are read from the deployment file (deployments/arc-*.json, copied to lib/deployment.generated.json by
// scripts/sync-web-deployment.mjs), so the site shows exactly the markets that exist on the chain. The schedule comes from
// docs/RULES.md (rule 2): the lock of round k is startOffset + k * roundLength, counted from the Unix epoch, so every
// market locks at a fixed clock time. Nothing here is a price; prices come from lib/price-feed.ts (Bitfinex).

export const COINS = [
  { key: "BTC", pair: "BTC/USD" },
  { key: "ETH", pair: "ETH/USD" },
  { key: "SOL", pair: "SOL/USD" },
] as const;

export type MarketKey = (typeof COINS)[number]["key"];

export type Market = {
  /** The market's id in the arena contract */
  id: number;
  /** As named on the chain, e.g. "BTC/USD 5m" */
  name: string;
  /** The coin: BTC, ETH or SOL */
  key: MarketKey;
  /** e.g. "BTC/USD" */
  pair: string;
  /** Round length in seconds (300 for 5m, 600 for 10m) */
  roundSeconds: number;
  /** Seconds after each round-length boundary at which this market locks */
  lockOffset: number;
  /** The price relay this market reads (its address on the chain) */
  feed: string;
};

/** "5m", "10m", "1h": how a round length is written on the buttons. */
export function frameLabel(roundSeconds: number) {
  return roundSeconds % 3600 === 0 ? `${roundSeconds / 3600}h` : `${Math.round(roundSeconds / 60)}m`;
}

export const MARKETS: Market[] = deployment.markets.flatMap((m) => {
  const coin = COINS.find((c) => m.name.startsWith(`${c.pair} `));
  return coin ? [{ id: m.id, name: m.name, key: coin.key, pair: coin.pair, roundSeconds: m.round, lockOffset: m.offset, feed: m.feed }] : [];
});

/** The time frames that exist, shortest first (from the deployment). */
export const TIME_FRAMES: number[] = [...new Set(MARKETS.map((m) => m.roundSeconds))].sort((a, b) => a - b);

/** The default time frame: the shortest one (5m). */
export const DEFAULT_FRAME = TIME_FRAMES[0] ?? 300;

/** The market for a coin and time frame; falls back to the coin's first market if that time frame does not exist for it. */
export function marketFor(key: MarketKey, roundSeconds: number): Market {
  const ofCoin = MARKETS.filter((m) => m.key === key);
  return ofCoin.find((m) => m.roundSeconds === roundSeconds) ?? ofCoin[0] ?? MARKETS[0];
}

/**
 * Seconds until the next lock. At the exact lock second the round is already locked,
 * so the countdown shows a full round length (same as the contract: calls close at the lock).
 */
export function secondsToNextLock(nowSec: number, lockOffset: number, roundSeconds: number) {
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

/** "5 min", "10 min", "30 min", "1 hour": how a round length is written on the call panel. */
export function frameWords(roundSeconds: number) {
  if (roundSeconds % 3600 === 0) return roundSeconds === 3600 ? "1 hour" : `${roundSeconds / 3600} hours`;
  return `${Math.round(roundSeconds / 60)} min`;
}
