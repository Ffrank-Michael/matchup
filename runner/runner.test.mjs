// Tests for the round runner's brain (no blockchain, no wallets).  Run:  node --test runner/runner.test.mjs
// The testnet uses 10-minute rounds (600 s), so round k of an offset-0 market locks at 600 * k.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CFG } from './config.mjs';
import { planTick, tickDelay, lookbackFor, lockTime, endTime } from './plan.mjs';
import { findSettleIds } from './settleIds.mjs';
import { createWalk } from './priceWalk.mjs';
import { simulate, createWorld, mulberry32 } from './simulate.mjs';

const KEYS = ['trend-follower', 'contrarian', 'streak-hunter', 'coin-flipper'];
const NAMES = ['Agent 1 · Trend Follower', 'Agent 2 · Contrarian', 'Agent 3 · Streak Hunter', 'Agent 4 · Coin Flipper'];
const id = (n) => (1n << 64n) | BigInt(n);
const upd = (n, updatedAt, usd) => ({ id: id(n), updatedAt, price: BigInt(Math.round(usd * 1e8)) });
const ROUND = 600;
const nextAt = (now, offset = 0) => (now < offset ? 0 : Math.floor((now - offset) / ROUND) + 1); // the contract's rule

// BTC-like market: offset 0, 10-minute rounds. Round k locks at 600*k and ends at 600*(k+1).
// Feed: round 8 went UP (100 -> 101), round 9 went UP (101 -> 102), so "last finished round" is UP.
const FEED = [
  upd(1, 4810, 100), upd(2, 5390, 101), // round 8 (4800..5400): start 100, end 101
  upd(3, 5410, 101), upd(4, 5990, 102), // round 9 (5400..6000): start 101, end 102
];
const market = (now, over = {}) => ({
  id: 0, name: 'BTC/USD', roundLength: ROUND, startOffset: 0, minStake: 100_000, paused: false,
  nextRound: nextAt(now), feed: { updates: FEED }, rounds: {}, ...over,
});
const agent = (key, over = {}) => ({ key, balance: 5_000_000, allowance: 10_000_000, positions: {}, ...over });
const agents = (over = {}) => KEYS.map((k) => agent(k, over[k] || {}));
const snap = (now, m = market(now), a = agents()) => ({ now, markets: [m], agents: a });
const cfg = (over = {}) => ({ ...CFG, random: mulberry32(7), ...over });
const bets = (r) => r.actions.filter((a) => a.type === 'bet');
const kinds = (r) => r.actions.map((a) => a.type);

// ---------------------------------------------------------------- the settings fit 10-minute rounds

test('settings: early bets 1 minute after a round opens, contrarian 2 minutes before lock, two prices a round', () => {
  assert.equal(CFG.earlyDelay, 60);
  assert.equal(CFG.contrarianLead, 120);
  assert.equal(CFG.endMargin, 15);
  assert.equal(CFG.startAfter, 2);
  assert.equal(CFG.startGiveUp, 0.25);
  assert.ok(CFG.fastTickSeconds < CFG.tickSeconds, 'looks more often while a price is due');
  assert.ok(CFG.fastTickSeconds >= 3, "stays inside the exchange's request limit when several markets are due");
});

test('settings: the look-back covers the contract\'s whole 1-hour settle window', () => {
  assert.ok(CFG.lookback * ROUND >= CFG.settleWindow + ROUND, 'a round that can still be settled would be ignored');
});

// ---------------------------------------------------------------- betting order and timing
// Round 11 can be bet on from lock(10) = 6000 until lock(11) = 6600.

test('early agents wait a minute after the round opens, then bet in order: trend follower, streak hunter, coin flipper', () => {
  assert.deepEqual(bets(planTick(snap(6059), cfg())), []);
  const r = planTick(snap(6060), cfg());
  assert.deepEqual(bets(r).map((b) => b.agent), ['trend-follower', 'streak-hunter', 'coin-flipper']);
  assert.ok(bets(r).every((b) => b.round === 11 && b.market === 0));
});

test('the early agents use the real price history (last finished round was UP, so the trend follower bets UP)', () => {
  const b = bets(planTick(snap(6060), cfg())).find((x) => x.agent === 'trend-follower');
  assert.equal(b.side, 'UP');
  assert.equal(b.stake, 500_000);
  assert.match(b.reason, /101\.00 -> 102\.00/);
});

