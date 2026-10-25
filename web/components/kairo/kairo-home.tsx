"use client";

import * as React from "react";

import { AGENTS, type AgentKey } from "@/lib/agents";
import { MARKETS, secondsToNextLock, type MarketKey } from "@/lib/markets";
import { hourPoints, lastPrice, usePriceFeed } from "@/lib/price-feed";
import { useNowSeconds } from "@/lib/use-now";

import { AgentStrip } from "./agent-strip";
import { ChartSheet } from "./chart-sheet";
import { LiveCalls } from "./live-calls";
import { MarketCard } from "./market-card";
import { WalletButton } from "./wallet-button";
import { WhosCalling } from "./whos-calling";
import { YourCall, type Side } from "./your-call";
import { YourCalls } from "./your-calls";

// The agreed phone-first layout (docs/WEBSITE.md), top to bottom:
// Phone: market cards (one row, each with its last-hour line), a row of four agents, Your call, Live calls, Your calls,
// then the agent leaderboard. The full chart opens from the selected card in a sheet from the bottom.
// Laptop: the cards, then Who's calling and Your call half and half, then Live calls and Your calls.
// Only the prices are real data right now: one Bitfinex feed (lib/price-feed.ts) supplies every number.
// Everything about rounds, money and agents says "not live yet" until the contract is deployed.

export function KairoHome() {
  const [selected, setSelected] = React.useState<MarketKey>("BTC");
  const [side, setSide] = React.useState<Side | null>(null);
  const [amount, setAmount] = React.useState("");
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
        <WalletButton />
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

        {/* 2. Phone only: a compact row of the four agents (tap one to see its reason and back it) */}
        <AgentStrip backing={backing} onBack={setBacking} className="lg:hidden" />

        {/* Phone order: Your call, Live calls, Your calls, then the agent leaderboard.
            Laptop order (source order): Who's calling and Your call half and half, then Live calls and Your calls. */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <WhosCalling backing={backing} onBack={setBacking} index={4} className="order-4 lg:order-none" />
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
            className="order-1 lg:order-none"
          />
          <LiveCalls index={6} className="order-2 min-h-[200px] lg:order-none" />
          <YourCalls index={7} className="order-3 min-h-[200px] lg:order-none" />
        </div>
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
