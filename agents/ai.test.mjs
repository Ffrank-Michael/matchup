// Tests for the Gemini client (no internet: the network function is a fake).  Run:  node --test agents/ai.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { askGemini, batchSchema, buildBatchPrompt, candlesFor, costUsd, frameLabel, parseBatch, readDecision, AI_AGENTS, JSON_KEY, MAX_REASON } from './ai.mjs';

const KEY = 'fake-test-key-should-never-appear-anywhere';
const candles = Array.from({ length: 130 }, (_, i) => ({ time: 1_790_000_000 + i * 60, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));
const frames = (...secs) => secs.map((s) => ({ label: frameLabel(s), roundSeconds: s, secondsToLock: 285 }));
const dec = (call, reason) => ({ call, reason });
const item = (frame, over = {}) => ({ frame, trend_follower: dec('UP', 'Higher highs.'), contrarian: dec('DOWN', 'Stretched.'), chart_reader: dec('UP', 'Strong close.'), ...over });
const answer = (...items) => JSON.stringify({ frames: items });

test('time frame names and how many candles each call gets', () => {
  assert.deepEqual([300, 600, 1800, 3600].map(frameLabel), ['5m', '10m', '30m', '1h']);
  assert.deepEqual([300, 600, 1800, 3600].map(candlesFor), [30, 30, 60, 120]);
  assert.equal(candlesFor(86_400), 120);
});

test('the prompt carries all three personalities, the frames, the price and enough candles for the longest frame', () => {
  for (const [secs, n] of [[[300], 30], [[300, 600], 30], [[300, 600, 1800], 60], [[300, 600, 1800, 3600], 120]]) {
    const { system, user } = buildBatchPrompt({ coin: 'BTC/USD', candles, frames: frames(...secs) });
    for (const k of Object.values(JSON_KEY)) assert.ok(system.includes(k), k);
    assert.match(system, /JSON/);
    assert.equal(user.split('\n').filter((l) => /^\d\d:\d\d /.test(l)).length, n);
    for (const f of frames(...secs)) assert.ok(user.includes(`- ${f.label}:`), f.label);
    assert.match(user, /Coin: BTC\/USD\. Current price: 230/); // last candle close = 101 + 129
    assert.match(user, new RegExp(`Last ${n} one-minute candles`));
  }
  const { system, user } = buildBatchPrompt({ coin: 'ETH/USD', candles, frames: frames(300) });
  assert.ok(!/\b(bet|wager|odds)\b/i.test(system + user), 'the site words stay out of the prompt too');
});

test('readDecision: exactly call and reason, UP or DOWN, a short single-line reason', () => {
  assert.deepEqual(readDecision({ call: 'UP', reason: '  Three green candles   in a row. ' }), dec('UP', 'Three green candles in a row.'));
  for (const bad of [null, 'UP', [], {}, { call: 'UP' }, { reason: 'x' }, { call: 'up', reason: 'x' }, { call: 'SIDEWAYS', reason: 'x' },
    { call: 'UP', reason: '' }, { call: 'UP', reason: '   ' }, { call: 'UP', reason: 5 }, { call: 'UP', reason: 'x', extra: 1 }]) {
    assert.equal(readDecision(bad), null, JSON.stringify(bad));
  }
  const r = readDecision({ call: 'UP', reason: 'word '.repeat(80) });
  assert.ok(r.reason.length <= MAX_REASON);
  assert.ok(r.reason.endsWith('…'));
});

test('parseBatch: one entry per frame with all three agents', () => {
  const out = parseBatch(answer(item('5m'), item('10m', { contrarian: dec('UP', 'Fading the dip.') })), ['5m', '10m']);
  assert.deepEqual(Object.keys(out), ['5m', '10m']);
  assert.deepEqual(Object.keys(out['5m']), AI_AGENTS);
  assert.deepEqual(out['5m']['trend-follower'], dec('UP', 'Higher highs.'));
  assert.deepEqual(out['10m'].contrarian, dec('UP', 'Fading the dip.'));
});

test('parseBatch: a missing frame or a malformed agent only takes that part away', () => {
  const out = parseBatch(answer(item('5m', { chart_reader: { call: 'UP' } })), ['5m', '10m']);
  assert.equal(out['5m']['chart-reader'], null);
  assert.ok(out['5m']['trend-follower']);
  assert.deepEqual(out['10m'], { 'trend-follower': null, contrarian: null, 'chart-reader': null });
});

test('parseBatch: extra keys, unknown or repeated frames and wrong shapes are not used', () => {
  assert.equal(parseBatch(answer(item('5m', { extra: 1 })), ['5m']), null, 'an entry with an extra key is dropped, nothing else is left');
  const out = parseBatch(answer(item('1h'), item('5m'), item('5m', { trend_follower: dec('DOWN', 'Second copy.') })), ['5m']);
  assert.deepEqual(out['5m']['trend-follower'], dec('UP', 'Higher highs.'), 'the first copy wins, the unknown frame is ignored');
  for (const bad of ['', 'UP', 'not json', '[]', 'null', '{}', '{"frames":{}}', '{"frames":[],"extra":1}', '{"frames":[null,5]}']) {
    assert.equal(parseBatch(bad, ['5m']), null, bad);
  }
});

test('batchSchema: the frame names are the only choices and every agent is required', () => {
  const s = batchSchema(['5m', '10m']);
  const entry = s.properties.frames.items;
  assert.deepEqual(entry.properties.frame.enum, ['5m', '10m']);
  assert.equal(s.properties.frames.minItems, 2);
  assert.deepEqual(entry.required, ['frame', 'trend_follower', 'contrarian', 'chart_reader']);
  assert.deepEqual(entry.properties.contrarian.properties.call.enum, ['UP', 'DOWN']);
});

test('costUsd: tokens times price per million', () => {
  assert.equal(costUsd(1_000_000, 1_000_000, { inPerM: 0.3, outPerM: 2.5 }), 2.8);
  assert.ok(Math.abs(costUsd(2335, 318, { inPerM: 0.3, outPerM: 2.5 }) - 0.0014955) < 1e-9);
});

// ---------------------------------------------------------------- the network call

const reply = (text, usage = { promptTokenCount: 1900, candidatesTokenCount: 210 }) => ({
  ok: true, status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: usage }),
  text: async () => '',
});
const fail = (status, text = '') => ({ ok: false, status, json: async () => ({}), text: async () => text });
const LABELS = ['5m'];
const ask = (fetchFn, over = {}) => {
  const { system, user } = buildBatchPrompt({ coin: 'BTC/USD', candles, frames: frames(300) });
  return askGemini({ apiKey: KEY, system, user, schema: batchSchema(LABELS), parse: (t) => parseBatch(t, LABELS), fetchFn, retryDelayMs: 0, sleep: async () => {}, model: 'model-default', ...over });
};
const GOOD = answer(item('5m'));

