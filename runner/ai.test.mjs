// Tests for the AI side of the runner: the planner's AI path, the stateful asker, and the notes writer.  Run:  node --test runner/ai.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CFG } from './config.mjs';
import { planTick } from './plan.mjs';
import { createAi } from './ai.mjs';
import { createNotes, noteKey } from './notes.mjs';
import { COULDNT_DECIDE } from '../agents/ai.mjs';
import { mulberry32 } from './simulate.mjs';

const KEYS = ['trend-follower', 'contrarian', 'chart-reader', 'coin-flipper'];
const id = (n) => (1n << 64n) | BigInt(n);
const upd = (n, updatedAt, usd) => ({ id: id(n), updatedAt, price: BigInt(Math.round(usd * 1e8)) });
const FEED = [upd(1, 4810, 100), upd(2, 5390, 101), upd(3, 5410, 101), upd(4, 5990, 102)];
const market = (over = {}) => ({ id: 0, name: 'BTC/USD', roundLength: 600, startOffset: 0, minStake: 100_000, paused: false, nextRound: 11, feed: { updates: FEED }, rounds: {}, ...over });
const agent = (key, over = {}) => ({ key, balance: 5_000_000, allowance: 10_000_000, positions: {}, ...over });
const CANDLES = Array.from({ length: 30 }, (_, i) => ({ time: 1_790_000_000 + i * 60, open: 100 + i, close: 101 + i, high: 102 + i, low: 99 + i }));
const snap = (now, m = market(), candles = CANDLES) => ({ now, markets: [m], agents: KEYS.map((k) => agent(k)), candles: { 'BTC/USD': candles } });
const mkAi = (results = {}) => ({ results: new Map(Object.entries(results)) });
const cfg = (ai, over = {}) => ({ ...CFG, random: mulberry32(7), ai, ...over });
const bets = (r) => r.actions.filter((a) => a.type === 'bet');
const AI3 = ['trend-follower', 'chart-reader', 'contrarian'];

// ---------------------------------------------------------------- the planner

test('an AI agent that is due makes a request first and bets nothing', () => {
  const r = planTick(snap(6060), cfg(mkAi()));
  assert.deepEqual(r.aiRequests.map((q) => q.agent).sort(), ['chart-reader', 'trend-follower']);
  assert.deepEqual(bets(r).map((b) => b.agent), ['coin-flipper'], 'the coin flipper stays random and does not wait');
  const q = r.aiRequests.find((x) => x.agent === 'trend-follower');
  assert.equal(q.id, '0:11:trend-follower');
  assert.equal(q.candles.length, 30);
  assert.equal(q.forcedSide, null);
  assert.deepEqual(q.bets, { up: 0, down: 0 });
});

test('a good answer becomes a bet carrying the reason', () => {
  const ai = mkAi({ '0:11:trend-follower': { ok: true, call: 'DOWN', reason: 'Momentum is fading.' } });
  const r = planTick(snap(6060), cfg(ai));
  const b = bets(r).find((x) => x.agent === 'trend-follower');
  assert.equal(b.side, 'DOWN');
  assert.equal(b.stake, 500_000);
  assert.equal(b.reason, 'Momentum is fading.');
  assert.equal(b.ai, true);
  assert.ok(!r.aiRequests.some((q) => q.agent === 'trend-follower'));
});

test('a failed answer is a final skip that says Couldn\'t decide this round', () => {
  const ai = mkAi({ '0:11:chart-reader': { ok: false, error: 'timed out' } });
  const r = planTick(snap(6060), cfg(ai));
  const d = r.decisions.find((x) => x.agent === 'chart-reader');
  assert.equal(d.decision.action, 'SKIP');
  assert.equal(d.decision.reason, COULDNT_DECIDE);
  assert.equal(d.decision.aiFailed, true);
  assert.equal(d.retry, false, 'not looked at again');
  assert.ok(!bets(r).some((b) => b.agent === 'chart-reader'));
});

test('too few candles is a skip with no request', () => {
  const r = planTick(snap(6060, market(), CANDLES.slice(0, 5)), cfg(mkAi()));
  assert.equal(r.aiRequests.length, 0);
  const d = r.decisions.find((x) => x.agent === 'trend-follower');
  assert.equal(d.decision.reason, COULDNT_DECIDE);
});

test('an agent without enough money skips without asking the model', () => {
  const s = snap(6060);
  s.agents.find((a) => a.key === 'trend-follower').balance = 10_000;
  const r = planTick(s, cfg(mkAi()));
  assert.ok(!r.aiRequests.some((q) => q.agent === 'trend-follower'));
  assert.equal(r.decisions.find((x) => x.agent === 'trend-follower').decision.action, 'SKIP');
});

