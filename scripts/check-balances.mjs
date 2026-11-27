// Matchup: the USDC balances of the mainnet wallets, and who receives the 2% fee. ARC MAINNET, READ ONLY.
//
//   node scripts/check-balances.mjs                    the owner, the runner and the arena
//   node scripts/check-balances.mjs 0xabc... 0xdef...  the same, plus these addresses (labelled "other")
//
// No keys and no transactions: it reads public data only. It does not read .env. The Arc RPC is ARC_MAINNET_RPC_URL from the
// shell if set, otherwise Arc's public RPC.
//
// USDC is the gas token on Arc. The chain shows the same money two ways (native, 18 decimals; the ERC-20 at 0x3600..., 6 decimals);
// this script reads the ERC-20 view, like the rest of the scripts (lib.mjs usdcBalance).
//
// The fee: the arena keeps 2% of each round's matched pool in feesAccrued. withdrawFees(to, amount) has NO fixed recipient:
// whoever calls it names the address `to`, and only owner() can call it (onlyOwner), capped by feesAccrued.
import { pathToFileURL } from 'node:url';
import { createPublicClient, http, formatUnits, getAddress, isAddress } from 'viem';

export const MAINNET_CHAIN_ID = 5042;
export const PUBLIC_RPC = 'https://rpc.mainnet.arc.io';
export const USDC = '0x3600000000000000000000000000000000000000';
export const OWNER = '0x1AB2ADf11B3B16544C5F76d74c729B4EdCDcb4bC';
export const RUNNER = '0x141043c9f604c8274286Dc0319a2F1c9124CEa3F';
export const ARENA = '0xaebac196c76a2c9338a30aef663e4799fFA0d364';
export const MIN_RUNNER = 1_000_000n; // 1 USDC (6 decimals)
export const MIN_OWNER = 500_000n; // 0.5 USDC

const view = (name, outputs, inputs = []) => ({ type: 'function', name, stateMutability: 'view', inputs, outputs });
export const erc20Abi = [view('balanceOf', [{ type: 'uint256' }], [{ name: 'a', type: 'address' }])];
export const arenaAbi = [
  view('feesAccrued', [{ type: 'uint256' }]),
  view('totalPlayerFunds', [{ type: 'uint256' }]),
  view('owner', [{ type: 'address' }]),
  view('pendingOwner', [{ type: 'address' }]),
];

/** The command line: extra addresses only. Returns { extra, error }. */
export function parseArgs(argv) {
  const extra = [];
  for (const a of argv) {
    if (!isAddress(a, { strict: false })) return { extra, error: `"${a}" is not an address (0x + 40 hex characters). This script only takes addresses.` };
    extra.push(getAddress(a));
  }
  return { extra, error: null };
}

/** The wallets to show, in order, each once. A known address passed again keeps its own label. */
export function walletList(extra = []) {
  const list = [
    { label: 'owner', address: getAddress(OWNER) },
    { label: 'runner', address: getAddress(RUNNER) },
    { label: 'arena', address: getAddress(ARENA) },
  ];
  for (const a of extra) if (!list.some((w) => w.address === getAddress(a))) list.push({ label: 'other', address: getAddress(a) });
  return list;
}

export const usdcText = (raw) => formatUnits(raw, 6);

/**
 * Reads everything. io = { chainId(), balance(address) -> bigint (6 decimals), code(address) -> hex, read(address, fn) -> value }.
 * A read that fails is kept as an error on its line, so one bad call does not hide the rest.
 */
export async function collect(io, extra = []) {
  const chainId = await io.chainId();
  if (chainId !== MAINNET_CHAIN_ID) throw new Error(`the RPC is chain ${chainId}, not Arc mainnet (${MAINNET_CHAIN_ID}). Nothing was read.`);
  const wallets = [];
  for (const w of walletList(extra)) {
    try { wallets.push({ ...w, raw: await io.balance(w.address) }); } catch (e) { wallets.push({ ...w, raw: null, error: e.shortMessage || e.message }); }
  }
  const arena = { hasCode: false };
  try { arena.hasCode = ((await io.code(getAddress(ARENA))) || '0x') !== '0x'; } catch { arena.hasCode = null; }
  for (const fn of ['feesAccrued', 'totalPlayerFunds', 'owner', 'pendingOwner']) {
    try { arena[fn] = await io.read(getAddress(ARENA), fn); } catch { arena[fn] = null; }
  }
  return { chainId, wallets, arena };
}

