"use client";

import * as React from "react";

import { AGENTS, type Agent, type AgentKey, type AgentLive } from "@/lib/agents";
import { formatUsd } from "@/lib/markets";
import { cn } from "@/lib/utils";

import { AgentAvatar } from "./agent-avatar";
import { CallPill } from "./call-pill";
import { NotLive, Tile } from "./tile";

type Tab = "agent" | "own";

const DOT = {
  won: { colour: "oklch(0.8 0.16 155)", label: "won" },
  lost: { colour: "oklch(0.66 0.2 22)", label: "lost" },
  refunded: { colour: "transparent", label: "refunded" },
} as const;

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-[14px] font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function AgentCard({ agent, live, on, onToggle }: { agent: Agent; live?: AgentLive; on: boolean; onToggle: () => void }) {
  const call = live?.call ?? null;
  const last5 = live?.last5;
  return (
    <div
      className={cn("rounded-3xl border bg-card p-4 transition-colors", on ? "bg-muted/50" : "border-border")}
      style={on ? { borderColor: agent.colour } : undefined}
    >
      <div className="flex items-center gap-4">
        <AgentAvatar agent={agent} call={call} size={76} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] text-muted-foreground">Agent {agent.number}</p>
          <h3 className="truncate text-[17px] font-semibold leading-tight tracking-[-0.01em]">{agent.name}</h3>
          <p className="mt-0.5 text-[13px] font-medium" style={{ color: agent.colour }}>
            {agent.tagline}
          </p>
        </div>
      </div>

      {/* the current call */}
      <div className="mt-4">
        <CallPill call={call} />
        <p className="mt-2 text-[13px] italic leading-snug text-muted-foreground">
          {live?.reason ? <>&ldquo;{live.reason}&rdquo;</> : <span className="not-italic">{agent.how}</span>}
        </p>
      </div>

      {/* numbers */}
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3">
        <Stat label="Win rate" value={live?.winRate === undefined ? <NotLive className="justify-start text-[12px] font-normal" /> : `${Math.round(live.winRate * 100)}%`} />
        <Stat
          label="Profit"
          value={
            live?.profit === undefined ? (
              <NotLive className="justify-start text-[12px] font-normal" />
            ) : (
              `${live.profit >= 0 ? "+" : "-"}${formatUsd(Math.abs(live.profit))} USDC`
            )
          }
        />
        <div className="col-span-2">
          <p className="text-[11px] text-muted-foreground">Last 5 calls</p>
          {last5 ? (
            <ul className="mt-1.5 flex gap-2" aria-label="Last five results, newest first">
              {last5.map((r, i) => (
                <li
                  key={i}
                  title={DOT[r].label}
                  aria-label={DOT[r].label}
                  className="size-3.5 rounded-full border-2"
                  style={{ background: DOT[r].colour, borderColor: r === "refunded" ? "var(--color-muted-foreground)" : DOT[r].colour }}
                />
              ))}
            </ul>
          ) : (
            <NotLive className="mt-1 justify-start text-[12px]" />
          )}
        </div>
      </div>

      <button
        type="button"
        aria-pressed={on}
        onClick={onToggle}
        className={cn(
          "mt-4 h-12 w-full rounded-2xl border-2 text-[15px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          on ? "text-background" : "hover:bg-muted/60",
        )}
        style={on ? { background: agent.colour, borderColor: agent.colour } : { borderColor: agent.colour, color: agent.colour }}
      >
        {on ? "Backing this agent" : "Back this agent"}
      </button>
    </div>
  );
}

/**
 * "Who's calling?": back one of the four house agents, or make your own call.
 * Each agent's current call, reason and win rate come from the contract, so they say "not live yet".
 * Picking an agent only remembers the choice; the Your call panel shows it as a chip.
 */
export function WhosCalling({
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
  const [tab, setTab] = React.useState<Tab>("agent");

  return (
    <Tile
      title={
        <>
          <span className="lg:hidden">Agent leaderboard</span>
          <span className="hidden lg:inline">Who&apos;s calling?</span>
        </>
      }
      index={index}
      className={cn("p-4 sm:p-5", className)}
    >
      <div role="tablist" aria-label="Who is calling" className="hidden grid-cols-2 gap-1 lg:grid rounded-full border border-border bg-muted/40 p-1 text-[13px]">
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

      <ul className={cn("flex flex-col gap-3 lg:mt-3", tab === "own" && "lg:hidden")}>
        {AGENTS.map((agent) => (
          <li key={agent.key}>
            <AgentCard agent={agent} live={live[agent.key]} on={backing === agent.key} onToggle={() => onBack(backing === agent.key ? null : agent.key)} />
          </li>
        ))}
      </ul>
      {tab === "own" ? (
        <p className="mt-3 hidden rounded-2xl lg:block border border-dashed border-border p-4 text-[13px] leading-relaxed text-muted-foreground">
          You pick UP or DOWN yourself in the <span className="font-medium text-foreground">Your call</span> panel.
        </p>
      ) : null}
    </Tile>
  );
}