test('the contrarian waits for the early agents, and an empty round is looked at again without asking the model', () => {
  const done = new Set(['0:11:trend-follower', '0:11:chart-reader', '0:11:coin-flipper']);
  const r = planTick(snap(6090), cfg(mkAi()), done);
  assert.equal(r.aiRequests.length, 0);
  const d = r.decisions.find((x) => x.agent === 'contrarian');
  assert.equal(d.decision.action, 'SKIP');
  assert.equal(d.retry, true);
  // an early agent still waiting for its answer holds the contrarian back
  const waiting = planTick(snap(6090), cfg(mkAi()), new Set(['0:11:trend-follower', '0:11:coin-flipper']));
  assert.ok(!waiting.aiRequests.some((q) => q.agent === 'contrarian'));
});

test('contrarian with one empty side: the empty side is fixed for the model', () => {
  const done = new Set(['0:11:trend-follower', '0:11:chart-reader', '0:11:coin-flipper']);
  const m = market({ rounds: { 11: { state: 'Unsettled', up: 500_000, down: 0 } } });
  const r = planTick(snap(6090, m), cfg(mkAi()), done);
  const q = r.aiRequests.find((x) => x.agent === 'contrarian');
  assert.equal(q.forcedSide, 'DOWN');
  assert.deepEqual(q.bets, { up: 500_000, down: 0 });
  const m2 = market({ rounds: { 11: { state: 'Unsettled', up: 0, down: 700_000 } } });
  assert.equal(planTick(snap(6090, m2), cfg(mkAi()), done).aiRequests[0].forcedSide, 'UP');
});

test('contrarian with money on both sides (even split too) chooses freely', () => {
  const done = new Set(['0:11:trend-follower', '0:11:chart-reader', '0:11:coin-flipper']);
  for (const [up, down] of [[500_000, 300_000], [400_000, 400_000]]) {
    const m = market({ rounds: { 11: { state: 'Unsettled', up, down } } });
    const q = planTick(snap(6090, m), cfg(mkAi()), done).aiRequests.find((x) => x.agent === 'contrarian');
    assert.equal(q.forcedSide, null);
  }
});

test('contrarian answer becomes a bet; a forced answer keeps its reason', () => {
  const done = new Set(['0:11:trend-follower', '0:11:chart-reader', '0:11:coin-flipper']);
  const m = market({ rounds: { 11: { state: 'Unsettled', up: 500_000, down: 0 } } });
  const ai = mkAi({ '0:11:contrarian': { ok: true, call: 'DOWN', reason: 'DOWN has no money yet, and the run is stretched.' } });
  const b = bets(planTick(snap(6090, m), cfg(ai), done))[0];
  assert.deepEqual([b.agent, b.side, b.stake], ['contrarian', 'DOWN', 400_000]);
  assert.match(b.reason, /stretched/);
});

test('without cfg.ai the agents use their plain rules (tests and simulation)', () => {
  const r = planTick(snap(6060), { ...CFG, random: mulberry32(7) });
  assert.deepEqual(r.aiRequests, []);
  assert.deepEqual(bets(r).map((b) => b.agent), ['trend-follower', 'chart-reader', 'coin-flipper']);
  assert.ok(AI3.length === 3);
});

// ---------------------------------------------------------------- the stateful asker

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-ai-'));
const REQ = { id: '0:11:trend-follower', agent: 'trend-follower', market: 'BTC/USD 5m', marketId: 0, round: 11, roundSeconds: 300, secondsToLock: 90, candles: CANDLES, bets: { up: 0, down: 0 }, forcedSide: null };
const settle = () => new Promise((r) => setTimeout(r, 10));

test('createAi: one call per decision id, logged with model, tokens and cost, key never logged', async () => {
  const dir = tmp(); const file = path.join(dir, 'ai-log.jsonl'); const lines = [];
  let calls = 0;
  const askFn = async (o) => { calls++; assert.equal(o.apiKey, 'SECRETKEY123'); return { ok: true, call: 'UP', reason: 'Higher highs.', tokensIn: 1000, tokensOut: 40, latencyMs: 800, attempts: 1 }; };
  const ai = createAi({ env: { GEMINI_API_KEY: 'SECRETKEY123', GEMINI_MODEL: 'gemini-test' }, live: true, log: (m) => lines.push(m), askFn, file });
  ai.request(REQ); ai.request(REQ); ai.request(REQ);
  await settle();
  assert.equal(calls, 1);
  assert.deepEqual(ai.results.get(REQ.id), { ...ai.results.get(REQ.id), ok: true, call: 'UP', reason: 'Higher highs.' });
  const row = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.deepEqual([row.model, row.tokensIn, row.tokensOut, row.ok, row.call], ['gemini-test', 1000, 40, true, 'UP']);
  assert.equal(row.costUsd, 0.0004); // (1000*0.30 + 40*2.50) / 1e6
  assert.ok(!lines.join('\n').includes('SECRETKEY123') && !JSON.stringify(row).includes('SECRETKEY123'));
  assert.match(ai.summary(), /1 calls/);
  fs.rmSync(dir, { recursive: true });
});

