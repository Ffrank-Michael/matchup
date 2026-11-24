// The START price of a round, the way the price runner finds it (docs/RULES.md, H5): the first Bitfinex trade whose own time
// is at or after the lock plus 2 seconds. The contract only records its start price when the round is settled, so while a
// round runs the site asks here. The browser cannot ask Bitfinex's trade history itself (it sends no CORS headers), so this
// small server route does and hands back the number. A finished answer never changes, so it is remembered.
import { ratioOf } from "@/lib/ratio";

const SYMBOLS: Record<string, string> = { BTC: "tBTCUSD", ETH: "tETHUSD", SOL: "tSOLUSD" };
// Coin vs coin: the start is the first coin's start trade divided by the second coin's start trade, each found by the same rule
// (the runner does exactly this: runner/exchangePrices.mjs). The answer's tradeAt is the later of the two trades.
const PAIRS: Record<string, [string, string]> = { ETHBTC: ["ETH", "BTC"], SOLBTC: ["SOL", "BTC"] };
const START_AFTER_SECONDS = 2;
const known = new Map<string, { price: number; tradeAt: number }>();

/** One coin's first trade at or after lock + 2 s; null when there is none yet (or Bitfinex did not answer). */
async function startTrade(coin: string, lock: number): Promise<{ price: number; tradeAt: number } | null> {
  const key = `${coin}:${lock}`;
  const hit = known.get(key);
  if (hit) return hit;
  const from = (lock + START_AFTER_SECONDS) * 1000;
  try {
    const res = await fetch(`https://api-pub.bitfinex.com/v2/trades/${SYMBOLS[coin]}/hist?limit=1&sort=1&start=${from}`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const trade = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as unknown[]) : null;
    const ms = trade?.[1];
    const price = trade?.[3];
    if (typeof ms !== "number" || typeof price !== "number" || ms < from || !(price > 0)) return null;
    const answer = { price, tradeAt: Math.floor(ms / 1000) };
    known.set(key, answer);
    if (known.size > 500) known.delete(known.keys().next().value as string);
    return answer;
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

  if (!legs) return Response.json((await startTrade(coin, lock)) ?? { price: null });
  const top = await startTrade(legs[0], lock);
  const bottom = top ? await startTrade(legs[1], lock) : null;
  if (!top || !bottom) return Response.json({ price: null });
  // the same rounding as the chain: both prices as 8-decimal integers, ratio with 18 decimals, rounded down
  return Response.json({ price: ratioOf(top.price, bottom.price), tradeAt: Math.max(top.tradeAt, bottom.tradeAt) });
}
