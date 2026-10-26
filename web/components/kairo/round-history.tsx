"use client";

import * as React from "react";
import { createPortal } from "react-dom";

import { formatUsd, frameWords, type Market } from "@/lib/markets";
import { cn } from "@/lib/utils";
import { usdc, useRoundHistory, type Round } from "@/onchain";

import { RoundBadge, roundStatusOf } from "./round-badge";
import { useOpenRoundCard } from "./round-card-context";

const hm = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const day = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

function resultOf(r: Round): string | null {
  return r.state === "up" ? "UP" : r.state === "down" ? "DOWN" : r.state === "refunded" ? "Refunded" : null;
}

/**
 * Older rounds of the selected market (the last 24 hours, newest first; rounds nobody called are left out). More load as the
 * list is scrolled. Each row opens that round's result card, which sits above this sheet.
 * `newest` is the newest round to list, fixed when the sheet opened.
 */
export function RoundHistory({
  open,
  onClose,
  market,
  newest,
  nowSec,
}: {
  open: boolean;
  onClose: () => void;
  market: Market;
  newest: number | null;
  nowSec: number | null;
}) {
  const openCard = useOpenRoundCard();
  const { rounds, isLoading, isError, hasMore, loadingMore, loadMore } = useRoundHistory(market, newest, open);
  // drawn on the page itself, not inside the tile (a tile is animated, which would make "fixed" mean "inside the tile")
  const mounted = React.useSyncExternalStore(() => () => {}, () => true, () => false);
  const scroller = React.useRef<HTMLDivElement>(null);
  const sentinel = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Load the next page when the end of the list comes into view. The observer is made again after every page, so a page that
  // had no rounds with calls (and left the end still in view) goes straight on to the next one.
  React.useEffect(() => {
    const el = sentinel.current;
    if (!open || !el || !hasMore || loadingMore) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { root: scroller.current, rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [open, hasMore, loadingMore, loadMore, rounds?.length]);

  if (!mounted) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-50" aria-hidden={!open}>
      <div onClick={onClose} className={cn("absolute inset-0 bg-black/60 transition-opacity duration-200", open ? "pointer-events-auto opacity-100" : "opacity-0")} />
      <section
        role="dialog"
        aria-label="Round history"
        className={cn(
          "pointer-events-auto absolute flex max-h-[85dvh] flex-col border border-border bg-card text-card-foreground shadow-2xl transition-[opacity,transform,visibility] duration-200 motion-reduce:transition-none",
          "inset-x-0 bottom-0 rounded-t-[28px] border-b-0",
          "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[520px] sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:rounded-[28px] sm:border-b",
          open ? "visible translate-y-0 opacity-100 sm:-translate-y-1/2" : "invisible translate-y-8 opacity-0 sm:-translate-y-[45%]",
        )}
      >
        <div className="flex items-start justify-between gap-3 px-5 pb-2 pt-4">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-muted-foreground">Round history · last 24 hours</p>
            <h2 className="truncate text-[17px] font-semibold tracking-tight">
              {market.pair} · {frameWords(market.roundSeconds)}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-9 shrink-0 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div ref={scroller} className="flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {rounds === null ? (
            <p className="rounded-2xl border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
              {isError ? "Could not load the history. Close this and try again." : isLoading ? "Loading…" : "Loading…"}
            </p>
          ) : rounds.length === 0 && !hasMore ? (
            <p className="rounded-2xl border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
              No calls on this market in the last 24 hours.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {rounds.map((r, i) => {
                const d = day(r.lockTimeSec);
                const header = i === 0 || day(rounds[i - 1].lockTimeSec) !== d;
                const result = resultOf(r);
                const status = roundStatusOf(r.lockTimeSec, r.endTimeSec, nowSec, result);
                return (
                  <li key={r.roundIndex}>
                    {header ? <p className="pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">{d}</p> : null}
                    <button
                      type="button"
                      onClick={() => openCard?.({ marketId: r.marketId, roundIndex: r.roundIndex, round: r })}
                      className="flex w-full items-center justify-between gap-3 rounded-lg py-2.5 text-left text-[13px] transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="flex items-center gap-2 font-semibold">
                          <span className="font-mono tabular-nums">
                            {hm(r.lockTimeSec)}–{hm(r.endTimeSec)}
                          </span>
                          <RoundBadge status={status} />
                        </span>
                        {r.startPrice !== null && r.endPrice !== null ? (
                          <span className="truncate font-mono text-[12px] tabular-nums text-muted-foreground">
                            {formatUsd(r.startPrice / 1e8)} → {formatUsd(r.endPrice / 1e8)}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-right font-mono tabular-nums">
                        {usdc(r.upTotal + r.downTotal)}
                        <span className="block text-[11px] text-muted-foreground">in the round</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {hasMore ? (
            <div ref={sentinel} className="py-4 text-center font-mono text-[12px] text-muted-foreground">
              {loadingMore ? "loading more…" : ""}
            </div>
          ) : rounds && rounds.length > 0 ? (
            <p className="py-4 text-center text-[12px] text-muted-foreground">That is the last 24 hours. Rounds with no calls are left out.</p>
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}
