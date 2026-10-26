"use client";

import * as React from "react";

import { AGENTS, type Agent, type AgentKey } from "./agents";

/**
 * Which agent a call backed, per wallet, market and round. The chain only knows the call, not who it copied, so the browser
 * remembers it (a per-visitor convenience: it lives in this browser only and the site works without it).
 */
const STORAGE_KEY = "kairo.backed.v1";
const EVENT = "kairo-backed";

type Store = Record<string, AgentKey>;
const keyOf = (address: string, marketId: number, roundIndex: number) => `${address.toLowerCase()}:${marketId}:${roundIndex}`;

function readRaw(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function parse(raw: string): Store {
  try {
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as Store) : {};
  } catch {
    return {};
  }
}

/** Remember that this wallet's call on this round backed `agent`. */
export function rememberBacked(address: string, marketId: number, roundIndex: number, agent: AgentKey) {
  try {
    const store = parse(readRaw());
    store[keyOf(address, marketId, roundIndex)] = agent;
    // keep it small: the newest 200 entries
    const entries = Object.entries(store).slice(-200);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // no storage (private window, blocked): the call still went through, only the little avatar is missing
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** A lookup: the agent this wallet backed on a round, or null. */
export function useBackedAgents(address: string | undefined): (marketId: number, roundIndex: number) => Agent | null {
  const raw = React.useSyncExternalStore(subscribe, readRaw, () => "");
  return React.useMemo(() => {
    const store = parse(raw);
    return (marketId, roundIndex) => {
      if (!address) return null;
      const k = store[keyOf(address, marketId, roundIndex)];
      return AGENTS.find((a) => a.key === k) ?? null;
    };
  }, [raw, address]);
}
