"use client";

import { formatUsd, type MarketKey } from "@/lib/markets";
import { useTradeTime } from "@/lib/use-trade-time";
import { txLink, type PricePush } from "@/onchain";

const clock = (unixSec: number) => new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/**
 * A price the chain recorded, with proof: the price, a small "Verify" link to the transaction that recorded it, and when the
 * Bitfinex trade behind it happened, so anyone can compare it with Bitfinex's own trade history.
 */
export function PriceProof({ coin, price, push, detail = true }: { coin: MarketKey; price: number | null; push: PricePush | null; detail?: boolean }) {
  const tradeAt = useTradeTime(coin, push ? push.price : null, push ? push.time : null);
  if (price === null) return <span className="text-muted-foreground">…</span>;
  return (
    <span className="inline-flex flex-col items-end">
      <span className="font-mono tabular-nums">
        {formatUsd(price)}
        {push ? (
          <>
            {" "}
            <a href={txLink(push.tx) ?? undefined} target="_blank" rel="noreferrer" className="font-sans text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">
              Verify
            </a>
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
