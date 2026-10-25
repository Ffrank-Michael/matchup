"use client";

import * as React from "react";

import { MARKETS, type MarketKey } from "@/lib/markets";

// The ONE source of prices on the site: Bitfinex's free public websocket (no key).
//   wss://api-pub.bitfinex.com/ws/2   channel "candles", key "trade:1m:tBTCUSD" (and ETH, SOL)
// It first sends the last 240 one-minute candles (4 hours), then a message on every trade.
// The price is the price of the last trade (the close of the newest candle). The runner that
// records the round's start and end prices reads the last trade from the same Bitfinex market
// (runner/exchangePrices.mjs), so every price on the page is the number that decides a round.
//
// Every place on the page takes its price from here, so two places can never disagree.
// Limits (Bitfinex docs): 20 new connections per minute per IP and 25 channels per connection.
// We open ONE connection with 3 channels and share it between all components.
// A quiet market only updates when somebody trades; nothing is invented in between.

export type Candle = {
  /** Start of the minute (ms since 1970) */
  t: number;
  open: number;
  close: number;
  high: number;
  low: number;
};

export type FeedStatus = "connecting" | "live" | "reconnecting";

export type FeedState = {
  status: FeedStatus;
  /** 1-minute candles per market, oldest first. null until Bitfinex has sent them. */
  candles: Record<MarketKey, Candle[] | null>;
};

const URL = "wss://api-pub.bitfinex.com/ws/2";
const SYMBOL: Record<MarketKey, string> = { BTC: "tBTCUSD", ETH: "tETHUSD", SOL: "tSOLUSD" };
const KEEP = 240;
const SILENT_MS = 25_000; // Bitfinex sends a heartbeat every ~15 s; longer silence means a dead connection
const STOP_DELAY_MS = 3_000; // keep the connection a moment after the last listener leaves (page changes, StrictMode)

const EMPTY: FeedState = { status: "connecting", candles: { BTC: null, ETH: null, SOL: null } };

let state: FeedState = EMPTY;
const listeners = new Set<() => void>();
let ws: WebSocket | null = null;
let running = false;
let attempt = 0;
let lastMessageAt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let watchdog: ReturnType<typeof setInterval> | undefined;
let stopTimer: ReturnType<typeof setTimeout> | undefined;

function set(next: FeedState) {
  state = next;
  listeners.forEach((l) => l());
}

function parseCandle(c: unknown): Candle | null {
  if (!Array.isArray(c) || c.length < 6) return null;
  const [t, open, close, high, low] = c;
  const nums = [t, open, close, high, low];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n)) || close <= 0) return null;
  return { t, open, close, high, low };
}

function connect() {
  if (!running) return;
  const socket = new WebSocket(URL);
  ws = socket;
  const channels = new Map<number, MarketKey>();

  socket.onopen = () => {
    lastMessageAt = Date.now();
    for (const m of MARKETS) {
      socket.send(JSON.stringify({ event: "subscribe", channel: "candles", key: `trade:1m:${SYMBOL[m.key]}` }));
    }
  };

  socket.onmessage = (ev) => {
    lastMessageAt = Date.now();
    let d: unknown;
    try {
      d = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    if (!Array.isArray(d)) {
      const e = d as { event?: string; key?: string; chanId?: number; code?: number };
      if (e.event === "subscribed" && typeof e.chanId === "number" && typeof e.key === "string") {
        const m = MARKETS.find((x) => e.key === `trade:1m:${SYMBOL[x.key]}`);
        if (m) channels.set(e.chanId, m.key);
      } else if (e.event === "info" && e.code === 20051) {
        socket.close(); // Bitfinex asks clients to reconnect
      }
      return;
    }
    const key = channels.get(d[0]);
    const payload = d[1];
    if (!key || payload === "hb" || !Array.isArray(payload)) return;

    if (Array.isArray(payload[0])) {
      // first message: a snapshot of recent candles, newest first
      const candles = payload.map(parseCandle).filter((c): c is Candle => c !== null).reverse().slice(-KEEP);
      if (candles.length === 0) return;
      attempt = 0;
      set({ status: "live", candles: { ...state.candles, [key]: candles } });
      return;
    }

    const c = parseCandle(payload);
    const have = state.candles[key];
    if (!c || !have) return;
    const next = have.slice();
    const last = next[next.length - 1];
    if (c.t === last.t) next[next.length - 1] = c;
    else if (c.t > last.t) next.push(c);
    else return;
    set({ status: "live", candles: { ...state.candles, [key]: next.slice(-KEEP) } });
  };

  const lost = () => {
    if (ws !== socket) return;
    ws = null;
    if (!running) return;
    set({ ...state, status: "reconnecting" });
    // wait 3 s, 6 s, 12 s ... up to 30 s (stays well under 20 new connections a minute)
    const wait = Math.min(30_000, 3_000 * 2 ** attempt) + Math.random() * 500;
    attempt += 1;
    retryTimer = setTimeout(connect, wait);
  };
  socket.onclose = lost;
  socket.onerror = () => socket.close();
}

function start() {
  if (running) return;
  running = true;
  attempt = 0;
  connect();
  watchdog = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > SILENT_MS) ws.close();
  }, 5_000);
}

function stop() {
  running = false;
  clearTimeout(retryTimer);
  clearInterval(watchdog);
  const w = ws;
  ws = null;
  w?.close();
  state = { ...state, status: "connecting" };
}

function subscribe(listener: () => void) {
  clearTimeout(stopTimer);
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopTimer = setTimeout(stop, STOP_DELAY_MS);
  };
}

/** Live Bitfinex data for all three markets (one shared connection). */
export function usePriceFeed(): FeedState {
  return React.useSyncExternalStore(subscribe, () => state, () => EMPTY);
}

/** The price shown for a market everywhere on the page: the last trade. */
export function lastPrice(candles: Candle[] | null): number | null {
  return candles && candles.length ? candles[candles.length - 1].close : null;
}

export type Point = readonly [timeMs: number, price: number];
const HOUR_MS = 3_600_000;

/**
 * The last hour of a market as (time, price) points, oldest first. Each finished minute counts at its
 * last trade; the newest point is "now" at the live price, so the line ends exactly on the number shown.
 * Minutes with no trade have no candle and are simply not drawn.
 */
export function hourPoints(candles: Candle[] | null, nowMs: number): Point[] | null {
  if (!candles || candles.length === 0) return null;
  const from = nowMs - HOUR_MS;
  const pts: Point[] = [];
  for (const c of candles) {
    const at = Math.min(c.t + 59_999, nowMs);
    if (at >= from && at < nowMs) pts.push([at, c.close]);
  }
  pts.push([nowMs, candles[candles.length - 1].close]);
  return pts.length >= 2 ? pts : null;
}

export const HOUR = HOUR_MS;
