// Kairo Markets round runner (Arc TESTNET only).
//
//   node runner/run.mjs --once          Look at the chain once, print what it WOULD do, send nothing.
//   node runner/run.mjs                 Same, but keeps going every few seconds (still sends nothing).
//   node runner/run.mjs --live          LIVE: really sends transactions (test prices, bets, settles, claims).
//   node runner/run.mjs --live --once   One live pass, then stop.
//
// Each pass: read the chain -> ask planTick() what to do -> do it, one action at a time.
// The agents' wallets are Circle developer-controlled wallets; the deployer wallet owns the test feeds.
import { setup } from '../scripts/lib.mjs';
import { displayName } from '../agents/index.mjs';
import { CFG } from './config.mjs';
import { planTick, tickDelay } from './plan.mjs';
import { loadDeployments, makeReader } from './chain.mjs';
import { makeExecutor, describe } from './wallets.mjs';

const LIVE = process.argv.includes('--live');
const ONCE = process.argv.includes('--once');

const { env, pub, wallet, usdc, chain } = setup();
if (chain.id !== 5042002) throw new Error('Arc testnet only.');
if (LIVE && !String(env.CIRCLE_API_KEY || '').startsWith('TEST_API_KEY:')) throw new Error('Live mode needs a TEST_API_KEY (testnet) Circle key.');

let deployments;
try { deployments = loadDeployments(); } catch (e) { console.error('STOP: ' + e.message); process.exit(1); }
const readSnapshot = makeReader({ pub, usdc, deployments });
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`${stamp()}  ${msg}`);

console.log(LIVE ? '*** LIVE MODE: real testnet transactions will be sent ***' : '--- DRY RUN: nothing will be sent ---');

const decided = new Set();   // decisions already taken (a skip counts), so no agent decides twice per round
const failedUntil = new Map(); // action text -> time before which we do not retry it
let execute;
let agentLane = Promise.resolve(); // the background lane for agent transactions
const inflight = new Set();   // action texts being executed right now

async function tick() {
  const snap = await readSnapshot();
  execute ||= makeExecutor({ live: LIVE, env, deployments, pub, wallet, usdc, arenaAbi: snap.art.arena.abi, feedAbi: snap.art.feed.abi, relayAbi: snap.art.relay?.abi, explorer: chain.blockExplorers.default.url, chainId: chain.id });
  const { actions, decisions } = planTick(snap, { ...CFG, random: Math.random }, decided);
  const delay = tickDelay(snap, CFG);

  for (const d of decisions) {
    if (d.decision.action === 'SKIP') log(`${displayName(d.agent)} skips ${d.market} round ${d.round}: ${d.decision.reason}`);
    if (LIVE || d.decision.action === 'SKIP') decided.add(d.id); // a dry run never marks a bet as decided, so it keeps showing it
  }
  if (actions.length === 0 && decisions.length === 0) return delay;

  // Two lanes, so a slow agent bet (Circle takes several seconds per transaction) never makes a price push or a settle late:
  //   fast lane: price pushes and settles (the deployer wallet), waited for before the next look at the chain
  //   agent lane: approvals, bets and claims (Circle wallets), one after another in the background
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
    } catch (e) {
      // do not hammer a failing action; a failed price push is retried after 5 s (the start price waits for the first trade after the lock)
      failedUntil.set(text, Date.now() + (a.type === 'pushPrice' ? 5_000 : 5 * 60_000));
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
