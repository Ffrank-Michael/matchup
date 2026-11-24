// node --test runner/priceWindow.test.mjs
// Start and end prices from a WINDOW of trades (audit part 2, P2-01): BTC and ETH use the median of all Bitfinex trades in a short
// window; with fewer than 3 trades there is no price (a FINAL error: nothing is pushed, the round refunds). SOL keeps one trade.
// No network: a fake Bitfinex answers from a list of trades.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExchangePrices, WINDOWS, WINDOW_SETTLE_SEC, median } from './exchangePrices.mjs';
import { CFG } from './config.mjs';
import { makePriceLogEntry } from './priceLog.mjs';
import { madeOf } from './mainnet.mjs';
import { FINAL_WAIT_MS } from './retry.mjs';

const LOCK = 1_800_000_000; // seconds
const T = LOCK + CFG.startAfter;
const WB = WINDOWS['BTC/USD'].seconds;
const WE = WINDOWS['ETH/USD'].seconds;

/** A fake Bitfinex: trades per symbol as [timeSec, price]; answers the window asked for, oldest first, like sort=1. */
function bitfinex(trades, { dateSec } = {}) {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    const sym = url.match(/trades\/(t\w+)\/hist/)[1];
    const q = new URL(url).searchParams;
    const from = Number(q.get('start')), to = Number(q.get('end'));
    const list = (trades[sym] ?? []).map(([sec, price], i) => [i + 1, sec * 1000, 0.01, price]).filter((t) => t[1] >= from && t[1] <= to);
    return { ok: true, status: 200, json: async () => list, headers: new Headers(dateSec ? { date: new Date(dateSec * 1000).toUTCString() } : {}) };
  };
  return { fetchFn, urls };
}
const pricesAt = (nowSec, f, opts = {}) => createExchangePrices({ fetchFn: f.fetchFn, nowMs: () => nowSec * 1000, ...opts });

test('the windows: BTC 60 s, ETH 90 s, at least 3 trades each; SOL has none (it keeps one trade)', () => {
  assert.deepEqual(WINDOWS['BTC/USD'], { seconds: 60, minTrades: 3 });
  assert.deepEqual(WINDOWS['ETH/USD'], { seconds: 90, minTrades: 3 });
  assert.equal(WINDOWS['SOL/USD'], undefined);
});

test('both windows fit inside a 5-minute round: the start window ends before the end window begins', () => {
  for (const [pair, w] of Object.entries(WINDOWS)) {
    const startEnds = CFG.startAfter + w.seconds;
    const endBegins = 300 - CFG.endMargin - w.seconds;
    assert.ok(startEnds < endBegins, `${pair}: start window ends at ${startEnds} s, end window begins at ${endBegins} s`);
  }
});

test('median: odd and even counts, order does not matter', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
});

test('START (BTC): the median of every trade from lock + 2 s for the BTC window, asked once the window closed', async () => {
  const f = bitfinex({ tBTCUSD: [[T - 1, 1], [T, 80_000], [T + 5, 80_010], [T + 12, 80_020], [T + WB - 1, 80_030], [T + WB, 99_999]] }, { dateSec: T + WB + 3 });
  const q = await pricesAt(T + WB + 3, f).quote('BTC/USD 5m', { firstTradeAfter: T });
  assert.equal(q.usd, (80_010 + 80_020) / 2, 'trades before T and at the window end are outside it');
  assert.equal(q.price, 8_001_500_000_000n);
  assert.deepEqual([q.method, q.trades, q.windowFrom, q.windowTo], ['median', 4, T, T + WB]);
  assert.ok(f.urls[0].includes(`tBTCUSD/hist?start=${T * 1000}&end=${(T + WB) * 1000 - 1}&limit=10000&sort=1`), f.urls[0]);
});

test('START: not asked before the window has closed (plus 2 s): "not over yet", and that is not final', async () => {
  const f = bitfinex({ tBTCUSD: [[T + 1, 80_000], [T + 2, 80_000], [T + 3, 80_000]] });
  const e = await pricesAt(T + WB + WINDOW_SETTLE_SEC - 1, f).quote('BTC/USD 5m', { firstTradeAfter: T }).catch((x) => x);
  assert.match(e.message, /window .* is not over yet; will try again/);
  assert.equal(e.final, undefined);
  assert.equal(f.urls.length, 0, 'Bitfinex was not even asked');
});

test('START: fewer than 3 trades in the window -> no price, a FINAL error (nothing is pushed, the round refunds)', async () => {
  const f = bitfinex({ tETHUSD: [[T + 10, 3000], [T + 40, 3001]] }, { dateSec: T + WE + 3 });
  const e = await pricesAt(T + WE + 3, f).quote('ETH/USD 5m', { firstTradeAfter: T }).catch((x) => x);
  assert.match(e.message, /only 2 ETH\/USD trades on Bitfinex .* \(at least 3 needed\): no price, so the round refunds/);
  assert.equal(e.final, true);
  assert.ok(FINAL_WAIT_MS >= 60 * 60_000, 'the runner does not ask again for the rest of the round');
});

