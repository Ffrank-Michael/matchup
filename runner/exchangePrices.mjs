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
// WINDOWS (audit part 2, P2-01): one trade at a moment anyone can predict was enough to set a price. So for BTC and ETH the
// start and end prices are the MEDIAN of all trades in a short window instead of one trade:
//   start: the window opens at firstTradeAfter (lock + 2 s) and lasts WINDOWS[pair].seconds
//   end:   the window closes endMargin seconds before the round ends (60 s) and lasts WINDOWS[pair].seconds
// With fewer than WINDOWS[pair].minTrades trades in the window there is no price: the error is FINAL (e.final = true), the
// runner does not ask again, nothing is pushed and the round refunds. The median counts trades, not their size, so one big
// order that walks the book counts once per trade it makes, and an attacker needs more than half of the trades in the window.
// SOL/USD trades too rarely on Bitfinex for this (no trade at all in about 40% of minutes, measured 25 Nov 2026), so SOL keeps
// the single-trade rule above until a second, deeper source is added (docs/RUNBOOK.md, "Known limits").
//
// If the API fails or looks wrong this THROWS. It never falls back to made-up numbers: the runner then
// simply pushes nothing, which is what a real feed outage looks like (the contract refunds a round with
// no usable update).
import { pairOf, isRatioPair, legsOf, ratio18, toUsd8, RATIO_DECIMALS, USD_DECIMALS } from './pairs.mjs';
import { CFG } from './config.mjs';

export const SOURCE = 'Bitfinex';
export const SYMBOLS = { 'BTC/USD': 'tBTCUSD', 'ETH/USD': 'tETHUSD', 'SOL/USD': 'tSOLUSD' };
const BASE = 'https://api-pub.bitfinex.com/v2/trades';
/** Coins whose start and end are the median of a window of trades (P2-01). A coin not listed (SOL) keeps the single trade. */
export const WINDOWS = {
  // Measured over a full day on 25 Nov 2026 (76,000 BTC and 25,500 ETH trades): fewer than 3 trades in 0.3% of 60 s BTC windows
  // (5% in the quietest hour) and 1.7% of 90 s ETH windows (18% in the quietest hour). Shorter windows refunded too often
  // (BTC 30 s: 2.5%; ETH 60 s: 5.3%). Both still fit a 5-minute round: start 0:02-1:32, end 2:30-4:00 for ETH.
  'BTC/USD': { seconds: 60, minTrades: 3 },
  'ETH/USD': { seconds: 90, minTrades: 3 },
};
/** A window is only asked for once it closed this long ago, so Bitfinex's history has every trade in it. */
export const WINDOW_SETTLE_SEC = 2;

/** The median of a list of numbers (the mean of the middle two for an even count). */
export function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const hhmmss = (sec) => new Date(sec * 1000).toISOString().slice(11, 19);

