// Matchup round runner (Arc TESTNET only).
//
//   node runner/run.mjs --once          Look at the chain once, print what it WOULD do, send nothing.
//   node runner/run.mjs                 Same, but keeps going every few seconds (still sends nothing).
//   node runner/run.mjs --live          LIVE: really sends transactions (test prices, calls, settles, claims).
//   node runner/run.mjs --live --once   One live pass, then stop.
//
// Each pass: read the chain -> ask planTick() what to do -> do it, one action at a time.
// The agents' wallets are Circle developer-controlled wallets; the runner's own wallet pushes prices and settles (on the testnet the deployer wallet, which owns the test feeds).
import { setup } from '../scripts/lib.mjs';
import { displayName } from '../agents/index.mjs';
import { CFG } from './config.mjs';
import { planTick, tickDelay, LATE } from './plan.mjs';
import { loadDeployments, makeReader } from './chain.mjs';
import { makeExecutor, describe } from './wallets.mjs';
import { createCandles } from './candles.mjs';
import { createAi } from './ai.mjs';
import { createNotes } from './notes.mjs';
import { COULDNT_DECIDE } from '../agents/ai.mjs';

const LIVE = process.argv.includes('--live');
const ONCE = process.argv.includes('--once');

// The runner signs with its own key (RUNNER_PRIVATE_KEY). On the testnet it falls back to the deployer wallet, which owns the rehearsal feeds.
const { env, pub, wallet, usdc, chain } = setup('testnet', { role: 'runner' });
if (chain.id !== 5042002) throw new Error('Arc testnet only.');
if (LIVE && !String(env.CIRCLE_API_KEY || '').startsWith('TEST_API_KEY:')) throw new Error('Live mode needs a TEST_API_KEY (testnet) Circle key.');

let deployments;
try { deployments = loadDeployments(); } catch (e) { console.error('STOP: ' + e.message); process.exit(1); }
const readSnapshot = makeReader({ pub, usdc, deployments });
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`${stamp()}  ${msg}`);

console.log(LIVE ? '*** LIVE MODE: real testnet transactions will be sent ***' : '--- DRY RUN: nothing will be sent ---');

// Which markets the house agents play (AI_MARKETS in .env, comma separated names like "BTC/USD 5m", or "all"). Default: BTC, ETH and SOL 5m.
const aiMarketsText = String(env.AI_MARKETS || 'BTC/USD 5m,ETH/USD 5m,SOL/USD 5m').trim();
const aiMarkets = aiMarketsText.toLowerCase() === 'all' ? 'all' : aiMarketsText.split(',').map((s) => s.trim()).filter(Boolean);
const ai = createAi({ env, live: LIVE, log });         // Gemini decides the trend follower, the contrarian and the chart reader
const notes = createNotes({ env, log });                // their one-sentence reasons, for the website
const candleSource = createCandles();

/** Fresh candles for an AI call: the call is made seconds after a minute turns, so make sure the minute that just closed is in. */
async function freshCandles(req) {
  const wantLast = Math.floor(Date.now() / 60_000) * 60 - 60; // start of the newest finished minute
  let candles = req.candles;
  for (let i = 0; i < 3 && (candles[candles.length - 1]?.time ?? 0) < wantLast; i++) {
    try { candles = await candleSource.get(req.coin, { force: true }); } catch { break; }
    if ((candles[candles.length - 1]?.time ?? 0) < wantLast) await new Promise((r) => setTimeout(r, 1500));
  }
  return candles;
}
let candleData = null;       // closed 1-minute candles per coin, for the chart reader
let candleRefresh = null;
const decided = new Set();   // decisions already taken (a skip counts), so no agent decides twice per round
const loggedSkips = new Set(); // retryable skips already written to the log (once per round)
const failedUntil = new Map(); // action text -> time before which we do not retry it
let execute;
let agentLane = Promise.resolve(); // the background lane for agent transactions
const inflight = new Set();   // action texts being executed right now

