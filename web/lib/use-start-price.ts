"use client";

import * as React from "react";

import type { MarketKey } from "@/lib/markets";

// The start price of a round that has begun, for the dashed line on the charts. Once the contract has recorded it (it does that
// when the round is settled) that number wins; until then the site asks /api/start-price, which finds the same trade the price
// runner uses. Asked again every few seconds until it is found. null when it is not known yet (or the round has not started).

const found = new Map<string, number>();

export function useStartPrice(coin: MarketKey | null, lockSec: number | null, nowSec: number | null, onChain: number | null): number | null {
  const key = coin !== null && lockSec !== null ? `${coin}:${lockSec}` : null;
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  const started = key !== null && nowSec !== null && lockSec !== null && nowSec >= lockSec + 2;
  const need = started && onChain === null && !found.has(key);

  React.useEffect(() => {
    if (!need || key === null) return;
    let stop = false;
    const ask = async () => {
      try {
        const res = await fetch(`/api/start-price?coin=${coin}&lock=${lockSec}`);
        const body: { price: number | null } = await res.json();
        if (!stop && typeof body.price === "number") {
          found.set(key, body.price);
          bump();
          return true;
        }
      } catch {
        // try again below
      }
      return false;
    };
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (!(await ask()) && !stop) timer = setTimeout(loop, 4000);
    };
    void loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [need, key, coin, lockSec]);

  if (onChain !== null) return onChain;
  return key !== null && started ? (found.get(key) ?? null) : null;
}
