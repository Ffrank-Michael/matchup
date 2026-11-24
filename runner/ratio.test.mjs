// Tests for the coin-vs-coin ("ratio") markets in the runner: the maths, the start-price rule for BOTH coins, the price log,
// the ratio candles, the planner, the testnet executor and the AI prompts. No network: fake fetch, fake chain.
//   node --test runner/ratio.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { RATIO_PAIRS, pairOf, isRatioPair, isRatioMarket, decimalsOf, legsOf, ratio18, toUsd8, priceNumber, priceText } from './pairs.mjs';
import { createExchangePrices } from './exchangePrices.mjs';
import { makePriceLogEntry } from './priceLog.mjs';
import { createCandles, ratioCandles } from './candles.mjs';
import { planTick, lockTime, endTime } from './plan.mjs';
import { CFG } from './config.mjs';
import { makeExecutor } from './wallets.mjs';
import { buildBatchPrompt, buildGuidePrompt, coinShort, ratioNote } from '../agents/ai.mjs';

const NOW = 1_800_000_000_000; // ms

// ---------------------------------------------------------------- the maths

test('the pairs: ETH/BTC and SOL/BTC, each made of two USD markets', () => {
  assert.deepEqual(Object.keys(RATIO_PAIRS), ['ETH/BTC', 'SOL/BTC']);
  assert.deepEqual(legsOf('ETH/BTC'), ['ETH/USD', 'BTC/USD']);
  assert.deepEqual(legsOf('SOL/BTC'), ['SOL/USD', 'BTC/USD']);
  assert.equal(legsOf('BTC/USD'), null);
  assert.equal(pairOf('ETH/BTC 1h'), 'ETH/BTC');
  assert.ok(isRatioMarket('SOL/BTC 1h'));
  assert.ok(!isRatioMarket('SOL/USD 1h'));
  assert.ok(!isRatioPair('toString'), 'no prototype names');
  assert.equal(decimalsOf('ETH/BTC'), 18);
  assert.equal(decimalsOf('ETH/USD'), 8);
});

test('ratio18 is the same maths as the RatioGuard contract (rounded down)', () => {
  assert.equal(ratio18(3_000_00000000n, 100_000_00000000n), 30_000_000_000_000_000n); // 0.03
  assert.equal(ratio18(150_00000000n, 100_000_00000000n), 1_500_000_000_000_000n);  // 0.0015
  // the same hand-checked numbers as contracts/test/RatioGuard.t.sol (test_realisticPrices_matchHandMaths)
  assert.equal(ratio18(331_287_654_321n, 9_765_412_345_678n), 33_924_594_537_743_416n);
  assert.equal(ratio18(1_00000000n, 3_00000000n), 333_333_333_333_333_333n, 'rounds down');
  assert.throws(() => ratio18(0n, 1n));
  assert.throws(() => ratio18(1n, -1n));
});

test('prices read back as numbers and text with the right decimals', () => {
  assert.equal(toUsd8(3312.87654321), 331_287_654_321n);
  assert.equal(priceNumber(30_000_000_000_000_000n, 'ETH/BTC'), 0.03);
  assert.equal(priceNumber('8047700000000', 'BTC/USD'), 80477);
  assert.equal(priceText(33_924_594_537_743_416n, 'ETH/BTC'), '0.0339246 BTC');
  assert.equal(priceText(8_047_700_000_000n, 'BTC/USD'), '$80,477.00');
});

// ---------------------------------------------------------------- prices from Bitfinex

const ok = (data) => ({ ok: true, status: 200, json: async () => data, headers: new Headers({ date: new Date(NOW).toUTCString() }) });
/** A fake Bitfinex that answers per symbol: { tETHUSD: [timeMs, price] | null, ... }. */
function fakeBitfinex(bySymbol) {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    const sym = url.match(/trades\/(t[A-Z]+)\//)[1];
    const t = bySymbol[sym];
    return ok(t ? [[1, t[0], 0.1, t[1]]] : []);
  };
  return { fetchFn, urls };
}

