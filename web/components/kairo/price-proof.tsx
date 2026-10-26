"use client";

import { formatUsd, type MarketKey } from "@/lib/markets";
import { useTradeTime } from "@/lib/use-trade-time";
import { txLink, type PricePush } from "@/onchain";

import { useOpenRoundCard, type RoundRef } from "./round-card-context";

const clock = (unixSec: number) => new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/**
 * A price the chain recorded, with proof: the price and a small link. Given `round`, the link is "Verify" and opens our own
 * round result card; without it (inside that card) it is "View on blockchain" and goes to the transaction that recorded the
 * price. It also shows when the price landed on the chain and the time of the Bitfinex trade behind it.
 */
export function PriceProof({ coin, price, push, detail = true, round }: { coin: MarketKey; price: number | null; push: PricePush | null; detail?: boolean; round?: RoundRef }) {
  const openCard = useOpenRoundCard();
  const tradeAt = useTradeTime(coin, push ? push.price : null, push ? push.time : null);
  if (price === null) return <span className="text-muted-foreground">…</span>;
  return (
    <span className="inline-flex flex-col items-end">
      <span className="font-mono tabular-nums">
        {formatUsd(price)}
        {push ? (
          <>
            {" "}
            {round && openCard ? (
              <button type="button" onClick={() => openCard(round)} className="font-sans text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">
                Verify
              </button>
            ) : (
              <a href={txLink(push.tx) ?? undefined} target="_blank" rel="noreferrer" className="font-sans text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">
                View on blockchain
              </a>
            )}
          </>
        ) : null}
      </span>
      {detail && push ? (
        <span className="text-[11px] font-normal text-muted-foreground">
          On chain {clock(push.time)}
          {tradeAt !== null ? ` · Bitfinex trade ${clock(tradeAt)}` : ""}
        </span>
      ) : null}
    </span>
  );
}

/**
 * "Start $80,389 → End $80,400" in words (never bare numbers), with a small "Verify" that opens our round result card.
 * A price the chain has not recorded yet shows as "…".
 */
export function StartEnd({ start, end, round, className }: { start: number | null; end: number | null; round: RoundRef; className?: string }) {
  const openCard = useOpenRoundCard();
  return (
    <span className={className}>
      <span className="whitespace-nowrap">
        Start <span className="font-mono tabular-nums text-foreground">{start !== null ? formatUsd(start) : "…"}</span>
      </span>{" "}
      <span aria-hidden>→</span>{" "}
      <span className="whitespace-nowrap">
        End <span className="font-mono tabular-nums text-foreground">{end !== null ? formatUsd(end) : "…"}</span>
      </span>
      {openCard ? (
        <>
          {" "}
          <button type="button" onClick={() => openCard(round)} className="text-[11px] font-medium underline underline-offset-2 hover:text-foreground">
            Verify
          </button>
        </>
      ) : null}
    </span>
  );
}
