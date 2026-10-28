// node --test runner/mainnet.test.mjs
// The mainnet runner moves real USDC, so these tests pin down every "may this send?" rule. No chain, no keys, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CFG } from './config.mjs';
import { planTick, tickDelay } from './plan.mjs';
import { runnerSpec } from './supervise.mjs';
import { ROOT } from '../scripts/lib.mjs';
import {
  SEND_FLAG, MAINNET_CHAIN_ID, RUNNER_ENV_NAMES, readRunnerEnv, parseArgs, parseRunnerConfig, checkAgainstGuard,
  makeMainnetExecutor, describe, chainProblem, preflight,
} from './mainnet.mjs';

const KEY = '0x' + 'ab'.repeat(32);
const DEPLOYER_KEY = '0x' + 'cd'.repeat(32);
const ARENA = '0x' + '11'.repeat(20);
const RUNNER = '0x' + '22'.repeat(20);
const OWNER = '0x' + '33'.repeat(20);
const FEED = '0x' + '44'.repeat(20);
const GUARD = '0x' + '55'.repeat(20);

// ---------------------------------------------------------------- what the runner reads from .env

test('env: only the runner\'s own settings are taken from .env; the deployer key is never held', () => {
  const text = [
    `MAINNET_RUNNER_PRIVATE_KEY=${KEY}`, `MAINNET_ARENA_ADDRESS=${ARENA}`,
    `MAINNET_DEPLOYER_PRIVATE_KEY=${DEPLOYER_KEY}`, `DEPLOYER_PRIVATE_KEY=${DEPLOYER_KEY}`, `RUNNER_PRIVATE_KEY=${DEPLOYER_KEY}`,
    'CIRCLE_API_KEY=x', 'GEMINI_API_KEY=y',
  ].join('\n');
  const env = readRunnerEnv(text);
  assert.deepEqual(Object.keys(env).sort(), ['MAINNET_ARENA_ADDRESS', 'MAINNET_RUNNER_PRIVATE_KEY']);
  assert.ok(!JSON.stringify(env).includes(DEPLOYER_KEY));
  assert.ok(Object.keys(env).every((k) => RUNNER_ENV_NAMES.includes(k)));
});

test('env: the old RUNNER_PRIVATE_KEY name does not count; only MAINNET_RUNNER_PRIVATE_KEY does', () => {
  const cfg = parseRunnerConfig(readRunnerEnv(`RUNNER_PRIVATE_KEY=${KEY}\nMAINNET_ARENA_ADDRESS=${ARENA}`));
  assert.match(cfg.problems.join(' '), /MAINNET_RUNNER_PRIVATE_KEY is missing/);
});

