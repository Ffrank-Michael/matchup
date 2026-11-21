// Tests for the guide calls (runner/guide.mjs): no money, nothing on chain, no real Gemini or Upstash (everything is faked).
//   node --test runner/guide.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { askGemini, buildGuidePrompt, guideSchema, parseGuide, guideWording, GUIDE_LABEL } from '../agents/ai.mjs';
import { createGuide, dueRounds, laterRounds, expectedPerDay, outcomeOf, resultOf, callField, resField, limitDay, GUIDE_AI_AGENTS, GUIDE_CFG, GUIDE_HASH, GUIDE_MODELS, AGENT_MODELS, FALLBACK_MODELS, ASK_OFFSETS, CYCLE_SECONDS } from './guide.mjs';

// T0 is a multiple of 600: the 10-minute cycle starts at T0 and the three AI agents are asked at T0 + 3, T0 + 25 and T0 + 47.
const T0 = 1_800_000_000;
const mk = (id, name, roundLength, startOffset, lockAt) => ({ id, name, roundLength, startOffset, minStake: 500_000, paused: false, nextRound: (lockAt - startOffset) / roundLength, rounds: {}, feed: { address: '0x0', updates: [] } });
// BTC locks 300 s after the cycle starts, ETH 100 s and SOL 200 s after it (their rounds opened earlier), like the real markets.
const markets = () => [
  mk(0, 'BTC/USD 5m', 300, 0, T0 + 300), mk(1, 'ETH/USD 5m', 300, 100, T0 + 100), mk(2, 'SOL/USD 5m', 300, 200, T0 + 200),
  mk(3, 'BTC/USD 10m', 600, 0, T0 + 600), mk(4, 'ETH/USD 10m', 600, 100, T0 + 100), mk(5, 'SOL/USD 10m', 600, 200, T0 + 200),
];
// the same markets `n` 10-minute cycles later: two more 5-minute rounds, one more 10-minute round
const later = (n) => markets().map((m) => ({ ...m, nextRound: m.nextRound + n * (m.roundLength === 300 ? 2 : 1) }));
const candles = Array.from({ length: 60 }, (_, i) => ({ time: T0 - 3600 + i * 60, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));
const AI_ENTRIES = 9; // 6 open rounds + the 5-minute round after the next one of each of the 3 coins
const ALL_CALLS = 6 + 3 * AI_ENTRIES; // Coin Flipper's 6 + 3 AI agents x 9

// the test candles only rise, so the lookback window ends higher than it began: Trend Follower goes with it (UP), Contrarian against it (DOWN)
const ruleCall = (system) => (system.includes('You are the Trend Follower') ? 'UP' : system.includes('You are the Contrarian') ? 'DOWN' : null);

// what a model that works answers: one UP/DOWN call and reason for every entry asked
function answerFor(args) {
  const n = args.schema.properties.calls.minItems;
  const coins = args.schema.properties.calls.items.properties.coin.enum, frames = args.schema.properties.calls.items.properties.frame.enum;
  const list = [];
  for (const c of coins) for (const f of frames) list.push({ coin: c, frame: f });
  const wanted = list.filter((e) => args.user.includes(`Coin: ${e.coin}.`) && args.user.includes(`- ${e.frame}:`)).slice(0, n);
  return { ok: true, value: args.parse(JSON.stringify({ calls: wanted.map((e, i) => ({ coin: e.coin, frame: e.frame, call: ruleCall(args.system) ?? (i % 2 ? 'DOWN' : 'UP'), reason: `${e.coin} ${e.frame} moved 0.2%` })) })), tokensIn: 100, tokensOut: 50, latencyMs: 5, attempts: 1, model: args.model };
}

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-test-'));
  const logs = [];
  const clock = { ms: (T0 + 50) * 1000 }; // all three agents are due
  const asks = [];
  const redis = [];
  const files = { file: path.join(dir, 'calls.jsonl'), stateFile: path.join(dir, 'state.json'), priceFile: path.join(dir, 'prices.jsonl') };
  const askFn = over.askFn ?? (async (args) => { asks.push(args); return answerFor(args); });
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
const at = (t, sec) => { t.clock.ms = (T0 + sec) * 1000; };

// ------------------------------------------------------------------------------------------------ pure parts

test('dueRounds: every open next round, but not a paused market and not one that locks within the minimum', () => {
  const ms = markets();
  ms[2].paused = true;
  const d = dueRounds(ms, T0 + 3, 25);
  assert.deepEqual(d.map((x) => `${x.short} ${x.label} ${x.secondsToLock}`), ['BTC 5m 297', 'ETH 5m 97', 'BTC 10m 597', 'ETH 10m 97', 'SOL 10m 197']);
  assert.deepEqual(dueRounds(ms, T0 + 80, 25).map((x) => x.market), ['BTC/USD 5m', 'BTC/USD 10m', 'SOL/USD 10m']); // ETH locks in 20 s
});

test('laterRounds: for each 5-minute market the round after the next one, with when its window opens; not for other lengths or paused markets', () => {
  const ms = markets();
  ms[2].paused = true;
  const l = laterRounds(ms, T0 + 3);
  assert.deepEqual(l.map((x) => `${x.short} ${x.label} ${x.ask} round ${x.round - ms[x.marketId].nextRound} lock+${x.lock - T0} opens in ${x.opensIn}`), [
    'BTC 5m 5m-after round 1 lock+600 opens in 297',
    'ETH 5m 5m-after round 1 lock+400 opens in 97',
  ]);
  assert.equal(l[0].end, l[0].lock + 300);
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

test('the prompt asks the later 5-minute round as its own entry, with when it opens and closes, next to the open 5-minute round', () => {
  const frames = [{ label: '5m', roundSeconds: 300, secondsToLock: 97 }, { label: '5m-after', roundSeconds: 300, secondsToLock: 397, opensIn: 97 }];
  const { user } = buildGuidePrompt({ agent: 'chart-reader', coins: [{ coin: 'ETH/USD', candles, frames }] });
  assert.match(user, /^- 5m: rounds of 5 minutes, calling closes in about 97 seconds$/m);
  assert.match(user, /^- 5m-after: the 5-minute round after the next one; calling opens in about 97 seconds and closes in about 397 seconds$/m);
  const keys = [{ coin: 'ETH', frame: '5m' }, { coin: 'ETH', frame: '5m-after' }];
  const schema = guideSchema(keys);
  assert.deepEqual(schema.properties.calls.items.properties.frame.enum, ['5m', '5m-after']);
  const v = parseGuide(JSON.stringify({ calls: [{ coin: 'ETH', frame: '5m', call: 'UP', reason: 'a' }, { coin: 'ETH', frame: '5m-after', call: 'DOWN', reason: 'b' }] }), keys);
  assert.deepEqual(Object.keys(v), ['ETH:5m', 'ETH:5m-after']);
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
  for (const [agent, model] of Object.entries(AGENT_MODELS)) assert.ok(t.logs.some((l) => l.startsWith(`WOULD ask ${model} for ${agent}: ${AI_ENTRIES} calls`)), agent);
  assert.ok(t.logs.some((l) => /BTC 5m-after/.test(l)));
  assert.equal(t.logs.filter((l) => l.startsWith('WOULD save guide call: Coin Flipper')).length, 6);
  assert.equal(t.redis.length, 0);
  assert.equal(fs.readdirSync(t.dir).length, 0, 'no files written');
  assert.equal(t.g.calls.size, 0);
});

test('the AI agents are asked once every 10 minutes, 20 seconds or more apart, never in the same second', async () => {
  assert.equal(CYCLE_SECONDS, 600);
  const offsets = GUIDE_AI_AGENTS.map((a) => ASK_OFFSETS[a]).sort((a, b) => a - b);
  for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] - offsets[i - 1] >= 20, 'at least 20 s apart');
  const t = setup();
  at(t, 1); t.g.tick(t.snap); await settle();
  assert.equal(t.asks.length, 0, 'before the first offset');
  at(t, ASK_OFFSETS['trend-follower']); t.g.tick(t.snap); await settle();
  assert.equal(t.asks.length, 1);
  at(t, ASK_OFFSETS.contrarian); t.g.tick(t.snap); await settle();
  assert.equal(t.asks.length, 2);
  at(t, ASK_OFFSETS['chart-reader']); t.g.tick(t.snap); await settle();
  assert.equal(t.asks.length, 3);
  // not again 5 minutes later (the 5-minute mark is not a cycle), but at the next 10-minute mark
  at(t, 305); t.g.tick({ markets: markets().map((m) => ({ ...m, nextRound: m.nextRound + (m.roundLength === 300 ? 1 : 0) })) }); await settle();
  assert.equal(t.asks.length, 3, 'nothing at the 5-minute mark');
  at(t, 600 + 50); t.g.tick({ markets: later(1) }); await settle();
  assert.equal(t.asks.length, 6, 'one more request per agent at the next 10-minute mark, not more');
  at(t, 600 + 60); t.g.tick({ markets: later(1) }); await settle();
  assert.equal(t.asks.length, 6);
});

test('nextWake: seconds until the next agent is due', () => {
  const t = setup();
  at(t, 10); assert.equal(t.g.nextWake(), 15, 'Contrarian is next');
  at(t, 48); assert.equal(t.g.nextWake(), 555, 'Trend Follower at the next 10-minute mark');
  at(t, 0); assert.equal(t.g.nextWake(), 3);
});

test('live: ONE request per AI agent covers every open round plus the 5-minute round after the next one of each coin', async () => {
  const t = setup();
  t.g.tick(t.snap); await settle();
  assert.equal(t.asks.length, 3, 'one request per agent');
  for (const a of t.asks) {
    assert.equal(a.retryOn429, false);
    assert.equal(a.maxAttempts, 2, 'one retry, for a timeout or a server error');
    assert.equal(a.schema.properties.calls.minItems, AI_ENTRIES);
    assert.deepEqual(a.schema.properties.calls.items.properties.frame.enum.slice().sort(), ['10m', '5m', '5m-after']);
    for (const coin of ['BTC', 'ETH', 'SOL']) { assert.match(a.user, new RegExp(`Coin: ${coin}\\.`)); }
    assert.equal((a.user.match(/^- 5m-after:/gm) ?? []).length, 3);
  }
  assert.equal(t.g.calls.size, ALL_CALLS);
  // every 5-minute round of the next two rounds has a call from every agent, saved before its round locks, with the time it was made
  for (const agent of [...GUIDE_AI_AGENTS, 'coin-flipper']) {
    for (const m of markets().filter((x) => x.roundLength === 300)) {
      const open = t.g.calls.get(callField(m.id, m.nextRound, agent));
      assert.ok(open && open.s === 'called', `${agent} ${m.name} open round`);
      if (agent === 'coin-flipper') continue;
      const after = t.g.calls.get(callField(m.id, m.nextRound + 1, agent));
      assert.ok(after && after.s === 'called', `${agent} ${m.name} later round`);
      assert.equal(after.frame, '5m', 'recorded like any 5-minute call: nothing is labelled differently');
      assert.equal(after.at, T0 + 50);
      assert.ok(after.at < after.lock);
      assert.equal(after.lock, m.startOffset + (m.nextRound + 1) * 300);
    }
  }
  assert.equal(t.g.calls.get(callField(0, markets()[0].nextRound, 'chart-reader')).model, 'gemini-3.1-flash-lite');
  assert.equal(t.g.calls.get(callField(0, markets()[0].nextRound, 'contrarian')).model, 'gemini-3.1-flash-lite');
  assert.equal(t.g.calls.get(callField(0, markets()[0].nextRound, 'trend-follower')).model, 'gemini-3.1-flash-lite');
  const flip = t.g.calls.get(callField(0, markets()[0].nextRound, 'coin-flipper'));
  assert.equal(flip.src, 'random');
  assert.equal(flip.c, 'UP');
  assert.equal(t.g.calls.has(callField(0, markets()[0].nextRound + 1, 'coin-flipper')), false, 'Coin Flipper calls a round when it opens');
});

test('every 5-minute round gets a call from every agent over two cycles: the request makes the later round, the next request the two after it', async () => {
  const t = setup();
  t.g.tick(t.snap); await settle();
  at(t, 600 + 50); t.g.tick({ markets: later(1) }); await settle();
  for (const m of markets().filter((x) => x.roundLength === 300)) {
    for (const k of [0, 1, 2, 3]) for (const agent of GUIDE_AI_AGENTS) assert.ok(t.g.calls.has(callField(m.id, m.nextRound + k, agent)), `${agent} ${m.name} round +${k}`);
  }
});

test('calls are saved once and never change: the file is append-only and Upstash is written with HSETNX', async () => {
  const t = setup();
  t.g.tick(t.snap); await settle();
  const before = fs.readFileSync(t.files.file, 'utf8');
  const lines = before.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, ALL_CALLS);
  assert.equal(new Set(lines.map((l) => `${l.m}:${l.r}:${l.a}`)).size, ALL_CALLS, 'no call saved twice');
  // the same tick again (same cycle, same rounds): the file does not change
  at(t, 65); t.g.tick(t.snap); await settle();
  assert.equal(fs.readFileSync(t.files.file, 'utf8'), before);
  // upstash: EVAL with HSETNX on the guide hash, field "market:round:agent"
  const evals = t.redis.filter((c) => c[0] === 'EVAL');
  assert.ok(evals.length >= 1);
  assert.match(evals[0][1], /HSETNX/);
  assert.equal(evals[0][3], GUIDE_HASH);
  const sent = new Map();
  for (const c of evals) for (let i = 4; i < c.length; i += 2) sent.set(c[i], JSON.parse(c[i + 1]));
  assert.equal(sent.size, ALL_CALLS);
  const one = sent.get(callField(0, markets()[0].nextRound + 1, 'trend-follower'));
  assert.ok(one.at < one.lock && one.c && one.t);
});

