// Tests for the real-price source (Bitfinex). No network: a fake fetch stands in for Bitfinex.
//   node --test runner/exchangePrices.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExchangePrices, SYMBOLS, SOURCE } from './exchangePrices.mjs';

const NOW = 1_800_000_000_000; // ms
const iso = (ms) => new Date(ms).toUTCString();

// A Bitfinex answer: the newest trade [id, time_ms, amount, price], plus the Date header.
const trade = (usd, tradeAgoSec = 3) => [[1999595785, NOW - tradeAgoSec * 1000, 0.0014, usd]];
const ok = (data, dateMs = NOW) => ({ ok: true, status: 200, json: async () => data, headers: new Headers(dateMs === null ? {} : { date: iso(dateMs) }) });
const bad = (status) => ({ ok: false, status, json: async () => ({}), headers: new Headers() });

function setup(responses, opts = {}) {
  let t = NOW;
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init, at: t });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(t) : r;
  };
  const prices = createExchangePrices({ fetchFn, nowMs: () => t, ...opts });
  return { prices, calls, advance: (s) => { t += s * 1000; } };
}

test('gives the last trade price as an 8-decimal whole number', async () => {
  const { prices } = setup([ok(trade(80522))]);
  assert.equal(await prices.price('BTC/USD'), 8052200000000n);
  const e = setup([ok(trade(2343.74))]);
  assert.equal(await e.prices.price('ETH/USD'), 234374000000n);
  const s = setup([ok(trade(101.42))]);
  assert.equal(await s.prices.price('SOL/USD'), 10142000000n);
});

test('asks Bitfinex for the newest trade of exactly the right market', async () => {
  const { prices, calls } = setup([ok(trade(80522))]);
  await prices.price('BTC/USD');
  const e = setup([ok(trade(2343))]);
  await e.prices.price('ETH/USD');
  const s = setup([ok(trade(101))]);
  await s.prices.price('SOL/USD');
  assert.equal(calls[0].url, 'https://api-pub.bitfinex.com/v2/trades/tBTCUSD/hist?limit=1');
  assert.equal(e.calls[0].url, 'https://api-pub.bitfinex.com/v2/trades/tETHUSD/hist?limit=1');
  assert.equal(s.calls[0].url, 'https://api-pub.bitfinex.com/v2/trades/tSOLUSD/hist?limit=1');
});

test('the quote carries its source, Bitfinex clock time and the time of the trade', async () => {
  const { prices } = setup([ok(trade(80522, 7))]);
  const q = await prices.quote('BTC/USD');
  assert.equal(q.source, SOURCE);
  assert.equal(SOURCE, 'Bitfinex');
  assert.equal(q.quotedAt, NOW / 1000);
  assert.equal(q.tradeAt, NOW / 1000 - 7);
  assert.equal(q.usd, 80522);
});

test('an answer is reused for 5 seconds per market, and each market is asked separately', async () => {
  const { prices, calls, advance } = setup([ok(trade(80522))]);
  await prices.price('BTC/USD');
  advance(4);
  await prices.price('BTC/USD');
  assert.equal(calls.length, 1);
  advance(2);
  await prices.price('BTC/USD');
  assert.equal(calls.length, 2);
  await prices.price('ETH/USD');
  assert.equal(calls.length, 3);
});

test('rate limited (HTTP 429): throws, and does not ask again for at least 5 seconds', async () => {
  const { prices, calls, advance } = setup([bad(429), ok(trade(80522))]);
  await assert.rejects(() => prices.price('BTC/USD'), /429.*rate limited/);
  advance(2);
  await assert.rejects(() => prices.price('BTC/USD'), /tried a moment ago/);
  assert.equal(calls.length, 1);
  advance(4);
  assert.equal(await prices.price('BTC/USD'), 8052200000000n);
  assert.equal(calls.length, 2);
});

test('Bitfinex error answer, network failure or a server error: throws, never invents a price', async () => {
  const a = setup([ok(['error', 11010, 'ratelimit: error'])]);
  await assert.rejects(() => a.prices.price('BTC/USD'), /no usable price.*ratelimit/);
  const b = setup([new Error('fetch failed')]);
  await assert.rejects(() => b.prices.price('BTC/USD'), /fetch failed/);
  const c = setup([bad(500)]);
  await assert.rejects(() => c.prices.price('BTC/USD'), /HTTP 500/);
  const d = setup([ok([])]);
  await assert.rejects(() => d.prices.price('BTC/USD'), /no usable price/);
});

test('refuses a missing, zero, negative or non-number price or trade time', async () => {
  for (const usd of [undefined, 0, -5, '80522', null, NaN]) {
    const { prices } = setup([ok(trade(usd))]);
    await assert.rejects(() => prices.price('BTC/USD'), /no usable price/, `usd=${String(usd)}`);
  }
  const { prices } = setup([ok([[1, 'noon', 0.1, 80522]])]);
  await assert.rejects(() => prices.price('BTC/USD'), /no usable price/);
});

test('an old last trade is still the market price, but a market silent for 15 minutes is refused', async () => {
  const quiet = setup([ok(trade(80522, 600))]);
  assert.equal(await quiet.prices.price('BTC/USD'), 8052200000000n); // 10 minutes ago: nothing traded since, so still the price
  const dead = setup([ok(trade(80522, 901))]);
  await assert.rejects(() => dead.prices.price('BTC/USD'), /stalled/);
  const edge = setup([ok(trade(80522, 900))]);
  assert.equal(await edge.prices.price('BTC/USD'), 8052200000000n);
});