test('the history comes from the feed, so rounds nobody bet on still count', () => {
  const down = [upd(1, 5410, 102), upd(2, 5990, 100)]; // round 9: 102 -> 100
  const r = planTick(snap(6060, market(6060, { feed: { updates: down } })), cfg());
  assert.equal(bets(r).find((x) => x.agent === 'trend-follower').side, 'DOWN');
});

test('the round that is still running is not part of the history (only finished rounds are)', () => {
  // round 10 is running (6000..6600): started at 90, already down at 80. Round 9 (the last finished one) went UP.
  const f = [...FEED, upd(5, 6003, 90), upd(6, 6100, 80)];
  const r = planTick(snap(6200, market(6200, { feed: { updates: f } })), cfg());
  assert.equal(r.actions.length > 0 || r.decisions.length > 0, true);
  assert.equal(bets(r).find((x) => x.agent === 'trend-follower').side, 'UP');
});

test('no early bets in the last minute before lock', () => {
  assert.equal(bets(planTick(snap(6540 - 1), cfg())).length, 3);
  assert.equal(bets(planTick(snap(6540), cfg())).length, 0);
});

test('the contrarian bets about 2 minutes before lock, and only after the early agents are done', () => {
  const done = new Set(['0:11:trend-follower', '0:11:streak-hunter', '0:11:coin-flipper']);
  const m = (now) => market(now, { rounds: { 11: { state: 'Unsettled', up: 800_000, down: 200_000, startPrice: 0n, endPrice: 0n } } });
  assert.deepEqual(bets(planTick(snap(6479, m(6479)), cfg(), done)), []);
  const r = planTick(snap(6480, m(6480)), cfg(), done);
  assert.deepEqual(bets(r).map((b) => [b.agent, b.side]), [['contrarian', 'DOWN']]);
  assert.match(bets(r)[0].reason, /\$0\.80 is on UP and \$0\.20 on DOWN \(80% on UP\)/);
  // not in the last 30 seconds
  assert.deepEqual(bets(planTick(snap(6570, m(6570)), cfg(), done)), []);
  // an early agent that has not finished holds the contrarian back
  const notDone = new Set(['0:11:trend-follower', '0:11:streak-hunter']);
  assert.deepEqual(bets(planTick(snap(6480, m(6480)), cfg(), notDone)).map((b) => b.agent).filter((a) => a === 'contrarian'), []);
});

test('the contrarian skips when nobody has bet (and says so)', () => {
  const done = new Set(['0:11:trend-follower', '0:11:streak-hunter', '0:11:coin-flipper']);
  const r = planTick(snap(6480), cfg(), done);
  assert.deepEqual(bets(r), []);
  const d = r.decisions.find((x) => x.agent === 'contrarian');
  assert.equal(d.decision.action, 'SKIP');
});

test('an agent decides once per round: decided ids are not decided again', () => {
  const r1 = planTick(snap(6060), cfg());
  const decided = new Set(r1.decisions.map((d) => d.id));
  assert.equal(decided.size, 3);
  assert.deepEqual(planTick(snap(6070), cfg(), decided).decisions, []);
});

test('one side per round: an agent that already has a position never bets again', () => {
  const a = agents({ 'trend-follower': { positions: { '0:11': { up: 0, down: 300_000, claimed: false } } } });
  const r = planTick(snap(6060, market(6060), a), cfg());
  assert.deepEqual(bets(r).map((b) => b.agent), ['streak-hunter', 'coin-flipper']);
});

test('a paused market gets no bets', () => {
  assert.deepEqual(bets(planTick(snap(6060, market(6060, { paused: true })), cfg())), []);
});

test('approval comes right before the bet, and only when the allowance is too small', () => {
  const low = agents({ 'trend-follower': { allowance: 0 } });
  const r = planTick(snap(6060, market(6060), low), cfg());
  const i = r.actions.findIndex((a) => a.type === 'approve');
  assert.equal(r.actions[i].agent, 'trend-follower');
  assert.equal(r.actions[i + 1].type, 'bet');
  assert.equal(r.actions.filter((a) => a.type === 'approve').length, 1);
  assert.ok(!kinds(planTick(snap(6060), cfg())).includes('approve'));
});

