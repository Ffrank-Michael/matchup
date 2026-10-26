import { formatCountdown, formatUsd, type Market } from "@/lib/markets";
import { HOUR, type Point } from "@/lib/price-feed";
import { cn } from "@/lib/utils";
import { WINNING_TEXT, winningSide } from "@/lib/winning";

import { NotLive } from "./tile";

/**
 * The last hour as a line: left edge is one hour ago, right edge is now (the live price).
 * Lime if the price went up over the hour, lilac if it went down. A dashed line marks the start price once there is one.
 */
function Sparkline({ points, nowMs, startPrice, className }: { points: Point[]; nowMs: number; startPrice: number | null; className?: string }) {
  const W = 200;
  const H = 48;
  const prices = points.map((p) => p[1]);
  const lo = Math.min(...prices, startPrice ?? Infinity);
  const hi = Math.max(...prices, startPrice ?? -Infinity);
  const from = nowMs - HOUR;
  const y = (v: number) => H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6);
  const xy = points.map(([t, v]) => `${(((t - from) / HOUR) * W).toFixed(1)},${y(v).toFixed(1)}`);
  const up = prices[prices.length - 1] >= prices[0];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn("w-full", className)} role="img" aria-label={`${up ? "Up" : "Down"} over the last hour`}>
      {startPrice !== null ? (
        <line x1={0} x2={W} y1={y(startPrice)} y2={y(startPrice)} strokeWidth={1.5} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" style={{ stroke: "var(--color-muted-foreground)" }} />
      ) : null}
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

function ChartIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3v18h18" />
      <path d="M7 15l4-4 3 3 5-6" />
    </svg>
  );
}

/** The selected card's extra: the true "UP winning" or "DOWN winning" label, or, before there is a start price, only the legend. */
function SelectedInfo({ price, startPrice, small }: { price: number | null; startPrice: number | null; small?: boolean }) {
  const winning = winningSide(price, startPrice);
  return (
    <span className={cn("flex flex-col gap-1.5", small ? "text-[10px]" : "text-[12px]")}>
      {winning ? (
        <span
          className="w-fit rounded-full px-2 py-0.5 font-semibold"
          style={
            winning === "LEVEL"
              ? { border: "1px solid var(--color-border)", color: "var(--color-muted-foreground)" }
              : { background: winning === "UP" ? "var(--color-up)" : "var(--color-down)", color: "oklch(0.24 0.06 135)" }
          }
        >
          {WINNING_TEXT[winning]}
        </span>
      ) : null}
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span className="h-0 w-4 shrink-0 border-t-2 border-dashed border-muted-foreground" aria-hidden />
        Start price
        {startPrice !== null ? <span className="font-mono text-foreground">{formatUsd(startPrice)}</span> : <NotLive className={small ? "text-[10px]" : "text-[11px]"} />}
      </span>
    </span>
  );
}

/**
 * One market. On a phone it is a small card (ticker, price, last-hour line, countdown) and three fit in one row.
 * On a laptop it is bigger. The selected card also holds the start price line and the "winning" label,
 * which need the contract, so until a start price exists only the legend and "not live yet" show.
 */
export function MarketCard({
  market,
  price,
  points,
  nowMs,
  feedFailed,
  secondsLeft,
  selected,
  startPrice,
  onSelect,
  onOpenChart,
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
  /** This round's start price once the contract has recorded it; null before */
  startPrice: number | null;
  onSelect: () => void;
  /** Opens the full chart in a sheet (from the bottom on a phone, centred on a laptop) */
  onOpenChart: () => void;
  index: number;
}) {
  const countdown = secondsLeft === null ? "--:--" : formatCountdown(secondsLeft);
  const spark = points && nowMs !== null ? <Sparkline points={points} nowMs={nowMs} startPrice={selected ? startPrice : null} className="h-8 lg:h-12" /> : <span className="block h-8 lg:h-12" aria-hidden />;
  return (
    <div className="relative flex min-w-0">
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${market.pair}, select`}
        onClick={onSelect}
        style={{ animationDelay: `${index * 70}ms` }}
        className={cn(
          "kairo-rise flex w-full min-w-0 flex-col rounded-2xl border bg-card p-2.5 text-left text-card-foreground transition-[border-color,box-shadow] duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:rounded-[26px] lg:p-5",
          selected ? "border-up shadow-[0_0_28px_-6px_var(--color-up)]" : "border-border hover:border-foreground/25",
        )}
      >
        {/* phone: ticker, price, last-hour line, countdown. laptop: ticker and pair on the left, countdown on the right */}
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

        <span className="mt-2 block lg:mt-3">{spark}</span>
        <span className="mt-1 hidden text-[11px] text-muted-foreground lg:block">{points && nowMs !== null ? "last hour" : " "}</span>

        <span className="mt-1.5 flex items-center gap-1 font-mono text-[11px] tabular-nums text-muted-foreground lg:hidden" aria-label="next lock in">
          <LockIcon />
          <span className="text-foreground">{countdown}</span>
        </span>

        {/* laptop only */}
        <span className="mt-4 hidden lg:block">
          <span className="block h-2 rounded-full bg-muted" aria-hidden />
          <span className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>UP vs DOWN money</span>
            <NotLive className="text-[11px]" />
          </span>
        </span>

        {selected ? (
          <>
            <span className="mt-2 block border-t border-border pt-2 lg:hidden">
              <SelectedInfo price={price} startPrice={startPrice} small />
            </span>
            <span className="mt-4 hidden border-t border-border pt-3 lg:block">
              <SelectedInfo price={price} startPrice={startPrice} />
            </span>
          </>
        ) : null}
      </button>

      {/* the full chart (sheet on a phone, centred panel on a laptop). A sibling of the card button, because buttons cannot nest. */}
      {selected ? (
        <button
          type="button"
          onClick={onOpenChart}
          aria-label={`Open the full ${market.pair} chart`}
          className="absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-full border border-border bg-background/70 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:right-3 lg:top-3"
        >
          <ChartIcon />
        </button>
      ) : null}
    </div>
  );
}
