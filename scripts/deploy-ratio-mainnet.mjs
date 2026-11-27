// Matchup: add ETH vs BTC (1-hour rounds) to the EXISTING mainnet arena. ARC MAINNET, ETH vs BTC ONLY.
//
//   node scripts/deploy-ratio-mainnet.mjs                  DRY RUN (default): reads the chain, checks Chainlink, the owner, the pusher,
//                                                          the market count and the owner's USDC, and prints exactly what it would deploy.
//                                                          Sends nothing.
//   node scripts/deploy-ratio-mainnet.mjs --i-understand-this-spends-real-usdc
//                                                          Deploys 1 RatioGuard and 1 relay, creates market "ETH/BTC 1h", then verifies.
//   node scripts/deploy-ratio-mainnet.mjs --verify-only    Re-checks what deployments/arc-mainnet.json says was deployed (reads only).
//
// What it deploys (scripts/markets.mjs, the ethbtc entries of RATIO_PAIRS and RATIO_MARKETS; docs/RATIO_MAINNET_CHECKLIST.md):
//   RatioGuard(Chainlink ETH/USD proxy, Chainlink BTC/USD proxy, 25 h, 25 h, "ETH / USD", "BTC / USD", description)   18 decimals
//   GuardedRelayFeed(arena owner, runner wallet as pusher, that RatioGuard, 250 bps, mainnet description)                unchanged contract
//   createMarket("ETH/BTC 1h", relay, no feedB, 3600 s, offset 50 s, 0.50 USDC)                                         unchanged arena, id 12
//
// Refuses every other pair, SOL vs BTC included (it waits for a better SOL price source). Refuses --send on its own, --set, --pusher,
// --arena, any unknown flag and anything on the command line that looks like a key. The owner key is MAINNET_DEPLOYER_PRIVATE_KEY,
// read from the .env file on this PC only (never from the command line or the shell), never printed, and refused on the server.
// The pusher is the ADDRESS of MAINNET_RUNNER_PRIVATE_KEY and must be the pusher the existing mainnet relays already use.
// It does not push a first ratio: on mainnet the runner pushes only for rounds with calls on both sides.
// Safe to re-run: each finished step is saved to deployments/arc-mainnet.json (under "ratio") and skipped next time.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatUnits, getAddress, isAddress, zeroAddress, encodeDeployData, encodeFunctionData, decodeFunctionResult, createPublicClient, http } from 'viem';
import { UNDERSTAND_FLAG } from './deployFlags.mjs';
import {
  COINS, CHAINLINK_MAINNET, FEED_DECIMALS, MIN_STAKE, RATIO_PAIRS, RATIO_MARKETS, RATIO_DECIMALS, RATIO_LEG_MAX_AGE_SECONDS,
  judgeGuard, ratioBandBps, ratioMarketName, ratioGuardDescription, ratioRelayDescription, ratioGuardArgs,
} from './markets.mjs';

export const PAIR = 'ethbtc';
export const MAINNET_CHAIN_ID = 5042;
export const EXPECTED_MARKET_COUNT = 12; // the twelve coin/USD markets; ETH/BTC 1h becomes id 12
export const MIN_NEED_RAW = 500_000n; // the owner must hold at least 0.50 USDC, or twice the estimate if that is more
const KNOWN_FLAGS = new Set([UNDERSTAND_FLAG, '--verify-only', '--pair']);
const PAIR_ALIASES = { ethbtc: 'ethbtc', 'eth/btc': 'ethbtc', 'eth-btc': 'ethbtc', solbtc: 'solbtc', 'sol/btc': 'solbtc', 'sol-btc': 'solbtc' };

/**
 * The command line, checked. Returns { send, verifyOnly, error }. Pure, so it can be tested.
 * Only ETH vs BTC; only the long flag sends; nothing that could carry a key or change who owns or pushes.
 */
export function parseArgs(args) {
  const out = (error) => ({ send: false, verifyOnly: false, error });
  if (args.some((a) => /0x[0-9a-fA-F]{64}/.test(a))) return out('Something on the command line looks like a private key. Keys are read from .env only; never type one on the command line.');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const [name, inline] = a.startsWith('--') ? a.split('=', 2) : [a, undefined];
    if (name === '--send') return out(`--send is refused on mainnet. Run the dry run first (no flag), and once you have read it, run again with ${UNDERSTAND_FLAG}.`);
    if (name === '--set' || name === '--pusher' || name === '--arena' || name === '--owner' || name === '--key') return out(`${name} is not allowed here: the arena, the owner and the pusher come from deployments/arc-mainnet.json and .env, not the command line.`);
    if (!KNOWN_FLAGS.has(name)) return out(`Unknown argument "${a}". This script takes only --pair ethbtc, --verify-only and ${UNDERSTAND_FLAG}.`);
    if (name === '--pair') {
      const v = inline ?? args[++i];
      const key = PAIR_ALIASES[String(v || '').toLowerCase()];
      if (key === 'solbtc') return out('SOL vs BTC is refused on mainnet: it waits for a better SOL price source (docs/RATIO_MAINNET_CHECKLIST.md, "Later: SOL vs BTC").');
      if (key !== PAIR) return out(`Only ETH vs BTC can be deployed on mainnet (--pair ethbtc), not "${v ?? ''}".`);
    }
  }
  const verifyOnly = args.includes('--verify-only');
  return { send: args.includes(UNDERSTAND_FLAG) && !verifyOnly, verifyOnly, error: null };
}

