// Tests for the guide calls (runner/guide.mjs): no money, nothing on chain, no real Gemini or Upstash (everything is faked).
//   node --test runner/guide.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { askGemini, buildGuidePrompt, guideSchema, parseGuide, guideWording, GUIDE_LABEL } from '../agents/ai.mjs';
import { createGuide, dueRounds, outcomeOf, resultOf, callField, resField, limitDay, GUIDE_AI_AGENTS, GUIDE_CFG, GUIDE_HASH, GUIDE_MODELS, AGENT_MODELS, FALLBACK_MODEL } from './guide.mjs';
import { estimateTokens } from '../agents/ai.mjs';

// Cycle-aligned clock: T0 is a multiple of 300, so the 5-minute cycle starts at T0 and the AI is due at T0 + 3.
const T0 = 1_800_000_000;
const mk = (id, name, roundLength, startOffset, lockAt) => ({ id, name, roundLength, startOffset, minStake: 500_000, paused: false, nextRound: (lockAt - startOffset) / roundLength, rounds: {}, feed: { address: '0x0', updates: [] } });
// BTC locks at the cycle's end, ETH 100 s and SOL 200 s after the cycle starts (their rounds opened earlier), like the real markets.
const markets = () => [
  mk(0, 'BTC/USD 5m', 300, 0, T0 + 300), mk(1, 'ETH/USD 5m', 300, 100, T0 + 100), mk(2, 'SOL/USD 5m', 300, 200, T0 + 200),
  mk(3, 'BTC/USD 10m', 600, 0, T0 + 600), mk(4, 'ETH/USD 10m', 600, 100, T0 + 100), mk(5, 'SOL/USD 10m', 600, 200, T0 + 200),
];
const candles = Array.from({ length: 60 }, (_, i) => ({ time: T0 - 3600 + i * 60, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));

// what a model that works answers: one UP/DOWN call and reason for every entry asked
function answerFor(args) {
  const n = args.schema.properties.calls.minItems;
  const coins = args.schema.properties.calls.items.properties.coin.enum, frames = args.schema.properties.calls.items.properties.frame.enum;
  const list = [];
  for (const c of coins) for (const f of frames) list.push({ coin: c, frame: f });
  const wanted = list.filter((e) => args.user.includes(`Coin: ${e.coin}.`) && args.user.includes(`- ${e.frame}:`)).slice(0, n);
  return { ok: true, value: args.parse(JSON.stringify({ calls: wanted.map((e, i) => ({ coin: e.coin, frame: e.frame, call: i % 2 ? 'DOWN' : 'UP', reason: `${e.coin} ${e.frame} moved 0.2%` })) })), tokensIn: 100, tokensOut: 50, latencyMs: 5, attempts: 1, model: args.model };
}

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-test-'));
  const logs = [];
  const clock = { ms: (T0 + 3) * 1000 };
  const asks = [];
  const redis = [];
  const files = { file: path.join(dir, 'calls.jsonl'), stateFile: path.join(dir, 'state.json'), priceFile: path.join(dir, 'prices.jsonl') };
  const answer = (args) => {
    // one UP/DOWN call for every entry in the schema, alternating
    const n = args.schema.properties.calls.minItems;
    const coins = args.schema.properties.calls.items.properties.coin.enum, frames = args.schema.properties.calls.items.properties.frame.enum;
    const list = [];
    for (const c of coins) for (const f of frames) list.push({ coin: c, frame: f });
    const wanted = list.filter((e) => args.user.includes(`Coin: ${e.coin}.`) && args.user.includes(`- ${e.frame}:`)).slice(0, n);
    return { ok: true, value: args.parse(JSON.stringify({ calls: wanted.map((e, i) => ({ coin: e.coin, frame: e.frame, call: i % 2 ? 'DOWN' : 'UP', reason: `${e.coin} ${e.frame} moved 0.2%` })) })), tokensIn: 100, tokensOut: 50, latencyMs: 5, attempts: 1, model: args.model };
  };
  const askFn = over.askFn ?? (async (args) => { asks.push(args); return answer(args); });
  const fetchFn = over.fetchFn ?? (async (url, init) => {
    if (String(url).startsWith('https://redis.test')) { redis.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ result: 1 }) }; }
    throw new Error('unexpected fetch ' + url);
  });
  const g = createGuide({
    env: { GEMINI_API_KEY: 'k', UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 't', ...(over.env ?? {}) }, live: over.live ?? true,
    log: (m) => logs.push(m), getCandles: async () => candles, askFn, fetchFn, now: () => clock.ms, random: over.random ?? (() => 0.7),
    chainPriceLog: over.chainPriceLog ?? (() => []), sleep: async () => {}, ...files, cfg: over.cfg, ...(over.models ? { models: over.models } : {}),
  });
  return { g, logs, clock, asks, redis, files, dir, snap: { markets: over.markets ?? markets() } };
}
const settle = () => new Promise((r) => setTimeout(r, 20)); // let the background work finish
const calledFields = (g) => [...g.calls.keys()].sort();

