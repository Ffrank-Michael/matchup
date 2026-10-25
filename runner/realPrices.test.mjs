// Tests for the real-price source. No network: a fake fetch stands in for CoinGecko.
//   node --test runner/realPrices.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealPrices, COINGECKO_IDS } from './realPrices.mjs';

const NOW = 1_800_000_000_000; // ms
const body = (over = {}) => ({
  bitcoin: { usd: 80522, last_updated_at: NOW / 1000 - 20 },
  ethereum: { usd: 2343.74, last_updated_at: NOW / 1000 - 20 },
  solana: { usd: 101.42, last_updated_at: NOW / 1000 - 20 },
  ...over,
});
const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const bad = (status) => ({ ok: false, status, json: async () => ({}) });

function setup(responses, opts = {}) {
  let t = NOW;
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  const prices = createRealPrices({ fetchFn, nowMs: () => t, ...opts });
  return { prices, calls, advance: (s) => { t += s * 1000; } };
}

test('gives each market its real price as an 8-decimal whole number', async () => {
  const { prices } = setup([ok(body())]);
  assert.equal(await prices.price('BTC/USD'), 8052200000000n);
  assert.equal(await prices.price('ETH/USD'), 234374000000n);
  assert.equal(await prices.price('SOL/USD'), 10142000000n);
});

test('one request serves all three markets, and the answer is reused for 30 seconds', async () => {
  const { prices, calls, advance } = setup([ok(body())]);
  await prices.price('BTC/USD'); await prices.price('ETH/USD'); await prices.price('SOL/USD');
  assert.equal(calls.length, 1);
  advance(29);
  await prices.price('BTC/USD');
  assert.equal(calls.length, 1);
  advance(2);
  await prices.price('BTC/USD');
  assert.equal(calls.length, 2);
});

test('asks CoinGecko for exactly bitcoin, ethereum and solana in USD, keyless by default', async () => {
  const { prices, calls } = setup([ok(body())]);
  await prices.price('BTC/USD');
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://api.coingecko.com/api/v3/simple/price');
  assert.equal(u.searchParams.get('ids'), 'bitcoin,ethereum,solana');
  assert.equal(u.searchParams.get('vs_currencies'), 'usd');
  assert.deepEqual(calls[0].init.headers, {});
});

test('a free demo key is sent only when one is given', async () => {
  const { prices, calls } = setup([ok(body())], { apiKey: 'demo-key' });
  await prices.price('BTC/USD');
  assert.equal(calls[0].init.headers['x-cg-demo-api-key'], 'demo-key');
});

test('rate limited (HTTP 429): throws, and does not ask again for at least 15 seconds', async () => {
  const { prices, calls, advance } = setup([bad(429), ok(body())]);
  await assert.rejects(() => prices.price('BTC/USD'), /429.*rate limited/);
  advance(5);
  await assert.rejects(() => prices.price('BTC/USD'), /tried a moment ago/);
  assert.equal(calls.length, 1);
  advance(11);
  assert.equal(await prices.price('BTC/USD'), 8052200000000n);
  assert.equal(calls.length, 2);
});

test('network failure or a server error: throws, never invents a price', async () => {
  const a = setup([new Error('fetch failed')]);
  await assert.rejects(() => a.prices.price('BTC/USD'), /fetch failed/);
  const b = setup([bad(500)]);
  await assert.rejects(() => b.prices.price('BTC/USD'), /HTTP 500/);
});

test('refuses a missing, zero, negative or non-number price', async () => {
  for (const usd of [undefined, 0, -5, '80522', null, NaN]) {
    const { prices } = setup([ok(body({ bitcoin: { usd } }))]);
    await assert.rejects(() => prices.price('ETH/USD'), /no usable price for bitcoin/, `usd=${String(usd)}`);
  }
  const { prices } = setup([ok({})]);
  await assert.rejects(() => prices.price('BTC/USD'), /no usable price/);
});