/** True only for an address written in its EIP-55 checksummed form: a mistyped character, or an unchecked all-lowercase form, is refused. Pure. */
export const isChecksummed = (a) => typeof a === 'string' && isAddress(a, { strict: true }) && a === getAddress(a);

/** The one market this script may create, checked against scripts/markets.mjs. Returns { market, problems }. Pure. */
export function ethBtcMarket(chainlink = CHAINLINK_MAINNET) {
  const problems = [];
  const p = RATIO_PAIRS[PAIR];
  const market = RATIO_MARKETS.find((m) => m.pair === PAIR);
  if (!p || p.top !== 'eth' || p.bottom !== 'btc') problems.push('RATIO_PAIRS.ethbtc is not ETH over BTC');
  if (!market) problems.push('RATIO_MARKETS has no ethbtc market');
  else {
    if (market.round !== 3600) problems.push(`ETH/BTC round is ${market.round} s, expected 3600`);
    if (market.offset !== 50) problems.push(`ETH/BTC offset is ${market.offset} s, expected 50`);
  }
  if (ratioBandBps(PAIR) !== 250) problems.push(`ETH/BTC band is ${ratioBandBps(PAIR)} bps, expected 250`);
  // strict: a mixed-case address must carry a correct EIP-55 checksum, so one mistyped character is caught (audit part 3, F-3)
  for (const c of ['eth', 'btc']) if (!isChecksummed(chainlink[c])) problems.push(`the Chainlink ${c.toUpperCase()}/USD address in scripts/markets.mjs ("${chainlink[c] ?? ''}") is not a valid checksummed address`);
  return { market, problems };
}

/** Is this checkout the server's? The owner key must never be used there (docs/RATIO_MAINNET_CHECKLIST.md). Pure. */
export const onServer = (root) => String(root).replace(/\\/g, '/').startsWith('/home/ubuntu/');

/**
 * One Chainlink leg as a RatioGuard leg: the deploy script's own rules (description, 8 decimals, answer above 0, not in the future,
 * at most 26 h) plus the RatioGuard's tighter 25 h leg limit. feed = { description, decimals, answer, updatedAt }. Pure.
 */
export function judgeLeg(feed, coin, now) {
  const bad = judgeGuard(feed, coin, now);
  if (!bad.length && now - feed.updatedAt > RATIO_LEG_MAX_AGE_SECONDS) bad.push(`latest answer is ${Math.round((now - feed.updatedAt) / 3600)} hours old, the RatioGuard accepts at most ${RATIO_LEG_MAX_AGE_SECONDS / 3600}`);
  return bad;
}

/** ETH/BTC with 18 decimals worked out off chain exactly as RatioGuard._ratio does (both legs 8 decimals). Pure. */
export const expectedRatio = (ethAnswer, btcAnswer) => (ethAnswer * 10n ** BigInt(RATIO_DECIMALS + FEED_DECIMALS)) / (btcAnswer * 10n ** BigInt(FEED_DECIMALS));

/**
 * What the owner must hold. gas = { guard, relay, market } (gas units), gasPrice in wei of the 18-decimal native view.
 * Returns { costWei, costRaw (6 decimals, rounded up), needRaw }: need = twice the estimate, at least 0.50 USDC. Pure.
 */
export function costAndNeed(gas, gasPrice) {
  const costWei = (gas.guard + gas.relay + gas.market) * gasPrice;
  const costRaw = (costWei + 10n ** 12n - 1n) / 10n ** 12n;
  const needRaw = costRaw * 2n > MIN_NEED_RAW ? costRaw * 2n : MIN_NEED_RAW;
  return { costWei, costRaw, needRaw };
}

const usd6 = (raw) => formatUnits(raw, 6);
const short = (e) => String(e?.shortMessage || e?.message || e).slice(0, 160);

/**
 * The whole run. Everything outside the process comes in through `io`, so the tests can drive a dry run with a fake chain:
 *   io.chain   { chainId, now(), getCode(a), read(a, abi, fn, args), gasPrice(), estimateDeploy(c, args, from), balance(a), testnetMarketGas() }
 *   io.sender  null for a dry run; otherwise { deploy(c, args) -> {hash, address, block}, write(a, abi, fn, args) -> {hash, block} }
 *   io.art     compiled contracts (arena, relay, ratioGuard)
 *   io.state   { load(), save(st) } for deployments/arc-mainnet.json
 *   io.deployer the owner wallet's address (from the .env key, or MAINNET_DEPLOYER_ADDRESS in a dry run), or null
 *   io.pusher  { address, problems } from MAINNET_RUNNER_PRIVATE_KEY (runnerKey.mjs mainnetPusher)
 *   io.explorer, io.log
 * Returns { ok, sent: [...] }; a STOP throws an Error whose message starts with "STOP: ".
 */
