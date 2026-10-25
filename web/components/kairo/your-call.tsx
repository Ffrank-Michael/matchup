"use client";

import * as React from "react";

import type { Agent } from "@/lib/agents";
import { formatCountdown, ROUND_SECONDS, type Market } from "@/lib/markets";
import { cn } from "@/lib/utils";

import { AgentAvatar } from "./agent-avatar";
import { INK, NotLive, Tile } from "./tile";

export type Side = "UP" | "DOWN";

const MIN_STAKE = 0.1;
const QUICK = ["0.25", "0.50", "1"] as const;
const URGENT_SECONDS = 60;

/** Keep digits and one dot, at most 6 decimals (USDC has 6). */
function cleanAmount(raw: string) {
  const s = raw.replace(/[^0-9.]/g, "");
  const [whole, ...rest] = s.split(".");
  if (rest.length === 0) return whole.slice(0, 7);
  return `${whole.slice(0, 7)}.${rest.join("").slice(0, 6)}`;
}

function Ring({ secondsLeft }: { secondsLeft: number | null }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  const frac = secondsLeft === null ? 1 : Math.max(0, Math.min(1, secondsLeft / ROUND_SECONDS));
  const urgent = secondsLeft !== null && secondsLeft <= URGENT_SECONDS;
  return (
    <svg width="52" height="52" viewBox="0 0 52 52" className={cn("shrink-0 -rotate-90", urgent && "animate-pulse motion-reduce:animate-none")} aria-hidden>
      <circle cx="26" cy="26" r={r} fill="none" strokeWidth="5" style={{ stroke: INK, opacity: 0.15 }} />
      <circle
        cx="26"
        cy="26"
        r={r}
        fill="none"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - frac)}
        style={{ stroke: INK, transition: "stroke-dashoffset 1s linear" }}
      />
    </svg>
  );
}

/**
 * The big lime panel: choose UP or DOWN, an amount, then confirm.
 * Nothing here talks to the contract yet, so the payout says "not live yet" and Confirm stays off.
 */
