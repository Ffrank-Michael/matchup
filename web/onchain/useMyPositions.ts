/**
 * src/onchain/useMyPositions.ts
 * ─────────────────────────────────────────────────────────────
 * Reads positions and claimable amounts for the connected wallet,
 * across all markets and the rounds in the provided `rounds` map.
 *
 * Claimable computation (mirrors _computePayout in PredictionArena.sol):
 *
 *   Refund (state Refunded, or Unsettled past endTime+SETTLE_WINDOW):
 *     amount = pos.up + pos.down   [rule E2: refund is exact stake, no fee]
 *
 *   Win (SettledUp and pos.up > 0, or SettledDown and pos.down > 0):
 *     loser = downTotal (for SettledUp) or upTotal (for SettledDown)
 *     winner = upTotal (for SettledUp) or downTotal (for SettledDown)
 *     stake = pos.up (SettledUp) or pos.down (SettledDown)
 *     fee = floor(loser * FEE_BPS / BPS)         [FEE_BPS=200, BPS=10000 from contract]
 *     D   = loser - fee                           [distributable to winners]
 *     bonus = floor(stake * D / winner)           [pro-rata share]
 *     amount = stake + bonus                      [rule E2]
 *
 *   Loser or no position:
 *     kind = "none", amount = 0n
 *
 * We call `claimable()` on-chain for each position rather than recomputing
 * off-chain to stay 100% correct as the contract accumulates dust.
 * The off-chain formula is used only to classify the kind ("win"|"refund"|"none")
 * so the UI can show the right label.
 */

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { useConnection } from "wagmi";
import { ARENA_ABI } from "./abi";
import { ARENA_ADDRESSES } from "./addresses";
import { NETWORK } from "./env";
import type { Market } from "./useMarkets";
import type { Round } from "./useRounds";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const REFETCH_MS = 5_000;
// SETTLE_WINDOW from PredictionArena.sol constant (1 hour)
const SETTLE_WINDOW_SEC = 3_600;

// ── Types ─────────────────────────────────────────────────────

export type ClaimableKind =
  | "win"     // round settled in the player's favour
  | "refund"  // round refunded (any reason, including timeout)
  | "partial" // lost, but part of the stake was not matched and comes back (matched calls)
  | "none";   // lost with nothing coming back, no position, or already claimed

export interface MyPosition {
  marketId: number;
  roundIndex: number;
  /** USDC called on UP, 6-decimal units */
  up: bigint;
  /** USDC called on DOWN, 6-decimal units */
  down: bigint;
  claimed: boolean;
  /** What the player can claim */
  claimableKind: ClaimableKind;
  /** Amount in 6-decimal USDC units; 0n if claimableKind === "none" */
  claimableAmount: bigint;
}

// ── Internal: classify without on-chain call ──────────────────

function classifyKind(
  pos: { up: bigint; down: bigint; claimed: boolean },
  round: Round,
  nowSec: number,
): ClaimableKind {
  if (pos.claimed) return "none";
  if (pos.up === 0n && pos.down === 0n) return "none";

  // Refund cases: any settled Refunded state, or Unsettled past settle window
  if (round.state === "refunded") return "refund";
  if (
    round.state === "unsettled" &&
    nowSec > round.endTimeSec + SETTLE_WINDOW_SEC
  )
    return "refund";

  // Win cases
  if (round.state === "up" && pos.up > 0n) return "win";
  if (round.state === "down" && pos.down > 0n) return "win";

  return "none";
}

// ── Hook ──────────────────────────────────────────────────────

/**
 * Returns all positions the connected wallet has across the provided rounds.
 * Returns only entries where the player has called (up > 0 or down > 0).
 */
export function useMyPositions(
  markets: Market[] | null,
  roundsByMarket: Record<number, Round[]>,
): { positions: MyPosition[] | null; isLoading: boolean } {
  const client = usePublicClient();
  const { address } = useConnection();
  const arenaAddress = ARENA_ADDRESSES[NETWORK];

  // Build the list of (marketId, roundIndex) pairs to query
  const queries = markets
    ? markets.flatMap((m) => {
        const rounds = roundsByMarket[m.id] ?? [];
        return rounds.map((r) => ({ marketId: m.id, roundIndex: r.roundIndex }));
      })
    : [];

  const { data, isLoading } = useQuery({
    queryKey: [
      "myPositions",
      NETWORK,
      address,
      // Re-fetch when rounds change (state changes after settle)
      markets?.map((m) => m.nextRound).join(","),
      Object.values(roundsByMarket).reduce((n, list) => n + list.length, 0),
    ],
    queryFn: async (): Promise<MyPosition[]> => {
      if (!arenaAddress || !address || !client || queries.length === 0) {
        return [];
      }

      const now = Math.floor(Date.now() / 1000);

      // Batch: position + claimable for each (market, round)
      const positionCalls = queries.map((q) => ({
        address: arenaAddress,
        abi: ARENA_ABI,
        functionName: "positions" as const,
        args: [BigInt(q.marketId), BigInt(q.roundIndex), address],
      }));

      const claimableCalls = queries.map((q) => ({
        address: arenaAddress,
        abi: ARENA_ABI,
        functionName: "claimable" as const,
        args: [BigInt(q.marketId), BigInt(q.roundIndex), address],
      }));

      const results = await client.multicall({
        contracts: [...positionCalls, ...claimableCalls],
        allowFailure: true, // allow partial failure; skip errored entries
        multicallAddress: MULTICALL3,
        batchSize: 60_000,
      });

      const n = queries.length;
      const positions: MyPosition[] = [];

      for (let i = 0; i < n; i++) {
        const posResult = results[i];
        const claimResult = results[n + i];

        // Skip failed reads — return null → UI shows "not live yet"
        if (posResult.status === "failure") continue;

        const [upRaw, downRaw, claimed] = posResult.result as [bigint, bigint, boolean];

        // Skip if the player has no position here
        if (upRaw === 0n && downRaw === 0n) continue;

        const q = queries[i];
        // Find the matching round for state classification
        const roundsForMarket = roundsByMarket[q.marketId] ?? [];
        const round = roundsForMarket.find((r) => r.roundIndex === q.roundIndex);
        if (!round) continue;

        let kind = classifyKind({ up: upRaw, down: downRaw, claimed }, round, now);
        const claimableAmount =
          claimResult.status === "success"
            ? (claimResult.result as bigint)
            : 0n;
        // matched calls: a lost call on the bigger side still has its unmatched part to claim (claimable() says how much)
        if (kind === "none" && !claimed && claimableAmount > 0n && (round.state === "up" || round.state === "down")) kind = "partial";

        positions.push({
          marketId: q.marketId,
          roundIndex: q.roundIndex,
          up: upRaw,
          down: downRaw,
          claimed,
          claimableKind: kind,
          claimableAmount,
        });
      }

      return positions;
    },
    enabled: !!client && !!address && !!arenaAddress && queries.length > 0,
    refetchInterval: REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: REFETCH_MS,
    retry: 3,
  });

  return { positions: data ?? null, isLoading };
}
