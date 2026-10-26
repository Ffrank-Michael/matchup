"use client";

import * as React from "react";

import type { MarketKey } from "@/lib/markets";

// The time of the Bitfinex trade behind a price that is on the chain (see app/api/trade-time/route.ts). Asked once per price.

const found = new Map<string, number | null>();

export function useTradeTime(coin: MarketKey | null, price: number | null, pushedAt: number | null): number | null {
  const key = coin && price !== null && pushedAt !== null ? `${coin}:${price}:${pushedAt}` : null;
  const [, bump] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => {
    if (key === null || found.has(key)) return;
    found.set(key, null);
    void fetch(`/api/trade-time?coin=${coin}&price=${price}&at=${pushedAt}`)
      .then((r) => r.json())
      .then((b: { tradeAt: number | null }) => {
        if (typeof b.tradeAt === "number") found.set(key, b.tradeAt);
        else found.delete(key); // try again next time it is shown
        bump();
      })
      .catch(() => found.delete(key));
  }, [key, coin, price, pushedAt]);

  return key !== null ? (found.get(key) ?? null) : null;
}
