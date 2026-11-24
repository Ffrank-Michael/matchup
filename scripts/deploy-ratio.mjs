// Matchup: add the coin-vs-coin markets (ETH vs BTC, SOL vs BTC, 1-hour rounds) to the EXISTING testnet arena. ARC TESTNET ONLY.
//
//   node scripts/deploy-ratio.mjs                  DRY RUN (default): reads deployments/arc-testnet.json and the chain, checks, prints the plan. Sends nothing.
//   node scripts/deploy-ratio.mjs --send           Deploys 2 RatioGuards and 2 relays, creates 2 markets, pushes one first ratio to each relay, then verifies.
//   node scripts/deploy-ratio.mjs --verify-only    Re-checks what deployments/arc-testnet.json says was deployed.
//
// What it deploys, per pair (scripts/markets.mjs, RATIO_PAIRS and RATIO_MARKETS):
//   RatioGuard(top stand-in, bottom stand-in)   e.g. the testnet "Chainlink stand-ins" of ETH/USD and BTC/USD, 18 decimals
//   GuardedRelayFeed(owner, pusher, that RatioGuard, 250 bps, "Matchup relay ETH / BTC (TESTNET REHEARSAL): ...")   unchanged contract
//   createMarket("ETH/BTC 1h", relay, no feedB, 3600 s, offset 50 s, 0.50 USDC)                                       unchanged arena
// The owner and the pusher are the ones the testnet deployment already uses. Nothing about the existing markets changes.
//
// There is no mainnet mode on purpose: a mainnet run needs its own review first (docs/RATIO_MAINNET_CHECKLIST.md). The script stops if
// the RPC is not Arc testnet. Safe to re-run: every finished step is saved to deployments/arc-testnet.json and skipped next time.
// The key is DEPLOYER_PRIVATE_KEY from .env (never printed).
import fs from 'node:fs';
import path from 'node:path';
import { formatUnits, getAddress, zeroAddress } from 'viem';
import { setup, ROOT, usdcBalance } from './lib.mjs';
import { compile, normalise } from './compile.mjs';
import { MIN_STAKE, MAX_GUARD_AGE_SECONDS, standInDescription, RATIO_PAIRS, RATIO_MARKETS, RATIO_DECIMALS, ratioBandBps, ratioMarketName, ratioGuardDescription, ratioRelayDescription, validateRatioMarkets, ratioGuardArgs, RATIO_LEG_MAX_AGE_SECONDS } from './markets.mjs';
import { createExchangePrices } from '../runner/exchangePrices.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
function fail(msg) { console.error('\nSTOP: ' + msg); process.exit(1); }
function step(msg) { console.log('\n== ' + msg); }

if (flag('--set') || flag('--i-understand-this-spends-real-usdc')) fail('deploy-ratio.mjs is for the Arc TESTNET only. The mainnet steps are in docs/RATIO_MAINNET_CHECKLIST.md.');
const SEND = flag('--send');
const VERIFY_ONLY = flag('--verify-only');
const TESTNET_CHAIN_ID = 5042002;
const STATE_FILE = path.join(ROOT, 'deployments', 'arc-testnet.json');
const PAIR_KEYS = RATIO_MARKETS.map((m) => m.pair);

const { pub, wallet, account, chain, usdc, hasKey } = setup('testnet', { needKey: SEND });
const explorer = chain.blockExplorers.default.url;
const txUrl = (h) => `${explorer}/tx/${h}`;
const addrUrl = (a) => `${explorer}/address/${a}`;
const read = (address, abi, functionName, a = []) => pub.readContract({ address, abi, functionName, args: a });
const loadState = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
const isRatio = (m) => m.kind === 'ratio';