test('END (ETH): the median of the ETH window that closes 60 s before the round ends', async () => {
  const end = LOCK + 300;
  const from = end - CFG.endMargin - WE, to = end - CFG.endMargin;
  const f = bitfinex({ tETHUSD: [[from - 1, 1], [from, 3000], [from + 20, 3002], [to - 1, 3004], [to, 9999]] }, { dateSec: to + 3 });
  const q = await pricesAt(to + 3, f).quote('ETH/USD 5m', { endsAt: end });
  assert.equal(q.usd, 3002);
  assert.deepEqual([q.trades, q.windowFrom, q.windowTo], [3, from, to]);
});

test('a single huge or odd trade does not move the median (the point of the fix)', async () => {
  const f = bitfinex({ tBTCUSD: [[T + 1, 80_000], [T + 2, 80_001], [T + 3, 79_999], [T + 4, 80_002], [T + 5, 82_000]] }, { dateSec: T + WB + 3 });
  const q = await pricesAt(T + WB + 3, f).quote('BTC/USD 5m', { firstTradeAfter: T });
  assert.equal(q.usd, 80_001, 'the 82,000 print is ignored');
});

test('SOL keeps the single first trade at or after the moment (no window)', async () => {
  const urls = [];
  const sol = createExchangePrices({ nowMs: () => (T + 8) * 1000, fetchFn: async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => [[1, (T + 7) * 1000, 0.1, 150]], headers: new Headers({ date: new Date((T + 8) * 1000).toUTCString() }) };
  } });
  const q = await sol.quote('SOL/USD 5m', { firstTradeAfter: T });
  assert.equal(q.usd, 150);
  assert.equal(q.method, undefined);
  assert.ok(urls[0].includes('tSOLUSD/hist?limit=1&sort=1&start='), urls[0]);
});

test('coin vs coin: each coin by its own rule (ETH/BTC: two windows)', async () => {
  const eth = [[T + 1, 3000], [T + 20, 3000], [T + 50, 3000]];
  const btc = [[T + 1, 100_000], [T + 10, 100_000], [T + 20, 100_000]];
  const f = bitfinex({ tETHUSD: eth, tBTCUSD: btc }, { dateSec: T + WE + 3 });
  const q = await pricesAt(T + WE + 3, f).quote('ETH/BTC 1h', { firstTradeAfter: T });
  assert.equal(q.price, 30_000_000_000_000_000n); // 0.03
  assert.deepEqual(q.legs.map((l) => [l.pair, l.method, l.trades, l.windowTo]), [['ETH/USD', 'median', 3, T + WE], ['BTC/USD', 'median', 3, T + WB]]);
  assert.match(madeOf(q), /ETH\/USD median of 3 trades .* \/ BTC\/USD median of 3 trades/);
});

test('coin vs coin: too few trades on ONE coin is enough for no price (final)', async () => {
  const f = bitfinex({ tETHUSD: [[T + 1, 3000], [T + 20, 3000], [T + 50, 3000]], tBTCUSD: [[T + 1, 100_000]] }, { dateSec: T + WE + 3 });
  const e = await pricesAt(T + WE + 3, f).quote('ETH/BTC 1h', { firstTradeAfter: T }).catch((x) => x);
  assert.equal(e.final, true);
  assert.match(e.message, /only 1 BTC\/USD trade/);
});

test('the price log says how a windowed price was made', async () => {
  const f = bitfinex({ tBTCUSD: [[T + 1, 80_000], [T + 2, 80_000], [T + 3, 80_000]] }, { dateSec: T + WB + 3 });
  const q = await pricesAt(T + WB + 3, f).quote('BTC/USD 5m', { firstTradeAfter: T });
  const e = makePriceLogEntry({ action: { marketName: 'BTC/USD 5m', market: 0, round: 1, why: 'start price' }, quote: q, txHash: '0x1', blockNumber: 1n, blockTimestamp: BigInt(T + WB + 5), feed: '0xf', explorer: 'x', chainId: 1 });
  assert.deepEqual([e.method, e.trades, e.windowFrom, e.windowTo], ['median', 3, T, T + WB]);
  assert.match(madeOf(q), /^median of 3 trades \d\d:\d\d:\d\d-\d\d:\d\d:\d\d UTC$/);
});

test('a Bitfinex clock behind the window end means "not over yet" (not final), even if this PC thinks it is', async () => {
  const f = bitfinex({ tBTCUSD: [[T + 1, 80_000], [T + 2, 80_000], [T + 3, 80_000]] }, { dateSec: T + WB - 1 });
  const e = await pricesAt(T + WB + 3, f).quote('BTC/USD 5m', { firstTradeAfter: T }).catch((x) => x);
  assert.match(e.message, /Bitfinex's clock says the BTC\/USD window is not over yet/);
  assert.equal(e.final, undefined);
});
