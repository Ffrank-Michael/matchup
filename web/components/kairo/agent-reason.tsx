"use client";

import * as React from "react";

import type { Agent, AgentLive } from "@/lib/agents";
import { AI_NOTE_LABEL } from "@/lib/use-agent-notes";
import { cn } from "@/lib/utils";

import { AgentAvatar } from "./agent-avatar";

export const COULDNT_DECIDE = "Couldn't decide this round";

/**
 * The line under an agent's call on its card: the AI's one-sentence reason for the next round, "Couldn't decide this round"
 * when the AI did not answer, or (before there is a note) how the agent decides. The reason is the model's own words, so it is
 * labelled as such.
 */
export function AgentReason({ agent, info }: { agent: Agent; info?: AgentLive }) {
  if (info?.skipped) {
    return <p className="mt-2 text-[13px] leading-snug text-muted-foreground">{COULDNT_DECIDE}</p>;
  }
  if (info?.reason) {
    return (
      <p className="mt-2 text-[13px] leading-snug text-muted-foreground">
        <span className="italic">&ldquo;{info.reason}&rdquo;</span>
        {agent.ai && !info.ruleReason ? <span className="mt-0.5 block text-[11px] opacity-80">{AI_NOTE_LABEL}</span> : null}
      </p>
    );
  }
  return <p className="mt-2 text-[13px] leading-snug text-muted-foreground">{agent.how}</p>;
}

/** An agent's reason under its call in a list: two lines, tap to read all of it. */
export function CallNote({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-expanded={open}
      className={cn(
        "block w-full rounded-md text-left text-[12px] italic leading-snug text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !open && "line-clamp-2",
        className,
      )}
    >
      &ldquo;{text}&rdquo;
    </button>
  );
}

/** "Trend Follower: Couldn't decide this round", for each AI agent that skipped a round because the AI did not answer. */
export function SkippedNotes({ agents, className }: { agents: ReadonlyArray<Agent>; className?: string }) {
  if (agents.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-1", className)}>
      {agents.map((a) => (
        <li key={a.key} className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <AgentAvatar agent={a} size={22} />
          <span>
            <span className="font-medium" style={{ color: a.colour }}>{a.name}</span>: {COULDNT_DECIDE}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The honest label for the reasons shown in a list. */
export function AiNoteFootnote({ className }: { className?: string }) {
  return <p className={cn("text-[11px] text-muted-foreground opacity-80", className)}>Agent reasons: {AI_NOTE_LABEL}</p>;
}
