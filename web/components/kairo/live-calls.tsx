"use client";

import * as React from "react";
import { useConnection } from "wagmi";

import type { Market } from "@/lib/markets";
import { whoIs, whoName } from "@/lib/players";
import { refundReasonText } from "@/lib/refund-reason";
import { pushKey, usdc, usePricePushes, useLiveCalls, useSettlements, settlementKey, type PricePush } from "@/onchain";

import { AgentAvatar } from "./agent-avatar";
import { PriceProof } from "./price-proof";
import { Tile } from "./tile";

const hm = (unixSec: number) => new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const INK = "oklch(0.24 0.06 135)";

/**
 * Every call as it comes in, read from the contract's events, grouped by the round it is for (newest round first). Each round
 * has a plain header: its time, how it is going or how it ended, and its start and end price with a "Verify" link to the
 * transaction that recorded each. A call shows who made it (an agent by name, "You", or "Player 0x37…C4"), the side, the
 * amount, and once the round is over ✓ Won, ✗ Lost or Refunded. Tapping a call opens that round in the watch sheet.
 */
export function LiveCalls({ market, nowSec, onOpen, index, className }: { market: Market; nowSec: number | null; onOpen: (marketId: number, roundIndex: number) => void; index: number; className?: string }) {
  const { calls, isLoading } = useLiveCalls(market.id);
  const { address } = useConnection();
  const settlements = useSettlements();
  const pushes = usePricePushes([market.feed]);

  const groups = React.useMemo(() => {
    const by = new Map<number, NonNullable<typeof calls>>();
    for (const c of calls ?? []) by.set(c.roundIndex, [...(by.get(c.roundIndex) ?? []), c]);
    return [...by.entries()].sort((a, b) => b[0] - a[0]);
  }, [calls]);

  const pushFor = (roundId: bigint | undefined): PricePush | null => (roundId && roundId > 0n ? (pushes?.get(pushKey(market.feed, roundId)) ?? null) : null);

  return (
    <Tile title={`Live calls · ${market.name}`} index={index} className={className}>
      {calls === null ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border p-6">
          <span className="font-mono text-[12px] text-muted-foreground">{isLoading ? "loading…" : "Could not load calls. Trying again."}</span>
        </div>
      ) : calls.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">No calls on this market yet.</div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(([roundIndex, list]) => {
            const lock = roundIndex * market.roundSeconds + market.lockOffset;
            const end = lock + market.roundSeconds;
            const s = settlements?.get(settlementKey(market.id, roundIndex));
            const winner = s?.state === 1 ? "UP" : s?.state === 2 ? "DOWN" : null;
            const refunded = s?.state === 3;
            const status =
              nowSec !== null && nowSec < lock
                ? "Starts " + hm(lock)
                : nowSec !== null && nowSec < end
                  ? `In progress, ends at ${hm(end)}`
                  : winner
                    ? `Ended ${winner}`
                    : refunded
                      ? `Refunded · ${refundReasonText(s?.reason)}`
                      : "Ended, waiting for the result";
            return (
              <section key={roundIndex} aria-label={`Round ${hm(lock)} to ${hm(end)}`}>
                <header className="rounded-xl bg-muted/40 px-3 py-2 text-[12px]">
                  <p className="font-semibold">
                    {hm(lock)}–{hm(end)} · {status}
                  </p>
                  {s && (s.startPrice !== null || s.endPrice !== null) ? (
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-muted-foreground">
                      <PriceProof coin={market.key} price={s.startPrice} push={pushFor(s.startRoundId)} detail={false} />
                      <span aria-hidden>→</span>
                      <PriceProof coin={market.key} price={s.endPrice} push={pushFor(s.endRoundId)} detail={false} />
                    </p>
                  ) : null}
                </header>
                <ul className="flex flex-col divide-y divide-border">
                  {list.map((c) => {
                    const who = whoIs(c.player, address);
                    const result = winner ? (c.side === winner ? "won" : "lost") : refunded ? "refunded" : null;
                    return (
                      <li key={`${c.txHash}-${c.logIndex}`}>
                        <button
                          type="button"
                          onClick={() => onOpen(market.id, c.roundIndex)}
                          className="flex w-full items-center justify-between gap-3 rounded-lg py-2 text-left text-[13px] transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            {who.kind === "agent" ? <AgentAvatar agent={who.agent} size={26} /> : null}
                            <span className={who.kind === "player" ? "truncate text-muted-foreground" : "truncate font-medium"} style={who.kind === "agent" ? { color: who.agent.colour } : undefined}>
                              {whoName(c.player, address)}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="rounded-full px-2.5 py-0.5 text-[12px] font-bold" style={{ background: c.side === "UP" ? "var(--color-up)" : "var(--color-down)", color: INK }}>
                              {c.side === "UP" ? "▲ UP" : "▼ DOWN"}
                            </span>
                            <span className="font-mono tabular-nums">{usdc(c.amount)}</span>
                            {result ? (
                              <span className={result === "won" ? "w-16 text-right text-[12px] font-semibold text-up" : "w-16 text-right text-[12px] font-semibold text-muted-foreground"}>
                                {result === "won" ? "✓ Won" : result === "lost" ? "✗ Lost" : "Refunded"}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </Tile>
  );
}

