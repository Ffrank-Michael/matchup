// The AI behind Trend Follower, Contrarian and Chart Reader: ONE small Gemini call per coin every 5 minutes. It answers for
// all three agents and for every time frame whose next round opens at that moment (5m, plus 10m, 30m or 1h when they line up),
// each with its own call and one short reason. (Coin Flipper stays random: it is the benchmark, "Can AI beat a coin flip?")
//
// Everything here is pure or takes its network function as an argument, so the tests never reach the internet.
// The API key is sent in a header (never in the web address), and nothing in this file ever prints or returns it.
export const AI_AGENTS = ['trend-follower', 'contrarian', 'chart-reader'];
export const MIN_CANDLES = 10;     // fewer than this is a data outage: the agents cannot decide
export const MIN_SENT = 30;        // at least this many one-minute candles go to the model
export const MAX_SENT = 120;       // ... and never more than this (a 1-hour round gets 120)
export const MAX_REASON = 140;     // characters kept of a reason
// Measured on our key (27 Oct 2026, real calls with the runner's own prompt): gemini-3.5-flash-lite answers 8 of 10 calls but takes 1 to 22 s
// (the same request, run again: Google's queue, not the model's thinking); gemini-3.1-flash-lite answers in 2 to 6 s when it answers but
// returns HTTP 503 about half the time. gemini-3.5-flash is fast but its free tier allows 20 calls a day; gemini-2.5-* answer 404; gemma and
// gemini-flash-latest do not work. So: the reliable one first, with a longer first try, and the quick one for the second and third try.
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_FALLBACK_MODEL = 'gemini-3.1-flash-lite';
export const COULDNT_DECIDE = "Couldn't decide this round";

// JSON keys the model uses for the three agents
export const JSON_KEY = { 'trend-follower': 'trend_follower', contrarian: 'contrarian', 'chart-reader': 'chart_reader' };

/** "5m", "10m", "30m", "1h": the name of a time frame, as the model and the logs use it. */
export const frameLabel = (roundSeconds) => (roundSeconds % 3600 === 0 ? `${roundSeconds / 3600}h` : `${Math.round(roundSeconds / 60)}m`);

/** How many 1-minute candles to send: twice the longest round in the call, at least 30 and at most 120. */
export const candlesFor = (longestRoundSeconds) => Math.min(MAX_SENT, Math.max(MIN_SENT, Math.ceil(longestRoundSeconds / 60) * 2));

const SYSTEM = [
  'You play three players in Kairo Markets, a small game where each player calls whether a coin price will be UP or DOWN over a round.',
  'You are given the coin, the last one-minute candles and the time frames whose next round is about to take calls. For each time frame, give each of the three players their own call.',
  'A round starts when calling closes; its start price is the first trade after that and its end price is the last trade when it ends. UP wins if the end price is higher than the start price. A player must call UP or DOWN and cannot skip. The players may disagree.',
  'The three players:',
  '- trend_follower: you believe in momentum: a price that has been moving one way tends to keep going over the next few minutes. You ride the trend and look at the direction and strength of the recent move.',
  '- contrarian: you fade the crowd and over-extended moves: when the price has run hard one way you lean the other way. Nobody has put money in yet, so you cannot see the crowd; give the side you would take against the move or the likely crowd.',
  '- chart_reader: you read candle shapes and levels: the size and direction of candles, wicks, highs and lows, recent support and resistance, and how the short-term average compares with the longer one.',
  "Each reason is ONE short plain sentence (under 140 characters) in that player's own style that uses a real number or fact from the data you were given. No advice, no hype, no mention of being an AI.",
  'Reply with JSON only: {"frames":[{"frame":"5m","trend_follower":{"call":"UP"|"DOWN","reason":"..."},"contrarian":{...},"chart_reader":{...}}, ...]} with exactly one entry for every time frame asked, and nothing else.',
].join('\n');

/** Each agent's personality in a few words, for the tests and the site's text: the name on the card must match this. */
export const PERSONALITIES = {
  'trend-follower': 'momentum: rides the trend',
  contrarian: 'fades the crowd and over-extended moves',
  'chart-reader': 'reads candle shapes and levels',
};

const utc = (sec) => new Date(sec * 1000).toISOString().slice(11, 16);
const num = (n) => (n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(Number(n.toPrecision(7))));

/**
 * The prompt for one coin at one moment.
 *   req: { coin ("BTC/USD"), candles [{time, open, high, low, close}], frames: [{ label ("5m"), roundSeconds, secondsToLock }] }
 */