export async function run(mode, io) {
  const { chain, sender, art, state, log } = io;
  const stop = (msg) => { throw new Error('STOP: ' + msg); };
  const step = (msg) => log('\n== ' + msg);
  const addrUrl = (a) => `${io.explorer}/address/${a}`;
  const txUrl = (h) => `${io.explorer}/tx/${h}`;
  const sent = [];
  if (mode.send && !sender) stop('internal: sending was asked for without a wallet.');

  const { market: M, problems: listProblems } = ethBtcMarket();
  if (listProblems.length) stop('the ETH vs BTC settings in scripts/markets.mjs are wrong:\n  ' + listProblems.join('\n  '));
  const name = ratioMarketName(M);
  if (chain.chainId !== MAINNET_CHAIN_ID) stop(`the RPC is chain ${chain.chainId}, not Arc mainnet (${MAINNET_CHAIN_ID}).`);

  let st = state.load();
  if (!st) stop('deployments/arc-mainnet.json does not exist.');
  if (st.network !== 'arc-mainnet' || st.chainId !== MAINNET_CHAIN_ID) stop('deployments/arc-mainnet.json is not the Arc mainnet deployment.');
  if ((st.markets || []).some((m) => m.kind === 'ratio' && m.coin !== PAIR)) stop('deployments/arc-mainnet.json already lists a coin-vs-coin market other than ETH vs BTC. Stop and look at it.');
  const A = getAddress(st.arena.address);
  const top = getAddress(CHAINLINK_MAINNET.eth);
  const bottom = getAddress(CHAINLINK_MAINNET.btc);
  const read = (address, abi, fn, a = []) => chain.read(address, abi, fn, a);

  if (mode.verifyOnly) return { ok: await verify(io, st, M), sent };

  // ---------- 1. Chainlink ETH/USD and BTC/USD (reads only) ----------
  step('Check Chainlink on Arc mainnet (reads only)');
  // The addresses must be the feeds the live ETH and BTC relays already use as their guard (audit part 3, F-2): a raw aggregator,
  // a secondary proxy or someone else's contract can say "ETH / USD" with 8 decimals too, and every other check reads the same address.
  const refProblems = await liveReferenceProblems(io, st, top, bottom);
  if (refProblems.length) stop('the Chainlink addresses do not match the live mainnet relays:\n  ' + refProblems.join('\n  ') + '\nNothing was sent.');
  log(`  The live ETH and BTC relays use exactly these Chainlink feeds as their guard: ${top}, ${bottom}`);
  const now = await chain.now();
  const legs = {};
  for (const [coin, address] of [['eth', top], ['btc', bottom]]) {
    const code = await chain.getCode(address);
    if (!code || code === '0x') stop(`there is no contract at the Chainlink ${COINS[coin].pair} address ${address}.`);
    const [description, decimals, round] = await Promise.all([
      read(address, art.ratioGuard.abi, 'description'), read(address, art.ratioGuard.abi, 'decimals'), read(address, art.ratioGuard.abi, 'latestRoundData'),
    ]);
    const found = { description, decimals: Number(decimals), answer: round[1], updatedAt: Number(round[3]) };
    const problems = judgeLeg(found, coin, now);
    legs[coin] = found;
    log(`  ${COINS[coin].pair.padEnd(8)} ${address}  "${description}"  ${found.decimals} decimals  ${(Number(found.answer) / 1e8).toLocaleString('en-US')} USD  ${now - found.updatedAt} s old  ${problems.length ? 'FAIL' : 'OK'}`);
    for (const p of problems) log(`    ${p}`);
    if (problems.length) stop(`the Chainlink ${COINS[coin].pair} check failed. Nothing was sent.`);
  }
  log(`  Chainlink ETH/BTC now: ${Number(expectedRatio(legs.eth.answer, legs.btc.answer)) / 1e18}`);

  // ---------- 2. the arena, the owner and the pusher (reads only) ----------
  step('Check the arena, the owner and the pusher (reads only)');
  const arenaOwner = getAddress(await read(A, art.arena.abi, 'owner'));
  const pending = getAddress(await read(A, art.arena.abi, 'pendingOwner'));
  const count = Number(await read(A, art.arena.abi, 'marketCount'));
  const have = (st.markets || []).find((m) => m.name === name);
  log(`  Arena           : ${A} (${count} markets)`);
  log(`  Arena owner     : ${arenaOwner}${pending !== zeroAddress ? `  (a handover to ${pending} is pending)` : ''}`);
  log(`  Owner wallet    : ${io.deployer ?? '(no MAINNET_DEPLOYER_PRIVATE_KEY or MAINNET_DEPLOYER_ADDRESS in .env)'}`);
  if (!io.deployer) { if (mode.send) stop('MAINNET_DEPLOYER_PRIVATE_KEY is missing in .env.'); log('  NOTE: the owner and its USDC cannot be checked without the address.'); }
  else if (getAddress(io.deployer) !== arenaOwner) stop(`the owner wallet in .env is ${io.deployer}, but the arena owner is ${arenaOwner}. Only the arena owner can create the market. If the arena was already handed to a hardware wallet, this script cannot be used as it is: see docs/RATIO_MAINNET_CHECKLIST.md.`);
  if (pending !== zeroAddress) log('  WARNING: an ownership handover is pending on the arena. Finish or cancel it before deploying, so the new relay gets the same owner.');
  const expectedCount = have ? EXPECTED_MARKET_COUNT + 1 : EXPECTED_MARKET_COUNT;
  if (count !== st.markets.length || count !== expectedCount) stop(`the arena has ${count} markets and the file lists ${st.markets.length}; expected ${expectedCount}${have ? ' (ETH/BTC 1h already created)' : ', so the new market gets id 12'}. Check ${addrUrl(A)}.`);

  const filePusher = getAddress(st.pusher);
  const btcRelayPusher = getAddress(await read(getAddress(st.feeds.btc.address), art.relay.abi, 'pusher'));
  if (io.pusher.problems.length) stop(['the runner key is not usable as the pusher:', ...io.pusher.problems.map((p) => '  - ' + p)].join('\n'));
  if (!io.pusher.address) {
    if (mode.send) stop('MAINNET_RUNNER_PRIVATE_KEY is missing in .env: the pusher must be its address.');
    log(`  Pusher          : ${filePusher} (from the deployment file; MAINNET_RUNNER_PRIVATE_KEY is not in .env, so it is not checked against the key)`);
  } else if (getAddress(io.pusher.address) !== filePusher) stop(`the runner key's address is ${io.pusher.address}, but the mainnet relays use pusher ${filePusher}.`);
  if (btcRelayPusher !== filePusher) stop(`the BTC relay's pusher on chain is ${btcRelayPusher}, not ${filePusher} as the file says. Check before going on.`);
  if (io.deployer && getAddress(io.deployer) === filePusher) stop('the pusher is the owner wallet. The runner must have its own wallet.');
  const pusher = filePusher;
  log(`  Pusher          : ${pusher} (the runner wallet; the BTC relay on chain agrees)`);

  // ---------- 3. what it would deploy ----------
  st.ratio ||= { guards: {}, feeds: {} };
  st.ratio.guards ||= {}; st.ratio.feeds ||= {};
  const gArgs = ratioGuardArgs(PAIR, top, bottom, 'mainnet');
  const doneGuard = st.ratio.guards[PAIR];
  const doneRelay = st.ratio.feeds[PAIR];
  const relayArgs = (guard) => [arenaOwner, pusher, guard, ratioBandBps(PAIR), ratioRelayDescription(PAIR, 'mainnet')];

  // A guard or relay saved by an earlier run (or a hand edit) is checked in full BEFORE anything builds on it, in the dry run
  // too: the market's feed can never be changed once createMarket is sent (audit part 3, F-1).
  if (have && (!doneGuard || !doneRelay)) stop(`the file lists market ${name} but no RatioGuard or relay for it. Repair deployments/arc-mainnet.json first.`);
  if (doneRelay && !doneGuard) stop('the file has an ETH/BTC relay but no RatioGuard. Repair deployments/arc-mainnet.json first.');
  if (doneGuard) {
    const bad = failures(await checkGuard(io, getAddress(doneGuard.address)));
    if (bad.length) stop(`the saved RatioGuard ${doneGuard.address} is not what this script deploys:\n  ${bad.join('\n  ')}\nNothing was sent.`);
    log(`  Saved RatioGuard ${getAddress(doneGuard.address)}: every check passed.`);
  }
  if (doneRelay) {
    const bad = failures(await checkRelay(io, getAddress(doneRelay.address), getAddress(doneGuard.address), arenaOwner, pusher));
    if (bad.length) stop(`the saved relay ${doneRelay.address} is not what this script deploys:\n  ${bad.join('\n  ')}\nNothing was sent.`);
    log(`  Saved relay ${getAddress(doneRelay.address)}: every check passed.`);
  }
  step(mode.send ? 'The plan (sending now)' : `DRY RUN (nothing is sent). The plan, exactly. Add ${UNDERSTAND_FLAG} to send it.`);
  log(doneGuard ? `  1. RatioGuard: already deployed at ${doneGuard.address}` : [
    '  1. Deploy RatioGuard',
    `       numerator     ${top} (Chainlink ETH/USD), expected label "${gArgs[4]}", at most ${gArgs[2]} s old`,
    `       denominator   ${bottom} (Chainlink BTC/USD), expected label "${gArgs[5]}", at most ${gArgs[3]} s old`,
    `       description   "${gArgs[6]}", ${RATIO_DECIMALS} decimals`,
  ].join('\n'));
  log(doneRelay ? `  2. Relay: already deployed at ${doneRelay.address}` : [
    '  2. Deploy GuardedRelayFeed',
    `       owner         ${arenaOwner}`,
    `       pusher        ${pusher}`,
    `       guard         ${doneGuard ? doneGuard.address : 'the RatioGuard from step 1'}`,
    `       band          ${ratioBandBps(PAIR)} bps (${ratioBandBps(PAIR) / 100}%)`,
    `       description   "${ratioRelayDescription(PAIR, 'mainnet')}"`,
  ].join('\n'));
  log(have ? `  3. Market: already market id ${have.id}` : [
    `  3. createMarket on the arena ${A}`,
    `       name "${name}", feed = the relay from step 2, feedB = none (${zeroAddress}), ${M.round} s rounds, offset ${M.offset} s, min stake ${MIN_STAKE} (${usd6(MIN_STAKE)} USDC); it becomes market id ${count}`,
  ].join('\n'));
  log('  4. Verify everything on chain. No first ratio is pushed: the runner pushes only for rounds with calls on both sides.');

  // ---------- 3b. the RatioGuard constructor, simulated on mainnet (eth_call: nothing is sent) ----------
  // A constructor that would revert (WrongFeed, BadMaxAge, TooManyDecimals, ...) must stop the dry run, not turn into a gas guess
  // (audit part 3, F-4). The simulated guard's own answer is then compared with Chainlink ETH / BTC worked out here.
  const from = io.deployer ?? arenaOwner;
  if (!doneGuard) {
    step('Simulate the RatioGuard constructor on Arc mainnet (eth_call, nothing is sent)');
    let runtime;
    try { runtime = await chain.simulateDeploy(art.ratioGuard, gArgs, from); }
    catch (e) { stop(`the RatioGuard constructor would revert on mainnet (${short(e)}). Nothing was sent.`); }
    if (!runtime || runtime === '0x') stop('the simulated RatioGuard constructor returned no code. Nothing was sent.');
    log('  The constructor accepts these feeds, labels and age limits.');
    let match = false;
    for (let i = 0; i < 2 && !match; i++) {
      let answer;
      try { answer = (await chain.callCode(runtime, art.ratioGuard.abi, 'latestRoundData'))[1]; }
      catch (e) { stop(`the simulated RatioGuard refuses to answer (${short(e)}). Nothing was sent.`); }
      const [e, b] = await Promise.all([read(top, art.ratioGuard.abi, 'latestRoundData'), read(bottom, art.ratioGuard.abi, 'latestRoundData')]);
      const want = expectedRatio(e[1], b[1]);
      match = answer === want;
      log(`  The simulated guard answers ${Number(answer) / 1e18}; Chainlink ETH / BTC worked out here: ${Number(want) / 1e18} ${match ? 'OK' : '(differs, reading again)'}`);
    }
    if (!match) stop('the simulated RatioGuard does not give Chainlink ETH / BTC. Nothing was sent.');
  }

  // ---------- 4. cost and the owner's USDC ----------
  step('Cost and the owner wallet\'s USDC');
  const gasPrice = await chain.gasPrice();
  const guessDeploy = (c) => 53_000n + 200n * BigInt((c.deployedBytecode.length - 2) / 2) + 16n * BigInt((c.bytecode.length - 2) / 2);
  // no silent guess for the guard: its constructor was simulated above, so a failed estimate means something is wrong (F-4)
  const g = doneGuard ? 0n : await chain.estimateDeploy(art.ratioGuard, gArgs, from);
  if (g === null) stop('the node could not estimate the RatioGuard deployment although its simulation passed. Look at the RPC before going on. Nothing was sent.');
  // the relay's constructor reads its guard, so it can only be estimated (and so checked) once the guard exists
  let r = 0n;
  if (!doneRelay && doneGuard) {
    r = await chain.estimateDeploy(art.relay, relayArgs(getAddress(doneGuard.address)), from);
    if (r === null) stop('the relay constructor would revert on mainnet (its gas estimate failed). Nothing was sent.');
  } else if (!doneRelay) r = guessDeploy(art.relay);
  const mk = have ? 0n : (await chain.testnetMarketGas()) ?? 400_000n;
  const { costWei, needRaw } = costAndNeed({ guard: g, relay: r, market: mk }, gasPrice);
  log(`  Gas price       : ${formatUnits(gasPrice, 9)} gwei`);
  log(`  Gas             : RatioGuard ${g}, relay ${r}, createMarket ${mk} (the relay and the market are estimates from code size and the testnet ETH/BTC market)`);
  log(`  Estimated cost  : about ${Number(formatUnits(costWei, 18)).toFixed(6)} USDC`);
  log(`  The owner needs : at least ${usd6(needRaw)} USDC (twice the estimate, never under ${usd6(MIN_NEED_RAW)})`);
  if (io.deployer) {
    const bal = await chain.balance(io.deployer);
    log(`  Owner holds     : ${usd6(bal)} USDC${bal < needRaw ? `  -> send it at least ${usd6(needRaw - bal)} more USDC before the real run` : '  (enough)'}`);
    if (mode.send && bal < needRaw) stop(`the owner holds ${usd6(bal)} USDC and needs at least ${usd6(needRaw)}. Fund it first. Nothing was sent.`);
  }
  if (!mode.send) { log(`\nDry run done. Nothing was sent. To deploy: node scripts/deploy-ratio-mainnet.mjs ${UNDERSTAND_FLAG}`); return { ok: true, sent }; }

  // ---------- 5. send ----------
  const send = async (what, p) => {
    step(what);
    const res = await p;
    sent.push(what);
    log(`  ${txUrl(res.hash)}`);
    return res;
  };
  if (!doneGuard) {
    const res = await send('Deploy RatioGuard ETH/BTC', sender.deploy(art.ratioGuard, gArgs));
    st.ratio.guards[PAIR] = { address: res.address, tx: res.hash, block: res.block, top, bottom };
    state.save(st);
    log(`  ${res.address}`);
  }
  // the guard must give exactly Chainlink ETH / Chainlink BTC, worked out off chain (read twice if a leg updated in between)
  const G = getAddress(st.ratio.guards[PAIR].address);
  let match = false;
  for (let i = 0; i < 2 && !match; i++) {
    const [gr, e, b] = await Promise.all([read(G, art.ratioGuard.abi, 'latestRoundData'), read(top, art.ratioGuard.abi, 'latestRoundData'), read(bottom, art.ratioGuard.abi, 'latestRoundData')]);
    const want = expectedRatio(e[1], b[1]);
    match = gr[1] === want;
    log(`  RatioGuard answers ${Number(gr[1]) / 1e18}; Chainlink ETH / BTC worked out here: ${Number(want) / 1e18} ${match ? 'OK' : '(differs, reading again)'}`);
  }
  if (!match) stop(`the RatioGuard ${G} does not give Chainlink ETH / BTC. Do not go on; nothing uses it yet.`);

  if (!st.ratio.feeds[PAIR]) {
    const res = await send('Deploy relay feed ETH/BTC', sender.deploy(art.relay, relayArgs(G)));
    st.ratio.feeds[PAIR] = { address: res.address, tx: res.hash, block: res.block };
    state.save(st);
    log(`  ${res.address}`);
  }
  if (!st.markets.some((m) => m.name === name)) {
    const id = Number(await read(A, art.arena.abi, 'marketCount'));
    if (id !== EXPECTED_MARKET_COUNT || id !== st.markets.length) stop(`the arena now has ${id} markets (the file lists ${st.markets.length}); stopping before creating ${name}.`);
    const feed = getAddress(st.ratio.feeds[PAIR].address);
    // last look before the one step that cannot be undone (this also covers a relay deployed in this same run)
    const bad = [...failures(await checkGuard(io, G)), ...failures(await checkRelay(io, feed, G, arenaOwner, pusher))];
    if (bad.length) stop(`the guard or relay is not what this script deploys; the market was NOT created:\n  ${bad.join('\n  ')}`);
    const res = await send(`Create market ${name}`, sender.write(A, art.arena.abi, 'createMarket', [name, feed, zeroAddress, M.round, M.offset, MIN_STAKE]));
    st.markets.push({ id, name, coin: PAIR, kind: 'ratio', round: M.round, offset: M.offset, feed, minStake: Number(MIN_STAKE), tx: res.hash, block: res.block });
    state.save(st);
    log(`  market id ${id}`);
  }
  st.ratio.deployedAt ||= new Date(now * 1000).toISOString();
  state.save(st);
  const ok = await verify(io, state.load(), M);
  log('\nSaved to deployments/arc-mainnet.json. Next: node scripts/deploy.mjs --set mainnet --verify-only, then the "Deploy day" steps in docs/RATIO_MAINNET_CHECKLIST.md.');
  return { ok, sent };
}