test('createAi: a failed call is recorded as a failure', async () => {
  const dir = tmp();
  const ai = createAi({ env: { GEMINI_API_KEY: 'k' }, live: true, askFn: async () => ({ ok: false, error: 'timed out', latencyMs: 20000, attempts: 2 }), file: path.join(dir, 'l.jsonl') });
  ai.request(REQ); await settle();
  assert.deepEqual([ai.results.get(REQ.id).ok, ai.results.get(REQ.id).error], [false, 'timed out']);
  fs.rmSync(dir, { recursive: true });
});

test('createAi: no key means every agent fails at once and says why once', () => {
  const lines = [];
  const ai = createAi({ env: {}, live: true, log: (m) => lines.push(m), file: path.join(tmp(), 'l.jsonl') });
  ai.request(REQ); ai.request({ ...REQ, id: 'x2' });
  assert.equal(ai.results.get(REQ.id).ok, false);
  assert.equal(lines.filter((l) => /GEMINI_API_KEY is not set/.test(l)).length, 1);
});

test('createAi: the daily limit stops new calls', async () => {
  const dir = tmp(); let calls = 0;
  const ai = createAi({ env: { GEMINI_API_KEY: 'k', GEMINI_MAX_CALLS_PER_DAY: '2' }, live: true, askFn: async () => { calls++; return { ok: true, call: 'UP', reason: 'x', tokensIn: 1, tokensOut: 1, latencyMs: 1, attempts: 1 }; }, file: path.join(dir, 'l.jsonl') });
  for (let i = 0; i < 4; i++) ai.request({ ...REQ, id: 'r' + i });
  await settle();
  assert.equal(calls, 2);
  assert.equal(ai.results.get('r3').error, 'daily limit reached');
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

// ---------------------------------------------------------------- which markets the AI agents play

const ETH = (over = {}) => market({ id: 1, name: 'ETH/USD', ...over });
const snapTwo = (now, eth) => ({ now, markets: [market(), eth], agents: KEYS.map((k) => agent(k)), candles: { 'BTC/USD': CANDLES, 'ETH/USD': CANDLES } });

test('markets: the AI agents play only the markets in aiMarkets, the coin flipper plays all', () => {
  const r = planTick(snapTwo(6060, ETH()), cfg(mkAi(), { aiMarkets: ['BTC/USD'] }));
  assert.deepEqual(r.aiRequests.map((q) => `${q.marketId}:${q.agent}`).sort(), ['0:chart-reader', '0:trend-follower']);
  assert.deepEqual(bets(r).map((b) => `${b.market}:${b.agent}`).sort(), ['0:coin-flipper', '1:coin-flipper']);
  const all = planTick(snapTwo(6060, ETH()), cfg(mkAi(), { aiMarkets: 'all' }));
  assert.equal(all.aiRequests.length, 4);
});

test('markets: elsewhere the contrarian only answers money that is not the house agents\' own', () => {
  const house = { '1:11': { up: 500_000, down: 0 } };
  const flipperOnly = (r) => ({ ...r, agents: r.agents.map((a) => (a.key === 'coin-flipper' ? { ...a, positions: house } : a)) });
  const done = new Set(['1:11:coin-flipper']);
  const m1 = ETH({ rounds: { 11: { state: 'Unsettled', up: 500_000, down: 0 } } });
  // only the coin flipper's money: the contrarian stays out and says nothing
  const quiet = planTick(flipperOnly(snapTwo(6090, m1)), cfg(mkAi(), { aiMarkets: ['BTC/USD'] }), done);
  assert.ok(!quiet.aiRequests.some((q) => q.marketId === 1));
  assert.ok(!quiet.decisions.some((d) => d.marketId === 1 && d.agent === 'contrarian'));
  // a real player's money is on it too: the contrarian answers
  const m2 = ETH({ rounds: { 11: { state: 'Unsettled', up: 500_000, down: 800_000 } } });
  const answers = planTick(flipperOnly(snapTwo(6090, m2)), cfg(mkAi(), { aiMarkets: ['BTC/USD'] }), done);
  assert.deepEqual(answers.aiRequests.filter((q) => q.marketId === 1).map((q) => q.agent), ['contrarian']);
});

test('createAi: more calls than the per-minute limit are skipped, not queued', async () => {
  const dir = tmp(); let calls = 0;
  const ai = createAi({ env: { GEMINI_API_KEY: 'k', GEMINI_MAX_PER_MINUTE: '2' }, live: true, askFn: async () => { calls++; return { ok: true, call: 'UP', reason: 'x', tokensIn: 1, tokensOut: 1, latencyMs: 1, attempts: 1 }; }, file: path.join(dir, 'l.jsonl') });
  for (let i = 0; i < 4; i++) ai.request({ ...REQ, id: 'p' + i });
  await settle();
  assert.equal(calls, 2);
  assert.equal(ai.results.get('p3').error, 'too many calls at once');
  fs.rmSync(dir, { recursive: true });
});
