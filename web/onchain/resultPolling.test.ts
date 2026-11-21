// Tests for how often the round states are read.  Run:  node --test onchain/resultPolling.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { roundsPollMs, setWaitingEnds, NORMAL_POLL_MS, WAITING_POLL_MS } from "./resultPolling.ts";

test("reads every 5 s when nothing of the wallet is waiting", () => {
  assert.equal(roundsPollMs([], 1_000), NORMAL_POLL_MS);
  assert.equal(roundsPollMs([2_000], 1_000), NORMAL_POLL_MS); // ends much later
});

test("reads every 2 s from 5 s before a round ends until 5 minutes after", () => {
  assert.equal(roundsPollMs([1_000], 994), NORMAL_POLL_MS);
  assert.equal(roundsPollMs([1_000], 995), WAITING_POLL_MS);
  assert.equal(roundsPollMs([1_000], 1_001), WAITING_POLL_MS);
  assert.equal(roundsPollMs([1_000], 1_299), WAITING_POLL_MS);
  assert.equal(roundsPollMs([1_000], 1_300), NORMAL_POLL_MS); // no result after 5 minutes: back to normal
  assert.equal(roundsPollMs([500, 1_000], 1_000), WAITING_POLL_MS); // any one waiting round is enough
});

test("uses the end times recorded by the positions read", () => {
  const now = Date.now() / 1000;
  setWaitingEnds([now - 10]);
  assert.equal(roundsPollMs(), WAITING_POLL_MS);
  setWaitingEnds([]);
  assert.equal(roundsPollMs(), NORMAL_POLL_MS);
});
