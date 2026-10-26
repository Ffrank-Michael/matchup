"use client";

import * as React from "react";

import {
  formatCountdown,
  formatUsd,
  frameWords,
  MARKETS,
  type Market,
} from "@/lib/markets";
import { lastPrice, type Candle, type Point } from "@/lib/price-feed";
import { whoIs, whoName } from "@/lib/players";
import { refundReasonText } from "@/lib/refund-reason";
import { useStartPrice } from "@/lib/use-start-price";
import { cn } from "@/lib/utils";
import { winningSide } from "@/lib/winning";
import {
  settledPayout,
  txLink,
  usdc,
  useCallHistory,
  useClaim,
  usePricePush,
  usePricePushes,
  useRoundCalls,
  useSettlementFor,
  type MyPosition,
  type Round,
} from "@/onchain";

import { AgentAvatar } from "./agent-avatar";
import { PriceProof } from "./price-proof";
import { RoundBadge, roundStatusOf } from "./round-badge";
import { RoundChart } from "./round-chart";
import { INK } from "./tile";

/** Which round is open in the sheet. */
export type Watch = { marketId: number; roundIndex: number };

const SNAPS = [50, 85, 100]; // heights of the phone sheet in dvh: half, the usual one, full screen
const STEP_DISTANCE = 50; // px dragged that moves the sheet to the next height
const clock = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const price8 = (raw: number | null) => (raw === null ? null : raw / 1e8);
const sideColour = (side: "UP" | "DOWN") =>
  side === "UP" ? "var(--color-up)" : "var(--color-down)";

function SidePill({ side }: { side: "UP" | "DOWN" }) {
  return (
    <span
      className="rounded-full px-2.5 py-0.5 text-[12px] font-bold"
      style={{ background: sideColour(side), color: INK }}
    >
      {side === "UP" ? "▲ UP" : "▼ DOWN"}
    </span>
  );
}

/**
 * The price over one round: the trades since it locked. Finished minutes come from the Bitfinex candles; while the sheet is
 * open the live price is also noted every second, so the line moves between candles.
 */
