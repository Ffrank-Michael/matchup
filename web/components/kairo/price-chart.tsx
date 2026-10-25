"use client";

import * as React from "react";

import { formatUsd, type Market } from "@/lib/markets";
import { HOUR, type Candle, type Point } from "@/lib/price-feed";
import { cn } from "@/lib/utils";
import { WINNING_TEXT, winningSide } from "@/lib/winning";

import { INK, NotLive } from "./tile";

// The full chart of the selected market (phone: opens in a sheet from the bottom).
// Line: the last hour of real Bitfinex trades, ending at the live price.
// Candles: the same hour as 1-minute candles (lime if the minute closed higher, lilac if lower).
// The right fifth is kept free: that is where the round's start price line sits once there is one.

const W = 640;
const H = 240;
const PLOT = W * 0.8;

type Mode = "line" | "candles";

type Mark = { x: number; y: number; value: number; time: number; detail?: string };

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
  const uid = React.useId().replace(/:/g, "");
  const [mode, setMode] = React.useState<Mode>("line");
  const [hover, setHover] = React.useState<number | null>(null);

  const ready = points !== null && nowMs !== null;
  const hourCandles = React.useMemo(() => (candles && nowMs !== null ? candles.filter((c) => c.t >= nowMs - HOUR && c.t < nowMs) : []), [candles, nowMs]);
  const showCandles = mode === "candles";

  // price range of what is drawn (and the start price, so its line is always inside the chart)
  const values = showCandles ? hourCandles.flatMap((c) => [c.high, c.low]) : ready ? points.map((p) => p[1]) : [];
  if (startPrice !== null && values.length) values.push(startPrice);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 0;
  const y = (v: number) => H - 24 - ((v - lo) / (hi - lo || 1)) * (H - 56);
  const x = (t: number) => ((t - ((nowMs ?? 0) - HOUR)) / HOUR) * PLOT;

  const marks: Mark[] = !ready
    ? []
    : showCandles
      ? hourCandles.map((c) => ({
          x: x(c.t + 30_000),
          y: y(c.close),
          value: c.close,
          time: c.t,
          detail: `O ${formatUsd(c.open)}  H ${formatUsd(c.high)}  L ${formatUsd(c.low)}`,
        }))
      : points.map(([t, v]) => ({ x: x(t), y: y(v), value: v, time: t }));

  const idx = hover !== null && hover < marks.length ? hover : marks.length - 1;
  const hovering = hover !== null && hover < marks.length;
  const shown: Mark | undefined = marks[idx];

  const line = !showCandles && ready ? marks.map((m, i) => `${i === 0 ? "M" : "L"} ${m.x.toFixed(1)} ${m.y.toFixed(1)}`).join(" ") : "";
  const rising = ready ? (showCandles ? hourCandles.length === 0 || hourCandles[hourCandles.length - 1].close >= hourCandles[0].open : points[points.length - 1][1] >= points[0][1]) : true;
  const color = rising ? "var(--color-up)" : "var(--color-down)";
  const winning = winningSide(price, startPrice);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ready || marks.length === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    if (px > PLOT) return setHover(null);
    let best = 0;
    for (let i = 1; i < marks.length; i++) if (Math.abs(marks[i].x - px) < Math.abs(marks[best].x - px)) best = i;
    setHover(best);
  };

  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <p className="font-mono text-[26px] font-semibold leading-none tracking-[-0.03em] tabular-nums">
            {hovering && shown ? formatUsd(shown.value) : price !== null ? formatUsd(price) : <span className="text-muted-foreground">{feedFailed ? "price unavailable" : "…"}</span>}
          </p>
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground" aria-live="polite">
            {hovering && shown
              ? new Date(shown.time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: showCandles ? undefined : "2-digit" })
              : ready
                ? "Bitfinex last trade · last hour"
                : " "}
          </p>
          {hovering && shown?.detail ? <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{shown.detail}</p> : null}
        </div>
        <div
          role="group"
          aria-label="Chart type"
          className="grid grid-cols-2 gap-0.5 rounded-full border border-border bg-muted/40 p-0.5 text-[12px] font-medium"
        >
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
              className={cn(
                "rounded-full px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                mode === key ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground">
        {winning ? (
          <span
            className="rounded-full px-2.5 py-0.5 font-semibold"
            style={winning === "LEVEL" ? { border: "1px solid var(--color-border)" } : { background: winning === "UP" ? "var(--color-up)" : "var(--color-down)", color: INK }}
          >
            {WINNING_TEXT[winning]}
          </span>
        ) : null}
        <span className="flex items-center gap-2">
          <span className="h-0 w-5 border-t-2 border-dashed border-muted-foreground" aria-hidden />
          Start price
          {startPrice !== null ? <span className="font-mono text-foreground">{formatUsd(startPrice)}</span> : <NotLive className="text-[11px]" />}
        </span>
      </div>

      <div className="relative mt-4 touch-pan-y" style={{ height: 240 }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ready && marks.length > 0 ? (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
              <defs>
                <linearGradient id={`${uid}-f`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" style={{ stopColor: color, stopOpacity: 0.26 }} />
                  <stop offset="1" style={{ stopColor: color, stopOpacity: 0 }} />
                </linearGradient>
              </defs>
              {[0.25, 0.5, 0.75].map((f) => (
                <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} vectorEffect="non-scaling-stroke" strokeDasharray="1 5" style={{ stroke: "var(--color-border)" }} />
              ))}
              {/* room kept for the round's start price line */}
              <rect x={PLOT} y={0} width={W - PLOT} height={H} style={{ fill: "var(--color-muted)", fillOpacity: 0.35 }} />
              <line x1={PLOT} x2={PLOT} y1={0} y2={H} vectorEffect="non-scaling-stroke" strokeDasharray="3 4" style={{ stroke: "var(--color-border)" }} />
              {startPrice !== null ? (
                <line x1={0} x2={W} y1={y(startPrice)} y2={y(startPrice)} vectorEffect="non-scaling-stroke" strokeWidth={1.5} strokeDasharray="5 4" style={{ stroke: "var(--color-muted-foreground)" }} />
              ) : null}
              {showCandles ? (
                hourCandles.map((c) => {
                  const cx = x(c.t + 30_000);
                  const up = c.close >= c.open;
                  const top = y(Math.max(c.open, c.close));
                  const bottom = y(Math.min(c.open, c.close));
                  const stroke = up ? "var(--color-up)" : "var(--color-down)";
                  return (
                    <g key={c.t}>
                      <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} vectorEffect="non-scaling-stroke" strokeWidth={1.5} style={{ stroke }} />
                      <rect x={cx - (PLOT / 60) * 0.3} y={top} width={(PLOT / 60) * 0.6} height={Math.max(bottom - top, 1.5)} rx={1} style={{ fill: stroke }} />
                    </g>
                  );
                })
              ) : (
                <>
                  <path d={`${line} L ${marks[marks.length - 1].x.toFixed(1)} ${H} L ${marks[0].x.toFixed(1)} ${H} Z`} fill={`url(#${uid}-f)`} />
                  <path d={line} fill="none" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={{ stroke: color }} />
                </>
              )}
            </svg>
            <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-border" style={{ left: `${(shown.x / W) * 100}%`, opacity: hovering ? 1 : 0 }} />
            {!showCandles ? (
              <span
                aria-hidden
                className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-card"
                style={{ left: `${(shown.x / W) * 100}%`, top: `${(shown.y / H) * 100}%`, background: color }}
              />
            ) : null}
            <span className="pointer-events-none absolute left-2 top-1 font-mono text-[11px] tabular-nums text-muted-foreground">{formatUsd(hi)}</span>
            <span className="pointer-events-none absolute bottom-1 left-2 font-mono text-[11px] tabular-nums text-muted-foreground">{formatUsd(lo)}</span>
            <span className="pointer-events-none absolute right-2 top-1 font-mono text-[11px] text-muted-foreground">this round</span>
          </>
        ) : (
          <p className="absolute inset-0 grid place-items-center font-mono text-[12px] text-muted-foreground">
            {feedFailed ? "price unavailable" : mode === "candles" && ready ? "no trades in the last hour" : "loading prices…"}
          </p>
        )}
      </div>
      <p className="sr-only">{market.pair}</p>
    </div>
  );
}
