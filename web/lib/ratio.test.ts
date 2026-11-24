// Tests for the coin-vs-coin maths.  Run:  node --test lib/ratio.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { formatRatio, ratioCandles, ratioOf } from "./ratio.ts";

test("ratioOf rounds like the chain: 8-decimal prices, 18-decimal ratio, rounded down", () => {
  assert.equal(ratioOf(3000, 100000), 0.03);
  assert.equal(ratioOf(150, 100000), 0.0015);
  // the hand-checked numbers of contracts/test/RatioGuard.t.sol: 331287654321 * 1e18 / 9765412345678 = 33924594537743416
  assert.equal(ratioOf(3312.87654321, 97654.12345678), 33924594537743416 / 1e18);
  assert.equal(ratioOf(1, 3), 333333333333333333 / 1e18);
  assert.equal(ratioOf(0, 3), null);
  assert.equal(ratioOf(3, -1), null);
});

test("both coins up by the same % give exactly the same ratio (a refund on the chain)", () => {
  assert.equal(ratioOf(3060, 102000), ratioOf(3000, 100000));
});

test("ratio candles: exact open and close, no invented wicks, only minutes both coins traded", () => {
  const top = [
    { t: 60_000, open: 3000, close: 3030, high: 3050, low: 2990 },
    { t: 120_000, open: 3030, close: 3000, high: 3040, low: 2980 },
    { t: 180_000, open: 3000, close: 3000, high: 3000, low: 3000 },
  ];
  const bottom = [
    { t: 60_000, open: 100000, close: 100000, high: 100100, low: 99900 },
    { t: 120_000, open: 100000, close: 101000, high: 101500, low: 99000 },
  ];
  const r = ratioCandles(top, bottom);
  assert.ok(r);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { t: 60_000, open: 0.03, close: 0.0303, high: 0.0303, low: 0.03 });
  assert.equal(r[1].high, r[1].open);
  assert.equal(r[1].low, r[1].close);
  assert.equal(ratioCandles(null, bottom), null);
  assert.equal(ratioCandles(top, []), null);
});

test("a ratio is written with 5 significant digits and its unit", () => {
  assert.equal(formatRatio(0.0339245945, "BTC"), "0.033925 BTC");
  assert.equal(formatRatio(0.0015, "BTC"), "0.0015 BTC");
});
