/**
 * src/onchain/useMarkets.ts
 * ─────────────────────────────────────────────────────────────
 * Reads every market from PredictionArena with ONE Multicall3 batch.
 *
 * Reads per market:
 *   1. markets(id)          → feedA, roundLength, startOffset, minStake, paused
 *   2. marketName(id)       → name string (e.g. "BTC/USD 5m")
 *   3. nextCallableRound(id)→ next callable round index
 *
 * The coin is parsed from the name: "BTC/USD 5m" → "btc".
 * Returns null for each market when the arena is not deployed (mainnet, null address).
 */

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { ARENA_ABI } from "./abi";
import { ARENA_ADDRESSES } from "./addresses";
import { NETWORK } from "./env";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const REFETCH_MS = 5_000;

// ── Types ─────────────────────────────────────────────────────

export interface Market {
  id: number;
  name: string;
  /** lowercase coin key: "btc" | "eth" | "sol" */
  coin: string;
  roundLength: number; // seconds
  startOffset: number; // seconds from epoch
  /** minimum USDC amount per call, in 6-decimal units */
  minStake: bigint;
  paused: boolean;
  /** round index that can be called on right now */
  nextRound: number;
  /** feed address (AggregatorV3Interface) */
  feedAddress: `0x${string}`;
}

/** Parses "BTC/USD 5m" → "btc" */
function parseCoin(name: string): string {
  const match = /^([A-Z]+)\//.exec(name);
  return match ? match[1].toLowerCase() : "unknown";
}

// ── Hook ──────────────────────────────────────────────────────

/**
 * Returns the list of all markets from PredictionArena, or null if the
 * contract is not deployed on the current network, or undefined while loading.
 */
export function useMarkets(): { markets: Market[] | null; isLoading: boolean; error: Error | null } {
  const client = usePublicClient();
  const arenaAddress = ARENA_ADDRESSES[NETWORK];

  const { data, isLoading, error } = useQuery({
    queryKey: ["markets", NETWORK, arenaAddress],
    queryFn: async (): Promise<Market[]> => {
      if (!arenaAddress) {
        // Mainnet not deployed yet — return empty list; hook reports "not-deployed" via null.
        throw new Error("not-deployed");
      }
      if (!client) throw new Error("no rpc client");

      // Step 1: read marketCount
      const count = await client.readContract({
        address: arenaAddress,
        abi: ARENA_ABI,
        functionName: "marketCount",
      });
      const n = Number(count);
      if (n === 0) return [];

      const ids = Array.from({ length: n }, (_, i) => i);

      // Step 2: batch all market reads in ONE multicall
      const calls = ids.flatMap((id) => [
        { address: arenaAddress, abi: ARENA_ABI, functionName: "markets" as const, args: [BigInt(id)] },
        { address: arenaAddress, abi: ARENA_ABI, functionName: "marketName" as const, args: [BigInt(id)] },
        { address: arenaAddress, abi: ARENA_ABI, functionName: "nextCallableRound" as const, args: [BigInt(id)] },
      ]);

      const results = await client.multicall({
        contracts: calls,
        allowFailure: false,
        multicallAddress: MULTICALL3,
        batchSize: 60_000,
      });

      return ids.map((id) => {
        const base = id * 3;
        const mkt = results[base] as readonly [string, string, number, number, bigint, boolean];
        const name = results[base + 1] as string;
        const nextRound = results[base + 2] as bigint;

        const [feedA, , roundLength, startOffset, minStake, paused] = mkt;

        return {
          id,
          name,
          coin: parseCoin(name),
          roundLength: Number(roundLength),
          startOffset: Number(startOffset),
          minStake,
          paused,
          nextRound: Number(nextRound),
          feedAddress: feedA as `0x${string}`,
        };
      });
    },
    enabled: !!client,
    refetchInterval: REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: REFETCH_MS,
    retry: 3,
  });

  if (!arenaAddress) {
    return { markets: null, isLoading: false, error: null };
  }

  return {
    markets: data ?? null,
    isLoading,
    error: error,
  };
}
