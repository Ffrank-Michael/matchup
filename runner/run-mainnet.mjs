// Matchup round runner for Arc MAINNET (chain 5042, real USDC for gas).
//
//   node runner/run-mainnet.mjs --once                                      Look at the chain once, print what it WOULD do, send nothing.
//   node runner/run-mainnet.mjs                                             Same, but keeps going every few seconds (still sends nothing).
//   node runner/run-mainnet.mjs --i-understand-this-spends-real-usdc        LIVE: really sends transactions (price pushes and settles).
//   node runner/run-mainnet.mjs --i-understand-this-spends-real-usdc --once One live pass, then stop.
//
// It works like runner/run.mjs, with these differences:
//   - it reads MAINNET_ARENA_ADDRESS and MAINNET_RUNNER_PRIVATE_KEY from .env (nothing else: see RUNNER_ENV_NAMES in mainnet.mjs)
//   - it only pushes prices and settles: the mainnet house agents have no wallets, so no agent call moves money
//   - the four agents make GUIDE CALLS on every open round whether or not anyone plays (runner/guide.mjs): no money, nothing on chain.
//     Live (with the flag) it asks Gemini (one request per AI agent every 5 minutes), saves the calls where the site reads them and scores
//     them when rounds end. Without the flag it only logs what it WOULD ask.
//   - a round with no calls gets no price push and no settle; a round with calls on one side only gets no price push but is settled right after it ends (the contract refunds it at once, so its callers can claim); a round with calls on both sides gets both
//   - every price is checked against Chainlink off chain before it is sent (the relay checks it again on chain)
// Without the flag the wallet client is never even created, so a dry run cannot send anything.
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ROOT, NETWORKS, arcChain } from '../scripts/lib.mjs';
import { CFG } from './config.mjs';
import { planTick, tickDelay } from './plan.mjs';
import { makeReader } from './chain.mjs';
import { createCandles } from './candles.mjs';
import { createGuide, freshCandles } from './guide.mjs';
import { SEND_FLAG, MIN_RUNNER_BALANCE, readRunnerEnv, parseArgs, parseRunnerConfig, makeMainnetExecutor, describe, chainProblem, preflight } from './mainnet.mjs';

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`${stamp()}  ${msg}`);
const stop = (msg) => { console.error('STOP: ' + msg); process.exit(1); };

const { live: LIVE, once: ONCE, error: argError } = parseArgs(process.argv.slice(2));
if (argError) stop(argError);

const envFile = path.join(ROOT, '.env');
if (!fs.existsSync(envFile)) stop('No .env file. Copy .env.example to .env first.');
const runnerEnv = readRunnerEnv(fs.readFileSync(envFile, 'utf8')); // only the names the runner may hold (mainnet.mjs)
const cfg = parseRunnerConfig(runnerEnv);
if (cfg.problems.length) stop(cfg.problems.join('\n      '));

const net = NETWORKS.mainnet;
const rpc = cfg.rpc || net.rpc;
const chain = arcChain(net, rpc);
const account = privateKeyToAccount(cfg.key);
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = LIVE ? createWalletClient({ account, chain, transport: http(rpc) }) : null; // no wallet client without the flag: a dry run cannot send

console.log(LIVE ? '*** LIVE MODE on Arc MAINNET: real transactions will be sent and they cost real USDC ***' : `--- DRY RUN on Arc mainnet: nothing will be sent (add ${SEND_FLAG} to send) ---`);
log(`runner wallet ${account.address}, arena ${cfg.arena}`);

const wrongChain = await chainProblem(pub).catch((e) => `cannot reach the RPC: ${String(e.shortMessage || e.message).slice(0, 200)}`);
if (wrongChain) stop(wrongChain);
const readSnapshot = makeReader({ pub, usdc: cfg.usdc, deployments: { arena: { arena: { address: cfg.arena } }, circle: { agents: [] } } });
const planCfg = { ...CFG, random: Math.random, matchedOnly: true, runnerOnly: true };

const candleSource = createCandles();
const guide = createGuide({ env: runnerEnv, live: LIVE, log, getCandles: (coin) => freshCandles(candleSource, coin) });
let execute;
let checked = false;
const failedUntil = new Map(); // action text -> time before which we do not retry it
const inflight = new Set();    // action texts being executed right now

async function tick() {
  const snap = await readSnapshot();
  const { art } = snap; // the contracts' ABIs, compiled once by the reader
  execute ||= makeMainnetExecutor({ live: LIVE, pub, wallet, arena: cfg.arena, arenaAbi: art.arena.abi, relayAbi: art.relay.abi, guardAbi: art.feed.abi, explorer: chain.blockExplorers.default.url, chainId: chain.id });
  if (!checked) { // once, with the first look at the markets: is this the right chain, arena and pusher?
    const feeds = [...new Set(snap.markets.map((m) => m.feed.address))];
    const problems = await preflight({ pub, arena: cfg.arena, arenaAbi: art.arena.abi, relayAbi: art.relay.abi, runner: account.address, feeds });
    if (problems.length) stop(problems.join('\n      '));
    checked = true;
    log(`checked: Arc mainnet, ${snap.markets.length} markets, ${feeds.length} relay feeds, the runner is the pusher of each`);
  }
  try { guide.tick(snap); } catch (e) { log(`GUIDE problem (the guide calls never stop the runner): ${String(e.message).slice(0, 120)}`); } // starts its work in the background and returns at once
  const balance = await pub.getBalance({ address: account.address });
  if (balance < MIN_RUNNER_BALANCE) {
    const msg = `the runner wallet holds ${formatUnits(balance, 18)} USDC, below the ${formatUnits(MIN_RUNNER_BALANCE, 18)} it needs for gas`;
    if (LIVE) { const e = new Error(msg + '; stopping until it is topped up'); e.fatal = true; throw e; }
    log(`WARNING: ${msg}`);
  }
  snap.agents = [];
  const { actions } = planTick(snap, planCfg);
  for (const a of actions) {
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
      log(`${/will try again/.test(why) ? 'WAITING' : LIVE ? 'FAILED' : 'WOULD FAIL'}: ${text}\n         ${why}`);
    } finally {
      inflight.delete(text);
    }
  }
  return Math.min(tickDelay(snap, planCfg), guide.nextWake());
}

do {
  let delay = CFG.tickSeconds;
  const began = Date.now();
  try { delay = await tick(); const took = (Date.now() - began) / 1000; if (took > 4) log(`slow pass: ${took.toFixed(1)} s (reading the chain and sending prices and settles)`); } catch (e) {
    log(`${e.fatal ? 'STOPPING' : 'tick error'}: ${String(e.shortMessage || e.message).slice(0, 300)}`);
    if (e.fatal) process.exit(1);
  }
  if (!ONCE) await new Promise((r) => setTimeout(r, delay * 1000));
} while (!ONCE);
