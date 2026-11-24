// Coin-vs-coin ("ratio") markets: which pairs exist, how their price is made from two USD prices, and their decimals.
//
// A ratio market is named like any other market: "<pair> <time frame>", e.g. "ETH/BTC 1h". Its price is ETH/USD divided
// by BTC/USD (how many BTC one ETH is worth), with 18 decimals, worked out exactly like the RatioGuard contract does:
//   ratio = top * 10^18 / bottom     (both 8-decimal prices, rounded down)
// The ratio ends higher than it started exactly when the top coin's % move beat the bottom coin's, so UP means
// "ETH wins" and DOWN means "BTC wins". Only 1-hour rounds are deployed (scripts/markets.mjs).
//
// Pure: nothing here reads the network.
export const USD_DECIMALS = 8;
export const RATIO_DECIMALS = 18;

/** The ratio pairs and the two USD markets each is made of (top / bottom). */
export const RATIO_PAIRS = {
  'ETH/BTC': { top: 'ETH/USD', bottom: 'BTC/USD', a: 'ETH', b: 'BTC' },
  'SOL/BTC': { top: 'SOL/USD', bottom: 'BTC/USD', a: 'SOL', b: 'BTC' },
};

/** "ETH/BTC 1h" -> "ETH/BTC", "BTC/USD 5m" -> "BTC/USD". */
export const pairOf = (marketName) => String(marketName).split(' ')[0];

export const isRatioPair = (pair) => Object.hasOwn(RATIO_PAIRS, pair);
export const isRatioMarket = (marketName) => isRatioPair(pairOf(marketName));

/** Decimals of the price a market's feed holds. */
export const decimalsOf = (pair) => (isRatioPair(pair) ? RATIO_DECIMALS : USD_DECIMALS);

/** The two USD markets of a ratio pair, top first; null for a USD pair. */
export const legsOf = (pair) => (isRatioPair(pair) ? [RATIO_PAIRS[pair].top, RATIO_PAIRS[pair].bottom] : null);

/** A USD price (a number like 3312.87) as the 8-decimal whole number a feed takes. */
export const toUsd8 = (usd) => BigInt(Math.round(usd * 10 ** USD_DECIMALS));

/** top / bottom with 18 decimals, from two 8-decimal prices (BigInt), rounded down: the same maths as RatioGuard. */
export function ratio18(top8, bottom8) {
  const t = BigInt(top8), b = BigInt(bottom8);
  if (t <= 0n || b <= 0n) throw new Error('a ratio needs two prices above zero');
  return (t * 10n ** 18n) / b;
}

/** An on-chain price (BigInt or numeric string) as a plain number, for the agents and the logs. */
export const priceNumber = (raw, pair) => Number(BigInt(raw)) / 10 ** decimalsOf(pair);

/** How a price is written in the logs: "$3,312.87" for a USD pair, "0.0339246 BTC" for a ratio pair. */
export function priceText(raw, pair) {
  const n = priceNumber(raw, pair);
  if (isRatioPair(pair)) return `${Number(n.toPrecision(6))} ${RATIO_PAIRS[pair].b}`;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