export function buildBatchPrompt(req) {
  const longest = Math.max(...req.frames.map((f) => f.roundSeconds));
  const candles = req.candles.slice(-candlesFor(longest));
  const price = candles[candles.length - 1].close;
  const lines = candles.map((c) => `${utc(c.time)} ${num(c.open)} ${num(c.high ?? Math.max(c.open, c.close))} ${num(c.low ?? Math.min(c.open, c.close))} ${num(c.close)}`);
  const user = [
    `Coin: ${req.coin}. Current price: ${num(price)}.`,
    'Time frames to answer (the next round of each is about to take calls):',
    ...req.frames.map((f) => `- ${f.label}: rounds of ${Math.round(f.roundSeconds / 60)} minutes, calling closes in about ${Math.max(0, Math.round(f.secondsToLock))} seconds`),
    `Last ${candles.length} one-minute candles, oldest first, as "time(UTC) open high low close":`,
    ...lines,
    'Reply with JSON only, one entry per time frame, each with trend_follower, contrarian and chart_reader.',
  ].join('\n');
  return { system: SYSTEM, user };
}

/** One decision: an object with exactly `call` (UP or DOWN) and a non-empty `reason`. Returns { call, reason } or null. */
export function readDecision(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !keys.includes('call') || !keys.includes('reason')) return null;
  if (v.call !== 'UP' && v.call !== 'DOWN') return null;
  if (typeof v.reason !== 'string') return null;
  let reason = v.reason.replace(/\s+/g, ' ').trim();
  if (!reason) return null;
  if (reason.length > MAX_REASON) reason = reason.slice(0, MAX_REASON - 1).replace(/\s+\S*$/, '') + '…';
  return { call: v.call, reason };
}

/**
 * Strict reading of the model's whole answer: { frames: [ { frame, trend_follower, contrarian, chart_reader } ] } with exactly those keys.
 * Returns { [label]: { 'trend-follower': {call, reason} | null, contrarian: ..., 'chart-reader': ... } } for the labels asked, where a
 * decision that is missing or malformed is null (that agent skips that round), or null when nothing at all could be used.
 */
export function parseBatch(text, labels) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (Object.keys(v).length !== 1 || !Array.isArray(v.frames)) return null;
  const wanted = ['frame', ...AI_AGENTS.map((a) => JSON_KEY[a])];
  const out = {};
  let usable = 0;
  for (const item of v.frames) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const label = item.frame;
    if (typeof label !== 'string' || !labels.includes(label) || out[label]) continue;
    const keys = Object.keys(item);
    const shapeOk = keys.length === wanted.length && wanted.every((k) => keys.includes(k));
    out[label] = {};
    for (const agent of AI_AGENTS) {
      const d = shapeOk ? readDecision(item[JSON_KEY[agent]]) : null;
      out[label][agent] = d;
      if (d) usable++;
    }
  }
  if (usable === 0) return null;
  for (const label of labels) if (!out[label]) out[label] = Object.fromEntries(AI_AGENTS.map((a) => [a, null]));
  return out;
}

/** What a call cost, from the tokens and a price per million tokens. The free tier bills 0; this is the paid-tier equivalent. */
export const costUsd = (inTokens, outTokens, { inPerM, outPerM }) => (inTokens * inPerM + outTokens * outPerM) / 1_000_000;

/** The shape the model must answer in (Gemini's schema dialect), for the given time frame labels. */
export function batchSchema(labels) {
  const decision = {
    type: 'OBJECT',
    properties: { call: { type: 'STRING', enum: ['UP', 'DOWN'] }, reason: { type: 'STRING' } },
    required: ['call', 'reason'],
    propertyOrdering: ['call', 'reason'],
  };
  const keys = AI_AGENTS.map((a) => JSON_KEY[a]);
  return {
    type: 'OBJECT',
    properties: {
      frames: {
        type: 'ARRAY',
        minItems: labels.length,
        maxItems: labels.length,
        items: {
          type: 'OBJECT',
          properties: { frame: { type: 'STRING', enum: labels }, ...Object.fromEntries(keys.map((k) => [k, decision])) },
          required: ['frame', ...keys],
          propertyOrdering: ['frame', ...keys],
        },
      },
    },
    required: ['frames'],
  };
}

