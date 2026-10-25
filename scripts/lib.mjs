// Shared helpers for the Kairo Markets scripts. Reads .env; NEVER prints a secret.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const env = {};
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) throw new Error('No .env file. Copy .env.example to .env first.');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

export function setup() {
  const env = loadEnv();
  const key = env.DEPLOYER_PRIVATE_KEY || '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('DEPLOYER_PRIVATE_KEY in .env is missing or not 0x + 64 hex characters.');
  const rpc = env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io';
  const chainId = Number(env.ARC_TESTNET_CHAIN_ID || 5042002);
  if (chainId !== 5042002) throw new Error('Refusing to run: this project is Arc TESTNET only (chain id 5042002).');
  const usdc = env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
  // Arc testnet: USDC is the native gas token (18-decimal native view, 6-decimal ERC-20 view).
  const chain = defineChain({
    id: chainId,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: 'Arc Testnet Explorer', url: 'https://explorer.testnet.arc.io' } },
  });
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  return { env, chain, account, pub, wallet, usdc };
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
