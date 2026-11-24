import deployment from "./deployment.generated.json";
import { formatRatio } from "./ratio";

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

/**
 * Coin-vs-coin markets: the price is the first coin's USD price divided by the second's (how many BTC one ETH is worth), so
 * the ratio ends higher than it started exactly when the first coin's % move beat the second's. On the chain they are
 * ordinary UP/DOWN markets ("ETH/BTC 1h") whose relay holds that ratio with 18 decimals: UP is "ETH wins", DOWN is
 * "BTC wins". Only shown when the deployment has such a market (1-hour rounds only).
 */
export const MATCHUPS = [
  { key: "ETHBTC", pair: "ETH/BTC", a: "ETH", b: "BTC" },
  { key: "SOLBTC", pair: "SOL/BTC", a: "SOL", b: "BTC" },
] as const;

export type CoinKey = (typeof COINS)[number]["key"];
export type MatchupKey = (typeof MATCHUPS)[number]["key"];
export type MarketKey = CoinKey | MatchupKey;

/** Every key that can have a live price: the three coins, then the coin-vs-coin pairs. */
export const ALL_KEYS: readonly MarketKey[] = [...COINS.map((c) => c.key), ...MATCHUPS.map((m) => m.key)];

export const isMatchupKey = (key: MarketKey): key is MatchupKey => MATCHUPS.some((m) => m.key === key);
export const matchupOf = (key: MarketKey) => MATCHUPS.find((m) => m.key === key) ?? null;

export type Market = {
  /** The market's id in the arena contract */
  id: number;
  /** As named on the chain, e.g. "BTC/USD 5m" */
  name: string;
  /** The coin (BTC, ETH, SOL) or the coin-vs-coin pair (ETHBTC, SOLBTC) */
  key: MarketKey;
  /** e.g. "BTC/USD" or "ETH/BTC" */
  pair: string;
  /** "coin": a USD price, UP or DOWN. "ratio": coin vs coin (ETH vs BTC), "ETH wins" or "BTC wins". */
  kind: "coin" | "ratio";
  /** How the market is named on the page: "BTC", or "ETH vs BTC" */
  label: string;
  /** The words on the two buttons: UP / DOWN, or "ETH wins" / "BTC wins" */
  sides: { UP: string; DOWN: string };
  /** Decimals of the price the market's relay holds: 8 for USD, 18 for a ratio */
  decimals: number;
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

export const MARKETS: Market[] = deployment.markets.flatMap((m): Market[] => {
  const base = { id: m.id, name: m.name, roundSeconds: m.round, lockOffset: m.offset, feed: m.feed };
  const coin = COINS.find((c) => m.name.startsWith(`${c.pair} `));
  if (coin) return [{ ...base, key: coin.key, pair: coin.pair, kind: "coin", label: coin.key, sides: { UP: "UP", DOWN: "DOWN" }, decimals: 8 }];
  const pair = MATCHUPS.find((c) => m.name.startsWith(`${c.pair} `));
  if (pair) return [{ ...base, key: pair.key, pair: pair.pair, kind: "ratio", label: `${pair.a} vs ${pair.b}`, sides: { UP: `${pair.a} wins`, DOWN: `${pair.b} wins` }, decimals: 18 }];
  return [];
});

/** The coin-vs-coin pairs that have a market in this deployment (none: the page shows no coin-vs-coin row). */
export const LIVE_MATCHUPS = MATCHUPS.filter((p) => MARKETS.some((m) => m.key === p.key));

/** The time frames each coin or pair has, shortest first (a coin-vs-coin pair has only 1 hour). Worked out once. */
export const FRAMES_OF: Readonly<Record<MarketKey, number[]>> = Object.fromEntries(
  ALL_KEYS.map((key) => [key, [...new Set(MARKETS.filter((m) => m.key === key).map((m) => m.roundSeconds))].sort((a, b) => a - b)]),
) as Record<MarketKey, number[]>;

/** A price read from the chain (a relay's integer) as a number, using the market's own decimals. */
export function chainPrice(marketId: number, raw: number | bigint): number {
  const d = MARKETS.find((m) => m.id === marketId)?.decimals ?? 8;
  return Number(raw) / 10 ** d;
}

/** Decimals of the price a relay feed holds, by its address (8 unless a coin-vs-coin market uses it). */
export function feedDecimals(feed: string): number {
  return MARKETS.find((m) => m.feed.toLowerCase() === feed.toLowerCase())?.decimals ?? 8;
}

/** A market's price as text: dollars for a coin, "0.033925 BTC" for a coin-vs-coin pair. */
export function formatPrice(market: Pick<Market, "kind" | "key">, value: number) {
  if (market.kind !== "ratio") return formatUsd(value);
  return formatRatio(value, matchupOf(market.key)?.b ?? "");
}

/** The time frames that exist, shortest first (from the deployment). */
export const TIME_FRAMES: number[] = [...new Set(MARKETS.map((m) => m.roundSeconds))].sort((a, b) => a - b);

/** The default time frame: the shortest one (5m). */
export const DEFAULT_FRAME = TIME_FRAMES[0] ?? 300;

/** The market for a coin (or pair) and time frame; falls back to its first market if that time frame does not exist for it. */
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
