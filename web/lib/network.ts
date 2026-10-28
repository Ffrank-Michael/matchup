import { NETWORK } from "@/onchain/env";

// Which Arc network the site is pointed at. Mainnet is the target; testnet is a short rehearsal.
// Set NEXT_PUBLIC_NETWORK=mainnet for the real site; anything else (or unset) is testnet.
export const IS_MAINNET = NETWORK === "mainnet";