/**
 * Reads only. The Chainlink addresses (top = ETH/USD, bottom = BTC/USD) against an independent reference that is already on chain:
 * the guard() of the live mainnet ETH and BTC relays, the guards listed in deployments/arc-mainnet.json, and the ETH relay's pusher.
 * Returns the problems (empty = all match). A read that fails counts as a problem.
 */
export async function liveReferenceProblems(io, st, top, bottom) {
  const read = (address, abi, fn) => io.chain.read(address, abi, fn, []);
  const bad = [];
  const want = { eth: top, btc: bottom };
  for (const c of ['eth', 'btc']) {
    const relay = st.feeds?.[c]?.address;
    if (!relay) { bad.push(`deployments/arc-mainnet.json lists no ${c.toUpperCase()} relay`); continue; }
    try {
      const g = getAddress(await read(getAddress(relay), io.art.relay.abi, 'guard'));
      if (g !== want[c]) bad.push(`scripts/markets.mjs has ${want[c]} for Chainlink ${COINS[c].pair}, but the live ${c.toUpperCase()} relay ${getAddress(relay)} uses ${g}`);
    } catch (e) { bad.push(`could not read guard() of the ${c.toUpperCase()} relay ${relay} (${short(e)})`); }
    const listed = st.guards?.[c]?.address;
    if (!listed || getAddress(listed) !== want[c]) bad.push(`deployments/arc-mainnet.json lists ${listed ?? 'nothing'} as the ${c.toUpperCase()} guard, not ${want[c]}`);
  }
  if (st.feeds?.eth?.address) {
    try {
      const p = getAddress(await read(getAddress(st.feeds.eth.address), io.art.relay.abi, 'pusher'));
      if (p !== getAddress(st.pusher)) bad.push(`the ETH relay's pusher on chain is ${p}, not ${getAddress(st.pusher)} as the file says`);
    } catch (e) { bad.push(`could not read pusher() of the ETH relay (${short(e)})`); }
  }
  return bad;
}