test('a ratio quote asks BOTH coins and divides them, 18 decimals', async () => {
  const { fetchFn, urls } = fakeBitfinex({ tETHUSD: [NOW - 3000, 3000], tBTCUSD: [NOW - 1000, 100000] });
  const prices = createExchangePrices({ fetchFn, nowMs: () => NOW });
  const q = await prices.quote('ETH/BTC 1h');
  assert.equal(q.price, 30_000_000_000_000_000n);
  assert.equal(q.decimals, 18);
  assert.equal(q.usd, 0.03);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes('/tETHUSD/') && urls[1].includes('/tBTCUSD/'), 'top coin first, then the bottom one');
  assert.deepEqual(q.legs.map((l) => [l.pair, l.usd, l.price]), [['ETH/USD', 3000, '300000000000'], ['BTC/USD', 100000, '10000000000000']]);
  assert.equal(q.tradeAt, (NOW - 1000) / 1000, 'the later of the two trades');
});

test('the START ratio uses each coin\'s own first trade at least 2 s after the lock', async () => {
  const lock = NOW / 1000 - 30;
  const after = lock + CFG.startAfter;
  const { fetchFn, urls } = fakeBitfinex({ tSOLUSD: [after * 1000 + 400, 150], tBTCUSD: [after * 1000 + 9000, 100000] });
  const prices = createExchangePrices({ fetchFn, nowMs: () => NOW, windows: {} }); // the single-trade rule (BTC's window has its own test)
  const q = await prices.quote('SOL/BTC 1h', { firstTradeAfter: after });
  for (const u of urls) assert.ok(u.endsWith(`limit=1&sort=1&start=${after * 1000}`), `oldest trade from lock + 2 s: ${u}`);
  assert.equal(q.price, 1_500_000_000_000_000n);
  assert.equal(q.legs[0].tradeAt, after);
  assert.equal(q.legs[1].tradeAt, after + 9);
});

test('no start ratio until BOTH coins have traded after the lock (it tries again)', async () => {
  const after = NOW / 1000 - 10;
  const { fetchFn } = fakeBitfinex({ tETHUSD: [after * 1000 + 100, 3000], tBTCUSD: null });
  const prices = createExchangePrices({ fetchFn, nowMs: () => NOW, windows: {} }); // the single-trade rule
  await assert.rejects(prices.quote('ETH/BTC 1h', { firstTradeAfter: after }), /no BTC\/USD trade on Bitfinex yet.*will try again/);
});

test('a ratio that jumps more than 20% is not trusted', async () => {
  let t = NOW;
  let eth = 3000;
  const fetchFn = async (url) => ok([[1, t - 1000, 0.1, url.includes('tETHUSD') ? eth : 100000]]);
  const prices = createExchangePrices({ fetchFn, nowMs: () => t, maxJump: 0.2 });
  await prices.quote('ETH/BTC 1h');
  t += 10_000;
  eth = 3000 * 1.19; // the ETH leg alone passes (19%), and so does the ratio
  await prices.quote('ETH/BTC 1h');
  t += 10_000;
  eth = 3000 * 1.19 * 1.25;
  await assert.rejects(prices.quote('ETH/BTC 1h'), /moved from/);
});

// ---------------------------------------------------------------- the price log

