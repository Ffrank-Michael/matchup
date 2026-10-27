// Kairo Markets: deploy the twelve markets (BTC, ETH and SOL at 5, 10 and 30 minutes and 1 hour) with one guarded relay feed per coin.
//
//   node scripts/deploy.mjs --set rehearsal                  DRY RUN on Arc TESTNET (default). Compiles, checks, estimates. Sends nothing.
//   node scripts/deploy.mjs --set rehearsal --send           Deploys 3 test stand-ins for Chainlink, the arena, 3 relays, 12 markets, then verifies.
//   node scripts/deploy.mjs --set mainnet                    DRY RUN on Arc MAINNET: reads Chainlink on chain and checks it. Sends nothing.
//   node scripts/deploy.mjs --set mainnet --send --i-understand-this-spends-real-usdc
//                                                            Real deployment on Arc MAINNET (real USDC for gas).
//   node scripts/deploy.mjs --set X --verify-only            Re-check the addresses saved in deployments/arc-<testnet|mainnet>.json.
//   node scripts/deploy.mjs --set X --send --arena 0x..      The arena was already deployed elsewhere (for example by Arc Studio): use it.
//   node scripts/deploy.mjs --set X --send --pusher 0x..     TESTNET only: the address allowed to push prices (default: the deployer wallet).
//
// On MAINNET the pusher is always the address of RUNNER_PRIVATE_KEY in .env: the runner's own wallet, separate from the deployer
// (the owner) and from any wallet people play with. The script derives only the ADDRESS from that key, never prints the key, and
// stops if the key is missing or the address is also the deployer, the final owner or a house agent. --pusher is refused on mainnet.
// Settling needs no special right (anyone may settle), so the runner's wallet settles with the same key.
//
// Safe to re-run: every finished step is saved to the deployment file and skipped next time.
// The owner is the deployer wallet. Keys are read from .env (DEPLOYER_PRIVATE_KEY on testnet, MAINNET_DEPLOYER_PRIVATE_KEY on
// mainnet) and never printed. Market lists, bands and Chainlink addresses live in scripts/markets.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { formatUnits, getAddress, isAddress, zeroAddress, encodeDeployData } from 'viem';
import { setup, ROOT, usdcBalance } from './lib.mjs';
import { compile, normalise } from './compile.mjs';
import { SETS, COINS, CHAINLINK_MAINNET, MIN_STAKE, FEED_DECIMALS, MAX_GUARD_AGE_SECONDS, marketName, relayDescription, standInDescription, validateSet, judgeGuard } from './markets.mjs';
import { createExchangePrices } from '../runner/exchangePrices.mjs';
import { mainnetPusher } from './runnerKey.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
function fail(msg) { console.error('\nSTOP: ' + msg); process.exit(1); }
function step(msg) { console.log('\n== ' + msg); }

const SEND = flag('--send');
const VERIFY_ONLY = flag('--verify-only');
const SET_NAME = opt('--set') || 'rehearsal';
const SET = SETS[SET_NAME];
if (!SET) fail(`--set must be one of: ${Object.keys(SETS).join(', ')}`);
const problems = validateSet(SET_NAME);
if (problems.length) fail('the market list is wrong:\n  ' + problems.join('\n  '));
const MAINNET = SET.network === 'mainnet';
if (MAINNET && SEND && !flag('--i-understand-this-spends-real-usdc')) {
  fail('Mainnet spends real USDC. Add --i-understand-this-spends-real-usdc to --send once you have read the dry run.');
}

if (MAINNET && opt('--pusher')) fail('--pusher is not allowed on mainnet. The pusher is always the address of RUNNER_PRIVATE_KEY in .env.');

const COIN_KEYS = Object.keys(COINS);
const STATE_FILE = path.join(ROOT, 'deployments', MAINNET ? 'arc-mainnet.json' : 'arc-testnet.json');
const loadState = () => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null);
const saveState = (s) => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
};

const { env, pub, wallet, account, chain, usdc, hasKey } = setup(SET.network, { needKey: SEND });
const explorer = chain.blockExplorers.default.url;