test('agents keep 0.05 USDC for fees: a poor agent bets the minimum or sits out', () => {
  const poor = agents({ 'trend-follower': { balance: 150_000 } });
  assert.equal(bets(planTick(snap(6060, market(6060), poor), cfg())).find((b) => b.agent === 'trend-follower').stake, 100_000);
  const broke = agents({ 'trend-follower': { balance: 140_000 } });
  const r = planTick(snap(6060, market(6060), broke), cfg());
  assert.ok(!bets(r).some((b) => b.agent === 'trend-follower'));
  assert.equal(r.decisions.find((d) => d.agent === 'trend-follower').decision.action, 'SKIP');
});

test('no bet is ever bigger than the safety cap', () => {
  const r = planTick(snap(6060), cfg({ maxStake: 200_000 }));
  assert.ok(bets(r).every((b) => b.stake <= 200_000));
  assert.equal(bets(r).find((b) => b.agent === 'trend-follower').stake, 200_000);
});

// ---------------------------------------------------------------- three markets, staggered 3 minutes apart

const three = (now) => [
  market(now),
  market(now, { id: 1, name: 'ETH/USD', startOffset: 180, nextRound: nextAt(now, 180) }),
  market(now, { id: 2, name: 'SOL/USD', startOffset: 360, nextRound: nextAt(now, 360) }),
];

test('each market runs on its own clock: BTC locks at :00, ETH at :03, SOL at :06 of every 10 minutes', () => {
  const [btc, eth, sol] = three(6060);
  assert.equal(lockTime(btc, 10) % 600, 0);
  assert.equal(lockTime(eth, 10) % 600, 180);
  assert.equal(lockTime(sol, 10) % 600, 360);
  assert.equal(endTime(eth, 10), lockTime(eth, 11));
});

test('each market gets its early bets 1 minute after ITS round opens', () => {
  // BTC round 11 opened at 6000, ETH round 11 opens at 6180, SOL round 11 opens at 6360.
  const run = (now, decided) => planTick({ now, markets: three(now), agents: agents() }, cfg(), decided);
  const who = (r) => [...new Set(r.decisions.map((d) => d.market))];
  const r1 = run(6060, new Set());
  assert.ok(who(r1).includes('BTC/USD'));
  const decided = new Set(r1.decisions.map((d) => d.id));
  assert.deepEqual(who(run(6239, decided)).filter((n) => n !== 'BTC/USD'), []);                 // ETH still waiting
  assert.deepEqual(who(run(6240, decided)).filter((n) => n === 'ETH/USD'), ['ETH/USD']);        // ETH opened at 6180
  const decided2 = new Set([...decided, ...run(6240, decided).decisions.map((d) => d.id)]);
  assert.deepEqual(who(run(6419, decided2)).filter((n) => n === 'SOL/USD'), []);
  assert.deepEqual(who(run(6420, decided2)).filter((n) => n === 'SOL/USD'), ['SOL/USD']);       // SOL opened at 6360
});

test('each market asks for its start price right after ITS lock', () => {
  const startDue = (now, over) => planTick(snap(now, market(now, over)), cfg()).actions.filter((x) => x.type === 'pushPrice' && x.why === 'start price').length;
  // BTC round 10 locks at 6000, ETH round 10 at 6180, SOL round 10 at 6360 (each has an older price only)
  const eth = (now) => ({ id: 1, name: 'ETH/USD', startOffset: 180, nextRound: nextAt(now, 180), feed: { updates: [upd(1, 6120, 100)] } });
  const sol = (now) => ({ id: 2, name: 'SOL/USD', startOffset: 360, nextRound: nextAt(now, 360), feed: { updates: [upd(1, 6300, 100)] } });
  assert.equal(startDue(6001), 0);          assert.equal(startDue(6002), 1);
  assert.equal(startDue(6181, eth(6181)), 0); assert.equal(startDue(6182, eth(6182)), 1);
  assert.equal(startDue(6361, sol(6361)), 0); assert.equal(startDue(6362, sol(6362)), 1);
});

// ---------------------------------------------------------------- test prices
// Round 10 is running between 6000 and 6600 (nextRound is 11).

const priceAt = (now, updates) => planTick(snap(now, market(now, { feed: { updates } })), cfg()).actions.filter((a) => a.type === 'pushPrice');