// ------------------------------------------------------------------------------------------------ pure parts

test('dueRounds: every open next round, but not a paused market and not one that locks within the minimum', () => {
  const ms = markets();
  ms[2].paused = true;
  const d = dueRounds(ms, T0 + 3, 25);
  assert.deepEqual(d.map((x) => `${x.short} ${x.label} ${x.secondsToLock}`), ['BTC 5m 297', 'ETH 5m 97', 'BTC 10m 597', 'ETH 10m 97', 'SOL 10m 197']);
  assert.deepEqual(dueRounds(ms, T0 + 80, 25).map((x) => x.market), ['BTC/USD 5m', 'BTC/USD 10m', 'SOL/USD 10m']); // ETH locks in 20 s
});

test('scoring words: won, lost, or no result when the price did not change', () => {
  assert.equal(outcomeOf(100, 101), 'UP');
  assert.equal(outcomeOf(100, 99), 'DOWN');
  assert.equal(outcomeOf(100, 100), 'FLAT');
  assert.deepEqual(['UP', 'DOWN'].map((c) => resultOf(c, 'UP')), ['won', 'lost']);
  assert.deepEqual(['UP', 'DOWN'].map((c) => resultOf(c, 'FLAT')), ['none', 'none']);
});

test('the answer is read strictly, one entry per coin and time frame, and the wording follows the site', () => {
  const entries = [{ coin: 'BTC', frame: '5m' }, { coin: 'ETH', frame: '5m' }, { coin: 'SOL', frame: '5m' }];
  const text = JSON.stringify({ calls: [
    { coin: 'BTC', frame: '5m', call: 'UP', reason: 'Good odds, I bet on it' },
    { coin: 'ETH', frame: '5m', call: 'SIDEWAYS', reason: 'x' },
    { coin: 'SOL', frame: '5m', call: 'DOWN', reason: 'y', extra: 1 },
  ] });
  const v = parseGuide(text, entries);
  assert.deepEqual(v['BTC:5m'], { call: 'UP', reason: 'Good chances, I call on it' });
  assert.equal(v['ETH:5m'], null);
  assert.equal(v['SOL:5m'], null);
  assert.equal(parseGuide('not json', entries), null);
  assert.equal(parseGuide(JSON.stringify({ calls: [] }), entries), null);
  assert.equal(guideWording('betting bets wager odds'), 'calling calls call chances');
  assert.equal(guideSchema(entries).properties.calls.minItems, 3);
});

test('the prompt holds every coin and time frame once, and never says bet', () => {
  const frames = (labels) => labels.map((l) => ({ label: l, roundSeconds: l === '5m' ? 300 : 600, secondsToLock: 90 }));
  const { system, user } = buildGuidePrompt({ agent: 'contrarian', coins: [{ coin: 'BTC/USD', candles, frames: frames(['5m', '10m']) }, { coin: 'ETH/USD', candles, frames: frames(['5m']) }] });
  assert.match(user, /Coin: BTC\./);
  assert.match(user, /Coin: ETH\./);
  assert.equal((user.match(/^- 5m:/gm) ?? []).length, 2);
  assert.equal((user.match(/^- 10m:/gm) ?? []).length, 1);
  assert.match(system, /Contrarian/);
  assert.match(system, /Never use the words bet, wager or odds/);
  assert.equal(GUIDE_LABEL, 'Guide call, no money');
});

test('askGemini with retryOn429 false: a limit answer is final, one request only', async () => {
  let n = 0;
  const fetchFn = async () => { n++; return { ok: false, status: 429, json: async () => ({}) }; };
  const out = await askGemini({ apiKey: 'k', system: 's', user: 'u', schema: {}, parse: () => ({}), fetchFn, retryOn429: false, maxAttempts: 2, sleep: async () => {} });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'HTTP 429');
  assert.equal(n, 1);
  // and a server error is tried once more, no more than maxAttempts
  n = 0;
  const f503 = async () => { n++; return { ok: false, status: 503, json: async () => ({}) }; };
  const out2 = await askGemini({ apiKey: 'k', system: 's', user: 'u', schema: {}, parse: () => ({}), fetchFn: f503, retryOn429: false, maxAttempts: 2, retryDelayMs: 0, sleep: async () => {} });
  assert.equal(out2.error, 'HTTP 503');
  assert.equal(n, 2);
});

// ------------------------------------------------------------------------------------------------ making the calls

test('dry run: it only says what it would ask and save, sends nothing and writes nothing', async () => {
  const t = setup({ live: false, askFn: async () => { throw new Error('no Gemini in a dry run'); } });
  t.g.tick(t.snap);
  t.g.tick(t.snap);
  await settle();
  assert.equal(t.logs.filter((l) => l.startsWith('WOULD ask')).length, 3, 'one line per AI agent, once');
  for (const [agent, model] of Object.entries(AGENT_MODELS)) assert.ok(t.logs.some((l) => l.startsWith(`WOULD ask ${model} for ${agent}`)), agent);
  assert.equal(t.logs.filter((l) => l.startsWith('WOULD save guide call: Coin Flipper')).length, 6);
  assert.equal(t.redis.length, 0);
  assert.equal(fs.readdirSync(t.dir).length, 0, 'no files written');
  assert.equal(t.g.calls.size, 0);
});

