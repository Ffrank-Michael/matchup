// Tests for the one-sided round note.  Run:  node --test lib/one-sided.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { oneSidedNote, oneSidedText, WAITING_TEXT, NOBODY_JOINED_TEXT } from "./one-sided.ts";

const round = (state: "open" | "locked" | "unsettled" | "up" | "down" | "refunded", up: bigint, down: bigint) => ({
  state,
  upTotal: up,
  downTotal: down,
  lockTimeSec: 1_000,
});

test("money on one side while calling is open: waiting for the other side", () => {
  assert.equal(oneSidedNote(round("open", 500_000n, 0n), 900), WAITING_TEXT);
  assert.equal(oneSidedNote(round("open", 0n, 500_000n), 900), WAITING_TEXT);
  assert.equal(oneSidedNote(round("open", 500_000n, 0n), null), WAITING_TEXT);
});

test("money on one side after calling closes: a refund, nobody can join any more", () => {
  assert.equal(oneSidedNote(round("locked", 500_000n, 0n), 1_100), NOBODY_JOINED_TEXT);
  assert.equal(oneSidedNote(round("unsettled", 0n, 500_000n), 1_700), NOBODY_JOINED_TEXT);
  // the page's clock has passed the lock before the next read of the round
  assert.equal(oneSidedNote(round("open", 500_000n, 0n), 1_000), NOBODY_JOINED_TEXT);
});

test("no note for calls on both sides, no calls, or a round with its result", () => {
  assert.equal(oneSidedNote(round("open", 500_000n, 200_000n), 900), null);
  assert.equal(oneSidedNote(round("open", 0n, 0n), 900), null);
  assert.equal(oneSidedNote(round("refunded", 500_000n, 0n), 2_000), null);
  assert.equal(oneSidedNote(round("up", 500_000n, 0n), 2_000), null);
});

test("the words use the site's plain language", () => {
  assert.equal(oneSidedText(false), WAITING_TEXT);
  assert.equal(oneSidedText(true), NOBODY_JOINED_TEXT);
  for (const t of [WAITING_TEXT, NOBODY_JOINED_TEXT]) assert.doesNotMatch(t, /\b(bet|wager|odds)\b/i);
});
