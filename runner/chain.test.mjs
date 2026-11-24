// node --test runner/chain.test.mjs
// The remembered feed history (runner/chain.mjs, createFeedHistory; audit part 2, P2-15): a read that fails half-way never
// leaves a gap behind, the planner does not settle from an incomplete history, and a refused settle makes the feed be read again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeedHistory, isRevert } from './chain.mjs';
import { planTick } from './plan.mjs';
import { CFG } from './config.mjs';
import { wrongSettleIds } from './retry.mjs';

const P1 = 1n << 64n;
const FEED = '0xfeed';

/** A pretend relay: updates[i] has id P1|(i+1); `failOn` is a set of ids whose getRoundData read fails once (a node problem). */
function fakeFeed(times, { failOn = new Set(), revertLatest = false } = {}) {
  const f = { times: [...times], failOn, reads: 0 };
  f.read = async (feed, fn, args = []) => {
    assert.equal(feed, FEED);
    f.reads++;
    const n = f.times.length;
    if (fn === 'latestRoundData') {
      if (revertLatest || n === 0) throw Object.assign(new Error('No data present'), { name: 'ContractFunctionRevertedError' });
      return [P1 | BigInt(n), BigInt(1000 + n), 0n, BigInt(f.times[n - 1]), P1 | BigInt(n)];
    }
    const id = args[0];
    if (f.failOn.has(id)) { f.failOn.delete(id); throw new Error('HTTP request failed: timeout'); }
    const i = Number(id & 0xffffffffffffffffn);
    if (i < 1 || i > n) throw Object.assign(new Error('No data present'), { name: 'ContractFunctionRevertedError' });
    return [id, BigInt(1000 + i), 0n, BigInt(f.times[i - 1]), id];
  };
  return f;
}

const ids = (list) => list.map((u) => Number(u.id & 0xffffffffffffffffn));

test('a full walk: every update back to the first one older than needed, complete', async () => {
  const f = fakeFeed([100, 200, 300, 400, 500]);
  const h = createFeedHistory(f.read);
  const r = await h.history(FEED, 250);
  assert.deepEqual(ids(r.updates), [2, 3, 4, 5], 'from the newest update older than 250 (the contract looks one back too)');
  assert.equal(r.complete, true);
});

test('a read that fails half-way saves nothing and says incomplete; the next pass reads it all and is complete', async () => {
  const f = fakeFeed([100, 200, 300, 400, 500], { failOn: new Set([P1 | 3n]) });
  const h = createFeedHistory(f.read);
  const first = await h.history(FEED, 150);
  assert.equal(first.complete, false);
  assert.deepEqual(ids(first.updates), [4, 5], 'the part read so far is still shown (for the price timing), but not saved');
  const second = await h.history(FEED, 150);
  assert.equal(second.complete, true);
  assert.deepEqual(ids(second.updates), [1, 2, 3, 4, 5], 'no gap: update 3 was read again');
});

test('the old bug: a gap is never remembered, even when new updates arrive after the failure', async () => {
  const f = fakeFeed([100, 200, 300], { failOn: new Set([P1 | 2n]) });
  const h = createFeedHistory(f.read);
  assert.equal((await h.history(FEED, 50)).complete, false);
  f.times.push(400, 500);
  const r = await h.history(FEED, 50);
  assert.deepEqual(ids(r.updates), [1, 2, 3, 4, 5]);
  assert.equal(r.complete, true);
});

test('when the node does not answer the latest read, the remembered list is kept and marked incomplete', async () => {
  const f = fakeFeed([100, 200]);
  let nodeDown = false;
  const h = createFeedHistory(async (...a) => { if (nodeDown) throw new Error('fetch failed'); return f.read(...a); });
  const good = await h.history(FEED, 50);
  nodeDown = true;
  const r = await h.history(FEED, 50);
  assert.deepEqual(ids(r.updates), ids(good.updates), 'what was remembered is kept');
  assert.equal(r.complete, false, 'but not settled from while the node is down');
  const fresh = createFeedHistory(async () => { throw new Error('fetch failed'); });
  assert.deepEqual(await fresh.history(FEED, 50), { updates: [], complete: false }, 'nothing remembered and no answer: not "no price"');
});

