/**
 * onchain/useChainStart.ts
 * The start price on chain for a running round (audit part 2, P2-05): the first update of the market's relay at or after
 * the lock (web/lib/chain-start.ts). Asked every few seconds until it is there; once found it never changes, so it is kept.
 * Returns the price as a number with the market's decimals, or null while there is none on chain.
 */
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";

import { NETWORK } from "./env";
import { findChainStart, type RoundData } from "@/lib/chain-start";
import { feedDecimals } from "@/lib/markets";

/** The two reads of the Chainlink interface every relay has. */
export const FEED_ABI = [
  {
    type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
  },
  {
    type: "function", name: "getRoundData", stateMutability: "view", inputs: [{ name: "_roundId", type: "uint80" }],
    outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
  },
] as const;

export function useChainStart(feed: string | null, lockSec: number | null, nowSec: number | null): number | null {
  const client = usePublicClient();
  const started = feed !== null && lockSec !== null && nowSec !== null && nowSec >= lockSec;
  const { data } = useQuery({
    queryKey: ["chainStart", NETWORK, feed?.toLowerCase(), lockSec],
    enabled: started && !!client,
    queryFn: async () => {
      if (!client || !feed || lockSec === null) throw new Error("not ready");
      const address = feed as `0x${string}`;
      const found = await findChainStart(
        {
          latest: async () => (await client.readContract({ address, abi: FEED_ABI, functionName: "latestRoundData" })) as RoundData,
          round: async (id) => (await client.readContract({ address, abi: FEED_ABI, functionName: "getRoundData", args: [id] })) as RoundData,
        },
        lockSec,
      );
      return found ? Number(found.answer) / 10 ** feedDecimals(feed) : null;
    },
    // until it is on chain, look again every 4 s; once found it never changes
    refetchInterval: (q) => (q.state.data == null ? 4_000 : false),
    staleTime: (q) => (q.state.data == null ? 0 : Infinity),
    retry: 2,
  });
  return started ? (data ?? null) : null;
}