async function tick() {
  const snap = await readSnapshot();
  execute ||= makeExecutor({ live: LIVE, env, deployments, pub, wallet, usdc, arenaAbi: snap.art.arena.abi, feedAbi: snap.art.feed.abi, relayAbi: snap.art.relay?.abi, explorer: chain.blockExplorers.default.url, chainId: chain.id });
  // Candles: waited for once (a missing chart would make the chart reader skip its round), then refreshed in the background so a price push is never held up.
  const pairs = snap.markets.map((m) => m.name.split(' ')[0]);
  if (!candleRefresh) candleRefresh = candleSource.getAll(pairs).then((c) => { candleData = c; }).finally(() => { candleRefresh = null; });
  if (candleData === null) await candleRefresh;
  snap.candles = candleData ?? {};
  const planCfg = { ...CFG, random: Math.random, ai, aiMarkets };
  const { actions, decisions, aiRequests } = planTick(snap, planCfg, decided);
  for (const r of aiRequests) ai.request(r, { prepare: freshCandles }); // answered in the background; the next look turns the answer into calls or skips
  const delay = aiRequests.length ? Math.min(CFG.fastTickSeconds, tickDelay(snap, planCfg)) : tickDelay(snap, planCfg);

  for (const d of decisions) {
    if (d.decision.action === 'SKIP' && !(d.retry && loggedSkips.has(d.id))) {
      log(`${displayName(d.agent)} skips ${d.market} round ${d.round}: ${d.decision.reason}`);
      if (d.retry) loggedSkips.add(d.id);
    }
    if (LIVE && d.decision.aiFailed && !decided.has(d.id)) {
      notes.publish({ m: d.marketId, r: d.round, a: d.agent, s: 'skipped', c: null, t: COULDNT_DECIDE, at: Math.floor(Date.now() / 1000), model: ai.model });
    }
    if (d.retry) continue; // the contrarian's skip is not final: it looks again next tick, until its cutoff
    if (LIVE || d.decision.action === 'SKIP') decided.add(d.id); // a dry run never marks a call as decided, so it keeps showing it
  }
  if (actions.length === 0 && decisions.length === 0) return delay;

  // Two lanes, so a slow agent call (Circle takes several seconds per transaction) never makes a price push or a settle late:
  //   fast lane: price pushes and settles (the deployer wallet), waited for before the next look at the chain
  //   agent lane: approvals, calls and claims (Circle wallets), one after another in the background
  const fast = actions.filter((a) => a.type === 'pushPrice' || a.type === 'settle');
  const slow = actions.filter((a) => a.type !== 'pushPrice' && a.type !== 'settle');
  if (slow.length) agentLane = agentLane.then(() => runLane(slow));
  await runLane(fast);
  return delay;
}

/** Runs actions one after another. An action already running, or one that failed a moment ago, is skipped. */
async function runLane(list) {
  for (const a of list) {
    const text = describe(a);
    if ((failedUntil.get(text) || 0) > Date.now() || inflight.has(text)) continue;
    inflight.add(text);
    try {
      const res = await execute(a);
      log(`${LIVE ? 'DONE' : 'WOULD'}: ${text}${res.note ? '\n         ' + res.note : ''}${res.tx ? '\n         tx ' + res.tx : ''}`);
      if (LIVE && a.type === 'call' && a.ai) notes.publish({ m: a.market, r: a.round, a: a.agent, s: 'called', c: a.side, t: a.reason, at: Math.floor(Date.now() / 1000), model: ai.model, src: a.rule ? 'rule' : 'ai' });
    } catch (e) {
      // do not hammer a failing action; a failed price push is retried after 5 s (the start price waits for the first trade after the lock)
      // a failed contrarian approval or call is tried again soon (its window is short) and its decision is taken back after that
      const late = a.agent === LATE && (a.type === 'call' || a.type === 'approve');
      failedUntil.set(text, Date.now() + (a.type === 'pushPrice' ? 5_000 : late ? 15_000 : 5 * 60_000));
      if (late && a.type === 'call') setTimeout(() => decided.delete(`${a.market}:${a.round}:${a.agent}`), 15_000); // then it is planned again (if its window is still open)
      const why = String(e.shortMessage || e.message).slice(0, 300);
      // the start price waits for the first trade after the lock: that is waiting, not a failure
      log(`${/will try again/.test(why) ? 'WAITING' : 'FAILED'}: ${text}\n         ${why}`);
    } finally {
      inflight.delete(text);
    }
  }
}

do {
  let delay = CFG.tickSeconds;
  const began = Date.now();
  try { delay = await tick(); const took = (Date.now() - began) / 1000; if (took > 4) log(`slow pass: ${took.toFixed(1)} s (reading the chain and sending prices and settles)`); } catch (e) { log(`tick error: ${String(e.shortMessage || e.message).slice(0, 300)}`); }
  if (!ONCE) await new Promise((r) => setTimeout(r, delay * 1000));
} while (!ONCE);
await agentLane; // --once: wait for the agent transactions that were started