test('a good answer returns the decisions and the token counts', async () => {
  let seen;
  const out = await ask(async (url, init) => { seen = { url, init }; return reply(GOOD); });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value['5m']['chart-reader'], dec('UP', 'Strong close.'));
  assert.equal(out.tokensIn, 1900);
  assert.equal(out.tokensOut, 210);
  assert.equal(out.attempts, 1);
  assert.equal(seen.init.headers['x-goog-api-key'], KEY, 'the key goes in a header');
  assert.ok(!seen.url.includes(KEY), 'and never in the web address');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema.properties.frames.items.properties.frame.enum, ['5m']);
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
});

test('an answer that is not the required JSON fails without a retry', async () => {
  let calls = 0;
  const out = await ask(async () => { calls++; return reply('I think UP'); });
  assert.deepEqual([out.ok, out.error, calls], [false, 'answer was not the required JSON', 1]);
});

test('a timeout is tried once more, then fails', async () => {
  let calls = 0;
  const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
  const out = await ask(async () => { calls++; throw timeout; });
  assert.equal(calls, 2);
  assert.deepEqual([out.ok, out.error, out.attempts], [false, 'timed out', 2]);
});

test('429 then success: the retry works', async () => {
  const answers = [fail(429), reply(GOOD)];
  const out = await ask(async () => answers.shift());
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
});

test('server errors twice in a row fail with a short phrase that has no key in it', async () => {
  let calls = 0;
  const out = await ask(async () => { calls++; return fail(503, `secret details ${KEY}`); });
  assert.equal(calls, 2);
  assert.equal(out.error, 'HTTP 503');
  assert.ok(!JSON.stringify(out).includes(KEY));
});

test('a 400 is tried once more without the thinking setting, then fails', async () => {
  let calls = 0;
  const out = await ask(async () => { calls++; return fail(400, 'API key not valid'); }, { model: 'model-a' });
  assert.equal(calls, 2);
  assert.equal(out.error, 'HTTP 400');
  assert.ok(!JSON.stringify(out).includes('API key'));
});

test('a model that refuses the thinking setting is asked again without it, and remembered', async () => {
  const bodies = [];
  const answers = [fail(400, 'Request contains an invalid argument.'), reply(GOOD)];
  const first = await ask(async (_u, init) => { bodies.push(JSON.parse(init.body)); return answers.shift(); }, { model: 'model-b' });
  assert.equal(first.ok, true);
  assert.ok(bodies[0].generationConfig.thinkingConfig);
  assert.equal(bodies[1].generationConfig.thinkingConfig, undefined);
  let body;
  const second = await ask(async (_u, init) => { body = JSON.parse(init.body); return reply(GOOD); }, { model: 'model-b' });
  assert.equal(second.attempts, 1);
  assert.equal(body.generationConfig.thinkingConfig, undefined);
});

test('the key never shows up in any error text, whatever goes wrong', async () => {
  const boom = Object.assign(new Error(`connect failed to https://x/?key=${KEY}`), { name: 'FetchError' });
  const out = await ask(async () => { throw boom; });
  assert.equal(out.error, 'network error');
  assert.ok(!JSON.stringify(out).includes(KEY));
});