/** The code at `address` is `c` from the repo (immutables blanked when io.normalise is given). */
async function sameCode(io, address, c) {
  const code = await io.chain.getCode(address);
  return !!code && code !== '0x' && (io.normalise ? io.normalise(code, c.immutableReferences) === io.normalise(c.deployedBytecode, c.immutableReferences) : code === c.deployedBytecode);
}

/** Runs each [what, test] in turn; a test that throws (a missing function, an older contract, no contract) is a failure, not a crash. */
async function runChecks(list) {
  const out = [];
  for (const [what, fn] of list) {
    try { out.push({ ok: !!(await fn()), what }); } catch (e) { out.push({ ok: false, what: `${what} (the read failed: ${short(e)})` }); }
  }
  return out;
}

/** Reads only: is the contract at G exactly the RatioGuard this script deploys? Returns [{ ok, what }] (audit part 3, F-1). */
export async function checkGuard(io, G) {
  const read = (fn) => io.chain.read(G, io.art.ratioGuard.abi, fn, []);
  return runChecks([
    ['guard: top is Chainlink ETH/USD', async () => getAddress(await read('numerator')) === getAddress(CHAINLINK_MAINNET.eth)],
    ['guard: bottom is Chainlink BTC/USD', async () => getAddress(await read('denominator')) === getAddress(CHAINLINK_MAINNET.btc)],
    [`guard has ${RATIO_DECIMALS} decimals`, async () => Number(await read('decimals')) === RATIO_DECIMALS],
    [`guard says "${ratioGuardDescription(PAIR)}"`, async () => (await read('description')) === ratioGuardDescription(PAIR)],
    [`guard: each leg at most ${RATIO_LEG_MAX_AGE_SECONDS / 3600} h old`, async () => Number(await read('numeratorMaxAge')) === RATIO_LEG_MAX_AGE_SECONDS && Number(await read('denominatorMaxAge')) === RATIO_LEG_MAX_AGE_SECONDS],
    ['guard is version 2', async () => Number(await read('version')) === 2],
    ['guard code on chain matches the repo', () => sameCode(io, G, io.art.ratioGuard)],
    ['guard answers a ratio above 0', async () => (await read('latestRoundData'))[1] > 0n],
  ]);
}