test('refuses a quote CoinGecko last updated more than 3 minutes ago', async () => {
  const stale = { usd: 80522, last_updated_at: NOW / 1000 - 181 };
  const { prices } = setup([ok(body({ bitcoin: stale }))]);
  await assert.rejects(() => prices.price('BTC/USD'), /stale/);
  assert.equal(await prices.price('ETH/USD'), 234374000000n); // the other coins are still fine
  const fresh = setup([ok(body({ bitcoin: { usd: 80522, last_updated_at: NOW / 1000 - 179 } }))]);
  assert.equal(await fresh.prices.price('BTC/USD'), 8052200000000n);
});

test('refuses a price that jumped more than 20% from the last one handed out', async () => {
  const { prices, advance } = setup([ok(body()), ok(body({ bitcoin: { usd: 100000, last_updated_at: NOW / 1000 } }))]);
  await prices.price('BTC/USD');
  advance(60);
  await assert.rejects(() => prices.price('BTC/USD'), /not trusting it/);
  assert.equal(await prices.price('ETH/USD'), 234374000000n);
});

test('a normal move is accepted', async () => {
  const { prices, advance } = setup([ok(body()), ok(body({ bitcoin: { usd: 80900, last_updated_at: NOW / 1000 } }))]);
  await prices.price('BTC/USD');
  advance(60);
  assert.equal(await prices.price('BTC/USD'), 8090000000000n);
});

test('a market with no real price source is refused', async () => {
  const { prices, calls } = setup([ok(body())]);
  await assert.rejects(() => prices.price('DOGE/USD'), /no real price source/);
  assert.equal(calls.length, 0);
});

test('the three testnet markets are the ones that have a source', () => {
  assert.deepEqual(Object.keys(COINGECKO_IDS), ['BTC/USD', 'ETH/USD', 'SOL/USD']);
});

// ---------------------------------------------------------------- fairness: the start price must be a quote made AFTER the lock

const at = (offsetSec, usd = 80522) => ({ bitcoin: { usd, last_updated_at: NOW / 1000 + offsetSec }, ethereum: { usd: 2343.74, last_updated_at: NOW / 1000 + offsetSec }, solana: { usd: 101.42, last_updated_at: NOW / 1000 + offsetSec } });

test('quotedAfter: a quote made before the lock is refused, a newer one is accepted', async () => {
  const lock = NOW / 1000;
  const { prices, calls, advance } = setup([ok(at(-40)), ok(at(+10, 80600))]);
  await assert.rejects(() => prices.quote('BTC/USD', { quotedAfter: lock + 10 }), /too old for this push/);  // 40 s behind the lock
  advance(16);
  const q = await prices.quote('BTC/USD', { quotedAfter: lock + 10 });                                       // asks again, gets a newer quote
  assert.equal(q.usd, 80600);
  assert.equal(q.quotedAt, lock + 10);
  assert.equal(calls.length, 2);
});

test('quotedAfter: a quote made exactly at the limit is accepted, one second earlier is not', async () => {
  const lock = NOW / 1000;
  const a = setup([ok(at(+10))]);
  assert.equal((await a.prices.quote('BTC/USD', { quotedAfter: lock + 10 })).quotedAt, lock + 10);
  const b = setup([ok(at(+9))]);
  await assert.rejects(() => b.prices.quote('BTC/USD', { quotedAfter: lock + 10 }), /too old/);
});

test('quotedAfter: asking again is still limited to once per 15 seconds (rate limit stays safe)', async () => {
  const { prices, calls, advance } = setup([ok(at(-40)), ok(at(+20))]);
  await assert.rejects(() => prices.quote('BTC/USD', { quotedAfter: NOW / 1000 }), /too old/);
  advance(5);
  await assert.rejects(() => prices.quote('BTC/USD', { quotedAfter: NOW / 1000 }), /too old/);
  assert.equal(calls.length, 1); // 5 seconds later it did NOT ask CoinGecko again
});

test('without quotedAfter an older quote is fine, and the quote time is reported', async () => {
  const { prices } = setup([ok(at(-100))]);
  const q = await prices.quote('BTC/USD');
  assert.equal(q.quotedAt, NOW / 1000 - 100);
  assert.equal(q.price, 8052200000000n);
});