test('the price log keeps the ratio and BOTH trades it was made from', () => {
  const quote = {
    price: 30_000_000_000_000_000n, usd: 0.03, decimals: 18, source: 'Bitfinex', quotedAt: 1_800_000_000, tradeAt: 1_799_999_999,
    legs: [{ pair: 'ETH/USD', usd: 3000, price: '300000000000', tradeAt: 1_799_999_990, quotedAt: 1_800_000_000 }, { pair: 'BTC/USD', usd: 100000, price: '10000000000000', tradeAt: 1_799_999_999, quotedAt: 1_800_000_000 }],
  };
  const e = makePriceLogEntry({ action: { marketName: 'ETH/BTC 1h', market: 12, round: 7, why: 'start price' }, quote, txHash: '0xabc', blockNumber: 5n, blockTimestamp: 1_800_000_003n, feed: '0xfeed', explorer: 'https://x', chainId: 5042002 });
  assert.equal(e.price, '30000000000000000');
  assert.equal(e.decimals, 18);
  assert.equal(e.ratio, 0.03);
  assert.equal(e.priceUsd, undefined, 'a ratio is not a dollar price');
  assert.deepEqual(e.legs, [
    { pair: 'ETH/USD', priceUsd: 3000, price: '300000000000', lastTradeAt: 1_799_999_990, sourceQuoteAt: 1_800_000_000 },
    { pair: 'BTC/USD', priceUsd: 100000, price: '10000000000000', lastTradeAt: 1_799_999_999, sourceQuoteAt: 1_800_000_000 },
  ]);
  assert.equal(e.kind, 'start');
  // a USD entry is unchanged
  const u = makePriceLogEntry({ action: { marketName: 'BTC/USD 5m', market: 0, round: 1, why: 'end price' }, quote: { price: 8_047_700_000_000n, usd: 80477, quotedAt: 1, tradeAt: 1 }, txHash: '0x1', blockNumber: 1n, blockTimestamp: 2n, feed: '0xf', explorer: 'https://x', chainId: 1 });
  assert.equal(u.priceUsd, 80477);
  assert.equal(u.decimals, 8);
  assert.equal(u.legs, undefined);
});

// ---------------------------------------------------------------- candles for the agents

test('ratio candles: open and close divided minute by minute, no invented wicks, only minutes both coins traded', () => {
  const top = [{ time: 60, open: 3000, close: 3030, high: 3050, low: 2990 }, { time: 120, open: 3030, close: 3000, high: 3040, low: 2980 }, { time: 180, open: 1, close: 1 }];
  const bottom = [{ time: 60, open: 100000, close: 100000, high: 100100, low: 99900 }, { time: 120, open: 100000, close: 101000, high: 101500, low: 99000 }];
  const r = ratioCandles(top, bottom);
  assert.equal(r.length, 2, 'the 180 minute has no BTC candle');
  assert.deepEqual(r[0], { time: 60, open: 0.03, close: 0.0303, high: 0.0303, low: 0.03 });
  assert.equal(r[1].close, 3000 / 101000);
  assert.equal(r[1].high, r[1].open);
  assert.equal(r[1].low, r[1].close);
});

test('the candle source builds ETH/BTC from the ETH and BTC candles', async () => {
  const asked = [];
  const now = 10 * 60_000;
  const candle = (t, p) => [t, p, p, p, p, 1];
  const fetchFn = async (url) => {
    asked.push(url);
    const p = url.includes('tETHUSD') ? 3000 : 100000;
    return { ok: true, json: async () => [candle(now - 120_000, p), candle(now - 180_000, p)] };
  };
  const c = createCandles({ fetchFn, nowMs: () => now });
  const got = await c.get('ETH/BTC');
  assert.equal(got.length, 2);
  assert.ok(got.every((k) => k.close === 0.03));
  assert.ok(asked.some((u) => u.includes('trade:1m:tETHUSD')) && asked.some((u) => u.includes('trade:1m:tBTCUSD')));
});

// ---------------------------------------------------------------- the planner

const ratioMarket = (over = {}) => ({
  id: 12, name: 'ETH/BTC 1h', roundLength: 3600, startOffset: 50, minStake: 500_000, paused: false, nextRound: 6,
  feed: { address: '0xratio', updates: [] }, rounds: {}, ...over,
});

