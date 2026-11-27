// node --test scripts/deploy-ratio-mainnet.test.mjs
// The mainnet ETH vs BTC script: what it refuses, and a whole dry run against a fake chain (no network, no wallet, nothing sent).
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, zeroAddress } from 'viem';
import { parseArgs, ethBtcMarket, isChecksummed, onServer, judgeLeg, expectedRatio, costAndNeed, run, PAIR, MIN_NEED_RAW } from './deploy-ratio-mainnet.mjs';
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
const ETH_RELAY = getAddress('0xdbb8d2106f1e45aa5287b666a4c8841bead356c0');
const ETH = getAddress(CHAINLINK_MAINNET.eth);
const BTC = getAddress(CHAINLINK_MAINNET.btc);
const contract = (b) => ({ abi: [], bytecode: '0x' + b.repeat(100), deployedBytecode: '0x' + b.repeat(80) });
const ART = { arena: contract('60'), relay: contract('61'), ratioGuard: contract('62') };
const GUARD = getAddress('0x' + '9a'.repeat(20));
const RELAY = getAddress('0x' + '9b'.repeat(20));
const RATIO = 3n * 10n ** 16n; // 3000 / 100000: the fake Chainlink legs below

/** What a correct RatioGuard answers (any read can be overridden). */
const guardReads = (over = {}) => ({
  numerator: ETH, denominator: BTC, decimals: 18, description: ratioGuardDescription(PAIR),
  numeratorMaxAge: RATIO_LEG_MAX_AGE_SECONDS, denominatorMaxAge: RATIO_LEG_MAX_AGE_SECONDS, version: 2n,
  latestRoundData: [0n, RATIO, 0n, BigInt(NOW - 600), 0n], ...over,
});
/** What a correct ETH/BTC relay on guard G answers. */
const relayReads = (G, over = {}) => ({
  owner: OWNER, pusher: PUSHER, guard: G, bandBps: 250, decimals: 18, description: ratioRelayDescription(PAIR, 'mainnet'), ...over,
});

function fakeState() {
  return {
    network: 'arc-mainnet', chainId: 5042, owner: OWNER, pusher: PUSHER, arena: { address: ARENA },
    feeds: { btc: { address: BTC_RELAY }, eth: { address: ETH_RELAY } },
    guards: { btc: { address: BTC, kind: 'Chainlink proxy' }, eth: { address: ETH, kind: 'Chainlink proxy' } },
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
    [`${ARENA}.marketCount`]: () => BigInt(over.marketCount ?? st.markets.length),
    [`${BTC_RELAY}.pusher`]: over.btcRelayPusher ?? PUSHER,
    [`${ETH_RELAY}.pusher`]: over.ethRelayPusher ?? PUSHER,
    [`${BTC_RELAY}.guard`]: over.btcRelayGuard ?? BTC,
    [`${ETH_RELAY}.guard`]: over.ethRelayGuard ?? ETH,
  };
  // contracts the fake chain knows besides Chainlink: address -> { code, reads }. A sender may add to it.
  const contracts = { ...over.contracts };
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
      getCode: async (a) => (legs[a] ? '0x6080' : contracts[a]?.code ?? '0x'),
      read: async (a, _abi, fn, args = []) => {
        if (legs[a]) {
          const l = legs[a];
          if (fn === 'description') return l.description;
          if (fn === 'decimals') return 8;
          if (fn === 'latestRoundData') return [1n, l.answer, 0n, BigInt(l.updatedAt), 1n];
        }
        if (contracts[a]) {
          const v = contracts[a].reads[fn];
          if (v === undefined) throw new Error(`execution reverted: ${fn}() is not on this contract`);
          return typeof v === 'function' ? v(...args) : v;
        }
        const k = `${a}.${fn}`;
        if (typeof reads[k] === 'function') return reads[k](...args);
        if (k in reads) return reads[k];
        throw new Error(`the dry run read something unexpected: ${k}`);
      },
      gasPrice: async () => 20n * 10n ** 9n,
      estimateDeploy: async (c) => (over.estimate ? over.estimate(c) : 1_000_000n),
      // the RatioGuard constructor simulated with eth_call: its runtime code, or a throw when it would revert
      simulateDeploy: async (c, args) => { if (over.simulateDeploy) return over.simulateDeploy(c, args); return c.deployedBytecode; },
      // a read against that simulated code
      callCode: async (code, _abi, fn) => {
        if (over.callCode) return over.callCode(code, fn);
        if (code === ART.ratioGuard.deployedBytecode && fn === 'latestRoundData') return guardReads().latestRoundData;
        throw new Error(`execution reverted: ${fn}() on unknown code`);
      },
      balance: async () => over.balance ?? 3_000_000n,
      testnetMarketGas: async () => 300_000n,
    },
  };
  return { io, lines, contracts, reads, saves: () => saved, text: () => lines.join('\n') };
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

