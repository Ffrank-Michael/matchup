"use client";

import * as React from "react";

import { AGENTS, type AgentKey, type AgentLive } from "@/lib/agents";
import { cn } from "@/lib/utils";

import { AgentAvatar } from "./agent-avatar";
import { CallPill } from "./call-pill";

/**
 * Phone only: the four agents as a compact row of avatars. Tap one to see how it decides (and its reason
 * for the open round, once the contract is live) and to back it. The full cards are further down, as a leaderboard.
 */
export function AgentStrip({
  backing,
  onBack,
  live = {},
  className,
}: {
  backing: AgentKey | null;
  onBack: (key: AgentKey | null) => void;
  live?: Partial<Record<AgentKey, AgentLive>>;
  className?: string;
}) {
  const [open, setOpen] = React.useState<AgentKey | null>(null);
  const agent = AGENTS.find((a) => a.key === open) ?? null;
  const info = agent ? live[agent.key] : undefined;
  const on = agent !== null && backing === agent.key;

  return (
    <section aria-label="Agents" className={cn("rounded-3xl border border-border bg-card p-3", className)}>
      <ul className="grid grid-cols-4 gap-1">
        {AGENTS.map((a) => {
          const selected = open === a.key;
          return (
            <li key={a.key}>
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`${a.name}${backing === a.key ? ", backing" : ""}`}
                onClick={() => setOpen(selected ? null : a.key)}
                className={cn(
                  "flex w-full flex-col items-center gap-1.5 rounded-2xl px-1 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "bg-muted/60" : "hover:bg-muted/30",
                )}
              >
                <AgentAvatar agent={a} call={live[a.key]?.call ?? null} size={52} />
                <span className="w-full truncate text-center text-[11px] font-medium leading-tight">{a.name}</span>
                <span
                  aria-hidden
                  className="h-1 w-5 rounded-full transition-opacity"
                  style={{ background: a.colour, opacity: backing === a.key ? 1 : 0 }}
                />
              </button>
            </li>
          );
        })}
      </ul>

      {agent ? (
        <div className="mt-2 rounded-2xl border bg-background/40 p-3" style={{ borderColor: agent.colour }}>
          <p className="text-[12px] text-muted-foreground">Agent {agent.number}</p>
          <p className="text-[15px] font-semibold leading-tight">
            {agent.name} <span className="font-medium" style={{ color: agent.colour }}>· {agent.tagline}</span>
          </p>
          <div className="mt-3">
            <CallPill call={info?.call ?? null} />
          </div>
          <p className="mt-2 text-[13px] italic leading-snug text-muted-foreground">
            {info?.reason ? <>&ldquo;{info.reason}&rdquo;</> : <span className="not-italic">{agent.how}</span>}
          </p>
          <button
            type="button"
            aria-pressed={on}
            onClick={() => onBack(on ? null : agent.key)}
            className={cn(
              "mt-3 h-11 w-full rounded-2xl border-2 text-[14px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on ? "text-background" : "hover:bg-muted/60",
            )}
            style={on ? { background: agent.colour, borderColor: agent.colour } : { borderColor: agent.colour, color: agent.colour }}
          >
            {on ? "Backing this agent" : "Back this agent"}
          </button>
        </div>
      ) : (
        <p className="mt-1 px-1 text-center text-[11px] text-muted-foreground">Tap an agent to see how it decides and back it.</p>
      )}
    </section>
  );
}
