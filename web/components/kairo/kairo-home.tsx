"use client";

import Link from "next/link";
import * as React from "react";

import { AGENTS, type AgentKey } from "@/lib/agents";
import { MARKETS, secondsToNextLock, type MarketKey } from "@/lib/markets";
import { hourPoints, lastPrice, usePriceFeed } from "@/lib/price-feed";
import { useNowSeconds } from "@/lib/use-now";

import { AgentLeaderboard, AgentStack } from "./agent-leaderboard";
import { AgentStrip } from "./agent-strip";
import { ChartSheet } from "./chart-sheet";
import { LiveCalls } from "./live-calls";
import { MarketCard } from "./market-card";
import { WalletButton } from "./wallet-button";
import { YourCall, type Side } from "./your-call";
import { YourCalls } from "./your-calls";

// The agreed phone-first layout (docs/WEBSITE.md), top to bottom:
// Same components on phone and laptop, only arranged differently. Top to bottom: the market cards (one row, each with
// its last-hour line), the four agents, Your call, Live calls, Your calls, then the agent leaderboard. On a laptop the
// the four agent cards are stacked beside Your call, and Live calls sit beside Your calls. The full chart opens from the selected card
// (a sheet from the bottom on a phone, a centred panel on a laptop).
// Only the prices are real data right now: one Bitfinex feed (lib/price-feed.ts) supplies every number.
// Everything about rounds, money and agents says "not live yet" until the contract is deployed.

export function KairoHome() {
  const [selected, setSelected] = React.useState<MarketKey>("BTC");
  const [side, setSide] = React.useState<Side | null>(null);
  const [amount, setAmount] = React.useState("1");
  const [backing, setBacking] = React.useState<AgentKey | null>(null);
  const [chartOpen, setChartOpen] = React.useState(false);
  // The selected market's start price comes from the contract once the round has started; null until it is live.
  const startPrice: number | null = null;
  const backingAgent = AGENTS.find((a) => a.key === backing) ?? null;
  const feed = usePriceFeed();
  const now = useNowSeconds();
  const nowMs = now === null ? null : now * 1000;
  const market = MARKETS.find((m) => m.key === selected) ?? MARKETS[0];
  const priceOf = (key: MarketKey) => lastPrice(feed.candles[key]);
  const pointsOf = (key: MarketKey) => (nowMs === null ? null : hourPoints(feed.candles[key], nowMs));
  const feedFailed = feed.status === "reconnecting" && MARKETS.every((m) => feed.candles[m.key] === null);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-4 py-4 sm:px-8 sm:py-8">
      {/* Top bar */}
      <header className="kairo-rise mb-3 flex items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2.5">
          <span className="size-2.5 rounded-full bg-up" aria-hidden />
          <span className="text-[17px] font-semibold tracking-[-0.02em]">Kairo Markets</span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/how-it-works"
            className="rounded-full px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            How it works
          </Link>
          <WalletButton />
        </div>
      </header>

      <div className="flex flex-col gap-3">
        {/* 1. One card per market: all three in ONE row, also on a phone */}
        <div role="group" aria-label="Markets" className="grid grid-cols-3 gap-2 lg:gap-3">
          {MARKETS.map((m, i) => (
            <MarketCard
              key={m.key}
              market={m}
              price={priceOf(m.key)}
              points={pointsOf(m.key)}
              nowMs={nowMs}
              feedFailed={feedFailed}
              secondsLeft={now === null ? null : secondsToNextLock(now, m.lockOffset)}
              selected={m.key === selected}
              startPrice={m.key === selected ? startPrice : null}
              onSelect={() => setSelected(m.key)}
              onOpenChart={() => setChartOpen(true)}
              index={i}
            />
          ))}
        </div>

        {/* 2 to 5. The same four tiles on phone and laptop, only arranged differently:
            phone = one column in this order, laptop = two columns (agents | your call, then live calls | your calls). */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <AgentStrip backing={backing} onBack={setBacking} className="lg:hidden" />
          <AgentStack backing={backing} onBack={setBacking} index={4} className="hidden lg:flex" />
          <YourCall
            market={market}
            secondsLeft={now === null ? null : secondsToNextLock(now, market.lockOffset)}
            side={side}
            onSide={setSide}
            amount={amount}
            onAmount={setAmount}
            backing={backingAgent}
            onClearBacking={() => setBacking(null)}
            index={5}
          />
          <LiveCalls index={6} className="min-h-[200px]" />
          <YourCalls index={7} className="min-h-[200px]" />
        </div>

        {/* 6. The full agent cards as a leaderboard */}
        <AgentLeaderboard backing={backing} onBack={setBacking} index={8} className="lg:hidden" />
      </div>

      <ChartSheet
        open={chartOpen}
        onClose={() => setChartOpen(false)}
        market={market}
        price={priceOf(market.key)}
        points={pointsOf(market.key)}
        candles={feed.candles[market.key]}
        nowMs={nowMs}
        feedFailed={feedFailed}
        startPrice={startPrice}
      />

      <footer className="mt-4 px-1 text-[11px] text-muted-foreground">
        Prices: last trade on{" "}
        <a href="https://www.bitfinex.com" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
          Bitfinex
        </a>
        , live.{" "}
        {feed.status === "reconnecting" && !feedFailed ? "Connection lost just now, showing the last prices while it reconnects." : null}
      </footer>
    </div>
  );
}
