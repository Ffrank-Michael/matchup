// Tests for the round runner's brain (no blockchain, no wallets).  Run:  node --test runner/runner.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { CFG } from './config.mjs';
import { planTick, lockTime, endTime } from './plan.mjs';
import { findSettleIds } from './settleIds.mjs';
import { createWalk } from './priceWalk.mjs';
import { simulate, mulberry32 } from './simulate.mjs';

const KEYS = ['trend-follower', 'contrarian', 'streak-hunter', 'coin-flipper'];
const id = (n) => (1n << 64n) | BigInt(n);
const upd = (n, updatedAt, usd) => ({ id: id(n), updatedAt, price: BigInt(Math.round(usd * 1e8)) });
const nextAt = (now) => Math.floor(now / 3600) + 1; // the contract's rule for a market with offset 0 and 1-hour rounds

// BTC-like market: offset 0, 1-hour rounds. Round k locks at 3600*k and ends at 3600*(k+1).
// Feed: round 8 went UP (100 -> 101), round 9 went UP (101 -> 102), so "last finished round" is UP.
const FEED = [
  upd(1, 28810, 100), upd(2, 32390, 101), // round 8 (28800..32400): start 100, end 101
  upd(3, 32410, 101), upd(4, 35990, 102), // round 9 (32400..36000): start 101, end 102
];
const market = (now, over = {}) => ({
  id: 0, name: 'BTC/USD', roundLength: 3600, startOffset: 0, minStake: 100_000, paused: false,
  nextRound: nextAt(now), feed: { updates: FEED }, rounds: {}, ...over,
});
const agent = (key, over = {}) => ({ key, balance: 5_000_000, allowance: 10_000_000, positions: {}, ...over });
const agents = (over = {}) => KEYS.map((k) => agent(k, over[k] || {}));
const snap = (now, m = market(now), a = agents()) => ({ now, markets: [m], agents: a });
const cfg = (over = {}) => ({ ...CFG, random: mulberry32(7), ...over });
const bets = (r) => r.actions.filter((a) => a.type === 'bet');
const kinds = (r) => r.actions.map((a) => a.type);

// ---------------------------------------------------------------- betting order and timing
// Round 11 can be bet on from lock(10) = 36000 until lock(11) = 39600.

test('early agents wait a minute after the round opens, then bet in order: trend follower, streak hunter, coin flipper', () => {
  assert.deepEqual(bets(planTick(snap(36059), cfg())), []);
  const r = planTick(snap(36060), cfg());
  assert.deepEqual(bets(r).map((b) => b.agent), ['trend-follower', 'streak-hunter', 'coin-flipper']);
  assert.ok(bets(r).every((b) => b.round === 11 && b.market === 0));
});

test('the early agents use the real price history (last finished round was UP, so the trend follower bets UP)', () => {
  const b = bets(planTick(snap(36060), cfg())).find((x) => x.agent === 'trend-follower');
  assert.equal(b.side, 'UP');
  assert.equal(b.stake, 500_000);
  assert.match(b.reason, /101\.00 -> 102\.00/);
});

test('the history comes from the feed, so rounds nobody bet on still count', () => {
  const down = [upd(1, 32410, 102), upd(2, 35990, 100)]; // round 9: 102 -> 100
  const r = planTick(snap(36060, market(36060, { feed: { updates: down } })), cfg());
  assert.equal(bets(r).find((x) => x.agent === 'trend-follower').side, 'DOWN');
});

test('the round that is still running is not part of the history (only finished rounds are)', () => {
  // round 10 is running (36000..39600): started at 90, already down at 80. Round 9 (the last finished one) went UP.
  const f = [...FEED, upd(5, 36003, 90), upd(6, 37000, 80)];
  const r = planTick(snap(37100, market(37100, { feed: { updates: f } })), cfg());
  assert.equal(r.actions.length > 0 || r.decisions.length > 0, true);
  assert.equal(bets(r).find((x) => x.agent === 'trend-follower').side, 'UP');
});

test('no early bets in the last minute before lock', () => {
  assert.equal(bets(planTick(snap(39540 - 1), cfg())).length, 3);
  assert.equal(bets(planTick(snap(39540), cfg())).length, 0);
});

