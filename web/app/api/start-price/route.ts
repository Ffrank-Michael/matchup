// The START price of a round, the way the price runner finds it (docs/RULES.md, H5): the first Bitfinex trade whose own time
// is at or after the lock plus 2 seconds. The contract only records its start price when the round is settled, so while a
// round runs the site asks here. The browser cannot ask Bitfinex's trade history itself (it sends no CORS headers), so this
// small server route does and hands back the number. A finished answer never changes, so it is remembered.
const SYMBOLS: Record<string, string> = { BTC: "tBTCUSD", ETH: "tETHUSD", SOL: "tSOLUSD" };
const START_AFTER_SECONDS = 2;
const known = new Map<string, { price: number; tradeAt: number }>();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const coin = searchParams.get("coin") ?? "";
  const lock = Number(searchParams.get("lock"));
  const symbol = SYMBOLS[coin];
  const now = Math.floor(Date.now() / 1000);
  if (!symbol || !Number.isInteger(lock) || lock > now || lock < now - 6 * 3600) return Response.json({ error: "bad request" }, { status: 400 });

  const key = `${coin}:${lock}`;
  const hit = known.get(key);
  if (hit) return Response.json(hit);

  const from = (lock + START_AFTER_SECONDS) * 1000;
  try {
    const res = await fetch(`https://api-pub.bitfinex.com/v2/trades/${symbol}/hist?limit=1&sort=1&start=${from}`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (!res.ok) return Response.json({ price: null }, { status: 200 });
    const data: unknown = await res.json();
    const trade = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as unknown[]) : null;
    const ms = trade?.[1];
    const price = trade?.[3];
    if (typeof ms !== "number" || typeof price !== "number" || ms < from || !(price > 0)) return Response.json({ price: null });
    const answer = { price, tradeAt: Math.floor(ms / 1000) };
    known.set(key, answer);
    if (known.size > 500) known.delete(known.keys().next().value as string);
    return Response.json(answer);
  } catch {
    return Response.json({ price: null });
  }
}
