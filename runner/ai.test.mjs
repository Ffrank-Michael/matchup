// Tests for the AI side of the runner: the planner's AI path, the stateful asker, and the notes writer.  Run:  node --test runner/ai.test.mjs
// Rounds here are 600 s (and 300 s / 3600 s for the other time frames), all locking at multiples of their length, so round 11 of the
// 10-minute market opens at 6000, the same moment as the 5-minute market's round 20 and the 1-hour market's round 2 (opens 3600).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CFG } from './config.mjs';
import { planTick, tickDelay } from './plan.mjs';
import { createAi } from './ai.mjs';
import { createNotes, noteKey } from './notes.mjs';
import { COULDNT_DECIDE } from '../agents/ai.mjs';
import { mulberry32 } from './simulate.mjs';

const KEYS = ['trend-follower', 'contrarian', 'chart-reader', 'coin-flipper'];
const id = (n) => (1n << 64n) | BigInt(n);
const upd = (n, updatedAt, usd) => ({ id: id(n), updatedAt, price: BigInt(Math.round(usd * 1e8)) });
const FEED = [upd(1, 4810, 100), upd(2, 5390, 101), upd(3, 5410, 101), upd(4, 5990, 102), upd(5, 6003, 102)];
const nextAt = (now, offset, len) => (now < offset ? 0 : Math.floor((now - offset) / len) + 1);
// a market of the given coin and round length (offset 0 unless given): the next round is the one the contract would say
const mk = (now, { id: mid, name, len, offset = 0, ...over }) => ({ id: mid, name, roundLength: len, startOffset: offset, minStake: 100_000, paused: false, nextRound: nextAt(now, offset, len), feed: { updates: FEED }, rounds: {}, ...over });
const BTC10 = (now, over = {}) => mk(now, { id: 0, name: 'BTC/USD 10m', len: 600, ...over });
const BTC5 = (now, over = {}) => mk(now, { id: 3, name: 'BTC/USD 5m', len: 300, ...over });
const BTC1H = (now, over = {}) => mk(now, { id: 5, name: 'BTC/USD 1h', len: 3600, ...over });
const ETH5 = (now, over = {}) => mk(now, { id: 1, name: 'ETH/USD 5m', len: 300, offset: 100, ...over });
const agent = (key, over = {}) => ({ key, balance: 5_000_000, allowance: 10_000_000, positions: {}, ...over });
const CANDLES = Array.from({ length: 130 }, (_, i) => ({ time: 1_790_000_000 + i * 60, open: 100 + i, close: 101 + i, high: 102 + i, low: 99 + i }));
const snap = (now, markets, { agents = KEYS.map((k) => agent(k)), candles = CANDLES } = {}) => ({ now, markets, agents, candles: { 'BTC/USD': candles, 'ETH/USD': candles } });
const ans = (up = 'UP', down = 'DOWN') => ({ 'trend-follower': { call: up, reason: 'Trend says ' + up + '.' }, contrarian: { call: down, reason: 'Fading to ' + down + '.' }, 'chart-reader': { call: up, reason: 'Candles say ' + up + '.' } });
const mkAi = (results = {}) => ({ results: new Map(Object.entries(results)) });
const cfg = (ai, over = {}) => ({ ...CFG, random: mulberry32(7), ai, aiMarkets: 'all', ...over });
const bets = (r) => r.actions.filter((a) => a.type === 'bet');
const BATCH = 'ai:BTC/USD:6000';
const EARLY_DONE = new Set(['0:11:trend-follower', '0:11:chart-reader', '0:11:coin-flipper', '3:21:trend-follower', '3:21:chart-reader', '3:21:coin-flipper']);

// ---------------------------------------------------------------- when the AI is asked