test('the contrarian bets about 5 minutes before lock, and only after the early agents are done', () => {
  const done = new Set(['0:11:trend-follower', '0:11:streak-hunter', '0:11:coin-flipper']);
  const m = (now) => market(now, { rounds: { 11: { state: 'Unsettled', up: 800_000, down: 200_000, startPrice: 0n, endPrice: 0n } } });
  assert.deepEqual(bets(planTick(snap(39299, m(39299)), cfg(), done)), []);
  const r = planTick(snap(39300, m(39300)), cfg(), done);
  assert.deepEqual(bets(r).map((b) => [b.agent, b.side]), [['contrarian', 'DOWN']]);
  assert.match(bets(r)[0].reason, /\$0\.80 is on UP and \$0\.20 on DOWN \(80% on UP\)/);
  // not in the last 30 seconds
  assert.deepEqual(bets(planTick(snap(39570, m(39570)), cfg(), done)), []);
  // an early agent that has not finished holds the contrarian back
  const notDone = new Set(['0:11:trend-follower', '0:11:streak-hunter']);
  assert.deepEqual(bets(planTick(snap(39300, m(39300)), cfg(), notDone)).map((b) => b.agent).filter((a) => a === 'contrarian'), []);
});

test('the contrarian skips when nobody has bet (and says so)', () => {
  const done = new Set(['0:11:trend-follower', '0:11:streak-hunter', '0:11:coin-flipper']);
  const r = planTick(snap(39300), cfg(), done);
  assert.deepEqual(bets(r), []);
  const d = r.decisions.find((x) => x.agent === 'contrarian');
  assert.equal(d.decision.action, 'SKIP');
});

test('an agent decides once per round: decided ids are not decided again', () => {
  const r1 = planTick(snap(36060), cfg());
  const decided = new Set(r1.decisions.map((d) => d.id));
  assert.equal(decided.size, 3);
  assert.deepEqual(planTick(snap(36070), cfg(), decided).decisions, []);
});

test('one side per round: an agent that already has a position never bets again', () => {
  const a = agents({ 'trend-follower': { positions: { '0:11': { up: 0, down: 300_000, claimed: false } } } });
  const r = planTick(snap(36060, market(36060), a), cfg());
  assert.deepEqual(bets(r).map((b) => b.agent), ['streak-hunter', 'coin-flipper']);
});

test('a paused market gets no bets', () => {
  assert.deepEqual(bets(planTick(snap(36060, market(36060, { paused: true })), cfg())), []);
});

test('approval comes right before the bet, and only when the allowance is too small', () => {
  const low = agents({ 'trend-follower': { allowance: 0 } });
  const r = planTick(snap(36060, market(36060), low), cfg());
  const i = r.actions.findIndex((a) => a.type === 'approve');
  assert.equal(r.actions[i].agent, 'trend-follower');
  assert.equal(r.actions[i + 1].type, 'bet');
  assert.equal(r.actions.filter((a) => a.type === 'approve').length, 1);
  assert.ok(!kinds(planTick(snap(36060), cfg())).includes('approve'));
});

test('agents keep 0.05 USDC for fees: a poor agent bets the minimum or sits out', () => {
  const poor = agents({ 'trend-follower': { balance: 150_000 } });
  assert.equal(bets(planTick(snap(36060, market(36060), poor), cfg())).find((b) => b.agent === 'trend-follower').stake, 100_000);
  const broke = agents({ 'trend-follower': { balance: 140_000 } });
  const r = planTick(snap(36060, market(36060), broke), cfg());
  assert.ok(!bets(r).some((b) => b.agent === 'trend-follower'));
  assert.equal(r.decisions.find((d) => d.agent === 'trend-follower').decision.action, 'SKIP');
});

test('no bet is ever bigger than the safety cap', () => {
  const r = planTick(snap(36060), cfg({ maxStake: 200_000 }));
  assert.ok(bets(r).every((b) => b.stake <= 200_000));
  assert.equal(bets(r).find((b) => b.agent === 'trend-follower').stake, 200_000);
});

// ---------------------------------------------------------------- test prices
// Round 10 is running between 36000 and 39600 (nextRound is 11).

const priceAt = (now, updates) => planTick(snap(now, market(now, { feed: { updates } })), cfg()).actions.filter((a) => a.type === 'pushPrice');

test('start price: pushed 3 seconds after lock, once', () => {
  assert.equal(priceAt(36002, FEED).length, 0);
  const r = priceAt(36003, FEED);
  assert.equal(r.length, 1);
  assert.equal(r[0].why, 'start price');
  assert.equal(priceAt(36004, [...FEED, upd(5, 36003, 102)]).length, 0); // already pushed
});

