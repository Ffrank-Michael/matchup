// Run with:  node --test onchain/payout.test.ts   (from web/; Node 22.18 or newer runs TypeScript files directly)
// Every number is worked out by hand from docs/MATCHED_CALLS.md.
import assert from "node:assert/strict";
import test from "node:test";

import { estimatePayout, matchedPart, settledPayout, settledSplit } from "./payout.ts";

const usdc = (n: number) => BigInt(Math.round(n * 1_000_000));

test("nobody on the other side: the stake comes back, no fee", () => {
  assert.deepEqual(estimatePayout("UP", usdc(1), usdc(5), 0n), { kind: "refund", payout: usdc(1) });
  assert.deepEqual(estimatePayout("DOWN", usdc(2), 0n, 0n), { kind: "refund", payout: usdc(2) });
});

test("worked example: UP 10 against DOWN 6 -> matched 6, win +5.88, 4 comes back", () => {
  // An UP call of 10 on an empty UP side, DOWN already 6. M = 6, fee = 0.12, bonus = 5.88.
  const r = estimatePayout("UP", usdc(10), 0n, usdc(6));
  assert.deepEqual(r, { kind: "win", payout: usdc(15.88), matched: usdc(6), unmatched: usdc(4), bonus: usdc(5.88), lose: usdc(6) });
});

test("the smaller side is fully matched: DOWN 6 against UP 10 wins +5.88 and nothing comes back", () => {
  const r = estimatePayout("DOWN", usdc(6), usdc(10), 0n);
  assert.deepEqual(r, { kind: "win", payout: usdc(11.88), matched: usdc(6), unmatched: 0n, bonus: usdc(5.88), lose: usdc(6) });
});

test("a tie matches everybody in full; the fee is 2% of the matched pool", () => {
  // UP 5 (mine) against DOWN 5: M = 5, fee 0.10, bonus 4.90.
  const r = estimatePayout("UP", usdc(5), 0n, usdc(5));
  assert.equal(r.kind, "win");
  assert.equal(r.kind === "win" && r.bonus, usdc(4.9));
});

test("the bigger side rounds down when it wins and up when it loses (the contract's rule)", () => {
  // UP 400_010 + 300_010 + 300_010 = 1_000_030 against DOWN 1_000_000.
  assert.equal(matchedPart(400_010n, 1_000_030n, 1_000_000n, true), 399_998n); // floor
  assert.equal(matchedPart(400_010n, 1_000_030n, 1_000_000n, false), 399_999n); // ceil
  assert.equal(matchedPart(300_010n, 1_000_030n, 1_000_000n, true), 300_000n);
  assert.equal(matchedPart(300_010n, 1_000_030n, 1_000_000n, false), 300_001n);
  assert.equal(matchedPart(1_000_000n, 1_000_000n, 1_000_030n, true), 1_000_000n); // smaller side
});

test("a settled round: winners get stake + matched share, losers get the unmatched part back", () => {
  // UP 10 (one caller) against DOWN 6.
  assert.equal(settledPayout(usdc(10), usdc(10), usdc(6), true), usdc(15.88)); // UP wins
  assert.equal(settledPayout(usdc(10), usdc(10), usdc(6), false), usdc(4)); // UP loses: only the unmatched 4 comes back
  assert.equal(settledPayout(usdc(6), usdc(6), usdc(10), true), usdc(11.88)); // DOWN wins
  assert.equal(settledPayout(usdc(6), usdc(6), usdc(10), false), 0n); // DOWN loses: fully matched, nothing back
  // The hand-computed rounding case from the contract tests: a loses with 400_010 of 1_000_030 -> unmatched 11.
  assert.equal(settledPayout(400_010n, 1_000_030n, 1_000_000n, false), 11n);
  assert.equal(settledPayout(400_010n, 1_000_030n, 1_000_000n, true), 792_008n);
  assert.equal(settledSplit(400_010n, 1_000_030n, 1_000_000n, true).unmatched, 12n);
});

test("the estimate never pays out more than the money in the round", () => {
  for (const [up, down, stake] of [[1, 3, 0.5], [0.1, 9, 10], [4, 4, 4]] as const) {
    const r = estimatePayout("UP", usdc(stake), usdc(up), usdc(down));
    assert.ok(r.payout <= usdc(up) + usdc(down) + usdc(stake));
  }
});
