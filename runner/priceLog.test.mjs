// Tests for the public price log and for the live price push that writes it. No network, no chain:
// fakes stand in for the blockchain and for Bitfinex.   node --test runner/priceLog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendPriceLog, readPriceLog, makePriceLogEntry, kindOf } from './priceLog.mjs';
import { makeExecutor } from './wallets.mjs';
import { planTick } from './plan.mjs';
import { CFG } from './config.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-log-'));
const tmp = () => path.join(tmpDir(), 'price-log.jsonl');
const FEEDS = {
  btc: { address: '0xBBBB000000000000000000000000000000000001' },
  eth: { address: '0xEEEE000000000000000000000000000000000002' },
  sol: { address: '0x5050000000000000000000000000000000000003' },
};
const deployments = { arena: { arena: { address: '0xA' }, feeds: FEEDS }, circle: { agents: [] } };
const QUOTE = { price: 8047700000000n, usd: 80477, quotedAt: 1_800_000_030, tradeAt: 1_800_000_027, source: 'Bitfinex' };

function fakeChain({ fail } = {}) {
  const sent = [];
  return {
    sent,
    wallet: { writeContract: async (x) => { sent.push(x); return '0xhash' + sent.length; } },
    pub: {
      waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 777n }),
      getBlock: async ({ blockNumber }) => {
        if (fail) throw new Error('rpc down');
        assert.equal(blockNumber, 777n);
        return { timestamp: 1_800_000_075n };
      },
    },
  };
}
const prices = (q = QUOTE) => ({ quote: async () => q });
const push = { type: 'pushPrice', market: 1, marketName: 'ETH/USD', round: 42, why: 'start price', firstTradeAfter: 1_800_000_010 };
const executor = (over) => makeExecutor({ live: true, env: {}, deployments, usdc: '0xU', arenaAbi: [], feedAbi: [], ...over });

test('log file: appended one line per entry and read back in order', () => {
  const f = tmp();
  appendPriceLog({ a: 1 }, f);
  appendPriceLog({ a: 2 }, f);
  assert.deepEqual(readPriceLog(f), [{ a: 1 }, { a: 2 }]);
  assert.equal(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length, 2);
});

test('log file: a missing file is an empty log, and a damaged line is skipped', () => {
  assert.deepEqual(readPriceLog(path.join(os.tmpdir(), 'kairo-does-not-exist.jsonl')), []);
  const f = tmp();
  appendPriceLog({ ok: 1 }, f);
  fs.appendFileSync(f, '{"half written');
  fs.appendFileSync(f, '\n');
  appendPriceLog({ ok: 2 }, f);
  assert.deepEqual(readPriceLog(f), [{ ok: 1 }, { ok: 2 }]);
});

test('log file: the folder is created when it does not exist', () => {
  const f = path.join(tmpDir(), 'nested', 'deeper', 'log.jsonl');
  appendPriceLog({ x: 1 }, f);
  assert.deepEqual(readPriceLog(f), [{ x: 1 }]);
});

test('entry: has the price, the source, both times, the transaction and an explorer link', () => {
  const e = makePriceLogEntry({
    action: push, quote: QUOTE, txHash: '0xabc', blockNumber: 777n, blockTimestamp: 1_800_000_075n,
    feed: FEEDS.eth.address, explorer: 'https://explorer.testnet.arc.io', chainId: 5042002,
  });
  assert.equal(e.label, 'TEST PRICES - NOT REAL DATA');
  assert.equal(e.market, 'ETH/USD');
  assert.equal(e.round, 42);
  assert.equal(e.kind, 'start');
  assert.equal(e.price, '8047700000000'); // a string: JSON cannot hold big numbers safely
  assert.equal(e.priceUsd, 80477);
  assert.equal(e.source, 'Bitfinex');
  assert.equal(e.lastTradeAt, 1_800_000_027); // when the trade that set the price happened
  assert.equal(e.sourceQuoteAt, 1_800_000_030);
  assert.equal(e.sourceQuoteAgeSec, 45); // block time minus the time the price was asked for (Bitfinex's clock)
  assert.equal(e.recordedAt, 1_800_000_075);
  assert.equal(e.recordedAtIso, new Date(1_800_000_075_000).toISOString());
  assert.equal(e.txHash, '0xabc');
  assert.equal(e.blockNumber, '777');
  assert.equal(e.explorerUrl, 'https://explorer.testnet.arc.io/tx/0xabc');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(e)));
});

