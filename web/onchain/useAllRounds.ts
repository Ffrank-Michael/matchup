/**
 * onchain/useAllRounds.ts
 * The rounds of every market in ONE multicall: enough past rounds to cover the contract's 1-hour settle window, plus the
 * next one. Used for the pots, the start price of the running round and the "Your calls" list. (Written for the site:
 * Arc Studio's useRounds reads one market at a time.)
 */
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";

import { ARENA_ABI } from "./abi";
import { ARENA_ADDRESSES } from "./addresses";
import { NETWORK } from "./env";
import type { Round, RoundDisplayState } from "./useRounds";
import type { Market } from "./useMarkets";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const SETTLE_WINDOW_SEC = 3_600;
const STATES = ["unsettled", "up", "down", "refunded"] as const;

function displayState(stateNo: number, lock: number, end: number, now: number): RoundDisplayState {
  const s = STATES[stateNo];
  if (s !== "unsettled") return s;
  if (now < lock) return "open";
  if (now < end) return "locked";
  return now <= end + SETTLE_WINDOW_SEC ? "unsettled" : "refunded"; // past the settle window the contract refunds on claim
}

/** Rounds per market, newest first, keyed by market id. null until the first read. */
export function useAllRounds(markets: Market[] | null): { roundsByMarket: Record<number, Round[]> | null; isLoading: boolean } {
  const client = usePublicClient();
  const arenaAddress = ARENA_ADDRESSES[NETWORK];
  const key = markets?.map((m) => `${m.id}:${m.nextRound}`).join(",");

  const { data, isLoading } = useQuery({
    queryKey: ["rounds", NETWORK, "all", key],
    queryFn: async () => {
      if (!arenaAddress || !client || !markets) throw new Error("not ready");
      const now = Math.floor(Date.now() / 1000);
      const wanted = markets.flatMap((m) => {
        const back = Math.ceil(SETTLE_WINDOW_SEC / m.roundLength) + 2;
        const first = Math.max(0, m.nextRound - back);
        return Array.from({ length: m.nextRound - first + 1 }, (_, i) => ({ m, k: first + i }));
      });
      const results = await client.multicall({
        contracts: wanted.map(({ m, k }) => ({ address: arenaAddress, abi: ARENA_ABI, functionName: "rounds" as const, args: [BigInt(m.id), BigInt(k)] as const })),
        allowFailure: false,
        multicallAddress: MULTICALL3,
        batchSize: 60_000,
      });
      const out: Record<number, Round[]> = {};
      wanted.forEach(({ m, k }, i) => {
        const [upTotal, downTotal, , , startRaw, endRaw, stateNo] = results[i];
        const lock = m.startOffset + k * m.roundLength;
        const end = lock + m.roundLength;
        (out[m.id] ||= []).push({
          marketId: m.id,
          roundIndex: k,
          upTotal,
          downTotal,
          startPrice: startRaw !== 0n ? Number(startRaw) : null,
          endPrice: endRaw !== 0n ? Number(endRaw) : null,
          state: displayState(Number(stateNo), lock, end, now),
          lockTimeSec: lock,
          endTimeSec: end,
        });
      });
      for (const id of Object.keys(out)) out[Number(id)].reverse(); // newest first
      return out;
    },
    enabled: !!client && !!arenaAddress && !!markets && markets.length > 0,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    staleTime: 4_000,
    retry: 3,
  });

  return { roundsByMarket: data ?? null, isLoading };
}