// Models that refused the thinking setting: remembered, so the next calls do not waste a request (and a second of waiting) on it.
// gemini-3.5-flash-lite is known to answer 400 to the thinking-off setting (seen on our key), so it starts here and no try is wasted on it.
const noThinking = new Set(['gemini-3.5-flash-lite']);
const MIN_TRY_MS = 2_000; // a try needs at least this long to be worth starting

/**
 * One Gemini call, with up to 3 tries. The first try has timeoutMs (16 s: our main model answers up to about 15 s), the second and third
 * fallbackTimeoutMs (8 s each), so the worst case is 16 + 1 + 8 + 1 + 8 = 34 s and the last try still lands long before the round locks. A timeout, a network error or a server
 * error is tried again (up to 3 tries); HTTP 429 only once more (a third request into a quota wall helps nobody), or not at all when
 * `retryOn429` is false (the guide calls: a limit or quota answer is final for that request).
 * The first try uses `model`; the second and third use `fallbackModel` (when one is given): a model that is slow or down at the
 * moment is not asked three times in a row. (After a 400 about the thinking setting the same model is asked again without it.)
 * `beforeRetry()` is asked before every try after the first: false stops the call (the runner counts each retry toward its daily and
 * per-minute limits there). `deadline` (ms since 1970) is when the answer is too late to be useful: no try starts that could not
 * finish before it, and no try may run past it.
 * `schema` is the answer's shape and `parse(text)` turns the answer's text into a value (or null when it is not what was asked for).
 * Returns { ok: true, value, tokensIn, tokensOut, latencyMs, attempts, model } or { ok: false, error, latencyMs, attempts, model }
 * (model: the one that answered, or the last one tried).
 * `plain` is for Gemma models: they take no system instruction, no JSON mode and no thinking setting, so the system text goes in front of the
 * user text and the answer is plain text that `parse` must pick the JSON out of.
 * Error texts are fixed short phrases: they never contain the key or the web address.
 */
export async function askGemini({ apiKey, model = DEFAULT_MODEL, system, user, schema, parse, maxOutputTokens = 1500, fetchFn = fetch, timeoutMs = 16_000, fallbackTimeoutMs = 8_000, retryDelayMs = 1_000, maxAttempts = 3, retryOn429 = true, plain = false, fallbackModel = null, deadline = Infinity, beforeRetry = () => true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const started = Date.now();
  if (!Number.isFinite(deadline)) deadline = Infinity;
  let lastError = 'no answer';
  let attempts = 0;
  let usedModel = model;
  let sameModelAgain = false; // after a 400 about the thinking setting: the next try is the same model, without that setting
  /** Waits, then says whether another try may start: tries left, time left before the deadline, and the runner's own limits. */
  const mayRetry = async (attempt) => {
    if (attempt >= maxAttempts || Date.now() + retryDelayMs + MIN_TRY_MS > deadline) return false;
    await sleep(retryDelayMs);
    return beforeRetry() !== false;
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const m = attempt === 1 || sameModelAgain || !fallbackModel ? usedModel : fallbackModel;
    const firstKind = attempt === 1 || sameModelAgain; // the first try, or the same try again without the thinking setting: the longer limit
    usedModel = m;
    sameModelAgain = false;
    const useThinkingOff = !plain && !noThinking.has(m);
    const body = plain
      ? { contents: [{ role: 'user', parts: [{ text: `${system}\n\n${user}` }] }], generationConfig: { temperature: 0.4, maxOutputTokens } }
      : {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens,
            responseMimeType: 'application/json',
            responseSchema: schema,
            ...(useThinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        };
    let res;
    try {
      res = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(firstKind ? timeoutMs : fallbackTimeoutMs, Math.max(MIN_TRY_MS, deadline - Date.now()))),
      });
    } catch (e) {
      lastError = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : 'network error';
      if (await mayRetry(attempt)) continue;
      break;
    }
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      if (res.status === 400 && useThinkingOff) { // some models refuse the thinking setting (and say so vaguely): once more without it
        noThinking.add(m); sameModelAgain = true;
        if (attempt < maxAttempts && beforeRetry() !== false) continue;
        break;
      }
      if ((res.status >= 500 || (res.status === 429 && retryOn429 && attempt === 1)) && await mayRetry(attempt)) continue;
      break;
    }
    let data;
    try { data = await res.json(); } catch { lastError = 'unreadable answer'; break; }
    const usage = data?.usageMetadata ?? {};
    const text = data?.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('') ?? '';
    const value = parse(text);
    if (value === null || value === undefined) { lastError = 'answer was not the required JSON'; break; }
    return {
      ok: true, value,
      tokensIn: usage.promptTokenCount ?? 0,
      tokensOut: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      latencyMs: Date.now() - started, attempts, model: usedModel,
    };
  }
  return { ok: false, error: lastError, latencyMs: Date.now() - started, attempts, model: usedModel };
}