export function createExchangePrices({
  fetchFn = fetch,
  nowMs = Date.now,
  ttlMs = 5_000,           // reuse a market's last answer for 5 seconds
  minGapMs = 5_000,        // never ask for the same market more often than this, even after a failure
  maxTradeAgeSec = 900,    // a market with no trade for 15 minutes looks stalled: do not push
  maxClockSkewSec = 120,   // this PC's clock must be within 2 minutes of Bitfinex's
  maxJump = 0.20,          // reject a price that moved more than 20% from the last one we handed out
  windows = WINDOWS,       // which coins use a window of trades instead of one trade (P2-01)
  endMargin = CFG.endMargin, // the end window closes this long before the round ends
} = {}) {
  const cache = {};        // market name -> { at, quote }
  const lastTry = {};      // market name -> ms
  const lastPrice = {};    // market name -> last USD price handed out

  // One request to Bitfinex for the given market; returns the checked quote of the first trade in the answer,
  // or null when the answer is an empty list (no trade in that range).
  async function ask(pair, query) {
    const symbol = SYMBOLS[pair];
    if (!symbol) throw new Error(`no real price source for market ${pair}`);
    if (nowMs() - (lastTry[pair] ?? -Infinity) < minGapMs) throw new Error('price API was tried a moment ago; waiting before asking again');
    lastTry[pair] = nowMs();

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

  /**
   * The median of every trade of `pair` from fromSec (included) to toSec (not included). Throws (not final) while the window has
   * not closed WINDOW_SETTLE_SEC ago, and a FINAL error when it holds fewer than minTrades trades.
   */
  async function windowQuote(pair, fromSec, toSec, minTrades) {
    const symbol = SYMBOLS[pair];
    if (!symbol) throw new Error(`no real price source for market ${pair}`);
    const nowSec = nowMs() / 1000;
    if (nowSec < toSec + WINDOW_SETTLE_SEC) throw new Error(`the ${pair} price window (${hhmmss(fromSec)} to ${hhmmss(toSec)} UTC) is not over yet; will try again`);
    if (nowMs() - (lastTry[pair] ?? -Infinity) < minGapMs) throw new Error('price API was tried a moment ago; waiting before asking again');
    lastTry[pair] = nowMs();
    const res = await fetchFn(`${BASE}/${symbol}/hist?start=${Math.floor(fromSec * 1000)}&end=${Math.floor(toSec * 1000) - 1}&limit=10000&sort=1`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Bitfinex answered HTTP ${res.status}${res.status === 429 ? ' (too many requests: rate limited)' : ''}`);
    const data = await res.json();
    if (!Array.isArray(data) || (data.length && !Array.isArray(data[0]))) throw new Error(`Bitfinex gave no usable trades for ${symbol}${data?.[0] === 'error' ? ` (${data.slice(1).join(' ')})` : ''}`);
    const dateHeader = res.headers?.get?.('date');
    const serverMs = dateHeader ? Date.parse(dateHeader) : NaN;
    const quotedAt = Number.isFinite(serverMs) ? Math.floor(serverMs / 1000) : Math.floor(nowSec);
    if (Number.isFinite(serverMs) && Math.abs(nowSec - quotedAt) > maxClockSkewSec) {
      throw new Error(`this PC's clock differs from Bitfinex's by ${Math.round(nowSec - quotedAt)} s: fix the clock before pushing prices`);
    }
    if (quotedAt < toSec) throw new Error(`Bitfinex's clock says the ${pair} window is not over yet; will try again`);
    const trades = data
      .filter((t) => typeof t?.[1] === 'number' && typeof t?.[3] === 'number' && Number.isFinite(t[3]) && t[3] > 0)
      .filter((t) => t[1] >= fromSec * 1000 && t[1] < toSec * 1000);
    if (trades.length < minTrades) {
      const e = new Error(`only ${trades.length} ${pair} trade${trades.length === 1 ? '' : 's'} on Bitfinex from ${hhmmss(fromSec)} to ${hhmmss(toSec)} UTC (at least ${minTrades} needed): no price, so the round refunds`);
      e.final = true;
      throw e;
    }
    const usd = median(trades.map((t) => t[3]));
    return { usd, quotedAt, tradeAt: Math.floor(trades[trades.length - 1][1] / 1000), source: SOURCE, method: 'median', trades: trades.length, windowFrom: fromSec, windowTo: toSec };
  }

  async function load(pair) {
    const c = cache[pair];
    if (c && nowMs() - c.at < ttlMs) return c.quote;
    const quote = await ask(pair, 'limit=1');
    if (!quote) throw new Error(`Bitfinex gave no usable price for ${SYMBOLS[pair]} (empty answer)`);
    cache[pair] = { at: nowMs(), quote };
    return quote;
  }

  /**
   * One USD market's checked quote (8-decimal price).
   *   firstTradeAfter: the START price (a window from that moment, or the oldest trade at or after it for a coin without a window)
   *   endsAt:          the END price of a round ending then (a window closing endMargin before it, or the last trade for a coin without one)
   */
  async function usdQuote(pair, firstTradeAfter, endsAt) {
    let q;
    const w = windows[pair];
    if (w && firstTradeAfter !== undefined) {
      q = await windowQuote(pair, firstTradeAfter, firstTradeAfter + w.seconds, w.minTrades);
    } else if (w && endsAt !== undefined) {
      q = await windowQuote(pair, endsAt - endMargin - w.seconds, endsAt - endMargin, w.minTrades);
    } else if (firstTradeAfter !== undefined) {
      q = await ask(pair, `limit=1&sort=1&start=${Math.floor(firstTradeAfter * 1000)}`);
      if (!q) throw new Error(`no ${pair} trade on Bitfinex yet since ${new Date(firstTradeAfter * 1000).toISOString().slice(11, 19)} UTC; will try again`);
      if (q.tradeAt < firstTradeAfter) throw new Error(`Bitfinex answered with a ${pair} trade from before the lock; will try again`);
    } else {
      q = await load(pair);
    }
    jumpCheck(pair, q.usd);
    return { price: toUsd8(q.usd), decimals: USD_DECIMALS, ...q };
  }

  /** Refuses a price that moved more than maxJump from the last one handed out for that pair, then remembers it. */
  function jumpCheck(pair, value) {
    const before = lastPrice[pair];
    if (before && Math.abs(value - before) / before > maxJump) {
      throw new Error(`${pair} moved from ${before} to ${value} (over ${maxJump * 100}%): not trusting it`);
    }
    lastPrice[pair] = value;
  }

  /**
   * A coin-vs-coin market ("ETH/BTC"): both coins are asked (for the START price each coin's own first trade at or after
   * firstTradeAfter), and the price is top / bottom with 18 decimals, the same maths as the RatioGuard contract.
   * Both trades are kept in `legs`, so the price log can show where the ratio came from.
   */
  async function ratioQuote(pair, firstTradeAfter, endsAt) {
    const [topPair, bottomPair] = legsOf(pair);
    const top = await usdQuote(topPair, firstTradeAfter, endsAt);
    const bottom = await usdQuote(bottomPair, firstTradeAfter, endsAt);
    const price = ratio18(top.price, bottom.price);
    const value = Number(price) / 10 ** RATIO_DECIMALS;
    jumpCheck(pair, value);
    const leg = (p, q) => ({ pair: p, usd: q.usd, price: String(q.price), tradeAt: q.tradeAt, quotedAt: q.quotedAt, ...(q.method ? { method: q.method, trades: q.trades, windowFrom: q.windowFrom, windowTo: q.windowTo } : {}) });
    return {
      price, usd: value, decimals: RATIO_DECIMALS, source: SOURCE,
      quotedAt: Math.max(top.quotedAt, bottom.quotedAt),
      tradeAt: Math.max(top.tradeAt, bottom.tradeAt), // the later of the two trades: the ratio exists from that moment
      legs: [leg(topPair, top), leg(bottomPair, bottom)],
    };
  }

  return {
    /**
     * Current real USD price for a market (or, for a coin-vs-coin market such as "ETH/BTC 1h", the ratio of two coins).
     * Returns { price (8-decimal BigInt, ready for the feed), usd, quotedAt (unix seconds, Bitfinex's clock),
     *           tradeAt (unix seconds of the trade the price comes from), source }.
     * firstTradeAfter (unix seconds, optional): use the OLDEST trade whose own time is at or after this moment
     * (the START price). Throws if there is none yet; the cache is not used and the 5 second limit still applies.
     */
    async quote(marketName, { firstTradeAfter, endsAt } = {}) {
      const pair = pairOf(marketName); // "BTC/USD 5m" and "BTC/USD 10m" are the same coin
      return isRatioPair(pair) ? ratioQuote(pair, firstTradeAfter, endsAt) : usdQuote(pair, firstTradeAfter, endsAt);
    },

    /** Same as quote(), but only the price (8 decimals, or 18 for a coin-vs-coin market). */
    async price(marketName, opts) {
      return (await this.quote(marketName, opts)).price;
    },
  };
}