test('a restart does not ask again in the same cycle and does not make the same call twice', async () => {
  const t = setup();
  t.g.tick(t.snap); await settle();
  const second = createGuide({ env: { GEMINI_API_KEY: 'k' }, live: true, log: () => {}, getCandles: async () => candles, askFn: async () => { throw new Error('must not ask'); }, fetchFn: async () => { throw new Error('no network'); }, now: () => t.clock.ms + 20_000, ...t.files });
  second.tick(t.snap); await settle();
  assert.equal(second.calls.size, ALL_CALLS, 'the saved calls were read back');
});

test('an answer that comes after a round locks is dropped for that round only', async () => {
  const t = setup({ askFn: async (args) => { t.asks.push(args); at(t, 203); return answerFor(args); } });
  t.g.tick(t.snap); await settle();
  const ai = [...t.g.calls.values()].filter((r) => r.a === 'trend-follower');
  // 150 s later ETH (locks at +100) and SOL (locks at +200) are locked: no call for them; BTC (locks at +300) and the later rounds still are
  assert.deepEqual(ai.map((r) => `${r.market} ${r.r}`).sort(), [
    `BTC/USD 10m ${markets()[3].nextRound}`, `BTC/USD 5m ${markets()[0].nextRound}`, `BTC/USD 5m ${markets()[0].nextRound + 1}`,
    `ETH/USD 5m ${markets()[1].nextRound + 1}`, `SOL/USD 5m ${markets()[2].nextRound + 1}`,
  ].sort());
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


// ------------------------------------------------------------------------------------------------ the models, caps, limit answers

const modelsOf = (t) => t.asks.map((a) => a.model).sort();
const askedBy = (t) => Object.fromEntries(t.asks.map((a) => [a.system.includes('Chart Reader') ? 'chart-reader' : a.system.includes('Contrarian') ? 'contrarian' : 'trend-follower', a.model]));

const M = 'gemini-3.1-flash-lite';

const B = 'gemini-3.5-flash-lite';

test('the models: all three AI agents use gemini-3.1-flash-lite first; gemini-3.5-flash-lite is the backup for it', async () => {
  assert.deepEqual(AGENT_MODELS, { 'chart-reader': M, contrarian: M, 'trend-follower': M });
  assert.deepEqual(Object.keys(GUIDE_MODELS), [M, B]);
  assert.deepEqual(FALLBACK_MODELS, { [M]: B });
  assert.deepEqual(Object.values(GUIDE_MODELS).map((m) => m.dailyCap), [450, 450]);
  assert.equal(GUIDE_MODELS[M].perMinute, 10);
  assert.ok(!/gemma/i.test(JSON.stringify(GUIDE_MODELS) + JSON.stringify(AGENT_MODELS)));
  const t = setup();
  t.g.tick(t.snap); await settle();
  assert.deepEqual(askedBy(t), { 'trend-follower': M, contrarian: M, 'chart-reader': M });
  for (const a of t.asks) { assert.equal(a.fallbackModel, B); assert.equal(a.plain, undefined); assert.equal(a.timeoutMs, 16_000); assert.ok(a.maxAttempts >= 2); }
});

test('expected requests a day: 144 per agent, so 432 on the one model, under its cap of 450', () => {
  assert.equal(GUIDE_CFG.requestsPerDayEach, 144);
  assert.deepEqual(expectedPerDay(), { [M]: 432 });
  assert.ok(432 <= GUIDE_MODELS[M].dailyCap);
});

test('the three staggered requests never exceed the per-minute limit, even with every retry', () => {
  const secs = Object.values(ASK_OFFSETS).sort((a, b) => a - b);
  assert.equal(secs.length, 3);
  assert.ok(secs.every((s, i) => i === 0 || s - secs[i - 1] >= 20), 'at least 20 s apart');
  assert.ok(secs[2] - secs[0] < 60, 'all three fall inside one minute');
  const worst = 3 * Math.max(2, GUIDE_MODELS[M].maxAttempts); // every agent tries twice (the first model, then the backup)
  assert.ok(worst <= GUIDE_MODELS[M].perMinute, `${worst} requests in a minute at most, limit ${GUIDE_MODELS[M].perMinute}`);
  assert.ok(worst <= GUIDE_MODELS[B].perMinute);
  assert.ok(GUIDE_MODELS[M].perMinute <= 15, "under Google's own 15 a minute");
});

test('a limit or quota answer is not retried: that model rests 10 minutes, the next agent uses the backup, and when both rest the agents skip', async () => {
  const t = setup({ askFn: async (args) => { t.asks.push(args); return { ok: false, error: 'HTTP 429', attempts: 1, latencyMs: 3, model: args.model }; } });
  for (const sec of [ASK_OFFSETS['trend-follower'], ASK_OFFSETS.contrarian, ASK_OFFSETS['chart-reader']]) { at(t, sec); assert.doesNotThrow(() => t.g.tick(t.snap)); await settle(); }
  // Trend Follower is told the limit is reached on the first model; Contrarian finds it resting and goes to the backup, which also says so; Chart Reader finds both resting
  assert.deepEqual(modelsOf(t), [M, B]);
  assert.ok(t.logs.some((l) => /gemini-3\.1-flash-lite says too many requests/.test(l)));
  assert.ok(t.logs.some((l) => /contrarian: gemini-3\.1-flash-lite not used \(paused until.*asking gemini-3\.5-flash-lite instead/.test(l)));
  assert.ok(t.logs.some((l) => /gemini-3\.5-flash-lite says too many requests/.test(l)));
  assert.ok(t.logs.some((l) => /chart-reader: gemini-3\.1-flash-lite not used \(paused until/.test(l)));
  assert.ok(!t.logs.some((l) => /gemma/i.test(l)));
  for (const agent of ['trend-follower', 'contrarian', 'chart-reader']) {
    const skip = t.g.calls.get(callField(0, markets()[0].nextRound, agent));
    assert.equal(skip.s, 'skipped');
    assert.equal(skip.c, null);
    assert.match(skip.t, /decide/);
    assert.equal(t.g.calls.get(callField(0, markets()[0].nextRound + 1, agent)).s, 'skipped', 'the later 5-minute round locks before the next cycle too');
  }
  // not asked again in a loop; asked again at the next cycle, when the rest is over
  at(t, 300 + 50); t.g.tick(t.snap); await settle();
  assert.equal(t.asks.length, 2);
  at(t, 600 + 60); t.g.tick({ markets: later(1) }); await settle();
  assert.ok(t.asks.length > 2, 'asked again once the rest is over');
});

test('the backup: when the first model is down (server error or timeout) the same request goes to gemini-3.5-flash-lite and the calls are saved', async () => {
  const t = setup({ askFn: async (args) => {
    t.asks.push(args);
    // what askGemini does: the first model fails, the backup answers
    const ok = answerFor({ ...args, model: args.fallbackModel });
    return { ...ok, model: args.fallbackModel, attempts: 2 };
  } });
  t.g.tick(t.snap); await settle();
  assert.equal(t.asks.length, 3);
  assert.ok(t.asks.every((a) => a.model === M && a.fallbackModel === B));
  const saved = [...t.g.calls.values()].filter((r) => r.a === 'chart-reader' && r.s === 'called');
  assert.ok(saved.length > 0);
  assert.ok(t.logs.some((l) => /GUIDE chart-reader: \d+ calls saved .*gemini-3\.5-flash-lite/.test(l)));
});

test('the backup: when the first model is at its daily cap the agent asks the backup straight away, and the backup is counted on its own', async () => {
  const models = { ...GUIDE_MODELS, [M]: { ...GUIDE_MODELS[M], dailyCap: 1 } };
  const t = setup({ models });
  t.g.tick(t.snap); await settle();
  assert.deepEqual(modelsOf(t), [B, B, M].sort());
  assert.ok(t.logs.some((l) => /gemini-3\.1-flash-lite not used \(daily cap 1 reached\); asking gemini-3\.5-flash-lite instead/.test(l)));
  const asked = t.asks.filter((a) => a.model === B);
  assert.ok(asked.every((a) => a.fallbackModel === null));
  assert.match(t.g.summary(), /gemini-3\.1-flash-lite 1/);
  assert.match(t.g.summary(), /gemini-3\.5-flash-lite 2/);
});

test('any other failure skips those calls and carries on: no retry loop, no other model', async () => {
  const t = setup({ askFn: async (args) => { t.asks.push(args); return { ok: false, error: 'timed out', attempts: 2, latencyMs: 24_000, model: args.model }; } });
  t.g.tick(t.snap); await settle();
  assert.equal(t.asks.length, 3);
  assert.ok(t.logs.some((l) => /no answer from gemini-3\.1-flash-lite \(timed out, 2 tries, took 24\.0 s\)/.test(l)));
  assert.ok(t.g.calls.has(callField(1, markets()[1].nextRound, 'chart-reader')), 'ETH 5m locks soon: it gets its skip');
  assert.equal([...t.g.calls.values()].filter((r) => r.a === 'coin-flipper' && r.s === 'called').length, 6, 'Coin Flipper does not need Gemini');
});

test("a model at its daily cap is not asked: its agents skip their calls for the cycle; the day follows Google's reset (midnight Pacific)", async () => {
  const models = { [M]: { ...GUIDE_MODELS[M], dailyCap: 1 } };
  const t = setup({ models });
  t.g.tick(t.snap); await settle();
  assert.equal(t.asks.length, 1, 'only one request fits under a cap of 1: the other two agents are not asked');
  at(t, 600 + 50); t.g.tick({ markets: later(1) }); await settle();
  assert.equal(t.asks.length, 1, 'still at the cap the next cycle');
  assert.ok(t.logs.some((l) => /chart-reader: gemini-3\.1-flash-lite not used \(daily cap 1 reached\)/.test(l)));
  const skipped = t.g.calls.get(callField(0, later(1)[0].nextRound, 'chart-reader'));
  assert.equal(skipped.s, 'skipped');
  assert.match(skipped.t, /decide/);
  // midnight Pacific is 07:00 UTC in summer and 08:00 UTC in winter
  assert.equal(limitDay(Date.UTC(2026, 9, 28, 6, 59)), '2026-10-27');
  assert.equal(limitDay(Date.UTC(2026, 9, 28, 7, 1)), '2026-10-28');
  assert.equal(limitDay(Date.UTC(2026, 0, 15, 7, 59)), '2026-01-14');
  assert.equal(limitDay(Date.UTC(2026, 0, 15, 8, 1)), '2026-01-15');
});

test('a retry after a timeout or a server error is counted like any request', async () => {
  const t = setup();
  t.g.tick(t.snap); await settle();
  const a = t.asks.find((x) => x.model === M);
  assert.equal(a.beforeRetry(), true);
  assert.match(t.g.summary(), /gemini-3\.1-flash-lite 4/); // three first tries and one retry
});

test('the hourly line counts the requests per model and gives the expected daily total for each', async () => {
  const t = setup();
  t.g.tick(t.snap); await settle();
  t.clock.ms += 3600_000;
  t.g.tick(t.snap); await settle();
  const line = t.logs.find((l) => l.startsWith('GUIDE Gemini requests:'));
  assert.match(line, /3 in the last hour \(gemini-3\.1-flash-lite 3, gemini-3\.5-flash-lite 0\)/);
  assert.match(line, /today \(Pacific day/);
  assert.match(line, /caps gemini-3\.1-flash-lite 450, gemini-3\.5-flash-lite 450/);
  assert.match(line, /expected a day: gemini-3\.1-flash-lite 432/);
});

test('the log says how many seconds a call took', async () => {
  const t = setup({ askFn: async (args) => { t.asks.push(args); return { ...answerFor(args), latencyMs: args.system.includes('Chart Reader') ? 6200 : 900 }; } });
  t.g.tick(t.snap); await settle();
  assert.ok(t.logs.some((l) => /GUIDE chart-reader: 9 calls saved for 9 rounds \(gemini-3\.1-flash-lite, 100 in \/ 50 out tokens, took 6\.2 s\)/.test(l)));
  assert.ok(t.logs.some((l) => /GUIDE contrarian: 9 calls saved for 9 rounds \(gemini-3\.1-flash-lite, 100 in \/ 50 out tokens, took 0\.9 s\)/.test(l)));
});

test('a missing key means no request and no crash', async () => {
  const t = setup({ env: { GEMINI_API_KEY: '' } });
  assert.doesNotThrow(() => t.g.tick(t.snap));
  await settle();
  assert.equal(t.asks.length, 0);
  assert.ok(t.logs.some((l) => /GEMINI_API_KEY is not set/.test(l)));
});

test('Trend Follower and Contrarian are given the same lookback window for a round, with opposite rules; Chart Reader is given none', () => {
  const frames = [{ label: '5m', roundSeconds: 300, secondsToLock: 200 }, { label: '1h', roundSeconds: 3600, secondsToLock: 900 }];
  const ask = (agent) => buildGuidePrompt({ agent, coins: [{ coin: 'BTC/USD', candles, frames }] });
  const lines = (user) => user.split('\n').filter((l) => l.startsWith('- BTC ') && l.includes('net move'));
  const trend = lines(ask('trend-follower').user), contra = lines(ask('contrarian').user);
  assert.equal(trend.length, 2);
  assert.match(trend[0], /^- BTC 5m: last 10 one-minute candles/);   // 2 x 5 minutes
  assert.match(trend[1], /^- BTC 1h: last 60 one-minute candles/);   // only 60 candles exist, so the window is what there is
  const same = (l) => l.replace(/; so you call (UP|DOWN)$/, '');
  assert.deepEqual(trend.map(same), contra.map(same), 'the same data for both');
  assert.ok(trend.every((l) => l.endsWith('so you call UP')) && contra.every((l) => l.endsWith('so you call DOWN')));
  assert.match(ask('trend-follower').system, /go WITH that net move|You go WITH/);
  assert.match(ask('contrarian').system, /You go AGAINST/);
  assert.equal(lines(ask('chart-reader').user).length, 0);
  assert.ok(!/another player|other player/i.test(ask('chart-reader').user), 'no call of another player is in a prompt');
});

test('Chart Reader is told to judge every time frame separately and not to copy one answer across frames; the other two are not', () => {
  const frames = [{ label: '5m', roundSeconds: 300, secondsToLock: 200 }, { label: '30m', roundSeconds: 1800, secondsToLock: 900 }];
  const sys = (agent) => buildGuidePrompt({ agent, coins: [{ coin: 'BTC/USD', candles, frames }] }).system;
  assert.match(sys('chart-reader'), /Judge every time frame separately/);
  assert.match(sys('chart-reader'), /never copy one answer across time frames/);
  assert.ok(!/Judge every time frame separately/.test(sys('trend-follower')) && !/Judge every time frame separately/.test(sys('contrarian')));
});

test('an answer against its own rule is not used: that call is skipped, the others are kept', () => {
  const entries = [{ coin: 'BTC', frame: '5m' }, { coin: 'ETH', frame: '5m' }];
  const text = JSON.stringify({ calls: [{ coin: 'BTC', frame: '5m', call: 'UP', reason: 'a' }, { coin: 'ETH', frame: '5m', call: 'UP', reason: 'b' }] });
  const out = parseGuide(text, entries, { 'BTC:5m': 'UP', 'ETH:5m': 'DOWN' });
  assert.equal(out['BTC:5m'].call, 'UP');
  assert.equal(out['ETH:5m'], null);
  assert.equal(parseGuide(text, entries)['ETH:5m'].call, 'UP', 'no rule given: any call is read as before');
});

test('live: Trend Follower and Contrarian each ask once, separately, and call opposite sides of the same window', async () => {
  const t = setup();
  t.g.tick(t.snap); await settle();
  const of = (who) => t.asks.filter((a) => a.system.includes(who));
  assert.equal(of('You are the Trend Follower').length, 1);
  assert.equal(of('You are the Contrarian').length, 1);
  for (const a of t.asks) assert.ok(!/Contrarian|Trend Follower/.test(a.user), 'a prompt never shows or names the other agent');
  // the same window lines in both requests, one rule each way
  const windows = (who) => of(who)[0].user.split('\n').filter((l) => /net move/.test(l) && l.startsWith('- ')).map((l) => l.replace(/; so you call (UP|DOWN)$/, ''));
  assert.deepEqual(windows('You are the Trend Follower'), windows('You are the Contrarian'));
  assert.ok(windows('You are the Trend Follower').length > 0);
  const m0 = markets()[0];
  assert.equal(t.g.calls.get(callField(0, m0.nextRound, 'trend-follower')).c, 'UP');
  assert.equal(t.g.calls.get(callField(0, m0.nextRound, 'contrarian')).c, 'DOWN');
});

test('live: an AI answer against its own rule is not saved: that call shows as skipped', async () => {
  // a model that ignores the rule and answers UP for everyone: Trend Follower is fine, Contrarian is not
  const t = setup({ askFn: async (args) => ({ ok: true, value: args.parse(JSON.stringify({ calls: args.schema.properties.calls.items.properties.coin.enum.flatMap((coin) => args.schema.properties.calls.items.properties.frame.enum.filter((f) => args.user.includes(`Coin: ${coin}.`) && args.user.includes(`- ${f}:`)).map((frame) => ({ coin, frame, call: 'UP', reason: 'up' }))) })), tokensIn: 1, tokensOut: 1, latencyMs: 1, attempts: 1, model: args.model }) });
  t.g.tick(t.snap); await settle();
  const m0 = markets()[0];
  assert.equal(t.g.calls.get(callField(0, m0.nextRound, 'trend-follower')).s, 'called');
  assert.notEqual(t.g.calls.get(callField(0, m0.nextRound, 'contrarian'))?.s, 'called');
});
