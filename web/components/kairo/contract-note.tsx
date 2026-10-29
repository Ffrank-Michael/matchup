import { getAddress } from "viem";

import { ARENA_ADDRESSES } from "@/onchain/addresses";
import { arcMainnet, arcTestnet } from "@/onchain/chains";
import { NETWORK } from "@/onchain/env";

/** The plain-words note about wallet security warnings. The address is the Matchup contract of the site's network, linked to its explorer. */
export function ContractNote({ className }: { className?: string }) {
  const address = ARENA_ADDRESSES[NETWORK];
  const explorer = (NETWORK === "mainnet" ? arcMainnet : arcTestnet).blockExplorers.default.url;
  const checksummed = address ? getAddress(address) : null;

  return (
    <p className={className}>
      Some wallet security tools say &lsquo;nothing in return&rsquo; or show an unknown token. That is normal: your USDC is held by the Matchup contract (
      {checksummed ? (
        <a href={`${explorer}/address/${checksummed}`} target="_blank" rel="noopener noreferrer" className="font-mono font-semibold underline underline-offset-2">
          {checksummed.slice(0, 6)}…{checksummed.slice(-4)}
        </a>
      ) : (
        "not deployed yet"
      )}
      ) until the round settles. Check that the address matches.
    </p>
  );
}
