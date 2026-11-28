// Tests for the hot round (calls waiting on one side only).  Run:  node --test lib/hot-round.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { isHot, usdcPlain, waitingLine, waitingSide } from "./hot-round.ts";

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

// ── the waiting line under the flame ──

test("the waiting line names the side, the amount and the side that is needed", () => {
  assert.equal(waitingLine(waitingSide(round("open", 2_000_000n, 0n), 900)), "UP 2 USDC waiting. Needs DOWN.");
  assert.equal(waitingLine(waitingSide(round("open", 0n, 2_500_000n), 900)), "DOWN 2.50 USDC waiting. Needs UP.");
});

test("the waiting line is gone once both sides have calls or the calling window closes", () => {
  assert.equal(waitingLine(waitingSide(round("open", 2_000_000n, 500_000n), 900)), null);
  assert.equal(waitingLine(waitingSide(round("open", 2_000_000n, 0n), 1_000)), null);
  assert.equal(waitingLine(waitingSide(round("locked", 2_000_000n, 0n), 900)), null);
});

test("coin vs coin uses the market's own side names", () => {
  const words = { UP: "ETH wins", DOWN: "BTC wins" };
  assert.equal(waitingLine(waitingSide(round("open", 1_000_000n, 0n), 900), words), "1 USDC waiting on ETH wins. Needs BTC wins.");
});

test("amounts are the exact on-chain amount, never rounded up", () => {
  assert.equal(usdcPlain(2_000_000n), "2");
  assert.equal(usdcPlain(500_000n), "0.50");
  assert.equal(usdcPlain(1_239_999n), "1.23");
  assert.equal(usdcPlain(10_000_000n), "10");
  assert.equal(usdcPlain(4_000n), "0.004");
  assert.equal(usdcPlain(1n), "0.000001");
});

test("plain words: no em dashes, no bet, wager or odds", () => {
  const lines = [
    waitingLine(waitingSide(round("open", 2_000_000n, 0n), 900)),
    waitingLine(waitingSide(round("open", 0n, 2_000_000n), 900), { UP: "ETH wins", DOWN: "BTC wins" }),
  ];
  for (const l of lines) {
    assert.ok(l);
    assert.doesNotMatch(l, /—/);
    assert.doesNotMatch(l, /\b(bet|wager|odds)\b/i);
  }
});

test("the round card shows the waiting line under the flame", () => {
  const card = fs.readFileSync(path.resolve(import.meta.dirname, "..", "components", "kairo", "market-card.tsx"), "utf8");
  assert.match(card, /data-testid="hot-line"/);
  assert.match(card, /waitingLine\(waiting, market\.sides\)/);
});
