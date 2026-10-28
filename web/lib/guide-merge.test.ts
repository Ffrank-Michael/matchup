// node --test lib/guide-merge.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { withGuideCalls } from "./guide-merge.ts";
import type { GuideCalls } from "./use-guide-calls.ts";

const guide: GuideCalls = {
  "trend-follower": {
    current: { c: "UP", t: "BTC rose 0.3%", at: 1000, s: "called", src: "ai" },
    recent: [{ r: 9, c: "DOWN", at: 700, res: "won" }, { r: 8, c: "UP", at: 400, res: "lost" }, { r: 7, c: "UP", at: 100, res: "none" }],
    wins: 1,
    decided: 2,
  },
  contrarian: { current: { c: null, t: "Couldn't decide this round", at: 1000, s: "skipped", src: "ai" }, recent: [], wins: 0, decided: 0 },
  "coin-flipper": { current: { c: "DOWN", t: "coin flip gave 0.20, so DOWN.", at: 1001, s: "called", src: "random" }, recent: [], wins: 0, decided: 0 },
};

test("a guide call fills the open round and is marked as a guide call; win rate and last five come from guide calls, with no profit", () => {
  const out = withGuideCalls({ "trend-follower": { winRate: 1, profit: 5, last5: ["won"] } }, guide);
  const tf = out["trend-follower"]!;
  assert.equal(tf.call, "UP");
  assert.equal(tf.guide, true);
  assert.equal(tf.callAt, 1000);
  assert.equal(tf.reason, "BTC rose 0.3%");
  assert.equal(tf.winRate, 0.5);
  assert.equal(tf.guideDecided, 2);
  assert.equal(tf.profit, undefined);
  assert.equal(tf.last5, undefined);
  assert.deepEqual(tf.guideRecent?.map((p) => p.res), ["won", "lost", "none"]);
});

test("a real on-chain call keeps its own call and transaction; it is not turned into a guide call", () => {
  const out = withGuideCalls({ "trend-follower": { call: "DOWN", callTx: "0xabc" } }, guide);
  const tf = out["trend-follower"]!;
  assert.equal(tf.call, "DOWN");
  assert.equal(tf.callTx, "0xabc");
  assert.equal(tf.guide, undefined);
});

test("a skipped round shows no call, and the random agent's reason is not an AI note", () => {
  const out = withGuideCalls({}, guide);
  assert.equal(out.contrarian?.call, undefined);
  assert.equal(out.contrarian?.skipped, true);
  assert.equal(out["coin-flipper"]?.call, "DOWN");
  assert.equal(out["coin-flipper"]?.ruleReason, true);
  assert.equal(out["chart-reader"], undefined);
});

test("with no guide data nothing changes", () => {
  const live = { "trend-follower": { winRate: 0.4 } };
  assert.equal(withGuideCalls(live, null), live);
});