test('entry: kinds are start, mid and end', () => {
  assert.equal(kindOf('start price'), 'start');
  assert.equal(kindOf('mid-round price'), 'mid');
  assert.equal(kindOf('end price'), 'end');
});

test('a live price push puts the price on the right feed and writes exactly one log line', async () => {
  const chain = fakeChain();
  const logged = [];
  const execute = executor({ pub: chain.pub, wallet: chain.wallet, prices: prices(), logPush: (e) => logged.push(e) });
  const res = await execute(push);
  assert.equal(chain.sent.length, 1);
  assert.equal(chain.sent[0].address, FEEDS.eth.address);
  assert.equal(chain.sent[0].functionName, 'setPrice');
  assert.deepEqual(chain.sent[0].args, [8047700000000n]);
  assert.equal(res.tx, '0xhash1');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].txHash, '0xhash1');
  assert.equal(logged[0].feed, FEEDS.eth.address);
  assert.equal(logged[0].round, 42);
  assert.equal(logged[0].recordedAt, 1_800_000_075);
});

test('a dry run writes no log line and sends nothing', async () => {
  const chain = fakeChain();
  const logged = [];
  const execute = executor({ live: false, pub: chain.pub, wallet: chain.wallet, prices: prices(), logPush: (e) => logged.push(e) });
  const res = await execute(push);
  assert.equal(res.dryRun, true);
  assert.equal(chain.sent.length, 0);
  assert.equal(logged.length, 0);
});

test('if the price API fails nothing is sent and nothing is logged', async () => {
  const chain = fakeChain();
  const logged = [];
  const failing = { quote: async () => { throw new Error('Bitfinex answered HTTP 429'); } };
  const execute = executor({ pub: chain.pub, wallet: chain.wallet, prices: failing, logPush: (e) => logged.push(e) });
  await assert.rejects(() => execute(push), /429/);
  assert.equal(chain.sent.length, 0);
  assert.equal(logged.length, 0);
});

test('if the log cannot be written, the push still counts and the warning is loud', async () => {
  const chain = fakeChain();
  const execute = executor({ pub: chain.pub, wallet: chain.wallet, prices: prices(), logPush: () => { throw new Error('disk full'); } });
  const res = await execute(push);
  assert.equal(res.tx, '0xhash1');
  assert.match(res.note, /WARNING: the price is on chain but could not be written to the price log: disk full/);

  const rpc = fakeChain({ fail: true });
  const execute2 = executor({ pub: rpc.pub, wallet: rpc.wallet, prices: prices(), logPush: () => {} });
  assert.match((await execute2(push)).note, /WARNING.*rpc down/s);
});

test('the planner tells the executor which round each price belongs to', () => {
  const id = (n) => (1n << 64n) | BigInt(n);
  const m = {
    id: 0, name: 'BTC/USD', roundLength: 600, startOffset: 0, minStake: 100_000, paused: false,
    nextRound: 11, feed: { updates: [{ id: id(1), updatedAt: 5990, price: 1n }] }, rounds: {},
  };
  const r = planTick({ now: 6000 + CFG.startAfter, markets: [m], agents: ['trend-follower', 'contrarian', 'streak-hunter', 'coin-flipper'].map((key) => ({ key, balance: 5_000_000, allowance: 10_000_000, positions: {} })) }, { ...CFG, random: Math.random });
  const p = r.actions.find((a) => a.type === 'pushPrice');
  assert.equal(p.round, 10); // round 10 is the one running (round 11 is the one open for calls)
});

test('start and end prices carry the running round and the right kind', () => {
  const id = (n) => (1n << 64n) | BigInt(n);
  const agentsList = ['trend-follower', 'contrarian', 'streak-hunter', 'coin-flipper'].map((key) => ({ key, balance: 5_000_000, allowance: 10_000_000, positions: {} }));
  const at = (now, updates) => {
    const m = { id: 0, name: 'BTC/USD', roundLength: 600, startOffset: 0, minStake: 100_000, paused: false, nextRound: 11, feed: { updates }, rounds: {} };
    return planTick({ now, markets: [m], agents: agentsList }, { ...CFG, random: Math.random }).actions.filter((a) => a.type === 'pushPrice');
  };
  const old = { id: id(1), updatedAt: 5990, price: 1n };
  const start = { id: id(2), updatedAt: 6010, price: 1n };
  assert.deepEqual(at(6010, [old]).map((a) => [a.why, a.round]), [['start price', 10]]);
  assert.deepEqual(at(6585, [old, start]).map((a) => [a.why, a.round]), [['end price', 10]]);
});
