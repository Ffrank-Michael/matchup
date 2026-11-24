// node --test runner/pusherWatch.test.mjs
// The relay pusher watch (runner/pusherWatch.mjs): every PusherChanged is alerted once, a relay whose pusher is not the runner
// is alerted once until it is fixed, nothing is skipped when the node fails, and nothing secret is in an alert. No chain, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPusherWatch, pusherChangedMessage, eventAlert, CHECK_EVERY_MS, MAX_LOG_RANGE, MIN_LOG_RANGE, START_LOOKBACK_BLOCKS, READ_FAIL_ALERT_MS } from './pusherWatch.mjs';
import { RUNNER_ENV_NAMES, readRunnerEnv } from './mainnet.mjs';

const RUNNER = getAddress('0x' + '22'.repeat(20));
const OTHER = getAddress('0x' + '66'.repeat(20));
const ETHBTC = getAddress('0x' + '44'.repeat(20));
const SOLBTC = getAddress('0x' + '45'.repeat(20));
const TX = '0x' + 'ab'.repeat(32);

/** A pretend chain: a block number, PusherChanged logs per block, pusher() per feed, and switches to make calls fail. */
function fakeChain({ latest = 10_000n, logs = [], pushers = {} } = {}) {
  const chain = { latest, logs, pushers, failLogs: false, calls: [] };
  chain.pub = {
    getBlockNumber: async () => chain.latest,
    getLogs: async ({ address, fromBlock, toBlock, events }) => {
      assert.ok(events.some((e) => e.name === 'PusherChanged'));
      chain.calls.push([fromBlock, toBlock]);
      if (chain.failLogs) throw new Error('rpc down');
      return chain.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && address.includes(getAddress(l.address)));
    },
    readContract: async ({ address, functionName }) => {
      assert.equal(functionName, 'pusher');
      if (!(address in chain.pushers)) throw new Error('not a relay');
      return chain.pushers[address];
    },
  };
  return chain;
}

function setup(opts = {}) {
  const chain = fakeChain(opts);
  let t = 0;
  const alerts = [];
  const lines = [];
  const check = createPusherWatch({
    pub: chain.pub, runner: RUNNER, arena: opts.arena ?? null, stateFile: opts.stateFile ?? null,
    alert: async (title, message) => { alerts.push({ title, message }); }, log: (l) => lines.push(l), now: () => t,
  });
  return { chain, check, alerts, lines, later: (ms = CHECK_EVERY_MS) => { t += ms; } };
}

const changed = (feed, block, oldPusher, newPusher, logIndex = 0) => ({
  address: feed.toLowerCase(), blockNumber: block, transactionHash: TX, logIndex, eventName: 'PusherChanged', args: { oldPusher, newPusher },
});

test('a PusherChanged on a relay is alerted (phone + log), naming the relay, both addresses, block and tx', async () => {
  const s = setup({ logs: [changed(ETHBTC, 9_500n, RUNNER, OTHER)], pushers: { [ETHBTC]: RUNNER, [SOLBTC]: RUNNER } });
  const sent = await s.check([ETHBTC, SOLBTC], { [ETHBTC]: 'ETH/BTC relay' });
  assert.equal(sent.length, 1);
  assert.equal(s.alerts.length, 1);
  assert.equal(s.alerts[0].title, 'Matchup: relay pusher changed');
  assert.match(s.alerts[0].message, new RegExp(`ETH/BTC relay ${ETHBTC}: pusher ${RUNNER} -> ${OTHER} \\(NOT this runner\\) at block 9500, tx ${TX}`));
  assert.match(s.alerts[0].message, /setMarketPaused/);
  assert.ok(s.lines.some((l) => l.startsWith('ALERT: Matchup: relay pusher changed')));
});

test('an expected change (back to this runner) is still alerted, marked as this runner', () => {
  const m = pusherChangedMessage(changed(SOLBTC, 5n, OTHER, RUNNER), RUNNER);
  assert.match(m.message, /\(this runner\)/);
  assert.doesNotMatch(m.message, /NOT this runner/);
});

test('each event is alerted once, and the next check starts right after the last block read', async () => {
  const s = setup({ logs: [changed(ETHBTC, 9_999n, RUNNER, OTHER)], pushers: {} });
  await s.check([ETHBTC]);
  assert.equal(s.chain.calls.at(-1)[1], 10_000n);
  s.later();
  s.chain.latest = 10_005n;
  await s.check([ETHBTC]);
  assert.equal(s.alerts.length, 1);
  assert.deepEqual(s.chain.calls.at(-1), [10_001n, 10_005n]);
});

