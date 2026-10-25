// Kairo Markets: deploy to Arc TESTNET and create the three markets.
//
//   node scripts/deploy.mjs                 DRY RUN (default). Compiles, checks the wallet and
//                                           estimates the cost. Sends nothing.
//   node scripts/deploy.mjs --send          Deploys 3 test price feeds + PredictionArena, creates the
//                                           3 markets, then verifies everything on chain.
//   node scripts/deploy.mjs --send --arena 0x.. --feeds 0xBTC,0xETH,0xSOL
//                                           The contracts were already deployed elsewhere (for example
//                                           by Arc Studio). Only create the markets and verify.
//   node scripts/deploy.mjs --verify-only   Re-check the addresses in deployments/arc-testnet.json.
//
// Safe to re-run: every finished step is saved to deployments/arc-testnet.json and skipped next time.
// The owner on testnet is the deployer wallet. The private key is read from .env and never printed.
import fs from 'node:fs';
import path from 'node:path';
import { formatUnits, getAddress, isAddress, zeroAddress } from 'viem';
import { setup, ROOT, usdcBalance } from './lib.mjs';
import { compile, normalise } from './compile.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const SEND = flag('--send');
const VERIFY_ONLY = flag('--verify-only');

const ROUND = 3600;
const MIN_STAKE = 100_000n; // 0.10 USDC
const MARKETS = [
  { key: 'btc', name: 'BTC/USD', offset: 0 },
  { key: 'eth', name: 'ETH/USD', offset: 1200 },
  { key: 'sol', name: 'SOL/USD', offset: 2400 },
];
const FEED_DECIMALS = 8;
const feedDescription = (m) => `TEST PRICES - NOT REAL DATA / ${m.name}`;

const STATE_FILE = path.join(ROOT, 'deployments', 'arc-testnet.json');
const loadState = () => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null);
const saveState = (s) => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
};

const { pub, wallet, account, chain, usdc } = setup();
const explorer = chain.blockExplorers.default.url;
const addrUrl = (a) => `${explorer}/address/${a}`;
const txUrl = (h) => `${explorer}/tx/${h}`;

function fail(msg) { console.error('\nSTOP: ' + msg); process.exit(1); }
function step(msg) { console.log('\n== ' + msg); }

