// The START price of a round, the way the price runner works it out (runner/exchangePrices.mjs). The site shows the start price
// that is on chain (web/onchain/useChainStart.ts); this route is only the cross-check: if the two differ, the page says so.
//   BTC and ETH (audit part 2, P2-01): the MEDIAN of all Bitfinex trades in a window that opens 2 s after the lock and lasts
//     30 s (BTC) or 60 s (ETH); fewer than 3 trades means there is no start price (the round refunds).
//   SOL: the first Bitfinex trade at or after the lock plus 2 seconds (SOL trades too rarely for a window).
// The browser cannot ask Bitfinex's trade history itself (it sends no CORS headers), so this small server route does and hands
// back the number. A finished answer never changes, so it is remembered.
import { ratioOf } from "@/lib/ratio";
import { START_AFTER_SECONDS, WINDOWS, median } from "@/lib/price-rule";

const SYMBOLS: Record<string, string> = { BTC: "tBTCUSD", ETH: "tETHUSD", SOL: "tSOLUSD" };
// Coin vs coin: the start is the first coin's start price divided by the second coin's, each by its own rule (the runner does
// exactly this). The answer's tradeAt is the later of the two.
const PAIRS: Record<string, [string, string]> = { ETHBTC: ["ETH", "BTC"], SOLBTC: ["SOL", "BTC"] };
type Start = { price: number | null; tradeAt: number };
const known = new Map<string, Start>();
const remember = (key: string, answer: Start) => {
  known.set(key, answer);
  if (known.size > 500) known.delete(known.keys().next().value as string);
  return answer;
};

/** One coin's start price; null when it is not known yet (or Bitfinex did not answer); { price: null } when there is none. */
async function startOf(coin: string, lock: number): Promise<Start | null> {
  const key = `${coin}:${lock}`;
  const hit = known.get(key);
  if (hit) return hit;
  const from = (lock + START_AFTER_SECONDS) * 1000;
  const w = WINDOWS[coin];
  try {
    if (w) {
      const to = from + w.seconds * 1000;
      if (Date.now() < to + 2000) return null; // the window is not over yet
      const res = await fetch(`https://api-pub.bitfinex.com/v2/trades/${SYMBOLS[coin]}/hist?start=${from}&end=${to - 1}&limit=10000&sort=1`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
      if (!res.ok) return null;
      const data: unknown = await res.json();
      if (!Array.isArray(data)) return null;
      const prices = data
        .filter((t): t is unknown[] => Array.isArray(t) && typeof t[1] === "number" && typeof t[3] === "number" && (t[1] as number) >= from && (t[1] as number) < to && (t[3] as number) > 0)
        .map((t) => t[3] as number);
      if (prices.length < w.minTrades) return remember(key, { price: null, tradeAt: Math.floor(to / 1000) }); // too few trades: no start price
      return remember(key, { price: median(prices), tradeAt: Math.floor(to / 1000) });
    }
    const res = await fetch(`https://api-pub.bitfinex.com/v2/trades/${SYMBOLS[coin]}/hist?limit=1&sort=1&start=${from}`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const trade = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as unknown[]) : null;
    const ms = trade?.[1];
    const price = trade?.[3];
    if (typeof ms !== "number" || typeof price !== "number" || ms < from || !(price > 0)) return null;
    return remember(key, { price, tradeAt: Math.floor(ms / 1000) });
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const coin = searchParams.get("coin") ?? "";
  const lock = Number(searchParams.get("lock"));
  const now = Math.floor(Date.now() / 1000);
  const legs = PAIRS[coin];
  if ((!SYMBOLS[coin] && !legs) || !Number.isInteger(lock) || lock > now || lock < now - 6 * 3600) return Response.json({ error: "bad request" }, { status: 400 });

  if (!legs) return Response.json((await startOf(coin, lock)) ?? { price: null });
  const top = await startOf(legs[0], lock);
  const bottom = top && top.price !== null ? await startOf(legs[1], lock) : null;
  if (!top || top.price === null || !bottom || bottom.price === null) return Response.json({ price: null });
  // the same rounding as the chain: both prices as 8-decimal integers, ratio with 18 decimals, rounded down
  return Response.json({ price: ratioOf(top.price, bottom.price), tradeAt: Math.max(top.tradeAt, bottom.tradeAt) });
}
