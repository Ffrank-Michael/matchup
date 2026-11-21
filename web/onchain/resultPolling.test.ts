// Tests for how often the round states are read.  Run:  node --test onchain/resultPolling.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { roundsPollMs, roundsRefetchInterval, setWaitingEnds, NORMAL_POLL_MS, WAITING_POLL_MS } from "./resultPolling.ts";

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

test("the refetch callback uses the end times recorded by the positions read, in the browser", () => {
  const g = globalThis as { window?: unknown };
  g.window = {}; // as in the browser
  try {
    setWaitingEnds([Date.now() / 1000 - 10]);
    assert.equal(roundsRefetchInterval(), WAITING_POLL_MS);
    setWaitingEnds([]);
    assert.equal(roundsRefetchInterval(), NORMAL_POLL_MS);
  } finally {
    delete g.window;
  }
});

test("on the server (prerender) the refetch callback reads no clock and answers the normal interval", () => {
  setWaitingEnds([Date.now() / 1000 - 10]); // would be fast in the browser
  const realNow = Date.now;
  Date.now = () => { throw new Error("Date.now() read on the server"); };
  try {
    assert.equal(roundsRefetchInterval(), NORMAL_POLL_MS);
  } finally {
    Date.now = realNow;
    setWaitingEnds([]);
  }
});
