/**
 * onchain/usePlayer.ts
 * Whose positions, balance and calls the screens show: the connected browser wallet if there is one, otherwise the Google
 * (Circle) wallet. The Google wallet lives on Arc mainnet, so it only counts when the site itself is on mainnet
 * (NEXT_PUBLIC_NETWORK=mainnet); on the testnet rehearsal it is ignored here. The rule is pickPlayer (lib/circle-calls.ts).
 * Reading the chain needs only an address; sending differs (wagmi for a browser wallet, Circle for Google, see useMakeCall).
 */
import { useConnection } from "wagmi";

import { pickPlayer, type PlayerSource } from "@/lib/circle-calls";
import { useGoogleWallet } from "@/lib/use-google-wallet";
import { NETWORK } from "./env";

export type { PlayerSource };

export function usePlayer(): { address: `0x${string}` | undefined; source: PlayerSource } {
  const { address } = useConnection();
  const google = useGoogleWallet();
  return pickPlayer(address, google, NETWORK);
}