export function YourCall({
  market,
  secondsLeft,
  side,
  onSide,
  amount,
  onAmount,
  backing,
  onClearBacking,
  index,
  className,
}: {
  market: Market;
  /** Seconds until the next lock of this market; null before the clock is known */
  secondsLeft: number | null;
  side: Side | null;
  onSide: (side: Side) => void;
  amount: string;
  onAmount: (amount: string) => void;
  /** An agent the user chose to back, if any */
  backing: Agent | null;
  onClearBacking: () => void;
  index: number;
  className?: string;
}) {
  const urgent = secondsLeft !== null && secondsLeft <= URGENT_SECONDS;
  const parsed = amount === "" || amount === "." ? null : Number(amount);
  const tooSmall = parsed !== null && parsed < MIN_STAKE;
  const inputId = React.useId();

  return (
    <Tile title={`Your call · ${market.pair}`} accent index={index} className={cn("p-4 sm:p-6", className)}>
      {/* countdown */}
      <div className="flex items-center gap-3">
        <Ring secondsLeft={secondsLeft} />
        <div className="min-w-0">
          <p className="font-mono text-[34px] font-semibold leading-none tracking-[-0.04em] tabular-nums" aria-label="calling closes in">
            {secondsLeft === null ? "--:--" : formatCountdown(secondsLeft)}
          </p>
          <p className="mt-1 text-[12px] font-medium opacity-75">{urgent ? "Calling closes very soon" : "until calling closes for this round"}</p>
        </div>
      </div>

      {backing ? (
        <div className="mt-4 flex items-center gap-2.5 rounded-2xl p-2 pr-3" style={{ background: "color-mix(in oklch, black 12%, transparent)" }}>
          <AgentAvatar agent={backing} size={40} />
          <p className="min-w-0 flex-1 text-[12px] leading-snug">
            <span className="font-semibold">
              Backing Agent {backing.number} · {backing.name}
            </span>
            <span className="block opacity-70">Its call comes from the contract (not live yet), so pick a side below for now.</span>
          </p>
          <button type="button" onClick={onClearBacking} className="shrink-0 rounded-full px-2 py-1 text-[12px] font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current">
            Stop
          </button>
        </div>
      ) : null}

      {/* UP / DOWN */}
      <div role="group" aria-label="Your call" className="mt-4 grid grid-cols-2 gap-3">
        {(
          [
            ["UP", "Higher", "var(--color-up)"],
            ["DOWN", "Lower", "var(--color-down)"],
          ] as const
        ).map(([s, hint, colour]) => {
          const on = side === s;
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              onClick={() => onSide(s)}
              className="flex h-[88px] flex-col items-center justify-center gap-0.5 rounded-2xl border-2 text-[26px] font-bold tracking-[-0.02em] transition-[background-color,transform] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transition-none"
              style={
                on
                  ? { background: INK, borderColor: INK, color: colour }
                  : { background: "color-mix(in oklch, white 28%, transparent)", borderColor: "color-mix(in oklch, black 20%, transparent)", color: INK }
              }
            >
              <span aria-hidden className="text-[20px] leading-none">
                {s === "UP" ? "▲" : "▼"}
              </span>
              {s}
              <span className="text-[11px] font-medium opacity-70">{hint} than start price</span>
            </button>
          );
        })}
      </div>

      {/* amount */}
      <div className="mt-5">
        <label htmlFor={inputId} className="text-[12px] font-medium opacity-75">
          Amount (USDC)
        </label>
        <div className="mt-1 flex items-baseline gap-1 border-b-2 pb-1" style={{ borderColor: "color-mix(in oklch, black 30%, transparent)" }}>
          <span className="font-mono text-[34px] font-semibold leading-none opacity-60">$</span>
          <input
            id={inputId}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(e) => onAmount(cleanAmount(e.target.value))}
            aria-invalid={tooSmall}
            aria-describedby={`${inputId}-hint`}
            className="min-w-0 flex-1 bg-transparent font-mono text-[40px] font-semibold leading-none tracking-[-0.04em] tabular-nums outline-none placeholder:opacity-30"
          />
        </div>
        <p id={`${inputId}-hint`} className={cn("mt-1.5 text-[12px]", tooSmall ? "font-semibold" : "opacity-70")}>
          The smallest call is 0.10 USDC.
        </p>
        <div className="mt-3 flex gap-2">
          {QUICK.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onAmount(q)}
              aria-pressed={amount === q}
              className="flex-1 rounded-full border-2 py-2 font-mono text-[14px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
              style={amount === q ? { background: INK, borderColor: INK, color: "var(--color-up)" } : { borderColor: "color-mix(in oklch, black 25%, transparent)" }}
            >
              ${q}
            </button>
          ))}
        </div>
      </div>

      {/* payout */}
      <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl px-3.5 py-3 text-[13px]" style={{ background: "color-mix(in oklch, black 10%, transparent)" }}>
        <span>
          <span className="font-semibold">Estimated payout</span>
          <span className="block text-[11px] opacity-70">Changes until calling closes</span>
        </span>
        <NotLive onAccent className="text-[12px]" />
      </div>

      {/* confirm */}
      <button
        type="button"
        disabled
        className="mt-4 flex h-14 w-full items-center justify-center rounded-2xl text-[17px] font-bold disabled:cursor-not-allowed"
        style={{ background: "color-mix(in oklch, black 22%, transparent)", color: INK, opacity: 0.55 }}
      >
        Confirm call
      </button>
      <p className="mt-1.5 text-center text-[11px] opacity-70">Calls open once the contract is live.</p>

      {/* notes */}
      <ul className="mt-4 flex flex-col gap-2 text-[12px] leading-relaxed opacity-80">
        <li>
          <span className="font-semibold">Fee:</span> 2% of winnings. If you lose or get refunded, you pay no fee.
        </li>
        <li>
          <span className="font-semibold">Start price:</span> UP wins if the end price is higher than the start price. The start price is recorded about 2 minutes after calling closes, so nobody can know it in advance.
        </li>
      </ul>
    </Tile>
  );
}
