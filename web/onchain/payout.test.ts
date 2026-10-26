// Run with:  node --test onchain/payout.test.ts   (from web/; Node 22.18 or newer runs TypeScript files directly)
import assert from "node:assert/strict";
import test from "node:test";

import { estimatePayout } from "./payout.ts";

const usdc = (n: number) => BigInt(Math.round(n * 1_000_000));

test("nobody on the other side: the stake comes back, no fee", () => {
  assert.deepEqual(estimatePayout("UP", usdc(1), usdc(5), 0n), { kind: "refund", payout: usdc(1) });
  assert.deepEqual(estimatePayout("DOWN", usdc(2), 0n, 0n), { kind: "refund", payout: usdc(2) });
});

test("the fee is 2% of the losing side only, and winners share the rest in proportion", () => {
  // 1 USDC joins UP, UP already has 1, DOWN has 2: UP pot is 2 with my stake, so I own half of it.
  // Losing side 2.00, fee 0.04, 1.96 shared: my half is 0.98, so I get my 1.00 back plus 0.98.
  const r = estimatePayout("UP", usdc(1), usdc(1), usdc(2));
  assert.equal(r.kind, "win");
  assert.equal(r.payout, usdc(1.98));
});

test("a big stake on a quiet side takes nearly all of the other side, less 2%", () => {
  const r = estimatePayout("DOWN", usdc(10), 0n + usdc(1), usdc(0.1));
  assert.equal(r.kind, "win");
  // I am about 99% of the DOWN pot: share = (1 - 0.02) * 10 / 10.1 = 0.9702 -> payout 10 + 0.970297...
  assert.ok(r.payout > usdc(10.97) && r.payout < usdc(10.98), String(r.payout));
});

test("the estimate never pays out more than the money in the round", () => {
  for (const [up, down, stake] of [[1, 3, 0.5], [0.1, 9, 10], [4, 4, 4]] as const) {
    const r = estimatePayout("UP", usdc(stake), usdc(up), usdc(down));
    assert.ok(r.payout <= usdc(up) + usdc(down) + usdc(stake));
  }
});
