"use client";

import { useQuery } from "@tanstack/react-query";

import { NETWORK } from "@/onchain/env";

import type { AgentKey } from "./agents";

export const GUIDE_LABEL = "Guide call, no money";

/** One agent's call for the open round (or that it could not decide), as saved when the call window opened. */
export type GuideCall = { c: "UP" | "DOWN" | null; t: string; at: number; s: "called" | "skipped"; src: "ai" | "random" };
/** An earlier call of that agent on the same market and how it ended: won, lost, no result (price unchanged) or pending. */
export type GuidePast = { r: number; c: "UP" | "DOWN"; at: number; res: "won" | "lost" | "none" | "pending" };
export type GuideAgent = { current: GuideCall | null; recent: GuidePast[]; wins: number; decided: number };
export type GuideCalls = Partial<Record<AgentKey, GuideAgent>>;

/**
 * The agents' guide calls for one market's open round, plus their last five calls on that market and win rate. Read from the
 * site's own route (the mainnet runner makes them; they move no money). Only the mainnet site has them. null until read.
 */
export function useGuideCalls(marketId: number, openRound: number | null): GuideCalls | null {
  const { data } = useQuery({
    queryKey: ["guideCalls", marketId, openRound],
    enabled: NETWORK === "mainnet" && openRound !== null,
    refetchInterval: 20_000,
    staleTime: 10_000,
    queryFn: async (): Promise<GuideCalls> => {
      const res = await fetch(`/api/guide-calls?market=${marketId}&round=${openRound}`, { cache: "no-store" });
      if (!res.ok) return {};
      const body = (await res.json()) as { agents?: GuideCalls };
      return body.agents && typeof body.agents === "object" ? body.agents : {};
    },
  });
  return data ?? null;
}
