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

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/**
 * One market. On a phone it is a small card (ticker, price, countdown) and three fit in one row.
 * On a laptop it is bigger, with the last-hour line; the selected card also holds the "winning" label
 * and the start price line, which need the contract and say "not live yet".
 */
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
  const countdown = secondsLeft === null ? "--:--" : formatCountdown(secondsLeft);
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${market.pair}, select`}
      onClick={onSelect}
      style={{ animationDelay: `${index * 70}ms` }}
      className={cn(
        "kairo-rise flex min-w-0 flex-col rounded-2xl border bg-card p-2.5 text-left text-card-foreground transition-[border-color,box-shadow] duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:rounded-[26px] lg:p-5",
        selected ? "border-up shadow-[0_0_28px_-6px_var(--color-up)]" : "border-border hover:border-foreground/25",
      )}
    >
      {/* phone: ticker, then price, then countdown. laptop: ticker and pair on the left, countdown on the right */}
      <span className="flex items-center justify-between gap-3">
        <span className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold tracking-tight lg:text-[15px]">{market.key}</span>
          <span className="hidden text-[12px] text-muted-foreground lg:inline">{market.pair}</span>
        </span>
        <span
          className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 font-mono text-[11px] tabular-nums text-muted-foreground lg:flex"
          aria-label="next lock in"
        >
          <LockIcon />
          <span className="text-foreground">{countdown}</span>
        </span>
      </span>

      <span className="mt-1.5 block min-w-0 truncate font-mono text-[13px] font-semibold leading-none tracking-[-0.04em] tabular-nums sm:text-[17px] lg:mt-4 lg:text-[30px]">
        {price !== null ? formatUsd(price) : feedFailed ? <span className="text-[11px] font-medium tracking-normal text-muted-foreground lg:text-[14px]">unavailable</span> : <span className="text-muted-foreground">…</span>}
      </span>

      <span className="mt-1.5 flex items-center gap-1 font-mono text-[11px] tabular-nums text-muted-foreground lg:hidden" aria-label="next lock in">
        <LockIcon />
        <span className="text-foreground">{countdown}</span>
      </span>

      {/* laptop only */}
      <span className="mt-3 hidden lg:block">{points && nowMs !== null ? <Sparkline points={points} nowMs={nowMs} /> : <span className="block h-12" aria-hidden />}</span>
      <span className="mt-1 hidden text-[11px] text-muted-foreground lg:block">{points && nowMs !== null ? "last hour" : " "}</span>

      <span className="mt-4 hidden lg:block">
        <span className="block h-2 rounded-full bg-muted" aria-hidden />
        <span className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>UP vs DOWN money</span>
          <NotLive className="text-[11px]" />
        </span>
      </span>

      {selected ? (
        <span className="mt-4 hidden border-t border-border pt-3 lg:block">
          <span className="flex items-center justify-between gap-2 text-[12px]">
            <span className="rounded-full border border-dashed border-border px-2.5 py-1 text-muted-foreground">UP winning / DOWN winning</span>
            <NotLive className="text-[11px]" />
          </span>
          <span className="mt-3 flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className="h-0 w-5 border-t-2 border-dashed border-muted-foreground" aria-hidden />
            Start price
            <NotLive className="text-[11px]" />
          </span>
        </span>
      ) : null}
    </button>
  );
}