test('one request per coin, listing every time frame that opens at that moment, shortest first', () => {
  const r = planTick(snap(6004, [BTC10(6004), BTC5(6004), BTC1H(6004), ETH5(6004)]), cfg(mkAi()));
  const btc = r.aiRequests.find((q) => q.id === BATCH);
  assert.deepEqual(btc.frames.map((f) => [f.label, f.marketId, f.round]), [['5m', 3, 21], ['10m', 0, 11]], 'the 1-hour round opened at 3600, not now');
  assert.ok(btc.frames.every((f) => f.secondsToLock > 0 && f.secondsToLock <= 600));
  // the 1-hour round (still open for calls, nobody has called it yet) is a separate, catching-up request of its own
  assert.deepEqual(r.aiRequests.filter((q) => q.coin === 'BTC/USD').map((q) => q.id).sort(), ['ai:BTC/USD:3600', BATCH]);
});

test('different coins open at different moments and each get their own request', () => {
  const r = planTick(snap(6004, [BTC5(6004), ETH5(6004)]), cfg(mkAi()));
  // ETH (offset 100): its round 20 opened at 5800 and is still open for calls, so ETH has its own request
  assert.deepEqual(r.aiRequests.map((q) => q.id).sort(), ['ai:BTC/USD:6000', 'ai:ETH/USD:5800']);
});

test('the request waits aiAskAfter seconds after the opening, and stops when calling is nearly over', () => {
  assert.equal(planTick(snap(6002, [BTC10(6002)]), cfg(mkAi())).aiRequests.length, 0);
  assert.equal(planTick(snap(6003, [BTC10(6003)]), cfg(mkAi())).aiRequests.length, 1);
  assert.equal(planTick(snap(6539, [BTC10(6539)]), cfg(mkAi())).aiRequests.length, 1);
  assert.equal(planTick(snap(6540, [BTC10(6540)]), cfg(mkAi())).aiRequests.length, 0, 'earlyCutoff before the lock');
});

test('the candles sent fit the longest frame: 30 for 5m and 10m, 120 for 1h', () => {
  const two = planTick(snap(6004, [BTC10(6004), BTC5(6004)]), cfg(mkAi())).aiRequests[0];
  assert.equal(two.candles.length, 30);
  const hour = planTick(snap(3604, [BTC1H(3604), BTC5(3604)]), cfg(mkAi())).aiRequests[0];
  assert.deepEqual(hour.frames.map((f) => f.label), ['5m', '1h']);
  assert.equal(hour.candles.length, 120);
});

test('once the answer is in, nothing more is asked', () => {
  const r = planTick(snap(6012, [BTC10(6012)]), cfg(mkAi({ [BATCH]: { ok: true, decisions: { 0: ans() } } })));
  assert.equal(r.aiRequests.length, 0);
});

test('no request when every AI agent already called this round or has no money', () => {
  const has = (key) => agent(key, { positions: { '0:11': { up: 500_000, down: 0 } } });
  const done = KEYS.map((k) => (k === 'coin-flipper' ? agent(k) : has(k)));
  assert.equal(planTick(snap(6012, [BTC10(6012)], { agents: done }), cfg(mkAi())).aiRequests.length, 0);
  const broke = KEYS.map((k) => agent(k, { balance: 10_000 }));
  assert.equal(planTick(snap(6012, [BTC10(6012)], { agents: broke }), cfg(mkAi())).aiRequests.length, 0);
});

test('too few candles: no request, and the agents skip with "Couldn\'t decide this round"', () => {
  const r = planTick(snap(6012, [BTC10(6012)], { candles: CANDLES.slice(0, 5) }), cfg(mkAi()));
  assert.equal(r.aiRequests.length, 0);
  const d = r.decisions.find((x) => x.agent === 'trend-follower');
  assert.deepEqual([d.decision.reason, d.decision.aiFailed, d.retry], [COULDNT_DECIDE, true, false]);
});

test('a paused market, or one the AI does not play (aiMarkets), is not asked about', () => {
  assert.equal(planTick(snap(6012, [BTC10(6012, { paused: true })]), cfg(mkAi())).aiRequests.length, 0);
  const r = planTick(snap(6012, [BTC10(6012), ETH5(6012)]), cfg(mkAi(), { aiMarkets: ['BTC/USD 10m'] }));
  assert.deepEqual(r.aiRequests.map((q) => q.coin), ['BTC/USD']);
});

// ---------------------------------------------------------------- when the agents act, and what they do with the answer

