"use client";

import * as React from "react";

import { MARKETS, secondsToNextLock, type MarketKey } from "@/lib/markets";
import { useNowSeconds, usePrices } from "@/lib/use-live";

import { MarketCard } from "./market-card";
import { PriceChart } from "./price-chart";
import { Tile } from "./tile";

// Step C2: market cards on top (live CoinGecko price, 7-day line, countdown to the next lock),
// the selected market in the middle, Agents and Live calls at the bottom.
// Only the prices are real data right now. Everything about rounds, money and agents says
// "not live yet" until the contract is deployed.

export function KairoHome() {
  const [selected, setSelected] = React.useState<MarketKey>("BTC");
  const prices = usePrices();
  const now = useNowSeconds();
  const market = MARKETS.find((m) => m.key === selected) ?? MARKETS[0];
  const coinOf = (id: string) => prices.coins?.[id] ?? null;
  const feedFailed = prices.failing && !prices.coins;
  const stale = prices.failing && prices.okAt !== null;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-4 py-4 sm:px-8 sm:py-8">
      {/* Top bar */}
      <header className="kairo-rise mb-3 flex items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2.5">
          <span className="size-2.5 rounded-full bg-up" aria-hidden />
          <span className="text-[17px] font-semibold tracking-[-0.02em]">Kairo Markets</span>
        </div>
        <button
          type="button"
          disabled
          title="Not working yet"
          className="cursor-not-allowed rounded-full bg-foreground px-3.5 py-1.5 font-mono text-[12px] font-semibold text-background opacity-60"
        >
          Connect wallet
        </button>
      </header>

      <div className="flex flex-col gap-3">
        {/* Top: one card per market (stacked on phones) */}
        <div role="group" aria-label="Markets" className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {MARKETS.map((m, i) => (
            <MarketCard
              key={m.key}
              market={m}
              coin={coinOf(m.coingeckoId)}
              feedFailed={feedFailed}
              secondsLeft={now === null ? null : secondsToNextLock(now, m.lockOffset)}
              selected={m.key === selected}
              onSelect={() => setSelected(m.key)}
              index={i}
            />
          ))}
        </div>

        {/* Middle: the selected market. On phones the call panel comes first, then the chart. */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <PriceChart market={market} coin={coinOf(market.coingeckoId)} feedFailed={feedFailed} index={3} className="order-2 lg:order-1 lg:col-span-2" />
          <Tile title={`Make your call · ${market.key}`} accent index={4} className="order-1 min-h-[240px] lg:order-2" />
        </div>

        {/* Bottom: two tiles */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Tile title="Agents" index={5} className="min-h-[220px]" />
          <Tile title="Live calls" index={6} className="min-h-[220px]" />
        </div>
      </div>

      <footer className="mt-4 px-1 text-[11px] text-muted-foreground">
        Price data provided by{" "}
        <a href="https://www.coingecko.com" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
          CoinGecko
        </a>
        .{" "}
        {stale && prices.okAt !== null
          ? `CoinGecko could not be reached just now, showing the last prices from ${new Date(prices.okAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`
          : null}
      </footer>
    </div>
  );
}
