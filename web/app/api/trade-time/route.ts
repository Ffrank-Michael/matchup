// When the Bitfinex trade behind a price on the chain happened. The relay stores the price and the time it landed on the chain,
// not the trade's own time, so this looks at Bitfinex's trades in the 90 seconds before the push for the newest trade at that
// exact price. Used for the "Verify" lines: anyone can compare it with Bitfinex's own history. A found answer never changes.
const SYMBOLS: Record<string, string> = { BTC: "tBTCUSD", ETH: "tETHUSD", SOL: "tSOLUSD" };
const known = new Map<string, { tradeAt: number }>();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const coin = searchParams.get("coin") ?? "";
  const price = Number(searchParams.get("price"));
  const at = Number(searchParams.get("at"));
  const symbol = SYMBOLS[coin];
  if (!symbol || !(price > 0) || !Number.isInteger(at)) return Response.json({ error: "bad request" }, { status: 400 });

  const key = `${coin}:${price}:${at}`;
  const hit = known.get(key);
  if (hit) return Response.json(hit);

  try {
    const url = `https://api-pub.bitfinex.com/v2/trades/${symbol}/hist?limit=250&sort=-1&start=${(at - 90) * 1000}&end=${(at + 5) * 1000}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (!res.ok) return Response.json({ tradeAt: null });
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return Response.json({ tradeAt: null });
    // newest first: the first trade at this price is the closest one before the push
    const trade = (data as unknown[][]).find((t) => Array.isArray(t) && typeof t[3] === "number" && Math.abs(t[3] - price) <= price * 1e-8);
    if (!trade || typeof trade[1] !== "number") return Response.json({ tradeAt: null });
    const answer = { tradeAt: Math.floor(trade[1] / 1000) };
    known.set(key, answer);
    if (known.size > 500) known.delete(known.keys().next().value as string);
    return Response.json(answer);
  } catch {
    return Response.json({ tradeAt: null });
  }
}