test('the early agents act 10 s after the opening, not before, each on its own market\'s answer', () => {
  const ai = mkAi({ [BATCH]: { ok: true, decisions: { 0: ans('UP', 'DOWN'), 3: ans('DOWN', 'UP') } } });
  const markets = (n) => [BTC10(n), BTC5(n)];
  assert.deepEqual(bets(planTick(snap(6009, markets(6009)), cfg(ai))).filter((b) => b.ai), []);
  const r = planTick(snap(6010, markets(6010)), cfg(ai));
  const side = (market, agentKey) => bets(r).find((b) => b.market === market && b.agent === agentKey)?.side;
  assert.deepEqual([side(0, 'trend-follower'), side(0, 'chart-reader')], ['UP', 'UP']);
  assert.deepEqual([side(3, 'trend-follower'), side(3, 'chart-reader')], ['DOWN', 'DOWN']);
  const b = bets(r).find((x) => x.market === 0 && x.agent === 'trend-follower');
  assert.deepEqual([b.reason, b.ai, b.rule, b.stake], ['Trend says UP.', true, false, 500_000]);
  assert.ok(bets(r).some((x) => x.agent === 'coin-flipper' && x.market === 0), 'the coin flipper acts at the same time, at random');
});

test('a failed answer makes all three agents skip, for good, with the standard words', () => {
  const ai = mkAi({ [BATCH]: { ok: false, error: 'timed out' } });
  const r = planTick(snap(6012, [BTC10(6012)]), cfg(ai));
  for (const key of ['trend-follower', 'chart-reader']) {
    const d = r.decisions.find((x) => x.agent === key);
    assert.deepEqual([d.decision.action, d.decision.reason, d.decision.aiFailed, d.retry], ['SKIP', COULDNT_DECIDE, true, false]);
  }
  assert.ok(!bets(r).some((b) => b.ai));
});

test('a decision missing from an otherwise good answer only skips that agent', () => {
  const partial = { ...ans(), 'chart-reader': null };
  const r = planTick(snap(6012, [BTC10(6012)]), cfg(mkAi({ [BATCH]: { ok: true, decisions: { 0: partial } } })));
  assert.equal(r.decisions.find((x) => x.agent === 'chart-reader').decision.aiFailed, true);
  assert.equal(bets(r).find((b) => b.agent === 'trend-follower').ai, true);
});

test('while the answer is on its way the AI agents wait (no decision, no skip)', () => {
  const r = planTick(snap(6012, [BTC10(6012)]), cfg(mkAi()));
  assert.ok(!r.decisions.some((d) => d.agent === 'trend-follower' || d.agent === 'chart-reader'));
});

test('an agent without enough money skips without waiting for the model', () => {
  const agents = KEYS.map((k) => agent(k, k === 'trend-follower' ? { balance: 10_000 } : {}));
  const r = planTick(snap(6012, [BTC10(6012)], { agents }), cfg(mkAi()));
  assert.equal(r.decisions.find((x) => x.agent === 'trend-follower').decision.action, 'SKIP');
  assert.equal(r.aiRequests.length, 1, 'the others are still asked about');
});

// ---------------------------------------------------------------- the contrarian

const withMoney = (up, down) => BTC10(6032, { rounds: { 11: { state: 'Unsettled', up, down } } });
const contra = (ai, m, now = 6032) => planTick(snap(now, [m]), cfg(ai), EARLY_DONE);

test('the contrarian acts 20 s after the early agents, and only once they are done', () => {
  const ai = mkAi({ [BATCH]: { ok: true, decisions: { 0: ans('UP', 'UP') } } });
  const m = (n) => BTC10(n, { rounds: { 11: { state: 'Unsettled', up: 300_000, down: 500_000 } } });
  assert.deepEqual(bets(planTick(snap(6029, [m(6029)]), cfg(ai), EARLY_DONE)).filter((b) => b.agent === 'contrarian'), []);
  assert.equal(bets(planTick(snap(6030, [m(6030)]), cfg(ai), EARLY_DONE)).filter((b) => b.agent === 'contrarian').length, 1);
  const notDone = new Set(['0:11:trend-follower', '0:11:coin-flipper']);
  assert.deepEqual(bets(planTick(snap(6032, [m(6032)]), cfg(ai), notDone)).filter((b) => b.agent === 'contrarian'), []);
});

