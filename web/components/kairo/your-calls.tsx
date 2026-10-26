"use client";

import * as React from "react";
import { useConnection } from "wagmi";

import { MARKETS } from "@/lib/markets";
import { refundReasonText } from "@/lib/refund-reason";
import {
  claimLabel,
  CLAIM_STATUS_TEXT,
  settledPayout,
  settlementKey,
  txLink,
  usdc,
  useClaim,
  useSettlements,
  type MyPosition,
  type Round,
} from "@/onchain";

import { StartEnd } from "./price-proof";
import { RoundBadge, roundStatusOf } from "./round-badge";
import { Tile } from "./tile";

const clock = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const INK = "oklch(0.24 0.06 135)";

/** How a position stands, in words, from the round's real state. */
function describe(
  p: MyPosition,
  round: Round | undefined,
): { text: string; tone: "open" | "claim" | "done" | "lost" } {
  if (!round) return { text: "…", tone: "open" };
  if (p.claimed)
    return {
      text: round.state === "refunded" ? "Refunded" : "Paid out",
      tone: "done",
    };
  if (p.claimableKind === "win") return { text: "Won", tone: "claim" };
  if (p.claimableKind === "refund") return { text: "Refunded", tone: "claim" };
  // matched calls: lost, but the unmatched part of the stake is waiting to be claimed
  if (p.claimableKind === "partial") return { text: "Lost", tone: "claim" };
  if (round.state === "up" || round.state === "down")
    return { text: "Lost", tone: "lost" };
  return {
    text:
      round.state === "open"
        ? "Open"
        : round.state === "locked"
          ? "Running"
          : "Waiting for the result",
    tone: "open",
  };
}

/**
 * The connected wallet's calls, read from the contract: open ones first, then finished ones marked won, lost or
 * refunded, with a button for money that is waiting, and Claim all.
 */
