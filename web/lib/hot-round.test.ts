// Tests for the hot round (calls waiting on one side only).  Run:  node --test lib/hot-round.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { isHot, waitingSide } from "./hot-round.ts";

type State = "open" | "locked" | "unsettled" | "up" | "down" | "refunded";
const round = (state: State, up: bigint, down: bigint) => ({ state, upTotal: up, downTotal: down, lockTimeSec: 1_000 });

test("calls on UP only while calling is open: hot, waiting on UP, needs DOWN", () => {
  assert.deepEqual(waitingSide(round("open", 2_000_000n, 0n), 900), { side: "UP", amount: 2_000_000n, needs: "DOWN" });
  assert.equal(isHot(round("open", 2_000_000n, 0n), 900), true);
});

test("calls on DOWN only while calling is open: hot, waiting on DOWN, needs UP", () => {
  assert.deepEqual(waitingSide(round("open", 0n, 750_000n), 999), { side: "DOWN", amount: 750_000n, needs: "UP" });
});

test("not hot: calls on both sides, or no calls at all", () => {
  assert.equal(isHot(round("open", 2_000_000n, 1n), 900), false);
  assert.equal(isHot(round("open", 0n, 0n), 900), false);
});

test("not hot once calling has closed, by the contract's state or by the page's clock", () => {
  assert.equal(isHot(round("open", 2_000_000n, 0n), 1_000), false); // the clock reached the lock
  for (const s of ["locked", "unsettled", "up", "down", "refunded"] as const) assert.equal(isHot(round(s, 2_000_000n, 0n), 900), false, s);
});

test("not hot before the clock or the round is known", () => {
  assert.equal(isHot(round("open", 2_000_000n, 0n), null), false);
  assert.equal(isHot(undefined, 900), false);
  assert.equal(isHot(null, 900), false);
});

test("the round card shows the flame from waitingSide, for the round that takes calls now", () => {
  const card = fs.readFileSync(path.resolve(import.meta.dirname, "..", "components", "kairo", "market-card.tsx"), "utf8");
  assert.match(card, /data-testid="hot-flame"/);
  const home = fs.readFileSync(path.resolve(import.meta.dirname, "..", "components", "kairo", "kairo-home.tsx"), "utf8");
  assert.match(home, /waitingSide\(/);
});