test('contrarian: money on both sides, the AI view is used as it is (even split too)', () => {
  const ai = mkAi({ [BATCH]: { ok: true, decisions: { 0: ans('UP', 'UP') } } });
  for (const [up, down] of [[500_000, 300_000], [400_000, 400_000]]) {
    const b = bets(contra(ai, withMoney(up, down))).find((x) => x.agent === 'contrarian');
    assert.deepEqual([b.side, b.reason, b.rule, b.stake], ['UP', 'Fading to UP.', false, 400_000]);
  }
});

test('contrarian: with one side empty the empty side is taken, and a view that disagrees gets a plain-number reason', () => {
  const ai = mkAi({ [BATCH]: { ok: true, decisions: { 0: ans('UP', 'UP') } } }); // the AI view is UP
  const b = bets(contra(ai, withMoney(500_000, 0))).find((x) => x.agent === 'contrarian'); // all the money is on UP, so DOWN is empty? no: UP has it
  assert.equal(b.side, 'DOWN');
  assert.equal(b.rule, true);
  assert.equal(b.reason, 'All the money is on UP ($0.50), so I take DOWN.');
  const c = bets(contra(ai, withMoney(0, 700_000))).find((x) => x.agent === 'contrarian'); // UP is empty and the view is UP
  assert.deepEqual([c.side, c.rule, c.reason], ['UP', false, 'Fading to UP.'], 'the model already agrees: its own words stay');
});

test('contrarian: nobody on the round yet is looked at again, with no request', () => {
  const ai = mkAi({ [BATCH]: { ok: true, decisions: { 0: ans() } } });
  const r = contra(ai, withMoney(0, 0));
  const d = r.decisions.find((x) => x.agent === 'contrarian');
  assert.deepEqual([d.decision.action, d.retry], ['SKIP', true]);
  assert.equal(r.aiRequests.length, 0);
});

test('contrarian: a failed answer is a final skip', () => {
  const r = contra(mkAi({ [BATCH]: { ok: false, error: 'HTTP 503' } }), withMoney(500_000, 0));
  const d = r.decisions.find((x) => x.agent === 'contrarian');
  assert.deepEqual([d.decision.reason, d.retry], [COULDNT_DECIDE, false]);
});

// ---------------------------------------------------------------- other cases

test('elsewhere (aiMarkets) the contrarian only answers money that is not the house agents\' own', () => {
  const house = { '1:20': { up: 500_000, down: 0 } };
  const agents = KEYS.map((k) => agent(k, k === 'coin-flipper' ? { positions: house } : {}));
  const done = new Set(['1:20:coin-flipper']);
  const quiet = planTick(snap(6012, [BTC10(6012), ETH5(6012, { rounds: { 20: { state: 'Unsettled', up: 500_000, down: 0 } } })], { agents }), cfg(mkAi(), { aiMarkets: ['BTC/USD 10m'] }), done);
  assert.ok(!quiet.decisions.some((d) => d.marketId === 1 && d.agent === 'contrarian'));
  const real = planTick(snap(6012, [BTC10(6012), ETH5(6012, { rounds: { 20: { state: 'Unsettled', up: 500_000, down: 800_000 } } })], { agents }), cfg(mkAi(), { aiMarkets: ['BTC/USD 10m'] }), done);
  assert.ok(real.decisions.some((d) => d.marketId === 1 && d.agent === 'contrarian'));
});

test('without cfg.ai the agents use their plain rules (tests and simulation)', () => {
  const r = planTick(snap(6070, [BTC10(6070)]), { ...CFG, random: mulberry32(7) });
  assert.deepEqual(r.aiRequests, []);
  assert.ok(bets(r).some((b) => b.agent === 'trend-follower' && !b.ai));
});

