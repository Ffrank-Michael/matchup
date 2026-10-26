"use client";

import Link from "next/link";
import * as React from "react";

import { AGENTS, type AgentKey } from "@/lib/agents";
import { COINS, DEFAULT_FRAME, marketFor, secondsToNextLock, TIME_FRAMES, type MarketKey } from "@/lib/markets";
import { hourPoints, lastPrice, usePriceFeed } from "@/lib/price-feed";
import { useNowSeconds } from "@/lib/use-now";
import { useAllRounds, useMarkets, useMyPositions } from "@/onchain";

import { AgentLeaderboard } from "./agent-leaderboard";
import { AgentStrip } from "./agent-strip";
import { ChartSheet } from "./chart-sheet";
import { LiveCalls } from "./live-calls";
import { MarketCard } from "./market-card";
import { WalletButton } from "./wallet-button";
import { YourCall, type Side } from "./your-call";
import { YourCalls } from "./your-calls";

// The agreed phone-first layout (docs/WEBSITE.md), top to bottom:
// Same components on phone and laptop, only arranged differently. Top to bottom: the market cards (one row, each with
// its last-hour line), the four agents (a row of robot heads, details of the selected one underneath), Your call, Live
// calls (of the selected market), Your calls, then the agent leaderboard. On a laptop it is two columns: the agents and
// Live calls in the left column beside Your call (both columns end at the same height), then Your calls beside the
// leaderboard. The full chart opens from the selected card (a sheet from the bottom on a phone, a centred panel on a laptop).
// Only the prices are real data right now: one Bitfinex feed (lib/price-feed.ts) supplies every number.
// Everything about rounds, money and agents says "not live yet" until the contract is deployed.

export function KairoHome() {
  const [selected, setSelected] = React.useState<MarketKey>("BTC");
  // The time frame (round length in seconds: 300 = 5 min, the default, or 600 = 10 min). Picked in the call panel.
  const [frame, setFrame] = React.useState<number>(DEFAULT_FRAME);
  const [side, setSide] = React.useState<Side | null>(null);
  const [amount, setAmount] = React.useState("1");
  const [backing, setBacking] = React.useState<AgentKey | null>(null);
  const [chartOpen, setChartOpen] = React.useState(false);
  const backingAgent = AGENTS.find((a) => a.key === backing) ?? null;
  const feed = usePriceFeed();
  const now = useNowSeconds();
  const nowMs = now === null ? null : now * 1000;
  // The selected coin + time frame is ONE market on the chain; the timer, call panel and live calls follow it.
  const market = marketFor(selected, frame);
  // Everything about rounds and money comes from the contract (read every few seconds); null until it has been read.
  const { markets: chainMarkets } = useMarkets();
  const { roundsByMarket } = useAllRounds(chainMarkets);
  const { positions } = useMyPositions(chainMarkets, roundsByMarket ?? {});
  const chainOf = (id: number) => chainMarkets?.find((c) => c.id === id) ?? null;
  // The start price of the round running now (the one before the next bettable round), once the contract has recorded it.
  const startPriceOf = (id: number) => {
    const c = chainOf(id);
    const r = c ? roundsByMarket?.[id]?.find((x) => x.roundIndex === c.nextRound - 1) : undefined;
    return r && r.startPrice !== null ? r.startPrice / 1e8 : null;
  };
  const startPrice = startPriceOf(market.id);
  const selectedChain = chainOf(market.id);
  // The money on the round that can be called now (the contract's next round).
  const nextRound = selectedChain ? roundsByMarket?.[market.id]?.find((x) => x.roundIndex === selectedChain.nextRound) : undefined;
  const priceOf = (key: MarketKey) => lastPrice(feed.candles[key]);
  const pointsOf = (key: MarketKey) => (nowMs === null ? null : hourPoints(feed.candles[key], nowMs));
  const feedFailed = feed.status === "reconnecting" && COINS.every((c) => feed.candles[c.key] === null);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-4 py-4 sm:px-8 sm:py-8">
      {/* Top bar */}
      <header className="kairo-rise mb-3 flex flex-nowrap items-center justify-between gap-3 px-1">
        <Link href="/" aria-label="Kairo Markets, home" className="flex items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/kairo-logo-inline.svg" alt="Kairo Markets" width={155} height={28} className="h-7 w-auto max-w-none" />
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/how-it-works"
            aria-label="How it works"
            className="grid size-8 place-items-center rounded-full border border-border text-[14px] font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-auto sm:border-0 sm:px-3 sm:py-1.5 sm:text-[13px] sm:font-medium"
          >
            <span className="sm:hidden" aria-hidden>
              ?
            </span>
            <span className="hidden sm:inline">How it works</span>
          </Link>
          <WalletButton />
        </div>
      </header>

      <div className="flex flex-col gap-3">
        {/* 1. One card per coin (name, live price, last hour): all three in ONE row, also on a phone. Tapping one picks that market in the call panel. */}
        <div role="group" aria-label="Markets" className="grid grid-cols-3 gap-2 lg:gap-3">
          {COINS.map((c, i) => {
            const m = marketFor(c.key, frame);
            return (
              <MarketCard
                key={c.key}
                market={m}
                price={priceOf(c.key)}
                points={pointsOf(c.key)}
                nowMs={nowMs}
                feedFailed={feedFailed}
                selected={c.key === selected}
                onSelect={() => setSelected(c.key)}
                onOpenChart={() => setChartOpen(true)}
                index={i}
              />
            );
          })}
        </div>

        {/* 2 to 6. The same tiles on phone and laptop, only arranged differently.
            Phone: one column in this order: agents, your call, live calls, your calls, leaderboard (the order classes).
            Laptop: two columns, rows stretch to the same height: [agents + live calls | your call], [your calls | leaderboard].
            The wrapper is "contents" on a phone, so its tiles take part in the one-column order. */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="contents lg:flex lg:flex-col lg:gap-3">
            <AgentStrip backing={backing} onBack={setBacking} className="order-1 lg:order-none" />
            <LiveCalls market={market} index={6} className="order-3 min-h-[200px] lg:order-none lg:flex-1" />
          </div>
          <YourCall
            frames={TIME_FRAMES}
            frame={market.roundSeconds}
            onFrame={setFrame}
            market={market}
            secondsLeft={now === null ? null : secondsToNextLock(now, market.lockOffset, market.roundSeconds)}
            side={side}
            onSide={setSide}
            amount={amount}
            onAmount={setAmount}
            backing={backingAgent}
            onClearBacking={() => setBacking(null)}
            chain={selectedChain ? { nextRound: selectedChain.nextRound, minStake: selectedChain.minStake, paused: selectedChain.paused, upTotal: nextRound?.upTotal ?? 0n, downTotal: nextRound?.downTotal ?? 0n } : null}
            index={5}
            className="order-2 lg:order-none"
          />
          <YourCalls positions={positions} roundsByMarket={roundsByMarket} index={7} className="order-4 min-h-[200px] lg:order-none" />
          <AgentLeaderboard backing={backing} onBack={setBacking} index={8} className="order-5 lg:order-none" />
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