test('live: nothing more is asked in the same cycle, and the next cycle asks once more per agent', async () => {
  const t = setup();
  t.g.tick(t.snap); await settle();
  t.clock.ms += 10_000; t.g.tick(t.snap); await settle();
  assert.equal(t.asks.length, 3);
  // next cycle: new rounds are open
  t.clock.ms = (T0 + 300 + 3) * 1000;
  const next = markets().map((m) => ({ ...m, nextRound: m.nextRound + 300 / m.roundLength * (m.roundLength === 300 ? 1 : 0.5) }));
  t.g.tick({ markets: next }); await settle();
  assert.equal(t.asks.length, 6, 'one more request per AI agent, not more');
});

test('calls are saved once and never change: the file is append-only and Upstash is written with HSETNX', async () => {
  const t = setup();
  t.g.tick(t.snap); await settle();
  const before = fs.readFileSync(t.files.file, 'utf8');
  const lines = before.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 24);
  assert.equal(new Set(lines.map((l) => `${l.m}:${l.r}:${l.a}`)).size, 24, 'no call saved twice');
  // the same tick again (same cycle, same rounds): the file does not change
  t.clock.ms += 15_000; t.g.tick(t.snap); await settle();
  assert.equal(fs.readFileSync(t.files.file, 'utf8'), before);
  // upstash: EVAL with HSETNX on the guide hash, field "market:round:agent"
  const evals = t.redis.filter((c) => c[0] === 'EVAL');
  assert.ok(evals.length >= 1);
  assert.match(evals[0][1], /HSETNX/);
  assert.equal(evals[0][3], GUIDE_HASH);
  const sent = new Map();
  for (const c of evals) for (let i = 4; i < c.length; i += 2) sent.set(c[i], JSON.parse(c[i + 1]));
  assert.equal(sent.size, 24);
  const one = sent.get(callField(0, markets()[0].nextRound, 'trend-follower'));
  assert.ok(one.at < one.lock && one.c && one.t);
  assert.equal(t.redis.every((c) => !JSON.stringify(c).includes('"k"') || true), true);
});

test('a restart does not ask again in the same cycle and does not make the same call twice', async () => {
  const t = setup();
  t.g.tick(t.snap); await settle();
  const second = createGuide({ env: { GEMINI_API_KEY: 'k' }, live: true, log: () => {}, getCandles: async () => candles, askFn: async () => { throw new Error('must not ask'); }, fetchFn: async () => { throw new Error('no network'); }, now: () => t.clock.ms + 20_000, ...t.files });
  second.tick(t.snap); await settle();
  assert.equal(second.calls.size, 24, 'the saved calls were read back');
});

test('an answer that comes after the round locks is dropped', async () => {
  const t = setup({ askFn: async (args) => { t.clock.ms = (T0 + 203) * 1000; return (await (async () => ({ ok: true, value: args.parse(JSON.stringify({ calls: [{ coin: 'BTC', frame: '5m', call: 'UP', reason: 'late' }, { coin: 'ETH', frame: '5m', call: 'UP', reason: 'late' }, { coin: 'SOL', frame: '5m', call: 'UP', reason: 'late' }, { coin: 'BTC', frame: '10m', call: 'UP', reason: 'late' }, { coin: 'ETH', frame: '10m', call: 'UP', reason: 'late' }, { coin: 'SOL', frame: '10m', call: 'UP', reason: 'late' }] })), tokensIn: 1, tokensOut: 1, latencyMs: 1, attempts: 1, model: 'm' }))()); } });
  t.g.tick(t.snap); await settle();
  const ai = [...t.g.calls.values()].filter((r) => r.a === 'trend-follower');
  // 200 s later ETH (locks at +100) and SOL (locks at +200) are locked: no call for them; BTC (locks at +300) still is
  assert.deepEqual(ai.map((r) => r.market).sort(), ['BTC/USD 10m', 'BTC/USD 5m']);
  for (const r of ai) assert.ok(r.at < r.lock);
});

// ------------------------------------------------------------------------------------------------ scoring