test('the runner looks more often around an opening, then goes back to the slow rhythm', () => {
  const at = (now) => tickDelay(snap(now, [BTC10(now)]), cfg(mkAi()));
  assert.equal(at(5900), CFG.tickSeconds);
  assert.equal(at(5990), CFG.fastTickSeconds, 'a slow tick from here would reach past the moment the AI is asked');
  assert.equal(at(6020), CFG.fastTickSeconds);
  assert.equal(at(6100), CFG.tickSeconds);
});

// ---------------------------------------------------------------- the stateful asker

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-ai-'));
const REQ = {
  id: BATCH, coin: 'BTC/USD', opensAt: 6000, candles: CANDLES,
  frames: [{ marketId: 3, market: 'BTC/USD 5m', label: '5m', roundSeconds: 300, round: 20, secondsToLock: 290 }, { marketId: 0, market: 'BTC/USD 10m', label: '10m', roundSeconds: 600, round: 11, secondsToLock: 590 }],
};
const settle = () => new Promise((r) => setTimeout(r, 10));
const good = { ok: true, value: { '5m': ans('UP', 'DOWN'), '10m': { ...ans('DOWN', 'UP'), 'chart-reader': null } }, tokensIn: 2000, tokensOut: 300, latencyMs: 900, attempts: 1 };

test('createAi: one call per batch id, logged with model, tokens and cost, key never logged', async () => {
  const dir = tmp(); const file = path.join(dir, 'ai-log.jsonl'); const lines = [];
  let seen; let calls = 0;
  const askFn = async (o) => { calls++; seen = o; assert.equal(o.apiKey, 'SECRETKEY123'); return good; };
  const ai = createAi({ env: { GEMINI_API_KEY: 'SECRETKEY123', GEMINI_MODEL: 'gemini-test' }, live: true, log: (m) => lines.push(m), askFn, file });
  ai.request(REQ); ai.request(REQ); ai.request(REQ);
  await settle();
  assert.equal(calls, 1);
  assert.match(seen.user, /- 5m:/);
  assert.match(seen.user, /- 10m:/);
  assert.deepEqual(seen.schema.properties.frames.items.properties.frame.enum, ['5m', '10m']);
  const res = ai.results.get(BATCH);
  assert.equal(res.ok, true);
  assert.deepEqual(res.decisions[3]['trend-follower'], { call: 'UP', reason: 'Trend says UP.' });
  assert.deepEqual(res.decisions[0]['chart-reader'], null);
  const row = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.deepEqual([row.model, row.tokensIn, row.tokensOut, row.ok, row.decisions, row.frames], ['gemini-test', 2000, 300, true, 5, ['5m', '10m']]);
  assert.equal(row.costUsd, 0.00135); // (2000*0.30 + 300*2.50) / 1e6
  assert.ok(lines.some((l) => /5m trend-follower: UP "Trend says UP\."/.test(l)), 'every decision and its reason is in the log');
  assert.ok(!lines.join('\n').includes('SECRETKEY123') && !JSON.stringify(row).includes('SECRETKEY123'));
  assert.match(ai.summary(), /1 calls/);
  fs.rmSync(dir, { recursive: true });
});

test('createAi: fresher candles from prepare() are the ones sent, cut to the longest frame', async () => {
  const dir = tmp(); let seen;
  const ai = createAi({ env: { GEMINI_API_KEY: 'k' }, live: true, askFn: async (o) => { seen = o; return good; }, file: path.join(dir, 'l.jsonl') });
  const fresh = CANDLES.map((c) => ({ ...c, close: 999 }));
  ai.request(REQ, { prepare: async () => fresh });
  await settle();
  assert.equal(seen.user.split('\n').filter((l) => /^\d\d:\d\d /.test(l)).length, 30);
  assert.match(seen.user, /Current price: 999/);
  fs.rmSync(dir, { recursive: true });
});

test('createAi: a failed call is recorded as a failure', async () => {
  const dir = tmp();
  const ai = createAi({ env: { GEMINI_API_KEY: 'k' }, live: true, askFn: async () => ({ ok: false, error: 'timed out', latencyMs: 20000, attempts: 2 }), file: path.join(dir, 'l.jsonl') });
  ai.request(REQ); await settle();
  assert.deepEqual([ai.results.get(BATCH).ok, ai.results.get(BATCH).error], [false, 'timed out']);
  fs.rmSync(dir, { recursive: true });
});