test('config: a good key and arena address give no problems; the address is normalised', () => {
  const cfg = parseRunnerConfig({ MAINNET_RUNNER_PRIVATE_KEY: KEY, MAINNET_ARENA_ADDRESS: ARENA.toUpperCase().replace('0X', '0x') });
  assert.deepEqual(cfg.problems, []);
  assert.equal(cfg.key, KEY);
  assert.match(cfg.arena, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(cfg.rpc, '');
});

test('config: every missing or malformed setting is named, and no message contains the key', () => {
  const bad = parseRunnerConfig({ MAINNET_RUNNER_PRIVATE_KEY: '0x1234secretsecret', MAINNET_ARENA_ADDRESS: '0xnope' });
  assert.equal(bad.problems.length, 2);
  assert.ok(!bad.problems.join(' ').includes('secretsecret'));
  assert.equal(bad.arena, null);
  assert.equal(parseRunnerConfig({}).problems.length, 2);
});

// ---------------------------------------------------------------- the flag

test('flag: without --i-understand-this-spends-real-usdc it is a dry run', () => {
  assert.equal(parseArgs([]).live, false);
  assert.equal(parseArgs(['--once']).live, false);
  assert.equal(parseArgs([SEND_FLAG]).live, true);
  assert.equal(parseArgs([SEND_FLAG, '--once']).once, true);
});

test('flag: the testnet runner\'s --live is refused, whatever else is given', () => {
  assert.match(parseArgs(['--live']).error, /testnet runner/);
  assert.equal(parseArgs(['--live', SEND_FLAG]).live, false);
  assert.match(parseArgs(['--live', SEND_FLAG]).error, /--live/);
});

// ---------------------------------------------------------------- the Chainlink check (same maths as GuardedRelayFeed.setPrice)

const NOW = 1_800_000_000;
const guardCase = (over = {}) => checkAgainstGuard({ price: 10_000_00000000n, guardAnswer: 10_000_00000000n, guardUpdatedAt: NOW - 60, bandBps: 100, maxAgeSeconds: 26 * 3600, now: NOW, ...over });

test('chainlink check: a price inside the band passes', () => {
  assert.equal(guardCase().ok, true);
  assert.equal(guardCase({ price: 10_050_00000000n }).ok, true); // 0.5% with a 1% band
});

test('chainlink check: exactly on the band edge passes, one unit more fails (the relay uses <=)', () => {
  assert.equal(guardCase({ price: 10_100_00000000n }).ok, true);
  assert.equal(guardCase({ price: 10_100_00000001n }).ok, false);
  assert.equal(guardCase({ price: 9_900_00000000n }).ok, true);
  assert.equal(guardCase({ price: 9_899_99999999n }).ok, false);
  assert.match(guardCase({ price: 11_000_00000000n }).reason, /10% away from Chainlink; the relay accepts at most 1%/);
});

test('chainlink check: a stale, future, empty or absurd Chainlink answer blocks the push', () => {
  assert.equal(guardCase({ guardUpdatedAt: NOW - 26 * 3600 }).ok, true);
  assert.equal(guardCase({ guardUpdatedAt: NOW - 26 * 3600 - 1 }).ok, false);
  assert.equal(guardCase({ guardUpdatedAt: NOW + 1 }).ok, false);
  assert.equal(guardCase({ guardUpdatedAt: 0 }).ok, false);
  assert.equal(guardCase({ guardAnswer: 0n }).ok, false);
  assert.equal(guardCase({ guardAnswer: -5n }).ok, false);
  assert.equal(guardCase({ guardAnswer: 1n << 128n }).ok, false);
  assert.equal(guardCase({ price: 0n }).ok, false);
});

// ---------------------------------------------------------------- the executor

function fakeChain({ bitfinex = 10_010_00000000n, guard = 10_000_00000000n, guardAt = NOW - 30 } = {}) {
  const sent = [];
  const logged = [];
  const pub = {
    readContract: async ({ address, functionName }) => {
      if (functionName === 'guard') return GUARD;
      if (functionName === 'bandBps') return 100;
      if (functionName === 'MAX_GUARD_AGE') return BigInt(26 * 3600);
      if (functionName === 'latestRoundData' && address === GUARD) return [1n, guard, 0n, BigInt(guardAt), 1n];
      throw new Error('unexpected read ' + functionName);
    },
    waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 7n }),
    getBlock: async () => ({ timestamp: BigInt(NOW) }),
  };
  const wallet = { writeContract: async (req) => { sent.push(req); return '0x' + 'ee'.repeat(32); } };
  const prices = { quote: async () => ({ price: bitfinex, usd: Number(bitfinex) / 1e8, quotedAt: NOW, tradeAt: NOW - 2, source: 'Bitfinex' }) };
  const make = (live, w = wallet) => makeMainnetExecutor({ live, pub, wallet: w, arena: ARENA, arenaAbi: [], relayAbi: [], guardAbi: [], prices, explorer: 'https://explorer.arc.io', chainId: 5042, logPush: (e) => logged.push(e), nowSec: () => NOW });
  return { sent, logged, make };
}
const push = { type: 'pushPrice', market: 0, marketName: 'BTC/USD 5m', round: 4, feed: FEED, why: 'end price', endsAt: NOW + 50 };
const settle = { type: 'settle', market: 0, marketName: 'BTC/USD 5m', round: 3, startId: 5n, endId: 9n };

test('executor: a dry run never sends, and works with no wallet at all', async () => {
  const c = fakeChain();
  const execute = c.make(false, null);
  const p = await execute(push);
  assert.equal(p.dryRun, true);
  assert.match(p.note, /^would push Bitfinex last trade at .*\$10,010\.00, Chainlink \$10,000\.00, 0\.10% apart \(limit 1%\)/);
  assert.equal((await execute(settle)).dryRun, true);
  assert.equal(c.sent.length, 0);
  assert.equal(c.logged.length, 0);
});

test('executor: a dry run does not send even when a wallet is available', async () => {
  const c = fakeChain();
  const execute = c.make(false);
  await execute(push);
  await execute(settle);
  assert.equal(c.sent.length, 0);
});

