"use client";

import Link from "next/link";
import * as React from "react";
import { useConnection } from "wagmi";

import { AGENTS, type AgentKey } from "@/lib/agents";
import { rememberBacked } from "@/lib/backed";
import {
  COINS,
  DEFAULT_FRAME,
  marketFor,
  secondsToNextLock,
  TIME_FRAMES,
  type MarketKey,
} from "@/lib/markets";
import { hourPoints, lastPrice, usePriceFeed } from "@/lib/price-feed";
import { useNowSeconds } from "@/lib/use-now";
import { useStartPrice } from "@/lib/use-start-price";
import {
  useAgentStats,
  useAllRounds,
  useMarkets,
  useMyPositions,
} from "@/onchain";

import { AgentLeaderboard } from "./agent-leaderboard";
import { AgentStrip } from "./agent-strip";
import { ChartSheet } from "./chart-sheet";
import { LiveCalls } from "./live-calls";
import { LivePill } from "./live-pill";
import { MarketCard } from "./market-card";
import { PhoneMenu } from "./phone-menu";
import { RoundCardProvider } from "./round-card";
import { WalletButton } from "./wallet-button";
import { WelcomeBanner } from "./welcome-banner";
import { YourCall, type Side } from "./your-call";
import { WatchSheet, type Watch } from "./watch-sheet";
import { YourCalls } from "./your-calls";

// The agreed phone-first layout (docs/WEBSITE.md), top to bottom:
// Same components on phone and laptop, only arranged differently. Top to bottom: the market cards (one row, each with
// its last-hour line), the four agents (a row of robot heads, details of the selected one underneath), Your call, Live
// calls (of the selected market), Your calls, then the agent leaderboard. On a laptop it is two columns: the agents and
// Live calls in the left column beside Your call (both columns end at the same height), then Your calls beside the
// leaderboard. The full chart opens from the selected card (a sheet from the bottom on a phone, a centred panel on a laptop).
// Only the prices are real data right now: one Bitfinex feed (lib/price-feed.ts) supplies every number.
// Rounds, money and the agents' records are read from the contract; prices come from Bitfinex.

