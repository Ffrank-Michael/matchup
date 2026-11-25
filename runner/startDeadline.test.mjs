// node --test runner/startDeadline.test.mjs
// How long the runner keeps asking for a START price (plan.mjs, startDeadline). The BTC and ETH start price is the median of a
// 60 s / 90 s window that opens 2 s after the lock, so it can only be read once that window has closed. The old rule (give up
// at 25% of the round) gave BTC 5m 11 s to spare and ETH 5m none at all (its window closes at 94 s, the rule stopped at 75 s),
// so every two-sided ETH 5m round refunded. Now: startGiveUp of the round or startMargin (30 s) after the price can be read,
// whichever is later, and never once the end price window has opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from './config.mjs';
import { priceDue, startDeadline, startReadyAfter, endWindowOpensAfter } from './plan.mjs';
import { createExchangePrices, WINDOWS, WINDOW_SETTLE_SEC } from './exchangePrices.mjs';

const cfg = { ...CFG, matchedOnly: true, runnerOnly: true };
const K = 11; // the market's next round; round K-1 is running

/** A market whose round K-1 has calls on both sides and no price since its lock. */
function market(name, roundLength, updates = [{ id: 1n, answer: 1n, updatedAt: 0 }]) {
  return { id: 0, name, roundLength, startOffset: 0, minStake: 1, paused: false, nextRound: K, feed: { updates }, rounds: { [K - 1]: { state: 'Unsettled', up: 1, down: 1 } } };
}
const lockOf = (m) => m.startOffset + (K - 1) * m.roundLength;

// [market, earliest second after the lock the start price can be read, last second after the lock the runner still asks]
const CASES = [
  ['BTC/USD 5m', 300, 64, 93],     // window 2-62 s, +2 s for Bitfinex's history; asks until 64 + 30 (was 75: 11 s to spare)
  ['ETH/USD 5m', 300, 94, 123],    // window 2-92 s; asks until 94 + 30 (was 75: never)
  ['ETH/USD 10m', 600, 94, 149],   // 25% of 600 s is later than 94 + 30
  ['SOL/USD 5m', 300, 2, 74],      // a single trade: readable at once; 25% of 300 s
  ['BTC/USD 1h', 3600, 64, 899],   // 25% of an hour
  ['ETH/USD 1h', 3600, 94, 899],
  ['SOL/USD 1h', 3600, 2, 899],
  ['ETH/BTC 1h', 3600, 94, 899],   // coin vs coin waits for its slower coin (ETH's 90 s window)
  ['SOL/BTC 1h', 3600, 64, 899],
];

for (const [name, len, ready, lastAsk] of CASES) {
  test(`${name}: start price readable from lock + ${ready} s, asked for until lock + ${lastAsk} s`, () => {
    const m = market(name, len);
    assert.equal(startReadyAfter(m, cfg), ready, 'earliest second the start price can be read');
    assert.equal(startDeadline(m, cfg) - 1, lastAsk, 'last second the runner still asks');
    const lock = lockOf(m);
    assert.equal(priceDue(m, lock + CFG.startAfter - 1, cfg), null, 'not before lock + startAfter');
    assert.equal(priceDue(m, lock + ready, cfg), 'start', 'asked when it can first be read');
    assert.equal(priceDue(m, lock + lastAsk, cfg), 'start', 'still asked at the last second');
    assert.equal(priceDue(m, lock + lastAsk + 1, cfg), null, 'then left to refund');
    assert.ok(lastAsk + 1 - ready >= CFG.startMargin, `at least ${CFG.startMargin} s to read and push it`);
  });
}

test('for every coin and round length the start never runs into the end price window or the last 20 seconds', () => {
  for (const pair of ['BTC/USD', 'ETH/USD', 'SOL/USD', 'ETH/BTC', 'SOL/BTC']) {
    for (const len of [300, 600, 1800, 3600]) {
      const m = market(`${pair} x`, len);
      const deadline = startDeadline(m, cfg);
      assert.ok(deadline - startReadyAfter(m, cfg) >= CFG.startMargin, `${pair} ${len}: a full margin after it can be read`);
      assert.ok(deadline <= endWindowOpensAfter(m, cfg), `${pair} ${len}: stops before the end window opens`);
      assert.ok(deadline < len - CFG.endMargin, `${pair} ${len}: stops before the end price is taken`);
      assert.ok(deadline < len - CFG.endCutoff, `${pair} ${len}: nowhere near the last 20 seconds`);
      // walking the whole round: 'start' and 'end' never overlap, and with no start price there is never an end price
      const lock = lockOf(m);
      for (let t = 0; t < len; t++) assert.notEqual(priceDue(m, lock + t, cfg), 'end', `${pair} ${len} at ${t}`);
    }
  }
});

test('ETH 5m: once the start is in, the end price is still asked for in its own window', () => {
  const m = market('ETH/USD 5m', 300);
  const lock = lockOf(m);
  m.feed.updates.push({ id: 2n, answer: 2n, updatedAt: lock + 120 }); // a start pushed late, at lock + 120 s
  assert.equal(priceDue(m, lock + 121, cfg), null);
  assert.equal(priceDue(m, lock + 300 - CFG.endMargin, cfg), 'end');
  assert.equal(priceDue(m, lock + 300 - CFG.endCutoff - 1, cfg), 'end');
  assert.equal(priceDue(m, lock + 300 - CFG.endCutoff, cfg), null);
});

// The "earliest second" above is the real one: the price module refuses a window before it has closed plus WINDOW_SETTLE_SEC.
function fakeBitfinex(trades) {
  return async (url) => {
    const q = new URL(url).searchParams;
    const from = Number(q.get('start')), to = Number(q.get('end'));
    const list = trades.map(([sec, price], i) => [i + 1, sec * 1000, 0.01, price]).filter((t) => t[1] >= from && t[1] <= to);
    return { ok: true, status: 200, json: async () => list, headers: new Headers() };
  };
}

for (const pair of ['BTC/USD', 'ETH/USD']) {
  test(`${pair}: the price module first gives a start price at the second startReadyAfter says`, async () => {
    const LOCK = 1_800_000_000;
    const w = WINDOWS[pair].seconds;
    const trades = [5, 20, 40, w - 5].map((s) => [LOCK + CFG.startAfter + s, 100 + s]);
    const ready = startReadyAfter(market(`${pair} 5m`, 300), cfg);
    assert.equal(ready, CFG.startAfter + w + WINDOW_SETTLE_SEC);
    const at = (sec) => createExchangePrices({ fetchFn: fakeBitfinex(trades), nowMs: () => (LOCK + sec) * 1000 }).quote(pair, { firstTradeAfter: LOCK + CFG.startAfter });
    await assert.rejects(at(ready - 1), /not over yet/);
    const q = await at(ready);
    assert.equal(q.method, 'median');
  });
}