test('executor: live mode without a wallet is refused at setup', () => {
  assert.throws(() => fakeChain().make(true, null), /needs a wallet/);
});

test('executor: live mode sends the price to the relay feed and the settle to the arena, and logs the push', async () => {
  const c = fakeChain();
  const execute = c.make(true);
  const p = await execute(push);
  assert.equal(c.sent[0].address, FEED);
  assert.equal(c.sent[0].functionName, 'setPrice');
  assert.deepEqual(c.sent[0].args, [10_010_00000000n]);
  assert.match(p.note, /end price landed 50 s before the round ends/);
  assert.equal(c.logged.length, 1);
  assert.equal(c.logged[0].chainId, 5042);
  assert.equal(c.logged[0].round, 4);
  assert.ok(!/TEST PRICES/.test(c.logged[0].label));
  const s = await execute(settle);
  assert.equal(c.sent[1].address, ARENA);
  assert.equal(c.sent[1].functionName, 'settle');
  assert.deepEqual(c.sent[1].args, [0n, 3n, 5n, 9n]);
  assert.ok(s.tx);
});

test('executor: a price outside the Chainlink band is not sent (live) and is reported (dry run)', async () => {
  const c = fakeChain({ bitfinex: 10_300_00000000n });
  await assert.rejects(c.make(true)(push), /price not sent: .*3% away from Chainlink/);
  await assert.rejects(c.make(false)(push), /price not sent/);
  assert.equal(c.sent.length, 0);
});

test('executor: a stale Chainlink answer blocks the price too', async () => {
  const c = fakeChain({ guardAt: NOW - 27 * 3600 });
  await assert.rejects(c.make(true)(push), /too old/);
  assert.equal(c.sent.length, 0);
});

test('executor: only price pushes and settles exist (no bets, approvals or claims on mainnet)', async () => {
  const execute = fakeChain().make(true);
  for (const type of ['bet', 'approve', 'claim']) await assert.rejects(execute({ type }), /unknown action/);
});

test('describe: plain words for both actions', () => {
  assert.match(describe(push), /runner pushes the BTC\/USD end price/);
  assert.match(describe(settle), /runner settles BTC\/USD 5m round 3 \(start id 5, end id 9\)/);
});

// ---------------------------------------------------------------- preflight

const pubFor = ({ chainId = MAINNET_CHAIN_ID, code = '0x60', owner = OWNER, pusher = RUNNER } = {}) => ({
  getChainId: async () => chainId,
  getCode: async () => code,
  readContract: async ({ functionName }) => {
    if (functionName === 'owner') return owner;
    if (functionName === 'pusher') { if (pusher === null) throw new Error('no such function'); return pusher; }
    throw new Error('unexpected ' + functionName);
  },
});
const pre = (pub) => preflight({ pub, arena: ARENA, arenaAbi: [], relayAbi: [], runner: RUNNER, feeds: [FEED] });

test('preflight: the right chain, an arena, a separate runner that is the pusher: no problems', async () => {
  assert.deepEqual(await pre(pubFor()), []);
  assert.equal(await chainProblem(pubFor()), null);
});

test('preflight: the testnet RPC, a missing contract, the owner as runner, a wrong pusher and a non-relay feed are all caught', async () => {
  assert.match(await chainProblem(pubFor({ chainId: 5042002 })), /5042002, not Arc mainnet/);
  assert.match((await pre(pubFor({ chainId: 5042002 })))[0], /not Arc mainnet/);
  assert.match((await pre(pubFor({ code: '0x' })))[0], /no contract at MAINNET_ARENA_ADDRESS/);
  assert.match((await pre(pubFor({ owner: RUNNER })))[0], /also the arena owner/);
  assert.match((await pre(pubFor({ pusher: OWNER })))[0], /not the pusher of feed/);
  assert.match((await pre(pubFor({ pusher: null })))[0], /not a Kairo relay/);
});

// ---------------------------------------------------------------- no gas on rounds without two sides (planTick with matchedOnly)