test('on start it looks back START_LOOKBACK_BLOCKS blocks, and reads in chunks of at most MAX_LOG_RANGE', async () => {
  const s = setup({ latest: 100_000n });
  await s.check([ETHBTC]);
  assert.deepEqual(s.chain.calls[0], [100_000n - START_LOOKBACK_BLOCKS, 100_000n - START_LOOKBACK_BLOCKS + MAX_LOG_RANGE - 1n]);
  for (const [from, to] of s.chain.calls) assert.ok(to - from + 1n <= MAX_LOG_RANGE);
  assert.equal(s.chain.calls.at(-1)[1], 100_000n);
  // and a long gap later is read in several chunks, none skipped
  s.later();
  s.chain.latest = 105_000n;
  const before = s.chain.calls.length;
  await s.check([ETHBTC]);
  const next = s.chain.calls.slice(before);
  assert.equal(next[0][0], 100_001n);
  for (let i = 1; i < next.length; i++) assert.equal(next[i][0], next[i - 1][1] + 1n);
  assert.equal(next.at(-1)[1], 105_000n);
});

test('a failed log read is retried from the same block next time (nothing skipped) and does not throw', async () => {
  const s = setup({ logs: [changed(ETHBTC, 9_900n, RUNNER, OTHER)] });
  s.chain.failLogs = true;
  await s.check([ETHBTC]);
  assert.equal(s.alerts.length, 0);
  assert.ok(s.lines.some((l) => /could not read the contract events/.test(l)));
  s.later();
  s.chain.failLogs = false;
  await s.check([ETHBTC]);
  assert.equal(s.alerts.length, 1, 'the event from the failed window is still found');
});

test('a relay whose pusher() is not the runner is alerted once, and again only after it was fixed and broke again', async () => {
  const s = setup({ pushers: { [ETHBTC]: OTHER, [SOLBTC]: RUNNER } });
  await s.check([ETHBTC, SOLBTC]);
  assert.equal(s.alerts.length, 1);
  assert.equal(s.alerts[0].title, 'Matchup: runner is not the pusher');
  assert.match(s.alerts[0].message, new RegExp(`${ETHBTC}: pusher\\(\\) is ${OTHER}`));
  s.later(); await s.check([ETHBTC, SOLBTC]);
  assert.equal(s.alerts.length, 1, 'not repeated every minute');
  s.chain.pushers[ETHBTC] = RUNNER;
  s.later(); await s.check([ETHBTC, SOLBTC]);
  s.chain.pushers[ETHBTC] = OTHER;
  s.later(); await s.check([ETHBTC, SOLBTC]);
  assert.equal(s.alerts.length, 2);
});

test('feeds that are not relays (no pusher()) are skipped; duplicate and lower-case addresses are read once', async () => {
  const s = setup({ pushers: { [SOLBTC]: RUNNER } });
  await s.check([ETHBTC, SOLBTC, SOLBTC.toLowerCase()]);
  assert.equal(s.alerts.length, 0);
});

test('at most one check a minute', async () => {
  const s = setup({ pushers: { [ETHBTC]: RUNNER } });
  await s.check([ETHBTC]);
  const reads = s.chain.calls.length;
  await s.check([ETHBTC]);
  assert.equal(s.chain.calls.length, reads, 'the second call within a minute reads nothing');
  s.later();
  s.chain.latest += 1n;
  await s.check([ETHBTC]);
  assert.ok(s.chain.calls.length > reads, 'a minute later it reads the new block');
});

test('the mainnet runner takes NTFY_TOPIC from .env (for the alert), and still no key but its own', () => {
  assert.ok(RUNNER_ENV_NAMES.includes('NTFY_TOPIC'));
  const env = readRunnerEnv('NTFY_TOPIC=matchup-alerts-x\nMAINNET_DEPLOYER_PRIVATE_KEY=0x' + 'cd'.repeat(32));
  assert.deepEqual(Object.keys(env), ['NTFY_TOPIC']);
});

// ---------------------------------------------------------------- P2-06: ownership, the arena, a blind watch, restarts

const ARENA = getAddress('0x' + '77'.repeat(20));
const ev = (address, block, eventName, args) => ({ address: address.toLowerCase(), blockNumber: block, transactionHash: TX, logIndex: Number(block % 1000n), eventName, args });

