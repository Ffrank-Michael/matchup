// Real BTC, ETH and SOL prices for the TEST feeds, from Bitfinex's free public API (no key).
//   GET https://api-pub.bitfinex.com/v2/trades/tBTCUSD/hist?limit=1   ->  [[id, time_ms, amount, price]]
// The price is the price of the LAST TRADE on Bitfinex's BTC/USD, ETH/USD or SOL/USD market.
// The website shows exactly the same number: it listens to Bitfinex's websocket and shows the
// last trade (the close of the newest 1-minute candle), so what people see is what decides the round.
// Bitfinex's limit for this endpoint is between 10 and 90 requests a minute per IP (a 60 second block
// if you go over). The runner asks only when it is about to push a price (a start and an end price per round
// per market, the start one repeated every few seconds until the first trade after the lock exists), at most
// once every 5 seconds per market.
//
// Quote time: Bitfinex answers with the current time in its "Date" header, so a quote is stamped with
// Bitfinex's own clock (not this PC's). If the last trade was a while ago, the price is still the market
// price right now, because nothing has traded since.
// START price (docs/RULES.md, H5): a caller can say firstTradeAfter = T. Then this asks Bitfinex for the
// OLDEST trade at or after T (sort=1&start=T) and uses that trade's own time, not the time of the quote.
// If nothing has traded since T it throws, and the runner asks again a few seconds later.
//
// If the API fails or looks wrong this THROWS. It never falls back to made-up numbers: the runner then
// simply pushes nothing, which is what a real feed outage looks like (the contract refunds a round with
// no usable update).
export const SOURCE = 'Bitfinex';
export const SYMBOLS = { 'BTC/USD': 'tBTCUSD', 'ETH/USD': 'tETHUSD', 'SOL/USD': 'tSOLUSD' };
const BASE = 'https://api-pub.bitfinex.com/v2/trades';

export function createExchangePrices({
  fetchFn = fetch,
  nowMs = Date.now,
  ttlMs = 5_000,           // reuse a market's last answer for 5 seconds
  minGapMs = 5_000,        // never ask for the same market more often than this, even after a failure
  maxTradeAgeSec = 900,    // a market with no trade for 15 minutes looks stalled: do not push
  maxClockSkewSec = 120,   // this PC's clock must be within 2 minutes of Bitfinex's
  maxJump = 0.20,          // reject a price that moved more than 20% from the last one we handed out
} = {}) {
  const cache = {};        // market name -> { at, quote }
  const lastTry = {};      // market name -> ms
  const lastPrice = {};    // market name -> last USD price handed out

  // One request to Bitfinex for the given market; returns the checked quote of the first trade in the answer,
  // or null when the answer is an empty list (no trade in that range).
  async function ask(marketName, query) {
    const symbol = SYMBOLS[marketName];
    if (!symbol) throw new Error(`no real price source for market ${marketName}`);
    if (nowMs() - (lastTry[marketName] ?? -Infinity) < minGapMs) throw new Error('price API was tried a moment ago; waiting before asking again');
    lastTry[marketName] = nowMs();

    const res = await fetchFn(`${BASE}/${symbol}/hist?${query}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Bitfinex answered HTTP ${res.status}${res.status === 429 ? ' (too many requests: rate limited)' : ''}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length === 0) return null;
    const trade = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : null; // an error answer looks like ["error", 11010, "ratelimit: error"]
    const tradeMs = trade?.[1];
    const usd = trade?.[3];
    if (!trade || typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0 || typeof tradeMs !== 'number' || !Number.isFinite(tradeMs)) {
      throw new Error(`Bitfinex gave no usable price for ${symbol}${data?.[0] === 'error' ? ` (${data.slice(1).join(' ')})` : ''}`);
    }

    // Bitfinex's own clock, from the HTTP Date header; if it is missing we fall back to this PC's clock.
    const dateHeader = res.headers?.get?.('date');
    const serverMs = dateHeader ? Date.parse(dateHeader) : NaN;
    const quotedAt = Number.isFinite(serverMs) ? Math.floor(serverMs / 1000) : Math.floor(nowMs() / 1000);
    if (Number.isFinite(serverMs) && Math.abs(nowMs() / 1000 - quotedAt) > maxClockSkewSec) {
      throw new Error(`this PC's clock differs from Bitfinex's by ${Math.round(nowMs() / 1000 - quotedAt)} s: fix the clock before pushing prices`);
    }
    const tradeAt = Math.floor(tradeMs / 1000);
    if (quotedAt - tradeAt > maxTradeAgeSec) {
      throw new Error(`Bitfinex's last ${symbol} trade is ${Math.round((quotedAt - tradeAt) / 60)} minutes old: the market looks stalled`);
    }
    return { usd, quotedAt, tradeAt, source: SOURCE };
  }

  async function load(marketName) {
    const c = cache[marketName];
    if (c && nowMs() - c.at < ttlMs) return c.quote;
    const quote = await ask(marketName, 'limit=1');
    if (!quote) throw new Error(`Bitfinex gave no usable price for ${SYMBOLS[marketName]} (empty answer)`);
    cache[marketName] = { at: nowMs(), quote };
    return quote;
  }

  return {
    /**
     * Current real USD price for a market.
     * Returns { price (8-decimal BigInt, ready for the feed), usd, quotedAt (unix seconds, Bitfinex's clock),
     *           tradeAt (unix seconds of the trade the price comes from), source }.
     * firstTradeAfter (unix seconds, optional): use the OLDEST trade whose own time is at or after this moment
     * (the START price). Throws if there is none yet; the cache is not used and the 5 second limit still applies.
     */
    async quote(marketName, { firstTradeAfter } = {}) {
      let q;
      if (firstTradeAfter !== undefined) {
        q = await ask(marketName, `limit=1&sort=1&start=${Math.floor(firstTradeAfter * 1000)}`);
        if (!q) throw new Error(`no ${marketName} trade on Bitfinex yet since ${new Date(firstTradeAfter * 1000).toISOString().slice(11, 19)} UTC; will try again`);
        if (q.tradeAt < firstTradeAfter) throw new Error(`Bitfinex answered with a ${marketName} trade from before the lock; will try again`);
      } else {
        q = await load(marketName);
      }
      const before = lastPrice[marketName];
      if (before && Math.abs(q.usd - before) / before > maxJump) {
        throw new Error(`${marketName} moved from ${before} to ${q.usd} (over ${maxJump * 100}%): not trusting it`);
      }
      lastPrice[marketName] = q.usd;
      return { price: BigInt(Math.round(q.usd * 1e8)), ...q };
    },

    /** Same as quote(), but only the 8-decimal price. */
    async price(marketName, opts) {
      return (await this.quote(marketName, opts)).price;
    },
  };
}
