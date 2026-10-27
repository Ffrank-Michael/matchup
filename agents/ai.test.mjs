// Tests for the Gemini client (no internet: the network function is a fake).  Run:  node --test agents/ai.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { askGemini, buildPrompt, parseAnswer, costUsd, PERSONALITIES, AI_AGENTS, MAX_REASON, CANDLES_SENT } from './ai.mjs';

const KEY = 'fake-test-key-should-never-appear-anywhere';
const candles = Array.from({ length: 40 }, (_, i) => ({ time: 1_790_000_000 + i * 60, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));
const req = (over = {}) => ({ agent: 'trend-follower', market: 'BTC/USD 5m', roundSeconds: 300, secondsToLock: 95, candles, bets: { up: 500_000, down: 0 }, ...over });
const reply = (obj, usage = { promptTokenCount: 900, candidatesTokenCount: 30 }) => ({
  ok: true, status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }], usageMetadata: usage }),
  text: async () => '',
});
const fail = (status, text = '') => ({ ok: false, status, json: async () => ({}), text: async () => text });
const ask = (fetchFn, over = {}) => {
  const { system, user } = buildPrompt(req(over.req));
  return askGemini({ apiKey: KEY, system, user, fetchFn, retryDelayMs: 0, sleep: async () => {}, ...over.ask });
};

test('the prompt carries the personality, the last 30 candles, the price and the pots', () => {
  for (const agent of AI_AGENTS) {
    const { system, user } = buildPrompt(req({ agent }));
    assert.ok(system.includes(PERSONALITIES[agent]));
    assert.match(system, /JSON/);
    assert.equal(user.split('\n').filter((l) => /^\d\d:\d\d /.test(l)).length, CANDLES_SENT);
    assert.match(user, /BTC\/USD 5m/);
    assert.match(user, /UP \$0\.50, DOWN \$0\.00/);
    assert.match(user, /Current price: 140/); // last candle close = 101 + 39
  }
  assert.ok(!/bet|wager|odds/i.test(buildPrompt(req()).system), 'the site words stay out of the prompt too');
});

test('a forced side is told to the model', () => {
  const { user } = buildPrompt(req({ forcedSide: 'DOWN' }));
  assert.match(user, /your call is DOWN/);
});

test('parseAnswer: strict JSON with exactly call and reason', () => {
  assert.deepEqual(parseAnswer('{"call":"UP","reason":"  Three green candles in a row. "}'), { call: 'UP', reason: 'Three green candles in a row.' });
  for (const bad of ['', 'UP', 'not json', '[]', 'null', '{"call":"UP"}', '{"reason":"x"}', '{"call":"up","reason":"x"}', '{"call":"SIDEWAYS","reason":"x"}',
    '{"call":"UP","reason":""}', '{"call":"UP","reason":"   "}', '{"call":"UP","reason":5}', '{"call":"UP","reason":"x","extra":1}']) {
    assert.equal(parseAnswer(bad), null, bad);
  }
});

test('parseAnswer: long reasons are cut, a forced side wins', () => {
  const long = 'word '.repeat(80);
  const r = parseAnswer(JSON.stringify({ call: 'UP', reason: long }));
  assert.ok(r.reason.length <= MAX_REASON);
  assert.ok(r.reason.endsWith('…'));
  assert.equal(parseAnswer('{"call":"UP","reason":"fine"}', 'DOWN').call, 'DOWN');
});

test('costUsd: tokens times price per million', () => {
  assert.equal(costUsd(1_000_000, 1_000_000, { inPerM: 0.3, outPerM: 2.5 }), 2.8);
  assert.ok(Math.abs(costUsd(950, 40, { inPerM: 0.3, outPerM: 2.5 }) - 0.000385) < 1e-9);
});

test('a good answer returns the call, the reason and the token counts', async () => {
  let seen;
  const out = await ask(async (url, init) => { seen = { url, init }; return reply({ call: 'DOWN', reason: 'Wicks are long on top.' }); });
  assert.equal(out.ok, true);
  assert.equal(out.call, 'DOWN');
  assert.equal(out.reason, 'Wicks are long on top.');
  assert.equal(out.tokensIn, 900);
  assert.equal(out.tokensOut, 30);
  assert.equal(out.attempts, 1);
  assert.equal(seen.init.headers['x-goog-api-key'], KEY, 'the key goes in a header');
  assert.ok(!seen.url.includes(KEY), 'and never in the web address');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
});

test('a forced side overrides what the model said', async () => {
  const out = await ask(async () => reply({ call: 'UP', reason: 'Momentum is up.' }), { ask: { forcedSide: 'DOWN' } });
  assert.equal(out.call, 'DOWN');
});

test('answers that are not the required JSON fail without a retry', async () => {
  let calls = 0;
  const out = await ask(async () => { calls++; return reply('I think UP'); });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'answer was not the required JSON');
  assert.equal(calls, 1);
  const extra = await ask(async () => reply({ call: 'UP', reason: 'x', confidence: 0.9 }));
  assert.equal(extra.ok, false);
});

test('a timeout is tried once more, then fails', async () => {
  let calls = 0;
  const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
  const out = await ask(async () => { calls++; throw timeout; });
  assert.equal(calls, 2);
  assert.deepEqual([out.ok, out.error, out.attempts], [false, 'timed out', 2]);
});

test('429 then success: the retry works', async () => {
  const answers = [fail(429), reply({ call: 'UP', reason: 'Steady climb.' })];
  const out = await ask(async () => answers.shift());
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
});

test('server errors twice in a row fail with a short phrase', async () => {
  let calls = 0;
  const out = await ask(async () => { calls++; return fail(503, `secret details ${KEY}`); });
  assert.equal(calls, 2);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'HTTP 503');
  assert.ok(!JSON.stringify(out).includes(KEY));
});

test('a 400 is tried once more without the thinking setting, then fails (a bad key is not retried forever)', async () => {
  let calls = 0;
  const out = await ask(async () => { calls++; return fail(400, 'API key not valid'); }, { ask: { model: 'model-a' } });
  assert.equal(calls, 2);
  assert.equal(out.error, 'HTTP 400');
  assert.ok(!JSON.stringify(out).includes('API key'));
});

test('a model that refuses the thinking setting is asked again without it', async () => {
  const bodies = [];
  const answers = [fail(400, 'Request contains an invalid argument.'), reply({ call: 'UP', reason: 'Higher lows.' })];
  const out = await ask(async (_u, init) => { bodies.push(JSON.parse(init.body)); return answers.shift(); }, { ask: { model: 'model-b' } });
  assert.equal(out.ok, true);
  assert.ok(bodies[0].generationConfig.thinkingConfig);
  assert.equal(bodies[1].generationConfig.thinkingConfig, undefined);
});

test('the key never shows up in any error text, whatever goes wrong', async () => {
  const boom = Object.assign(new Error(`connect failed to https://x/?key=${KEY}`), { name: 'FetchError' });
  const out = await ask(async () => { throw boom; });
  assert.equal(out.error, 'network error');
  assert.ok(!JSON.stringify(out).includes(KEY));
});

test('a model that refused the thinking setting is not asked with it again', async () => {
  const model = 'test-model-no-thinking';
  const first = [fail(400, 'invalid'), reply({ call: 'UP', reason: 'Steady.' })];
  await ask(async () => first.shift(), { ask: { model } });
  let body;
  const out = await ask(async (_u, init) => { body = JSON.parse(init.body); return reply({ call: 'DOWN', reason: 'Fading.' }); }, { ask: { model } });
  assert.equal(out.attempts, 1);
  assert.equal(body.generationConfig.thinkingConfig, undefined);
});
