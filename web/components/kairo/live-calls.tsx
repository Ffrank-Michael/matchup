"use client";

import * as React from "react";
import { useConnection } from "wagmi";

import { AGENTS } from "@/lib/agents";
import { useBackedAgents } from "@/lib/backed";
import type { Market } from "@/lib/markets";
import { whoIs, whoName } from "@/lib/players";
import { noteOf, useAgentNotes } from "@/lib/use-agent-notes";
import { refundReasonText } from "@/lib/refund-reason";
import { usdc, useLiveCalls, useSettlements, settlementKey } from "@/onchain";

import { AgentAvatar } from "./agent-avatar";
import { AiNoteFootnote, CallNote, SkippedNotes } from "./agent-reason";
import { StartEnd } from "./price-proof";
import { RoundBadge, roundStatusOf } from "./round-badge";
import { RoundHistory } from "./round-history";
import { Tile } from "./tile";

const hm = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const INK = "oklch(0.24 0.06 135)";

/**
 * The calls of three rounds of the selected market, read from the contract's events, newest round first: NEXT (taking calls),
 * LIVE (running) and the last one that ENDED. Older rounds are in the "Round history" sheet. Each round
 * has a plain header: its time, how it is going or how it ended, and its start and end price with a "Verify" link to the
 * transaction that recorded each. A call shows who made it (an agent by name, "You", or "Player 0x37…C4"), the side, the
 * amount, and once the round is over ✓ Won, ✗ Lost or Refunded. Tapping a call opens that round in the watch sheet.
 */