export function YourCalls({
  positions,
  roundsByMarket,
  nowSec,
  onOpen,
  index,
  className,
}: {
  positions: MyPosition[] | null;
  roundsByMarket: Record<number, Round[]> | null;
  nowSec: number | null;
  onOpen: (marketId: number, roundIndex: number) => void;
  index: number;
  className?: string;
}) {
  const { address } = useConnection();
  const { claim, claimAll, status, txHash, errorMessage, reset } = useClaim();
  const busy = status === "claim-wallet" || status === "claim-confirming";
  const settlements = useSettlements();

  const rows = React.useMemo(() => {
    const list = (positions ?? []).map((p) => ({
      p,
      round: roundsByMarket?.[p.marketId]?.find(
        (r) => r.roundIndex === p.roundIndex,
      ),
    }));
    const rank = (x: (typeof list)[number]) =>
      x.p.claimableKind !== "none" && !x.p.claimed
        ? 0
        : x.round &&
            (x.round.state === "open" ||
              x.round.state === "locked" ||
              x.round.state === "unsettled")
          ? 1
          : 2;
    return list
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (b.round?.endTimeSec ?? 0) - (a.round?.endTimeSec ?? 0),
      )
      .slice(0, 12);
  }, [positions, roundsByMarket]);

  const claimable = (positions ?? []).filter(
    (p) => p.claimableKind !== "none" && !p.claimed && p.claimableAmount > 0n,
  );

  return (
    <Tile
      title="Your calls"
      index={index}
      className={className}
      action={
        <button
          type="button"
          disabled={claimable.length === 0 || busy}
          onClick={() => claimAll(claimable)}
          className="rounded-full border border-border px-3 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground disabled:opacity-60 disabled:hover:bg-transparent"
        >
          Claim all{claimable.length > 1 ? ` (${claimable.length})` : ""}
        </button>
      }
    >
      {!address ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-2.5 text-[13px] text-muted-foreground">
          Connect your wallet to see your calls.
        </p>
      ) : positions === null ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-2.5 font-mono text-[12px] text-muted-foreground">
          loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-2.5 text-[13px] text-muted-foreground">
          No calls yet.{" "}
          <a
            href="#your-call"
            className="font-semibold text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Make your first call →
          </a>
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.map(({ p, round }) => {
            const d = describe(p, round);
            const live =
              !!round &&
              nowSec !== null &&
              nowSec >= round.lockTimeSec &&
              nowSec < round.endTimeSec;
            const market = MARKETS.find((m) => m.id === p.marketId);
            const side = p.up > 0n ? "UP" : "DOWN";
            const mine = p.up > 0n ? p.up : p.down;
            const s = settlements?.get(settlementKey(p.marketId, p.roundIndex));
            // what the call earned or cost, from the round's totals (the same sum as the contract's claim)
            const myTotal = round ? (side === "UP" ? round.upTotal : round.downTotal) : 0n;
            const otherTotal = round ? (side === "UP" ? round.downTotal : round.upTotal) : 0n;
            const decided = round?.state === "up" || round?.state === "down";
            const wonIt =
              decided && round?.state === (side === "UP" ? "up" : "down");
            // matched calls: a win adds the matched share of the pot, a loss costs only the matched part of the stake
            const delta = !decided ? null : settledPayout(mine, myTotal, otherTotal, wonIt) - mine;
            return (
              <li
                key={`${p.marketId}-${p.roundIndex}`}
                className="flex items-center justify-between gap-3 py-2.5 text-[13px]"
              >
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => onOpen(p.marketId, p.roundIndex)}
                    className="block w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="rounded-full px-2 py-0.5 text-[11px] font-bold"
                        style={{
                          background:
                            side === "UP"
                              ? "var(--color-up)"
                              : "var(--color-down)",
                          color: INK,
                        }}
                      >
                        {side === "UP" ? "▲ UP" : "▼ DOWN"}
                      </span>
                      <span className="font-mono tabular-nums">
                        {usdc(mine)}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      {round ? (
                        <RoundBadge
                          status={roundStatusOf(
                            round.lockTimeSec,
                            round.endTimeSec,
                            nowSec,
                            round.state === "up"
                              ? "UP"
                              : round.state === "down"
                                ? "DOWN"
                                : round.state === "refunded"
                                  ? "Refunded"
                                  : null,
                          )}
                        />
                      ) : null}
                      <span className="truncate">
                        {market?.name ?? `Market ${p.marketId}`}
                        {round
                          ? ` · ${clock(round.lockTimeSec)} to ${clock(round.endTimeSec)}`
                          : ""}{" "}
                        · {d.text}
                        {delta !== null && delta !== 0n ? (
                          <span
                            className={
                              delta > 0n
                                ? " font-semibold text-up"
                                : " font-semibold"
                            }
                          >{` · ${delta > 0n ? "won" : "lost"} ${usdc(delta < 0n ? -delta : delta)}`}</span>
                        ) : null}
                        {round?.state === "refunded"
                          ? ` · ${refundReasonText(s?.reason)}`
                          : ""}
                      </span>
                    </span>
                  </button>
                  {market &&
                  s &&
                  (s.startPrice !== null || s.endPrice !== null) ? (
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      <StartEnd
                        start={s.startPrice}
                        end={s.endPrice}
                        round={{
                          marketId: p.marketId,
                          roundIndex: p.roundIndex,
                        }}
                      />
                    </span>
                  ) : null}
                </div>
                {live ? (
                  <button
                    type="button"
                    onClick={() => onOpen(p.marketId, p.roundIndex)}
                    className="shrink-0 rounded-full border border-border px-3 py-1.5 text-[12px] font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Watch
                  </button>
                ) : null}
                {d.tone === "claim" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => claim(p)}
                    className="shrink-0 rounded-full bg-up px-3 py-1.5 text-[12px] font-bold disabled:opacity-60"
                    style={{ color: INK }}
                  >
                    {claimLabel(p.claimableKind)} {usdc(p.claimableAmount)}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {status !== "idle" ? (
        <p className="mt-3 text-[12px] text-muted-foreground" role="status">
          {status === "failed" ? errorMessage : CLAIM_STATUS_TEXT[status]}{" "}
          {txHash ? (
            <a
              href={txLink(txHash) ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              View transaction
            </a>
          ) : null}{" "}
          {status === "done" || status === "failed" ? (
            <button
              type="button"
              onClick={reset}
              className="underline underline-offset-2"
            >
              Dismiss
            </button>
          ) : null}
        </p>
      ) : rows.length > 0 ? (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Open calls first, then finished ones marked won, lost or refunded.
        </p>
      ) : null}
    </Tile>
  );
}
