"use client";

import * as React from "react";
import { useConnection } from "wagmi";

import { MARKETS } from "@/lib/markets";
import { claimLabel, CLAIM_STATUS_TEXT, txLink, usdc, useClaim, type MyPosition, type Round } from "@/onchain";

import { NotLive, Tile } from "./tile";

const clock = (unixSec: number) => new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const INK = "oklch(0.24 0.06 135)";

/** How a position stands, in words, from the round's real state. */
function describe(p: MyPosition, round: Round | undefined): { text: string; tone: "open" | "claim" | "done" | "lost" } {
  if (!round) return { text: "…", tone: "open" };
  if (p.claimed) return { text: round.state === "refunded" ? "Refunded" : "Paid out", tone: "done" };
  if (p.claimableKind === "win") return { text: "Won", tone: "claim" };
  if (p.claimableKind === "refund") return { text: "Refunded", tone: "claim" };
  if (round.state === "up" || round.state === "down") return { text: "Lost", tone: "lost" };
  return { text: round.state === "open" ? "Open" : round.state === "locked" ? "Running" : "Waiting for the result", tone: "open" };
}

/**
 * The connected wallet's calls, read from the contract: open ones first, then finished ones marked won, lost or
 * refunded, with a button for money that is waiting, and Claim all.
 */
export function YourCalls({
  positions,
  roundsByMarket,
  onOpen,
  index,
  className,
}: {
  positions: MyPosition[] | null;
  roundsByMarket: Record<number, Round[]> | null;
  onOpen: (marketId: number, roundIndex: number) => void;
  index: number;
  className?: string;
}) {
  const { address } = useConnection();
  const { claim, claimAll, status, txHash, errorMessage, reset } = useClaim();
  const busy = status === "claim-wallet" || status === "claim-confirming";

  const rows = React.useMemo(() => {
    const list = (positions ?? []).map((p) => ({ p, round: roundsByMarket?.[p.marketId]?.find((r) => r.roundIndex === p.roundIndex) }));
    const rank = (x: (typeof list)[number]) =>
      x.p.claimableKind !== "none" && !x.p.claimed ? 0 : x.round && (x.round.state === "open" || x.round.state === "locked" || x.round.state === "unsettled") ? 1 : 2;
    return list.sort((a, b) => rank(a) - rank(b) || (b.round?.endTimeSec ?? 0) - (a.round?.endTimeSec ?? 0)).slice(0, 12);
  }, [positions, roundsByMarket]);

  const claimable = (positions ?? []).filter((p) => p.claimableKind !== "none" && !p.claimed && p.claimableAmount > 0n);

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
        <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border p-6 text-center">
          <p className="text-[13px] text-muted-foreground">Connect your wallet to see your calls.</p>
        </div>
      ) : positions === null ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border p-6">
          <NotLive />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
          You have no calls in the last hour.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.map(({ p, round }) => {
            const d = describe(p, round);
            const market = MARKETS.find((m) => m.id === p.marketId);
            const side = p.up > 0n ? "UP" : "DOWN";
            const mine = p.up > 0n ? p.up : p.down;
            return (
              <li key={`${p.marketId}-${p.roundIndex}`} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                <button type="button" onClick={() => onOpen(p.marketId, p.roundIndex)} className="min-w-0 flex-1 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="flex items-center gap-2">
                    <span className="rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: side === "UP" ? "var(--color-up)" : "var(--color-down)", color: INK }}>
                      {side === "UP" ? "▲ UP" : "▼ DOWN"}
                    </span>
                    <span className="font-mono tabular-nums">{usdc(mine)}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {market?.name ?? `Market ${p.marketId}`}
                    {round ? ` · ${clock(round.lockTimeSec)} to ${clock(round.endTimeSec)}` : ""} · {d.text}
                  </span>
                </button>
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
            <a href={txLink(txHash) ?? undefined} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              View transaction
            </a>
          ) : null}{" "}
          {status === "done" || status === "failed" ? (
            <button type="button" onClick={reset} className="underline underline-offset-2">
              Dismiss
            </button>
          ) : null}
        </p>
      ) : (
        <p className="mt-3 text-[11px] text-muted-foreground">Open calls first, then finished ones marked won, lost or refunded.</p>
      )}
    </Tile>
  );
}
