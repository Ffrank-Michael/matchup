"use client";

import * as React from "react";

import type { Market } from "@/lib/markets";
import type { Candle, Point } from "@/lib/price-feed";

import { PriceChart } from "./price-chart";

const CLOSE_DISTANCE = 100; // px dragged down that closes the sheet

/**
 * The full chart of the selected market: a panel that slides up from the bottom on a phone, a centred panel on a laptop.
 * Close it with the X, by swiping the top of the panel down (phone), by tapping outside it, or with Escape.
 * Built on the native <dialog>, so focus stays inside while it is open and Escape works by itself.
 */
export function ChartSheet({
  open,
  onClose,
  market,
  price,
  points,
  candles,
  nowMs,
  feedFailed,
  startPrice,
}: {
  open: boolean;
  onClose: () => void;
  market: Market;
  price: number | null;
  points: Point[] | null;
  candles: Candle[] | null;
  nowMs: number | null;
  feedFailed: boolean;
  startPrice: number | null;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const [drag, setDrag] = React.useState<{ from: number; dy: number } | null>(null);

  React.useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: e.clientY, dy: 0 });
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag) setDrag({ from: drag.from, dy: Math.max(0, e.clientY - drag.from) });
  };
  const up = () => {
    if (drag && drag.dy > CLOSE_DISTANCE) onClose();
    setDrag(null);
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={`${market.pair} chart`}
      className="fixed inset-x-0 bottom-0 top-auto m-0 h-auto max-h-none w-full max-w-none bg-transparent p-0 text-foreground backdrop:bg-black/60 lg:inset-0 lg:m-auto lg:h-fit lg:w-[min(680px,calc(100vw-4rem))]"
    >
      {open ? (
        <div
          className="kairo-sheet mx-auto w-full max-w-[560px] rounded-t-[28px] border border-b-0 border-border bg-card pb-[max(1.25rem,env(safe-area-inset-bottom))] lg:max-w-none lg:rounded-[28px] lg:border-b lg:pb-6"
          style={drag ? { transform: `translateY(${drag.dy}px)`, transition: "none" } : { transition: "transform 200ms ease-out" }}
        >
          {/* grab area: swipe down from here to close */}
          <div
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => setDrag(null)}
            className="flex touch-none items-center justify-between gap-3 px-5 pb-2 pt-3"
          >
            <div className="flex flex-1 flex-col">
              <span aria-hidden className="mx-auto mb-2 h-1 w-10 rounded-full bg-border" />
              <h2 className="text-[15px] font-semibold">{market.pair}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label="Close chart"
              className="grid size-9 shrink-0 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div className="px-5 pt-1">
            <PriceChart market={market} price={price} points={points} candles={candles} nowMs={nowMs} feedFailed={feedFailed} startPrice={startPrice} />
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
