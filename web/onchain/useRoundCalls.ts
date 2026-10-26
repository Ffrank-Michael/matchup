/**
 * onchain/useRoundCalls.ts
 * Everyone who called one round of one market, from the contract's BetPlaced events (written for the site).
 * Calls are made during the round before, so the look-back reaches from one round length before the round's lock.
 * The public RPC refuses ranges above about 5,000 blocks, so the search goes back in chunks of 4,000.
 */
import { useQuery } from "@tanstack/react-query";
import { decodeAbiParameters, parseAbiItem, parseAbiParameters, toEventSelector } from "viem";
import { usePublicClient } from "wagmi";

import { ARENA_ADDRESSES } from "./addresses";
import { NETWORK } from "./env";
import { explorerLogs, numberTopic } from "./explorerLogs";

const CHUNK = 4_000n;
const MAX_CHUNKS = 6; // about 4 hours of blocks
const SECONDS_PER_BLOCK = 0.64;

export interface RoundCall {
  txHash: `0x${string}`;
  logIndex: number;
  player: `0x${string}`;
  side: "UP" | "DOWN";
  /** 6-decimal USDC units */
  amount: bigint;
}

const BET_PLACED_TOPIC = toEventSelector("BetPlaced(uint256,uint256,address,bool,uint256)");
const BET_PLACED = parseAbiItem("event BetPlaced(uint256 indexed marketId, uint256 indexed roundIndex, address indexed player, bool up, uint256 amount)");

export function useRoundCalls(marketId: number | null, roundIndex: number | null, lockTimeSec: number | null, roundLength: number | null) {
  const client = usePublicClient();
  const arenaAddress = ARENA_ADDRESSES[NETWORK];
  const enabled = !!client && !!arenaAddress && marketId !== null && roundIndex !== null && lockTimeSec !== null && roundLength !== null;

  const { data, isLoading } = useQuery({
    queryKey: ["roundCalls", NETWORK, marketId, roundIndex],
    queryFn: async (): Promise<RoundCall[]> => {
      if (!client || !arenaAddress || marketId === null || roundIndex === null || lockTimeSec === null || roundLength === null) throw new Error("not ready");
      const latest = await client.getBlockNumber();
      const secondsBack = Math.max(0, Math.floor(Date.now() / 1000) - (lockTimeSec - roundLength)) + 120;
      const blocksBack = BigInt(Math.ceil(secondsBack / SECONDS_PER_BLOCK)) + 200n;
      const chunks = Math.min(MAX_CHUNKS, Number((blocksBack + CHUNK - 1n) / CHUNK));
      const out: RoundCall[] = [];
      if (Number((blocksBack + CHUNK - 1n) / CHUNK) > MAX_CHUNKS) {
        // an older round (round history): the public RPC cannot search that far back, the block explorer's API can
        const logs = await explorerLogs({ address: arenaAddress, topics: [BET_PLACED_TOPIC, numberTopic(marketId), numberTopic(roundIndex)], fromBlock: 0 });
        for (const l of logs) {
          const [up, amount] = decodeAbiParameters(parseAbiParameters("bool,uint256"), l.data);
          out.push({ txHash: l.txHash, logIndex: l.logIndex, player: `0x${(l.topics[3] ?? "").slice(-40)}` as `0x${string}`, side: up ? "UP" : "DOWN", amount });
        }
        return out.sort((a, b) => a.logIndex - b.logIndex);
      }
      for (let i = 0; i < chunks; i++) {
        const to = latest - BigInt(i) * CHUNK;
        if (to < 0n) break;
        const from = to >= CHUNK ? to - CHUNK + 1n : 0n;
        const logs = await client.getLogs({ address: arenaAddress, event: BET_PLACED, args: { marketId: BigInt(marketId), roundIndex: BigInt(roundIndex) }, fromBlock: from, toBlock: to });
        for (const l of logs) {
          out.push({ txHash: l.transactionHash as `0x${string}`, logIndex: Number(l.logIndex), player: l.args.player as `0x${string}`, side: l.args.up ? "UP" : "DOWN", amount: l.args.amount ?? 0n });
        }
      }
      return out.sort((a, b) => a.logIndex - b.logIndex);
    },
    enabled,
    refetchInterval: 6_000,
    refetchIntervalInBackground: false,
    staleTime: 4_000,
    retry: 2,
  });

  return { calls: data ?? null, isLoading };
}
