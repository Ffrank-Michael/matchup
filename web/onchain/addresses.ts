/**
 * onchain/addresses.ts
 * The arena address of each network, from the deployment file (deployments/arc-*.json, copied to
 * lib/deployment.generated.json by scripts/sync-web-deployment.mjs). The site shows ONE network at a time
 * (NEXT_PUBLIC_NETWORK), and the copy is made for that network, so only that entry is filled in.
 * An empty entry means "not deployed yet": the hooks read nothing and send nothing.
 */
import deployment from "@/lib/deployment.generated.json";

const arena = deployment.arena as `0x${string}`;

export const ARENA_ADDRESSES = {
  testnet: deployment.chainId === 5042002 ? arena : null,
  mainnet: deployment.chainId === 5042 ? arena : null,
} as { testnet: `0x${string}` | null; mainnet: `0x${string}` | null };
