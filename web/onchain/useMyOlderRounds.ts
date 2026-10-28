/**
 * onchain/useMyOlderRounds.ts
 * Rounds older than the ones useAllRounds reads (about the last hour) in which the connected wallet still has money waiting:
 * a refund of a round nobody settled, winnings, or the unmatched part of a call. Without this a refund that opens one hour
 * after a round ended would drop off "Your calls" a few minutes later and the money could not be claimed from the site.
 *
 * Where the wallet called comes from the contract's BetPlaced events (block explorer API, which reaches back over the whole
 * chain); what is still waiting comes from the contract (positions and claimable). Claiming needs no extra step: claim()
 * turns a round that nobody settled in time into a refund by itself, in the same transaction.
 */
import { useQuery } from "@tanstack/react-query";
import { toEventSelector } from "viem";
import { useConnection, usePublicClient } from "wagmi";

import { ARENA_ABI } from "./abi";
import { ARENA_ADDRESSES } from "./addresses";
import { NETWORK } from "./env";
import { addressTopic, explorerLogs } from "./explorerLogs";
import { displayState } from "./useAllRounds";
import type { Market } from "./useMarkets";
import type { Round } from "./useRounds";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const BET_PLACED_TOPIC = toEventSelector("BetPlaced(uint256,uint256,address,bool,uint256)");

/** Rounds with money waiting for the connected wallet that are older than `recent`, per market, newest first. null until read. */
export function useMyOlderRounds(markets: Market[] | null, recent: Record<number, Round[]> | null): Record<number, Round[]> | null {
  const client = usePublicClient();
  const { address } = useConnection();
  const arenaAddress = ARENA_ADDRESSES[NETWORK];

  // 1. every (market, round) the wallet has called, from the events
  const bets = useQuery({
    queryKey: ["myBets", NETWORK, address],
    queryFn: async (): Promise<{ marketId: number; roundIndex: number }[]> => {
      if (!arenaAddress || !address) throw new Error("not ready");
      const logs = await explorerLogs({ address: arenaAddress, topics: [BET_PLACED_TOPIC, null, null, addressTopic(address)], fromBlock: 0 });
      const seen = new Map<string, { marketId: number; roundIndex: number }>();
      for (const l of logs) {
        const marketId = Number(BigInt(l.topics[1] ?? "0x0"));
        const roundIndex = Number(BigInt(l.topics[2] ?? "0x0"));
        seen.set(`${marketId}:${roundIndex}`, { marketId, roundIndex });
      }
      return [...seen.values()];
    },
    enabled: !!arenaAddress && !!address,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    retry: 2,
  });

  // only rounds older than what useAllRounds already shows
  const oldestShown = (marketId: number) => {
    const list = recent?.[marketId];
    return list && list.length > 0 ? list[list.length - 1].roundIndex : null;
  };
  const older = (bets.data ?? []).filter((b) => {
    const oldest = oldestShown(b.marketId);
    return oldest !== null && b.roundIndex < oldest;
  });

  // 2. which of them still have money waiting
  const { data } = useQuery({
    queryKey: ["myOlderRounds", NETWORK, address, older.map((b) => `${b.marketId}:${b.roundIndex}`).join(",")],
    queryFn: async (): Promise<Record<number, Round[]>> => {
      if (!client || !arenaAddress || !address || !markets) throw new Error("not ready");
      const now = Math.floor(Date.now() / 1000);
      const arena = { address: arenaAddress, abi: ARENA_ABI } as const;
      const ask = (functionName: "positions" | "claimable" | "rounds", b: { marketId: number; roundIndex: number }) =>
        ({ ...arena, functionName, args: functionName === "rounds" ? [BigInt(b.marketId), BigInt(b.roundIndex)] : [BigInt(b.marketId), BigInt(b.roundIndex), address] }) as never;
      const results = await client.multicall({
        contracts: [...older.map((b) => ask("positions", b)), ...older.map((b) => ask("claimable", b)), ...older.map((b) => ask("rounds", b))],
        allowFailure: true,
        multicallAddress: MULTICALL3,
        batchSize: 60_000,
      });
      const n = older.length;
      const out: Record<number, Round[]> = {};
      older.forEach((b, i) => {
        const pos = results[i], claimable = results[n + i], round = results[2 * n + i];
        if (pos.status !== "success" || claimable.status !== "success" || round.status !== "success") return;
        const [, , claimed] = pos.result as unknown as [bigint, bigint, boolean];
        if (claimed || (claimable.result as unknown as bigint) === 0n) return; // nothing waiting
        const m = markets.find((x) => x.id === b.marketId);
        if (!m) return;
        const [upTotal, downTotal, , , startRaw, endRaw, stateNo] = round.result as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, number];
        const lock = m.startOffset + b.roundIndex * m.roundLength;
        const end = lock + m.roundLength;
        (out[b.marketId] ||= []).push({
          marketId: b.marketId,
          roundIndex: b.roundIndex,
          upTotal,
          downTotal,
          startPrice: startRaw !== 0n ? Number(startRaw) : null,
          endPrice: endRaw !== 0n ? Number(endRaw) : null,
          state: displayState(Number(stateNo), lock, end, now),
          lockTimeSec: lock,
          endTimeSec: end,
        });
      });
      for (const id of Object.keys(out)) out[Number(id)].sort((x, y) => y.roundIndex - x.roundIndex);
      return out;
    },
    enabled: !!client && !!arenaAddress && !!address && !!markets && older.length > 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    retry: 2,
  });

  return older.length === 0 ? {} : (data ?? null);
}