test('a two-sided ETH/BTC round gets its start push with the 2-second rule, and settles with the right ids', () => {
  const m = ratioMarket();
  m.rounds[5] = { state: 'Unsettled', up: 1_000_000, down: 1_000_000 };
  const lock5 = lockTime(m, 5);
  const snap = { now: lock5 + 3, markets: [m], agents: [] };
  const { actions } = planTick(snap, { ...CFG, matchedOnly: true, runnerOnly: true });
  const push = actions.find((a) => a.type === 'pushPrice');
  assert.equal(push.marketName, 'ETH/BTC 1h');
  assert.equal(push.why, 'start price');
  assert.equal(push.firstTradeAfter, lock5 + 2);

  // later: start and end are on the feed, the round has ended -> settle with exactly those ids
  const P = 1n << 64n;
  m.feed.updates = [{ id: P | 1n, updatedAt: lock5 - 10, price: 29n * 10n ** 15n }, { id: P | 2n, updatedAt: lock5 + 6, price: 3n * 10n ** 16n }, { id: P | 3n, updatedAt: endTime(m, 5) - 60, price: 31n * 10n ** 15n }];
  m.nextRound = 7;
  const later = planTick({ now: endTime(m, 5) + 5, markets: [m], agents: [] }, { ...CFG, matchedOnly: true, runnerOnly: true });
  const settle = later.actions.find((a) => a.type === 'settle');
  assert.deepEqual([settle.round, settle.startId, settle.endId], [5, P | 2n, P | 3n]);
});

test('the house agents read ratio history as ratio numbers (18 decimals), not dollars', () => {
  const m = ratioMarket({ nextRound: 4 });
  const P = 1n << 64n;
  // round 1 and 2 finished: 0.030 -> 0.031, and 0.031 -> 0.030
  m.feed.updates = [
    { id: P | 1n, updatedAt: lockTime(m, 1) + 5, price: 30n * 10n ** 15n },
    { id: P | 2n, updatedAt: endTime(m, 1) - 60, price: 31n * 10n ** 15n },
    { id: P | 3n, updatedAt: lockTime(m, 2) + 5, price: 31n * 10n ** 15n },
    { id: P | 4n, updatedAt: endTime(m, 2) - 60, price: 30n * 10n ** 15n },
  ];
  const agents = ['trend-follower', 'chart-reader', 'coin-flipper', 'contrarian'].map((key) => ({ key, balance: 5_000_000, allowance: 10_000_000, positions: {} }));
  const snap = { now: lockTime(m, 3) + CFG.earlyDelay + 1, markets: [m], agents, candles: {} };
  const { decisions } = planTick(snap, { ...CFG, random: () => 0.9 }); // the plain rules (no AI)
  const tf = decisions.find((d) => d.agent === 'trend-follower');
  assert.equal(tf.decision.action, 'CALL');
  assert.equal(tf.decision.side, 'DOWN', 'the last finished round went from 0.031 to 0.030');
  assert.ok(tf.decision.reason.includes('(0.031 -> 0.03, -3.23%)'), tf.decision.reason);
});

// ---------------------------------------------------------------- the testnet executor