async function main() {
  if ((await pub.getChainId()) !== TESTNET_CHAIN_ID) fail(`the RPC is not Arc testnet (${TESTNET_CHAIN_ID}).`);
  if (!fs.existsSync(STATE_FILE)) fail('deployments/arc-testnet.json does not exist: deploy the testnet arena first (node scripts/deploy.mjs --set rehearsal --send).');
  const art = compile();
  let st = loadState();
  if (st.network !== 'arc-testnet' || st.chainId !== TESTNET_CHAIN_ID) fail('deployments/arc-testnet.json is not a testnet deployment.');
  const owner = getAddress(st.owner);
  const pusher = getAddress(st.pusher || st.owner);
  const A = st.arena.address;

  // the existing arena must be what the file says, and the stand-ins must be stand-ins (a testnet Chainlink guard we fill)
  const coins = [...new Set(PAIR_KEYS.flatMap((k) => [RATIO_PAIRS[k].top, RATIO_PAIRS[k].bottom]))];
  for (const c of coins) {
    const g = st.guards?.[c];
    if (!g || g.kind !== 'test stand-in') fail(`deployments/arc-testnet.json has no test stand-in for ${c.toUpperCase()}.`);
  }
  const count = Number(await read(A, art.arena.abi, 'marketCount'));
  if (count !== st.markets.length) fail(`the arena has ${count} markets but the file lists ${st.markets.length}. Check ${addrUrl(A)} before going on.`);
  const problems = validateRatioMarkets(st.markets.filter((m) => !isRatio(m)));
  if (problems.length) fail('the coin-vs-coin list is wrong:\n  ' + problems.join('\n  '));

  console.log(`Arc testnet. Arena ${A} (${count} markets). Owner ${owner}, pusher ${pusher}.`);
  console.log(`Deployer        : ${hasKey ? account.address : '(no key in .env: dry run only)'}`);
  if (hasKey) console.log(`USDC balance    : ${(await usdcBalance(pub, usdc, account.address)).text} USDC (testnet)`);

  if (VERIFY_ONLY) { await verify(art, st); return; }

  if (!SEND) {
    step('DRY RUN (nothing is sent). Add --send to deploy on the testnet.');
    for (const k of PAIR_KEYS) {
      const p = RATIO_PAIRS[k];
      const done = st.ratio?.feeds?.[k];
      console.log(`  ${p.pair}: ${done ? `already deployed (relay ${done.address})` : `RatioGuard(${p.top.toUpperCase()} stand-in ${st.guards[p.top].address}, ${p.bottom.toUpperCase()} stand-in ${st.guards[p.bottom].address}) "${ratioGuardDescription(k)}"`}`);
      if (!done) console.log(`    relay: "${ratioRelayDescription(k, st.set)}", band ${ratioBandBps(k)} bps, ${RATIO_DECIMALS} decimals, pusher ${pusher}`);
    }
    for (const m of RATIO_MARKETS) {
      const have = st.markets.find((x) => x.name === ratioMarketName(m));
      console.log(`  market "${ratioMarketName(m)}": ${have ? `already market id ${have.id}` : `round ${m.round}s, offset ${m.offset}s, min stake ${MIN_STAKE} (0.50 USDC), feed = the ${RATIO_PAIRS[m.pair].pair} relay, feedB = none`}`);
    }
    console.log('  then: refresh the stand-ins with Bitfinex prices and push one first ratio to each relay, then verify everything on chain.');
    return;
  }

  if (!hasKey) fail('--send needs DEPLOYER_PRIVATE_KEY in .env.');
  if (getAddress(account.address) !== owner) fail(`the key in .env is ${account.address}, but the arena owner is ${owner}: only the owner can create markets.`);

  const send = async (what, p) => {
    step(what);
    const hash = await p;
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') fail(`${what} reverted: ${txUrl(hash)}`);
    console.log(`  ${txUrl(hash)}`);
    return { hash, rc };
  };
  st.ratio ||= { guards: {}, feeds: {} };

  // 1. RatioGuards
  for (const k of PAIR_KEYS) {
    if (st.ratio.guards[k]) continue;
    const p = RATIO_PAIRS[k];
    const { hash, rc } = await send(`Deploy RatioGuard ${p.pair}`, wallet.deployContract({ abi: art.ratioGuard.abi, bytecode: art.ratioGuard.bytecode, args: ratioGuardArgs(k, st.guards[p.top].address, st.guards[p.bottom].address, st.set) }));
    st.ratio.guards[k] = { address: rc.contractAddress, tx: hash, block: Number(rc.blockNumber), top: st.guards[p.top].address, bottom: st.guards[p.bottom].address };
    saveState(st);
    console.log(`  ${rc.contractAddress}`);
  }

  // 2. relays (the unchanged GuardedRelayFeed, with the RatioGuard as its guard)
  for (const k of PAIR_KEYS) {
    if (st.ratio.feeds[k]) continue;
    const { hash, rc } = await send(`Deploy relay feed ${RATIO_PAIRS[k].pair}`, wallet.deployContract({ abi: art.relay.abi, bytecode: art.relay.bytecode, args: [owner, pusher, st.ratio.guards[k].address, ratioBandBps(k), ratioRelayDescription(k, st.set)] }));
    st.ratio.feeds[k] = { address: rc.contractAddress, tx: hash, block: Number(rc.blockNumber) };
    saveState(st);
    console.log(`  ${rc.contractAddress}`);
  }

  // 3. markets, appended after the existing ones (their ids follow on)
  for (const m of RATIO_MARKETS) {
    const name = ratioMarketName(m);
    if (st.markets.some((x) => x.name === name)) continue;
    const id = Number(await read(A, art.arena.abi, 'marketCount'));
    if (id !== st.markets.length) fail(`the arena has ${id} markets but the file lists ${st.markets.length}; stopping before creating ${name}.`);
    const feed = st.ratio.feeds[m.pair].address;
    const { hash, rc } = await send(`Create market ${name}`, wallet.writeContract({ address: A, abi: art.arena.abi, functionName: 'createMarket', args: [name, feed, zeroAddress, m.round, m.offset, MIN_STAKE] }));
    st.markets.push({ id, name, coin: m.pair, kind: 'ratio', round: m.round, offset: m.offset, feed, minStake: Number(MIN_STAKE), tx: hash, block: Number(rc.blockNumber) });
    saveState(st);
    console.log(`  market id ${id}`);
  }

  // 4. one first ratio per relay, the way the runner pushes it: both stand-ins get their own coin's Bitfinex price, then the relay
  //    gets the ratio (runner/wallets.mjs). This proves the whole chain of checks on the testnet, and it is harmless: a round's
  //    start price is the first update AFTER its lock, so this push decides nothing.
  const prices = createExchangePrices();
  for (const k of PAIR_KEYS) {
    if (st.ratio.feeds[k].firstPush) continue;
    const q = await prices.quote(`${RATIO_PAIRS[k].pair} 1h`);
    for (const l of q.legs) {
      const coin = l.pair.slice(0, 3).toLowerCase();
      await send(`Stand-in ${l.pair} ← ${l.usd} (Bitfinex last trade)`, wallet.writeContract({ address: st.guards[coin].address, abi: art.feed.abi, functionName: 'setPrice', args: [BigInt(l.price)] }));
    }
    const { hash } = await send(`First ratio for ${RATIO_PAIRS[k].pair}: ${q.usd} (${q.legs.map((l) => `${l.pair} ${l.usd}`).join(' / ')})`, wallet.writeContract({ address: st.ratio.feeds[k].address, abi: art.relay.abi, functionName: 'setPrice', args: [q.price] }));
    st.ratio.feeds[k].firstPush = hash;
    saveState(st);
    await new Promise((r) => setTimeout(r, 5200)); // Bitfinex: one request per 5 seconds per coin, and both pairs use BTC
  }

  st.ratio.deployedAt ||= new Date().toISOString();
  saveState(st);
  await verify(art, loadState());
  console.log('\nSaved to deployments/arc-testnet.json. Next: node scripts/sync-web-deployment.mjs (the site picks up the two markets),');
  console.log('then a runner with the coin-vs-coin code (node runner/run.mjs) pushes their prices and settles them.');
}

