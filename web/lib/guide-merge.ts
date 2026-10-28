import type { AgentKey, AgentLive } from "./agents";
import type { GuideCalls } from "./use-guide-calls";

/**
 * Puts the agents' guide calls into what the site shows for each agent.
 *  - The call for the open round: a real call the agent sent on chain keeps its own badge and transaction; otherwise the guide call is
 *    shown (and the reason that goes with it). Backing an agent copies this call, so it works on every round the runner called.
 *  - The last five calls and the win rate come from the guide calls of this market. No money moves, so no profit is shown with them.
 */
export function withGuideCalls(live: Partial<Record<AgentKey, AgentLive>>, guide: GuideCalls | null): Partial<Record<AgentKey, AgentLive>> {
  if (!guide) return live;
  const out = { ...live };
  for (const key of Object.keys(guide) as AgentKey[]) {
    const g = guide[key];
    if (!g) continue;
    const mine: AgentLive = { ...out[key] };
    if (!mine.call && g.current) {
      if (g.current.s === "called" && g.current.c) {
        mine.call = g.current.c;
        mine.reason = g.current.t;
        mine.ruleReason = g.current.src === "random";
        mine.guide = true;
        mine.callAt = g.current.at;
        mine.skipped = undefined;
      } else if (g.current.s === "skipped") {
        mine.skipped = true;
        mine.guide = true;
      }
    }
    if (g.recent.length > 0) {
      mine.guideRecent = g.recent.map((p) => ({ round: p.r, call: p.c, at: p.at, res: p.res }));
      mine.guideDecided = g.decided;
      mine.winRate = g.decided > 0 ? g.wins / g.decided : undefined;
      mine.profit = undefined; // guide calls move no money
      mine.last5 = undefined;
    }
    out[key] = mine;
  }
  return out;
}
