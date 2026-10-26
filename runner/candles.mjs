// Closed 1-minute candles for the chart reader, from Bitfinex's free public API (no key).
//   GET https://api-pub.bitfinex.com/v2/candles/trade:1m:tBTCUSD/hist?limit=24  ->  [[time_ms, open, close, high, low, volume], ...]  newest first
// Only candles that have finished count: the minute that is still running is dropped. Answers are reused for ttlMs, so
// the three coins cost about six requests a minute. If Bitfinex fails this THROWS and the runner gives the agent no
// candles; the chart reader then skips the round. It never makes numbers up.
import { SYMBOLS } from './exchangePrices.mjs';

const BASE = 'https://api-pub.bitfinex.com/v2/candles';
const MINUTE_MS = 60_000;

export function createCandles({ fetchFn = fetch, nowMs = Date.now, ttlMs = 30_000, count = 20 } = {}) {
  const cache = {}; // pair -> { at, candles }

  /** The last `count` finished 1-minute candles of a coin ("BTC/USD"), oldest first: [{ time, open, close }]. */
  async function get(pair) {
    const hit = cache[pair];
    if (hit && nowMs() - hit.at < ttlMs) return hit.candles;
    const symbol = SYMBOLS[pair];
    if (!symbol) throw new Error(`no candle source for market ${pair}`);
    const res = await fetchFn(`${BASE}/trade:1m:${symbol}/hist?limit=${count + 4}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Bitfinex answered HTTP ${res.status} for ${symbol} candles`);
    const data = await res.json();
    if (!Array.isArray(data) || data.some((c) => !Array.isArray(c))) throw new Error(`Bitfinex gave no usable candles for ${symbol}`);
    const now = nowMs();
    const candles = data
      .filter((c) => Number.isFinite(c[0]) && c[0] + MINUTE_MS <= now && c[1] > 0 && c[2] > 0)
      .sort((a, b) => a[0] - b[0])
      .slice(-count)
      .map((c) => ({ time: Math.floor(c[0] / 1000), open: c[1], close: c[2] }));
    cache[pair] = { at: now, candles };
    return candles;
  }

  /** Candles for several coins at once; a coin that fails is simply left out. */
  async function getAll(pairs) {
    const out = {};
    await Promise.all([...new Set(pairs)].map(async (p) => { try { out[p] = await get(p); } catch { /* no candles: that coin's chart reader skips */ } }));
    return out;
  }

  return { get, getAll };
}
