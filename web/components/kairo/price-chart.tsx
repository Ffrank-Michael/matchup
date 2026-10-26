"use client";

import * as React from "react";

import { formatUsd, type Market } from "@/lib/markets";
import { HOUR, type Candle, type Point } from "@/lib/price-feed";
import { cn } from "@/lib/utils";
import { WINNING_TEXT, winningSide } from "@/lib/winning";

import { LwChart, type HoverReading } from "./lw-chart";
import { INK } from "./tile";

// The full chart of the selected market (phone: opens in a sheet from the bottom).
// Line: the last hour of real Bitfinex trades, ending at the live price.
// Candles: the same hour as 1-minute candles (lime if the minute closed higher, lilac if lower).
// Drawn with TradingView Lightweight Charts (lw-chart.tsx). A dashed line marks the round's start price once there is one.

type Mode = "line" | "candles";

export function PriceChart({
  market,
  price,
  points,
  candles,
  nowMs,
  feedFailed,
  startPrice,
  className,
}: {
  market: Market;
  /** The live price (last trade); the same number the market card shows */
  price: number | null;
  /** The last hour as (time, price) points; the final point is the live price */
  points: Point[] | null;
  /** 1-minute candles, oldest first */
  candles: Candle[] | null;
  nowMs: number | null;
  feedFailed: boolean;
  /** This round's start price once the contract has recorded it; null before */
  startPrice: number | null;
  className?: string;
}) {
  const [mode, setMode] = React.useState<Mode>("line");
  const [hover, setHover] = React.useState<HoverReading>(null);

  const ready = points !== null && nowMs !== null;
  const hourCandles = React.useMemo(() => (candles && nowMs !== null ? candles.filter((c) => c.t >= nowMs - HOUR && c.t < nowMs) : []), [candles, nowMs]);
  const showCandles = mode === "candles";
  const hasData = ready && (showCandles ? hourCandles.length > 0 : points.length > 0);
  const rising = ready ? (showCandles ? hourCandles.length === 0 || hourCandles[hourCandles.length - 1].close >= hourCandles[0].open : points.length === 0 || points[points.length - 1][1] >= points[0][1]) : true;
  const winning = winningSide(price, startPrice);

  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <p className="font-mono text-[26px] font-semibold leading-none tracking-[-0.03em] tabular-nums">
            {hover ? formatUsd(hover.price) : price !== null ? formatUsd(price) : <span className="text-muted-foreground">{feedFailed ? "price unavailable" : "…"}</span>}
          </p>
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground" aria-live="polite">
            {hover ? new Date(hover.time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: showCandles ? undefined : "2-digit" }) : ready ? "Bitfinex last trade · last hour" : " "}
          </p>
          {hover?.detail ? <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{hover.detail}</p> : null}
        </div>
        <div role="group" aria-label="Chart type" className="grid grid-cols-2 gap-0.5 rounded-full border border-border bg-muted/40 p-0.5 text-[12px] font-medium">
          {(
            [
              ["line", "Line"],
              ["candles", "Candles"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={mode === key}
              onClick={() => {
                setMode(key);
                setHover(null);
              }}
              className={cn("rounded-full px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", mode === key ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground">
        {winning ? (
          <span className="rounded-full px-2.5 py-0.5 font-semibold" style={winning === "LEVEL" ? { border: "1px solid var(--color-border)" } : { background: winning === "UP" ? "var(--color-up)" : "var(--color-down)", color: INK }}>
            {WINNING_TEXT[winning]}
          </span>
        ) : null}
        <span className="flex items-center gap-2">
          <span className="h-0 w-5 border-t-2 border-dashed border-muted-foreground" aria-hidden />
          Start price
          {startPrice !== null ? <span className="font-mono text-foreground">{formatUsd(startPrice)}</span> : <span className="text-[11px]">after the round starts</span>}
        </span>
      </div>

      <div className="relative mt-4" style={{ height: 240 }}>
        {hasData ? (
          <LwChart mode={mode} candles={hourCandles} points={points ?? []} startPrice={startPrice} rising={rising} height={240} onHover={setHover} />
        ) : (
          <p className="absolute inset-0 grid place-items-center font-mono text-[12px] text-muted-foreground">{feedFailed ? "price unavailable" : mode === "candles" && ready ? "no trades in the last hour" : "loading prices…"}</p>
        )}
      </div>
      <p className="sr-only">{market.pair}</p>
      <p className="mt-2 text-[10px] text-muted-foreground">
        Charts by{" "}
        <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
          TradingView Lightweight Charts™
        </a>
        . Prices from Bitfinex.
      </p>
    </div>
  );
}