// ---------------------------------------------------------------------------------------------------------------------------
// GUIDE CALLS (mainnet): no money moves and nothing goes on chain. Each AI agent gets ONE request per 5-minute cycle that covers
// every coin and every time frame whose next round is open and has no call from it yet (so at most 12 requests an hour per agent).
// The answer is one call and one short reason for each (coin, time frame) asked.
// ---------------------------------------------------------------------------------------------------------------------------
export const GUIDE_LABEL = 'Guide call, no money';

const GUIDE_PERSONAS = {
  'trend-follower': 'You are the Trend Follower: you believe in momentum, a price that has been moving one way tends to keep going over the next few minutes. You ride the trend and look at the direction and strength of the recent move.',
  contrarian: 'You are the Contrarian: you fade over-extended moves, when the price has run hard one way you lean the other way. No crowd can be seen, so give the side you would take against the recent move or the likely crowd.',
  'chart-reader': 'You are the Chart Reader: you read candle shapes and levels: the size and direction of candles, wicks, highs and lows, recent support and resistance, and how the short-term average compares with the longer one.',
};

const GUIDE_SYSTEM = (agent) => [
  'You make guide calls in Kairo Markets, a small game where each player calls whether a coin price will be UP or DOWN over a round. A guide call moves no money: it only shows how you read the market.',
  GUIDE_PERSONAS[agent],
  'You are given, for each coin, the last one-minute candles and the time frames whose next round is about to take calls. For every coin and time frame asked, give one call. You must call UP or DOWN and cannot skip.',
  'A round starts when calling closes; its start price is the first trade after that and its end price is the last trade when it ends. UP wins if the end price is higher than the start price.',
  'Each reason is ONE short plain sentence (under 140 characters) in your own style that uses a real number or fact from the data you were given. No advice, no hype, no mention of being an AI. Never use the words bet, wager or odds: say call or position.',
  'Reply with JSON only: {"calls":[{"coin":"BTC","frame":"5m","call":"UP"|"DOWN","reason":"..."}, ...]} with exactly one entry for every coin and time frame asked, and nothing else.',
].join('\n');

// Gemma takes at most 16K input tokens a minute, so a request to it stays under about 12K. Its prompt is shorter: a shorter instruction, fewer
// candles (cut until the estimate fits) and plain numbers. The other models' prompt is not touched.
export const GEMMA_INPUT_BUDGET = 11_000; // estimated tokens: below the 12K target, because the estimate can be a little low
const MIN_COMPACT_CANDLES = 20;
/** A cautious token estimate for this kind of text: Gemma reads every digit as a token of its own, other characters about half a token. */
export function estimateTokens(text) {
  let digits = 0;
  for (const ch of text) if (ch >= '0' && ch <= '9') digits++;
  return Math.ceil(digits + (text.length - digits) * 0.5);
}

const COMPACT_SYSTEM = (agent) => [
  'Kairo Markets guide calls: call whether a coin price will be UP or DOWN over a round. No money moves.',
  GUIDE_PERSONAS[agent],
  'For every coin and time frame listed, give one call, UP or DOWN, and one reason: one short plain sentence (under 100 characters) using a real number from the data. Never use the words bet, wager or odds.',
  'Reply with ONLY this JSON, no code fence and no other text: {"calls":[{"coin":"BTC","frame":"5m","call":"UP","reason":"..."}]} with exactly one entry for every coin and time frame listed.',
].join('\n');

/** "BTC/USD" -> "BTC": how the model and the logs name a coin. */
export const coinShort = (pair) => String(pair).split('/')[0];

/** The model's words for a call must follow the site's wording: call, position, back an agent. */
export function guideWording(text) {
  return text
    .replace(/\bbetting\b/gi, 'calling').replace(/\bbets\b/gi, 'calls').replace(/\bbet\b/gi, 'call')
    .replace(/\bwagers\b/gi, 'calls').replace(/\bwager\b/gi, 'call').replace(/\bodds\b/gi, 'chances');
}

/**
 * The prompt for one agent at one moment.
 *   coins: [{ coin ("BTC/USD"), candles [{time, open, high, low, close}], frames: [{ label ("5m"), roundSeconds, secondsToLock }] }]
 */
