import { defineChain } from "viem";

// Arc testnet, with the same addresses the rest of this project uses (checked 2026-10-25:
// the RPC answers chain id 0x4cef52 = 5042002). Gas on Arc is paid in USDC, which is why the
// "native currency" is USDC (18 decimals in this native view; the ERC-20 view has 6).
// This is also what a wallet saves when the visitor accepts "Add network".
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" } },
  testnet: true,
});

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
