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
import { planTick } from './plan.mjs';
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

async function tick() {
  const snap = await readSnapshot();
  execute ||= makeExecutor({ live: LIVE, env, deployments, pub, wallet, usdc, arenaAbi: snap.art.arena.abi, feedAbi: snap.art.feed.abi, explorer: chain.blockExplorers.default.url, chainId: chain.id });
  const { actions, decisions } = planTick(snap, { ...CFG, random: Math.random }, decided);

  for (const d of decisions) {
    if (d.decision.action === 'SKIP') log(`${displayName(d.agent)} skips ${d.market} round ${d.round}: ${d.decision.reason}`);
    if (LIVE || d.decision.action === 'SKIP') decided.add(d.id); // a dry run never marks a bet as decided, so it keeps showing it
  }
  if (actions.length === 0 && decisions.length === 0) return;

  for (const a of actions) {
    const text = describe(a);
    if ((failedUntil.get(text) || 0) > Date.now()) continue;
    try {
      const res = await execute(a);
      log(`${LIVE ? 'DONE' : 'WOULD'}: ${text}${res.note ? '\n         ' + res.note : ''}${res.tx ? '\n         tx ' + res.tx : ''}`);
    } catch (e) {
      // do not hammer a failing action; a failed price push is retried sooner (the start price waits for a fresh quote)
      failedUntil.set(text, Date.now() + (a.type === 'pushPrice' ? 20_000 : 5 * 60_000));
      log(`FAILED: ${text}\n         ${String(e.shortMessage || e.message).slice(0, 300)}`);
    }
  }
}

do {
  try { await tick(); } catch (e) { log(`tick error: ${String(e.shortMessage || e.message).slice(0, 300)}`); }
  if (!ONCE) await new Promise((r) => setTimeout(r, CFG.tickSeconds * 1000));
} while (!ONCE);
