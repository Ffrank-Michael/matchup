// Shared helpers for the Kairo Markets scripts. Reads .env; NEVER prints a secret.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { runnerKeyFor } from './runnerKey.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Reads KEY=value lines. A value wrapped in matching quotes ("..." or '...') loses them, so KEY="https://x" works like KEY=https://x. */
export function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return env;
}

export function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) throw new Error('No .env file. Copy .env.example to .env first.');
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

// The two Arc networks. Everything defaults to testnet; mainnet (real USDC) is only used when a script asks for it by name.
export const NETWORKS = {
  testnet: { id: 5042002, name: 'Arc Testnet', rpcEnv: 'ARC_TESTNET_RPC_URL', rpc: 'https://rpc.testnet.arc.io', explorer: 'https://explorer.testnet.arc.io', keyEnv: 'DEPLOYER_PRIVATE_KEY' },
  mainnet: { id: 5042, name: 'Arc', rpcEnv: 'ARC_MAINNET_RPC_URL', rpc: 'https://rpc.mainnet.arc.io', explorer: 'https://explorer.arc.io', keyEnv: 'MAINNET_DEPLOYER_PRIVATE_KEY' },
};

/** The viem chain for one of the NETWORKS. Arc: USDC is the native gas token (18-decimal native view, 6-decimal ERC-20 view). */
export function arcChain(net, rpc) {
  return defineChain({
    id: net.id,
    name: net.name,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: `${net.name} Explorer`, url: net.explorer } },
  });
}

/**
 * Clients for one network. The key is read from .env and never printed.
 * needKey false (a read-only dry run): a missing key is allowed and the account is only an address
 * (MAINNET_DEPLOYER_ADDRESS from .env, or a placeholder); wallet is then null.
 * role 'runner': the round runner's key (see runnerKey.mjs): RUNNER_PRIVATE_KEY on testnet, MAINNET_RUNNER_PRIVATE_KEY on mainnet and nothing else, so the runner
 * never reads the deployer key there.
 */
export function setup(network = 'testnet', { needKey = true, role = 'deployer' } = {}) {
  const net = NETWORKS[network];
  if (!net) throw new Error(`Unknown network ${network}.`);
  const env = loadEnv();
  const key = role === 'runner' ? runnerKeyFor(network, env).key : env[net.keyEnv] || '';
  const hasKey = /^0x[0-9a-fA-F]{64}$/.test(key);
  if (!hasKey && (needKey || key)) throw new Error(`${net.keyEnv} in .env is missing or not 0x + 64 hex characters.`);
  const rpc = env[net.rpcEnv] || net.rpc;
  if (network === 'testnet' && Number(env.ARC_TESTNET_CHAIN_ID || net.id) !== net.id) throw new Error('Refusing to run: ARC_TESTNET_CHAIN_ID in .env is not 5042002.');
  const usdc = env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
  const chain = arcChain(net, rpc);
  const account = hasKey ? privateKeyToAccount(key) : { address: env.MAINNET_DEPLOYER_ADDRESS || '0x000000000000000000000000000000000000dEaD' };
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = hasKey ? createWalletClient({ account, chain, transport: http(rpc) }) : null;
  return { env, chain, account, pub, wallet, usdc, hasKey };
}

export const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

export async function usdcBalance(pub, usdc, who) {
  // One balance only: the 6-decimal ERC-20 view (the native 18-decimal view is the SAME money).
  const raw = await pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
  return { raw, text: formatUnits(raw, 6) };
}
