"use client";

import * as React from "react";

import { formatUsd, type Market } from "@/lib/markets";
import { HOUR, type Point } from "@/lib/price-feed";
import { cn } from "@/lib/utils";

import { NotLive, Tile } from "./tile";

// Wide price chart for the selected market: the last hour of real Bitfinex trades, ending at the live price.
// The right fifth is kept free: that is where the round's start price line will go once rounds are live.

const W = 640;
const H = 240;
const PLOT = W * 0.8;
const RESULT_DOTS = 30;

export function PriceChart({
  market,
  price,
  points,
  nowMs,
  feedFailed,
  index,
  className,
}: {
  market: Market;
  /** The live price (last trade); the same number the market card shows */
  price: number | null;
  /** The last hour as (time, price) points; the final point is the live price */
  points: Point[] | null;
  nowMs: number | null;
  feedFailed: boolean;
  index: number;
  className?: string;
}) {
  const uid = React.useId().replace(/:/g, "");
  const [hover, setHover] = React.useState<number | null>(null);

  const ready = points !== null && nowMs !== null;
  const prices = ready ? points.map((p) => p[1]) : [];
  const lo = ready ? Math.min(...prices) : 0;
  const hi = ready ? Math.max(...prices) : 0;
  const y = (v: number) => H - 24 - ((v - lo) / (hi - lo || 1)) * (H - 56);
  const xy = ready ? points.map(([t, v]) => [(((t - (nowMs - HOUR)) / HOUR) * PLOT), y(v)] as const) : [];
  const line = xy.map(([x, yy], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${yy.toFixed(1)}`).join(" ");
  const up = ready ? prices[prices.length - 1] >= prices[0] : true;
  const color = up ? "var(--color-up)" : "var(--color-down)";
  const idx = hover !== null && hover < xy.length ? hover : xy.length - 1;
  const hovering = ready && hover !== null && hover < xy.length;

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ready) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    if (x > PLOT) return setHover(null);
    let best = 0;
    for (let i = 1; i < xy.length; i++) if (Math.abs(xy[i][0] - x) < Math.abs(xy[best][0] - x)) best = i;
    setHover(best);
  };

  return (
    <Tile title={`Price chart · ${market.pair}`} index={index} className={cn("min-h-[360px]", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <p className="font-mono text-[26px] font-semibold leading-none tracking-[-0.03em] tabular-nums">
            {hovering ? (
              formatUsd(points[idx][1])
            ) : price !== null ? (
              formatUsd(price)
            ) : (
              <span className="text-muted-foreground">{feedFailed ? "price unavailable" : "…"}</span>
            )}
          </p>
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground" aria-live="polite">
            {hovering
              ? new Date(points[idx][0]).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })
              : ready
                ? "Bitfinex last trade · last hour"
                : " "}
          </p>
        </div>
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="h-0 w-5 border-t-2 border-dashed border-muted-foreground" aria-hidden />
          Start price
          <NotLive className="text-[11px]" />
        </p>
      </div>

      <div className="relative mt-4 flex-1 touch-pan-y" style={{ minHeight: 200 }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ready ? (
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
              <path d={`${line} L ${xy[xy.length - 1][0].toFixed(1)} ${H} L ${xy[0][0].toFixed(1)} ${H} Z`} fill={`url(#${uid}-f)`} />
              <path d={line} fill="none" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={{ stroke: color }} />
            </svg>
            <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-border" style={{ left: `${(xy[idx][0] / W) * 100}%`, opacity: hovering ? 1 : 0 }} />
            <span
              aria-hidden
              className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-card"
              style={{ left: `${(xy[idx][0] / W) * 100}%`, top: `${(xy[idx][1] / H) * 100}%`, background: color }}
            />
            <span className="pointer-events-none absolute left-2 top-1 font-mono text-[11px] tabular-nums text-muted-foreground">{formatUsd(hi)}</span>
            <span className="pointer-events-none absolute bottom-1 left-2 font-mono text-[11px] tabular-nums text-muted-foreground">{formatUsd(lo)}</span>
            <span className="pointer-events-none absolute right-2 top-1 font-mono text-[11px] text-muted-foreground">this round</span>
          </>
        ) : (
          <p className="absolute inset-0 grid place-items-center font-mono text-[12px] text-muted-foreground">{feedFailed ? "price unavailable" : "loading prices…"}</p>
        )}
      </div>

      {/* Last results: one dot per finished round, lime for UP and lilac for DOWN. Empty until rounds are live. */}
      <div className="mt-4 border-t border-border pt-3">
        <div className="mb-2 flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
          <span>Last results</span>
          <NotLive className="text-[11px]" />
        </div>
        <div className="flex flex-wrap gap-1.5" aria-hidden>
          {Array.from({ length: RESULT_DOTS }, (_, i) => (
            <span key={i} className="size-2.5 rounded-full border border-muted-foreground/40" />
          ))}
        </div>
      </div>
    </Tile>
  );
}
