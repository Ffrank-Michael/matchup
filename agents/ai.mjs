// The AI behind Trend Follower, Contrarian and Chart Reader: one small Gemini model call per agent per round.
// (Coin Flipper stays random: it is the benchmark, "Can AI beat a coin flip?")
//
// Everything here is pure or takes its network function as an argument, so the tests never reach the internet.
// The API key is sent in a header (never in the web address), and nothing in this file ever prints or returns it.
import { fmtUsdc } from './lib.mjs';

export const AI_AGENTS = ['trend-follower', 'contrarian', 'chart-reader'];
export const MIN_CANDLES = 10;     // fewer than this is a data outage: the agent cannot decide
export const CANDLES_SENT = 30;    // the model sees the last 30 one-minute candles
export const MAX_REASON = 140;     // characters kept of the reason
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite'; // fast and cheap; 'gemini-flash-latest' timed out on our key
export const COULDNT_DECIDE = "Couldn't decide this round";

const COMMON = [
  'You are one of four players in Kairo Markets, a small game where each player calls whether a coin price will be UP or DOWN over the next round.',
  'You are told the market, the last 30 one-minute candles, the current price and the money already on each side. The round you call starts when calling closes; its start price is the first trade after that and its end price is the last trade when it ends. UP wins if the end price is higher than the start price.',
  'You must call UP or DOWN. You cannot skip, and you cannot ask for more data.',
  'Reply with JSON only, exactly: {"call":"UP"|"DOWN","reason":"..."}.',
  'The reason is ONE short plain sentence (under 140 characters) that uses a real number or fact from the data you were given. No advice, no hype, no mention of being an AI.',
].join(' ');

/** Each agent's personality: what it believes, and how it looks at the data. The name on the card must match this. */
export const PERSONALITIES = {
  'trend-follower': 'You are Trend Follower. You believe in momentum: a price that has been moving one way tends to keep going over the next few minutes. You ride the trend and look at the direction and strength of the recent move.',
  contrarian: 'You are Contrarian. You fade the crowd and over-extended moves: when a lot of money is on one side, or the price has run hard one way, you take the other side. You look at where the money is and at how stretched the last move is.',
  'chart-reader': 'You are Chart Reader. You read candle shapes and levels: the size and direction of candles, wicks, highs and lows, recent support and resistance, and how the short-term average compares with the longer one.',
};

const utc = (sec) => new Date(sec * 1000).toISOString().slice(11, 16);
const num = (n) => (n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(Number(n.toPrecision(7))));

/**
 * The prompt for one decision.
 *   req: { agent, market ("BTC/USD 5m"), roundSeconds, secondsToLock, candles [{time, open, high, low, close}], bets {up, down} (micro-USDC), forcedSide? }
 */
export function buildPrompt(req) {
  const candles = req.candles.slice(-CANDLES_SENT);
  const price = candles[candles.length - 1].close;
  const lines = candles.map((c) => `${utc(c.time)} ${num(c.open)} ${num(c.high ?? Math.max(c.open, c.close))} ${num(c.low ?? Math.min(c.open, c.close))} ${num(c.close)}`);
  const user = [
    `Market: ${req.market}. Round length: ${Math.round(req.roundSeconds / 60)} minutes. Calling for this round closes in about ${Math.max(0, Math.round(req.secondsToLock))} seconds.`,
    `Current price: ${num(price)}.`,
    `Last ${candles.length} one-minute candles, oldest first, as "time(UTC) open high low close":`,
    ...lines,
    `Money already in this round: UP ${fmtUsdc(req.bets.up)}, DOWN ${fmtUsdc(req.bets.down)}. Only matched money plays: the extra on the bigger side comes back.`,
    req.forcedSide
      ? `The game rules fix your call: ${req.forcedSide} has no money yet and a round needs two sides, so your call is ${req.forcedSide}. Return call "${req.forcedSide}" and give one sentence on why that fits you.`
      : 'Make your call.',
    'Reply with JSON only: {"call":"UP"|"DOWN","reason":"one short sentence"}',
  ].join('\n');
  return { system: `${PERSONALITIES[req.agent]} ${COMMON}`, user };
}

/** Strict reading of the model's answer: a JSON object with exactly `call` (UP or DOWN) and a non-empty `reason`. Returns { call, reason } or null. */
export function parseAnswer(text, forcedSide = null) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !keys.includes('call') || !keys.includes('reason')) return null;
  if (v.call !== 'UP' && v.call !== 'DOWN') return null;
  if (typeof v.reason !== 'string') return null;
  let reason = v.reason.replace(/\s+/g, ' ').trim();
  if (!reason) return null;
  if (reason.length > MAX_REASON) reason = reason.slice(0, MAX_REASON - 1).replace(/\s+\S*$/, '') + '…';
  return { call: forcedSide ?? v.call, reason };
}

/** What a call cost, from the tokens and a price per million tokens. The free tier bills 0; this is the paid-tier equivalent. */
export const costUsd = (inTokens, outTokens, { inPerM, outPerM }) => (inTokens * inPerM + outTokens * outPerM) / 1_000_000;

// Models that refused the thinking setting: remembered, so the next calls do not waste a request (and a second of waiting) on it.
const noThinking = new Set();

const responseSchema = {
  type: 'OBJECT',
  properties: { call: { type: 'STRING', enum: ['UP', 'DOWN'] }, reason: { type: 'STRING' } },
  required: ['call', 'reason'],
  propertyOrdering: ['call', 'reason'],
};

/**
 * One Gemini call, with one quick retry on a timeout, a network error, HTTP 429 or a server error.
 * Returns { ok: true, call, reason, tokensIn, tokensOut, latencyMs, attempts } or { ok: false, error, latencyMs, attempts }.
 * Error texts are fixed short phrases: they never contain the key or the web address.
 */
export async function askGemini({ apiKey, model = DEFAULT_MODEL, system, user, forcedSide = null, fetchFn = fetch, timeoutMs = 10_000, retryDelayMs = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const started = Date.now();
  let useThinkingOff = !noThinking.has(model);
  let lastError = 'no answer';
  let attempts = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 200,
        responseMimeType: 'application/json',
        responseSchema,
        ...(useThinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    };
    let res;
    try {
      res = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastError = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : 'network error';
      if (attempt === 1) { await sleep(retryDelayMs); continue; }
      break;
    }
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      if (res.status === 400 && useThinkingOff) { useThinkingOff = false; noThinking.add(model); continue; } // some models refuse the thinking setting (and say so vaguely): once more without it
      if ((res.status === 429 || res.status >= 500) && attempt === 1) { await sleep(retryDelayMs); continue; }
      break;
    }
    let data;
    try { data = await res.json(); } catch { lastError = 'unreadable answer'; break; }
    const usage = data?.usageMetadata ?? {};
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const parsed = parseAnswer(text, forcedSide);
    if (!parsed) { lastError = 'answer was not the required JSON'; break; }
    return {
      ok: true, ...parsed,
      tokensIn: usage.promptTokenCount ?? 0,
      tokensOut: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      latencyMs: Date.now() - started, attempts,
    };
  }
  return { ok: false, error: lastError, latencyMs: Date.now() - started, attempts };
}