test('start price: asked for 2 seconds after the lock, as the first trade after the lock, once', () => {
  assert.equal(priceAt(6001, FEED).length, 0);
  const r = priceAt(6002, FEED);
  assert.equal(r.length, 1);
  assert.equal(r[0].why, 'start price');
  assert.equal(r[0].firstTradeAfter, 6000 + CFG.startAfter); // the executor uses the oldest trade at or after this moment
  assert.equal(priceAt(6003, [...FEED, upd(5, 6003, 102)]).length, 0); // already pushed
});

test('the start price keeps being asked for until 25% of the round has passed (150 s of 600), then the round is left to refund', () => {
  assert.equal(priceAt(6100, FEED)[0].why, 'start price');
  assert.equal(priceAt(6149, FEED)[0].why, 'start price');
  assert.equal(priceAt(6150, FEED).length, 0);
  assert.equal(priceAt(6400, FEED).length, 0);
  assert.equal(priceAt(6585, FEED).length, 0, 'with no start price there is no end price either');
});

test('a price from before the lock never counts as the start price', () => {
  const old = [...FEED, upd(5, 5999, 102)];
  assert.equal(priceAt(6002, old)[0].why, 'start price');
});

test('only the start price asks for a trade after the lock; the end price is the last trade', () => {
  const f = [...FEED, upd(5, 6010, 102)];
  assert.equal(priceAt(6585, f)[0].why, 'end price');
  assert.equal(priceAt(6585, f)[0].firstTradeAfter, undefined);
});

test('there is no price in the middle of the round', () => {
  const f = [...FEED, upd(5, 6010, 102)];
  for (let now = 6011; now < 6585; now += 7) assert.equal(priceAt(now, f).length, 0, 'at ' + now);
});

test('end price: pushed 15 seconds before the end, once', () => {
  const f = [...FEED, upd(5, 6010, 102)];
  assert.equal(priceAt(6584, f).length, 0);
  assert.equal(priceAt(6585, f)[0].why, 'end price');
  assert.equal(priceAt(6599, f)[0].why, 'end price'); // late is better than never, until the end
  assert.equal(priceAt(6585, [...f, upd(6, 6585, 103)]).length, 0);
  assert.equal(priceAt(6600, f).length, 0); // next round now
});

test('two prices go into one 10-minute round: start, end', () => {
  let feed = [...FEED];
  const why = [];
  for (let now = 6000; now < 6600; now += 3) {
    const p = priceAt(now, feed);
    if (p.length) { why.push(p[0].why); feed = [...feed, upd(100 + why.length, now, 100 + why.length)]; }
  }
  assert.deepEqual(why, ['start price', 'end price']);
});

// ---------------------------------------------------------------- how often the runner looks

test('the runner looks every 3 seconds while a start or end price is due, otherwise every 10', () => {
  const delay = (now, updates) => tickDelay(snap(now, market(now, { feed: { updates } })), CFG);
  const f = [...FEED, upd(5, 6010, 102)];
  assert.equal(delay(5990, FEED), 10);
  assert.equal(delay(6002, FEED), 3);   // start price due
  assert.equal(delay(6150, FEED), 10);  // gave up
  assert.equal(delay(6100, f), 10);     // start is in, end not due yet
  assert.equal(delay(6585, f), 3);      // end price due
  assert.equal(delay(6585, [...f, upd(6, 6585, 103)]), 10);
});

// ---------------------------------------------------------------- settling

const ended = (over = {}) => ({ 10: { state: 'Unsettled', up: 300_000, down: 200_000, startPrice: 0n, endPrice: 0n }, ...over });
// Round 10 (6000..6600): start update at 6003, end update at 6570, next round's start at 6603.
const FEED10 = [...FEED, upd(5, 6003, 102), upd(6, 6570, 103), upd(7, 6603, 103)];
const settles = (now, rounds, updates = FEED10) =>
  planTick(snap(now, market(now, { rounds, feed: { updates } })), cfg()).actions.filter((a) => a.type === 'settle');

test('settles an ended round with the exact start and end update ids', () => {
  assert.equal(settles(6600, ended()).length, 0); // not strictly after the end yet
  const [s] = settles(6601, ended());
  assert.equal(s.round, 10);
  assert.equal(s.startId, id(5));
  assert.equal(s.endId, id(6));
});

