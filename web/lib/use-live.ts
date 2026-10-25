"use client";

import * as React from "react";

// Live data for the page. Prices come straight from CoinGecko's free API (no key), asked once a
// minute from the visitor's own browser, so visitors do not share one rate limit.
// If CoinGecko cannot be reached we keep the last real prices and say so. We never invent a price.

const URL =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&sparkline=true";
const REFRESH_MS = 60_000;

export type Coin = {
  /** US dollars, as reported by CoinGecko */
  price: number;
  /** About 7 days of hourly prices, oldest first, ending at CoinGecko's last update */
  series: number[];
  /** When CoinGecko last updated this coin (ms since 1970) */
  updatedMs: number;
};

export type Prices = {
  coins: Record<string, Coin> | null;
  /** When we last got a good answer (ms since 1970) */
  okAt: number | null;
  /** True when the latest attempt failed */
  failing: boolean;
};

function parse(json: unknown): Record<string, Coin> {
  if (!Array.isArray(json)) throw new Error("unexpected answer");
  const coins: Record<string, Coin> = {};
  for (const c of json) {
    const price = c?.current_price;
    const series = c?.sparkline_in_7d?.price;
    const updatedMs = Date.parse(c?.last_updated);
    const good = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0;
    if (typeof c?.id !== "string" || !good(price) || !Array.isArray(series) || series.length < 2 || !series.every(good) || !Number.isFinite(updatedMs)) {
      throw new Error("unexpected answer");
    }
    coins[c.id] = { price, series, updatedMs };
  }
  return coins;
}

export function usePrices(): Prices {
  const [state, setState] = React.useState<Prices>({ coins: null, okAt: null, failing: false });

  React.useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    let loaded = false;

    const load = async () => {
      if (loaded && document.hidden) return; // nobody is looking, save the API calls
      try {
        const res = await fetch(URL, { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const coins = parse(await res.json());
        loaded = true;
        if (alive) setState({ coins, okAt: Date.now(), failing: false });
      } catch {
        if (alive) setState((s) => ({ ...s, failing: true }));
      }
    };

    load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      ctrl.abort();
      window.clearInterval(id);
    };
  }, []);

  return state;
}

function subscribe(onChange: () => void) {
  const id = window.setInterval(onChange, 1000);
  return () => window.clearInterval(id);
}
const getNow = () => Math.floor(Date.now() / 1000);

/** Current time in whole seconds, ticking every second. null on the server (so pages never freeze a time). */
export function useNowSeconds(): number | null {
  return React.useSyncExternalStore(subscribe, getNow, () => null);
}