test('createAi: no key means every agent fails at once and says why once', () => {
  const lines = [];
  const ai = createAi({ env: {}, live: true, log: (m) => lines.push(m), file: path.join(tmp(), 'l.jsonl') });
  ai.request(REQ); ai.request({ ...REQ, id: 'x2' });
  assert.equal(ai.results.get(BATCH).ok, false);
  assert.equal(lines.filter((l) => /GEMINI_API_KEY is not set/.test(l)).length, 1);
});

test('createAi: the daily limit stops new calls', async () => {
  const dir = tmp(); let calls = 0;
  const ai = createAi({ env: { GEMINI_API_KEY: 'k', GEMINI_MAX_CALLS_PER_DAY: '2', GEMINI_MAX_PER_MINUTE: '99' }, live: true, askFn: async () => { calls++; return good; }, file: path.join(dir, 'l.jsonl') });
  for (let i = 0; i < 4; i++) ai.request({ ...REQ, id: 'r' + i });
  await settle();
  assert.equal(calls, 2);
  assert.equal(ai.results.get('r3').error, 'daily limit reached');
  fs.rmSync(dir, { recursive: true });
});

test('createAi: retries count toward the daily limit, and the limit also stops a retry', async () => {
  const dir = tmp(); const lines = []; const retried = [];
  // a call that retries twice (3 requests in all) before it answers, as askGemini does through beforeRetry
  const askFn = async (o) => { retried.push(o.beforeRetry(), o.beforeRetry()); return { ...good, attempts: 3 }; };
  const ai = createAi({ env: { GEMINI_API_KEY: 'k', GEMINI_MAX_CALLS_PER_DAY: '4', GEMINI_MAX_PER_MINUTE: '99' }, live: true, log: (m) => lines.push(m), askFn, file: path.join(dir, 'l.jsonl') });
  ai.request({ ...REQ, id: 'a' }); await settle();
  assert.deepEqual(retried, [true, true]);
  assert.match(ai.summary(), /3 calls/);       // the first try and both retries
  ai.request({ ...REQ, id: 'b' }); await settle();
  assert.deepEqual(retried, [true, true, false, false]); // 'b' is the 4th request (allowed); both its retries would be the 5th and 6th: refused, the limit of 4 holds
  assert.match(ai.summary(), /4 calls/);
  ai.request({ ...REQ, id: 'c' });
  assert.equal(ai.results.get('c').error, 'daily limit reached');
  fs.rmSync(dir, { recursive: true });
});

test('createAi: retries count toward the per-minute limit too', async () => {
  const dir = tmp(); const answers = [];
  const ai = createAi({ env: { GEMINI_API_KEY: 'k', GEMINI_MAX_PER_MINUTE: '2' }, live: true, askFn: async (o) => { answers.push(o.beforeRetry(), o.beforeRetry()); return good; }, file: path.join(dir, 'l.jsonl') });
  ai.request({ ...REQ, id: 'm1' }); await settle();
  assert.deepEqual(answers, [true, false]); // the first try and one retry fill the 2 a minute
  fs.rmSync(dir, { recursive: true });
});

test('createAi: the deadline is one minute before the first frame locks', async () => {
  const dir = tmp(); let seen; const t0 = 1_790_000_000_000;
  const ai = createAi({ env: { GEMINI_API_KEY: 'k' }, live: true, now: () => t0, askFn: async (o) => { seen = o; return good; }, file: path.join(dir, 'l.jsonl') });
  ai.request(REQ); await settle(); // frames lock in 290 s and 590 s
  assert.equal(seen.deadline, t0 + 230_000);
  fs.rmSync(dir, { recursive: true });
});