/** Reads only: is the contract at R exactly the relay this script deploys, on guard G? Returns [{ ok, what }] (audit part 3, F-1). */
export async function checkRelay(io, R, G, owner, pusher) {
  const read = (fn) => io.chain.read(R, io.art.relay.abi, fn, []);
  return runChecks([
    [`relay is owned by the arena owner ${owner}`, async () => getAddress(await read('owner')) === owner],
    [`relay pusher is ${pusher}`, async () => getAddress(await read('pusher')) === pusher],
    [`relay guard is the RatioGuard ${G}`, async () => getAddress(await read('guard')) === G],
    [`relay band is ${ratioBandBps(PAIR)} bps`, async () => Number(await read('bandBps')) === ratioBandBps(PAIR)],
    [`relay has ${RATIO_DECIMALS} decimals`, async () => Number(await read('decimals')) === RATIO_DECIMALS],
    [`relay says "${ratioRelayDescription(PAIR, 'mainnet')}"`, async () => (await read('description')) === ratioRelayDescription(PAIR, 'mainnet')],
    ['relay code on chain matches the repo', () => sameCode(io, R, io.art.relay)],
  ]);
}

const failures = (results) => results.filter((r) => !r.ok).map((r) => r.what);

/** Reads only: everything about the ETH vs BTC guard, relay and market matches what this script deploys. Returns true when all pass. */
async function verify(io, st, M) {
  const { chain, art, log } = io;
  const read = (address, abi, fn, a = []) => chain.read(address, abi, fn, a);
  log('\n== Verify on chain (reads only)');
  if (!st.ratio?.guards?.[PAIR] || !st.ratio?.feeds?.[PAIR]) throw new Error('STOP: deployments/arc-mainnet.json has no ETH vs BTC deployment yet.');
  let bad = 0;
  const check = (ok, what) => { log(`  ${ok ? 'OK  ' : 'FAIL'} ${what}`); if (!ok) bad++; };
  const A = getAddress(st.arena.address);
  const G = getAddress(st.ratio.guards[PAIR].address);
  const R = getAddress(st.ratio.feeds[PAIR].address);
  const owner = getAddress(await read(A, art.arena.abi, 'owner'));
  const name = ratioMarketName(M);
  check(Number(await read(A, art.arena.abi, 'marketCount')) === st.markets.length, `the arena has the ${st.markets.length} markets the file lists`);
  const ref = await liveReferenceProblems(io, st, getAddress(CHAINLINK_MAINNET.eth), getAddress(CHAINLINK_MAINNET.btc));
  for (const p of ref) check(false, p);
  if (!ref.length) check(true, 'the Chainlink feeds are the ones the live ETH and BTC relays use');
  for (const r of await checkGuard(io, G)) check(r.ok, r.what);
  for (const r of await checkRelay(io, R, G, owner, getAddress(st.pusher))) check(r.ok, r.what);
  const rec = st.markets.find((x) => x.name === name);
  if (!rec) check(false, `market ${name} is in the file`);
  else {
    const mk = await read(A, art.arena.abi, 'markets', [BigInt(rec.id)]);
    check(rec.id === EXPECTED_MARKET_COUNT, `market ${name} is id ${EXPECTED_MARKET_COUNT}`);
    check((await read(A, art.arena.abi, 'marketName', [BigInt(rec.id)])) === name, `market ${rec.id} is named ${name}`);
    check(getAddress(mk[0]) === R, `market ${rec.id} reads the ETH/BTC relay`);
    check(getAddress(mk[1]) === zeroAddress, `market ${rec.id} has no second feed`);
    check(Number(mk[2]) === M.round && Number(mk[3]) === M.offset && mk[4] === MIN_STAKE && mk[5] === false, `market ${rec.id}: 1-hour rounds, offset ${M.offset} s, min stake ${usd6(MIN_STAKE)} USDC, not paused`);
  }
  if (bad) { log(`\n${bad} check(s) failed. Do not use this market until they are understood (pause it: setMarketPaused(${rec?.id ?? 12}, true)).`); return false; }
  log('\nAll checks passed.');
  return true;
}

