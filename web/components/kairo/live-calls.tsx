"use client";

import type { Market } from "@/lib/markets";
import { shortAddress, txLink, usdc, useLiveCalls } from "@/onchain";

import { NotLive, Tile } from "./tile";

const clock = (unixSec: number) => new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/**
 * Every call as it comes in, read from the contract's events: who made it (a short wallet address), the side, the amount,
 * the time. Only real calls are shown; nothing here is made up. An agent's name and its reason come with a later step.
 */
export function LiveCalls({ market, index, className }: { market: Market; index: number; className?: string }) {
  const { calls, isLoading } = useLiveCalls(market.id);
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
          {calls.map((c) => (
            <li key={`${c.txHash}-${c.logIndex}`} className="flex items-center justify-between gap-3 py-2 text-[13px]">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="rounded-full px-2.5 py-0.5 text-[12px] font-bold"
                  style={{ background: c.side === "UP" ? "var(--color-up)" : "var(--color-down)", color: "oklch(0.24 0.06 135)" }}
                >
                  {c.side === "UP" ? "▲ UP" : "▼ DOWN"}
                </span>
                <span className="font-mono tabular-nums">{usdc(c.amount)}</span>
              </span>
              <a
                href={txLink(c.txHash) ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate text-right font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {shortAddress(c.player)} · {c.time ? clock(c.time) : ""}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Tile>
  );
}