async function verify(art, st) {
  step('Verify on chain (reads only)');
  let bad = 0;
  const check = (ok, what) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${what}`); if (!ok) bad++; };
  const sameCode = async (address, c) => {
    const onchain = await pub.getCode({ address });
    return !!onchain && normalise(onchain, c.immutableReferences) === normalise(c.deployedBytecode, c.immutableReferences);
  };
  const owner = getAddress(st.owner);
  const pusher = getAddress(st.pusher || st.owner);
  const A = st.arena.address;
  if (!st.ratio) fail('deployments/arc-testnet.json has no coin-vs-coin deployment yet.');
  check(Number(await read(A, art.arena.abi, 'marketCount')) === st.markets.length, `the arena has the ${st.markets.length} markets the file lists`);
  for (const k of PAIR_KEYS) {
    const p = RATIO_PAIRS[k];
    const G = st.ratio.guards[k].address;
    const R = st.ratio.feeds[k].address;
    check(getAddress(await read(G, art.ratioGuard.abi, 'numerator')) === getAddress(st.guards[p.top].address), `${p.pair} guard: top is the ${p.top.toUpperCase()} stand-in`);
    check(getAddress(await read(G, art.ratioGuard.abi, 'denominator')) === getAddress(st.guards[p.bottom].address), `${p.pair} guard: bottom is the ${p.bottom.toUpperCase()} stand-in`);
    check(Number(await read(G, art.ratioGuard.abi, 'decimals')) === RATIO_DECIMALS, `${p.pair} guard has ${RATIO_DECIMALS} decimals`);
    check((await read(G, art.ratioGuard.abi, 'description')) === ratioGuardDescription(k), `${p.pair} guard says "${ratioGuardDescription(k)}"`);
    check(await sameCode(G, art.ratioGuard), `${p.pair} guard code on chain matches the repo`);
    try { // a RatioGuard deployed before the audit fixes (version 1) has no age limits: it must be redeployed
      const ages = await Promise.all([read(G, art.ratioGuard.abi, 'numeratorMaxAge'), read(G, art.ratioGuard.abi, 'denominatorMaxAge')]);
      check(ages.every((x) => Number(x) === RATIO_LEG_MAX_AGE_SECONDS), `${p.pair} guard: each leg at most ${RATIO_LEG_MAX_AGE_SECONDS / 3600} h old`);
    } catch { check(false, `${p.pair} guard has per-leg age limits (a RatioGuard version 1 does not: redeploy it)`); }
    for (const c of [p.top, p.bottom]) check((await read(st.guards[c].address, art.feed.abi, 'description')) === standInDescription(c), `${c.toUpperCase()} stand-in is labelled "${standInDescription(c)}"`);
    try {
      const [, answer, , updatedAt] = await read(G, art.ratioGuard.abi, 'latestRoundData');
      const now = Number((await pub.getBlock()).timestamp);
      check(answer > 0n && now - Number(updatedAt) <= MAX_GUARD_AGE_SECONDS, `${p.pair} guard answers ${Number(answer) / 1e18} (updated ${now - Number(updatedAt)} s ago; the relay accepts up to 26 h)`);
    } catch (e) { check(false, `${p.pair} guard answers (${String(e.shortMessage || e.message).slice(0, 80)})`); }
    check(getAddress(await read(R, art.relay.abi, 'owner')) === owner, `${p.pair} relay is owned by ${owner}`);
    check(getAddress(await read(R, art.relay.abi, 'pusher')) === pusher, `${p.pair} relay pusher is ${pusher}`);
    check(getAddress(await read(R, art.relay.abi, 'guard')) === getAddress(G), `${p.pair} relay guard is its RatioGuard`);
    check(Number(await read(R, art.relay.abi, 'bandBps')) === ratioBandBps(k), `${p.pair} relay band is ${ratioBandBps(k)} bps`);
    check(Number(await read(R, art.relay.abi, 'decimals')) === RATIO_DECIMALS, `${p.pair} relay has ${RATIO_DECIMALS} decimals`);
    check((await read(R, art.relay.abi, 'description')) === ratioRelayDescription(k, st.set), `${p.pair} relay says "${ratioRelayDescription(k, st.set)}"`);
    check(await sameCode(R, art.relay), `${p.pair} relay code on chain matches the repo`);
    try {
      const [, answer] = await read(R, art.relay.abi, 'latestRoundData');
      check(answer > 0n, `${p.pair} relay holds a ratio: ${Number(answer) / 1e18}`);
    } catch { check(false, `${p.pair} relay has a first ratio`); }
  }
  for (const m of RATIO_MARKETS) {
    const name = ratioMarketName(m);
    const rec = st.markets.find((x) => x.name === name);
    if (!rec) { check(false, `market ${name} exists in the file`); continue; }
    const mk = await read(A, art.arena.abi, 'markets', [BigInt(rec.id)]);
    check((await read(A, art.arena.abi, 'marketName', [BigInt(rec.id)])) === name, `market ${rec.id} is named ${name}`);
    check(getAddress(mk[0]) === getAddress(st.ratio.feeds[m.pair].address), `market ${rec.id} reads the ${RATIO_PAIRS[m.pair].pair} relay`);
    check(getAddress(mk[1]) === zeroAddress, `market ${rec.id} has no second feed`);
    check(Number(mk[2]) === m.round && Number(mk[3]) === m.offset && mk[4] === MIN_STAKE && mk[5] === false, `market ${rec.id}: 1-hour rounds, offset ${m.offset} s, min stake ${formatUnits(mk[4], 6)} USDC, not paused`);
  }
  if (bad) fail(`${bad} check(s) failed. Do not use these markets until they are understood.`);
  console.log('\nAll checks passed.');
}

main().catch((e) => { console.error('\nERROR: ' + (e.shortMessage || e.message)); process.exit(1); });