// ---------------------------------------------------------------- the real entry (not run by the tests)
async function main() {
  const fail = (msg) => { console.error('\n' + (msg.startsWith('STOP: ') ? msg : 'STOP: ' + msg)); process.exit(1); };
  const mode = parseArgs(process.argv.slice(2));
  if (mode.error) fail(mode.error);
  const { ROOT, setup, usdcBalance, NETWORKS, arcChain } = await import('./lib.mjs');
  if (onServer(ROOT)) fail('this is the server. The owner key must never be on the server; run this script on your PC.');
  const { compile, normalise } = await import('./compile.mjs');
  const { mainnetPusher } = await import('./runnerKey.mjs');

  let c;
  try { c = setup('mainnet', { needKey: mode.send }); } catch (e) { fail(e.message); }
  const { env, pub, wallet, account, chain, usdc, hasKey } = c;
  const deployer = hasKey ? getAddress(account.address) : env.MAINNET_DEPLOYER_ADDRESS ? getAddress(env.MAINNET_DEPLOYER_ADDRESS) : null;
  const agents = [];
  try { for (const a of JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', 'circle-mainnet.json'), 'utf8')).agents || []) agents.push([`the ${a.name || a.key} agent wallet`, a.address]); } catch { /* none */ }
  const pusher = env.MAINNET_RUNNER_PRIVATE_KEY || mode.send ? mainnetPusher(env, deployer ? [['the owner wallet', deployer], ...agents] : agents) : { address: null, problems: [] };

  const STATE_FILE = path.join(ROOT, 'deployments', 'arc-mainnet.json');
  const io = {
    log: (s) => console.log(s),
    explorer: chain.blockExplorers.default.url,
    art: compile(),
    normalise,
    deployer,
    pusher,
    state: {
      load: () => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null),
      save: (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n'),
    },
    chain: {
      chainId: await pub.getChainId(),
      now: async () => Number((await pub.getBlock()).timestamp),
      getCode: (address) => pub.getCode({ address }),
      read: (address, abi, functionName, args) => pub.readContract({ address, abi, functionName, args }),
      gasPrice: () => pub.getGasPrice(),
      estimateDeploy: async (ct, args, from) => { try { return await pub.estimateGas({ account: from, data: encodeDeployData({ abi: ct.abi, bytecode: ct.bytecode, args }) }); } catch { return null; } },
      // eth_call of the deployment: returns the code the constructor would leave behind, or throws with the revert reason
      simulateDeploy: async (ct, args, from) => (await pub.call({ account: from, data: encodeDeployData({ abi: ct.abi, bytecode: ct.bytecode, args }) })).data,
      // a read against code that is not deployed: the code is placed at a spare address for this one eth_call only
      callCode: async (code, abi, functionName) => {
        const at = '0x00000000000000000000000000000000000c0de1';
        const res = await pub.call({ to: at, data: encodeFunctionData({ abi, functionName }), stateOverride: [{ address: at, code }] });
        return decodeFunctionResult({ abi, functionName, data: res.data });
      },
      balance: async (who) => (await usdcBalance(pub, usdc, who)).raw,
      // the gas of the testnet ETH/BTC createMarket, the same call on the same contract (deployments/arc-testnet.json)
      testnetMarketGas: async () => {
        try {
          const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', 'arc-testnet.json'), 'utf8')).markets.find((m) => m.kind === 'ratio' && m.coin === PAIR);
          const net = NETWORKS.testnet; const rpc = env.ARC_TESTNET_RPC_URL || net.rpc;
          const rc = await createPublicClient({ chain: arcChain(net, rpc), transport: http(rpc) }).getTransactionReceipt({ hash: t.tx });
          return rc.gasUsed + rc.gasUsed / 5n; // 20% room
        } catch { return null; }
      },
    },
    sender: mode.send ? {
      deploy: async (ct, args) => {
        const hash = await wallet.deployContract({ abi: ct.abi, bytecode: ct.bytecode, args });
        const rc = await pub.waitForTransactionReceipt({ hash });
        if (rc.status !== 'success') throw new Error(`STOP: the deployment reverted: ${chain.blockExplorers.default.url}/tx/${hash}`);
        return { hash, address: getAddress(rc.contractAddress), block: Number(rc.blockNumber) };
      },
      write: async (address, abi, functionName, args) => {
        const hash = await wallet.writeContract({ address, abi, functionName, args });
        const rc = await pub.waitForTransactionReceipt({ hash });
        if (rc.status !== 'success') throw new Error(`STOP: ${functionName} reverted: ${chain.blockExplorers.default.url}/tx/${hash}`);
        return { hash, block: Number(rc.blockNumber) };
      },
    } : null,
  };
  console.log(`Arc mainnet, ETH vs BTC only. ${mode.send ? 'REAL RUN: this spends real USDC.' : mode.verifyOnly ? 'Verify only (reads).' : 'Dry run (reads only).'}`);
  const res = await run(mode, io);
  if (!res.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { const m = String(e?.shortMessage || e?.message || e); console.error('\n' + (m.startsWith('STOP: ') ? m : 'ERROR: ' + m)); process.exit(1); });
}