async function main() {
  const id = await pub.getChainId();
  if (id !== 5042002) fail(`RPC reports chain ${id}; this script only runs on Arc testnet (5042002).`);

  const art = compile();
  const arenaSize = (art.arena.deployedBytecode.length - 2) / 2;
  console.log(`Compiled with solc 0.8.28. PredictionArena runtime size: ${arenaSize} bytes (limit 24576).`);
  if (arenaSize > 24576) fail('PredictionArena is over the 24576-byte contract size limit.');

  const owner = account.address;
  const bal = await usdcBalance(pub, usdc, owner);
  console.log(`Deployer / owner : ${owner}`);
  console.log(`USDC balance     : ${bal.text} USDC`);
  console.log(`USDC token       : ${usdc}`);

  if (VERIFY_ONLY) {
    const st = loadState();
    if (!st) fail('No deployments/arc-testnet.json yet.');
    await verify(art, st);
    return;
  }

  // ---------- dry run ----------
  if (!SEND) {
    step('DRY RUN (nothing is sent). Add --send to deploy for real.');
    const gasPrice = await pub.getGasPrice();
    const feedGas = await pub.estimateGas({
      account: owner,
      data: await encodeDeploy(art.feed, [owner, FEED_DECIMALS, feedDescription(MARKETS[0])]),
    });
    const arenaGas = await pub.estimateGas({
      account: owner,
      data: await encodeDeploy(art.arena, [usdc, owner]),
    });
    const totalGas = feedGas * 3n + arenaGas + 3n * 400_000n; // 3 createMarket calls, generous
    const cost = totalGas * gasPrice;
    console.log(`Gas price        : ${formatUnits(gasPrice, 9)} gwei`);
    console.log(`Estimated gas    : feed ${feedGas} x3, arena ${arenaGas}, 3 createMarket (guess 400k each)`);
    console.log(`Estimated cost   : about ${formatUnits(cost, 18)} USDC (native 18-decimal view of the same USDC)`);
    if (bal.raw * 10n ** 12n < cost * 2n) console.log('WARNING: balance is less than twice the estimate. Fund the wallet before --send.');
    else console.log('Balance covers the estimate with room to spare.');
    console.log('\nPlan on --send:');
    for (const m of MARKETS) console.log(`  feed  "${feedDescription(m)}" (decimals ${FEED_DECIMALS}, owner ${owner})`);
    console.log(`  arena PredictionArena(usdc ${usdc}, owner ${owner})`);
    for (const m of MARKETS) console.log(`  market ${m.name}: round ${ROUND}s, offset ${m.offset}s, min stake ${MIN_STAKE} (0.10 USDC), feedB = none`);
    return;
  }

  // ---------- real deployment ----------
  let st = loadState() || { network: 'arc-testnet', chainId: 5042002, usdc, owner, feeds: {}, arena: null, markets: [] };
  if (getAddress(st.owner) !== getAddress(owner)) fail('deployments/arc-testnet.json belongs to a different owner wallet.');

  const existingArena = opt('--arena');
  const existingFeeds = opt('--feeds');
  if (existingArena || existingFeeds) {
    if (!existingArena || !existingFeeds) fail('Give both --arena and --feeds (BTC,ETH,SOL).');
    const f = existingFeeds.split(',');
    if (f.length !== 3 || ![existingArena, ...f].every(isAddress)) fail('--arena / --feeds must be valid addresses (3 feeds: BTC,ETH,SOL).');
    st.arena = { address: getAddress(existingArena), tx: null, source: 'deployed elsewhere' };
    MARKETS.forEach((m, i) => { st.feeds[m.key] = { address: getAddress(f[i]), tx: null, source: 'deployed elsewhere' }; });
    saveState(st);
  }

  for (const m of MARKETS) {
    if (st.feeds[m.key]) continue;
    step(`Deploy test price feed ${m.name}`);
    const hash = await wallet.deployContract({ abi: art.feed.abi, bytecode: art.feed.bytecode, args: [owner, FEED_DECIMALS, feedDescription(m)] });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') fail(`Feed deployment reverted: ${txUrl(hash)}`);
    st.feeds[m.key] = { address: rc.contractAddress, tx: hash, block: Number(rc.blockNumber) };
    saveState(st);
    console.log(`  ${rc.contractAddress}\n  ${txUrl(hash)}`);
  }

  if (!st.arena) {
    step('Deploy PredictionArena');
    const hash = await wallet.deployContract({ abi: art.arena.abi, bytecode: art.arena.bytecode, args: [usdc, owner] });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') fail(`Arena deployment reverted: ${txUrl(hash)}`);
    st.arena = { address: rc.contractAddress, tx: hash, block: Number(rc.blockNumber) };
    saveState(st);
    console.log(`  ${rc.contractAddress}\n  ${txUrl(hash)}`);
  }

  const count = Number(await pub.readContract({ address: st.arena.address, abi: art.arena.abi, functionName: 'marketCount' }));
  if (count > st.markets.length) {
    fail(`The arena already has ${count} markets but this file lists ${st.markets.length}. Check ${addrUrl(st.arena.address)} before going on.`);
  }
  for (let i = st.markets.length; i < MARKETS.length; i++) {
    const m = MARKETS[i];
    step(`Create market ${m.name}`);
    const hash = await wallet.writeContract({
      address: st.arena.address, abi: art.arena.abi, functionName: 'createMarket',
      args: [m.name, st.feeds[m.key].address, zeroAddress, ROUND, m.offset, MIN_STAKE],
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') fail(`createMarket reverted: ${txUrl(hash)}`);
    st.markets.push({ id: i, name: m.name, tx: hash, block: Number(rc.blockNumber) });
    saveState(st);
    console.log(`  market id ${i}\n  ${txUrl(hash)}`);
  }

  st.deployedAt = st.deployedAt || new Date().toISOString();
  saveState(st);
  await verify(art, st);

  console.log('\nDeployment record saved to deployments/arc-testnet.json (public information only).');
  console.log(`Arena: ${addrUrl(st.arena.address)}`);
  for (const m of MARKETS) console.log(`${m.name} feed: ${addrUrl(st.feeds[m.key].address)}`);
}

async function encodeDeploy(c, constructorArgs) {
  const { encodeDeployData } = await import('viem');
  return encodeDeployData({ abi: c.abi, bytecode: c.bytecode, args: constructorArgs });
}

async function verify(art, st) {
  step('Verify on chain (reads only)');
  const owner = account.address;
  let bad = 0;
  const check = (ok, what) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${what}`); if (!ok) bad++; };
  const read = (address, abi, functionName, a = []) => pub.readContract({ address, abi, functionName, args: a });

  const A = st.arena.address;
  check(getAddress(await read(A, art.arena.abi, 'owner')) === getAddress(owner), 'arena owner is the deployer wallet');
  check(getAddress(await read(A, art.arena.abi, 'USDC')) === getAddress(usdc), 'arena USDC is the Arc USDC token');
  check((await read(A, art.arena.abi, 'FEE_BPS')) === 200n, 'fee is 200 basis points (2%)');
  check((await read(A, art.arena.abi, 'SETTLE_WINDOW')) === 3600n, 'settle window is 1 hour');
  check((await read(A, art.arena.abi, 'marketCount')) === 3n, 'three markets exist');

  for (let i = 0; i < MARKETS.length; i++) {
    const m = MARKETS[i];
    const F = st.feeds[m.key].address;
    const mk = await read(A, art.arena.abi, 'markets', [BigInt(i)]);
    check((await read(A, art.arena.abi, 'marketName', [BigInt(i)])) === m.name, `market ${i} is named ${m.name}`);
    check(getAddress(mk[0]) === getAddress(F), `market ${i} uses the ${m.name} test feed`);
    check(getAddress(mk[1]) === zeroAddress, `market ${i} has no second feed`);
    check(Number(mk[2]) === ROUND && Number(mk[3]) === m.offset && mk[4] === MIN_STAKE && mk[5] === false,
      `market ${i}: 1-hour rounds, offset ${m.offset}s, min stake 0.10 USDC, not paused`);
    const desc = await read(F, art.feed.abi, 'description');
    check(desc.startsWith('TEST PRICES - NOT REAL DATA'), `feed ${m.name} is labelled "${desc}"`);
    check(getAddress(await read(F, art.feed.abi, 'owner')) === getAddress(owner), `feed ${m.name} is owned by the deployer wallet`);
    check(Number(await read(F, art.feed.abi, 'decimals')) === FEED_DECIMALS, `feed ${m.name} has ${FEED_DECIMALS} decimals`);
  }

  // The code on chain must be the code in this repo (immutable slots and the compiler's metadata tail ignored).
  const onchain = await pub.getCode({ address: A });
  const same = onchain && normalise(onchain, art.arena.immutableReferences) === normalise(art.arena.deployedBytecode, art.arena.immutableReferences);
  check(!!same, 'arena code on chain matches the code compiled from this repo');
  for (const m of MARKETS) {
    const c = await pub.getCode({ address: st.feeds[m.key].address });
    const ok = c && normalise(c, art.feed.immutableReferences) === normalise(art.feed.deployedBytecode, art.feed.immutableReferences);
    check(!!ok, `${m.name} feed code on chain matches the repo`);
  }

  if (bad) fail(`${bad} check(s) failed. Do not use this deployment until they are understood.`);
  console.log('\nAll checks passed.');
}

main().catch((e) => { console.error('\nERROR: ' + (e.shortMessage || e.message)); process.exit(1); });
