// GUIDE CALLS for the mainnet runner: the four agents (Trend Follower, Contrarian, Chart Reader, Coin Flipper) call UP or DOWN on every
// open round of every market, whether or not any person is playing. A guide call moves no money and nothing goes on chain.
//
//   const guide = createGuide({ env, live, log, getCandles });
//   guide.tick(snap)      once per runner pass: starts whatever is due in the background and returns at once (it never waits for Gemini)
//
// WHEN
//   Coin Flipper    random, no Gemini: its call for a round is made as soon as the round is seen (the call window is open).
//   The 3 AI agents ONE Gemini request per agent per 5-minute cycle (so at most 12 an hour per agent), started a few seconds into the cycle.
//                   It covers every coin and every time frame whose next round is open and has no call from that agent yet, so a
//                   single request holds BTC, ETH and SOL and, when they line up, the 10 min, 30 min and 1 hour rounds too.
//                   The request count does not depend on how many coins or time frames are covered, so nothing has to be dropped to stay
//                   within a free limit; only the amount of text in a request changes.
// SAVED
//   Each call is saved with the time it was made, before its round locks, and is never changed afterwards: the file is append-only, the
//   runner never saves a (market, round, agent) twice, and the copy on Upstash is written with HSETNX (set only if it is not there yet).
//   Where the site reads them: Upstash hash kairo:guide, field "<market>:<round>:<agent>"; the score of a round is field "<market>:<round>:res".
// GEMINI LIMITS
//   A limit or quota answer (HTTP 429) ends that request: no retry, and nothing is asked for 10 minutes. Any other failure skips those
//   calls ("Couldn't decide this round"). One retry only for a timeout or a server error, counted like any request. Everything Gemini
//   does runs in the background: the runner's price pushes and settles are never held up. The runner logs the number of requests each hour.
// SCORING
//   When a round ends each call is scored against the Bitfinex price at its start and end: the same prices the runner put on chain
//   (its price log) when the round was played, otherwise the first trade after the lock and the last trade before the end, asked from
//   Bitfinex's trade history. Won, lost, or no result when the two prices are equal. No gas, no settle.
// Nothing here ever prints a key.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../scripts/lib.mjs';
import { askGemini, buildGuidePrompt, guideSchema, parseGuide, coinShort, frameLabel, MIN_CANDLES, COULDNT_DECIDE, DEFAULT_MODEL, DEFAULT_FALLBACK_MODEL } from '../agents/ai.mjs';
import { lockTime } from './plan.mjs';
import { readPriceLog } from './priceLog.mjs';
import { SYMBOLS } from './exchangePrices.mjs';

export const GUIDE_AGENTS = ['trend-follower', 'contrarian', 'chart-reader', 'coin-flipper'];
export const GUIDE_AI_AGENTS = ['trend-follower', 'contrarian', 'chart-reader'];
export const GUIDE_FILE = path.join(ROOT, 'data', 'guide-calls-mainnet.jsonl');
export const GUIDE_STATE_FILE = path.join(ROOT, 'data', 'guide-state-mainnet.json');
export const GUIDE_PRICE_FILE = path.join(ROOT, 'data', 'guide-prices-mainnet.jsonl');
export const GUIDE_HASH = 'kairo:guide';
export const CYCLE_SECONDS = 300;
export const GUIDE_CFG = {
  askAfter: 3,            // the AI is asked this long after a cycle starts (the last minute's candle is in)
  minLeft: 25,            // an AI request only covers rounds that still have this many seconds before they lock
  flipMinLeft: 5,         // the Coin Flipper still calls a round that locks in more than this
  publishMargin: 3,       // an answer that lands within this many seconds of the lock is dropped: a call is saved before the round locks
  scoreAfter: 15,         // a round is scored this long after it ends
  scoreUntil: 6 * 3600,   // ... and given up on after this long (Bitfinex was out)
  maxFetchesPerPass: 4,   // trade-history requests per scoring pass
  fetchGapMs: 1_500,      // between two trade-history requests (Bitfinex allows 10 to 90 a minute)
  retryFetchMs: 60_000,   // a price that could not be fetched is asked again after this
  keepSeconds: 3 * 86400, // calls older than this are removed from Upstash
  quotaPauseMs: 10 * 60_000, // after HTTP 429 nothing is asked for this long
  dailyCap: 1200,         // the runner's own ceiling on Gemini requests per UTC day (GEMINI_MAX_CALLS_PER_DAY)
  perMinute: 6,           // ... and per minute (the free tier allows about 10)
  expectedPerDay: 3 * (86400 / CYCLE_SECONDS), // 3 AI agents x 288 cycles = 864 requests a day when every request succeeds
};