test('an update exactly at lock is the start and one exactly at the end is the end', () => {
  const f = [upd(1, 5000, 100), upd(2, 6000, 101), upd(3, 6600, 102), upd(4, 6601, 103)];
  const [s] = settles(6610, ended(), f);
  assert.equal(s.startId, id(2));
  assert.equal(s.endId, id(3));
});

test('one-sided round: settled with zero ids (the contract refunds without looking)', () => {
  const [s] = settles(6610, ended({ 10: { state: 'Unsettled', up: 300_000, down: 0, startPrice: 0n, endPrice: 0n } }));
  assert.equal(s.startId, 0n);
  assert.equal(s.endId, 0n);
});

test('no price after lock: settled with start id 0 (a refund)', () => {
  const [s] = settles(6610, ended(), FEED);
  assert.equal(s.startId, 0n);
});

test('does not settle: empty rounds, settled rounds, or after the 1-hour window', () => {
  assert.equal(settles(6610, ended({ 10: { state: 'Unsettled', up: 0, down: 0, startPrice: 0n, endPrice: 0n } })).length, 0);
  assert.equal(settles(6610, ended({ 10: { state: 'SettledUp', up: 300_000, down: 200_000, startPrice: 1n, endPrice: 2n } })).length, 0);
  assert.equal(settles(10200 + 1, ended()).length, 0); // end 6600 + 3600 = 10200 is the last second
  assert.equal(settles(10200, ended()).length, 1);
});

test('a round that ended almost an hour ago is still settled (the look-back is wide enough)', () => {
  // now is 3000 s after round 4 ended, so round 4 is 7 rounds back from the running round
  const now = 6000 + 5;
  const r4 = { 4: { state: 'Unsettled', up: 300_000, down: 200_000, startPrice: 0n, endPrice: 0n } };
  assert.equal(endTime({ startOffset: 0, roundLength: ROUND }, 4), 3000);
  const got = planTick(snap(now, market(now, { rounds: r4 })), cfg()).actions.filter((a) => a.type === 'settle');
  assert.deepEqual(got.map((a) => a.round), [4]);
});

// ---------------------------------------------------------------- claims

const claims = (now, rounds, positions, key = 'trend-follower') => {
  const a = agents({ [key]: { positions } });
  return planTick(snap(now, market(now, { rounds }), a), cfg()).actions.filter((x) => x.type === 'claim');
};
const R = (state, up = 300_000, down = 200_000) => ({ state, up, down, startPrice: 1n, endPrice: 2n });

test('claims a win, a refund, and a timed-out round; leaves losses and claimed rounds alone', () => {
  const pos = (up, down, claimed = false) => ({ up, down, claimed });
  assert.equal(claims(6610, { 10: R('SettledUp') }, { '0:10': pos(100_000, 0) }).length, 1);       // winner
  assert.equal(claims(6610, { 10: R('SettledUp') }, { '0:10': pos(0, 100_000) }).length, 0);       // loser
  assert.equal(claims(6610, { 10: R('SettledDown') }, { '0:10': pos(0, 100_000) }).length, 1);     // winner (down)
  assert.equal(claims(6610, { 10: R('Refunded') }, { '0:10': pos(0, 100_000) }).length, 1);        // refund
  assert.equal(claims(6610, { 10: R('SettledUp') }, { '0:10': pos(100_000, 0, true) }).length, 0); // already claimed
  assert.equal(claims(6610, { 10: R('Unsettled') }, { '0:10': pos(100_000, 0) }).length, 0);       // still inside the window
  assert.equal(claims(10201, { 10: R('Unsettled') }, { '0:10': pos(100_000, 0) }).length, 1);      // timed out: refund
});

// ---------------------------------------------------------------- helpers

