"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

// Step C1: the page frame only. Same tile look as the Web3 Bento (rounded 26px cards,
// quiet titles, rise-in animation, lime and lilac), but no demo content and no numbers.
// Every tile says "not live yet" until the contract is deployed.

const MARKETS = ["BTC", "ETH", "SOL"] as const;
type Market = (typeof MARKETS)[number];

// The solid lime tile uses the same dark ink as the Bento staking tile.
const INK = "oklch(0.24 0.06 135)";

function NotLive({ onAccent }: { onAccent?: boolean }) {
  return (
    <p
      className="flex flex-1 items-center justify-center gap-2 font-mono text-[12px] text-muted-foreground"
      style={onAccent ? { color: INK, opacity: 0.7 } : undefined}
    >
      <span
        className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none"
        aria-hidden
      />
      not live yet
    </p>
  );
}

function Tile({
  title,
  className,
  index,
  accent,
}: {
  title: string;
  className?: string;
  /** Position in the page, used to stagger the rise-in animation */
  index: number;
  accent?: boolean;
}) {
  return (
    <section
      className={cn(
        "kairo-rise relative flex min-w-0 flex-col overflow-hidden rounded-[26px] border p-5",
        accent ? "border-transparent bg-up" : "border-border bg-card text-card-foreground",
        className,
      )}
      style={{ animationDelay: `${index * 70}ms`, ...(accent ? { color: INK } : null) }}
    >
      <h2
        className={cn("mb-4 text-[13px] font-medium", accent ? "font-semibold opacity-75" : "text-muted-foreground")}
      >
        {title}
      </h2>
      <NotLive onAccent={accent} />
    </section>
  );
}

export function KairoHome() {
  const [market, setMarket] = React.useState<Market>("BTC");

  return (
    <div className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-4 sm:px-8 sm:py-8">
      {/* Top bar */}
      <header className="kairo-rise mb-3 flex flex-wrap items-center gap-x-3 gap-y-3 px-1">
        <div className="order-1 flex flex-1 items-center gap-2.5">
          <span className="size-2.5 rounded-full bg-up" aria-hidden />
          <span className="text-[17px] font-semibold tracking-[-0.02em]">Kairo Markets</span>
        </div>

        <div
          role="tablist"
          aria-label="Market"
          className="order-3 grid w-full grid-cols-3 rounded-full border border-border p-0.5 sm:order-2 sm:inline-flex sm:w-auto"
        >
          {MARKETS.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={m === market}
              onClick={() => setMarket(m)}
              className={cn(
                "rounded-full px-4 py-1.5 font-mono text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                m === market ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="order-2 flex justify-end sm:order-3 sm:flex-1">
          <button
            type="button"
            disabled
            title="Not working yet"
            className="cursor-not-allowed rounded-full bg-foreground px-3.5 py-1.5 font-mono text-[12px] font-semibold text-background opacity-60"
          >
            Connect wallet
          </button>
        </div>
      </header>

      {/* On phones the tiles stack in this order: round and countdown, then the call, then the rest. */}
      <main className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:auto-rows-[minmax(190px,auto)] lg:grid-cols-4">
        <Tile index={1} title={`Live round · ${market}`} className="min-h-[200px] sm:col-span-2 lg:col-span-2 lg:col-start-1 lg:row-start-1" />
        <Tile index={2} title="Make your call" accent className="min-h-[220px] sm:col-span-2 lg:col-span-1 lg:col-start-3 lg:row-span-2 lg:row-start-1" />
        <Tile index={3} title={`Price chart · ${market}`} className="min-h-[300px] sm:col-span-2 lg:col-span-2 lg:col-start-1 lg:row-span-2 lg:row-start-2" />
        <Tile index={4} title="UP vs DOWN" className="min-h-[180px] lg:col-start-4 lg:row-start-1" />
        <Tile index={5} title="Pot split" className="min-h-[180px] lg:col-start-4 lg:row-start-2" />
        <Tile index={6} title="Agents" className="min-h-[220px] sm:col-span-2 lg:col-span-2 lg:col-start-3 lg:row-start-3" />
        <Tile index={7} title="Last 30 results" className="min-h-[180px] sm:col-span-2 lg:col-span-2 lg:col-start-1 lg:row-start-4" />
        <Tile index={8} title="Live calls" className="min-h-[180px] sm:col-span-2 lg:col-span-2 lg:col-start-3 lg:row-start-4" />
      </main>
    </div>
  );
}
