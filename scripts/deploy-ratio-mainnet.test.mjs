// node --test scripts/deploy-ratio-mainnet.test.mjs
// The mainnet ETH vs BTC script: what it refuses, and a whole dry run against a fake chain (no network, no wallet, nothing sent).
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, zeroAddress } from 'viem';
import { parseArgs, ethBtcMarket, onServer, judgeLeg, expectedRatio, costAndNeed, run, PAIR, MIN_NEED_RAW } from './deploy-ratio-mainnet.mjs';
import { UNDERSTAND_FLAG } from './deployFlags.mjs';
import { CHAINLINK_MAINNET, RATIO_LEG_MAX_AGE_SECONDS, ratioGuardDescription, ratioRelayDescription, MIN_STAKE } from './markets.mjs';

const FAKE_KEY = '0x' + 'ab'.repeat(32);

// ---------------------------------------------------------------- refusals on the command line

test('no flag is a dry run; only the long flag sends; --verify-only never sends', () => {
  assert.deepEqual(parseArgs([]), { send: false, verifyOnly: false, error: null });
  assert.deepEqual(parseArgs(['--pair', 'ethbtc']), { send: false, verifyOnly: false, error: null });
  assert.deepEqual(parseArgs(['--pair=ETH/BTC']), { send: false, verifyOnly: false, error: null });
  assert.deepEqual(parseArgs([UNDERSTAND_FLAG]), { send: true, verifyOnly: false, error: null });
  assert.deepEqual(parseArgs(['--verify-only', UNDERSTAND_FLAG]), { send: false, verifyOnly: true, error: null });
});

test('SOL vs BTC is refused, by any spelling', () => {
  for (const v of ['solbtc', 'SOL/BTC', 'sol-btc']) {
    const r = parseArgs(['--pair', v, UNDERSTAND_FLAG]);
    assert.equal(r.send, false);
    assert.match(r.error, /SOL vs BTC is refused on mainnet/);
  }
  assert.match(parseArgs([`--pair=solbtc`]).error, /SOL vs BTC is refused/);
});

test('any other pair, a missing pair value, and any coin/USD name are refused', () => {
  for (const v of ['btcusd', 'ETH/USD', 'ethsol', '']) assert.match(parseArgs(['--pair', v]).error, /Only ETH vs BTC/, v);
  assert.match(parseArgs(['--pair']).error, /Only ETH vs BTC/);
});

test('--send alone, --set, --pusher, --arena, unknown flags and keys on the command line are refused', () => {
  assert.match(parseArgs(['--send']).error, /--send is refused on mainnet/);
  assert.match(parseArgs(['--send', UNDERSTAND_FLAG]).error, /--send is refused/);
  for (const f of ['--set', '--pusher', '--arena', '--owner', '--key']) assert.match(parseArgs([f, 'x']).error, /is not allowed here/, f);
  assert.match(parseArgs(['--yes']).error, /Unknown argument/);
  assert.match(parseArgs(['--i-understand']).error, /Unknown argument/);
  const k = parseArgs([UNDERSTAND_FLAG, FAKE_KEY]);
  assert.equal(k.send, false);
  assert.match(k.error, /looks like a private key/);
  assert.doesNotMatch(k.error, /abab/);
});

test('the ETH vs BTC settings in markets.mjs are the agreed ones', () => {
  const { market, problems } = ethBtcMarket();
  assert.deepEqual(problems, []);
  assert.deepEqual(market, { pair: 'ethbtc', round: 3600, offset: 50 });
});

test('the server is refused', () => {
  assert.equal(onServer('/home/ubuntu/arc-arena'), true);
  assert.equal(onServer('C:\\Users\\Frank\\Desktop\\arc-arena'), false);
});

// ---------------------------------------------------------------- Chainlink leg checks

const NOW = 1_800_000_000;
const leg = (over = {}) => ({ description: 'ETH / USD', decimals: 8, answer: 3_000n * 10n ** 8n, updatedAt: NOW - 600, ...over });

test('a Chainlink leg: right label, 8 decimals, positive, at most 25 h old', () => {
  assert.deepEqual(judgeLeg(leg(), 'eth', NOW), []);
  assert.match(judgeLeg(leg({ description: 'BTC / USD' }), 'eth', NOW)[0], /expected "ETH \/ USD"/);
  assert.match(judgeLeg(leg({ decimals: 18 }), 'eth', NOW)[0], /decimals are 18/);
  assert.match(judgeLeg(leg({ answer: 0n }), 'eth', NOW)[0], /above zero/);
  assert.match(judgeLeg(leg({ updatedAt: NOW + 5 }), 'eth', NOW)[0], /future/);
  assert.deepEqual(judgeLeg(leg({ updatedAt: NOW - RATIO_LEG_MAX_AGE_SECONDS }), 'eth', NOW), []);
  assert.match(judgeLeg(leg({ updatedAt: NOW - RATIO_LEG_MAX_AGE_SECONDS - 1 }), 'eth', NOW)[0], /RatioGuard accepts at most 25/);
});

