import { waitingLine, type Waiting } from "@/lib/hot-round";
import { formatPrice, type Market } from "@/lib/markets";
import { HOUR, type Point } from "@/lib/price-feed";
import { cn } from "@/lib/utils";

/**
 * The last hour as a line: left edge is one hour ago, right edge is now (the live price).
 * Lime if the price went up over the hour, lilac if it went down.
 */
function Sparkline({ points, nowMs, className }: { points: Point[]; nowMs: number; className?: string }) {
  const W = 200;
  const H = 48;
  const prices = points.map((p) => p[1]);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const from = nowMs - HOUR;
  const y = (v: number) => H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6);
  const xy = points.map(([t, v]) => `${(((t - from) / HOUR) * W).toFixed(1)},${y(v).toFixed(1)}`);
  const up = prices[prices.length - 1] >= prices[0];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn("w-full", className)} role="img" aria-label={`${up ? "Up" : "Down"} over the last hour`}>
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

function ChartIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3v18h18" />
      <path d="M7 15l4-4 3 3 5-6" />
    </svg>
  );
}

/** The flame on a round card whose calls are waiting on one side only */
function FlameIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2c.6 3.2-1 5.1-2.6 7C7.8 10.8 6 12.8 6 15.5A6 6 0 0 0 18 15.5c0-2.4-1.2-4.3-2.4-5.6-.2 1.5-.9 2.6-2 3.1.4-3.4-.4-7.6-1.6-11Z" />
    </svg>
  );
}

/**
 * One coin: its name, the live price and the last hour as a line. Tapping it picks that market in the call panel.
 * (Which time frame, the countdown and the rounds are in the call panel and the rounds strip, not here.)
 */
export function MarketCard({
  market,
  price,
  points,
  nowMs,
  feedFailed,
  selected,
  onSelect,
  onOpenChart,
  waiting,
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
  selected: boolean;
  onSelect: () => void;
  /** Opens the full chart in a sheet (from the bottom on a phone, centred on a laptop) */
  onOpenChart: () => void;
  /** The round taking calls now has calls on one side only (lib/hot-round.ts); null otherwise */
  waiting: Waiting | null;
  index: number;
}) {
  const spark = points && nowMs !== null ? <Sparkline points={points} nowMs={nowMs} className="h-8 lg:h-12" /> : <span className="block h-8 lg:h-12" aria-hidden />;
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
        <span className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold tracking-tight lg:text-[15px]">{market.label}</span>
          <span className="hidden text-[12px] text-muted-foreground lg:inline">{market.pair}</span>
          {waiting ? (
            <span
              data-testid="hot-flame"
              title={`Calls are waiting on ${waiting.side} only`}
              className="self-center text-[oklch(0.75_0.18_55)] motion-safe:animate-pulse"
            >
              <FlameIcon />
              <span className="sr-only">{`Calls are waiting on ${waiting.side} only`}</span>
            </span>
          ) : null}
        </span>
        {waiting ? (
          <span data-testid="hot-line" className="mt-1 block text-[10px] font-semibold leading-tight text-[oklch(0.75_0.18_55)] lg:text-[12px]">
            {waitingLine(waiting, market.sides)}
          </span>
        ) : null}

        <span className="mt-1.5 block min-w-0 truncate font-mono text-[13px] font-semibold leading-none tracking-[-0.04em] tabular-nums sm:text-[17px] lg:mt-3 lg:text-[30px]">
          {price !== null ? formatPrice(market, price) : feedFailed ? <span className="text-[11px] font-medium tracking-normal text-muted-foreground lg:text-[14px]">unavailable</span> : <span className="text-muted-foreground">…</span>}
        </span>

        <span className="mt-2 block lg:mt-3">{spark}</span>
        <span className="mt-1 hidden text-[11px] text-muted-foreground lg:block">{points && nowMs !== null ? "last hour" : " "}</span>
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