export const callField = (m, r, agent) => `${m}:${r}:${agent}`;
export const resField = (m, r) => `${m}:${r}:res`;
const numOr = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

/** Rounds that can be called right now: each market's next round, if it is not paused and still has `minLeft` seconds before it locks. */
export function dueRounds(markets, nowSec, minLeft = GUIDE_CFG.minLeft) {
  const out = [];
  for (const m of markets) {
    if (m.paused) continue;
    const round = m.nextRound;
    const lock = lockTime(m, round);
    if (lock - nowSec < minLeft) continue;
    const coin = m.name.split(' ')[0];
    out.push({ marketId: m.id, market: m.name, coin, short: coinShort(coin), label: frameLabel(m.roundLength), roundSeconds: m.roundLength, round, lock, end: lock + m.roundLength, secondsToLock: lock - nowSec });
  }
  return out;
}

/** The side that won a round from its two prices, or FLAT. */
export const outcomeOf = (start, end) => (end > start ? 'UP' : end < start ? 'DOWN' : 'FLAT');
/** One call's result: won, lost, or none (the price did not change). */
export const resultOf = (call, outcome) => (outcome === 'FLAT' ? 'none' : call === outcome ? 'won' : 'lost');

const usd = (p) => '$' + Number(p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

/** The newest finished minute must be in the candles: make sure of it (the AI is asked seconds after a minute turns). */
export async function freshCandles(candleSource, coin, { nowMs = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const wantLast = Math.floor(nowMs() / 60_000) * 60 - 60;
  let candles = await candleSource.get(coin);
  for (let i = 0; i < 3 && (candles[candles.length - 1]?.time ?? 0) < wantLast; i++) {
    await sleep(1500);
    try { candles = await candleSource.get(coin, { force: true }); } catch { break; }
  }
  return candles;
}

export function createGuide({
  env = process.env, live = false, log = () => {}, getCandles, askFn = askGemini, fetchFn = fetch, now = () => Date.now(),
  random = Math.random, file = GUIDE_FILE, stateFile = GUIDE_STATE_FILE, priceFile = GUIDE_PRICE_FILE, chainPriceLog = () => readPriceLog(),
  cfg: over = {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const cfg = { ...GUIDE_CFG, dailyCap: numOr(env.GEMINI_MAX_CALLS_PER_DAY, GUIDE_CFG.dailyCap), ...over };
  const apiKey = env.GEMINI_API_KEY || '';
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const fallbackModel = env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
  const redisUrl = String(env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN || '';
  const nowSec = () => Math.floor(now() / 1000);

  const calls = new Map();    // field -> record (a call, or a skip), kept for about 4 days
  const scored = new Set();   // "market:round" already scored
  const resultsOf = new Map(); // "market:round" -> score record
  const busy = new Set();     // agents with a request in flight
  const woulds = new Set();   // dry run: what was already announced
  const cycleCandles = new Map(); // "cycle:coin" -> Promise of candles, shared by the three agents' requests
  let state = { asked: {}, day: { date: '', started: 0 } };
  const hour = { key: '', started: 0, byAgent: {} };
  const recent = [];          // start times of the last minute's requests
  let pausedUntil = 0;
  let warnedNoKey = false, warnedRedis = false, scoring = false, lastPrune = 0, markets = [];

  // ---- local files (append-only) ----
  function append(f, entry) {
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(entry) + '\n'); } catch (e) { log(`GUIDE: could not write ${path.basename(f)} (${String(e.message).slice(0, 80)})`); }
  }
  function load() {
    try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* first run */ }
    try {
      const since = nowSec() - 4 * 86400;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'score') { if (e.end >= since) { scored.add(`${e.m}:${e.r}`); resultsOf.set(`${e.m}:${e.r}`, e); } continue; }
        if (e.a && e.end >= since && !calls.has(callField(e.m, e.r, e.a))) calls.set(callField(e.m, e.r, e.a), e);
      }
    } catch { /* no file yet */ }
  }
  function saveState() {
    if (!live) return;
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state)); } catch { /* the counters are a convenience */ }
  }
  load();

  // ---- Upstash (the website reads it) ----
  // One command per batch. HSETNX per field: a field that exists is never changed.
  const SET_ONCE = "for i=1,#ARGV,2 do redis.call('HSETNX',KEYS[1],ARGV[i],ARGV[i+1]) end return #ARGV/2";
  async function redis(command) {
    const res = await fetchFn(redisUrl, { method: 'POST', headers: { authorization: `Bearer ${redisToken}`, 'content-type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function pushRemote(pairs) { // pairs: [[field, json]]
    if (!live || !redisUrl || !redisToken || pairs.length === 0) return;
    try { await redis(['EVAL', SET_ONCE, '1', GUIDE_HASH, ...pairs.flat()]); } catch (e) {
      if (!warnedRedis) { warnedRedis = true; log(`GUIDE: could not save to Upstash (${String(e.message).split(redisToken).join('***').slice(0, 80)}); the site will not show guide calls until this works`); }
    }
  }

  // ---- saving calls ----
  /** Saves new calls: only those not saved before, and only before their round locks. Returns how many were saved. */
  function saveCalls(list) {
    const t = nowSec();
    const fresh = [];
    for (const rec of list) {
      const field = callField(rec.m, rec.r, rec.a);
      if (calls.has(field)) continue; // never changed afterwards
      if (t >= rec.lock - cfg.publishMargin) { log(`GUIDE: ${rec.a} ${rec.market} round ${rec.r}: the answer came too late (the round locks), so no call`); continue; }
      calls.set(field, rec);
      fresh.push(rec);
      append(file, rec);
    }
    void pushRemote(fresh.map((r) => [callField(r.m, r.r, r.a), JSON.stringify({ c: r.c, t: r.t, at: r.at, s: r.s, src: r.src, model: r.model, lock: r.lock })]));
    return fresh.length;
  }
  const record = (d, agent, extra) => ({ m: d.marketId, r: d.round, a: agent, market: d.market, coin: d.coin, frame: d.label, lock: d.lock, end: d.end, at: nowSec(), g: 1, ...extra });
  const skipRecord = (d, agent, why) => record(d, agent, { s: 'skipped', c: null, t: COULDNT_DECIDE, src: 'ai', model: null, why });
  /** A call that could not be made. A round that is still open at the next cycle is simply asked again then (one request per cycle, never a loop); one that locks before that gets its "Couldn't decide this round". */
  const giveUp = (list, agent, why) => saveCalls(list.filter((d) => d.lock - nowSec() < CYCLE_SECONDS + cfg.askAfter + cfg.minLeft).map((d) => skipRecord(d, agent, why)));

  // ---- counting Gemini requests ----
  function rollDay() {
    const d = new Date(now()).toISOString().slice(0, 10);
    if (state.day.date !== d) { state.day = { date: d, started: 0 }; saveState(); }
  }
  function rollHour() {
    const k = new Date(now()).toISOString().slice(0, 13);
    if (hour.key === k) return;
    if (hour.key) {
      const per = GUIDE_AI_AGENTS.map((a) => `${a} ${hour.byAgent[a] ?? 0}`).join(', ');
      log(`GUIDE Gemini requests: ${hour.started} in the last hour (${per}); ${state.day.started} so far today (UTC); expected about ${cfg.expectedPerDay} a day (3 agents x ${86400 / CYCLE_SECONDS} five-minute cycles, one request each)${state.day.started > cfg.dailyCap * 0.9 ? ' - NEAR THE DAILY CAP' : ''}`);
    }
    hour.key = k; hour.started = 0; hour.byAgent = {};
  }
  /** One request about to be sent (first try or a retry): counts it, and says no at either limit. */
  function allowRequest(agent) {
    rollDay();
    if (state.day.started >= cfg.dailyCap) return false;
    const t = now();
    while (recent.length && recent[0] < t - 60_000) recent.shift();
    if (recent.length >= cfg.perMinute) return false;
    recent.push(t);
    state.day.started++; hour.started++; hour.byAgent[agent] = (hour.byAgent[agent] ?? 0) + 1;
    saveState();
    return true;
  }

  // ---- Coin Flipper ----
  function flipperCalls(due) {
    for (const d of due) {
      if (calls.has(callField(d.marketId, d.round, 'coin-flipper')) || d.secondsToLock < cfg.flipMinLeft) continue;
      const flip = random();
      const side = flip >= 0.5 ? 'UP' : 'DOWN';
      const rec = record(d, 'coin-flipper', { s: 'called', c: side, t: `${d.market}: coin flip gave ${flip.toFixed(2)} (${flip >= 0.5 ? '0.50 or more' : 'under 0.50'}), so ${side}.`, src: 'random', model: null });
      if (!live) { const k = `flip:${rec.m}:${rec.r}`; if (!woulds.has(k)) { woulds.add(k); log(`WOULD save guide call: Coin Flipper ${d.market} round ${d.round}: ${side}`); } continue; }
      if (saveCalls([rec])) log(`GUIDE Coin Flipper ${d.market} round ${d.round}: ${side}`);
    }
  }

  // ---- the three AI agents ----
  async function candlesFor(cycle, coin) {
    const k = `${cycle}:${coin}`;
    if (!cycleCandles.has(k)) {
      for (const old of cycleCandles.keys()) if (!old.startsWith(`${cycle}:`)) cycleCandles.delete(old);
      cycleCandles.set(k, Promise.resolve().then(() => getCandles(coin)));
    }
    return cycleCandles.get(k);
  }

  async function runAgent(agent, entries, cycle) {
    const asked = [];
    const coins = [];
    const byCoin = new Map();
    for (const d of entries) byCoin.set(d.coin, [...(byCoin.get(d.coin) ?? []), d]);
    for (const [coin, group] of byCoin) {
      let candles = null;
      try { candles = await candlesFor(cycle, coin); } catch { /* no candles */ }
      if (!candles || candles.length < MIN_CANDLES) { giveUp(group, agent, 'no chart data'); log(`GUIDE ${agent} ${coin}: no chart data, so no call this round`); continue; }
      coins.push({ coin, candles, frames: group.map((d) => ({ label: d.label, roundSeconds: d.roundSeconds, secondsToLock: d.lock - nowSec() })) });
      asked.push(...group);
    }
    if (asked.length === 0) return;
    const keys = asked.map((d) => ({ coin: d.short, frame: d.label }));
    const { system, user } = buildGuidePrompt({ agent, coins });
    const deadline = Math.min(...asked.map((d) => d.lock)) * 1000 - 10_000; // an answer is useless once the first of these rounds locks
    const out = await askFn({
      apiKey, model, fallbackModel, system, user, deadline, retryOn429: false, maxAttempts: 2, beforeRetry: () => allowRequest(agent),
      timeoutMs: numOr(env.GEMINI_TIMEOUT_SECONDS, 16) * 1000, fallbackTimeoutMs: numOr(env.GEMINI_FALLBACK_TIMEOUT_SECONDS, 8) * 1000,
      schema: guideSchema(keys), parse: (text) => parseGuide(text, keys), maxOutputTokens: 300 + 90 * keys.length, sleep,
    });
    if (!out.ok) {
      if (out.error === 'HTTP 429') {
        pausedUntil = now() + cfg.quotaPauseMs;
        log(`GUIDE: Gemini says too many requests (a limit or quota). Not asking again until ${hhmm(pausedUntil)} UTC; ${agent} skips these calls`);
      }
      log(`GUIDE ${agent}: no answer (${out.error}, ${out.attempts} tries, ${out.latencyMs} ms), so these ${asked.length} calls are skipped`);
      giveUp(asked, agent, out.error);
      return;
    }
    let made = 0, missing = 0;
    const recs = asked.map((d) => {
      const v = out.value[`${d.short}:${d.label}`];
      if (!v) { missing++; return null; }
      return record(d, agent, { s: 'called', c: v.call, t: v.reason, src: 'ai', model: out.model });
    });
    giveUp(asked.filter((d, i) => !recs[i]), agent, 'missing from the answer');
    made = saveCalls(recs.filter(Boolean));
    const lines = recs.filter(Boolean).map((r) => `         ${r.market} round ${r.r}: ${r.c} "${r.t}"`);
    log(`GUIDE ${agent}: ${made} calls saved for ${asked.length} rounds (${out.model}, ${out.tokensIn} in / ${out.tokensOut} out tokens, ${out.latencyMs} ms${missing ? `, ${missing} missing` : ''})\n${lines.join('\n')}`);
  }

  function startAI(agent, entries, cycle) {
    state.asked[agent] = cycle; // one request per agent per cycle, even when it fails: nothing is asked again in a loop
    const labels = entries.map((d) => `${d.short} ${d.label}`).join(', ');
    if (!live) { log(`WOULD ask ${model} for ${agent}: ${entries.length} calls (${labels}), one request`); return; }
    saveState();
    if (!apiKey) {
      if (!warnedNoKey) { warnedNoKey = true; log('GUIDE: GEMINI_API_KEY is not set in .env, so the three AI agents make no guide calls ("Couldn\'t decide this round").'); }
      giveUp(entries, agent, 'no API key');
      return;
    }
    if (now() < pausedUntil) { giveUp(entries, agent, 'rate limited'); return; }
    if (!allowRequest(agent)) {
      log(`GUIDE: Gemini request limit reached (${cfg.dailyCap} a day or ${cfg.perMinute} a minute); ${agent} skips ${entries.length} calls`);
      giveUp(entries, agent, 'request limit');
      return;
    }
    busy.add(agent);
    runAgent(agent, entries, cycle)
      .catch((e) => log(`GUIDE ${agent}: unexpected error (${String(e.message).slice(0, 80)})`))
      .finally(() => busy.delete(agent));
  }

  // ---- scoring ----
  const chainPrices = { at: 0, map: new Map() };
  function chainPriceMap() {
    if (now() - chainPrices.at < 30_000) return chainPrices.map;
    chainPrices.at = now();
    const byId = new Map(markets.map((m) => [m.id, m]));
    const map = new Map();
    try {
      for (const e of chainPriceLog()) {
        const m = byId.get(e.marketId);
        if (!m || !['start', 'end'].includes(e.kind) || !(e.priceUsd > 0)) continue;
        const lock = lockTime(m, e.round);
        map.set(`${m.name.split(' ')[0]}:${e.kind === 'start' ? lock : lock + m.roundLength}:${e.kind}`, { usd: e.priceUsd, at: e.lastTradeAt ?? e.recordedAt, from: 'the runner\'s price log' });
      }
    } catch { /* no price log yet */ }
    chainPrices.map = map;
    return map;
  }

  const fetched = new Map();      // "coin:time:kind" -> { usd, at }
  const failedUntil = new Map();  // "coin:time:kind" -> ms
  let lastFetch = 0, attempts = 0;
  /** The Bitfinex trade for a round's start (first at or after lock + 2 s) or end (last at or before the end). null when not available yet. */
  async function priceAt(coin, time, kind) {
    const key = `${coin}:${time}:${kind}`;
    const onChain = chainPriceMap().get(key);
    if (onChain) return onChain;
    if (fetched.has(key)) return fetched.get(key);
    if ((failedUntil.get(key) ?? 0) > now()) return null;
    const gap = lastFetch + cfg.fetchGapMs - now();
    if (gap > 0) await sleep(gap);
    lastFetch = now(); attempts++;
    const query = kind === 'start' ? `limit=1&sort=1&start=${(time + 2) * 1000}` : `limit=1&sort=-1&end=${time * 1000}`;
    try {
      const res = await fetchFn(`https://api-pub.bitfinex.com/v2/trades/${SYMBOLS[coin]}/hist?${query}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const trade = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : null;
      const ms = trade?.[1], price = trade?.[3];
      if (typeof ms !== 'number' || !(price > 0)) throw new Error('no trade yet');
      const tradeAt = Math.floor(ms / 1000);
      if (kind === 'start' ? tradeAt < time + 2 : tradeAt > time) throw new Error('trade outside the asked time');
      const hit = { usd: price, at: tradeAt, from: 'Bitfinex trade history' };
      fetched.set(key, hit);
      append(priceFile, { v: 1, label: 'GUIDE CALLS - NO MONEY, NOTHING ON CHAIN', coin, kind, forTime: time, priceUsd: price, tradeAt, source: 'Bitfinex', recordedAt: nowSec() });
      return hit;
    } catch (e) {
      failedUntil.set(key, now() + cfg.retryFetchMs);
      log(`GUIDE: no ${coin} ${kind} price from Bitfinex for ${hhmm(time * 1000)} UTC yet (${String(e.message).slice(0, 60)}); trying again later`);
      return null;
    }
  }

  async function scoreOnce() {
    const t = nowSec();
    const rounds = new Map(); // "m:r" -> [records]
    for (const rec of calls.values()) {
      if (rec.s !== 'called') continue;
      const k = `${rec.m}:${rec.r}`;
      if (scored.has(k) || t < rec.end + cfg.scoreAfter || t > rec.end + cfg.scoreUntil) continue;
      if (!rounds.has(k)) rounds.set(k, []);
      rounds.get(k).push(rec);
    }
    attempts = 0;
    const done = [];
    for (const [k, recs] of [...rounds].sort((a, b) => a[1][0].end - b[1][0].end)) {
      const { coin, lock, end, m, r, market } = recs[0];
      const s = await priceAt(coin, lock, 'start');
      const e = s ? await priceAt(coin, end, 'end') : null;
      if (s && e) {
        // the end trade must not come before the start trade: otherwise the market did not trade during the round
        const outcome = e.at < s.at ? 'FLAT' : outcomeOf(s.usd, e.usd);
        const entry = { type: 'score', m, r, market, coin, lock, end, startPrice: s.usd, endPrice: e.usd, startAt: s.at, endAt: e.at, res: outcome, at: t };
        scored.add(k); resultsOf.set(k, entry);
        append(file, entry);
        done.push([resField(m, r), JSON.stringify({ start: s.usd, end: e.usd, res: outcome, at: t })]);
        const per = recs.map((c) => `${c.a} ${c.c} ${resultOf(c.c, outcome)}`).join(', ');
        log(`GUIDE scored ${market} round ${r}: start ${usd(s.usd)} (${s.from}), end ${usd(e.usd)} (${e.from}) -> ${outcome === 'FLAT' ? 'no change, no result' : outcome + ' won'}; ${per}`);
      }
      if (attempts >= cfg.maxFetchesPerPass) break;
    }
    await pushRemote(done);
  }

  async function prune() {
    if (!live || !redisUrl || !redisToken || now() - lastPrune < 3_600_000) return;
    lastPrune = now();
    const old = nowSec() - cfg.keepSeconds;
    const fields = [];
    for (const [f, rec] of calls) if (rec.end < old) { fields.push(f); calls.delete(f); }
    for (const [k, e] of resultsOf) if (e.end < old) { fields.push(`${k}:res`); resultsOf.delete(k); scored.delete(k); }
    for (let i = 0; i < fields.length; i += 500) { try { await redis(['HDEL', GUIDE_HASH, ...fields.slice(i, i + 500)]); } catch { /* next hour */ } }
  }

  return {
    calls, scored,
    /** Called once per runner pass with the chain snapshot. Starts what is due in the background and returns at once. */
    tick(snap) {
      markets = snap.markets;
      rollDay(); rollHour();
      const t = nowSec();
      const due = dueRounds(markets, t, cfg.flipMinLeft);
      flipperCalls(due);
      const cycle = Math.floor(t / CYCLE_SECONDS);
      if (t >= cycle * CYCLE_SECONDS + cfg.askAfter) {
        const aiDue = due.filter((d) => d.secondsToLock >= cfg.minLeft);
        for (const agent of GUIDE_AI_AGENTS) {
          if (state.asked[agent] === cycle || busy.has(agent)) continue;
          const entries = aiDue.filter((d) => !calls.has(callField(d.marketId, d.round, agent)));
          if (entries.length) startAI(agent, entries, cycle);
        }
      }
      if (live && !scoring) {
        scoring = true;
        scoreOnce().catch((e) => log(`GUIDE: scoring problem (${String(e.message).slice(0, 80)})`)).then(prune).finally(() => { scoring = false; });
      }
    },
    /** Seconds until the AI agents are due next (the start of the next 5-minute cycle plus askAfter), so the runner looks then and not up to 10 s later. */
    nextWake() {
      const t = now() / 1000;
      const thisAsk = Math.floor(t / CYCLE_SECONDS) * CYCLE_SECONDS + cfg.askAfter;
      return Math.max(1, Math.ceil((t >= thisAsk ? thisAsk + CYCLE_SECONDS : thisAsk) - t));
    },
    /** For the log: today's request count. */
    summary() { rollDay(); return `GUIDE today: ${state.day.started} Gemini requests (expected about ${cfg.expectedPerDay} a day)`; },
  };
}
