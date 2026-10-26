/**
 * onchain/useLiveCalls.ts
 * The latest calls on one market, from the contract's BetPlaced events (written for the site).
 * Looks back a limited number of blocks, so a quiet market shows only recent calls.
 */
import { useQuery } from "@tanstack/react-query";
import { parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";

import { ARENA_ADDRESSES } from "./addresses";
import { NETWORK } from "./env";

const LOOK_BACK_BLOCKS = 4_000n; // the public RPC refuses a range above about 5,000 blocks (about 50 minutes on Arc)
const SHOW = 8;

export interface LiveCall {
  txHash: `0x${string}`;
  logIndex: number;
  roundIndex: number;
  player: `0x${string}`;
  side: "UP" | "DOWN";
  /** 6-decimal USDC units */
  amount: bigint;
  /** unix seconds */
  time: number;
}

const BET_PLACED = parseAbiItem("event BetPlaced(uint256 indexed marketId, uint256 indexed roundIndex, address indexed player, bool up, uint256 amount)");

export function useLiveCalls(marketId: number | null): { calls: LiveCall[] | null; isLoading: boolean } {
  const client = usePublicClient();
  const arenaAddress = ARENA_ADDRESSES[NETWORK];

  const { data, isLoading } = useQuery({
    queryKey: ["liveCalls", NETWORK, marketId],
    queryFn: async (): Promise<LiveCall[]> => {
      if (!client || !arenaAddress || marketId === null) throw new Error("not ready");
      const latest = await client.getBlockNumber();
      const logs = await client.getLogs({
        address: arenaAddress,
        event: BET_PLACED,
        args: { marketId: BigInt(marketId) },
        fromBlock: latest > LOOK_BACK_BLOCKS ? latest - LOOK_BACK_BLOCKS : 0n,
        toBlock: latest,
      });
      const newest = logs.slice(-SHOW).reverse();
      const blocks = new Map<bigint, number>();
      await Promise.all(
        [...new Set(newest.map((l) => l.blockNumber))].map(async (bn) => {
          if (bn !== null) blocks.set(bn, Number((await client.getBlock({ blockNumber: bn })).timestamp));
        }),
      );
      return newest.map((l) => {
        const a = l.args;
        return {
          txHash: l.transactionHash as `0x${string}`,
          logIndex: Number(l.logIndex),
          roundIndex: Number(a.roundIndex),
          player: a.player as `0x${string}`,
          side: a.up ? "UP" : "DOWN",
          amount: a.amount ?? 0n,
          time: blocks.get(l.blockNumber as bigint) ?? 0,
        };
      });
    },
    enabled: !!client && !!arenaAddress && marketId !== null,
    refetchInterval: 8_000,
    refetchIntervalInBackground: false,
    staleTime: 6_000,
    retry: 2,
  });

  return { calls: data ?? null, isLoading };
}
