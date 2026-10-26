/**
 * src/onchain/chains.ts
 * ─────────────────────────────────────────────────────────────
 * Arc Testnet and Arc Mainnet chain definitions.
 *
 * USDC on Arc:
 *   Address   0x3600000000000000000000000000000000000000  (both networks)
 *   Decimals  6  (ERC-20 view — always use this for display and math)
 *
 * IMPORTANT: Arc uses USDC as its native gas token.  The native balance
 * has 18 decimals while the ERC-20 balance has 6.  They represent the
 * SAME pool of money, NOT two separate amounts.
 *
 *   ┌──────────────────────────┬──────────────────────────────┐
 *   │ Native view (gas/tx fees)│ ERC-20 view (all app money)  │
 *   │ 18 decimals              │ 6 decimals                   │
 *   │ Same address             │ Same address                 │
 *   └──────────────────────────┴──────────────────────────────┘
 *
 * We NEVER show the native balance.  We NEVER sum the two.
 * All USDC display and arithmetic uses the 6-decimal ERC-20 view.
 */

import { defineChain } from "viem";

// ── Arc Testnet ──────────────────────────────────────────────
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" },
  },
  testnet: true,
});

// ── Arc Mainnet ──────────────────────────────────────────────
export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
  testnet: false,
});

/** USDC ERC-20 contract address (same on both networks) */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;

/** USDC ERC-20 decimals — always 6, never 18 */
export const USDC_DECIMALS = 6;