test('F-3: the Chainlink constants must be written checksummed; a mistyped character is refused', () => {
  assert.equal(isChecksummed(CHAINLINK_MAINNET.eth), true);
  assert.equal(isChecksummed(CHAINLINK_MAINNET.btc), true);
  const typo = CHAINLINK_MAINNET.eth.slice(0, -1) + (CHAINLINK_MAINNET.eth.endsWith('4') ? '5' : '4'); // last hex digit changed, same case
  for (const bad of [typo, CHAINLINK_MAINNET.eth.toLowerCase(), '', undefined, '0x1234']) assert.equal(isChecksummed(bad), false, String(bad));
  const { problems } = ethBtcMarket({ eth: typo, btc: CHAINLINK_MAINNET.btc });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Chainlink ETH\/USD address .* is not a valid checksummed address/);
  assert.match(ethBtcMarket({ eth: CHAINLINK_MAINNET.eth, btc: CHAINLINK_MAINNET.btc.toLowerCase() }).problems[0], /BTC\/USD address/);
});

test('F-2: the Chainlink addresses must be the feeds the live ETH and BTC relays use; anything else stops the run before any leg is read', async () => {
  const other = getAddress('0x' + '44'.repeat(20));
  for (const [over, msg] of [
    [{ ethRelayGuard: other }, /has 0x50FCDD99D6762D1C170DC6A9111db944AEE6D364 for Chainlink ETH\/USD, but the live ETH relay .* uses 0x4444/],
    [{ btcRelayGuard: other }, /for Chainlink BTC\/USD, but the live BTC relay .* uses 0x4444/],
    [{ ethRelayPusher: other }, /the ETH relay's pusher on chain is 0x4444/],
  ]) {
    const f = fakeIo(over);
    await assert.rejects(run(dry, f.io), msg);
    assert.doesNotMatch(f.text(), /ETH\/USD +0x/, 'no leg was read');
  }
  const st = fakeState();
  st.guards.eth.address = other;
  await assert.rejects(run(dry, fakeIo({ state: st }).io), /lists 0x4444.* as the ETH guard/);
  const noEth = fakeState();
  delete noEth.feeds.eth;
  await assert.rejects(run(dry, fakeIo({ state: noEth }).io), /lists no ETH relay/);
  const ok = fakeIo();
  await run(dry, ok.io);
  assert.match(ok.text(), /The live ETH and BTC relays use exactly these Chainlink feeds/);
});

// ---------------------------------------------------------------- F-1: a saved guard or relay is checked before anything builds on it

/** A state whose earlier run saved a guard and (optionally) a relay, and the chain contracts that go with it. */
function savedRun({ relay = true, guardOver = {}, relayOver = {} } = {}) {
  const st = fakeState();
  st.ratio = { guards: { ethbtc: { address: GUARD } }, feeds: relay ? { ethbtc: { address: RELAY } } : {} };
  const contracts = { [GUARD]: { code: ART.ratioGuard.deployedBytecode, reads: guardReads(guardOver) } };
  if (relay) contracts[RELAY] = { code: ART.relay.deployedBytecode, reads: relayReads(GUARD, relayOver) };
  return { state: st, contracts };
}
/** A sender that must never be used. */
const forbiddenSender = () => {
  const calls = [];
  return { calls, deploy: async (...a) => { calls.push(['deploy', ...a]); throw new Error('must not deploy'); }, write: async (...a) => { calls.push(['write', ...a]); throw new Error('must not write'); } };
};
const send = { send: true, verifyOnly: false };

test('F-1: a correct saved guard and relay pass every check in the dry run and are not deployed again', async () => {
  const f = fakeIo(savedRun());
  const res = await run(dry, f.io);
  assert.equal(res.ok, true);
  assert.ok(f.text().includes(`Saved RatioGuard ${GUARD}: every check passed`));
  assert.ok(f.text().includes(`Saved relay ${RELAY}: every check passed`));
  assert.ok(f.text().includes(`1. RatioGuard: already deployed at ${GUARD}`));
  assert.match(f.text(), /RatioGuard 0, relay 0, createMarket 300000/);
});

test('F-1: a saved relay with the wrong pusher, band, guard, owner or code stops the dry run and the real run; nothing is sent', async () => {
  const other = getAddress('0x' + '55'.repeat(20));
  const cases = [
    [savedRun({ relayOver: { pusher: other } }), `relay pusher is ${PUSHER}`],
    [savedRun({ relayOver: { bandBps: 1000 } }), 'relay band is 250 bps'],
    [savedRun({ relayOver: { guard: other } }), `relay guard is the RatioGuard ${GUARD}`],
    [savedRun({ relayOver: { owner: other } }), `relay is owned by the arena owner ${OWNER}`],
    [(() => { const r = savedRun(); r.contracts[RELAY].code = '0x' + '99'.repeat(80); return r; })(), 'relay code on chain matches the repo'],
  ];
  for (const [setup, failing] of cases) {
    for (const mode of [dry, send]) {
      const f = fakeIo(setup);
      const sender = forbiddenSender();
      if (mode.send) f.io.sender = sender;
      await assert.rejects(run(mode, f.io), (e) => e.message.includes(`the saved relay ${RELAY} is not what this script deploys`) && e.message.includes(failing) && e.message.includes('Nothing was sent'));
      assert.deepEqual(sender.calls, [], failing);
      assert.equal(f.saves(), 0);
    }
  }
});

test('F-1: a saved guard that is version 1, has the wrong age limit, the wrong legs or another version stops the run', async () => {
  const { numeratorMaxAge, denominatorMaxAge, ...v1 } = guardReads({ version: 1n }); // version 1 has no age limits at all
  const v1Run = savedRun({ relay: false });
  v1Run.contracts[GUARD].reads = v1;
  for (const [setup, failing] of [
    [v1Run, 'each leg at most 25 h old (the read failed'],
    [savedRun({ relay: false, guardOver: { denominatorMaxAge: 26 * 3600 } }), 'each leg at most 25 h old'],
    [savedRun({ relay: false, guardOver: { numerator: BTC, denominator: ETH } }), 'guard: top is Chainlink ETH/USD'],
    [savedRun({ relay: false, guardOver: { version: 3n } }), 'guard is version 2'],
    [savedRun({ relay: false, guardOver: { description: 'Matchup ratio guard SOL / BTC' } }), 'guard says'],
  ]) {
    const f = fakeIo(setup);
    await assert.rejects(run(dry, f.io), (e) => e.message.includes(`the saved RatioGuard ${GUARD} is not what this script deploys`) && e.message.includes(failing));
    assert.doesNotMatch(f.text(), /The plan/);
  }
});

test('F-1: an inconsistent file (market but no guard, relay but no guard) stops the run', async () => {
  const st = fakeState();
  st.markets.push({ id: 12, name: 'ETH/BTC 1h', kind: 'ratio', coin: 'ethbtc' });
  await assert.rejects(run(dry, fakeIo({ state: st }).io), /lists market ETH\/BTC 1h but no RatioGuard or relay/);
  const st2 = fakeState();
  st2.ratio = { guards: {}, feeds: { ethbtc: { address: RELAY } } };
  await assert.rejects(run(dry, fakeIo({ state: st2 }).io), /an ETH\/BTC relay but no RatioGuard/);
});

// ---------------------------------------------------------------- F-4: the dry run reports a RatioGuard constructor that would fail

test('F-4: the dry run simulates the RatioGuard constructor with the exact arguments and checks its answer', async () => {
  let simulated;
  const f = fakeIo({ simulateDeploy: (c, args) => { simulated = { c, args }; return c.deployedBytecode; } });
  await run(dry, f.io);
  assert.equal(simulated.c, ART.ratioGuard);
  assert.deepEqual(simulated.args, [ETH, BTC, RATIO_LEG_MAX_AGE_SECONDS, RATIO_LEG_MAX_AGE_SECONDS, 'ETH / USD', 'BTC / USD', ratioGuardDescription(PAIR)]);
  assert.match(f.text(), /The constructor accepts these feeds, labels and age limits/);
  assert.match(f.text(), /The simulated guard answers 0\.03; Chainlink ETH \/ BTC worked out here: 0\.03 OK/);
});

test('F-4: a constructor that would revert, a guard that will not answer or answers wrong, or a failed estimate stops the dry run', async () => {
  for (const [over, msg] of [
    [{ simulateDeploy: () => { throw new Error('execution reverted: WrongFeed(0x50FC..., "ETH / USD", "BTC / USD")'); } }, /RatioGuard constructor would revert on mainnet \(execution reverted: WrongFeed/],
    [{ simulateDeploy: () => '0x' }, /returned no code/],
    [{ callCode: () => { throw new Error('execution reverted: StaleFeed'); } }, /simulated RatioGuard refuses to answer \(execution reverted: StaleFeed/],
    [{ callCode: () => [0n, RATIO + 1n, 0n, 0n, 0n] }, /simulated RatioGuard does not give Chainlink ETH \/ BTC/],
    [{ estimate: (c) => (c === ART.ratioGuard ? null : 1_000_000n) }, /could not estimate the RatioGuard deployment although its simulation passed/],
  ]) {
    const f = fakeIo(over);
    await assert.rejects(run(dry, f.io), (e) => msg.test(e.message) && /Nothing was sent/.test(e.message));
    assert.doesNotMatch(f.text(), /Dry run done/);
  }
});

test('F-4: with a saved guard, the relay constructor is estimated on it, and a failed estimate stops the dry run', async () => {
  const setup = savedRun({ relay: false });
  await assert.rejects(run(dry, fakeIo({ ...setup, estimate: (c) => (c === ART.relay ? null : 1_000_000n) }).io), /the relay constructor would revert on mainnet/);
  const ok = fakeIo(setup);
  await run(dry, ok.io);
  assert.match(ok.text(), /RatioGuard 0, relay 1000000, createMarket 300000/);
  assert.doesNotMatch(ok.text(), /Simulate the RatioGuard constructor/);
});