test('a feed with no price at all (latest reverts) is an empty, complete history', async () => {
  const f = fakeFeed([], {});
  const r = await createFeedHistory(f.read).history(FEED, 50);
  assert.deepEqual(r, { updates: [], complete: true });
});

test('a walk cut off by the read limit is backfilled on later passes until it reaches back far enough', async () => {
  const times = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
  const f = fakeFeed(times);
  const h = createFeedHistory(f.read, { maxReadsPerPass: 5 });
  const a = await h.history(FEED, 5);
  assert.equal(a.complete, false);
  let r = a;
  for (let i = 0; i < 5 && !r.complete; i++) r = await h.history(FEED, 5);
  assert.equal(r.complete, true);
  assert.deepEqual(ids(r.updates), times.map((_, i) => i + 1));
});

test('forget() makes the next pass read the feed again from scratch', async () => {
  const f = fakeFeed([100, 200, 300]);
  const h = createFeedHistory(f.read);
  await h.history(FEED, 50);
  const before = f.reads;
  await h.history(FEED, 50);
  assert.equal(f.reads - before, 1, 'normally only the latest is read');
  h.forget(FEED);
  const again = f.reads;
  await h.history(FEED, 50);
  assert.ok(f.reads - again > 1, 'after forget the whole history is read');
});

test('isRevert: a contract revert is told apart from a node problem (viem errors and plain ones)', () => {
  assert.equal(isRevert(Object.assign(new Error('x'), { name: 'ContractFunctionRevertedError' })), true);
  assert.equal(isRevert({ walk: (fn) => [{ name: 'ContractFunctionExecutionError' }, { name: 'ContractFunctionRevertedError' }].find(fn) }), true);
  assert.equal(isRevert(new Error('fetch failed')), false);
  assert.equal(isRevert(null), false);
});

// ---------------------------------------------------------------- the planner

function snapWith(complete, round) {
  const m = { id: 0, name: 'BTC/USD 5m', roundLength: 300, startOffset: 0, minStake: 500_000, paused: false, nextRound: 12,
    feed: { address: FEED, updates: [{ id: P1 | 1n, updatedAt: 10 * 300 + 3, price: 1n }, { id: P1 | 2n, updatedAt: 11 * 300 - 50, price: 2n }], complete },
    rounds: { 10: round } };
  return { now: 11 * 300 + 5, markets: [m], agents: [] };
}

test('the planner settles a two-sided round only from a complete history', () => {
  const two = { state: 'Unsettled', up: 1_000_000, down: 1_000_000 };
  const settles = (c) => planTick(snapWith(c, two), { ...CFG, runnerOnly: true }).actions.filter((a) => a.type === 'settle');
  assert.equal(settles(false).length, 0, 'incomplete: wait');
  const ok = settles(true);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].feed, FEED, 'the settle says which feed it used, so a refusal can make it be read again');
  assert.equal(ok[0].startId, P1 | 1n);
  assert.equal(settles(undefined).length, 1, 'the simulation (no flag) settles as before');
});

test('a one-sided round is still settled (with ids 0) from an incomplete history: it needs no price', () => {
  const one = { state: 'Unsettled', up: 1_000_000, down: 0 };
  const s = planTick(snapWith(false, one), { ...CFG, runnerOnly: true }).actions.filter((a) => a.type === 'settle');
  assert.equal(s.length, 1);
  assert.equal(s[0].startId, 0n);
});

test('wrongSettleIds: the contract refusing a start or end id is recognised, other failures are not', () => {
  assert.equal(wrongSettleIds({ shortMessage: 'The contract function "settle" reverted.', message: 'Error: InvalidStartRound(uint80 id)\n (18446744073709551617)' }), true);
  assert.equal(wrongSettleIds(new Error('reverted with InvalidEndRound(uint80)')), true);
  assert.equal(wrongSettleIds(new Error('SettleWindowClosed')), false);
  assert.equal(wrongSettleIds(new Error('fetch failed')), false);
});
