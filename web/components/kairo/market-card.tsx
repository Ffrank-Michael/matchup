import { formatCountdown, formatUsd, type Market } from "@/lib/markets";
import { HOUR, type Point } from "@/lib/price-feed";
import { cn } from "@/lib/utils";

import { NotLive } from "./tile";

/** The last hour as a line: left edge is one hour ago, right edge is now (the live price). */
function Sparkline({ points, nowMs }: { points: Point[]; nowMs: number }) {
  const W = 200;
  const H = 48;
  const prices = points.map((p) => p[1]);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const from = nowMs - HOUR;
  const xy = points.map(([t, v]) => `${(((t - from) / HOUR) * W).toFixed(1)},${(H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6)).toFixed(1)}`);
  const up = prices[prices.length - 1] >= prices[0];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-12 w-full" role="img" aria-label={`${up ? "Up" : "Down"} over the last hour`}>
      <polyline
        points={xy.join(" ")}
        fill="none"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        style={{ stroke: up ? "var(--color-up)" : "var(--color-down)" }}
      />
    </svg>
  );
}

export function MarketCard({
  market,
  price,
  points,
  nowMs,
  feedFailed,
  secondsLeft,
  selected,
  onSelect,
  index,
}: {
  market: Market;
  /** The last trade on Bitfinex; null until the first data has arrived */
  price: number | null;
  /** The last hour as (time, price) points; the final point is the price shown */
  points: Point[] | null;
  /** The clock the points are drawn against; null before it is known (server render) */
  nowMs: number | null;
  /** True when no price has ever arrived and the connection is down */
  feedFailed: boolean;
  /** null before the clock is known (server render) */
  secondsLeft: number | null;
  selected: boolean;
  onSelect: () => void;
  index: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      style={{ animationDelay: `${index * 70}ms` }}
      className={cn(
        "kairo-rise flex min-w-0 flex-col rounded-[26px] border bg-card p-5 text-left text-card-foreground transition-[border-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-up shadow-[0_0_0_1px_var(--color-up)]" : "border-border hover:border-foreground/25",
      )}
    >
      <span className="flex items-center justify-between gap-3">
        <span className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold tracking-tight">{market.key}</span>
          <span className="text-[12px] text-muted-foreground">{market.pair}</span>
        </span>
        <span className="rounded-full border border-border px-2.5 py-1 font-mono text-[11px] tabular-nums text-muted-foreground">
          next lock <span className="text-foreground">{secondsLeft === null ? "--:--" : formatCountdown(secondsLeft)}</span>
        </span>
      </span>

      <span className="mt-4 block font-mono text-[30px] font-semibold leading-none tracking-[-0.04em] tabular-nums">
        {price !== null ? formatUsd(price) : feedFailed ? <span className="text-[14px] font-medium tracking-normal text-muted-foreground">price unavailable</span> : <span className="text-muted-foreground">…</span>}
      </span>

      <span className="mt-3 block">{points && nowMs !== null ? <Sparkline points={points} nowMs={nowMs} /> : <span className="block h-12" aria-hidden />}</span>
      <span className="mt-1 block text-[11px] text-muted-foreground">{points && nowMs !== null ? "last hour" : " "}</span>

      <span className="mt-4 block">
        <span className="block h-2 rounded-full bg-muted" aria-hidden />
        <span className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>UP vs DOWN money</span>
          <NotLive className="text-[11px]" />
        </span>
      </span>
    </button>
  );
}
