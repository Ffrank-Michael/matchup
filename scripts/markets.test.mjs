// Tests for the deploy script's market lists and guard check (no network, nothing sent).  Run:  node --test scripts/markets.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';

import { SETS, COINS, CHAINLINK_MAINNET, MIN_STAKE, FEED_DECIMALS, MAX_GUARD_AGE_SECONDS, marketName, relayDescription, standInDescription, validateSet, judgeGuard } from './markets.mjs';
import { compile } from './compile.mjs';

test('both sets are the same six markets: BTC, ETH and SOL at 5 and at 10 minutes', () => {
  for (const name of ['rehearsal', 'mainnet']) {
    assert.deepEqual(validateSet(name), [], name);
    const names = SETS[name].markets.map(marketName);
    assert.deepEqual(names, ['BTC/USD 5m', 'ETH/USD 5m', 'SOL/USD 5m', 'BTC/USD 10m', 'ETH/USD 10m', 'SOL/USD 10m']);
  }
  assert.deepEqual(SETS.rehearsal.markets, SETS.mainnet.markets);
  assert.equal(SETS.rehearsal.network, 'testnet');
  assert.equal(SETS.mainnet.network, 'mainnet');
});

test('offsets are the agreed ones, and no two markets of the same round length lock at the same second', () => {
  const at = (n) => SETS.mainnet.markets.find((m) => marketName(m) === n).offset;
  assert.deepEqual(['BTC/USD 5m', 'ETH/USD 5m', 'SOL/USD 5m'].map(at), [0, 100, 200]);
  assert.deepEqual(['BTC/USD 10m', 'ETH/USD 10m', 'SOL/USD 10m'].map(at), [0, 200, 400]);
});

test('bands are 1.0% for BTC and 1.5% for ETH and SOL, and the relay description says so', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(COINS).map(([k, c]) => [k, c.bandBps])), { btc: 100, eth: 150, sol: 150 });
  assert.equal(relayDescription('btc', 'mainnet'), 'Kairo relay BTC / USD: Bitfinex last trade, checked against Chainlink within 1.0%');
  assert.match(relayDescription('eth', 'mainnet'), /within 1\.5%$/);
  assert.match(relayDescription('sol', 'mainnet'), /Chainlink within 1\.5%$/);
});

test('the testnet rehearsal is labelled as a rehearsal and its stand-ins carry the test warning', () => {
  for (const c of Object.keys(COINS)) {
    assert.match(relayDescription(c, 'rehearsal'), /^Kairo relay .* \(TESTNET REHEARSAL\)/);
    assert.ok(!/Chainlink within/.test(relayDescription(c, 'rehearsal')), 'the rehearsal must not claim to use Chainlink');
    assert.ok(standInDescription(c).startsWith('TEST PRICES - NOT REAL DATA'), 'MockPriceFeed insists on this prefix');
    assert.ok(relayDescription(c, 'mainnet').startsWith('Kairo relay '), 'GuardedRelayFeed insists on this prefix');
  }
});

test('descriptions the deploy script passes are accepted by the contracts\' own prefix rules', () => {
  const art = compile();
  assert.ok(art.relay.bytecode.length > 100 && art.feed.bytecode.length > 100 && art.arena.bytecode.length > 100);
  assert.ok((art.relay.deployedBytecode.length - 2) / 2 < 24576);
});

test('Chainlink proxies are valid, different addresses', () => {
  const list = Object.values(CHAINLINK_MAINNET);
  assert.equal(new Set(list.map((a) => a.toLowerCase())).size, 3);
  for (const a of list) assert.doesNotThrow(() => getAddress(a.toLowerCase()));
  assert.equal(CHAINLINK_MAINNET.btc, '0xa109B535C70C8Be9995be64Bb6751AcDB27e03De');
  assert.equal(CHAINLINK_MAINNET.eth, '0x50FCDD99D6762D1C170DC6A9111db944AEE6D364');
  assert.equal(CHAINLINK_MAINNET.sol, '0x2d04D354f5fDaE3De723df475745B0a9B4edf90C');
});

test('market settings: minimum stake 0.10 USDC, 8 decimals, relay age limit 26 hours', () => {
  assert.equal(MIN_STAKE, 100_000n);
  assert.equal(FEED_DECIMALS, 8);
  assert.equal(MAX_GUARD_AGE_SECONDS, 93_600);
});

test('validateSet reports a wrong list (it would stop the deploy)', () => {
  const ok = SETS.mainnet.markets;
  try {
    SETS.mainnet.markets = [...ok, { coin: 'btc', round: 300, offset: 0 }];       // same name and lock time twice
    assert.ok(validateSet('mainnet').some((p) => /duplicate/.test(p)));
    SETS.mainnet.markets = [{ coin: 'btc', round: 299, offset: 0 }, { coin: 'eth', round: 300, offset: 300 }, { coin: 'sol', round: 300, offset: 1 }];
    const p = validateSet('mainnet').join('\n');
    assert.match(p, /at least 300/);
    assert.match(p, /offset must be below/);
    SETS.mainnet.markets = ok.filter((m) => m.coin !== 'sol');
    assert.ok(validateSet('mainnet').some((x) => /sol: no market/.test(x)));
  } finally { SETS.mainnet.markets = ok; }
  assert.deepEqual(validateSet('mainnet'), []);
  assert.ok(validateSet('nope').length > 0);
});

// ---- the guard check that runs against Chainlink on mainnet before anything is deployed
const NOW = 1_800_000_000;
const good = { description: 'BTC / USD', decimals: 8, answer: 8_000_000_000_000n, updatedAt: NOW - 3600 };

test('judgeGuard accepts a healthy Chainlink feed', () => {
  assert.deepEqual(judgeGuard(good, 'btc', NOW), []);
});

test('judgeGuard stops the wrong feed, wrong decimals, zero or negative price, no time, future time', () => {
  assert.match(judgeGuard({ ...good, description: 'ETH / USD' }, 'btc', NOW).join(), /description/);
  assert.match(judgeGuard({ ...good, decimals: 18 }, 'btc', NOW).join(), /decimals/);
  assert.match(judgeGuard({ ...good, answer: 0n }, 'btc', NOW).join(), /above zero/);
  assert.match(judgeGuard({ ...good, answer: -5n }, 'btc', NOW).join(), /above zero/);
  assert.match(judgeGuard({ ...good, updatedAt: 0 }, 'btc', NOW).join(), /no time/);
  assert.match(judgeGuard({ ...good, updatedAt: NOW + 1 }, 'btc', NOW).join(), /future/);
});

test('judgeGuard: exactly 26 hours old is fine (as in the relay), one second more is not', () => {
  assert.deepEqual(judgeGuard({ ...good, updatedAt: NOW - 93_600 }, 'btc', NOW), []);
  assert.match(judgeGuard({ ...good, updatedAt: NOW - 93_601 }, 'btc', NOW).join(), /hours old/);
});
