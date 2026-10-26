"use client";

import { formatCountdown, MARKETS } from "@/lib/markets";
import type { MyPosition, Round } from "@/onchain";

/**
 * A small floating pill at the bottom of the screen while the viewer has a call in a round that is running now:
 * "Your call is live · 02:31 · Watch". Tapping it reopens the Watch live sheet. It hides while the sheet is open.
 */
export function LivePill({
  positions,
  roundsByMarket,
  nowSec,
  hidden,
  onWatch,
}: {
  positions: MyPosition[] | null;
  roundsByMarket: Record<number, Round[]> | null;
  nowSec: number | null;
  hidden: boolean;
  onWatch: (marketId: number, roundIndex: number) => void;
}) {
  if (hidden || nowSec === null || !positions) return null;
  // the call whose round ends first
  let best: { marketId: number; roundIndex: number; endSec: number } | null =
    null;
  for (const p of positions) {
    if (p.up + p.down <= 0n) continue;
    const r = roundsByMarket?.[p.marketId]?.find(
      (x) => x.roundIndex === p.roundIndex,
    );
    if (!r || nowSec < r.lockTimeSec || nowSec >= r.endTimeSec) continue;
    if (!best || r.endTimeSec < best.endSec)
      best = {
        marketId: p.marketId,
        roundIndex: p.roundIndex,
        endSec: r.endTimeSec,
      };
  }
  if (!best) return null;
  const market = MARKETS.find((m) => m.id === best.marketId);
  return (
    <button
      type="button"
      onClick={() => onWatch(best.marketId, best.roundIndex)}
      aria-label={`Your ${market?.pair ?? ""} call is live, ${formatCountdown(best.endSec - nowSec)} left. Watch`}
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-40 flex whitespace-nowrap -translate-x-1/2 items-center gap-2.5 rounded-full border border-border bg-card px-4 py-2.5 text-[13px] font-semibold shadow-xl transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden
        className="kairo-blink size-2 rounded-full bg-[oklch(0.66_0.2_22)]"
      />
      <span>Your call is live</span>
      <span aria-hidden className="text-muted-foreground">
        ·
      </span>
      <span className="font-mono tabular-nums">
        {formatCountdown(Math.max(0, best.endSec - nowSec))}
      </span>
      <span aria-hidden className="text-muted-foreground">
        ·
      </span>
      <span
        className="rounded-full bg-up px-2.5 py-0.5 text-[12px] font-bold"
        style={{ color: "oklch(0.24 0.06 135)" }}
      >
        Watch
      </span>
    </button>
  );
}