test('mid-round price every 20 minutes, never in the last 90 seconds', () => {
  const f = [...FEED, upd(5, 36003, 102)];
  assert.equal(priceAt(37202, f).length, 0);
  assert.equal(priceAt(37203, f)[0].why, 'mid-round price');
  assert.equal(priceAt(39509, f)[0].why, 'mid-round price');
  assert.equal(priceAt(39510, f).length, 0);
});

test('end price: pushed 30 seconds before the end, once', () => {
  const f = [...FEED, upd(5, 36003, 102)];
  assert.equal(priceAt(39569, f).length, 0);
  assert.equal(priceAt(39570, f)[0].why, 'end price');
  assert.equal(priceAt(39571, [...f, upd(6, 39570, 103)]).length, 0);
});

// ---------------------------------------------------------------- settling

const ended = (over = {}) => ({ 10: { state: 'Unsettled', up: 300_000, down: 200_000, startPrice: 0n, endPrice: 0n }, ...over });
// Round 10 (36000..39600): start update at 36003, end update at 39570, next round's start at 39603.
const FEED10 = [...FEED, upd(5, 36003, 102), upd(6, 39570, 103), upd(7, 39603, 103)];
const settles = (now, rounds, updates = FEED10) =>
  planTick(snap(now, market(now, { rounds, feed: { updates } })), cfg()).actions.filter((a) => a.type === 'settle');

test('settles an ended round with the exact start and end update ids', () => {
  assert.equal(settles(39600, ended()).length, 0); // not strictly after the end yet
  const [s] = settles(39601, ended());
  assert.equal(s.round, 10);
  assert.equal(s.startId, id(5));
  assert.equal(s.endId, id(6));
});

test('an update exactly at lock is the start and one exactly at the end is the end', () => {
  const f = [upd(1, 30000, 100), upd(2, 36000, 101), upd(3, 39600, 102), upd(4, 39601, 103)];
  const [s] = settles(39610, ended(), f);
  assert.equal(s.startId, id(2));
  assert.equal(s.endId, id(3));
});

test('one-sided round: settled with zero ids (the contract refunds without looking)', () => {
  const [s] = settles(39610, ended({ 10: { state: 'Unsettled', up: 300_000, down: 0, startPrice: 0n, endPrice: 0n } }));
  assert.equal(s.startId, 0n);
  assert.equal(s.endId, 0n);
});

test('no price after lock: settled with start id 0 (a refund)', () => {
  const [s] = settles(39610, ended(), FEED);
  assert.equal(s.startId, 0n);
});

test('does not settle: empty rounds, settled rounds, or after the 1-hour window', () => {
  assert.equal(settles(39610, ended({ 10: { state: 'Unsettled', up: 0, down: 0, startPrice: 0n, endPrice: 0n } })).length, 0);
  assert.equal(settles(39610, ended({ 10: { state: 'SettledUp', up: 300_000, down: 200_000, startPrice: 1n, endPrice: 2n } })).length, 0);
  assert.equal(settles(43200 + 1, ended()).length, 0); // end 39600 + 3600 = 43200 is the last second
  assert.equal(settles(43200, ended()).length, 1);
});

// ---------------------------------------------------------------- claims

const claims = (now, rounds, positions, key = 'trend-follower') => {
  const a = agents({ [key]: { positions } });
  return planTick(snap(now, market(now, { rounds }), a), cfg()).actions.filter((x) => x.type === 'claim');
};
const R = (state, up = 300_000, down = 200_000) => ({ state, up, down, startPrice: 1n, endPrice: 2n });

test('claims a win, a refund, and a timed-out round; leaves losses and claimed rounds alone', () => {
  const pos = (up, down, claimed = false) => ({ up, down, claimed });
  assert.equal(claims(39610, { 10: R('SettledUp') }, { '0:10': pos(100_000, 0) }).length, 1);       // winner
  assert.equal(claims(39610, { 10: R('SettledUp') }, { '0:10': pos(0, 100_000) }).length, 0);       // loser
  assert.equal(claims(39610, { 10: R('SettledDown') }, { '0:10': pos(0, 100_000) }).length, 1);     // winner (down)
  assert.equal(claims(39610, { 10: R('Refunded') }, { '0:10': pos(0, 100_000) }).length, 1);        // refund
  assert.equal(claims(39610, { 10: R('SettledUp') }, { '0:10': pos(100_000, 0, true) }).length, 0); // already claimed
  assert.equal(claims(39610, { 10: R('Unsettled') }, { '0:10': pos(100_000, 0) }).length, 0);       // still inside the window
  assert.equal(claims(43201, { 10: R('Unsettled') }, { '0:10': pos(100_000, 0) }).length, 1);       // timed out: refund
});