function useRoundSeries(
  candles: Candle[] | null,
  price: number | null,
  nowMs: number | null,
  fromMs: number,
  toMs: number,
  live: boolean,
): Point[] {
  const key = `${fromMs}`;
  const [samples, setSamples] = React.useState<{ key: string; pts: Point[] }>({
    key: "",
    pts: [],
  });

  React.useEffect(() => {
    if (!live || price === null || nowMs === null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one new sample per second from the shared price feed
    setSamples((s) =>
      s.key === key
        ? { key, pts: [...s.pts, [nowMs, price] as const].slice(-2000) }
        : { key, pts: [[nowMs, price] as const] },
    );
  }, [live, price, nowMs, key]);

  return React.useMemo(() => {
    const out: Point[] = [];
    const mine = samples.key === key ? samples.pts : [];
    const firstSample = mine.length ? mine[0][0] : Infinity;
    for (const c of candles ?? []) {
      if (c.t + 60_000 <= fromMs || c.t > toMs) continue;
      if (c.t <= fromMs) out.push([fromMs, c.open]); // the price when the round locked, as of the minute it locked in
      const at = c.t + 59_999; // the minute's last trade; a minute that closes after the round ended is not part of it
      if (
        at <= toMs &&
        at > fromMs &&
        at < firstSample &&
        (nowMs === null || at < nowMs)
      )
        out.push([at, c.close]);
    }
    for (const p of mine) if (p[0] <= toMs) out.push(p);
    return out;
  }, [candles, samples, key, fromMs, toMs, nowMs]);
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-[13px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * "Watch live": opens when you make a call or tap a call in Your calls or Live calls. A bottom sheet on a phone (about
 * 85% of the height, the page dimmed behind it, closed by swiping down or tapping outside); a panel on the right on a laptop
 * (about 40% of the width) that leaves the rest of the page usable. It shows the round: your call, the live chart against the
 * start price, the time left, everyone in the round, and at the end the result with a Claim button.
 */
export function WatchSheet({
  watch,
  onClose,
  roundsByMarket,
  positions,
  candlesFor,
  nowSec,
  me,
  onNext,
}: {
  watch: Watch | null;
  onClose: () => void;
  roundsByMarket: Record<number, Round[]> | null;
  positions: MyPosition[] | null;
  candlesFor: (market: Market) => Candle[] | null;
  nowSec: number | null;
  me: string | undefined;
  /** "Call the next round": picks this market in the call panel and scrolls to it */
  onNext: (market: Market) => void;
}) {
  // keep showing the last round while the sheet slides away
  const [held, setHeld] = React.useState<Watch | null>(watch);
  // phone: which of the three heights the sheet is at; laptop: whether the panel fills the whole width
  const [snap, setSnap] = React.useState(1);
  const [expanded, setExpanded] = React.useState(false);
  if (
    watch &&
    (!held ||
      held.marketId !== watch.marketId ||
      held.roundIndex !== watch.roundIndex)
  ) {
    setHeld(watch);
    setSnap(1);
    setExpanded(false);
  }
  const w = watch ?? held;
  const open = watch !== null;

  const market = w ? MARKETS.find((m) => m.id === w.marketId) : undefined;
  const round = w
    ? roundsByMarket?.[w.marketId]?.find((r) => r.roundIndex === w.roundIndex)
    : undefined;
  const position = w
    ? positions?.find(
        (p) => p.marketId === w.marketId && p.roundIndex === w.roundIndex,
      )
    : undefined;
  const lock = round?.lockTimeSec ?? null;
  const end = round?.endTimeSec ?? null;
  const roundLength = market?.roundSeconds ?? null;
  const { calls } = useRoundCalls(
    open && w ? w.marketId : null,
    open && w ? w.roundIndex : null,
    lock,
    roundLength,
  );
  const {
    claim,
    status: claimStatus,
    txHash: claimTx,
    errorMessage: claimError,
    reset: resetClaim,
  } = useClaim();

  const nowMs = nowSec === null ? null : nowSec * 1000;
  const candles = market ? candlesFor(market) : null;
  const livePrice = lastPrice(candles);
  const running =
    nowSec !== null &&
    lock !== null &&
    end !== null &&
    nowSec >= lock &&
    nowSec < end;
  const before = nowSec !== null && lock !== null && nowSec < lock;
  const series = useRoundSeries(
    candles,
    livePrice,
    nowMs,
    (lock ?? 0) * 1000,
    (end ?? 0) * 1000,
    running && open,
  );

  // ── the viewer's call, from the events (or the contract's position if the events have not arrived yet)
  const mineCalls = (calls ?? []).filter(
    (c) => me && c.player.toLowerCase() === me.toLowerCase(),
  );
  const mySide: "UP" | "DOWN" | null = mineCalls.length
    ? mineCalls[0].side
    : position
      ? position.up > 0n
        ? "UP"
        : position.down > 0n
          ? "DOWN"
          : null
      : null;
  const myAmount = mineCalls.length
    ? mineCalls.reduce((s, c) => s + c.amount, 0n)
    : position
      ? position.up + position.down
      : 0n;
  const history = useCallHistory(
    w ? w.marketId : null,
    w ? w.roundIndex : null,
    me,
  );
  const myTx =
    history?.callTx ?? (mineCalls.length ? mineCalls[0].txHash : null);

  // ── the round's story
  // the contract records the start price when it settles the round; until then the site finds the same trade the runner uses
  const startPrice = useStartPrice(
    market?.key ?? null,
    lock,
    nowSec,
    price8(round?.startPrice ?? null),
  );
  const endPrice = price8(round?.endPrice ?? null);
  // what the chain recorded: the prices (with the transactions that recorded them) and, for a refund, the reason
  const { settlement } = useSettlementFor(
    open && w ? w.marketId : null,
    open && w ? w.roundIndex : null,
  );
  const pushes = usePricePushes(market ? [market.feed] : []);
  const startPush = usePricePush(
    market?.feed ?? null,
    settlement && settlement.startRoundId > 0n ? settlement.startRoundId : null,
    pushes,
  );
  const endPush = usePricePush(
    market?.feed ?? null,
    settlement && settlement.endRoundId > 0n ? settlement.endRoundId : null,
    pushes,
  );
  const shownPrice = endPrice ?? livePrice;
  const lead = winningSide(shownPrice, startPrice);
  const settled = round?.state === "up" || round?.state === "down";
  const refunded = round?.state === "refunded";
  const finished = settled || refunded;
  const winner =
    round?.state === "up" ? "UP" : round?.state === "down" ? "DOWN" : null;
  const winnerTotal = round
    ? winner === "UP"
      ? round.upTotal
      : round.downTotal
    : 0n;
  const loserTotal = round
    ? winner === "UP"
      ? round.downTotal
      : round.upTotal
    : 0n;
  const won = settled && mySide !== null && mySide === winner;
  const payout = won ? settledPayout(myAmount, winnerTotal, loserTotal) : 0n;
  // this caller's share of the 2% fee: the fee is taken from the losing side, in proportion to the winners' stakes
  const feeShare =
    won && winnerTotal > 0n
      ? (((loserTotal * 200n) / 10_000n) * myAmount) / winnerTotal
      : 0n;
  const canClaim =
    position &&
    position.claimableKind !== "none" &&
    !position.claimed &&
    position.claimableAmount > 0n;

  // ── everyone in the round: one line per wallet
  const people = React.useMemo(() => {
    const by = new Map<
      string,
      { player: `0x${string}`; side: "UP" | "DOWN"; amount: bigint }
    >();
    for (const c of calls ?? []) {
      const k = c.player.toLowerCase();
      const prev = by.get(k);
      by.set(k, {
        player: c.player,
        side: c.side,
        amount: (prev?.amount ?? 0n) + c.amount,
      });
    }
    const rank = (a: { player: string }) =>
      whoIs(a.player, me).kind === "you"
        ? 0
        : whoIs(a.player, me).kind === "agent"
          ? 1
          : 2;
    return [...by.values()].sort(
      (a, b) => rank(a) - rank(b) || Number(b.amount - a.amount),
    );
  }, [calls, me]);

  // ── sheet behaviour: Escape closes, swipe down closes (phone)
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  const [drag, setDrag] = React.useState<{ from: number; dy: number } | null>(
    null,
  );
  const phone = () =>
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 1023px)").matches;
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!phone()) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: e.clientY, dy: 0 });
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag) setDrag({ from: drag.from, dy: e.clientY - drag.from });
  };
  const up = () => {
    if (drag && drag.dy < -STEP_DISTANCE)
      setSnap((s) => Math.min(SNAPS.length - 1, s + 1));
    else if (drag && drag.dy > STEP_DISTANCE) {
      if (snap === 0) onClose();
      else setSnap((s) => s - 1);
    }
    setDrag(null);
  };

  const myLabel = mySide ? `Your call: ${mySide} ${usdc(myAmount)}` : null;
  const frame = market ? frameWords(market.roundSeconds) : "";

  return (
    <div className="pointer-events-none fixed inset-0 z-50" aria-hidden={!open}>
      {/* phone: the page is dimmed; tapping it closes the sheet. Laptop: no dimming, the page stays usable. */}
      <div
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-black/60 transition-opacity duration-300 lg:hidden",
          open ? "pointer-events-auto opacity-100" : "opacity-0",
        )}
      />
      <section
        role="dialog"
        aria-label="Watch live"
        style={
          {
            "--sheet-h": `min(100dvh, max(30dvh, calc(${SNAPS[snap]}dvh - ${drag?.dy ?? 0}px)))`,
            ...(drag ? { transition: "none" } : {}),
          } as React.CSSProperties
        }
        className={cn(
          "pointer-events-auto absolute flex flex-col border border-border bg-card text-card-foreground shadow-2xl",
          "inset-x-0 bottom-0 h-[var(--sheet-h)] rounded-t-[28px] border-b-0",
          snap === 2 && "max-lg:rounded-t-none",
          "lg:inset-x-auto lg:bottom-0 lg:right-0 lg:top-0 lg:h-auto lg:rounded-none lg:border-b lg:border-r-0",
          expanded
            ? "lg:w-screen lg:max-w-none lg:border-l-0"
            : "lg:w-[40vw] lg:min-w-[440px] lg:max-w-[640px] lg:rounded-l-[28px]",
          "transition-[transform,visibility,height,width] duration-300 ease-out motion-reduce:transition-none",
          open
            ? "visible translate-y-0 lg:translate-x-0"
            : "invisible translate-y-full delay-0 lg:translate-x-full lg:translate-y-0",
        )}
      >
        {/* grab area: swipe down from here to close (phone) */}
        <div
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => setDrag(null)}
          className="flex touch-none select-none items-start justify-between gap-3 px-5 pb-2 pt-3"
        >
          <div className="min-w-0 flex-1">
            <span
              aria-hidden
              className="mx-auto mb-2 block h-1 w-10 rounded-full bg-border lg:hidden"
            />
            <h2 className="truncate text-[16px] font-semibold tracking-tight">
              {market ? `${market.pair} · ${frame}` : "Round"}
            </h2>
            <p className="mt-0.5 flex items-center gap-2 text-[12px] text-muted-foreground">
              {lock !== null && end !== null ? (
                <RoundBadge
                  status={roundStatusOf(
                    lock,
                    end,
                    nowSec,
                    settled ? (winner as string) : refunded ? "Refunded" : null,
                  )}
                />
              ) : null}
              {lock !== null && end !== null
                ? `${clock(lock)}–${clock(end)}`
                : " "}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setExpanded((x) => !x)}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={
              expanded ? "Make the panel smaller" : "Make the panel full width"
            }
            aria-pressed={expanded}
            className="hidden size-9 shrink-0 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:grid"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {expanded ? (
                <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
              ) : (
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
              )}
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Close"
            className="grid size-9 shrink-0 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {!round || !market ? (
            <p className="rounded-2xl border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
              Loading this round…
            </p>
          ) : (
            <>
              {/* the headline: what is happening to your call right now, or how the round ended */}
              {finished ? (
                <div
                  className="rounded-3xl p-4"
                  style={{
                    background: refunded
                      ? "var(--color-muted)"
                      : sideColour(winner ?? "UP"),
                    color: refunded ? undefined : INK,
                  }}
                >
                  <p className="text-[13px] font-semibold opacity-80">
                    {refunded
                      ? `Round refunded · ${refundReasonText(settlement?.reason)}`
                      : `Ended ${winner}${mySide ? (won ? " ✓" : "") : ""}`}
                  </p>
                  <p className="mt-1 text-[28px] font-bold leading-tight tracking-[-0.03em]">
                    {mySide === null
                      ? settled
                        ? `Start ${formatUsd(startPrice ?? 0)} → End ${formatUsd(endPrice ?? 0)}`
                        : "No one's money was lost"
                      : refunded
                        ? `You get your ${usdc(myAmount)} back`
                        : won
                          ? `You won ${usdc(payout - myAmount)}`
                          : `You lost ${usdc(myAmount)}`}
                  </p>
                  {mySide !== null && settled ? (
                    <p className="mt-1 text-[13px] font-medium opacity-80">
                      Start {formatUsd(startPrice ?? 0)} → End{" "}
                      {formatUsd(endPrice ?? 0)}
                    </p>
                  ) : null}
                </div>
              ) : before ? (
                <div className="rounded-3xl border border-border bg-muted/40 p-4">
                  <p className="text-[13px] font-semibold text-muted-foreground">
                    Round starts in
                  </p>
                  <p className="mt-1 font-mono text-[40px] font-semibold leading-none tracking-[-0.04em] tabular-nums">
                    {nowSec !== null && lock !== null
                      ? formatCountdown(Math.max(0, lock - nowSec))
                      : "--:--"}
                  </p>
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    {mySide
                      ? `You called ${mySide} for this round. The chart starts when it does.`
                      : "The chart starts when the round does."}
                  </p>
                </div>
              ) : nowSec !== null && end !== null && nowSec >= end ? (
                <div className="rounded-3xl border border-border bg-muted/40 p-4">
                  <p className="text-[13px] font-semibold text-muted-foreground">
                    Round ended
                  </p>
                  <p className="mt-1 text-[24px] font-bold leading-tight tracking-[-0.02em]">
                    Waiting for the result
                  </p>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    The final price is being recorded. This takes a few seconds.
                  </p>
                </div>
              ) : (
                <div
                  className="rounded-3xl p-4"
                  style={
                    lead && lead !== "LEVEL"
                      ? { background: sideColour(lead), color: INK }
                      : { background: "var(--color-muted)" }
                  }
                >
                  <div className="flex items-end justify-between gap-3">
                    <p className="text-[30px] font-bold leading-tight tracking-[-0.03em]">
                      {lead === null
                        ? "Waiting for the start price"
                        : lead === "LEVEL"
                          ? "Level with the start price"
                          : mySide
                            ? mySide === lead
                              ? "You're winning"
                              : "You're losing"
                            : `${lead} is winning`}
                    </p>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-[28px] font-semibold leading-none tabular-nums">
                        {nowSec !== null && end !== null
                          ? formatCountdown(Math.max(0, end - nowSec))
                          : "--:--"}
                      </p>
                      <p className="mt-1 text-[11px] font-medium opacity-75">
                        left
                      </p>
                    </div>
                  </div>
                  {lead && lead !== "LEVEL" ? (
                    <p className="mt-2 text-[13px] font-medium opacity-80">
                      {lead === "UP"
                        ? "▲ The price is above the start price, so UP is ahead."
                        : "▼ The price is below the start price, so DOWN is ahead."}
                    </p>
                  ) : null}
                </div>
              )}

              {/* the chart */}
              {before ? null : (
                <div className="mt-4 rounded-2xl border border-border p-2">
                  {lock !== null && end !== null ? (
                    <RoundChart
                      fromMs={lock * 1000}
                      toMs={end * 1000}
                      nowMs={finished ? null : nowMs}
                      points={series}
                      candles={(candles ?? []).filter(
                        (c) =>
                          c.t >= (lock ?? 0) * 1000 &&
                          c.t < (end ?? 0) * 1000 &&
                          c.t + 60_000 <= (nowMs ?? Infinity),
                      )}
                      startPrice={startPrice}
                      endPrice={endPrice}
                      myCall={
                        mySide && myLabel
                          ? { side: mySide, label: myLabel }
                          : null
                      }
                    />
                  ) : null}
                  <p className="px-1 pt-1 text-[11px] text-muted-foreground">
                    Bitfinex last trade, updated every second · dashed line =
                    start price
                  </p>
                </div>
              )}

              {/* your call */}
              {mySide ? (
                <dl className="mt-4 divide-y divide-border rounded-2xl border border-border px-4">
                  <Row label="Market">{market.pair}</Row>
                  <Row label="Time frame">{frame}</Row>
                  <Row label="Your call">
                    <span className="inline-flex items-center gap-2">
                      <SidePill side={mySide} /> {usdc(myAmount)}
                    </span>
                  </Row>
                  <Row label="Start price">
                    {startPush ? (
                      <PriceProof
                        coin={market.key}
                        price={settlement?.startPrice ?? startPrice}
                        push={startPush}
                        round={{
                          marketId: market.id,
                          roundIndex: round.roundIndex,
                        }}
                      />
                    ) : startPrice !== null ? (
                      formatUsd(startPrice)
                    ) : before ? (
                      "At the start of the round"
                    ) : (
                      "Recording…"
                    )}
                  </Row>
                  <Row
                    label={
                      finished || endPrice !== null
                        ? "End price"
                        : "Current price"
                    }
                  >
                    {endPush ? (
                      <PriceProof
                        coin={market.key}
                        price={settlement?.endPrice ?? endPrice}
                        push={endPush}
                        round={{
                          marketId: market.id,
                          roundIndex: round.roundIndex,
                        }}
                      />
                    ) : shownPrice !== null ? (
                      formatUsd(shownPrice)
                    ) : (
                      "…"
                    )}
                  </Row>
                  <Row label="Result">
                    {refunded ? (
                      <span>
                        Refunded
                        <span className="block text-[11px] font-normal text-muted-foreground">
                          {refundReasonText(settlement?.reason)}
                        </span>
                      </span>
                    ) : settled ? (
                      won ? (
                        "Won"
                      ) : (
                        "Lost"
                      )
                    ) : before ? (
                      "Not started"
                    ) : running ? (
                      "Running"
                    ) : (
                      "Waiting for the result"
                    )}
                  </Row>
                  {finished ? (
                    <>
                      <Row label="Paid out">
                        {history?.paidOut !== null &&
                        history?.paidOut !== undefined
                          ? usdc(history.paidOut)
                          : position && position.claimableAmount > 0n
                            ? `${usdc(position.claimableAmount)} waiting to be claimed`
                            : refunded || won
                              ? "…"
                              : "$0.00"}
                      </Row>
                      <Row label="Fee">
                        {won
                          ? `${usdc(feeShare)} (2% of winnings)`
                          : "$0.00 (no fee)"}
                      </Row>
                    </>
                  ) : null}
                  {history?.callTime ? (
                    <Row label="Called at">
                      {new Date(history.callTime * 1000).toLocaleString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: false,
                        day: "numeric",
                        month: "short",
                      })}
                    </Row>
                  ) : null}
                  {before ? (
                    <Row label="Starts in">
                      {nowSec !== null && lock !== null
                        ? formatCountdown(Math.max(0, lock - nowSec))
                        : "…"}
                    </Row>
                  ) : (
                    <Row label="Time left">
                      {nowSec !== null && end !== null
                        ? nowSec >= end
                          ? "Ended"
                          : formatCountdown(end - nowSec)
                        : "…"}
                    </Row>
                  )}
                </dl>
              ) : null}

              {/* the buttons */}
              {canClaim ? (
                <button
                  type="button"
                  disabled={
                    claimStatus === "claim-wallet" ||
                    claimStatus === "claim-confirming"
                  }
                  onClick={() => void claim(position)}
                  className="mt-4 h-14 w-full rounded-2xl text-[16px] font-bold disabled:opacity-60"
                  style={{ background: "var(--color-up)", color: INK }}
                >
                  {position.claimableKind === "win"
                    ? `Claim ${usdc(position.claimableAmount)}`
                    : `Get your ${usdc(position.claimableAmount)} back`}
                </button>
              ) : null}
              {claimStatus !== "idle" ? (
                <p
                  className="mt-2 text-center text-[12px] text-muted-foreground"
                  role="status"
                >
                  {claimStatus === "failed"
                    ? claimError
                    : claimStatus === "done"
                      ? "Done. The money is in your wallet."
                      : "Confirm in your wallet."}{" "}
                  {claimStatus === "done" || claimStatus === "failed" ? (
                    <button
                      type="button"
                      onClick={resetClaim}
                      className="underline underline-offset-2"
                    >
                      Dismiss
                    </button>
                  ) : null}{" "}
                  {claimTx ? (
                    <a
                      href={txLink(claimTx) ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2"
                    >
                      View transaction
                    </a>
                  ) : null}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  onNext(market);
                  onClose();
                }}
                className="mt-3 h-12 w-full rounded-2xl border-2 border-border text-[15px] font-semibold transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Call the next round
              </button>

              {/* everyone in this round */}
              <h3 className="mb-1 mt-6 text-[13px] font-medium text-muted-foreground">
                Everyone in this round
              </h3>
              {calls === null ? (
                <p className="py-3 font-mono text-[12px] text-muted-foreground">
                  loading…
                </p>
              ) : people.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border p-4 text-center text-[13px] text-muted-foreground">
                  No calls in this round yet.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {people.map((p) => {
                    const who = whoIs(p.player, me);
                    return (
                      <li
                        key={p.player}
                        className="flex items-center justify-between gap-3 py-2.5 text-[13px]"
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          {who.kind === "agent" ? (
                            <AgentAvatar agent={who.agent} size={32} />
                          ) : (
                            <span
                              aria-hidden
                              className="grid size-8 shrink-0 place-items-center rounded-full text-[12px] font-bold"
                              style={
                                who.kind === "you"
                                  ? {
                                      background: "var(--color-up)",
                                      color: INK,
                                    }
                                  : {
                                      background: "var(--color-muted)",
                                      color: "var(--color-muted-foreground)",
                                    }
                              }
                            >
                              {who.kind === "you" ? "Y" : "P"}
                            </span>
                          )}
                          <span
                            className={cn(
                              "truncate font-medium",
                              who.kind === "player" && "text-muted-foreground",
                            )}
                            style={
                              who.kind === "agent"
                                ? { color: who.agent.colour }
                                : undefined
                            }
                          >
                            {whoName(p.player, me)}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <SidePill side={p.side} />
                          <span className="w-16 text-right font-mono tabular-nums">
                            {usdc(p.amount)}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}

              {myTx || history?.claimTx ? (
                <p className="mt-5 flex justify-center gap-4 text-center text-[11px] text-muted-foreground">
                  {history?.claimTx ? (
                    <a
                      href={txLink(history.claimTx) ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      Claim transaction
                    </a>
                  ) : null}
                  {myTx ? (
                    <a
                      href={txLink(myTx) ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      Call transaction
                    </a>
                  ) : null}
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
