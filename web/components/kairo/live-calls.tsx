"use client";

import { useConnection } from "wagmi";

import type { Market } from "@/lib/markets";
import { whoIs, whoName } from "@/lib/players";
import { usdc, useLiveCalls } from "@/onchain";

import { AgentAvatar } from "./agent-avatar";
import { NotLive, Tile } from "./tile";

const clock = (unixSec: number) => new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/**
 * Every call as it comes in, read from the contract's events: who made it (an agent by name, "You", or "Player 0x37…C4"),
 * the side, the amount, the time. Tapping a call opens that round in the watch sheet. Only real calls are shown.
 */
export function LiveCalls({ market, onOpen, index, className }: { market: Market; onOpen: (marketId: number, roundIndex: number) => void; index: number; className?: string }) {
  const { calls, isLoading } = useLiveCalls(market.id);
  const { address } = useConnection();
  return (
    <Tile title={`Live calls · ${market.name}`} index={index} className={className}>
      {calls === null ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border p-6">
          {isLoading ? <span className="font-mono text-[12px] text-muted-foreground">loading…</span> : <NotLive />}
        </div>
      ) : calls.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
          No calls on this market yet.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {calls.map((c) => {
            const who = whoIs(c.player, address);
            return (
              <li key={`${c.txHash}-${c.logIndex}`}>
                <button
                  type="button"
                  onClick={() => onOpen(market.id, c.roundIndex)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg py-2 text-left text-[13px] transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {who.kind === "agent" ? <AgentAvatar agent={who.agent} size={26} /> : null}
                    <span className={who.kind === "player" ? "truncate text-muted-foreground" : "truncate font-medium"} style={who.kind === "agent" ? { color: who.agent.colour } : undefined}>
                      {whoName(c.player, address)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full px-2.5 py-0.5 text-[12px] font-bold" style={{ background: c.side === "UP" ? "var(--color-up)" : "var(--color-down)", color: "oklch(0.24 0.06 135)" }}>
                      {c.side === "UP" ? "▲ UP" : "▼ DOWN"}
                    </span>
                    <span className="font-mono tabular-nums">{usdc(c.amount)}</span>
                    <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{c.time ? clock(c.time) : ""}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Tile>
  );
}