// ---------------------------------------------------------------- helpers

test('planTick never changes the snapshot it is given', () => {
  const s = snap(36060);
  const before = JSON.stringify(s, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  planTick(s, cfg());
  assert.equal(JSON.stringify(s, (k, v) => (typeof v === 'bigint' ? v.toString() : v)), before);
});

test('lock and end times follow the contract formula (offset 20 minutes)', () => {
  const m = { startOffset: 1200, roundLength: 3600 };
  assert.equal(lockTime(m, 5), 1200 + 5 * 3600);
  assert.equal(endTime(m, 5), lockTime(m, 6));
});

test('findSettleIds: start = first update at/after lock, end = last at/before end', () => {
  const u = [upd(1, 90, 1), upd(2, 100, 2), upd(3, 150, 3), upd(4, 200, 4), upd(5, 201, 5)];
  assert.deepEqual(findSettleIds(u, 100, 200), { startId: id(2), endId: id(4) });
  assert.deepEqual(findSettleIds(u, 101, 200), { startId: id(3), endId: id(4) });
  assert.deepEqual(findSettleIds(u, 300, 400), { startId: 0n, endId: 0n });
  assert.deepEqual(findSettleIds([], 100, 200), { startId: 0n, endId: 0n });
});

test('test prices: a gentle walk that stays positive, moves at most 0.4% a step, and has 8 decimals', () => {
  const walk = createWalk(100000, mulberry32(3));
  let prev = 100000 * 1e8;
  for (let i = 0; i < 5000; i++) {
    const p = walk.next();
    assert.equal(typeof p, 'bigint');
    const ratio = Number(p) / prev;
    assert.ok(ratio > 0.995 && ratio < 1.005, `step ${i} moved ${ratio}`);
    assert.ok(p > 0n);
    prev = Number(p);
  }
});

// ---------------------------------------------------------------- whole days on a pretend chain

test('simulation: 8 hours on a pretend chain, 5 different seeds, no failed action', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { lines, world, failures } = simulate({ hours: 8, seed });
    assert.equal(failures, 0, `seed ${seed}: ${lines.filter((l) => l.includes('FAILED')).join('\n')}`);
    const text = lines.join('\n');
    assert.match(text, /settles round \d+ -> Settled(Up|Down)/, `seed ${seed}: nothing was settled`);
    assert.match(text, /claims \$/, `seed ${seed}: nothing was claimed`);
    for (const k of KEYS) assert.match(text, new RegExp(`${k} bets (UP|DOWN)`), `seed ${seed}: ${k} never bet`);
    // the four agents together can never end up with more than the 20 USDC they started with (fees only take money away); the rest is still in open rounds or unclaimed
    const total = world.agents.reduce((sum, ag) => sum + ag.balance, 0);
    assert.ok(total <= 20_000_000 && total > 15_000_000, `seed ${seed}: total ${total}`);
    // one side only per agent per round
    for (const a of world.agents) for (const p of Object.values(a.positions)) assert.ok(p.up === 0 || p.down === 0);
  }
});

test('simulation: in every round the contrarian bets after the three early agents', () => {
  const { lines } = simulate({ hours: 8, seed: 11 });
  const order = {};
  for (const l of lines) {
    const m = l.match(/\s(\S+) bets (UP|DOWN) .* on round (\d+):/);
    if (m) (order[m[3]] ||= []).push(m[1]);
  }
  const rounds = Object.values(order);
  assert.ok(rounds.length >= 7);
  for (const names of rounds) {
    const c = names.indexOf('contrarian');
    if (c >= 0) assert.equal(c, names.length - 1, `contrarian was not last: ${names}`);
    const early = names.filter((n) => n !== 'contrarian');
    assert.deepEqual(early, ['trend-follower', 'streak-hunter', 'coin-flipper'].filter((n) => early.includes(n)), `early order: ${early}`);
  }
});
