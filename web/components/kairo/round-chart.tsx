"use client";

import * as React from "react";

import { formatUsd } from "@/lib/markets";
import type { Candle, Point } from "@/lib/price-feed";
import { cn } from "@/lib/utils";

import { LwChart } from "./lw-chart";

// The live chart of one round. The x axis is the whole round (lock to end), so you see how much time is left; the price
// line is drawn up to now. A dashed line marks the round's start price: where the price is above it the picture is lime
// (UP is ahead), below it lilac (DOWN is ahead). The viewer's own call is marked on the start line.

const H = 260;
const PAD = { l: 8, r: 8, t: 22, b: 22 };

export function RoundChart({
  fromMs,
  toMs,
  nowMs,
  points,
  candles = [],
  startPrice,
  endPrice,
  myCall,
  className,
}: {
  /** The round's lock and end, in ms */
  fromMs: number;
  toMs: number;
  nowMs: number | null;
  /** The price over the round so far, oldest first (Bitfinex trades) */
  points: Point[];
  /** The 1-minute candles of the round so far (for the Candles view) */
  candles?: Candle[];
  /** The contract's start price for the round, if it has been recorded */
  startPrice: number | null;
  endPrice: number | null;
  /** The viewer's call in this round, drawn as a tag on the start line */
  myCall: { side: "UP" | "DOWN"; label: string } | null;
  className?: string;
}) {
  const uid = React.useId().replace(/:/g, "");
  const [mode, setMode] = React.useState<"line" | "candles">("line");
  // draw at the real width, so the text stays the size it is written in (a scaled-down picture makes it tiny on a phone)
  const box = React.useRef<HTMLDivElement>(null);
  const [W, setW] = React.useState(640);
  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setW(Math.max(240, Math.round(el.clientWidth))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const prices = points.map((p) => p[1]);
  if (startPrice !== null) prices.push(startPrice);
  if (endPrice !== null) prices.push(endPrice);
  let lo = prices.length ? Math.min(...prices) : 0;
  let hi = prices.length ? Math.max(...prices) : 1;
  // never zoom into a flat line: keep at least 0.04% of the price on screen
  const mid = (lo + hi) / 2;
  const minSpan = mid * 0.0004;
  if (hi - lo < minSpan) {
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;

  const x = (t: number) =>
    PAD.l +
    ((Math.min(Math.max(t, fromMs), toMs) - fromMs) / (toMs - fromMs)) *
      (W - PAD.l - PAD.r);
  const y = (v: number) =>
    PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const ys = startPrice !== null ? y(startPrice) : null;

  const path = points
    .map(
      ([t, v], i) =>
        `${i === 0 ? "M" : "L"}${x(t).toFixed(1)} ${y(v).toFixed(1)}`,
    )
    .join(" ");
  const last = points[points.length - 1];
  const nowX = nowMs !== null ? x(nowMs) : null;

  const toggle = (
    <div
      role="group"
      aria-label="Chart type"
      className="mb-1 ml-auto grid w-fit grid-cols-2 gap-0.5 rounded-full border border-border bg-muted/40 p-0.5 text-[12px] font-medium"
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
          onClick={() => setMode(key)}
          className={cn(
            "rounded-full px-3 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            mode === key
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (mode === "candles") {
    return (
      <div ref={box} className={cn("w-full", className)}>
        {toggle}
        {candles.length > 0 ? (
          <LwChart
            mode="candles"
            candles={candles}
            points={[]}
            startPrice={startPrice}
            height={H}
          />
        ) : (
          <p
            className="grid place-items-center font-mono text-[12px] text-muted-foreground"
            style={{ height: H }}
          >
            The first candle appears when a minute of the round is over
          </p>
        )}
      </div>
    );
  }

  return (
    <div ref={box} className={cn("w-full", className)}>
      {toggle}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="block select-none"
        role="img"
        aria-label="Live price in this round against its start price"
      >
        <defs>
          <clipPath id={`${uid}-above`}>
            <rect x="0" y="0" width={W} height={ys ?? 0} />
          </clipPath>
          <clipPath id={`${uid}-below`}>
            <rect x="0" y={ys ?? 0} width={W} height={H - (ys ?? 0)} />
          </clipPath>
        </defs>

        {/* time left: the part of the round still to come */}
        {nowX !== null && nowX < W - PAD.r ? (
          <rect
            x={nowX}
            y={PAD.t}
            width={W - PAD.r - nowX}
            height={H - PAD.t - PAD.b}
            fill="currentColor"
            opacity={0.04}
          />
        ) : null}

        {ys !== null && points.length > 1 ? (
          <>
            {/* the area between the line and the start price, lime above it and lilac below it */}
            <path
              d={`${path} L${x(last[0]).toFixed(1)} ${ys.toFixed(1)} L${x(points[0][0]).toFixed(1)} ${ys.toFixed(1)} Z`}
              fill="var(--color-up)"
              opacity={0.28}
              clipPath={`url(#${uid}-above)`}
            />
            <path
              d={`${path} L${x(last[0]).toFixed(1)} ${ys.toFixed(1)} L${x(points[0][0]).toFixed(1)} ${ys.toFixed(1)} Z`}
              fill="var(--color-down)"
              opacity={0.28}
              clipPath={`url(#${uid}-below)`}
            />
            <path
              d={path}
              fill="none"
              stroke="var(--color-up)"
              strokeWidth={2.6}
              strokeLinejoin="round"
              strokeLinecap="round"
              clipPath={`url(#${uid}-above)`}
            />
            <path
              d={path}
              fill="none"
              stroke="var(--color-down)"
              strokeWidth={2.6}
              strokeLinejoin="round"
              strokeLinecap="round"
              clipPath={`url(#${uid}-below)`}
            />
          </>
        ) : points.length > 1 ? (
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.7}
            strokeWidth={2.6}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

        {/* the start price: dashed */}
        {ys !== null && startPrice !== null ? (
          <>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={ys}
              y2={ys}
              stroke="currentColor"
              strokeOpacity={0.7}
              strokeWidth={1.5}
              strokeDasharray="6 6"
            />
            <text
              x={W - PAD.r}
              y={ys - 6}
              textAnchor="end"
              fontSize="12"
              fill="currentColor"
              opacity={0.75}
              className="font-mono"
            >
              start {formatUsd(startPrice)}
            </text>
          </>
        ) : null}

        {/* the viewer's own call, marked at the start of the round on the start line */}
        {myCall && ys !== null ? (
          <g>
            <rect
              x={PAD.l + 2}
              y={ys - 11}
              width={myCall.label.length * 7.4 + 22}
              height={22}
              rx={11}
              fill={
                myCall.side === "UP" ? "var(--color-up)" : "var(--color-down)"
              }
            />
            <text
              x={PAD.l + 13}
              y={ys + 4}
              fontSize="12"
              fontWeight={700}
              fill="oklch(0.24 0.06 135)"
            >
              {myCall.label}
            </text>
          </g>
        ) : null}

        {/* the live price */}
        {last && nowX !== null ? (
          <g>
            <circle
              cx={x(last[0])}
              cy={y(last[1])}
              r={9}
              fill="currentColor"
              opacity={0.15}
            />
            <circle
              cx={x(last[0])}
              cy={y(last[1])}
              r={4.5}
              fill="currentColor"
            />
          </g>
        ) : null}

        {/* the end price, once the round is over */}
        {endPrice !== null ? (
          <g>
            <circle
              cx={W - PAD.r}
              cy={y(endPrice)}
              r={5}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            />
            <text
              x={W - PAD.r - 10}
              y={y(endPrice) - 10}
              textAnchor="end"
              fontSize="12"
              fill="currentColor"
              className="font-mono"
            >
              end {formatUsd(endPrice)}
            </text>
          </g>
        ) : null}

        {points.length < 2 ? (
          <text
            x={W / 2}
            y={H / 2}
            textAnchor="middle"
            fontSize="14"
            fill="currentColor"
            opacity={0.6}
          >
            The line fills in as prices come in
          </text>
        ) : null}
      </svg>
    </div>
  );
}
