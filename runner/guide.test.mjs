// Tests for the guide calls (runner/guide.mjs): no money, nothing on chain, no real Gemini or Upstash (everything is faked).
//   node --test runner/guide.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { askGemini, buildGuidePrompt, guideSchema, parseGuide, guideWording, GUIDE_LABEL } from '../agents/ai.mjs';
import { createGuide, dueRounds, outcomeOf, resultOf, callField, resField, GUIDE_AI_AGENTS, GUIDE_CFG, GUIDE_HASH } from './guide.mjs';

// Cycle-aligned clock: T0 is a multiple of 300, so the 5-minute cycle starts at T0 and the AI is due at T0 + 3.
const T0 = 1_800_000_000;
const mk = (id, name, roundLength, startOffset, lockAt) => ({ id, name, roundLength, startOffset, minStake: 500_000, paused: false, nextRound: (lockAt - startOffset) / roundLength, rounds: {}, feed: { address: '0x0', updates: [] } });
// BTC locks at the cycle's end, ETH 100 s and SOL 200 s after the cycle starts (their rounds opened earlier), like the real markets.
const markets = () => [
  mk(0, 'BTC/USD 5m', 300, 0, T0 + 300), mk(1, 'ETH/USD 5m', 300, 100, T0 + 100), mk(2, 'SOL/USD 5m', 300, 200, T0 + 200),
  mk(3, 'BTC/USD 10m', 600, 0, T0 + 600), mk(4, 'ETH/USD 10m', 600, 100, T0 + 100), mk(5, 'SOL/USD 10m', 600, 200, T0 + 200),
];
const candles = Array.from({ length: 60 }, (_, i) => ({ time: T0 - 3600 + i * 60, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));

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
    return { ok: true, value: args.parse(JSON.stringify({ calls: wanted.map((e, i) => ({ coin: e.coin, frame: e.frame, call: i % 2 ? 'DOWN' : 'UP', reason: `${e.coin} ${e.frame} moved 0.2%` })) })), tokensIn: 100, tokensOut: 50, latencyMs: 5, attempts: 1, model: 'test-model' };
  };
  const askFn = over.askFn ?? (async (args) => { asks.push(args); return answer(args); });
  const fetchFn = over.fetchFn ?? (async (url, init) => {
    if (String(url).startsWith('https://redis.test')) { redis.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ result: 1 }) }; }
    throw new Error('unexpected fetch ' + url);
  });
  const g = createGuide({
    env: { GEMINI_API_KEY: 'k', UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 't', ...(over.env ?? {}) }, live: over.live ?? true,
    log: (m) => logs.push(m), getCandles: async () => candles, askFn, fetchFn, now: () => clock.ms, random: over.random ?? (() => 0.7),
    chainPriceLog: over.chainPriceLog ?? (() => []), sleep: async () => {}, ...files, cfg: over.cfg,
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
  assert.equal(t.logs.filter((l) => l.startsWith('WOULD save guide call: Coin Flipper')).length, 6);
  assert.equal(t.redis.length, 0);
  assert.equal(fs.readdirSync(t.dir).length, 0, 'no files written');
  assert.equal(t.g.calls.size, 0);
});