test('planTick never changes the snapshot it is given', () => {
  const s = snap(6060);
  const before = JSON.stringify(s, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  planTick(s, cfg());
  assert.equal(JSON.stringify(s, (k, v) => (typeof v === 'bigint' ? v.toString() : v)), before);
});

test('lock and end times follow the contract formula (ETH: offset 3 minutes, 10-minute rounds)', () => {
  const m = { startOffset: 180, roundLength: 600 };
  assert.equal(lockTime(m, 5), 180 + 5 * 600);
  assert.equal(endTime(m, 5), lockTime(m, 6));
});

test('lock and end times also work for the 1-hour option (ETH: offset 20 minutes)', () => {
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

test('pretend-chain prices (simulation only): a gentle walk that stays positive, moves at most 0.4% a step, and has 8 decimals', () => {
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

// ---------------------------------------------------------------- whole days on a pretend chain (all three markets)

test('simulation: 8 hours, 3 markets, 5 different seeds, no failed action', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { lines, world, failures } = simulate({ hours: 8, seed });
    assert.equal(failures, 0, `seed ${seed}: ${lines.filter((l) => l.includes('FAILED')).join('\n')}`);
    const text = lines.join('\n');
    for (const m of ['BTC/USD', 'ETH/USD', 'SOL/USD']) {
      assert.match(text, new RegExp(`settles ${m} round \\d+ -> Settled(Up|Down)`), `seed ${seed}: nothing settled on ${m}`);
      assert.match(text, new RegExp(`claims \\$\\S+ from ${m}`), `seed ${seed}: nothing claimed on ${m}`);
      assert.match(text, new RegExp(`Runner ${m} start price`), `seed ${seed}: no start price for ${m}`);
    }
    for (const n of NAMES) assert.match(text, new RegExp(`${n} bets (UP|DOWN)`), `seed ${seed}: ${n} never bet`);
    // no money appears or vanishes: what the agents hold plus what is still inside the contract is always the 20 USDC they started with
    const total = world.agents.reduce((sum, ag) => sum + ag.balance, 0);
    assert.equal(total + world.staked - world.paidOut, 20_000_000, `seed ${seed}`);
    assert.ok(total <= 20_000_000 && total > 5_000_000, `seed ${seed}: total ${total}`);
    assert.ok(world.paidOut > 0 && world.paidOut <= world.staked, `seed ${seed}: paid out more than was put in`);
    // one side only per agent per round, per market
    for (const a of world.agents) for (const p of Object.values(a.positions)) assert.ok(p.up === 0 || p.down === 0);
  }
});

test('simulation: each market gets two prices a round (start and end)', () => {
  const { lines } = simulate({ hours: 2, seed: 4 });
  for (const m of ['BTC/USD', 'ETH/USD', 'SOL/USD']) {
    const mine = lines.filter((l) => l.includes(`Runner ${m} `) && /price:/.test(l));
    assert.ok(mine.length >= 22 && mine.length <= 26, `${m}: ${mine.length} prices in 2 hours (12 rounds)`);
    for (const why of ['start price', 'end price']) {
      assert.ok(mine.filter((l) => l.includes(why)).length >= 11, `${m}: too few ${why}`);
    }
    assert.equal(mine.filter((l) => l.includes('mid-round')).length, 0, `${m}: a price in the middle`);
  }
});

test('simulation: in every round of every market the contrarian bets after the three early agents', () => {
  const { lines } = simulate({ hours: 8, seed: 11 });
  const order = {};
  for (const l of lines) {
    const m = l.match(/\s(Agent \d · [A-Za-z ]+?) bets (UP|DOWN) \S+ on (\S+) round (\d+):/);
    if (m) (order[`${m[3]} ${m[4]}`] ||= []).push(m[1]);
  }
  const rounds = Object.values(order);
  assert.ok(rounds.length >= 60, `only ${rounds.length} rounds had bets`);
  for (const names of rounds) {
    const c = names.indexOf('Agent 2 · Contrarian');
    if (c >= 0) assert.equal(c, names.length - 1, `contrarian was not last: ${names}`);
    const early = names.filter((n) => n !== 'Agent 2 · Contrarian');
    assert.deepEqual(early, ['Agent 1 · Trend Follower', 'Agent 3 · Streak Hunter', 'Agent 4 · Coin Flipper'].filter((n) => early.includes(n)), `early order: ${early}`);
  }
});

test('simulation: log lines use the agent names and have no words stuck together', () => {
  const { lines } = simulate({ hours: 3, seed: 2 });
  const text = lines.join('\n');
  assert.doesNotMatch(text, /trend-follower|streak-hunter|coin-flipper/);
  assert.doesNotMatch(text, /(UP|DOWN)[a-z]|[a-z](UP|DOWN)\b/);
  assert.doesNotMatch(text, /[a-z,.:] {2,}[a-z]/); // no double spaces inside a sentence
});

test('simulation: three markets, 10-minute rounds, BTC :00, ETH :03, SOL :06', () => {
  const w = createWorld({ now: 36000 });
  assert.deepEqual(w.markets.map((m) => [m.name, m.roundLength, m.startOffset]), [['BTC/USD', 600, 0], ['ETH/USD', 600, 180], ['SOL/USD', 600, 360]]);
});

// ---------------------------------------------------------------- 5- and 10-minute markets of one coin share one feed

test('two markets of one coin on the same feed: one start price push, one end price push, not two', () => {
  // BTC 5m (round 10 of 300 s: 3000..3300) and BTC 10m (round 5 of 600 s: 3000..3600) both lock at 3000.
  const feed = { address: '0xRELAY', updates: [upd(1, 2990, 100)] };
  const m5 = { id: 0, name: 'BTC/USD 5m', roundLength: 300, startOffset: 0, minStake: 100_000, paused: false, nextRound: 11, feed, rounds: {} };
  const m10 = { id: 3, name: 'BTC/USD 10m', roundLength: 600, startOffset: 0, minStake: 100_000, paused: false, nextRound: 6, feed, rounds: {} };
  const pushes = (now, f) => planTick({ now, markets: [{ ...m5, feed: f }, { ...m10, feed: f }], agents: agents() }, cfg()).actions.filter((a) => a.type === 'pushPrice');
  const start = pushes(3002, feed);
  assert.equal(start.length, 1);
  assert.equal(start[0].why, 'start price');
  assert.equal(start[0].feed, '0xRELAY'); // the executor pushes to the feed the market uses
  // after that push both markets have their start price, so nothing more is due
  assert.equal(pushes(3003, { address: '0xRELAY', updates: [...feed.updates, upd(2, 3003, 101)] }).length, 0);
  // at 3285 the 5-minute round ends in 15 s; the 10-minute round has 5 more minutes: one end price push, for the 5m market
  const mid = { address: '0xRELAY', updates: [...feed.updates, upd(2, 3003, 101)] };
  const end = pushes(3285, mid);
  assert.equal(end.length, 1);
  assert.equal(end[0].why, 'end price');
  assert.equal(end[0].marketName, 'BTC/USD 5m');
});

test('markets of different coins each get their own push', () => {
  const mk = (id, name, address, offset) => ({ id, name, roundLength: 300, startOffset: offset, minStake: 100_000, paused: false, nextRound: Math.floor((3004 - offset) / 300) + 1, feed: { address, updates: [upd(1, 2000, 100)] }, rounds: {} });
  const r = planTick({ now: 3004, markets: [mk(0, 'BTC/USD 5m', '0xB', 0), mk(1, 'ETH/USD 5m', '0xE', 2)], agents: agents() }, cfg());
  assert.deepEqual(r.actions.filter((a) => a.type === 'pushPrice').map((a) => a.marketName).sort(), ['BTC/USD 5m', 'ETH/USD 5m']);
});

// ---------------------------------------------------------------- order of actions and look-back

test('price pushes and settles come first in the plan, an approval still comes right before its bet', () => {
  const ms = three(6065).map((m, i) => ({ ...m, feed: { address: '0xF' + i, updates: [upd(1, 5000, 100)] } }));
  const r = planTick({ now: 6065, markets: ms, agents: agents({ 'coin-flipper': { allowance: 0 } }) }, cfg());
  const order = r.actions.map((x) => x.type);
  assert.ok(order.includes('pushPrice') && order.includes('bet'), order.join(','));
  const lastPush = order.lastIndexOf('pushPrice');
  const firstOther = order.findIndex((x) => x !== 'pushPrice' && x !== 'settle');
  assert.ok(firstOther > lastPush, order.join(','));
  r.actions.forEach((x, i) => { if (x.type === 'approve') { assert.equal(r.actions[i + 1].type, 'bet'); assert.equal(r.actions[i + 1].agent, x.agent); } });
});

test('the look-back covers the whole 1-hour settle window for 5-minute and 10-minute rounds alike', () => {
  for (const roundLength of [300, 600]) {
    assert.ok(lookbackFor({ roundLength }, CFG) * roundLength >= CFG.settleWindow + roundLength, `${roundLength}s rounds`);
  }
  assert.equal(lookbackFor({ roundLength: 300 }, CFG), 14);
  assert.equal(lookbackFor({ roundLength: 600 }, CFG), 8);
});