test('the ratio worked out off chain is the RatioGuard formula', () => {
  assert.equal(expectedRatio(3_000n * 10n ** 8n, 100_000n * 10n ** 8n), 3n * 10n ** 16n); // 0.03
});

test('the owner needs twice the estimate, never under 0.50 USDC', () => {
  const tiny = costAndNeed({ guard: 1_000_000n, relay: 1_500_000n, market: 400_000n }, 20n * 10n ** 9n); // 0.058 USDC
  assert.equal(tiny.costRaw, 58_000n);
  assert.equal(tiny.needRaw, MIN_NEED_RAW);
  const big = costAndNeed({ guard: 1_000_000n, relay: 1_500_000n, market: 500_000n }, 200n * 10n ** 9n); // 0.6 USDC
  assert.equal(big.costRaw, 600_000n);
  assert.equal(big.needRaw, 1_200_000n);
});

// ---------------------------------------------------------------- a whole dry run against a fake chain

const ARENA = getAddress('0xaebac196c76a2c9338a30aef663e4799ffa0d364');
const OWNER = getAddress('0x1AB2ADf11B3B16544C5F76d74c729B4EdCDcb4bC');
const PUSHER = getAddress('0x141043c9f604c8274286Dc0319a2F1c9124CEa3F');
const BTC_RELAY = getAddress('0x15dbb61c92fd8c301a19b769d984491731afab60');
const ETH = getAddress(CHAINLINK_MAINNET.eth.toLowerCase());
const BTC = getAddress(CHAINLINK_MAINNET.btc.toLowerCase());
const contract = { abi: [], bytecode: '0x' + '60'.repeat(100), deployedBytecode: '0x' + '60'.repeat(80) };
const ART = { arena: contract, relay: contract, ratioGuard: contract };

function fakeState() {
  return {
    network: 'arc-mainnet', chainId: 5042, owner: OWNER, pusher: PUSHER, arena: { address: ARENA },
    feeds: { btc: { address: BTC_RELAY } },
    markets: Array.from({ length: 12 }, (_, id) => ({ id, name: `M${id}` })),
  };
}

function fakeIo(over = {}) {
  const lines = [];
  let saved = 0;
  const st = over.state ?? fakeState();
  const legs = {
    [ETH]: { description: 'ETH / USD', answer: 3_000n * 10n ** 8n, updatedAt: NOW - 600 },
    [BTC]: { description: 'BTC / USD', answer: 100_000n * 10n ** 8n, updatedAt: NOW - 60 },
    ...over.legs,
  };
  const reads = {
    [`${ARENA}.owner`]: over.arenaOwner ?? OWNER,
    [`${ARENA}.pendingOwner`]: zeroAddress,
    [`${ARENA}.marketCount`]: BigInt(over.marketCount ?? 12),
    [`${BTC_RELAY}.pusher`]: over.btcRelayPusher ?? PUSHER,
  };
  const io = {
    log: (s) => lines.push(s),
    explorer: 'https://explorer.arc.io',
    art: ART,
    deployer: 'deployer' in over ? over.deployer : OWNER,
    pusher: over.pusher ?? { address: PUSHER, problems: [] },
    state: { load: () => st, save: () => { saved++; } },
    sender: null,
    chain: {
      chainId: over.chainId ?? 5042,
      now: async () => NOW,
      getCode: async (a) => (legs[a] ? '0x6080' : '0x'),
      read: async (a, _abi, fn) => {
        if (legs[a]) {
          const l = legs[a];
          if (fn === 'description') return l.description;
          if (fn === 'decimals') return 8;
          if (fn === 'latestRoundData') return [1n, l.answer, 0n, BigInt(l.updatedAt), 1n];
        }
        const k = `${a}.${fn}`;
        if (k in reads) return reads[k];
        throw new Error(`the dry run read something unexpected: ${k}`);
      },
      gasPrice: async () => 20n * 10n ** 9n,
      estimateDeploy: async () => 1_000_000n,
      balance: async () => over.balance ?? 3_000_000n,
      testnetMarketGas: async () => 300_000n,
    },
  };
  return { io, lines, saves: () => saved, text: () => lines.join('\n') };
}

const dry = { send: false, verifyOnly: false };

