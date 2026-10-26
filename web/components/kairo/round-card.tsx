"use client";

import * as React from "react";

import { formatUsd, frameWords, MARKETS } from "@/lib/markets";
import { useBackedAgents } from "@/lib/backed";
import { whoIs, whoName } from "@/lib/players";
import { refundReasonText } from "@/lib/refund-reason";
import { cn } from "@/lib/utils";
import {
  settledPayout,
  txLink,
  usdc,
  usePricePush,
  usePricePushes,
  useRoundCalls,
  useSettlementFor,
  type Round,
} from "@/onchain";

import { AgentAvatar } from "./agent-avatar";
import { PriceProof } from "./price-proof";
import { RoundBadge, roundStatusOf } from "./round-badge";
import { INK } from "./tile";
import { OpenRoundCard, type RoundRef } from "./round-card-context";

const clock = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 text-[13px]">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * Wraps the page and shows our own round result card when something calls `useOpenRoundCard()`: this is what every "Verify"
 * link opens. The card shows the start and end price with their times, every call in the round with Won or Lost, the totals
 * and the fee. Small "View on blockchain" links inside it go to the explorer, which is used only for transactions.
 */
export function RoundCardProvider({
  roundsByMarket,
  nowSec,
  me,
  children,
}: {
  roundsByMarket: Record<number, Round[]> | null;
  nowSec: number | null;
  me: string | undefined;
  children: React.ReactNode;
}) {
  const [ref, setRef] = React.useState<RoundRef | null>(null);
  const open = React.useCallback((r: RoundRef) => setRef(r), []);
  const close = React.useCallback(() => setRef(null), []);
  return (
    <OpenRoundCard.Provider value={open}>
      {children}
      <RoundCard
        target={ref}
        onClose={close}
        roundsByMarket={roundsByMarket}
        nowSec={nowSec}
        me={me}
      />
    </OpenRoundCard.Provider>
  );
}