/** Plain-words warnings. */
export function warnings({ wallets, arena }) {
  const out = [];
  const find = (label) => wallets.find((w) => w.label === label);
  const runner = find('runner'), owner = find('owner');
  if (runner.raw === null) out.push('Could not read the runner balance.');
  else if (runner.raw < MIN_RUNNER) out.push(`The runner has ${usdcText(runner.raw)} USDC, below 1 USDC. It pays gas for every price push and settle: top it up soon, or rounds will stop settling.`);
  if (owner.raw === null) out.push('Could not read the owner balance.');
  else if (owner.raw < MIN_OWNER) out.push(`The owner has ${usdcText(owner.raw)} USDC, below 0.5 USDC. It may not have enough gas to pause a market, change the pusher or withdraw fees.`);
  if (arena.hasCode === false) out.push('There is no contract at the arena address on this chain.');
  if (arena.owner && getAddress(arena.owner) !== getAddress(OWNER)) out.push(`The arena's owner() is ${arena.owner}, not the owner wallet listed here (${getAddress(OWNER)}). Check this: whoever owns the arena controls the fees.`);
  if (arena.pendingOwner && getAddress(arena.pendingOwner) !== '0x0000000000000000000000000000000000000000') out.push(`An ownership move is waiting: ${arena.pendingOwner} can call acceptOwnership() and become the owner.`);
  const held = wallets.find((w) => w.label === 'arena')?.raw;
  if (held != null && arena.feesAccrued != null && arena.totalPlayerFunds != null && held < arena.feesAccrued + arena.totalPlayerFunds) {
    out.push('The arena holds less USDC than players are owed plus the fees. This should never happen: stop and look.');
  }
  return out;
}

/** The whole report as text. Prints addresses and amounts only. */
export function report(data) {
  const { wallets, arena } = data;
  const lines = ['Arc mainnet (chain id ' + data.chainId + '), USDC balances', ''];
  const w1 = Math.max(...wallets.map((w) => w.label.length), 'Who'.length);
  lines.push(`${'Who'.padEnd(w1)}  ${'Address'.padEnd(42)}  USDC`);
  lines.push(`${'-'.repeat(w1)}  ${'-'.repeat(42)}  ${'-'.repeat(14)}`);
  for (const w of wallets) lines.push(`${w.label.padEnd(w1)}  ${w.address}  ${w.raw === null ? 'could not read (' + w.error + ')' : usdcText(w.raw)}`);
  lines.push('');
  const amt = (v) => (v === null || v === undefined ? 'could not read' : usdcText(v) + ' USDC');
  lines.push('Inside the arena:');
  lines.push(`  total USDC held          ${amt(wallets.find((w) => w.label === 'arena').raw)}`);
  lines.push(`  unclaimed fees           ${amt(arena.feesAccrued)}   (feesAccrued: the 2% fee not yet withdrawn)`);
  lines.push(`  owed to players          ${amt(arena.totalPlayerFunds)}   (totalPlayerFunds: stakes and winnings not yet claimed)`);
  lines.push('');
  lines.push('Who receives the 2% fee:');
  lines.push('  withdrawFees(to, amount) has no fixed recipient. The caller chooses the address "to" each time, so the fee goes');
  lines.push('  wherever the owner sends it. It is capped by the unclaimed fees and can never touch the players\' money.');
  lines.push(`  Who can call it: only the arena's owner(), which is now ${arena.owner ? getAddress(arena.owner) : '(could not read)'}${arena.owner && getAddress(arena.owner) === getAddress(OWNER) ? ' (the owner wallet above)' : ''}.`);
  lines.push('  Each withdrawal is on the explorer as a FeesWithdrawn(to, amount) event on the arena.');
  const warn = warnings(data);
  lines.push('');
  if (warn.length) { lines.push('WARNINGS:'); for (const x of warn) lines.push('  - ' + x); } else lines.push('No warnings: the runner has at least 1 USDC and the owner at least 0.5 USDC.');
  return lines.join('\n');
}

/** The real chain, through viem. Reads only. */
export function viemIo(rpc) {
  const pub = createPublicClient({ transport: http(rpc) });
  return {
    chainId: () => pub.getChainId(),
    balance: (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] }),
    code: (a) => pub.getCode({ address: a }),
    read: (a, fn) => pub.readContract({ address: a, abi: arenaAbi, functionName: fn }),
  };
}

async function main() {
  const { extra, error } = parseArgs(process.argv.slice(2));
  if (error) { console.error(error); process.exit(2); }
  const rpc = process.env.ARC_MAINNET_RPC_URL || PUBLIC_RPC;
  try {
    console.log(report(await collect(viemIo(rpc), extra)));
  } catch (e) {
    console.error('STOP: ' + (e.shortMessage || e.message));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
