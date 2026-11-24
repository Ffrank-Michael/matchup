// Coin vs coin (ETH vs BTC, SOL vs BTC): the maths in one place, with no React and no network, so it can be tested.
// The price of such a market is the first coin's USD price divided by the second's. The chain keeps it with 18 decimals and
// the runner works it out exactly like the RatioGuard contract: both prices as 8-decimal integers, top * 10^18 / bottom,
// rounded down (runner/pairs.mjs). The site uses the same rule, so its start ratio is the number the chain records.

type Candle = { t: number; open: number; close: number; high: number; low: number };

/** top / bottom from two USD prices, the way the chain records it (18 decimals, rounded down), as a plain number. */
export function ratioOf(topUsd: number, bottomUsd: number): number | null {
  if (!(topUsd > 0) || !(bottomUsd > 0)) return null;
  const top8 = BigInt(Math.round(topUsd * 1e8));
  const bottom8 = BigInt(Math.round(bottomUsd * 1e8));
  if (bottom8 === BigInt(0)) return null;
  return Number((top8 * BigInt(10) ** BigInt(18)) / bottom8) / 1e18;
}

/**
 * Coin-vs-coin candles for the minutes in which both coins traded. Open and close are exact (top open / bottom open, top close
 * / bottom close). The ratio's true high and low in a minute are not known from two separate candles, so they are the larger
 * and smaller of open and close: no invented wicks. The runner builds the agents' candles the same way (runner/candles.mjs).
 */
export function ratioCandles<C extends Candle>(top: C[] | null, bottom: C[] | null): Candle[] | null {
  if (!top || !bottom) return null;
  const byTime = new Map(bottom.map((c) => [c.t, c]));
  const out: Candle[] = [];
  for (const c of top) {
    const b = byTime.get(c.t);
    if (!b || !(b.open > 0) || !(b.close > 0)) continue;
    const open = c.open / b.open;
    const close = c.close / b.close;
    out.push({ t: c.t, open, close, high: Math.max(open, close), low: Math.min(open, close) });
  }
  return out.length ? out : null;
}

/** A ratio as text, with 5 significant digits so an hour's move stays visible: 0.0339246 -> "0.033925 BTC". */
export function formatRatio(value: number, unit: string): string {
  return `${Number(value.toPrecision(5))} ${unit}`.trim();
}