const ROUND = 300;
const id = (n) => (1n << 64n) | BigInt(n);
const upd = (n, updatedAt, usd) => ({ id: id(n), updatedAt, price: BigInt(Math.round(usd * 1e8)) });
// BTC-like 5-minute market, offset 0, feed address given so markets of one coin can share it. Round k locks at 300k and ends at 300(k+1).
const mk = (idn, nextRound, rounds, over = {}) => ({ id: idn, name: 'BTC/USD 5m', roundLength: ROUND, startOffset: 0, minStake: 500_000, paused: false, nextRound, feed: { address: FEED, updates: [] }, rounds, ...over });
const R = (up, down, state = 'Unsettled') => ({ up, down, startPrice: 0n, endPrice: 0n, state });
const cfg = (over = {}) => ({ ...CFG, matchedOnly: true, runnerOnly: true, random: () => 0.5, ...over });
const plan = (now, markets, c = cfg()) => planTick({ now, markets, agents: [], candles: {} }, c);
const types = (r) => r.actions.map((a) => a.type);
// Round 9 runs 2700..3000; round 10 can be called on. Round 8 ended at 2700 and can be settled.

test('matched only: an ended round with calls on both sides is settled, with the right feed ids', () => {
  const updates = [upd(1, 2410, 100), upd(2, 2690, 101)];
  const r = plan(2705, [mk(0, 10, { 8: R(5_000_000, 3_000_000) }, { feed: { address: FEED, updates } })]);
  assert.deepEqual(r.actions.filter((a) => a.type === 'settle').map((a) => [a.round, a.startId, a.endId]), [[8, id(1), id(2)]]);
});

test('matched only: a round nobody called is not settled (no gas)', () => {
  const r = plan(2705, [mk(0, 10, { 7: R(0, 0), 8: R(0, 0) })]);
  assert.deepEqual(types(r), []);
});

test('matched only: a one-sided round with a real call is settled right after it ends, with zero ids, and gets no price push', () => {
  const r = plan(2705, [mk(0, 10, { 8: R(5_000_000, 0), 6: R(0, 2_000_000) })]);
  assert.deepEqual(r.actions.map((a) => [a.type, a.round, a.startId, a.endId]), [['settle', 6, 0n, 0n], ['settle', 8, 0n, 0n]]);
  // both ended long enough ago to be inside the settle window; neither needs a price
  assert.equal(r.actions.some((a) => a.type === 'pushPrice'), false);
});

test('matched only: a one-sided round is settled only inside the settle window and only once', () => {
  assert.deepEqual(types(plan(2700, [mk(0, 10, { 8: R(5_000_000, 0) })])), []); // 8 ends at 2700: not before it has ended
  assert.deepEqual(types(plan(2705 + 3600, [mk(0, 10 + 12, { 8: R(5_000_000, 0) })])), []); // window over: the contract refunds it at claim
  assert.deepEqual(types(plan(2705, [mk(0, 10, { 8: R(5_000_000, 0, 'Refunded') })])), []); // already refunded
});

test('matched only: money that is only a house agent\x27s is not a real call, so that round is not settled', () => {
  const house = { key: 'coin-flipper', balance: 0, allowance: 0, positions: { '0:8': { up: 500_000, down: 0, claimed: false } } };
  const snap = (rounds) => ({ now: 2705, markets: [mk(0, 10, rounds)], agents: [house], candles: {} });
  assert.deepEqual(types(planTick(snap({ 8: R(500_000, 0) }), cfg())), []); // only the house agent called
  assert.deepEqual(types(planTick(snap({ 8: R(1_500_000, 0) }), cfg())), ['settle']); // a real person called too
});

test('testnet behaviour is unchanged: without matchedOnly a one-sided round is still settled (zero ids)', () => {
  const r = plan(2705, [mk(0, 10, { 8: R(5_000_000, 0) })], { ...CFG, runnerOnly: true, random: () => 0.5 });
  assert.deepEqual(r.actions.filter((a) => a.type === 'settle').map((a) => [a.round, a.startId, a.endId]), [[8, 0n, 0n]]);
});

test('matched only: the start price is pushed for a two-sided running round, not for an empty or one-sided one', () => {
  // round 9 locked at 2700 and is the running round (nextRound 10); 2705 is just after the lock
  const both = plan(2705, [mk(0, 10, { 9: R(2_000_000, 1_000_000) })]);
  assert.deepEqual(both.actions.map((a) => [a.type, a.why, a.round]), [['pushPrice', 'start price', 9]]);
  assert.deepEqual(types(plan(2705, [mk(0, 10, { 9: R(0, 0) })])), []);
  assert.deepEqual(types(plan(2705, [mk(0, 10, { 9: R(2_000_000, 0) })])), []);
  assert.deepEqual(types(plan(2705, [mk(0, 10, {})])), []); // no entry for the round at all
});

