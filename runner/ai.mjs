// The runner's side of the AI agents: asks Gemini in the background (one call per coin per opening moment, for every agent and
// every time frame that opens then), remembers the answers for the planner, and writes the log.
//
//   const ai = createAi({ env, live, log });
//   ai.request(req, { prepare })   start (once) the call for a batch id; planTick() later reads ai.results.get(id)
//   ai.results                     Map: batch id -> { ok: true, decisions: { [marketId]: { [agent]: { call, reason } | null } } } | { ok: false, error }
//
// req = { id, coin, opensAt, frames: [{ marketId, market, label, roundSeconds, round, secondsToLock }], candles }
// Every call is logged with model, tokens and cost to the runner log and to data/ai-log.jsonl. The key (GEMINI_API_KEY) comes
// from .env only and is never logged. In a dry run no call is made: the log only says what it WOULD ask.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../scripts/lib.mjs';
import { AI_AGENTS, askGemini, batchSchema, buildBatchPrompt, candlesFor, costUsd, DEFAULT_FALLBACK_MODEL, DEFAULT_MODEL, parseBatch } from '../agents/ai.mjs';

export const AI_LOG_FILE = path.join(ROOT, 'data', 'ai-log.jsonl');
const KEEP_MS = 15 * 60_000; // answers are kept this long
const QUOTA_PAUSE_MS = 5 * 60_000; // after an HTTP 429 nothing is asked for this long
const numOr = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export function createAi({ env = process.env, live = false, log = () => {}, askFn = askGemini, file = AI_LOG_FILE, now = () => Date.now() } = {}) {
  const apiKey = env.GEMINI_API_KEY || '';
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  // The second and third try of a call go to this model, so one slow or overloaded model does not use up all three tries.
  const fallbackModel = env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
  const timeoutMs = Math.max(1, numOr(env.GEMINI_TIMEOUT_SECONDS, 16)) * 1000;               // the first try
  const fallbackTimeoutMs = Math.max(1, numOr(env.GEMINI_FALLBACK_TIMEOUT_SECONDS, 8)) * 1000; // the second and third try
  // Paid-tier equivalent per million tokens. The free tier bills nothing; these numbers only say what the same calls would cost. Check ai.google.dev/pricing.
  const price = { inPerM: numOr(env.GEMINI_PRICE_IN_PER_M, 0.30), outPerM: numOr(env.GEMINI_PRICE_OUT_PER_M, 2.50) };
  const dailyCap = numOr(env.GEMINI_MAX_CALLS_PER_DAY, 1200);
  const perMinute = numOr(env.GEMINI_MAX_PER_MINUTE, 6); // the free tier allows about 10 a minute; the runner needs about 1
  const recent = []; // start times of the last minute's calls
  const results = new Map(); // id -> { ok, decisions, error, at }
  const asked = new Set();
  const day = { date: '', started: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
  let warnedNoKey = false;
  let pausedUntil = 0;

  function rollDay() {
    const d = new Date(now()).toISOString().slice(0, 10);
    if (day.date !== d) Object.assign(day, { date: d, started: 0, tokensIn: 0, tokensOut: 0, cost: 0 });
  }

  function write(entry) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(entry) + '\n'); } catch { /* the log is a convenience */ }
  }

  function prune() {
    const cutoff = now() - KEEP_MS;
    for (const [id, r] of results) if (r.at < cutoff) { results.delete(id); asked.delete(id); }
  }

  const fail = (id, error) => results.set(id, { ok: false, error, at: now() });

  /** Asked before every retry of a call. A retry is a real request to Gemini, so it counts toward the daily and the per-minute limit like a first try; at either limit the call stops. */
  function allowRetry() {
    rollDay();
    if (day.started >= dailyCap) return false;
    const t = now();
    while (recent.length && recent[0] < t - 60_000) recent.shift();
    if (recent.length >= perMinute) return false;
    recent.push(t);
    day.started++;
    return true;
  }

  async function run(req, prepare) {
    const labels = req.frames.map((f) => f.label);
    const longest = Math.max(...req.frames.map((f) => f.roundSeconds));
    const candles = (prepare ? await prepare(req) : req.candles).slice(-candlesFor(longest));
    const { system, user } = buildBatchPrompt({ coin: req.coin, candles, frames: req.frames });
    // An answer is useless once the early agents' time is over: one minute before the first frame locks (earlyCutoff in config.mjs).
    const nextLock = Math.min(...req.frames.map((f) => f.secondsToLock));
    const deadline = now() + Math.max(0, nextLock - 60) * 1000;
    const out = await askFn({
      apiKey, model, fallbackModel, timeoutMs, fallbackTimeoutMs, system, user, deadline, beforeRetry: allowRetry,
      schema: batchSchema(labels),
      parse: (text) => parseBatch(text, labels),
      maxOutputTokens: 400 + 260 * labels.length,
    });
    rollDay();
    const base = { t: new Date(now()).toISOString(), coin: req.coin, frames: labels, candles: candles.length, model: out.model ?? model, latencyMs: out.latencyMs, attempts: out.attempts };
    if (!out.ok) {
      if (out.error === 'HTTP 429') {
        pausedUntil = now() + QUOTA_PAUSE_MS;
        log('AI: Gemini says too many requests (a free-tier limit). Not asking again for 5 minutes; the AI agents skip until then.');
      }
      write({ ...base, ok: false, error: out.error });
      log(`AI ${req.coin} ${labels.join('+')}: no answer (${out.error}, ${out.attempts} tries, ${out.latencyMs} ms), so these agents skip this round`);
      fail(req.id, out.error);
      return;
    }
    const cost = costUsd(out.tokensIn, out.tokensOut, price);
    day.tokensIn += out.tokensIn; day.tokensOut += out.tokensOut; day.cost += cost;
    const decisions = {};
    const lines = [];
    let missing = 0;
    for (const f of req.frames) {
      decisions[f.marketId] = out.value[f.label];
      for (const agent of AI_AGENTS) {
        const d = out.value[f.label][agent];
        if (d) lines.push(`         ${f.label} ${agent}: ${d.call} "${d.reason}"`); else missing++;
      }
    }
    write({ ...base, ok: true, tokensIn: out.tokensIn, tokensOut: out.tokensOut, costUsd: Number(cost.toFixed(6)), decisions: labels.length * AI_AGENTS.length - missing });
    log(`AI ${req.coin} ${labels.join('+')}: ${lines.length} decisions (${base.model}, ${candles.length} candles, ${out.tokensIn} in / ${out.tokensOut} out tokens, about $${cost.toFixed(5)} at paid prices, ${out.latencyMs} ms${missing ? `, ${missing} missing` : ''})\n${lines.join('\n')}`);
    results.set(req.id, { ok: true, decisions, model: base.model, at: now() });
  }

  return {
    results, model, price,
    /** Starts the call for a batch id, once. The answer shows up in `results` a moment later. `prepare(req)` may return fresher candles. */
    request(req, { prepare } = {}) {
      prune();
      if (asked.has(req.id)) return;
      asked.add(req.id);
      rollDay();
      const labels = req.frames.map((f) => f.label).join('+');
      if (!live) {
        log(`WOULD ask ${model}: ${req.coin} ${labels} (${req.candles.length} candles) for the three AI agents`);
        return;
      }
      if (!apiKey) {
        if (!warnedNoKey) { warnedNoKey = true; log("AI: GEMINI_API_KEY is not set in .env, so the three AI agents cannot decide and skip every round (\"Couldn't decide this round\")."); }
        fail(req.id, 'no API key');
        return;
      }
      if (now() < pausedUntil) { fail(req.id, 'rate limited'); return; }
      if (day.started >= dailyCap) {
        log(`AI: daily limit of ${dailyCap} calls reached (GEMINI_MAX_CALLS_PER_DAY); the AI agents skip until tomorrow (UTC)`);
        fail(req.id, 'daily limit reached');
        return;
      }
      const t = now();
      while (recent.length && recent[0] < t - 60_000) recent.shift();
      if (recent.length >= perMinute) {
        log(`AI: more than ${perMinute} calls in a minute (GEMINI_MAX_PER_MINUTE); ${req.coin} ${labels} skips`);
        fail(req.id, 'too many calls at once');
        return;
      }
      recent.push(t);
      day.started++;
      run(req, prepare).catch((e) => {
        fail(req.id, 'unexpected error');
        log(`AI: unexpected error (${String(e.message).slice(0, 80)})`);
      });
    },
    /** A short line for the log: what today's calls added up to. */
    summary() { rollDay(); return `AI today: ${day.started} calls, ${day.tokensIn} in / ${day.tokensOut} out tokens, about $${day.cost.toFixed(4)} at paid prices`; },
  };
}