test('ownership moves on a relay or the arena are alerted, and the arena\'s market events too', async () => {
  const s = setup({ arena: ARENA, logs: [
    ev(ETHBTC, 9_100n, 'OwnershipTransferStarted', { previousOwner: RUNNER, newOwner: OTHER }),
    ev(ARENA, 9_200n, 'OwnershipTransferred', { previousOwner: RUNNER, newOwner: OTHER }),
    ev(ARENA, 9_300n, 'MarketCreated', { marketId: 14n, name: 'ETH/BTC 1h', feedA: OTHER }),
    ev(ARENA, 9_400n, 'MarketPausedChanged', { marketId: 12n, paused: true }),
  ] });
  await s.check([ETHBTC], { [ETHBTC]: 'ETH/BTC relay' });
  assert.deepEqual(s.alerts.map((a) => a.title), ['Matchup: ownership transfer started', 'Matchup: owner changed', 'Matchup: market created', 'Matchup: market paused']);
  assert.ok(s.alerts[0].message.startsWith(`ETH/BTC relay ${ETHBTC}: owner ${RUNNER} proposed ${OTHER}`));
  assert.ok(s.alerts[1].message.startsWith(`Arena ${ARENA}: owner`));
  assert.match(s.alerts[2].message, /new market 14 "ETH\/BTC 1h"/);
  assert.ok(s.alerts.slice(0, 3).every((a) => /docs\/RUNBOOK\.md/.test(a.message)));
});

test('the arena is read together with the relays, in one request per chunk', async () => {
  const s = setup({ arena: ARENA });
  const asked = [];
  const orig = s.chain.pub.getLogs;
  s.chain.pub.getLogs = async (q) => { asked.push(q.address); return orig(q); };
  await s.check([ETHBTC]);
  assert.deepEqual(asked[0], [ETHBTC, ARENA]);
});

test('a blind watch alerts after 5 minutes of failed reads, then at most once an hour; reads shrink to a range the node accepts', async () => {
  const s = setup({});
  s.chain.failLogs = true;
  const ranges = [];
  const orig = s.chain.pub.getLogs;
  s.chain.pub.getLogs = async (q) => { ranges.push(q.toBlock - q.fromBlock + 1n); return orig(q); };
  const blind = () => s.alerts.filter((a) => /cannot read the chain/.test(a.title)).length;
  await s.check([ETHBTC]);
  for (let i = 0; i < 5; i++) { s.later(); await s.check([ETHBTC]); }
  assert.equal(blind(), 0, 'not within the first 5 minutes');
  s.later(); await s.check([ETHBTC]);
  assert.equal(blind(), 1);
  s.later(); await s.check([ETHBTC]);
  assert.equal(blind(), 1, 'not every minute');
  assert.equal(READ_FAIL_ALERT_MS, 5 * 60_000);
  assert.equal(ranges[0], MAX_LOG_RANGE);
  assert.equal(ranges.at(-1), MIN_LOG_RANGE, 'halved down to the smallest range');
  s.chain.failLogs = false;
  const failuresBefore = s.lines.filter((l) => /could not read/.test(l)).length;
  s.later(); await s.check([ETHBTC]);
  assert.equal(s.lines.filter((l) => /could not read/.test(l)).length, failuresBefore, 'reads work again: no new failure');
  assert.equal(s.chain.calls.at(-1)[1], s.chain.latest, 'and it caught up to the newest block');
});

test('the place is saved: a restart goes on from the last block and does not alert old events again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pusher-watch-'));
  const stateFile = path.join(dir, 'watch.json');
  const logs = [changed(ETHBTC, 9_500n, RUNNER, OTHER)];
  const first = setup({ logs, stateFile });
  await first.check([ETHBTC]);
  assert.equal(first.alerts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).nextBlock, '10001');
  const second = setup({ logs, stateFile, latest: 10_050n }); // a restart: a new watch with the same file
  await second.check([ETHBTC]);
  assert.equal(second.alerts.length, 0, 'the old event is not alerted again');
  assert.deepEqual(second.chain.calls[0], [10_001n, 10_050n]);
});

test('eventAlert: a pusher change back to this runner is marked as such; an unpause has no warning tail', () => {
  assert.match(eventAlert(ev(ETHBTC, 5n, 'PusherChanged', { oldPusher: OTHER, newPusher: RUNNER }), RUNNER).message, /\(this runner\)/);
  const un = eventAlert(ev(ARENA, 6n, 'MarketPausedChanged', { marketId: 3n, paused: false }), RUNNER, { arena: ARENA });
  assert.equal(un.title, 'Matchup: market unpaused');
  assert.doesNotMatch(un.message, /RUNBOOK/);
});

test('source: the mainnet runner alerts on the phone before it stops for a failed start-up check', () => {
  const text = fs.readFileSync(new URL('./run-mainnet.mjs', import.meta.url), 'utf8');
  assert.match(text, /await alertPhone\('Matchup MAINNET runner cannot start'/);
  assert.match(text, /arena: cfg\.arena/);
  assert.match(text, /pusher-watch-mainnet\.json/);
});