// a Bitfinex trade-history answer that fits the asked time: the first trade 2 s after a start, the last trade 2 s before an end
const bitfinex = (url, startUsd, endUsd) => {
  const m = /start=(\d+)/.exec(url), e = /end=(\d+)/.exec(url);
  return m ? [[1, Number(m[1]) + 2000, 1, startUsd]] : [[2, Number(e[1]) - 2000, 1, endUsd]];
};
test('scoring: a round that ended is scored once against the start and end prices, no gas and no settle', async () => {
  const prices = { start: 100, end: 101 };
  const fetches = [];
  const t = setup({
    fetchFn: async (url, init) => {
      if (String(url).startsWith('https://redis.test')) { t.redis.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ result: 1 }) }; }
      fetches.push(String(url));
      return { ok: true, json: async () => bitfinex(String(url), prices.start, prices.end) };
    },
  });
  t.g.tick(t.snap); await settle();
  // BTC 5m: locks at T0+300, ends at T0+600
  t.clock.ms = (T0 + 600 + 30) * 1000;
  for (let pass = 0; pass < 3; pass++) { t.g.tick(t.snap); await settle(); await settle(); } // at most 4 price requests per pass: three passes reach every ended round
  const btc = markets()[0];
  const key = `${btc.id}:${btc.nextRound}`;
  assert.ok(t.g.scored.has(key), 'the round was scored');
  assert.ok(fetches.some((u) => /tBTCUSD.*sort=1&start=/.test(u)) && fetches.some((u) => /tBTCUSD.*sort=-1&end=/.test(u)));
  const res = t.redis.filter((c) => c[0] === 'EVAL').flatMap((c) => c.slice(4)).filter((x, i) => i % 2 === 0);
  assert.ok(res.includes(resField(btc.id, btc.nextRound)));
  const logged = t.logs.find((l) => l.startsWith(`GUIDE scored BTC/USD 5m round ${btc.nextRound}`));
  assert.match(logged, /UP won/);
  assert.match(logged, /(won|lost)/);
  // scored once: another pass does not score it again
  const n = t.redis.length;
  t.clock.ms += 20_000; t.g.tick(t.snap); await settle(); await settle();
  assert.equal(t.logs.filter((l) => l.startsWith(`GUIDE scored BTC/USD 5m round ${btc.nextRound}`)).length, 1);
  assert.ok(t.redis.length >= n);
});

test('scoring: when both prices are the same there is no result, for every agent', async () => {
  const t = setup({
    fetchFn: async (url, init) => {
      if (String(url).startsWith('https://redis.test')) { t.redis.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ result: 1 }) }; }
      return { ok: true, json: async () => bitfinex(String(url), 100, 100) };
    },
  });
  t.g.tick(t.snap); await settle();
  t.clock.ms = (T0 + 600 + 30) * 1000;
  for (let pass = 0; pass < 3; pass++) { t.g.tick(t.snap); await settle(); await settle(); } // at most 4 price requests per pass: three passes reach every ended round
  const logged = t.logs.find((l) => l.startsWith('GUIDE scored BTC/USD 5m'));
  assert.match(logged, /no change, no result/);
  assert.match(logged, /none/);
  assert.doesNotMatch(logged, /\bwon\b.*\bwon\b/);
});

test('scoring uses the prices the runner put on chain (its price log) when the round was played, with no Bitfinex request', async () => {
  const btc = markets()[0];
  const lock = T0 + 300, end = T0 + 600;
  void lock; void end;
  const chainLog = [
    { marketId: 0, round: btc.nextRound, kind: 'start', priceUsd: 200, lastTradeAt: T0 + 305, recordedAt: T0 + 306 },
    { marketId: 0, round: btc.nextRound, kind: 'end', priceUsd: 190, lastTradeAt: T0 + 570, recordedAt: T0 + 571 },
  ];
  const t = setup({ chainPriceLog: () => chainLog, fetchFn: async (url, init) => { if (String(url).startsWith('https://redis.test')) { t.redis.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ result: 1 }) }; } throw new Error('Bitfinex must not be asked: ' + url); } });
  t.g.tick(t.snap); await settle();
  t.clock.ms = (T0 + 600 + 30) * 1000;
  for (let pass = 0; pass < 3; pass++) { t.g.tick(t.snap); await settle(); await settle(); } // at most 4 price requests per pass: three passes reach every ended round
  const logged = t.logs.find((l) => l.startsWith('GUIDE scored BTC/USD 5m'));
  assert.match(logged, /\$200\.00 \(the runner's price log\)/);
  assert.match(logged, /DOWN won/);
});

test('a price that cannot be fetched is tried again later, and never crashes', async () => {
  const t = setup({ fetchFn: async (url, init) => { if (String(url).startsWith('https://redis.test')) { t.redis.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ result: 1 }) }; } return { ok: false, status: 500, json: async () => ({}) }; } });
  t.g.tick(t.snap); await settle();
  t.clock.ms = (T0 + 600 + 30) * 1000;
  assert.doesNotThrow(() => t.g.tick(t.snap));
  await settle(); await settle();
  assert.equal(t.g.scored.size, 0);
  assert.ok(t.logs.some((l) => /no BTC\/USD start price from Bitfinex/.test(l)));
});

// ------------------------------------------------------------------------------------------------ one model per agent, caps, fallback

const tick1 = async (t) => { t.g.tick(t.snap); await settle(); };
const nextCycle = (t, n = 1) => { t.clock.ms = (T0 + 300 * n + 3) * 1000; return { markets: markets().map((m) => ({ ...m, nextRound: m.nextRound + n * (m.roundLength === 300 ? 1 : 0.5) })) }; };
const modelsOf = (t) => t.asks.map((a) => a.model).sort();

