// The runner's side of the AI agents: asks Gemini in the background, remembers the answers for the planner, and writes the log.
//
//   const ai = createAi({ env, live, log });
//   ai.request(req)      start (once) the call for a decision id; planTick() later reads ai.results.get(id)
//   ai.results           Map: decision id -> { ok, call, reason } | { ok: false, error }
//
// Every call is logged with model, tokens and cost to the runner log and to data/ai-log.jsonl. The key (GEMINI_API_KEY) comes
// from .env only and is never logged. In a dry run no call is made: the log only says what it WOULD ask.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../scripts/lib.mjs';
import { askGemini, buildPrompt, costUsd, DEFAULT_MODEL } from '../agents/ai.mjs';

export const AI_LOG_FILE = path.join(ROOT, 'data', 'ai-log.jsonl');
const KEEP_MS = 15 * 60_000; // answers are kept this long
const numOr = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export function createAi({ env = process.env, live = false, log = () => {}, askFn = askGemini, file = AI_LOG_FILE, now = () => Date.now() } = {}) {
  const apiKey = env.GEMINI_API_KEY || '';
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  // Paid-tier equivalent per million tokens. The free tier bills nothing; these numbers only say what the same calls would cost. Check ai.google.dev/pricing.
  const price = { inPerM: numOr(env.GEMINI_PRICE_IN_PER_M, 0.30), outPerM: numOr(env.GEMINI_PRICE_OUT_PER_M, 2.50) };
  const dailyCap = numOr(env.GEMINI_MAX_CALLS_PER_DAY, 1200);
  const perMinute = numOr(env.GEMINI_MAX_PER_MINUTE, 10); // the free tier allows about 15 a minute for a Flash model
  const recent = []; // start times of the last minute's calls
  const results = new Map(); // id -> { ok, call, reason, error, at }
  const asked = new Set();
  const day = { date: '', started: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
  let warnedNoKey = false;

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

  async function run(req) {
    const { system, user } = buildPrompt(req);
    const out = await askFn({ apiKey, model, system, user, forcedSide: req.forcedSide });
    rollDay();
    const base = { t: new Date(now()).toISOString(), agent: req.agent, market: req.market, round: req.round, model, latencyMs: out.latencyMs, attempts: out.attempts };
    if (out.ok) {
      const cost = costUsd(out.tokensIn, out.tokensOut, price);
      day.tokensIn += out.tokensIn; day.tokensOut += out.tokensOut; day.cost += cost;
      write({ ...base, ok: true, call: out.call, tokensIn: out.tokensIn, tokensOut: out.tokensOut, costUsd: Number(cost.toFixed(6)) });
      log(`AI ${req.agent} ${req.market} round ${req.round}: ${out.call} (${model}, ${out.tokensIn} in / ${out.tokensOut} out tokens, about $${cost.toFixed(5)} at paid prices, ${out.latencyMs} ms)\n         "${out.reason}"`);
      results.set(req.id, { ok: true, call: out.call, reason: out.reason, model, at: now() });
    } else {
      write({ ...base, ok: false, error: out.error });
      log(`AI ${req.agent} ${req.market} round ${req.round}: no answer (${out.error}, ${out.attempts} tries, ${out.latencyMs} ms), so the agent skips this round`);
      results.set(req.id, { ok: false, error: out.error, model, at: now() });
    }
  }

  return {
    results, model, price,
    /** Starts the call for a decision id, once. The answer shows up in `results` a moment later. */
    request(req) {
      prune();
      if (asked.has(req.id)) return;
      asked.add(req.id);
      rollDay();
      if (!live) {
        log(`WOULD ask ${model}: ${req.agent} ${req.market} round ${req.round} (${req.candles.length} candles, UP ${req.bets.up} / DOWN ${req.bets.down}${req.forcedSide ? ', side fixed: ' + req.forcedSide : ''})`);
        return;
      }
      if (!apiKey) {
        if (!warnedNoKey) { warnedNoKey = true; log("AI: GEMINI_API_KEY is not set in .env, so the three AI agents cannot decide and skip every round (\"Couldn't decide this round\")."); }
        results.set(req.id, { ok: false, error: 'no API key', at: now() });
        return;
      }
      if (day.started >= dailyCap) {
        log(`AI: daily limit of ${dailyCap} calls reached (GEMINI_MAX_CALLS_PER_DAY); ${req.agent} skips this round`);
        results.set(req.id, { ok: false, error: 'daily limit reached', at: now() });
        return;
      }
      const t = now();
      while (recent.length && recent[0] < t - 60_000) recent.shift();
      if (recent.length >= perMinute) {
        log(`AI: more than ${perMinute} calls in a minute (GEMINI_MAX_PER_MINUTE); ${req.agent} skips this round`);
        results.set(req.id, { ok: false, error: 'too many calls at once', at: now() });
        return;
      }
      recent.push(t);
      day.started++;
      run(req).catch((e) => {
        results.set(req.id, { ok: false, error: 'unexpected error', at: now() });
        log(`AI: unexpected error (${String(e.message).slice(0, 80)})`);
      });
    },
    /** A short line for the log: what today's calls added up to. */
    summary() { rollDay(); return `AI today: ${day.started} calls, ${day.tokensIn} in / ${day.tokensOut} out tokens, about $${day.cost.toFixed(4)} at paid prices`; },
  };
}
