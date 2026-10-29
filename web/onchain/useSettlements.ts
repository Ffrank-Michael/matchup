/**
 * onchain/useSettlements.ts
 * What the chain recorded for finished rounds, so every round can show its start and end price, why it was refunded and a
 * "Verify" link to the transactions behind it:
 *   - RoundSettled events of the arena: result, the two prices, the refund reason, the settle transaction
 *   - PriceRelayed events of each market's price relay: the transaction that recorded each price, and when
 * The recent ones come from the shared chain log (useChainLog.ts). A round older than that (a receipt for a finished call)
 * is looked up by itself in the block explorer's API, which indexes the whole chain but allows only a few requests, so it is
 * used only for the one round that is open, and its answer is remembered.
 */
import { useQuery } from "@tanstack/react-query";
import { decodeAbiParameters, parseAbiParameters } from "viem";
import { usePublicClient } from "wagmi";

import { ARENA_ADDRESSES } from "./addresses";
import { NETWORK } from "./env";
import { addressTopic, explorerLogs, numberTopic } from "./explorerLogs";
import { CALL_PLACED, CLAIMED, PRICE_RELAYED, ROUND_SETTLED, settlementKey, useChainLog, type ChainLog, type PricePush, type Settlement } from "./useChainLog";

export type { PricePush, Settlement } from "./useChainLog";
export { pushKey, settlementKey } from "./useChainLog";

/** Recent settlements of all markets, keyed "marketId:roundIndex". */
export function useSettlements(): Map<string, Settlement> | null {
  return useChainLog()?.settlements ?? null;
}

/** Recent price pushes of the relays, keyed "feed:roundId". */
export function usePricePushes(feeds: string[]): Map<string, PricePush> | null {
  void feeds;
  return useChainLog()?.pushes ?? null;
}

/** One round's settlement: from the recent log if it is there, otherwise looked up by itself (an older round). */
export function useSettlementFor(marketId: number | null, roundIndex: number | null): { settlement: Settlement | null; loading: boolean } {
  const arena = ARENA_ADDRESSES[NETWORK];
  const log = useChainLog();
  const key = marketId !== null && roundIndex !== null ? settlementKey(marketId, roundIndex) : null;
  const inLog = key !== null ? (log?.settlements.get(key) ?? null) : null;
  const alone = useQuery({
    queryKey: ["settlement", NETWORK, key],
    queryFn: async (): Promise<Settlement | null> => {
      if (!arena || marketId === null || roundIndex === null) throw new Error("not ready");
      const logs = await explorerLogs({ address: arena, topics: [ROUND_SETTLED, numberTopic(marketId), numberTopic(roundIndex)], fromBlock: 0 });
      if (!logs.length) return null;
      const l = logs[logs.length - 1];
      const [state, startRoundId, endRoundId, sp, ep, reason] = decodeAbiParameters(parseAbiParameters("uint8,uint80,uint80,int256,int256,uint8"), l.data);
      return { marketId, roundIndex, state, startRoundId, endRoundId, startPrice: sp > 0n ? Number(sp) / 1e8 : null, endPrice: ep > 0n ? Number(ep) / 1e8 : null, reason, tx: l.txHash };
    },
    enabled: !!arena && key !== null && log !== null && inLog === null,
    staleTime: 60_000,
    retry: false,
  });
  return { settlement: inLog ?? alone.data ?? null, loading: log === null || alone.isLoading };
}

/** One price push, from the recent log or (an older round) looked up by itself. A recorded price never changes. */
export function usePricePush(feed: string | null, roundId: bigint | null, recent: Map<string, PricePush> | null): PricePush | null {
  const key = feed && roundId ? `${feed.toLowerCase()}:${roundId}` : null;
  const inLog = key ? (recent?.get(key) ?? null) : null;
  const alone = useQuery({
    queryKey: ["pricePush", NETWORK, key],
    queryFn: async (): Promise<PricePush | null> => {
      const logs = await explorerLogs({ address: feed as string, topics: [PRICE_RELAYED, numberTopic(roundId as bigint)], fromBlock: 0 });
      if (!logs.length) return null;
      const [answer, , updatedAt] = decodeAbiParameters(parseAbiParameters("int256,int256,uint256"), logs[0].data);
      return { roundId: roundId as bigint, price: Number(answer) / 1e8, time: Number(updatedAt), tx: logs[0].txHash };
    },
    enabled: key !== null && recent !== null && inLog === null,
    staleTime: Infinity,
    retry: false,
  });
  return inLog ?? alone.data ?? null;
}

export interface CallHistory {
  callTx: `0x${string}` | null;
  /** unix seconds */
  callTime: number | null;
  claimTx: `0x${string}` | null;
  /** USDC paid out by the claim, 6-decimal units */
  paidOut: bigint | null;
}

const inLogHistory = (log: ChainLog, marketId: number, roundIndex: number, player: string) => {
  const p = player.toLowerCase();
  const call = log.calls.find((b) => b.marketId === marketId && b.roundIndex === roundIndex && b.player.toLowerCase() === p);
  const claim = [...log.claims].reverse().find((c) => c.marketId === marketId && c.roundIndex === roundIndex && c.player.toLowerCase() === p);
  return { call, claim };
};

/** A player's call and claim transactions for one round (for the receipt): the recent log first, the explorer for an older round. */
export function useCallHistory(marketId: number | null, roundIndex: number | null, player: string | undefined): CallHistory | null {
  const client = usePublicClient();
  const arena = ARENA_ADDRESSES[NETWORK];
  const log = useChainLog();
  const ready = log !== null && marketId !== null && roundIndex !== null && !!player;
  const recent = ready ? inLogHistory(log, marketId, roundIndex, player) : null;

  // the time of the call: the timestamp of its block
  const time = useQuery({
    queryKey: ["blockTime", NETWORK, recent?.call?.block],
    queryFn: async () => Number((await client!.getBlock({ blockNumber: BigInt(recent!.call!.block) })).timestamp),
    enabled: !!client && !!recent?.call,
    staleTime: Infinity,
  });

  const older = useQuery({
    queryKey: ["callHistoryOlder", NETWORK, marketId, roundIndex, player?.toLowerCase()],
    queryFn: async (): Promise<CallHistory> => {
      const topics = (t0: string) => [t0, numberTopic(marketId as number), numberTopic(roundIndex as number), addressTopic(player as string)];
      const calls = await explorerLogs({ address: arena as string, topics: topics(CALL_PLACED), fromBlock: 0 });
      const claims = await explorerLogs({ address: arena as string, topics: topics(CLAIMED), fromBlock: 0 });
      const claim = claims[claims.length - 1];
      return {
        callTx: calls[0]?.txHash ?? null,
        callTime: calls[0]?.time ?? null,
        claimTx: claim?.txHash ?? null,
        paidOut: claim ? (decodeAbiParameters(parseAbiParameters("uint256"), claim.data)[0] as bigint) : null,
      };
    },
    enabled: !!arena && ready && !recent?.call,
    staleTime: 60_000,
    retry: false,
  });

  if (!ready) return null;
  if (recent?.call) return { callTx: recent.call.tx, callTime: time.data ?? null, claimTx: recent.claim?.tx ?? null, paidOut: recent.claim?.amount ?? null };
  return older.data ?? null;
}
