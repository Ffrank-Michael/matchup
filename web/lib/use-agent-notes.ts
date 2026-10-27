"use client";

import { useQuery } from "@tanstack/react-query";

import type { AgentKey } from "./agents";

/** What an AI agent said about one round: its one-sentence reason ("called"), or that it could not decide ("skipped"). */
export type AgentNote = { r: number; a: AgentKey; s: "called" | "skipped"; c: "UP" | "DOWN" | null; t: string };

export const AI_NOTE_LABEL = "AI note by Gemini. Not checked, not advice.";

/** The notes of the given rounds of one market, keyed "round:agent". Read from the site's own route every few seconds. */
export function useAgentNotes(marketId: number, rounds: ReadonlyArray<number>): Map<string, AgentNote> {
  const list = [...new Set(rounds.filter((r) => Number.isInteger(r) && r >= 0))].sort((a, b) => a - b).slice(-8);
  const { data } = useQuery({
    queryKey: ["agentNotes", marketId, list.join(",")],
    enabled: list.length > 0,
    refetchInterval: 8_000,
    staleTime: 4_000,
    queryFn: async (): Promise<AgentNote[]> => {
      const res = await fetch(`/api/agent-notes?market=${marketId}&rounds=${list.join(",")}`, { cache: "no-store" });
      if (!res.ok) return [];
      const body = (await res.json()) as { notes?: AgentNote[] };
      return Array.isArray(body.notes) ? body.notes : [];
    },
  });
  return new Map((data ?? []).map((n) => [`${n.r}:${n.a}`, n]));
}

export const noteOf = (notes: Map<string, AgentNote> | undefined, round: number, agent: string): AgentNote | undefined => notes?.get(`${round}:${agent}`);