export function LiveCalls({
  market,
  nextRound,
  nowSec,
  onOpen,
  index,
  className,
}: {
  market: Market;
  /** The round that takes calls now (the contract's next round) */
  nextRound: number | null;
  nowSec: number | null;
  onOpen: (marketId: number, roundIndex: number) => void;
  index: number;
  className?: string;
}) {
  const { calls, isLoading } = useLiveCalls(market.id);
  const { address } = useConnection();
  const settlements = useSettlements();
  const backedOf = useBackedAgents(address);
  // the AI agents' one-sentence reasons for the rounds shown here
  const notes = useAgentNotes(market.id, nextRound === null ? [] : [nextRound, nextRound - 1, nextRound - 2]);

  const [historyOpen, setHistoryOpen] = React.useState(false);
  // fixed when the sheet opens: the round just older than the three shown here
  const [historyFrom, setHistoryFrom] = React.useState<number | null>(null);
  const groups = React.useMemo(() => {
    if (nextRound === null) return [];
    return [nextRound, nextRound - 1, nextRound - 2]
      .filter((k) => k >= 0)
      .map((k): [number, NonNullable<typeof calls>] => [k, (calls ?? []).filter((c) => c.roundIndex === k)]);
  }, [calls, nextRound]);

  return (
    <Tile
      title={`Live calls · ${market.name}`}
      index={index}
      className={className}
    >
      {calls === null ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border p-6">
          <span className="font-mono text-[12px] text-muted-foreground">
            {isLoading ? "loading…" : "Could not load calls. Trying again."}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(([roundIndex, list]) => {
            const lock = roundIndex * market.roundSeconds + market.lockOffset;
            const end = lock + market.roundSeconds;
            const s = settlements?.get(settlementKey(market.id, roundIndex));
            const winner =
              s?.state === 1 ? "UP" : s?.state === 2 ? "DOWN" : null;
            const refunded = s?.state === 3;
            const status = roundStatusOf(
              lock,
              end,
              nowSec,
              winner ?? (refunded ? "Refunded" : null),
            );
            const isLive = status.kind === "live";
            return (
              <section
                key={roundIndex}
                aria-label={`Round ${hm(lock)} to ${hm(end)}`}
              >
                <header className="rounded-xl bg-muted/40 px-3 py-2 text-[12px]">
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex min-w-0 items-center gap-2 font-semibold">
                      <RoundBadge status={status} />
                      <span className="truncate">
                        {hm(lock)}–{hm(end)}
                      </span>
                    </p>
                    {isLive ? (
                      <button
                        type="button"
                        onClick={() => onOpen(market.id, roundIndex)}
                        className="shrink-0 rounded-full border border-border px-3 py-1 text-[12px] font-semibold text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Watch
                      </button>
                    ) : null}
                  </div>
                  {refunded ? (
                    <p className="mt-1 text-muted-foreground">
                      {refundReasonText(s?.reason)}
                    </p>
                  ) : null}
                  {s && (s.startPrice !== null || s.endPrice !== null) ? (
                    <p className="mt-1 text-muted-foreground">
                      <StartEnd
                        start={s.startPrice}
                        end={s.endPrice}
                        round={{ marketId: market.id, roundIndex }}
                      />
                    </p>
                  ) : null}
                </header>
                {list.length === 0 ? (
                  <p className="px-3 py-2 text-[12px] text-muted-foreground">No calls in this round.</p>
                ) : null}
                <SkippedNotes
                  className="px-3 py-1.5"
                  agents={AGENTS.filter((a) => a.ai && noteOf(notes, roundIndex, a.key)?.s === "skipped")}
                />
                <ul className="flex flex-col divide-y divide-border">
                  {list.map((c) => {
                    const who = whoIs(c.player, address);
                    const backed = who.kind === "you" ? backedOf(market.id, c.roundIndex) : null;
                    const result = winner
                      ? c.side === winner
                        ? "won"
                        : "lost"
                      : refunded
                        ? "refunded"
                        : null;
                    const note = who.kind === "agent" ? noteOf(notes, c.roundIndex, who.agent.key) : undefined;
                    return (
                      <li key={`${c.txHash}-${c.logIndex}`}>
                        <button
                          type="button"
                          onClick={() => onOpen(market.id, c.roundIndex)}
                          className="flex w-full items-center justify-between gap-3 rounded-lg py-2 text-left text-[13px] transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            {who.kind === "agent" ? (
                              <AgentAvatar agent={who.agent} size={26} />
                            ) : backed ? (
                              <span title={`Backing ${backed.name}`}>
                                <AgentAvatar agent={backed} size={26} />
                              </span>
                            ) : null}
                            <span
                              className={
                                who.kind === "player"
                                  ? "truncate text-muted-foreground"
                                  : "truncate font-medium"
                              }
                              style={
                                who.kind === "agent"
                                  ? { color: who.agent.colour }
                                  : undefined
                              }
                            >
                              {whoName(c.player, address)}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span
                              className="rounded-full px-2.5 py-0.5 text-[12px] font-bold"
                              style={{
                                background:
                                  c.side === "UP"
                                    ? "var(--color-up)"
                                    : "var(--color-down)",
                                color: INK,
                              }}
                            >
                              {c.side === "UP" ? "▲ UP" : "▼ DOWN"}
                            </span>
                            <span className="font-mono tabular-nums">
                              {usdc(c.amount)}
                            </span>
                            {result ? (
                              <span
                                className={
                                  result === "won"
                                    ? "w-16 text-right text-[12px] font-semibold text-up"
                                    : "w-16 text-right text-[12px] font-semibold text-muted-foreground"
                                }
                              >
                                {result === "won"
                                  ? "✓ Won"
                                  : result === "lost"
                                    ? "✗ Lost"
                                    : "Refunded"}
                              </span>
                            ) : null}
                          </span>
                        </button>
                        {note?.s === "called" ? <CallNote text={note.t} className="mb-2 pl-9 pr-1" /> : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          {[...notes.values()].some((n) => n.s === "called") ? <AiNoteFootnote className="px-1" /> : null}
          <button
            type="button"
            onClick={() => {
              setHistoryFrom(nextRound === null ? null : nextRound - 3);
              setHistoryOpen(true);
            }}
            disabled={nextRound === null}
            className="rounded-full border border-border px-4 py-2 text-[13px] font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Round history
          </button>
        </div>
      )}
      <RoundHistory
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        market={market}
        newest={historyFrom}
        nowSec={nowSec}
      />
    </Tile>
  );
}