test('matched only: the end price is pushed only for a two-sided round that has its start price', () => {
  const updates = [upd(1, 2710, 100)]; // start price of round 9 is in
  assert.deepEqual(plan(2950, [mk(0, 10, { 9: R(2_000_000, 1_000_000) }, { feed: { address: FEED, updates } })]).actions.map((a) => a.why), ['end price']);
  assert.deepEqual(types(plan(2950, [mk(0, 10, { 9: R(2_000_000, 0) }, { feed: { address: FEED, updates } })])), []);
});

test('matched only: two markets on one feed, only the two-sided one needs the push, and it still gets exactly one', () => {
  const empty5 = mk(0, 10, { 9: R(0, 0) });
  const matched10 = mk(1, 10, { 9: R(4_000_000, 4_000_000) }, { name: 'BTC/USD 10m' });
  const r = plan(2705, [empty5, matched10]);
  assert.deepEqual(r.actions.map((a) => [a.type, a.market]), [['pushPrice', 1]]);
  const swapped = plan(2705, [matched10, empty5]);
  assert.deepEqual(swapped.actions.map((a) => [a.type, a.market]), [['pushPrice', 1]]);
});

test('matched only: the runner does not poll fast for a price that will not be pushed', () => {
  const snap = (rounds) => ({ now: 2705, markets: [mk(0, 10, rounds)], agents: [], candles: {} });
  assert.equal(tickDelay(snap({ 9: R(0, 0) }), cfg()), CFG.tickSeconds);
  assert.equal(tickDelay(snap({ 9: R(1_000_000, 1_000_000) }), cfg()), CFG.fastTickSeconds);
});

test('runner only: no bets, approvals or claims are planned, even where the testnet runner would', () => {
  const agent = { key: 'trend-follower', balance: 5_000_000, allowance: 10_000_000, positions: { '0:8': { up: 1_000_000, down: 0, claimed: false } } };
  const markets = [mk(0, 10, { 8: R(1_000_000, 0, 'Refunded') })];
  const r = planTick({ now: 3000 - 100, markets, agents: [agent], candles: {} }, cfg());
  assert.deepEqual(types(r), []);
  assert.deepEqual(r.decisions, []);
  const noAgents = plan(3000 - 100, markets); // agents: [] must not crash either
  assert.deepEqual(types(noAgents), []);
});

// ---------------------------------------------------------------- the supervisor and the source files

test('supervisor: testnet is unchanged; mainnet is a dry run unless it is given the long flag, which is then passed on', () => {
  assert.deepEqual(runnerSpec([]).args, ['--live']);
  assert.equal(runnerSpec([]).script, 'runner/run.mjs');
  assert.equal(runnerSpec(['--journal']).name, 'testnet');
  const dry = runnerSpec(['--mainnet']);
  assert.equal(dry.script, 'runner/run-mainnet.mjs');
  assert.deepEqual(dry.args, []);
  assert.match(dry.name, /dry run/);
  const live = runnerSpec(['--mainnet', SEND_FLAG, '--journal']);
  assert.deepEqual(live.args, [SEND_FLAG]);
  assert.match(live.title, /MAINNET/);
  assert.notEqual(live.logName, runnerSpec([]).logName);
});

test('source: the mainnet runner never mentions a deployer key or the old key name, and creates no wallet client without the flag', () => {
  for (const f of ['runner/mainnet.mjs', 'runner/run-mainnet.mjs']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/DEPLOYER_PRIVATE_KEY/.test(text), `${f} must not read a deployer key`);
    assert.ok(!/(?<!MAINNET_)RUNNER_PRIVATE_KEY/.test(text), `${f} must use MAINNET_RUNNER_PRIVATE_KEY only`);
    assert.ok(!/loadEnv\(|setup\(/.test(text.replace(/\/\/.*$/gm, '')), `${f} must not use the shared loaders that read every key`);
  }
  const main = fs.readFileSync(path.join(ROOT, 'runner/run-mainnet.mjs'), 'utf8');
  assert.match(main, /const wallet = LIVE \? createWalletClient/);
  assert.equal((main.match(/createWalletClient\(/g) || []).length, 1);
});
