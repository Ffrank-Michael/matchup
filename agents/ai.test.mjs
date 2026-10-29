// Tests for the Gemini client (no internet: the network function is a fake).  Run:  node --test agents/ai.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { askGemini, batchSchema, buildBatchPrompt, candlesFor, costUsd, frameLabel, parseBatch, readDecision, lookbackMinutes, lookbackWindow, windowSide, AI_AGENTS, JSON_KEY, MAX_REASON } from './ai.mjs';

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

const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });

test('a timeout is tried up to three times, then fails', async () => {
  let calls = 0;
  const out = await ask(async () => { calls++; throw timeout; });
  assert.equal(calls, 3);
  assert.deepEqual([out.ok, out.error, out.attempts], [false, 'timed out', 3]);
});

test('two timeouts and then an answer: the third try works', async () => {
  const answers = [timeout, timeout, reply(GOOD)];
  const out = await ask(async () => { const a = answers.shift(); if (a instanceof Error) throw a; return a; });
  assert.deepEqual([out.ok, out.attempts], [true, 3]);
});

test('each try has its own abort limit and the waits between tries are short', async () => {
  const waits = []; const signals = [];
  await ask(async (_u, init) => { signals.push(init.signal); throw timeout; }, { retryDelayMs: 1000, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [1000, 1000]);
  assert.equal(signals.length, 3);
  assert.ok(signals.every((x) => x instanceof AbortSignal));
});

test('429 is tried once more, not twice', async () => {
  let calls = 0;
  const out = await ask(async () => { calls++; return fail(429); });
  assert.deepEqual([out.error, calls, out.attempts], ['HTTP 429', 2, 2]);
});

test('beforeRetry is asked before every retry, and a no stops the call', async () => {
  const asked = []; let calls = 0;
  const out = await ask(async () => { calls++; throw timeout; }, { beforeRetry: () => { asked.push(calls); return asked.length < 2; } });
  assert.deepEqual(asked, [1, 2]);
  assert.deepEqual([calls, out.attempts, out.error], [2, 2, 'timed out']);
});

test('a deadline that leaves no time for another try stops the retries', async () => {
  let calls = 0;
  const out = await ask(async () => { calls++; throw timeout; }, { deadline: Date.now() + 1500 });
  assert.deepEqual([calls, out.attempts], [1, 1]);
  calls = 0;
  const far = await ask(async () => { calls++; throw timeout; }, { deadline: Date.now() + 60_000 });
  assert.deepEqual([calls, far.attempts], [3, 3]);
  calls = 0;
  const bad = await ask(async () => { calls++; throw timeout; }, { deadline: NaN });
  assert.equal(calls, 3, 'a deadline that is not a number is ignored');
});

test('429 then success: the retry works', async () => {
  const answers = [fail(429), reply(GOOD)];
  const out = await ask(async () => answers.shift());
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
});

test('server errors three times in a row fail with a short phrase that has no key in it', async () => {
  let calls = 0;
  const out = await ask(async () => { calls++; return fail(503, `secret details ${KEY}`); });
  assert.equal(calls, 3);
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

const modelOf = (url) => decodeURIComponent(url.match(/models\/([^:]+):generateContent/)[1]);

test('the first try asks the main model, the second and third try the fallback model', async () => {
  const seen = [];
  const out = await ask(async (url) => { seen.push(modelOf(url)); throw timeout; }, { model: 'main-m', fallbackModel: 'backup-m' });
  assert.deepEqual(seen, ['main-m', 'backup-m', 'backup-m']);
  assert.deepEqual([out.ok, out.attempts, out.model], [false, 3, 'backup-m']);
});

test('an answer from the fallback model says which model answered', async () => {
  const seen = [];
  const answers = [timeout, reply(GOOD)];
  const out = await ask(async (url) => { seen.push(modelOf(url)); const a = answers.shift(); if (a instanceof Error) throw a; return a; }, { model: 'main-m', fallbackModel: 'backup-m' });
  assert.deepEqual(seen, ['main-m', 'backup-m']);
  assert.deepEqual([out.ok, out.attempts, out.model], [true, 2, 'backup-m']);
  const first = await ask(async () => reply(GOOD), { model: 'main-m', fallbackModel: 'backup-m' });
  assert.equal(first.model, 'main-m');
});

test('without a fallback model every try asks the main model', async () => {
  const seen = [];
  await ask(async (url) => { seen.push(modelOf(url)); throw timeout; }, { model: 'main-m' });
  assert.deepEqual(seen, ['main-m', 'main-m', 'main-m']);
});

test('a 400 about the thinking setting is asked again on the same model, not the fallback', async () => {
  const seen = []; const answers = [fail(400, 'invalid argument'), reply(GOOD)];
  const out = await ask(async (url) => { seen.push(modelOf(url)); return answers.shift(); }, { model: 'main-c', fallbackModel: 'backup-c' });
  assert.deepEqual(seen, ['main-c', 'main-c']);
  assert.deepEqual([out.ok, out.model], [true, 'main-c']);
});

test('every try on the fallback model is still counted: beforeRetry is asked before the second and the third', async () => {
  let asked = 0;
  await ask(async () => { throw timeout; }, { model: 'main-m', fallbackModel: 'backup-m', beforeRetry: () => { asked++; return true; } });
  assert.equal(asked, 2);
});

test('the first try waits up to timeoutMs, the second and third only up to fallbackTimeoutMs', async () => {
  const took = [];
  // a network that never answers until the try is aborted by its own limit
  const hang = (_url, init) => new Promise((_res, rej) => { const t = Date.now(); init.signal.addEventListener('abort', () => { took.push(Date.now() - t); rej(init.signal.reason); }); });
  const keepAlive = setInterval(() => {}, 25); // the abort timers do not keep Node running, and this promise would otherwise end the process on some versions
  let out;
  try { out = await ask(hang, { timeoutMs: 120, fallbackTimeoutMs: 20, model: 'm1', fallbackModel: 'm2' }); } finally { clearInterval(keepAlive); }
  assert.equal(out.error, 'timed out');
  assert.equal(took.length, 3);
  assert.ok(took[0] >= 100, 'first try ' + took[0]);
  assert.ok(took[1] < 90 && took[2] < 90, 'later tries ' + took.slice(1));
});

test('the main model that is known to refuse the thinking setting is asked without it from the first try', async () => {
  let body;
  await ask(async (_u, init) => { body = JSON.parse(init.body); return reply(GOOD); }, { model: 'gemini-3.5-flash-lite' });
  assert.equal(body.generationConfig.thinkingConfig, undefined);
});

// ---- one lookback window for Trend Follower and Contrarian ----
test('the lookback window is twice the round length in minutes', () => {
  assert.deepEqual([300, 600, 1800, 3600].map(lookbackMinutes), [10, 20, 60, 120]);
});

test('lookbackWindow: the net move from the first open to the last close of the last N candles', () => {
  const w = lookbackWindow(candles, 300); // candles open 100 + i, close 101 + i; the last 10 are i = 120..129
  assert.equal(w.minutes, 10);
  assert.equal(w.open, 220);
  assert.equal(w.close, 230);
  assert.equal(w.side, 'UP');
  assert.ok(Math.abs(w.pct - (10 / 220) * 100) < 1e-9);
  assert.equal(lookbackWindow(candles, 3600).minutes, 120);
  const down = candles.map((c, i) => ({ ...c, open: 500 - i, close: 499 - i }));
  assert.equal(lookbackWindow(down, 600).side, 'DOWN');
});

test('lookbackWindow: the same candles give the same window for both agents, and too few candles give none', () => {
  assert.deepEqual(lookbackWindow(candles, 1800), lookbackWindow(candles.slice(), 1800));
  assert.equal(lookbackWindow(candles.slice(0, 5), 300), null);
  assert.equal(lookbackWindow([], 300), null);
  assert.equal(lookbackWindow(undefined, 300), null);
});

test('a window with no net move is decided by the newest candle that moved, and by UP when none moved', () => {
  const flat = Array.from({ length: 12 }, (_, i) => ({ time: i * 60, open: 100, high: 100, low: 100, close: 100 }));
  assert.equal(lookbackWindow(flat, 300).side, 'UP');
  const wobble = flat.map((c) => ({ ...c }));
  wobble[8] = { time: 8 * 60, open: 101, high: 101, low: 99, close: 99 }; // newest mover closed lower
  wobble[3] = { time: 3 * 60, open: 100, high: 101, low: 100, close: 101 };
  wobble[11] = { ...wobble[11], close: 100 };
  wobble[0] = { ...wobble[0], open: 100 };
  const w = lookbackWindow(wobble, 300); // net move over the window is open 100 -> close 100: zero
  assert.equal(w.open, w.close);
  assert.equal(w.side, 'DOWN');
});

test('Trend Follower goes with the net move and Contrarian goes against it, from the same window', () => {
  const up = lookbackWindow(candles, 300);
  const down = lookbackWindow(candles.map((c, i) => ({ ...c, open: 500 - i, close: 499 - i })), 300);
  assert.equal(windowSide('trend-follower', up), 'UP');
  assert.equal(windowSide('contrarian', up), 'DOWN');
  assert.equal(windowSide('trend-follower', down), 'DOWN');
  assert.equal(windowSide('contrarian', down), 'UP');
});