test('createAi: more calls than the per-minute limit are skipped, not queued', async () => {
  const dir = tmp(); let calls = 0;
  const ai = createAi({ env: { GEMINI_API_KEY: 'k', GEMINI_MAX_PER_MINUTE: '2' }, live: true, askFn: async () => { calls++; return good; }, file: path.join(dir, 'l.jsonl') });
  for (let i = 0; i < 4; i++) ai.request({ ...REQ, id: 'p' + i });
  await settle();
  assert.equal(calls, 2);
  assert.equal(ai.results.get('p3').error, 'too many calls at once');
  fs.rmSync(dir, { recursive: true });
});

test('createAi: after an HTTP 429 nothing is asked for 5 minutes, then it asks again', async () => {
  const dir = tmp(); let calls = 0; let t = 1_790_000_000_000; const lines = [];
  const ai = createAi({ env: { GEMINI_API_KEY: 'k' }, live: true, log: (m) => lines.push(m), now: () => t, askFn: async () => { calls++; return calls === 1 ? { ok: false, error: 'HTTP 429', latencyMs: 1, attempts: 2 } : good; }, file: path.join(dir, 'l.jsonl') });
  ai.request({ ...REQ, id: 'a' }); await settle();
  ai.request({ ...REQ, id: 'b' });
  assert.equal(ai.results.get('b').error, 'rate limited');
  assert.equal(calls, 1);
  assert.ok(lines.some((l) => /too many requests/.test(l)));
  t += 5 * 60_000 + 1;
  ai.request({ ...REQ, id: 'c' }); await settle();
  assert.equal(ai.results.get('c').ok, true);
  fs.rmSync(dir, { recursive: true });
});

test('createAi: a dry run asks nothing', () => {
  const lines = []; let calls = 0;
  const ai = createAi({ env: { GEMINI_API_KEY: 'k' }, live: false, log: (m) => lines.push(m), askFn: async () => { calls++; }, file: path.join(tmp(), 'l.jsonl') });
  ai.request(REQ);
  assert.equal(calls, 0);
  assert.equal(ai.results.size, 0);
  assert.match(lines[0], /WOULD ask/);
});

// ---------------------------------------------------------------- the notes writer

const NOTE = { m: 0, r: 11, a: 'trend-follower', s: 'called', c: 'UP', t: 'Higher highs.', at: 1_790_000_000, model: 'gemini-test' };

test('notes: written to the local file and to Upstash with an expiry', async () => {
  const dir = tmp(); const file = path.join(dir, 'n.jsonl'); let sent;
  const notes = createNotes({ env: { UPSTASH_REDIS_REST_URL: 'https://x.upstash.io/', UPSTASH_REDIS_REST_TOKEN: 'tok' }, file, fetchFn: async (url, init) => { sent = { url, init }; return { ok: true }; } });
  await notes.publish(NOTE);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8').trim()), NOTE);
  assert.equal(sent.url, 'https://x.upstash.io');
  assert.equal(sent.init.headers.authorization, 'Bearer tok');
  const body = JSON.parse(sent.init.body);
  assert.deepEqual([body[0], body[1], body[3], body[4]], ['SET', noteKey(NOTE), 'EX', 259200]);
  assert.deepEqual(JSON.parse(body[2]), NOTE);
  fs.rmSync(dir, { recursive: true });
});

test('notes: a failing Upstash never throws and the token is never logged', async () => {
  const dir = tmp(); const lines = [];
  const notes = createNotes({ env: { UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'tok-secret' }, file: path.join(dir, 'n.jsonl'), log: (m) => lines.push(m), fetchFn: async () => { throw new Error('offline tok-secret'); } });
  await notes.publish(NOTE); await notes.publish(NOTE);
  assert.equal(lines.length, 1, 'warned once');
  assert.ok(!lines[0].includes('tok-secret'));
  fs.rmSync(dir, { recursive: true });
});

test('notes: with no Upstash settings only the local file is written', async () => {
  const dir = tmp(); let called = false;
  const notes = createNotes({ env: {}, file: path.join(dir, 'n.jsonl'), fetchFn: async () => { called = true; } });
  await notes.publish(NOTE);
  assert.equal(called, false);
  assert.equal(notes.remote, false);
  fs.rmSync(dir, { recursive: true });
});
