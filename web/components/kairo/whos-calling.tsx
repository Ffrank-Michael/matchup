"use client";

import * as React from "react";

import { AGENTS, type AgentKey } from "@/lib/agents";
import { cn } from "@/lib/utils";

import { AgentBadge } from "./agent-badge";
import { NotLive, Tile } from "./tile";

type Tab = "agent" | "own";

/**
 * "Who's calling?": back one of the four house agents, or make your own call.
 * Each agent's current call, reason and win rate come from the contract, so they say "not live yet".
 * Picking an agent only remembers the choice; the Your call panel shows it as a chip.
 */
export function WhosCalling({
  backing,
  onBack,
  index,
  className,
}: {
  backing: AgentKey | null;
  onBack: (key: AgentKey | null) => void;
  index: number;
  className?: string;
}) {
  const [tab, setTab] = React.useState<Tab>("agent");

  return (
    <Tile title="Who's calling?" index={index} className={cn("p-4 sm:p-5", className)}>
      <div role="tablist" aria-label="Who is calling" className="grid grid-cols-2 gap-1 rounded-full border border-border bg-muted/40 p-1 text-[13px]">
        {(
          [
            ["agent", "Back an agent"],
            ["own", "My own call"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
              if (key === "own") onBack(null);
            }}
            className={cn(
              "rounded-full px-3 py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === key ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "agent" ? (
        <ul className="mt-3 flex flex-col gap-2">
          {AGENTS.map((agent) => {
            const on = backing === agent.key;
            return (
              <li key={agent.key}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onBack(on ? null : agent.key)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-2xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    on ? "bg-muted/60" : "border-border hover:border-foreground/25",
                  )}
                  style={on ? { borderColor: agent.colour } : undefined}
                >
                  <AgentBadge agent={agent} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-[14px] font-semibold">
                        Agent {agent.number} · {agent.name}
                      </span>
                      <span
                        className={cn("shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium", on ? "text-foreground" : "border-border text-muted-foreground")}
                        style={on ? { borderColor: agent.colour } : undefined}
                      >
                        {on ? "Backing" : "Back"}
                      </span>
                    </span>
                    <span className="mt-1 block text-[12px] leading-snug text-muted-foreground">{agent.how}</span>
                    <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        Current call: <NotLive className="text-[11px]" />
                      </span>
                      <span className="flex items-center gap-1.5">
                        Win rate: <NotLive className="text-[11px]" />
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 rounded-2xl border border-dashed border-border p-4 text-[13px] leading-relaxed text-muted-foreground">
          You pick UP or DOWN yourself in the <span className="font-medium text-foreground">Your call</span> panel.
        </p>
      )}
    </Tile>
  );
}