/** The relay's pusher. Mainnet: the runner's own wallet (RUNNER_PRIVATE_KEY), checked against every wallet it must not be. Testnet: --pusher or the deployer. */
function choosePusher(owner) {
  if (!MAINNET) return opt('--pusher') ? getAddress(opt('--pusher')) : owner;
  const agents = [];
  try {
    for (const a of JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', 'circle-mainnet.json'), 'utf8')).agents || []) agents.push([`the ${a.name || a.key} agent wallet`, a.address]);
  } catch { /* no mainnet agent wallets yet */ }
  const { address, problems } = mainnetPusher(env, [['the deployer / owner wallet', owner], ...agents]);
  if (problems.length) fail(['the runner key is not usable as the mainnet pusher:', ...problems.map((p) => '  - ' + p)].join('\n'));
  return address;
}
const addrUrl = (a) => `${explorer}/address/${a}`;
const txUrl = (h) => `${explorer}/tx/${h}`;
const deployData = (c, a) => encodeDeployData({ abi: c.abi, bytecode: c.bytecode, args: a });
const sizeOf = (c) => (c.deployedBytecode.length - 2) / 2;
// Rough deploy gas when the node cannot estimate (a relay needs its guard to exist first): 32k + 200 per byte of code + calldata.
const guessDeployGas = (c) => 53_000n + 200n * BigInt(sizeOf(c)) + 16n * BigInt((c.bytecode.length - 2) / 2);

const guardAbi = [
  { type: 'function', name: 'description', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
];

/** Reads Chainlink's proxy for a coin on mainnet and returns the problems (empty = a fit guard). */
async function readGuardProblems(coin, address) {
  const now = Number((await pub.getBlock()).timestamp);
  const [description, decimals, round] = await Promise.all([
    pub.readContract({ address, abi: guardAbi, functionName: 'description' }),
    pub.readContract({ address, abi: guardAbi, functionName: 'decimals' }),
    pub.readContract({ address, abi: guardAbi, functionName: 'latestRoundData' }),
  ]);
  const found = { description, decimals, answer: round[1], updatedAt: Number(round[3]) };
  return { found, problems: judgeGuard(found, coin, now), ageHours: ((now - found.updatedAt) / 3600).toFixed(1) };
}

async function main() {
  const id = await pub.getChainId();
  if (id !== chain.id) fail(`RPC reports chain ${id}; this set runs on ${chain.name} (${chain.id}).`);

  const art = compile();
  const arenaSize = sizeOf(art.arena);
  console.log(`Set "${SET_NAME}" on ${chain.name}. Compiled with solc 0.8.28. PredictionArena runtime size: ${arenaSize} bytes (limit 24576); relay ${sizeOf(art.relay)} bytes.`);
  if (arenaSize > 24576) fail('PredictionArena is over the 24576-byte contract size limit.');

  const owner = account.address;
  const bal = await usdcBalance(pub, usdc, owner);
  console.log(`Deployer / owner : ${owner}${hasKey ? '' : '  (no key in .env: read-only dry run with a placeholder address)'}`);
  console.log(`USDC balance     : ${hasKey ? bal.text + ' USDC' : 'not shown (no key)'}`);
  console.log(`USDC token       : ${usdc}`);

  if (VERIFY_ONLY) {
    const st = loadState();
    if (!st) fail(`No ${path.basename(STATE_FILE)} yet.`);
    await verify(art, st);
    return;
  }

  // ---------- guards (mainnet: Chainlink must be what we think it is, before anything is sent) ----------
  if (MAINNET) {
    step('Check Chainlink on Arc mainnet (reads only)');
    let bad = 0;
    for (const coin of COIN_KEYS) {
      const { found, problems: p, ageHours } = await readGuardProblems(coin, getAddress(CHAINLINK_MAINNET[coin].toLowerCase()));
      console.log(`  ${p.length ? 'FAIL' : 'OK  '} ${COINS[coin].pair} proxy ${CHAINLINK_MAINNET[coin]}: "${found.description}", ${found.decimals} decimals, answer ${(Number(found.answer) / 1e8).toLocaleString('en-US')} USD, ${ageHours} h old`);
      for (const x of p) console.log(`         - ${x}`);
      bad += p.length;
    }
    if (bad) fail('Chainlink does not look right on Arc mainnet. Nothing was deployed.');
  }

  // ---------- dry run ----------
  if (!SEND) {
    step('DRY RUN (nothing is sent). Add --send to deploy for real.');
    const gasPrice = await pub.getGasPrice();
    const est = async (c, a) => { try { return { gas: await pub.estimateGas({ account: owner, data: deployData(c, a) }), how: 'node estimate' }; } catch { return { gas: guessDeployGas(c), how: 'guess from code size' }; } };
    const arenaE = await est(art.arena, [usdc, owner]);
    const feedE = await est(art.feed, [owner, FEED_DECIMALS, standInDescription('btc')]);
    const relayGas = guessDeployGas(art.relay);
    const MARKET_GAS = 400_000n;
    const seeds = MAINNET ? 0n : 3n * (feedE.gas + 90_000n);
    const totalGas = arenaE.gas + 3n * relayGas + BigInt(SET.markets.length) * MARKET_GAS + seeds;
    const cost = totalGas * gasPrice;
    console.log(`Gas price        : ${formatUnits(gasPrice, 9)} gwei`);
    console.log(`Estimated gas    : arena ${arenaE.gas} (${arenaE.how}), 3 relays ${relayGas} each (guess from code size), ${SET.markets.length} createMarket ${MARKET_GAS} each (guess)${MAINNET ? '' : `, 3 test stand-ins ${feedE.gas} each plus a first price`}`);
    console.log(`Estimated cost   : about ${formatUnits(cost, 18)} USDC (native 18-decimal view of the same USDC)`);
    if (!hasKey) console.log('Balance not checked (no key in .env).');
    else if (bal.raw * 10n ** 12n < cost * 2n) console.log('WARNING: balance is less than twice the estimate. Fund the wallet before --send.');
    else console.log('Balance covers the estimate with room to spare.');
    console.log('\nPlan on --send:');
    for (const coin of COIN_KEYS) {
      console.log(MAINNET
        ? `  guard ${COINS[coin].pair}: Chainlink proxy ${CHAINLINK_MAINNET[coin]} (nothing deployed)`
        : `  guard ${COINS[coin].pair}: new MockPriceFeed "${standInDescription(coin)}" (owner ${owner}), first price from Bitfinex`);
    }
    console.log(`  arena PredictionArena(usdc ${usdc}, owner ${owner})${opt('--arena') ? ` -> already deployed at ${opt('--arena')}, used as it is` : ''}`);
    for (const coin of COIN_KEYS) console.log(`  relay ${COINS[coin].pair}: "${relayDescription(coin, SET_NAME)}", band ${COINS[coin].bandBps} bps, pusher ${choosePusher(owner)}${MAINNET ? ' (the address of RUNNER_PRIVATE_KEY)' : ''}`);
    for (const m of SET.markets) console.log(`  market "${marketName(m)}": round ${m.round}s, offset ${m.offset}s, min stake ${MIN_STAKE} (0.50 USDC), feed = the ${m.coin.toUpperCase()} relay, feedB = none`);
    return;
  }

  // ---------- real deployment ----------
  if (!hasKey) fail('--send needs the deployer key in .env.');
  const pusher = choosePusher(owner);
  if (MAINNET) {
    const runnerBal = await usdcBalance(pub, usdc, pusher);
    console.log(`Runner wallet     : ${pusher} (pusher, holds ${runnerBal.text} USDC for its gas)`);
    if (runnerBal.raw < 500_000n) console.log('NOTE: the runner wallet holds under 0.50 USDC. Fund it before the runner starts; pushes and settles cost gas.');
  }
  let st = loadState() || { network: MAINNET ? 'arc-mainnet' : 'arc-testnet', set: SET_NAME, chainId: chain.id, usdc, owner, pusher, guards: {}, feeds: {}, arena: null, markets: [] };
  if (getAddress(st.owner) !== getAddress(owner)) fail(`${path.basename(STATE_FILE)} belongs to a different owner wallet.`);
  if (getAddress(st.pusher || owner) !== pusher) fail('This deployment already uses a different pusher address.');
  if (MAINNET) {
    const need = 2n * 10n ** 6n; // 2 USDC
    if (bal.raw < need) fail(`Deployer holds ${bal.text} USDC; mainnet needs at least 2 USDC (cost plus room). Fund it first.`);
  }

  const send = async (what, p) => {
    step(what);
    const hash = await p;
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') fail(`${what} reverted: ${txUrl(hash)}`);
    console.log(`  ${txUrl(hash)}`);
    return { hash, rc };
  };

  // guards
  for (const coin of COIN_KEYS) {
    if (st.guards[coin]) continue;
    if (MAINNET) {
      st.guards[coin] = { address: getAddress(CHAINLINK_MAINNET[coin].toLowerCase()), kind: 'Chainlink proxy' };
    } else {
      const { hash, rc } = await send(`Deploy test stand-in for Chainlink ${COINS[coin].pair}`, wallet.deployContract({ abi: art.feed.abi, bytecode: art.feed.bytecode, args: [owner, FEED_DECIMALS, standInDescription(coin)] }));
      st.guards[coin] = { address: rc.contractAddress, tx: hash, block: Number(rc.blockNumber), kind: 'test stand-in', seeded: false };
      console.log(`  ${rc.contractAddress}`);
    }
    saveState(st);
  }
  if (!MAINNET) {
    // The relay refuses to push while its guard has no price, so the stand-ins get one real Bitfinex price now.
    // (The runner keeps them fresh: the relay refuses a guard older than 26 hours.)
    const prices = createExchangePrices();
    for (const coin of COIN_KEYS) {
      if (st.guards[coin].seeded) continue;
      const price = await prices.price(COINS[coin].pair);
      await send(`First price for the ${COINS[coin].pair} stand-in: ${(Number(price) / 1e8).toLocaleString('en-US')} USD (Bitfinex last trade)`,
        wallet.writeContract({ address: st.guards[coin].address, abi: art.feed.abi, functionName: 'setPrice', args: [price] }));
      st.guards[coin].seeded = true;
      saveState(st);
      await new Promise((r) => setTimeout(r, 5200)); // Bitfinex: one request per 5 seconds per market
    }
  }

  // arena
  const existingArena = opt('--arena');
  if (existingArena) {
    if (!isAddress(existingArena)) fail('--arena must be a valid address.');
    if (st.arena && getAddress(st.arena.address) !== getAddress(existingArena)) fail('This deployment already has a different arena.');
    st.arena = { address: getAddress(existingArena), tx: null, source: 'deployed elsewhere' };
    saveState(st);
  }
  if (!st.arena) {
    const { hash, rc } = await send('Deploy PredictionArena', wallet.deployContract({ abi: art.arena.abi, bytecode: art.arena.bytecode, args: [usdc, owner] }));
    st.arena = { address: rc.contractAddress, tx: hash, block: Number(rc.blockNumber) };
    saveState(st);
    console.log(`  ${rc.contractAddress}`);
  }

  // relays
  for (const coin of COIN_KEYS) {
    if (st.feeds[coin]) continue;
    const { hash, rc } = await send(`Deploy relay feed ${COINS[coin].pair}`, wallet.deployContract({
      abi: art.relay.abi, bytecode: art.relay.bytecode,
      args: [owner, pusher, st.guards[coin].address, COINS[coin].bandBps, relayDescription(coin, SET_NAME)],
    }));
    st.feeds[coin] = { address: rc.contractAddress, tx: hash, block: Number(rc.blockNumber) };
    saveState(st);
    console.log(`  ${rc.contractAddress}`);
  }

  // markets
  const count = Number(await pub.readContract({ address: st.arena.address, abi: art.arena.abi, functionName: 'marketCount' }));
  if (count > st.markets.length) {
    fail(`The arena already has ${count} markets but this file lists ${st.markets.length}. Check ${addrUrl(st.arena.address)} before going on.`);
  }
  for (let i = st.markets.length; i < SET.markets.length; i++) {
    const m = SET.markets[i];
    const { hash, rc } = await send(`Create market ${marketName(m)}`, wallet.writeContract({
      address: st.arena.address, abi: art.arena.abi, functionName: 'createMarket',
      args: [marketName(m), st.feeds[m.coin].address, zeroAddress, m.round, m.offset, MIN_STAKE],
    }));
    st.markets.push({ id: i, name: marketName(m), coin: m.coin, round: m.round, offset: m.offset, feed: st.feeds[m.coin].address, minStake: Number(MIN_STAKE), tx: hash, block: Number(rc.blockNumber) });
    saveState(st);
    console.log(`  market id ${i}`);
  }

  st.deployedAt = st.deployedAt || new Date().toISOString();
  saveState(st);
  await verify(art, st);

  console.log(`\nDeployment record saved to deployments/${path.basename(STATE_FILE)} (public information only).`);
  console.log(`Arena: ${addrUrl(st.arena.address)}`);
  for (const coin of COIN_KEYS) console.log(`${COINS[coin].pair} relay: ${addrUrl(st.feeds[coin].address)}`);
}

async function verify(art, st) {
  step('Verify on chain (reads only)');
  const owner = getAddress(st.owner);
  const pusher = getAddress(st.pusher || st.owner);
  let bad = 0;
  const check = (ok, what) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${what}`); if (!ok) bad++; };
  const read = (address, abi, functionName, a = []) => pub.readContract({ address, abi, functionName, args: a });
  const sameCode = async (address, c) => {
    const onchain = await pub.getCode({ address });
    return !!onchain && normalise(onchain, c.immutableReferences) === normalise(c.deployedBytecode, c.immutableReferences);
  };

  const A = st.arena.address;
  check(getAddress(await read(A, art.arena.abi, 'owner')) === owner, 'arena owner is the deployer wallet');
  if (MAINNET) check(pusher !== owner, 'the relay pusher (the runner wallet) is not the owner wallet');
  check(getAddress(await read(A, art.arena.abi, 'USDC')) === getAddress(usdc), 'arena USDC is the Arc USDC token');
  check((await read(A, art.arena.abi, 'FEE_BPS')) === 200n, 'fee is 200 basis points (2%)');
  check((await read(A, art.arena.abi, 'SETTLE_WINDOW')) === 3600n, 'settle window is 1 hour');
  check((await read(A, art.arena.abi, 'marketCount')) === BigInt(SET.markets.length), `${SET.markets.length} markets exist`);
  // The code on chain must be the code in this repo (immutable slots and the compiler's metadata tail ignored).
  check(await sameCode(A, art.arena), 'arena code on chain matches the code compiled from this repo');

  for (const coin of COIN_KEYS) {
    const pair = COINS[coin].pair;
    const R = st.feeds[coin].address;
    const G = st.guards[coin].address;
    check(getAddress(await read(R, art.relay.abi, 'owner')) === owner, `${pair} relay is owned by the deployer wallet`);
    check(getAddress(await read(R, art.relay.abi, 'pusher')) === pusher, `${pair} relay pusher is ${pusher}`);
    check(getAddress(await read(R, art.relay.abi, 'guard')) === getAddress(G), `${pair} relay guard is ${G}`);
    check(Number(await read(R, art.relay.abi, 'bandBps')) === COINS[coin].bandBps, `${pair} relay band is ${COINS[coin].bandBps} bps`);
    check((await read(R, art.relay.abi, 'MAX_GUARD_AGE')) === BigInt(MAX_GUARD_AGE_SECONDS), `${pair} relay accepts a guard up to 26 hours old`);
    check(Number(await read(R, art.relay.abi, 'decimals')) === FEED_DECIMALS, `${pair} relay has ${FEED_DECIMALS} decimals`);
    check((await read(R, art.relay.abi, 'description')) === relayDescription(coin, SET_NAME), `${pair} relay says: "${relayDescription(coin, SET_NAME)}"`);
    check(await sameCode(R, art.relay), `${pair} relay code on chain matches the repo`);
    if (MAINNET) {
      const { problems: p } = await readGuardProblems(coin, G);
      check(p.length === 0, `${pair} guard is Chainlink's proxy and looks healthy${p.length ? ': ' + p.join('; ') : ''}`);
    } else {
      check((await read(G, art.feed.abi, 'description')) === standInDescription(coin), `${pair} stand-in is labelled "${standInDescription(coin)}"`);
      check(await sameCode(G, art.feed), `${pair} stand-in code on chain matches the repo`);
    }
  }

  for (let i = 0; i < SET.markets.length; i++) {
    const m = SET.markets[i];
    const mk = await read(A, art.arena.abi, 'markets', [BigInt(i)]);
    check((await read(A, art.arena.abi, 'marketName', [BigInt(i)])) === marketName(m), `market ${i} is named ${marketName(m)}`);
    check(getAddress(mk[0]) === getAddress(st.feeds[m.coin].address), `market ${i} uses the ${m.coin.toUpperCase()} relay`);
    check(getAddress(mk[1]) === zeroAddress, `market ${i} has no second feed`);
    check(Number(mk[2]) === m.round && Number(mk[3]) === m.offset && mk[4] === BigInt(st.markets[i].minStake ?? 100_000) && mk[5] === false,
      `market ${i}: ${m.round / 60}-minute rounds (${marketName(m)}), offset ${m.offset}s, min stake ${Number(mk[4]) / 1e6} USDC, not paused`);
  }

  if (bad) fail(`${bad} check(s) failed. Do not use this deployment until they are understood.`);
  console.log('\nAll checks passed.');
}

main().catch((e) => { console.error('\nERROR: ' + (e.shortMessage || e.message)); process.exit(1); });
