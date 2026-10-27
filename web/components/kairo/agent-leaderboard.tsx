"use client";

import * as React from "react";

import {
  AGENTS,
  type Agent,
  type AgentKey,
  type AgentLive,
} from "@/lib/agents";
import { formatUsd } from "@/lib/markets";
import { cn } from "@/lib/utils";

import { AgentAvatar } from "./agent-avatar";
import { AgentReason } from "./agent-reason";
import { CallPill } from "./call-pill";
import { Tile } from "./tile";

const NONE = (
  <span className="text-[12px] font-normal text-muted-foreground">
    No results yet
  </span>
);

const DOT = {
  won: { colour: "oklch(0.8 0.16 155)", label: "won" },
  lost: { colour: "oklch(0.66 0.2 22)", label: "lost" },
  refunded: { colour: "transparent", label: "refunded" },
} as const;

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-[14px] font-semibold tabular-nums">
        {value}
      </p>
    </div>
  );
}

export function AgentCard({
  agent,
  live,
  on,
  onToggle,
  compact,
}: {
  agent: Agent;
  live?: AgentLive;
  on: boolean;
  onToggle: () => void;
  compact?: boolean;
}) {
  const call = live?.call ?? null;
  const last5 = live?.last5;
  return (
    <div
      className={cn(
        "flex h-full flex-col rounded-3xl border bg-card transition-colors",
        compact ? "p-3.5" : "p-4",
        on ? "bg-muted/50" : "border-border",
      )}
      style={on ? { borderColor: agent.colour } : undefined}
    >
      <div className="flex items-center gap-4">
        <AgentAvatar agent={agent} call={call} size={compact ? 64 : 76} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] text-muted-foreground">
            Agent {agent.number}
          </p>
          <h3 className="truncate text-[17px] font-semibold leading-tight tracking-[-0.01em]">
            {agent.name}
          </h3>
          <p
            className="mt-0.5 text-[13px] font-medium"
            style={{ color: agent.colour }}
          >
            {agent.tagline}
          </p>
        </div>
      </div>

      {/* the current call */}
      <div className={compact ? "mt-3" : "mt-4"}>
        <CallPill call={call} />
        <AgentReason agent={agent} info={live} />
      </div>

      {/* numbers */}
      <div
        className={cn(
          "grid border-t border-border pt-3",
          compact
            ? "mt-3 grid-cols-3 gap-x-3"
            : "mt-4 grid-cols-2 gap-x-4 gap-y-3",
        )}
      >
        <Stat
          label="Win rate · last hour"
          value={
            live?.winRate === undefined
              ? NONE
              : `${Math.round(live.winRate * 100)}%`
          }
        />
        <Stat
          label="Profit · last hour"
          value={
            live?.profit === undefined
              ? NONE
              : `${live.profit >= 0 ? "+" : "-"}${formatUsd(Math.abs(live.profit))} USDC`
          }
        />
        <div className={compact ? undefined : "col-span-2"}>
          <p className="text-[11px] text-muted-foreground">Last 5 results</p>
          {last5 ? (
            <ul
              className="mt-1.5 flex gap-2"
              aria-label="Last five results, newest first"
            >
              {last5.map((r, i) => (
                <li
                  key={i}
                  title={DOT[r].label}
                  aria-label={DOT[r].label}
                  className="size-3.5 rounded-full border-2"
                  style={{
                    background: DOT[r].colour,
                    borderColor:
                      r === "refunded"
                        ? "var(--color-muted-foreground)"
                        : DOT[r].colour,
                  }}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-1">{NONE}</p>
          )}
        </div>
      </div>

      <div className={cn("mt-auto", compact ? "pt-3" : "pt-4")}>
        <button
          type="button"
          aria-pressed={on}
          onClick={onToggle}
          className={cn(
            "w-full rounded-2xl border-2 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "w-full",
            compact ? "h-10 text-[14px]" : "h-12 text-[15px]",
            on ? "text-background" : "hover:bg-muted/60",
          )}
          style={
            on
              ? { background: agent.colour, borderColor: agent.colour }
              : { borderColor: agent.colour, color: agent.colour }
          }
        >
          {on ? "Backing this agent" : "Back this agent"}
        </button>
      </div>
    </div>
  );
}

/**
 * The four agents as full cards: a leaderboard (one column on a phone, two columns from tablet width up).
 * Each agent's current call, win rate, profit and last five results are read from the chain (its own wallet's calls and
 * the rounds' results); an agent with nothing finished in the last hour shows "No results yet". It will be ranked by profit once there are results; until then the order is fixed.
 * Picking an agent only remembers the choice; the Your call panel shows it as a chip.
 */
export function AgentLeaderboard({
  backing,
  onBack,
  live = {},
  index,
  className,
}: {
  backing: AgentKey | null;
  onBack: (key: AgentKey | null) => void;
  /** What the contract says about each agent; empty until it is live */
  live?: Partial<Record<AgentKey, AgentLive>>;
  index: number;
  className?: string;
}) {
  return (
    <Tile
      title="Agent leaderboard"
      index={index}
      className={cn("p-4 sm:p-5", className)}
    >
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {AGENTS.map((agent) => (
          <li key={agent.key} className="flex flex-col">
            <AgentCard
              agent={agent}
              live={live[agent.key]}
              on={backing === agent.key}
              onToggle={() => onBack(backing === agent.key ? null : agent.key)}
            />
          </li>
        ))}
      </ul>
    </Tile>
  );
}
