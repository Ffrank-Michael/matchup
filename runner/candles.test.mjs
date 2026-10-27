// node --test runner/candles.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandles } from './candles.mjs';

const NOW = Date.parse('2026-10-26T12:30:30Z');
// newest first, like Bitfinex: [time_ms, open, close, high, low, volume]
const makeAnswer = (n, endMs = NOW) => Array.from({ length: n }, (_, i) => {
  const t = Math.floor(endMs / 60_000) * 60_000 - i * 60_000;
  return [t, 100 + i, 101 + i, 102, 99, 1];
});
const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const setup = (answer, opts = {}) => {
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return typeof answer === 'function' ? answer() : answer; };
  return { candles: createCandles({ fetchFn, nowMs: () => NOW, ...opts }), calls };
};

test('asks for the right coin and gives 120 finished candles, oldest first, without the running minute', async () => {
  const { candles, calls } = setup(ok(makeAnswer(124)));
  const got = await candles.get('BTC/USD');
  assert.equal(calls[0], 'https://api-pub.bitfinex.com/v2/candles/trade:1m:tBTCUSD/hist?limit=124');
  assert.equal(got.length, 120);
  assert.ok(got.every((c, i) => i === 0 || c.time === got[i - 1].time + 60));
  // the minute 12:30 is still running at 12:30:30, so the newest finished one is 12:29
  assert.equal(got[got.length - 1].time, Date.parse('2026-10-26T12:29:00Z') / 1000);
  assert.deepEqual(Object.keys(got[0]), ['time', 'open', 'close', 'high', 'low']);
});

test('an answer is reused for 30 seconds', async () => {
  const { candles, calls } = setup(ok(makeAnswer(24)));
  await candles.get('ETH/USD');
  await candles.get('ETH/USD');
  assert.equal(calls.length, 1);
});

test('a failing answer throws, and getAll leaves that coin out instead of making numbers up', async () => {
  const { candles } = setup({ ok: false, status: 429, json: async () => [] });
  await assert.rejects(() => candles.get('BTC/USD'), /HTTP 429/);
  assert.deepEqual(await candles.getAll(['BTC/USD', 'ETH/USD']), {});
  const bad = setup(ok(['error', 10020, 'bad']));
  await assert.rejects(() => bad.candles.get('SOL/USD'), /no usable candles/);
  await assert.rejects(() => bad.candles.get('DOGE/USD'), /no candle source/);
});

test('force skips the saved answer', async () => {
  const { candles, calls } = setup(ok(makeAnswer(24)));
  await candles.get('ETH/USD');
  await candles.get('ETH/USD', { force: true });
  assert.equal(calls.length, 2);
});
