// node --test runner/pusherWatch.test.mjs
// The relay pusher watch (runner/pusherWatch.mjs): every PusherChanged is alerted once, a relay whose pusher is not the runner
// is alerted once until it is fixed, nothing is skipped when the node fails, and nothing secret is in an alert. No chain, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { createPusherWatch, pusherChangedMessage, CHECK_EVERY_MS, MAX_LOG_RANGE, START_LOOKBACK_BLOCKS } from './pusherWatch.mjs';
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
    getLogs: async ({ address, fromBlock, toBlock, event }) => {
      assert.equal(event.name, 'PusherChanged');
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

function setup(opts) {
  const chain = fakeChain(opts);
  let t = 0;
  const alerts = [];
  const lines = [];
  const check = createPusherWatch({ pub: chain.pub, runner: RUNNER, alert: async (title, message) => { alerts.push({ title, message }); }, log: (l) => lines.push(l), now: () => t });
  return { chain, check, alerts, lines, later: () => { t += CHECK_EVERY_MS; } };
}

const changed = (feed, block, oldPusher, newPusher, logIndex = 0) => ({
  address: feed.toLowerCase(), blockNumber: block, transactionHash: TX, logIndex, args: { oldPusher, newPusher },
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
  assert.ok(s.lines.some((l) => /could not read PusherChanged logs/.test(l)));
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