export function buildGuidePrompt({ agent, coins, compact = false }) {
  if (compact) { // for Gemma: shorter instruction, fewer candles until the estimate fits
    const system = COMPACT_SYSTEM(agent);
    let user = '';
    for (let cap = MAX_SENT; ; cap = Math.max(MIN_COMPACT_CANDLES, Math.floor(cap * 0.85))) {
      user = guideUser(coins, { cap, compact: true });
      if (estimateTokens(system + user) <= GEMMA_INPUT_BUDGET || cap <= MIN_COMPACT_CANDLES) break;
    }
    return { system, user };
  }
  return { system: GUIDE_SYSTEM(agent), user: guideUser(coins, { cap: MAX_SENT, compact: false }) };
}

function guideUser(coins, { cap, compact }) {
  const fmt = compact ? (n) => String(Math.round(n * 100) / 100) : num; // compact: no thousands separators
  const parts = ['Make one guide call for every coin and time frame listed.'];
  for (const c of coins) {
    const longest = Math.max(...c.frames.map((f) => f.roundSeconds));
    const candles = c.candles.slice(-Math.min(cap, candlesFor(longest)));
    const price = candles[candles.length - 1].close;
    parts.push(
      '',
      `Coin: ${coinShort(c.coin)}. Current price: ${fmt(price)}.`,
      'Time frames to answer (the next round of each is about to take calls):',
      ...c.frames.map((f) => `- ${f.label}: rounds of ${Math.round(f.roundSeconds / 60)} minutes, calling closes in about ${Math.max(0, Math.round(f.secondsToLock))} seconds`),
      `Last ${candles.length} one-minute candles of ${coinShort(c.coin)}, oldest first, as "time(UTC) open high low close":`,
      ...candles.map((k) => `${utc(k.time)} ${fmt(k.open)} ${fmt(k.high ?? Math.max(k.open, k.close))} ${fmt(k.low ?? Math.min(k.open, k.close))} ${fmt(k.close)}`),
    );
  }
  parts.push('', 'Reply with JSON only, one entry for every coin and time frame listed above.');
  return parts.join('\n');
}

/** The shape the model must answer in, for the given entries [{ coin: "BTC", frame: "5m" }]. */
export function guideSchema(entries) {
  const coins = [...new Set(entries.map((e) => e.coin))];
  const frames = [...new Set(entries.map((e) => e.frame))];
  return {
    type: 'OBJECT',
    properties: {
      calls: {
        type: 'ARRAY',
        minItems: entries.length,
        maxItems: entries.length,
        items: {
          type: 'OBJECT',
          properties: { coin: { type: 'STRING', enum: coins }, frame: { type: 'STRING', enum: frames }, call: { type: 'STRING', enum: ['UP', 'DOWN'] }, reason: { type: 'STRING' } },
          required: ['coin', 'frame', 'call', 'reason'],
          propertyOrdering: ['coin', 'frame', 'call', 'reason'],
        },
      },
    },
    required: ['calls'],
  };
}

/**
 * Strict reading of the answer: { calls: [ { coin, frame, call, reason } ] } with exactly those keys. Returns
 * { "BTC:5m": { call, reason } | null, ... } for the entries asked (a missing or malformed one is null: that call is skipped),
 * or null when nothing at all could be used.
 */
export function parseGuide(text, entries) {
  let v;
  try { v = JSON.parse(text); } catch {
    // Gemma answers in plain text: possibly a code fence or a sentence around the JSON. Take what is between the first { and the last }.
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { v = JSON.parse(text.slice(a, b + 1)); } catch { return null; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (Object.keys(v).length !== 1 || !Array.isArray(v.calls)) return null;
  const wanted = new Set(entries.map((e) => `${e.coin}:${e.frame}`));
  const out = {};
  let usable = 0;
  for (const item of v.calls) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const key = `${item.coin}:${item.frame}`;
    if (!wanted.has(key) || key in out) continue;
    const keys = Object.keys(item);
    if (keys.length !== 4 || !['coin', 'frame', 'call', 'reason'].every((k) => keys.includes(k))) continue;
    const d = readDecision({ call: item.call, reason: item.reason });
    if (!d) continue;
    out[key] = { call: d.call, reason: guideWording(d.reason) };
    usable++;
  }
  if (usable === 0) return null;
  for (const k of wanted) if (!(k in out)) out[k] = null;
  return out;
}