test('testnet: an ETH/BTC push sets the ETH and BTC stand-ins to their OWN prices, then pushes the ratio to the relay', async () => {
  const sent = [];
  const logged = [];
  const wallet = { writeContract: async (x) => { sent.push(x); return `0x${sent.length}`; } };
  const pub = { waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 9n }), getBlock: async () => ({ timestamp: 1_800_000_100n }) };
  const deployments = {
    arena: { arena: { address: '0xarena' }, guards: { btc: { address: '0xbtcStandIn', kind: 'test stand-in' }, eth: { address: '0xethStandIn', kind: 'test stand-in' }, sol: { address: '0xsolStandIn', kind: 'test stand-in' } } },
    circle: { agents: [] },
  };
  const quote = {
    price: 30_000_000_000_000_000n, usd: 0.03, decimals: 18, source: 'Bitfinex', quotedAt: 1_800_000_000, tradeAt: 1_800_000_000,
    legs: [{ pair: 'ETH/USD', usd: 3000, price: '300000000000', tradeAt: 1, quotedAt: 1 }, { pair: 'BTC/USD', usd: 100000, price: '10000000000000', tradeAt: 1, quotedAt: 1 }],
  };
  const prices = { quote: async () => quote };
  const execute = makeExecutor({ live: true, env: {}, deployments, pub, wallet, usdc: '0xusdc', arenaAbi: [], feedAbi: ['feed'], relayAbi: ['relay'], prices, logPush: (e) => logged.push(e) });
  const res = await execute({ type: 'pushPrice', market: 12, marketName: 'ETH/BTC 1h', round: 3, feed: '0xratioRelay', why: 'end price', endsAt: 1_800_000_200 });
  assert.deepEqual(sent.map((x) => [x.address, x.functionName, x.args[0]]), [
    ['0xethStandIn', 'setPrice', 300_000_000_000n],
    ['0xbtcStandIn', 'setPrice', 10_000_000_000_000n],
    ['0xratioRelay', 'setPrice', 30_000_000_000_000_000n],
  ]);
  assert.equal(sent[2].abi[0], 'relay');
  assert.match(res.note, /0\.03 BTC/);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].legs.length, 2);
});

test('testnet: a USD push still sets only its own coin\'s stand-in', async () => {
  const sent = [];
  const wallet = { writeContract: async (x) => { sent.push(x); return '0x1'; } };
  const pub = { waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n }), getBlock: async () => ({ timestamp: 1n }) };
  const deployments = { arena: { arena: { address: '0xa' }, guards: { btc: { address: '0xbtcStandIn', kind: 'test stand-in' } } }, circle: { agents: [] } };
  const prices = { quote: async () => ({ price: 8_000_000_000_000n, usd: 80000, quotedAt: 1, tradeAt: 1 }) };
  const execute = makeExecutor({ live: true, env: {}, deployments, pub, wallet, usdc: '0xu', arenaAbi: [], feedAbi: [], relayAbi: [], prices, logPush: () => {} });
  await execute({ type: 'pushPrice', market: 0, marketName: 'BTC/USD 5m', round: 1, feed: '0xbtcRelay', why: 'start price' });
  assert.deepEqual(sent.map((x) => x.address), ['0xbtcStandIn', '0xbtcRelay']);
});

// ---------------------------------------------------------------- the AI prompts (testnet agents and guide calls)

test('the AI prompts name a ratio pair in full and say what UP and DOWN mean', () => {
  assert.equal(coinShort('ETH/BTC'), 'ETH/BTC');
  assert.equal(coinShort('ETH/USD'), 'ETH');
  assert.deepEqual(ratioNote('BTC/USD'), []);
  const candles = Array.from({ length: 40 }, (_, i) => ({ time: 60 * i, open: 0.03, close: 0.03 + i * 1e-5 }));
  const batch = buildBatchPrompt({ coin: 'ETH/BTC', candles, frames: [{ label: '1h', roundSeconds: 3600, secondsToLock: 1200 }] }).user;
  assert.match(batch, /ETH\/BTC is not a dollar price: it is ETH\/USD divided by BTC\/USD/);
  assert.match(batch, /UP means ETH beats BTC/);
  const guide = buildGuidePrompt({ agent: 'trend-follower', coins: [{ coin: 'SOL/BTC', candles, frames: [{ label: '1h', roundSeconds: 3600, secondsToLock: 1200 }] }] }).user;
  assert.match(guide, /Coin: SOL\/BTC\./);
  assert.match(guide, /UP means SOL beats BTC/);
  assert.match(guide, /SOL\/BTC 1h: last/, 'the lookback window is named with the full pair');
  const usd = buildBatchPrompt({ coin: 'BTC/USD', candles, frames: [{ label: '5m', roundSeconds: 300, secondsToLock: 200 }] }).user;
  assert.doesNotMatch(usd, /not a dollar price/);
});
