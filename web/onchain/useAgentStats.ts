/**
 * onchain/useAgentStats.ts
 * The four house agents' record, read from the chain (written for the site): their calls are the arena's BetPlaced events
 * from their own wallets; whether each call won comes from the round, and the money from the round's totals (the same
 * sum as the contract's claim). Only rounds the site already holds count (about the last hour), so the numbers say
 * "last hour". Nothing here is made up: an agent with no finished call in that time simply has no numbers yet.
 */
import type { AgentKey, AgentLive } from "@/lib/agents";
import { AGENT_ADDRESSES } from "@/lib/players";

import { settledPayout } from "./payout";
import { useChainLog } from "./useChainLog";
import type { Round } from "./useRounds";

export function useAgentStats(roundsByMarket: Record<number, Round[]> | null, nextRoundOf: (marketId: number) => number | null, marketId: number): Partial<Record<AgentKey, AgentLive>> {
  const log = useChainLog();
  // each agent's own calls, from the chain log (about the last two hours)
  const data = log ? Object.fromEntries(AGENT_ADDRESSES.map((a) => [a.key, log.bets.filter((b) => b.player.toLowerCase() === a.address)])) : null;

  const result: Partial<Record<AgentKey, AgentLive>> = {};
  if (!data || !roundsByMarket) return result;
  const nextRound = nextRoundOf(marketId);

  for (const a of AGENT_ADDRESSES) {
    const calls = data[a.key] ?? [];
    const live: AgentLive = {};

    // its call for the round that can be called now on the selected market
    const open = nextRound === null ? undefined : calls.find((c) => c.marketId === marketId && c.roundIndex === nextRound);
    if (open) live.call = open.side;

    // one result per round (an agent may call a round more than once: its amounts add up)
    const perRound = new Map<string, { side: "UP" | "DOWN"; stake: bigint; round: Round }>();
    for (const c of calls) {
      const round = roundsByMarket[c.marketId]?.find((r) => r.roundIndex === c.roundIndex);
      if (!round) continue;
      const k = `${c.marketId}:${c.roundIndex}`;
      const prev = perRound.get(k);
      perRound.set(k, { side: c.side, stake: (prev?.stake ?? 0n) + c.amount, round });
    }
    const finished = [...perRound.values()].filter((x) => x.round.state === "up" || x.round.state === "down" || x.round.state === "refunded").sort((p, q) => q.round.endTimeSec - p.round.endTimeSec);
    if (finished.length > 0) {
      let wins = 0;
      let decided = 0;
      let profit = 0n;
      for (const f of finished) {
        if (f.round.state === "refunded") continue;
        decided++;
        const won = f.round.state === (f.side === "UP" ? "up" : "down");
        const winnerTotal = f.round.state === "up" ? f.round.upTotal : f.round.downTotal;
        const loserTotal = f.round.state === "up" ? f.round.downTotal : f.round.upTotal;
        if (won) {
          wins++;
          profit += settledPayout(f.stake, winnerTotal, loserTotal) - f.stake;
        } else profit -= f.stake;
      }
      if (decided > 0) {
        live.winRate = wins / decided;
        live.profit = Number(profit) / 1e6;
      }
      live.last5 = finished.slice(0, 5).map((f) => (f.round.state === "refunded" ? "refunded" : f.round.state === (f.side === "UP" ? "up" : "down") ? "won" : "lost"));
    }
    result[a.key] = live;
  }
  return result;
}
