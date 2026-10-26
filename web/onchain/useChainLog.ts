/**
 * onchain/useChainLog.ts
 * The recent history of the arena and of the price relays, read from the chain itself through the public RPC (written for
 * the site). One shared read feeds everything that shows the past: the prices and result of each round, why a round was
 * refunded, the transactions behind each price ("Verify"), the agents' records and a player's call and claim receipts.
 *
 * The public RPC refuses searches over about 5,000 blocks, so the search goes in fixed blocks of 4,000. A block of history
 * that has ended never changes, so each is read once and remembered; only the newest one or two are read again on a refresh.
 * It reaches back about 2 hours (rounds up to 1 hour long plus their settle time). Older rounds are looked up one at a time
 * in the explorer (see useSettlements.ts), which is slower and rate limited, so it is only the fallback.
 */
import { useQuery } from "@tanstack/react-query";
import { decodeAbiParameters, parseAbiParameters, toEventSelector, type Log } from "viem";
import { usePublicClient } from "wagmi";

import { MARKETS } from "@/lib/markets";

import { ARENA_ADDRESSES } from "./addresses";
import { NETWORK } from "./env";

const GRID = 4_000;
const CHUNKS = 3;

export const ROUND_SETTLED = toEventSelector("RoundSettled(uint256,uint256,uint8,uint80,uint80,int256,int256,uint8)");
export const PRICE_RELAYED = toEventSelector("PriceRelayed(uint80,int256,int256,uint256)");
export const BET_PLACED = toEventSelector("BetPlaced(uint256,uint256,address,bool,uint256)");
export const CLAIMED = toEventSelector("Claimed(uint256,uint256,address,uint256)");

export interface Settlement {
  marketId: number;
  roundIndex: number;
  /** 1 = UP won, 2 = DOWN won, 3 = refunded */
  state: number;
  startRoundId: bigint;
  endRoundId: bigint;
  /** USD; null when the contract recorded none */
  startPrice: number | null;
  endPrice: number | null;
  /** RefundReason as a number (0 = not a refund) */
  reason: number;
  /** The transaction that settled the round */
  tx: `0x${string}`;
}

export interface PricePush {
  roundId: bigint;
  /** USD */
  price: number;
  /** When the price landed on the chain (unix seconds) */
  time: number;
  /** The transaction that recorded it */
  tx: `0x${string}`;
}

export interface BetEvent {
  marketId: number;
  roundIndex: number;
  player: `0x${string}`;
  side: "UP" | "DOWN";
  /** 6-decimal USDC units */
  amount: bigint;
  tx: `0x${string}`;
  block: number;
}

export interface ClaimEvent {
  marketId: number;
  roundIndex: number;
  player: `0x${string}`;
  amount: bigint;
  tx: `0x${string}`;
  block: number;
}

export interface ChainLog {
  settlements: Map<string, Settlement>;
  pushes: Map<string, PricePush>;
  bets: BetEvent[];
  claims: ClaimEvent[];
}

export const settlementKey = (marketId: number, roundIndex: number) => `${marketId}:${roundIndex}`;
export const pushKey = (feed: string, roundId: bigint) => `${feed.toLowerCase()}:${roundId}`;

const topicNum = (t: string | null | undefined) => Number(BigInt(t ?? "0x0"));
const topicAddr = (t: string | null | undefined) => `0x${(t ?? "").slice(-40)}` as `0x${string}`;

// blocks that have ended are read once
const done = new Map<number, Log[]>();

export function useChainLog(): ChainLog | null {
  const client = usePublicClient();
  const arena = ARENA_ADDRESSES[NETWORK];
  const feeds = [...new Set(MARKETS.map((m) => m.feed.toLowerCase()))] as `0x${string}`[];

  const { data } = useQuery({
    queryKey: ["chainLog", NETWORK],
    queryFn: async (): Promise<ChainLog> => {
      if (!client || !arena) throw new Error("not ready");
      const latest = Number(await client.getBlockNumber());
      const newestStart = Math.floor(latest / GRID) * GRID;
      const logs: Log[] = [];
      for (let i = 0; i < CHUNKS; i++) {
        const from = newestStart - i * GRID;
        if (from < 0) break;
        const to = Math.min(from + GRID - 1, latest);
        const ended = from + GRID - 1 < latest; // a block of history that has ended never changes
        const cached = ended ? done.get(from) : undefined;
        if (cached) {
          logs.push(...cached);
          continue;
        }
        const got = await client.getLogs({ address: [arena as `0x${string}`, ...feeds], fromBlock: BigInt(from), toBlock: BigInt(to) });
        if (ended) done.set(from, got);
        logs.push(...got);
      }

      const out: ChainLog = { settlements: new Map(), pushes: new Map(), bets: [], claims: [] };
      for (const l of logs) {
        const t0 = l.topics[0];
        const tx = l.transactionHash as `0x${string}`;
        const block = Number(l.blockNumber);
        if (t0 === ROUND_SETTLED) {
          const [state, startRoundId, endRoundId, sp, ep, reason] = decodeAbiParameters(parseAbiParameters("uint8,uint80,uint80,int256,int256,uint8"), l.data);
          const s: Settlement = { marketId: topicNum(l.topics[1]), roundIndex: topicNum(l.topics[2]), state, startRoundId, endRoundId, startPrice: sp > 0n ? Number(sp) / 1e8 : null, endPrice: ep > 0n ? Number(ep) / 1e8 : null, reason, tx };
          out.settlements.set(settlementKey(s.marketId, s.roundIndex), s);
        } else if (t0 === PRICE_RELAYED) {
          const [answer, , updatedAt] = decodeAbiParameters(parseAbiParameters("int256,int256,uint256"), l.data);
          const roundId = BigInt(l.topics[1] as string);
          out.pushes.set(pushKey(l.address, roundId), { roundId, price: Number(answer) / 1e8, time: Number(updatedAt), tx });
        } else if (t0 === BET_PLACED) {
          const [up, amount] = decodeAbiParameters(parseAbiParameters("bool,uint256"), l.data);
          out.bets.push({ marketId: topicNum(l.topics[1]), roundIndex: topicNum(l.topics[2]), player: topicAddr(l.topics[3]), side: up ? "UP" : "DOWN", amount, tx, block });
        } else if (t0 === CLAIMED) {
          const [amount] = decodeAbiParameters(parseAbiParameters("uint256"), l.data);
          out.claims.push({ marketId: topicNum(l.topics[1]), roundIndex: topicNum(l.topics[2]), player: topicAddr(l.topics[3]), amount, tx, block });
        }
      }
      return out;
    },
    enabled: !!client && !!arena,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 12_000,
    retry: 2,
  });
  return data ?? null;
}