export function KairoHome() {
  const [selected, setSelected] = React.useState<MarketKey>("BTC");
  // The time frame (round length in seconds: 300 = 5 min, the default, or 600 = 10 min). Picked in the call panel.
  const [frame, setFrame] = React.useState<number>(DEFAULT_FRAME);
  const [side, setSide] = React.useState<Side | null>(null);
  const [amount, setAmount] = React.useState("1");
  const [backing, setBacking] = React.useState<AgentKey | null>(null);
  const [chartOpen, setChartOpen] = React.useState(false);
  // the round open in the watch sheet (after a call, or when a call is tapped in Your calls or Live calls)
  const [watch, setWatch] = React.useState<Watch | null>(null);
  const openWatch = React.useCallback(
    (marketId: number, roundIndex: number) =>
      setWatch({ marketId, roundIndex }),
    [],
  );
  const closeWatch = React.useCallback(() => setWatch(null), []);
  const { address: me } = useConnection();
  const backingAgent = AGENTS.find((a) => a.key === backing) ?? null;
  // Tapping "Back this agent": remember it, and on a phone (one column) bring the call card into view.
  const backAgent = React.useCallback((key: AgentKey | null) => {
    setBacking(key);
    if (key !== null && window.matchMedia("(max-width: 1023px)").matches) {
      document.getElementById("your-call")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);
  const feed = usePriceFeed();
  const now = useNowSeconds();
  const nowMs = now === null ? null : now * 1000;
  // The selected coin + time frame is ONE market on the chain; the timer, call panel and live calls follow it.
  const market = marketFor(selected, frame);
  // Everything about rounds and money comes from the contract (read every few seconds); null until it has been read.
  const { markets: chainMarkets } = useMarkets();
  const { roundsByMarket } = useAllRounds(chainMarkets);
  const { positions } = useMyPositions(chainMarkets, roundsByMarket ?? {});
  const chainOf = (id: number) =>
    chainMarkets?.find((c) => c.id === id) ?? null;
  // The start price of the round running now (the one before the next bettable round), once the contract has recorded it.
  const selectedChain = chainOf(market.id);
  // each agent's record and its call for the selected market's open round, read from the chain
  const agentLive = useAgentStats(
    roundsByMarket,
    (id) => chainOf(id)?.nextRound ?? null,
    market.id,
  );
  // The contract records a round's start price when it settles it; while the round runs the site finds the same trade the runner uses.
  const runningRound = selectedChain
    ? roundsByMarket?.[market.id]?.find(
        (x) => x.roundIndex === selectedChain.nextRound - 1,
      )
    : undefined;
  const startPrice = useStartPrice(
    market.key,
    runningRound?.lockTimeSec ?? null,
    now,
    runningRound && runningRound.startPrice !== null
      ? runningRound.startPrice / 1e8
      : null,
  );
  // The money on the round that can be called now (the contract's next round).
  const nextRound = selectedChain
    ? roundsByMarket?.[market.id]?.find(
        (x) => x.roundIndex === selectedChain.nextRound,
      )
    : undefined;
  const priceOf = (key: MarketKey) => lastPrice(feed.candles[key]);
  const pointsOf = (key: MarketKey) =>
    nowMs === null ? null : hourPoints(feed.candles[key], nowMs);
  const feedFailed =
    feed.status === "reconnecting" &&
    COINS.every((c) => feed.candles[c.key] === null);

  return (
    <RoundCardProvider roundsByMarket={roundsByMarket} nowSec={now} me={me}>
      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-4 py-4 sm:px-8 sm:py-8">
        {/* Top bar */}
        <header className="kairo-rise mb-3 flex flex-nowrap items-center justify-between gap-3 px-1">
          <Link
            href="/"
            aria-label="Kairo Markets, home"
            className="flex items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/kairo-logo-inline.svg"
              alt="Kairo Markets"
              width={155}
              height={28}
              className="h-7 w-auto max-w-none"
            />
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href="/how-it-works"
              className="hidden px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block"
            >
              How it works
            </Link>
            <PhoneMenu />
            <WalletButton />
          </div>
        </header>
        <WelcomeBanner />

        <div className="flex flex-col gap-3">
          {/* 1. One card per coin (name, live price, last hour): all three in ONE row, also on a phone. Tapping one picks that market in the call panel. */}
          <div
            role="group"
            aria-label="Markets"
            className="grid grid-cols-3 gap-2 lg:gap-3"
          >
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
            Laptop: two independent columns, each from the top at its natural height (nothing stretches, nothing sticks):
            [agents, live calls, your calls | your call, leaderboard].
            The wrapper is "contents" on a phone, so its tiles take part in the one-column order. */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:items-start">
            <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-3">
              <AgentStrip
                backing={backing}
                onBack={backAgent}
                live={agentLive}
                className="order-1 lg:order-none"
              />
              <LiveCalls
                market={market}
                nextRound={selectedChain?.nextRound ?? null}
                nowSec={now}
                onOpen={openWatch}
                index={6}
                className="order-3 lg:order-none"
              />
              <YourCalls
                positions={positions}
                roundsByMarket={roundsByMarket}
                nowSec={now}
                onOpen={openWatch}
                index={7}
                className="order-4 lg:order-none"
              />
            </div>
            <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-3">
            <YourCall
              frames={TIME_FRAMES}
              frame={market.roundSeconds}
              onFrame={setFrame}
              market={market}
              secondsLeft={
                now === null
                  ? null
                  : secondsToNextLock(
                      now,
                      market.lockOffset,
                      market.roundSeconds,
                    )
              }
              side={side}
              onSide={setSide}
              amount={amount}
              onAmount={setAmount}
              backing={backingAgent}
              backingCall={backing ? (agentLive[backing]?.call ?? null) : null}
              onClearBacking={() => setBacking(null)}
              onCalled={(marketId, roundIndex) => {
                // a backed call: remember whom it copied (for the little avatar in Live calls and the receipt), then the chip is done
                if (backing && me) rememberBacked(me, marketId, roundIndex, backing);
                if (backing) setBacking(null);
                openWatch(marketId, roundIndex);
              }}
              chain={
                selectedChain
                  ? {
                      nextRound: selectedChain.nextRound,
                      minStake: selectedChain.minStake,
                      paused: selectedChain.paused,
                      upTotal: nextRound?.upTotal ?? 0n,
                      downTotal: nextRound?.downTotal ?? 0n,
                    }
                  : null
              }
              index={5}
              className="order-2 lg:order-none"
            />
            <AgentLeaderboard
              backing={backing}
              onBack={backAgent}
              live={agentLive}
              index={8}
              className="order-5 lg:order-none"
            />
            </div>
          </div>
        </div>

        <WatchSheet
          watch={watch}
          onClose={closeWatch}
          roundsByMarket={roundsByMarket}
          positions={positions}
          candlesFor={(m) => feed.candles[m.key]}
          nowSec={now}
          me={me}
          onNext={(m) => {
            setSelected(m.key);
            setFrame(m.roundSeconds);
            document
              .getElementById("your-call")
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        />

        <LivePill
          positions={positions}
          roundsByMarket={roundsByMarket}
          nowSec={now}
          hidden={watch !== null}
          onWatch={openWatch}
        />

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
          <a
            href="https://www.bitfinex.com"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Bitfinex
          </a>
          , live.{" "}
          {feed.status === "reconnecting" && !feedFailed
            ? "Connection lost just now, showing the last prices while it reconnects."
            : null}
          Charts by{" "}
          <a
            href="https://www.tradingview.com/lightweight-charts/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            TradingView Lightweight Charts™
          </a>
          .
        </footer>
      </div>
    </RoundCardProvider>
  );
}