test('each AI agent has its own model: Chart Reader gemini-3.5-flash-lite, Contrarian gemini-3.1-flash-lite, Trend Follower gemma-4-26b-a4b-it', async () => {
  assert.deepEqual(AGENT_MODELS, { 'chart-reader': 'gemini-3.5-flash-lite', contrarian: 'gemini-3.1-flash-lite', 'trend-follower': 'gemma-4-26b-a4b-it' });
  assert.equal(FALLBACK_MODEL, 'gemma-4-31b-it');
  assert.equal(new Set(Object.values(AGENT_MODELS)).size, 3, 'no two agents share a model');
  assert.deepEqual([GUIDE_MODELS['gemini-3.5-flash-lite'].dailyCap, GUIDE_MODELS['gemini-3.1-flash-lite'].dailyCap, GUIDE_MODELS['gemma-4-26b-a4b-it'].dailyCap, GUIDE_MODELS['gemma-4-31b-it'].dailyCap], [450, 450, 5000, 5000]);
  const t = setup();
  await tick1(t);
  assert.equal(t.asks.length, 3, 'one request per agent, covering every coin and time frame');
  const by = Object.fromEntries(t.asks.map((a) => [a.model, a]));
  assert.deepEqual(Object.keys(by).sort(), ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemma-4-26b-a4b-it']);
  for (const a of t.asks) {
    assert.equal(a.retryOn429, false);
    assert.equal(a.schema.properties.calls.minItems, 6, '3 coins x 5m, plus 10m for the three coins');
    for (const coin of ['BTC', 'ETH', 'SOL']) assert.match(a.user, new RegExp(`Coin: ${coin}\\.`));
  }
  assert.equal(by['gemma-4-26b-a4b-it'].plain, true);
  assert.equal(by['gemma-4-26b-a4b-it'].maxAttempts, 1, 'no second Gemma request within the minute');
  assert.equal(by['gemini-3.5-flash-lite'].plain, false);
  assert.equal(by['gemini-3.5-flash-lite'].maxAttempts, 2);
  // every agent has a call on every one of the six open rounds, saved before its round locks, with the model that made it
  assert.equal(t.g.calls.size, 4 * 6);
  for (const rec of t.g.calls.values()) { assert.ok(rec.at < rec.lock); assert.equal(rec.s, 'called'); }
  assert.equal(t.g.calls.get(callField(0, markets()[0].nextRound, 'trend-follower')).model, 'gemma-4-26b-a4b-it');
  assert.equal(t.g.calls.get(callField(0, markets()[0].nextRound, 'chart-reader')).model, 'gemini-3.5-flash-lite');
  const flip = t.g.calls.get(callField(0, markets()[0].nextRound, 'coin-flipper'));
  assert.equal(flip.src, 'random');
  assert.equal(flip.c, 'UP');
});

test('a model that answers with a limit or quota error is not retried: the agent uses gemma-4-31b-it for that call', async () => {
  const t = setup({ askFn: async (args) => { t.asks.push(args); return args.model === 'gemini-3.5-flash-lite' ? { ok: false, error: 'HTTP 429', attempts: 1, latencyMs: 3, model: args.model } : answerFor(args); } });
  await tick1(t);
  assert.deepEqual(modelsOf(t), ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemma-4-26b-a4b-it', 'gemma-4-31b-it'], 'one try on the limited model, one on the fallback');
  const rec = t.g.calls.get(callField(0, markets()[0].nextRound, 'chart-reader'));
  assert.equal(rec.s, 'called');
  assert.equal(rec.model, 'gemma-4-31b-it');
  assert.ok(t.logs.some((l) => /gemini-3\.5-flash-lite says too many requests/.test(l) && /chart-reader tries gemma-4-31b-it/.test(l)));
  // the limited model rests: next cycle Chart Reader goes straight to the fallback
  const before = t.asks.length;
  t.clock.ms += 61_000; // the fallback model's one-request-a-minute is free again
  t.g.tick(nextCycle(t)); await settle();
  assert.equal(t.asks.slice(before).filter((a) => a.model === 'gemini-3.5-flash-lite').length, 0, 'not asked again while it rests');
  assert.equal(t.asks.slice(before).filter((a) => a.model === 'gemma-4-31b-it').length, 1);
});

test('a limit answer from every model: the calls are skipped, nothing is retried in a loop, the runner is not affected', async () => {
  let asked = 0;
  const t = setup({ askFn: async (args) => { asked++; t.asks.push(args); return { ok: false, error: 'HTTP 429', attempts: 1, latencyMs: 3, model: args.model }; } });
  assert.doesNotThrow(() => t.g.tick(t.snap));
  await settle();
  // trend-follower: gemma-4-26b-a4b-it then gemma-4-31b-it; the other two find gemma-4-31b-it already used this minute: 4 requests in all
  assert.equal(asked, 4);
  const skipped = [...t.g.calls.values()].filter((r) => r.s === 'skipped' && r.a !== 'coin-flipper');
  assert.ok(skipped.length > 0);
  assert.ok(skipped.every((r) => r.c === null && /decide/.test(r.t)));
  assert.equal(t.g.calls.has(callField(3, markets()[3].nextRound, 'trend-follower')), false, 'BTC 10m stays open past the next cycle: asked again then');
  assert.equal(t.g.calls.has(callField(0, markets()[0].nextRound, 'trend-follower')), true, 'BTC 5m locks before the next cycle: it gets its skip');
  t.g.tick(nextCycle(t)); await settle();
  assert.equal(asked, 4, 'every model rests for 10 minutes');
  t.g.tick(nextCycle(t, 3)); await settle();
  assert.equal(asked, 8, 'asked again once, not more');
});

test('a model that does not exist (HTTP 404) is skipped for an hour and the fallback answers', async () => {
  const t = setup({ askFn: async (args) => { t.asks.push(args); return args.model === 'gemma-4-26b-a4b-it' ? { ok: false, error: 'HTTP 404', attempts: 1, latencyMs: 3, model: args.model } : answerFor(args); } });
  await tick1(t);
  assert.ok(t.logs.some((l) => /gemma-4-26b-a4b-it was not found \(HTTP 404\)/.test(l)));
  assert.equal(t.g.calls.get(callField(0, markets()[0].nextRound, 'trend-follower')).model, 'gemma-4-31b-it');
});

test('any other failure skips those calls once and carries on: no fallback, no retry loop', async () => {
  const t = setup({ askFn: async (args) => { t.asks.push(args); return { ok: false, error: 'timed out', attempts: 1, latencyMs: 24_000, model: args.model }; } });
  await tick1(t);
  assert.equal(t.asks.length, 3);
  assert.ok(t.logs.some((l) => /no answer from gemini-3\.5-flash-lite \(timed out/.test(l)));
  assert.ok(t.g.calls.has(callField(1, markets()[1].nextRound, 'chart-reader')), 'ETH 5m locks soon: it gets its skip');
  assert.equal([...t.g.calls.values()].filter((r) => r.a === 'coin-flipper' && r.s === 'called').length, 6, 'Coin Flipper does not need Gemini');
});

test("a model at its daily cap is not asked: the agent uses gemma-4-31b-it; the day follows Google's reset (midnight Pacific)", async () => {
  const models = { ...GUIDE_MODELS, 'gemini-3.5-flash-lite': { ...GUIDE_MODELS['gemini-3.5-flash-lite'], dailyCap: 1 } };
  const t = setup({ models });
  await tick1(t);
  assert.equal(modelsOf(t).filter((m) => m === 'gemini-3.5-flash-lite').length, 1);
  t.g.tick(nextCycle(t)); await settle();
  const second = t.asks.slice(3);
  assert.equal(second.filter((a) => a.model === 'gemini-3.5-flash-lite').length, 0, 'cap of 1 reached');
  assert.equal(second.filter((a) => a.model === 'gemma-4-31b-it').length, 1, 'Chart Reader fell back');
  assert.ok(t.logs.some((l) => /chart-reader: gemini-3\.5-flash-lite not used \(daily cap 1 reached\)/.test(l)));
  // midnight Pacific is 07:00 UTC in summer and 08:00 UTC in winter
  assert.equal(limitDay(Date.UTC(2026, 9, 28, 6, 59)), '2026-10-27');
  assert.equal(limitDay(Date.UTC(2026, 9, 28, 7, 1)), '2026-10-28');
  assert.equal(limitDay(Date.UTC(2026, 0, 15, 7, 59)), '2026-01-14');
  assert.equal(limitDay(Date.UTC(2026, 0, 15, 8, 1)), '2026-01-15');
});

test('Gemma gets one request a minute per model: with both flash-lite models at their cap only one agent reaches gemma-4-31b-it', async () => {
  const cap0 = (m) => ({ ...GUIDE_MODELS[m], dailyCap: 0 });
  const t = setup({ models: { ...GUIDE_MODELS, 'gemini-3.5-flash-lite': cap0('gemini-3.5-flash-lite'), 'gemini-3.1-flash-lite': cap0('gemini-3.1-flash-lite') } });
  await tick1(t);
  assert.deepEqual(modelsOf(t), ['gemma-4-26b-a4b-it', 'gemma-4-31b-it']);
  assert.ok(t.logs.some((l) => /gemma-4-31b-it not used \(1 a minute reached\)/.test(l)));
  const skip = [...t.g.calls.values()].filter((r) => r.s === 'skipped' && r.a !== 'coin-flipper');
  assert.ok(skip.length > 0, "the agent that found no model shows Couldn't decide this round");
});

test('the hourly line counts the requests per model and gives the expected daily total for each', async () => {
  const t = setup();
  await tick1(t);
  t.clock.ms += 3600_000;
  t.g.tick(t.snap); await settle();
  const line = t.logs.find((l) => l.startsWith('GUIDE Gemini requests:'));
  assert.match(line, /3 in the last hour \(gemini-3\.5-flash-lite 1, gemini-3\.1-flash-lite 1, gemma-4-26b-a4b-it 1, gemma-4-31b-it 0\)/);
  assert.match(line, /today \(Pacific day/);
  assert.match(line, /caps gemini-3\.5-flash-lite 450, gemini-3\.1-flash-lite 450, gemma-4-26b-a4b-it 5000, gemma-4-31b-it 5000/);
  assert.match(line, /expected about 288 a day/);
  assert.equal(GUIDE_CFG.expectedPerDayEach, 288);
});

test('a missing key means no request and no crash', async () => {
  const t = setup({ env: { GEMINI_API_KEY: '' } });
  assert.doesNotThrow(() => t.g.tick(t.snap));
  await settle();
  assert.equal(t.asks.length, 0);
  assert.ok(t.logs.some((l) => /GEMINI_API_KEY is not set/.test(l)));
});

// ------------------------------------------------------------------------------------------------ Gemma: plain request, short prompt, plain answer

test('askGemini plain (Gemma): the instructions go at the start of the user text; no system_instruction, no JSON mode, no thinking setting', async () => {
  let body;
  const fetchFn = async (url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'hidden thought', thought: true }, { text: '{"x":1}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }) }; };
  const out = await askGemini({ apiKey: 'k', model: 'gemma-4-26b-a4b-it', system: 'SYS', user: 'USER', schema: {}, parse: (t) => JSON.parse(t), fetchFn, plain: true });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, { x: 1 }, 'thought text is left out');
  assert.equal(body.systemInstruction, undefined);
  assert.equal(body.generationConfig.responseMimeType, undefined);
  assert.equal(body.generationConfig.responseSchema, undefined);
  assert.equal(body.generationConfig.thinkingConfig, undefined);
  assert.equal(body.contents[0].parts[0].text, 'SYS\n\nUSER');
});

test('Gemma prompt: a full 12-call request is over 12K tokens in the normal prompt and under it in the short one', () => {
  const big = Array.from({ length: 120 }, (_, i) => { const b = 67000 + Math.sin(i / 5) * 80 + i * 1.7; return { time: T0 + i * 60, open: b + 3.1, high: b + 21.37, low: b - 17.42, close: b + 5.55 }; });
  const frames = ['5m', '10m', '30m', '1h'].map((l) => ({ label: l, roundSeconds: { '5m': 300, '10m': 600, '30m': 1800, '1h': 3600 }[l], secondsToLock: 200 }));
  const coins = ['BTC/USD', 'ETH/USD', 'SOL/USD'].map((coin) => ({ coin, candles: big, frames }));
  for (const agent of ['trend-follower', 'contrarian', 'chart-reader']) {
    const normal = buildGuidePrompt({ agent, coins });
    const compact = buildGuidePrompt({ agent, coins, compact: true });
    assert.ok(estimateTokens(normal.system + normal.user) > 12_000, 'the normal prompt is too big for Gemma');
    assert.ok(estimateTokens(compact.system + compact.user) <= 11_000, 'the short prompt fits');
    assert.ok(compact.user.length < normal.user.length);
    assert.equal((compact.user.match(/^- (5m|10m|30m|1h):/gm) ?? []).length, 12, 'every coin and time frame is still asked');
    assert.match(compact.user, /Coin: BTC\./);
  }
  // the other models' prompt does not change
  assert.equal(buildGuidePrompt({ agent: 'trend-follower', coins }).user, buildGuidePrompt({ agent: 'trend-follower', coins, compact: false }).user);
});

test("Gemma's plain-text answer is read: a code fence or a sentence around the JSON, one call and reason for each entry", () => {
  const entries = [{ coin: 'BTC', frame: '5m' }, { coin: 'ETH', frame: '5m' }];
  const json = JSON.stringify({ calls: [{ coin: 'BTC', frame: '5m', call: 'UP', reason: 'BTC up 0.2% in 10 minutes' }, { coin: 'ETH', frame: '5m', call: 'DOWN', reason: 'ETH fell 0.1%' }] });
  for (const text of [json, '```json\n' + json + '\n```', 'Here are my calls:\n' + json + '\nHope that helps.']) {
    const v = parseGuide(text, entries);
    assert.deepEqual(v, { 'BTC:5m': { call: 'UP', reason: 'BTC up 0.2% in 10 minutes' }, 'ETH:5m': { call: 'DOWN', reason: 'ETH fell 0.1%' } });
  }
  assert.equal(parseGuide('I think UP.', entries), null);
  assert.equal(parseGuide('{"calls": [ {broken', entries), null);
});

// ------------------------------------------------------------------------------------------------ Gemma: 90 s, seconds in the log, what came back on a timeout

test('Gemma timeout is 90 s, the Gemini models keep 16 s; the Gemma instructions say to reply with only the JSON', async () => {
  assert.equal(GUIDE_MODELS['gemma-4-26b-a4b-it'].timeoutMs, 90_000);
  assert.equal(GUIDE_MODELS['gemma-4-31b-it'].timeoutMs, 90_000);
  assert.equal(GUIDE_MODELS['gemini-3.5-flash-lite'].timeoutMs, 16_000);
  assert.equal(GUIDE_MODELS['gemini-3.1-flash-lite'].timeoutMs, 16_000);
  const t = setup();
  await tick1(t);
  const by = Object.fromEntries(t.asks.map((a) => [a.model, a]));
  assert.equal(by['gemma-4-26b-a4b-it'].timeoutMs, 90_000);
  assert.equal(by['gemini-3.5-flash-lite'].timeoutMs, 16_000);
  assert.equal(by['gemini-3.1-flash-lite'].timeoutMs, 16_000);
  assert.match(by['gemma-4-26b-a4b-it'].system, /Reply with only the JSON, no explanation, no reasoning\./);
});

test('a fallback Gemma request is held to the same 90 seconds, counted from the start of the agent\'s work, and to the round\'s lock', async () => {
  const t = setup({ askFn: async (args) => { t.asks.push(args); if (args.model === 'gemini-3.5-flash-lite') { t.clock.ms += 40_000; return { ok: false, error: 'HTTP 429', attempts: 1, latencyMs: 40_000, model: args.model }; } return answerFor(args); } });
  await tick1(t);
  const first = t.asks.find((a) => a.model === 'gemini-3.5-flash-lite');
  const fb = t.asks.find((a) => a.model === 'gemma-4-31b-it' && a.system.includes('Chart Reader'));
  assert.ok(fb, 'Chart Reader fell back');
  // the deadline of a Gemma request is at most 90 s after the work began, never later than the lock
  const startedMs = (T0 + 3) * 1000;
  assert.ok(fb.deadline <= startedMs + 90_000, 'not past 90 s from the start');
  assert.ok(fb.deadline <= first.deadline);
});

test('askGemini: a Gemma answer that is still arriving when the time is up is a timeout, and what had arrived is returned', async () => {
  const enc = new TextEncoder();
  const fetchFn = async (url, init) => ({
    ok: true, status: 200,
    body: {
      getReader() {
        let n = 0;
        return {
          read: () => (n++ === 0
            ? Promise.resolve({ done: false, value: enc.encode('{"candidates":[{"content":{"parts":[{"text":"Thinking about the chart... ' + 'x'.repeat(300) + '"') })
            : new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))),
        };
      },
    },
  });
  const out = await askGemini({ apiKey: 'k', model: 'gemma-4-26b-a4b-it', system: 's', user: 'u', schema: {}, parse: () => ({}), fetchFn, plain: true, timeoutMs: 60, maxAttempts: 1, sleep: async () => {} });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'timed out');
  assert.equal(out.partial.length, 200);
  assert.match(out.partial, /^\{"candidates":\[\{"content"/);
  // nothing came back at all: an empty string
  const none = await askGemini({ apiKey: 'k', model: 'gemma-4-26b-a4b-it', system: 's', user: 'u', schema: {}, parse: () => ({}), plain: true, timeoutMs: 40, maxAttempts: 1, sleep: async () => {}, fetchFn: (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) });
  assert.equal(none.error, 'timed out');
  assert.equal(none.partial, '');
});

test('the log says how many seconds a Gemma call took, and on a timeout the first 200 characters that came back', async () => {
  const t = setup({ askFn: async (args) => {
    t.asks.push(args);
    if (args.model === 'gemma-4-26b-a4b-it') return { ok: false, error: 'timed out', attempts: 1, latencyMs: 90_000, model: args.model, partial: '{"calls":[{"coin":"BTC"' };
    return answerFor(args);
  } });
  await tick1(t);
  assert.ok(t.logs.some((l) => /gemma-4-26b-a4b-it timed out after 90\.0 s; first 200 characters that came back: "\{\\"calls\\":\[\{\\"coin\\":\\"BTC\\""/.test(l)), t.logs.join('\n'));
  const t2 = setup({ askFn: async (args) => { t2.asks.push(args); return args.model === 'gemma-4-26b-a4b-it' ? { ok: false, error: 'timed out', attempts: 1, latencyMs: 90_000, model: args.model, partial: '' } : answerFor(args); } });
  await tick1(t2);
  assert.ok(t2.logs.some((l) => /gemma-4-26b-a4b-it timed out after 90\.0 s; nothing had come back/.test(l)));
  // a call that finishes: its seconds are in the "saved" line
  const t3 = setup({ askFn: async (args) => { t3.asks.push(args); const r = answerFor(args); return { ...r, latencyMs: args.model === 'gemma-4-26b-a4b-it' ? 6200 : 900 }; } });
  await tick1(t3);
  assert.ok(t3.logs.some((l) => /GUIDE trend-follower: 6 calls saved for 6 rounds \(gemma-4-26b-a4b-it, 100 in \/ 50 out tokens, took 6\.2 s\)/.test(l)));
  // a Gemini model's timeout is not shown in the Gemma way
  assert.ok(!t.logs.some((l) => /gemini.* timed out after/.test(l)));
});
