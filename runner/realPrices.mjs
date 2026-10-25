// Real BTC, ETH and SOL prices for the TEST feeds, from CoinGecko's free keyless API.
//   GET https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd
// One request returns all three coins. CoinGecko's own limit for keyless use is about 10 to 30
// calls a minute, shared per IP, and they say it is meant for prototypes, not production.
// The runner asks for a price only when it is about to push one (about 3 times per round per market).
// Data provided by CoinGecko (https://www.coingecko.com).
//
// CoinGecko's prices can be a little behind the market. Every quote carries its own time
// (last_updated_at), so a caller can say "only a quote made after this moment" (quotedAfter).
// The runner uses that for the START price, so a start price is never a stale price from
// before the lock (see docs/RULES.md, fairness note).
//
// If the API fails or looks wrong this THROWS. It never falls back to made-up numbers: the
// runner then simply pushes nothing, which is what a real feed outage looks like (the
// contract refunds a round with no usable update).
export const COINGECKO_IDS = { 'BTC/USD': 'bitcoin', 'ETH/USD': 'ethereum', 'SOL/USD': 'solana' };
const URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_last_updated_at=true';

export function createRealPrices({
  fetchFn = fetch,
  nowMs = Date.now,
  apiKey,                 // optional free "Demo" key (header x-cg-demo-api-key); the keyless API works without it
  ttlMs = 30_000,         // reuse the last answer for 30 seconds
  minGapMs = 15_000,      // never call the API more often than this, even after a failure
  maxAgeSec = 180,        // reject a quote CoinGecko last updated more than 3 minutes ago (normally 13 to 89 seconds)
  maxJump = 0.20,         // reject a price that moved more than 20% from the last one we pushed
} = {}) {
  let cache = null;       // { at, data }
  let lastTry = 0;
  const lastPrice = {};   // market name -> last USD price handed out

  async function load(fresh) {
    if (!fresh && cache && nowMs() - cache.at < ttlMs) return cache.data;
    if (nowMs() - lastTry < minGapMs) throw new Error('price API was tried a moment ago; waiting before asking again');
    lastTry = nowMs();
    const res = await fetchFn(URL, {
      headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`CoinGecko answered HTTP ${res.status}${res.status === 429 ? ' (too many requests: rate limited)' : ''}`);
    const data = await res.json();
    for (const id of Object.values(COINGECKO_IDS)) {
      const usd = data?.[id]?.usd;
      if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) throw new Error(`CoinGecko gave no usable price for ${id}`);
    }
    cache = { at: nowMs(), data };
    return data;
  }

  return {
    /**
     * Current real USD price for a market.
     * Returns { price (8-decimal BigInt, ready for the feed), usd, quotedAt (unix seconds, from CoinGecko) }.
     * quotedAfter (unix seconds, optional): only accept a quote CoinGecko made after this moment;
     * if the newest quote is older, this asks CoinGecko once more (at most once per minGapMs) and then throws.
     */
    async quote(marketName, { quotedAfter } = {}) {
      const id = COINGECKO_IDS[marketName];
      if (!id) throw new Error(`no real price source for market ${marketName}`);
      let entry = (await load(false))[id];
      const tooOld = (e) => quotedAfter !== undefined && !(e.last_updated_at >= quotedAfter);
      if (tooOld(entry)) {
        // ask again (the once-per-minGapMs limit still applies; if it blocks us we report the real reason below)
        try { entry = (await load(true))[id]; } catch (e) { if (!/tried a moment ago/.test(e.message)) throw e; }
      }
      if (tooOld(entry)) {
        const behind = Math.round(quotedAfter - (entry.last_updated_at || 0));
        throw new Error(`CoinGecko's newest ${id} quote is ${behind} s too old for this push (it must be made after the lock); will try again`);
      }
      if (entry.last_updated_at && nowMs() / 1000 - entry.last_updated_at > maxAgeSec) {
        throw new Error(`CoinGecko's ${id} price is stale (${Math.round((nowMs() / 1000 - entry.last_updated_at) / 60)} minutes old)`);
      }
      const before = lastPrice[marketName];
      if (before && Math.abs(entry.usd - before) / before > maxJump) {
        throw new Error(`${marketName} moved from ${before} to ${entry.usd} (over ${maxJump * 100}%): not trusting it`);
      }
      lastPrice[marketName] = entry.usd;
      return { price: BigInt(Math.round(entry.usd * 1e8)), usd: entry.usd, quotedAt: entry.last_updated_at ?? null };
    },

    /** Same as quote(), but only the 8-decimal price. */
    async price(marketName, opts) {
      return (await this.quote(marketName, opts)).price;
    },
  };
}