test('refuses a price that jumped more than 20% from the last one handed out', async () => {
  const { prices, advance } = setup([ok(trade(80522)), (t) => ok(trade(100000), t)]);
  await prices.price('BTC/USD');
  advance(60);
  await assert.rejects(() => prices.price('BTC/USD'), /not trusting it/);
});

test('a normal move is accepted', async () => {
  const { prices, advance } = setup([ok(trade(80522)), (t) => ok(trade(80900), t)]);
  await prices.price('BTC/USD');
  advance(60);
  assert.equal(await prices.price('BTC/USD'), 8090000000000n);
});

test('a market with no real price source is refused', async () => {
  const { prices, calls } = setup([ok(trade(80522))]);
  await assert.rejects(() => prices.price('DOGE/USD'), /no real price source/);
  assert.equal(calls.length, 0);
});

test('the three testnet markets are the ones that have a source', () => {
  assert.deepEqual(SYMBOLS, { 'BTC/USD': 'tBTCUSD', 'ETH/USD': 'tETHUSD', 'SOL/USD': 'tSOLUSD' });
});

test("this PC's clock is checked against Bitfinex's: more than 2 minutes apart is refused", async () => {
  const off = setup([ok(trade(80522), NOW - 121_000)]);
  await assert.rejects(() => off.prices.price('BTC/USD'), /clock differs/);
  const near = setup([ok(trade(80522), NOW - 120_000)]);
  assert.equal(await near.prices.price('BTC/USD'), 8052200000000n);
});

test('without a Date header the PC clock is used for the quote time', async () => {
  const { prices } = setup([ok(trade(80522), null)]);
  assert.equal((await prices.quote('BTC/USD')).quotedAt, NOW / 1000);
});

// ---------------------------------------------------------------- fairness (rule H5): the start price is the first trade AFTER the lock

const LOCK = NOW / 1000;
// A "first trade after T" answer: the oldest trade at or after T, stamped by its own time.
const tradeAt = (usd, atSec) => [[1999595786, atSec * 1000, 0.002, usd]];

test('firstTradeAfter: asks Bitfinex for the OLDEST trade at or after the moment (sort=1&start=T)', async () => {
  const { prices, calls } = setup([ok(tradeAt(80600, LOCK + 5), NOW + 8_000)]);
  const q = await prices.quote('BTC/USD', { firstTradeAfter: LOCK + 2 });
  assert.equal(calls[0].url, `https://api-pub.bitfinex.com/v2/trades/tBTCUSD/hist?limit=1&sort=1&start=${(LOCK + 2) * 1000}`);
  assert.equal(q.usd, 80600);
  assert.equal(q.tradeAt, LOCK + 5);        // the price is stamped with the TRADE's time (not the time of the question)
  assert.equal(q.quotedAt, LOCK + 8);
});

test('firstTradeAfter: no trade yet since the lock -> nothing is pushed, and it asks again a few seconds later', async () => {
  const { prices, calls, advance } = setup([ok([], NOW + 3_000), (t) => ok(tradeAt(80600, LOCK + 6), t)]);
  advance(3);
  await assert.rejects(() => prices.quote('BTC/USD', { firstTradeAfter: LOCK + 2 }), /no BTC\/USD trade on Bitfinex yet/);
  advance(5);
  const q = await prices.quote('BTC/USD', { firstTradeAfter: LOCK + 2 });
  assert.equal(q.tradeAt, LOCK + 6);
  assert.equal(calls.length, 2);
});

test('firstTradeAfter: a trade from before the moment is refused (even if the answer came late)', async () => {
  const { prices } = setup([ok(tradeAt(80600, LOCK + 1), NOW + 9_000)]);
  await assert.rejects(() => prices.quote('BTC/USD', { firstTradeAfter: LOCK + 2 }), /before the lock/);
});

test('firstTradeAfter: a trade exactly at the moment is accepted', async () => {
  const { prices } = setup([ok(tradeAt(80600, LOCK + 2), NOW + 9_000)]);
  assert.equal((await prices.quote('BTC/USD', { firstTradeAfter: LOCK + 2 })).tradeAt, LOCK + 2);
});

test('firstTradeAfter: never uses the 5 second cache, and asking again is still limited to once per 5 seconds', async () => {
  const { prices, calls, advance } = setup([ok(trade(80522), NOW), ok(tradeAt(80600, LOCK + 3), NOW + 6_000)]);
  await prices.quote('BTC/USD');                                                  // the normal last-trade answer, now cached
  advance(1);
  await assert.rejects(() => prices.quote('BTC/USD', { firstTradeAfter: LOCK + 2 }), /tried a moment ago/);
  advance(5);
  assert.equal((await prices.quote('BTC/USD', { firstTradeAfter: LOCK + 2 })).usd, 80600);
  assert.equal(calls.length, 2);
});

test('firstTradeAfter: a Bitfinex error answer is not a price', async () => {
  const { prices } = setup([ok(['error', 11010, 'ratelimit: error'])]);
  await assert.rejects(() => prices.quote('BTC/USD', { firstTradeAfter: LOCK + 2 }), /no usable price/);
});

test('without firstTradeAfter the last trade is used, whatever its age', async () => {
  const { prices } = setup([ok(trade(80522, 100))]);
  const q = await prices.quote('BTC/USD');
  assert.equal(q.price, 8052200000000n);
});
