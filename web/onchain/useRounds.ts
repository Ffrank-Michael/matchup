/**
 * src/onchain/useRounds.ts
 * ─────────────────────────────────────────────────────────────
 * Reads the last `count` rounds (default 8) plus the next callable one
 * for a given market, in ONE multicall.
 *
 * Round state mapping (from PredictionArena.sol RoundState enum):
 *   0 = Unsettled → "open" if still before endTime, "unsettled" if past it
 *   1 = SettledUp → "up"
 *   2 = SettledDown → "down"
 *   3 = Refunded → "refunded"
 *
 * startPrice and endPrice are stored as int256 with 8 Chainlink decimals.
 * We convert them to JS numbers (safe: Chainlink prices fit in float64).
 *
 * The SETTLE_WINDOW is 1 hour (from the contract constant); a round that is
 * Unsettled and past endTime + SETTLE_WINDOW is "refunded" in display even
 * if the contract has not run markRefunded() yet.
 */

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { ARENA_ABI } from "./abi";
import { ARENA_ADDRESSES } from "./addresses";
import { NETWORK } from "./env";
import type { Market } from "./useMarkets";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const REFETCH_MS = 5_000;
const SETTLE_WINDOW_SEC = 3_600; // 1 hour (SETTLE_WINDOW in PredictionArena.sol)

// ── Types ─────────────────────────────────────────────────────

export type RoundDisplayState =
  | "open"        // accepting calls; before lockTime
  | "locked"      // between lockTime and endTime; no more calls
  | "unsettled"   // past endTime but within settle window; waiting for settle
  | "up"          // settled UP
  | "down"        // settled DOWN
  | "refunded";   // refunded (any reason, including timeout)

export interface Round {
  marketId: number;
  roundIndex: number;
  /** USDC total staked on UP, in 6-decimal units */
  upTotal: bigint;
  /** USDC total staked on DOWN, in 6-decimal units */
  downTotal: bigint;
  /** Chainlink start price (8 decimals), or null if not recorded yet */
  startPrice: number | null;
  /** Chainlink end price (8 decimals), or null if not settled yet */
  endPrice: number | null;
  state: RoundDisplayState;
  /** Unix seconds when the round locks (no more calls) */
  lockTimeSec: number;
  /** Unix seconds when the round ends */
  endTimeSec: number;
}

// ── Internal helper ───────────────────────────────────────────
// RoundState enum values from PredictionArena.sol:
//   0 = Unsettled, 1 = SettledUp, 2 = SettledDown, 3 = Refunded

function toDisplayState(
  enumVal: number,
  roundIndex: number,
  market: Market,
  nowSec: number,
): RoundDisplayState {
  if (enumVal === 1) return "up";
  if (enumVal === 2) return "down";
  if (enumVal === 3) return "refunded";
  // Unsettled (0)
  const lt = market.startOffset + roundIndex * market.roundLength;
  const et = lt + market.roundLength;
  if (nowSec < lt) return "open";
  if (nowSec < et) return "locked";
  if (nowSec <= et + SETTLE_WINDOW_SEC) return "unsettled";
  // Past settle window and still Unsettled → timeout refund available
  return "refunded";
}

// ── Hook ──────────────────────────────────────────────────────

/**
 * Returns rounds for a market. `count` = number of past rounds plus the next.
 * Rounds are returned newest-first (highest index first).
 */
export function useRounds(
  market: Market | null | undefined,
  count = 8,
): { rounds: Round[] | null; isLoading: boolean } {
  const client = usePublicClient();
  const arenaAddress = ARENA_ADDRESSES[NETWORK];

  const { data, isLoading } = useQuery({
    queryKey: ["rounds", NETWORK, market?.id, market?.nextRound, count],
    queryFn: async (): Promise<Round[]> => {
      if (!arenaAddress || !market || !client) throw new Error("not ready");

      const now = Math.floor(Date.now() / 1000);
      const nextRound = market.nextRound;

      // We fetch: nextRound, nextRound-1, …, nextRound-count (inclusive)
      // Clamp to >= 0.
      const startIdx = Math.max(0, nextRound - count);
      const indexes = Array.from(
        { length: nextRound - startIdx + 1 },
        (_, i) => startIdx + i,
      );

      const calls = indexes.map((k) => ({
        address: arenaAddress,
        abi: ARENA_ABI,
        functionName: "rounds" as const,
        args: [BigInt(market.id), BigInt(k)],
      }));

      const results = await client.multicall({
        contracts: calls,
        allowFailure: false,
        multicallAddress: MULTICALL3,
        batchSize: 60_000,
      });

      const rounds: Round[] = indexes.map((k, i) => {
        const r = results[i];
        const [upTotal, downTotal, , , startPriceRaw, endPriceRaw, stateEnum] = r;

        const lt = market.startOffset + k * market.roundLength;
        const et = lt + market.roundLength;

        return {
          marketId: market.id,
          roundIndex: k,
          upTotal,
          downTotal,
          // Prices are stored as int256; 0 means "not recorded yet"
          startPrice: startPriceRaw !== 0n ? Number(startPriceRaw) : null,
          endPrice: endPriceRaw !== 0n ? Number(endPriceRaw) : null,
          state: toDisplayState(stateEnum, k, market, now),
          lockTimeSec: lt,
          endTimeSec: et,
        };
      });

      // Return newest first
      return rounds.reverse();
    },
    enabled: !!client && !!market && !!arenaAddress,
    refetchInterval: REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: REFETCH_MS,
    retry: 3,
  });

  return { rounds: data ?? null, isLoading };
}