test('the dry run prints exactly what it would deploy, with every address and value, and sends and saves nothing', async () => {
  const f = fakeIo();
  const res = await run(dry, f.io);
  assert.equal(res.ok, true);
  assert.deepEqual(res.sent, []);
  assert.equal(f.saves(), 0);
  const t = f.text();
  assert.match(t, /DRY RUN \(nothing is sent\)/);
  assert.match(t, new RegExp(`numerator +${ETH} \\(Chainlink ETH/USD\\), expected label "ETH / USD", at most 90000 s old`));
  assert.match(t, new RegExp(`denominator +${BTC} \\(Chainlink BTC/USD\\), expected label "BTC / USD", at most 90000 s old`));
  assert.ok(t.includes(`"${ratioGuardDescription(PAIR)}", 18 decimals`));
  assert.match(t, new RegExp(`owner +${OWNER}`));
  assert.match(t, new RegExp(`pusher +${PUSHER}`));
  assert.match(t, /band +250 bps \(2\.5%\)/);
  assert.ok(t.includes(`"${ratioRelayDescription(PAIR, 'mainnet')}"`));
  assert.ok(t.includes(`createMarket on the arena ${ARENA}`));
  assert.ok(t.includes(`name "ETH/BTC 1h", feed = the relay from step 2, feedB = none (${zeroAddress}), 3600 s rounds, offset 50 s, min stake ${MIN_STAKE} (0.5 USDC); it becomes market id 12`));
  assert.match(t, /Chainlink ETH\/BTC now: 0\.03/);
  assert.match(t, /The owner needs : at least 0\.5 USDC/);
  assert.match(t, /Owner holds +: 3 USDC +\(enough\)/);
  assert.match(t, /No first ratio is pushed/);
  assert.match(t, /Nothing was sent/);
});

test('the dry run says how much more USDC the owner needs, and never prints a key', async () => {
  const f = fakeIo({ balance: 100_000n });
  await run(dry, f.io);
  assert.match(f.text(), /Owner holds +: 0\.1 USDC +-> send it at least 0\.4 more USDC/);
  assert.doesNotMatch(f.text(), /0x[0-9a-fA-F]{64}/);
});

test('the dry run stops on a bad Chainlink leg before planning anything', async () => {
  for (const [legs, msg] of [
    [{ [ETH]: { description: 'SOL / USD', answer: 1n, updatedAt: NOW } }, /Chainlink ETH\/USD check failed/],
    [{ [BTC]: { description: 'BTC / USD', answer: 1n, updatedAt: NOW - RATIO_LEG_MAX_AGE_SECONDS - 10 } }, /Chainlink BTC\/USD check failed/],
  ]) {
    const f = fakeIo({ legs });
    await assert.rejects(run(dry, f.io), msg);
    assert.doesNotMatch(f.text(), /The plan/);
  }
});

test('the dry run stops on the wrong chain, the wrong owner, the wrong market count or the wrong pusher', async () => {
  await assert.rejects(run(dry, fakeIo({ chainId: 5042002 }).io), /not Arc mainnet/);
  await assert.rejects(run(dry, fakeIo({ arenaOwner: getAddress('0x' + '11'.repeat(20)) }).io), /Only the arena owner can create the market/);
  await assert.rejects(run(dry, fakeIo({ marketCount: 13 }).io), /the arena has 13 markets/);
  await assert.rejects(run(dry, fakeIo({ pusher: { address: getAddress('0x' + '22'.repeat(20)), problems: [] } }).io), /mainnet relays use pusher/);
  await assert.rejects(run(dry, fakeIo({ btcRelayPusher: getAddress('0x' + '33'.repeat(20)) }).io), /BTC relay's pusher on chain/);
  await assert.rejects(run(dry, fakeIo({ pusher: { address: null, problems: ['same key as the deployer'] } }).io), /not usable as the pusher/);
});

test('a deployment file with SOL vs BTC already in it is refused', async () => {
  const st = fakeState();
  st.markets.push({ id: 12, name: 'SOL/BTC 1h', kind: 'ratio', coin: 'solbtc' });
  await assert.rejects(run(dry, fakeIo({ state: st }).io), /other than ETH vs BTC/);
});

test('sending without a wallet, or without the owner key, is refused', async () => {
  await assert.rejects(run({ send: true, verifyOnly: false }, fakeIo().io), /without a wallet/);
  const f = fakeIo({ deployer: null });
  f.io.sender = { deploy: async () => assert.fail('must not send'), write: async () => assert.fail('must not send') };
  await assert.rejects(run({ send: true, verifyOnly: false }, f.io), /MAINNET_DEPLOYER_PRIVATE_KEY is missing/);
});

test('sending stops before any transaction when the owner holds too little USDC', async () => {
  const f = fakeIo({ balance: 100_000n });
  f.io.sender = { deploy: async () => assert.fail('must not send'), write: async () => assert.fail('must not send') };
  await assert.rejects(run({ send: true, verifyOnly: false }, f.io), /needs at least 0\.5\. Fund it first\. Nothing was sent/);
});