function RoundCard({
  target,
  onClose,
  roundsByMarket,
  nowSec,
  me,
}: {
  target: RoundRef | null;
  onClose: () => void;
  roundsByMarket: Record<number, Round[]> | null;
  nowSec: number | null;
  me: string | undefined;
}) {
  // keep showing the last round while the card fades out
  const [held, setHeld] = React.useState<RoundRef | null>(target);
  if (
    target &&
    (!held ||
      held.marketId !== target.marketId ||
      held.roundIndex !== target.roundIndex)
  )
    setHeld(target);
  const open = target !== null;
  const w = target ?? held;
  const backedOf = useBackedAgents(me);

  const market = w ? MARKETS.find((m) => m.id === w.marketId) : undefined;
  const round = w
    ? (roundsByMarket?.[w.marketId]?.find((r) => r.roundIndex === w.roundIndex) ?? w.round)
    : undefined;
  const lock = round?.lockTimeSec ?? null;
  const end = round?.endTimeSec ?? null;
  const { calls } = useRoundCalls(
    open && w ? w.marketId : null,
    open && w ? w.roundIndex : null,
    lock,
    market?.roundSeconds ?? null,
  );
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

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const settled = round?.state === "up" || round?.state === "down";
  const refunded = round?.state === "refunded";
  const winner =
    round?.state === "up" ? "UP" : round?.state === "down" ? "DOWN" : null;
  const winnerTotal = round
    ? winner === "UP"
      ? round.upTotal
      : round.downTotal
    : 0n;
  // matched calls: M is the smaller side. Only M from each side plays; the extra on the bigger side comes back.
  const matchedM = round ? (round.upTotal < round.downTotal ? round.upTotal : round.downTotal) : 0n;
  const biggerTotal = round ? (round.upTotal > round.downTotal ? round.upTotal : round.downTotal) : 0n;
  const fee = settled && matchedM > 0n ? (matchedM * 200n) / 10_000n : 0n;
  const total = round ? round.upTotal + round.downTotal : 0n;

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

  const status =
    lock !== null && end !== null
      ? roundStatusOf(
          lock,
          end,
          nowSec,
          settled ? (winner as string) : refunded ? "Refunded" : null,
        )
      : null;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[60]"
      aria-hidden={!open}
    >
      <div
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-black/60 transition-opacity duration-200",
          open ? "pointer-events-auto opacity-100" : "opacity-0",
        )}
      />
      <section
        role="dialog"
        aria-label="Round result"
        className={cn(
          "pointer-events-auto absolute flex max-h-[90dvh] flex-col border border-border bg-card text-card-foreground shadow-2xl transition-[opacity,transform,visibility] duration-200 motion-reduce:transition-none",
          "inset-x-0 bottom-0 rounded-t-[28px] border-b-0",
          "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[560px] sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:rounded-[28px] sm:border-b",
          open
            ? "visible translate-y-0 opacity-100 sm:-translate-y-1/2"
            : "invisible translate-y-8 opacity-0 sm:-translate-y-[45%]",
        )}
      >
        <div className="flex items-start justify-between gap-3 px-5 pb-2 pt-4">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-muted-foreground">
              Round result
            </p>
            <h2 className="truncate text-[17px] font-semibold tracking-tight">
              {market
                ? `${market.pair} · ${frameWords(market.roundSeconds)}`
                : "Round"}
            </h2>
            <p className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
              {status ? <RoundBadge status={status} /> : null}
              {lock !== null && end !== null
                ? `${clock(lock)}–${clock(end)}`
                : null}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
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
              <div
                className="rounded-3xl p-4"
                style={{
                  background: winner
                    ? sideColour(winner)
                    : "var(--color-muted)",
                  color: winner ? INK : undefined,
                }}
              >
                <p className="text-[13px] font-semibold opacity-80">
                  {winner
                    ? `${winner} won`
                    : refunded
                      ? `Refunded · ${refundReasonText(settlement?.reason)}`
                      : "Not settled yet"}
                </p>
                <p className="mt-1 text-[22px] font-bold leading-tight tracking-[-0.02em]">
                  {settlement &&
                  (settlement.startPrice !== null ||
                    settlement.endPrice !== null)
                    ? `Start ${settlement.startPrice !== null ? formatUsd(settlement.startPrice) : "none"} → End ${settlement.endPrice !== null ? formatUsd(settlement.endPrice) : "none"}`
                    : refunded
                      ? "No prices were recorded"
                      : "Prices are recorded when the round is settled"}
                </p>
              </div>

              <dl className="mt-4 divide-y divide-border rounded-2xl border border-border px-4">
                <Row label="Start price">
                  <PriceProof
                    coin={market.key}
                    price={settlement?.startPrice ?? null}
                    push={startPush}
                  />
                </Row>
                <Row label="End price">
                  <PriceProof
                    coin={market.key}
                    price={settlement?.endPrice ?? null}
                    push={endPush}
                  />
                </Row>
                <Row label="Total in this round">{usdc(total)}</Row>
                <Row label="On UP">{usdc(round.upTotal)}</Row>
                <Row label="On DOWN">{usdc(round.downTotal)}</Row>
                {settled ? (
                  <Row label="Matched">
                    {`${usdc(matchedM)} on each side`}
                    {biggerTotal > matchedM ? (
                      <span className="block text-[11px] font-normal text-muted-foreground">
                        {`${usdc(biggerTotal - matchedM)} was not matched and came back`}
                      </span>
                    ) : null}
                  </Row>
                ) : null}
                <Row label="Fee">
                  {settled
                    ? `${usdc(fee)} (2% of the matched ${usdc(matchedM)})`
                    : "$0.00 (no fee on a refund)"}
                </Row>
                {settled ? (
                  <Row label="Paid to winners">{usdc(winnerTotal + matchedM - fee)}</Row>
                ) : null}
              </dl>

              <h3 className="mb-1 mt-5 text-[13px] font-medium text-muted-foreground">
                Every call in this round
              </h3>
              {calls === null ? (
                <p className="py-3 font-mono text-[12px] text-muted-foreground">
                  loading…
                </p>
              ) : people.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border p-4 text-center text-[13px] text-muted-foreground">
                  No calls in this round.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {people.map((p) => {
                    const who = whoIs(p.player, me);
                    const backed = who.kind === "you" ? backedOf(market.id, round.roundIndex) : null;
                    const avatarAgent = backed ?? (who.kind === "agent" ? who.agent : null);
                    const result = winner
                      ? p.side === winner
                        ? "won"
                        : "lost"
                      : refunded
                        ? "refunded"
                        : null;
                    // matched calls: a win adds the matched share of the pot; a loss costs only the matched part of the stake
                    const mineTotal = p.side === "UP" ? round.upTotal : round.downTotal;
                    const otherTotal = p.side === "UP" ? round.downTotal : round.upTotal;
                    const delta =
                      result === "won" || result === "lost"
                        ? settledPayout(p.amount, mineTotal, otherTotal, result === "won") - p.amount
                        : 0n;
                    return (
                      <li
                        key={p.player}
                        className="flex items-center justify-between gap-3 py-2.5 text-[13px]"
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          {avatarAgent ? (
                            <AgentAvatar agent={avatarAgent} size={30} />
                          ) : (
                            <span
                              aria-hidden
                              className="grid size-[30px] shrink-0 place-items-center rounded-full text-[12px] font-bold"
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
                            {backed ? <span className="font-normal text-muted-foreground"> · backing {backed.name}</span> : null}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <SidePill side={p.side} />
                          <span className="font-mono tabular-nums">
                            {usdc(p.amount)}
                          </span>
                          {result ? (
                            <span
                              className={cn(
                                "min-w-[78px] text-right text-[12px] font-semibold",
                                result === "won"
                                  ? "text-up"
                                  : "text-muted-foreground",
                              )}
                            >
                              {result === "won"
                                ? `✓ Won ${usdc(delta)}`
                                : result === "lost"
                                  ? `✗ Lost ${usdc(-delta)}`
                                  : "Refunded"}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}

              {settlement ? (
                <p className="mt-5 flex flex-wrap justify-center gap-x-4 gap-y-1 text-center text-[11px] text-muted-foreground">
                  <a
                    href={txLink(settlement.tx) ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    View on blockchain · result
                  </a>
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