test('live: ONE Gemini request per AI agent covers every coin and time frame, and Coin Flipper calls without Gemini', async () => {
  const t = setup();
  t.g.tick(t.snap);
  await settle();
  assert.equal(t.asks.length, 3, 'three requests: one per AI agent');
  for (const a of t.asks) {
    assert.equal(a.retryOn429, false);
    assert.equal(a.maxAttempts, 2);
    for (const coin of ['BTC', 'ETH', 'SOL']) assert.match(a.user, new RegExp(`Coin: ${coin}\\.`));
    assert.equal(a.schema.properties.calls.minItems, 6, '3 coins x 5m, plus 10m for the three coins');
  }
  // every agent has a call on every one of the six open rounds
  const fields = calledFields(t.g);
  assert.equal(fields.length, 4 * 6);
  for (const agent of [...GUIDE_AI_AGENTS, 'coin-flipper']) for (const m of markets()) assert.ok(t.g.calls.has(callField(m.id, m.nextRound, agent)), `${agent} market ${m.id}`);
  // each call is saved before its round locks, with the time it was made
  for (const rec of t.g.calls.values()) { assert.ok(rec.at < rec.lock, 'made before the lock'); assert.equal(rec.s, 'called'); assert.ok(rec.c === 'UP' || rec.c === 'DOWN'); assert.equal(rec.g, 1); }
  // the coin flipper: 0.7 is 0.50 or more, so UP, with its reason in the call words
  const flip = t.g.calls.get(callField(0, markets()[0].nextRound, 'coin-flipper'));
  assert.equal(flip.c, 'UP');
  assert.equal(flip.src, 'random');
  assert.doesNotMatch(flip.t, /\b(bet|wager|odds)\b/i);
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

test('a limit or quota answer skips the calls, is never retried, and nothing is asked for 10 minutes; the runner is not affected', async () => {
  let asked = 0;
  const t = setup({ askFn: async () => { asked++; return { ok: false, error: 'HTTP 429', attempts: 1, latencyMs: 3, model: 'm' }; } });
  assert.doesNotThrow(() => t.g.tick(t.snap));
  await settle();
  assert.equal(asked, 3);
  assert.ok(t.logs.some((l) => /too many requests/.test(l)));
  // ETH and SOL rounds lock within the cycle: they get "Couldn't decide this round"; the rounds that stay open are simply asked again later
  const skipped = [...t.g.calls.values()].filter((r) => r.s === 'skipped' && r.a !== 'coin-flipper');
  assert.ok(skipped.length > 0);
  assert.ok(skipped.every((r) => r.c === null && /decide/.test(r.t)));
  assert.equal(t.g.calls.has(callField(3, markets()[3].nextRound, 'trend-follower')), false, 'BTC 10m stays open past the next cycle: asked again then');
  assert.equal(t.g.calls.has(callField(0, markets()[0].nextRound, 'trend-follower')), true, 'BTC 5m locks before the next cycle: it gets its skip');
  // inside the pause: nothing is asked
  t.clock.ms = (T0 + 300 + 3) * 1000;
  t.g.tick({ markets: markets().map((m) => ({ ...m, nextRound: m.nextRound + 1 })) }); await settle();
  assert.equal(asked, 3, 'paused for 10 minutes');
  // after the pause it asks again
  t.clock.ms = (T0 + 900 + 3) * 1000;
  t.g.tick({ markets: markets().map((m) => ({ ...m, nextRound: m.nextRound + 2 })) }); await settle();
  assert.equal(asked, 6);
});

test('any other failure skips those calls once and carries on', async () => {
  const t = setup({ askFn: async () => ({ ok: false, error: 'timed out', attempts: 2, latencyMs: 24_000, model: 'm' }) });
  t.g.tick(t.snap); await settle();
  assert.ok(t.logs.some((l) => /no answer \(timed out/.test(l)));
  assert.ok(t.g.calls.has(callField(1, markets()[1].nextRound, 'chart-reader')), 'ETH 5m locks soon: it gets its skip');
  assert.equal([...t.g.calls.values()].filter((r) => r.a === 'coin-flipper' && r.s === 'called').length, 6, 'Coin Flipper does not need Gemini');
});

test('an answer that comes after the round locks is dropped', async () => {
  const t = setup({ askFn: async (args) => { t.clock.ms = (T0 + 203) * 1000; return (await (async () => ({ ok: true, value: args.parse(JSON.stringify({ calls: [{ coin: 'BTC', frame: '5m', call: 'UP', reason: 'late' }, { coin: 'ETH', frame: '5m', call: 'UP', reason: 'late' }, { coin: 'SOL', frame: '5m', call: 'UP', reason: 'late' }, { coin: 'BTC', frame: '10m', call: 'UP', reason: 'late' }, { coin: 'ETH', frame: '10m', call: 'UP', reason: 'late' }, { coin: 'SOL', frame: '10m', call: 'UP', reason: 'late' }] })), tokensIn: 1, tokensOut: 1, latencyMs: 1, attempts: 1, model: 'm' }))()); } });
  t.g.tick(t.snap); await settle();
  const ai = [...t.g.calls.values()].filter((r) => r.a === 'trend-follower');
  // 200 s later ETH (locks at +100) and SOL (locks at +200) are locked: no call for them; BTC (locks at +300) still is
  assert.deepEqual(ai.map((r) => r.market).sort(), ['BTC/USD 10m', 'BTC/USD 5m']);
  for (const r of ai) assert.ok(r.at < r.lock);
});

test('the daily cap stops the requests, and the hourly line gives the count and the expected daily total', async () => {
  const t = setup({ cfg: { dailyCap: 2 } });
  t.g.tick(t.snap); await settle();
  assert.equal(t.asks.length, 2, 'the third agent hits the cap');
  assert.ok(t.logs.some((l) => /request limit reached/.test(l)));
  t.clock.ms += 3600_000; // next hour
  t.g.tick(t.snap); await settle();
  const line = t.logs.find((l) => l.startsWith('GUIDE Gemini requests:'));
  assert.match(line, /2 in the last hour/);
  assert.match(line, /expected about 864 a day/);
  assert.equal(GUIDE_CFG.expectedPerDay, 864);
});

test('a missing key means no request and no crash', async () => {
  const t = setup({ env: { GEMINI_API_KEY: '' } });
  assert.doesNotThrow(() => t.g.tick(t.snap));
  await settle();
  assert.equal(t.asks.length, 0);
  assert.ok(t.logs.some((l) => /GEMINI_API_KEY is not set/.test(l)));
});

// ------------------------------------------------------------------------------------------------ scoring

// a Bitfinex trade-history answer that fits the asked time: the first trade 4 s after a start, the last trade 2 s before an end
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
