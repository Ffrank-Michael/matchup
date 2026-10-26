/**
 * onchain/useRoundHistory.ts
 * Older rounds of one market for the "Round history" sheet: the last 24 hours, newest first, read from the contract in pages
 * (one multicall of PAGE rounds each) so more load as the list is scrolled. Rounds that nobody called are left out.
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";

import type { Market } from "@/lib/markets";

import { ARENA_ABI } from "./abi";
import { ARENA_ADDRESSES } from "./addresses";
import { NETWORK } from "./env";
import { displayState } from "./useAllRounds";
import type { Round } from "./useRounds";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const PAGE = 24;
export const HISTORY_SECONDS = 24 * 3_600;

/**
 * `newest` is the newest round to list (the one just older than the rounds the Live calls tile shows). It is fixed when the
 * sheet opens, so the list does not move under the finger while it is read.
 */
export function useRoundHistory(market: Market, newest: number | null, enabled: boolean) {
  const client = usePublicClient();
  const arenaAddress = ARENA_ADDRESSES[NETWORK];
  const lockOf = (k: number) => k * market.roundSeconds + market.lockOffset;

  const q = useInfiniteQuery({
    queryKey: ["roundHistory", NETWORK, market.id, newest],
    initialPageParam: newest ?? 0,
    queryFn: async ({ pageParam }): Promise<{ rounds: Round[]; next: number | null }> => {
      if (!client || !arenaAddress) throw new Error("not ready");
      const now = Math.floor(Date.now() / 1000);
      const oldestWanted = now - HISTORY_SECONDS;
      const ks: number[] = [];
      for (let k = pageParam; k >= 0 && ks.length < PAGE && lockOf(k) + market.roundSeconds >= oldestWanted; k--) ks.push(k);
      if (ks.length === 0) return { rounds: [], next: null };
      const results = await client.multicall({
        contracts: ks.map((k) => ({ address: arenaAddress, abi: ARENA_ABI, functionName: "rounds" as const, args: [BigInt(market.id), BigInt(k)] as const })),
        allowFailure: false,
        multicallAddress: MULTICALL3,
        batchSize: 60_000,
      });
      const rounds: Round[] = [];
      ks.forEach((k, i) => {
        const [upTotal, downTotal, , , startRaw, endRaw, stateNo] = results[i];
        if (upTotal + downTotal === 0n) return;
        const lock = lockOf(k);
        const end = lock + market.roundSeconds;
        rounds.push({
          marketId: market.id,
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
      const last = ks[ks.length - 1];
      const more = last - 1 >= 0 && lockOf(last - 1) + market.roundSeconds >= oldestWanted;
      return { rounds, next: more ? last - 1 : null };
    },
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    enabled: enabled && newest !== null && !!client && !!arenaAddress,
    staleTime: 30_000,
    retry: 2,
  });

  return {
    rounds: q.data ? q.data.pages.flatMap((p) => p.rounds) : null,
    isLoading: q.isLoading,
    isError: q.isError,
    hasMore: q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    loadMore: () => void q.fetchNextPage(),
  };
}
