"use client";

import Link from "next/link";
import * as React from "react";
import { useConnection } from "wagmi";

import type { Agent } from "@/lib/agents";
import { formatCountdown, frameWords, type Market } from "@/lib/markets";
import { cn } from "@/lib/utils";
import { APPROVAL_NOTICE, BETA_LIMIT_USDC, DEFAULT_APPROVAL_USDC, estimatePayout, STATUS_TEXT, txLink, useMakeCall, usdc, useUsdc, useWalletStatus } from "@/onchain";

import { AgentAvatar } from "./agent-avatar";
import { INK, Tile } from "./tile";

export type Side = "UP" | "DOWN";

const MAX_STAKE = BETA_LIMIT_USDC; // beta limit: 10 USDC per wallet in each round, enforced on the site (the contract itself only has the 0.10 minimum)
const QUICK = ["1", "5", "10"] as const;
const URGENT_SECONDS = 60;

/** Keep digits and one dot, at most 6 decimals (USDC has 6). */
function cleanAmount(raw: string) {
  const s = raw.replace(/[^0-9.]/g, "");
  const [whole, ...rest] = s.split(".");
  if (rest.length === 0) return whole.slice(0, 7);
  return `${whole.slice(0, 7)}.${rest.join("").slice(0, 6)}`;
}

/** 1 -> "$1", 0.5 -> "$0.50" */
const dollars = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

function Ring({ secondsLeft, roundSeconds }: { secondsLeft: number | null; roundSeconds: number }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  const frac = secondsLeft === null ? 1 : Math.max(0, Math.min(1, secondsLeft / roundSeconds));
  const urgent = secondsLeft !== null && secondsLeft <= URGENT_SECONDS;
  return (
    <svg width="52" height="52" viewBox="0 0 52 52" className={cn("shrink-0 -rotate-90", urgent && "animate-pulse motion-reduce:animate-none")} aria-hidden>
      <circle cx="26" cy="26" r={r} fill="none" strokeWidth="5" style={{ stroke: INK, opacity: 0.15 }} />
      <circle cx="26" cy="26" r={r} fill="none" strokeWidth="5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} style={{ stroke: INK, transition: "stroke-dashoffset 1s linear" }} />
    </svg>
  );
}

/**
 * The big lime panel: choose a time frame, UP or DOWN and an amount, then confirm. The market (BTC, ETH, SOL) is chosen by the
 * cards at the top, not here. Everything about the round comes from the contract.
 */
export function YourCall({
  frames,
  frame,
  onFrame,
  market,
  secondsLeft,
  side,
  onSide,
  amount,
  onAmount,
  backing,
  onClearBacking,
  chain,
  onCalled,
  index,
  className,
}: {
  /** The time frames that exist (round lengths in seconds) */
  frames: number[];
  frame: number;
  onFrame: (roundSeconds: number) => void;
  /** The market that the selected card + time frame make */
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
  /** The market as the contract has it right now (the round to call, the smallest call, the money on that round); null until read */
  chain: { nextRound: number; minStake: bigint; paused: boolean; upTotal: bigint; downTotal: bigint } | null;
  /** Called once when a call has gone through: which market and round it was for */
  onCalled: (marketId: number, roundIndex: number) => void;
  index: number;
  className?: string;
}) {
  const parsed = amount === "" || amount === "." ? null : Number(amount);
  const minStake = chain ? Number(chain.minStake) / 1e6 : 0.1; // the market's own minimum, read from the contract
  const tooSmall = parsed !== null && parsed < minStake;
  const tooBig = parsed !== null && parsed > MAX_STAKE;
  const inputId = React.useId();
  const { address } = useConnection();
  const connected = !!address;
  const { isWrongNetwork: wrongNetwork } = useWalletStatus();
  const call = useMakeCall();
  const wallet = useUsdc();
  const [permission, setPermission] = React.useState(String(DEFAULT_APPROVAL_USDC));

  // the round the last call was for: when it goes through, the watch sheet opens on it
  const [sent, setSent] = React.useState<{ marketId: number; roundIndex: number } | null>(null);
  const status = call.status;
  React.useEffect(() => {
    if (status === "done" && sent) onCalled(sent.marketId, sent.roundIndex);
  }, [status, sent, onCalled]);
  const busy = ["checking", "approve-wallet", "approve-confirming", "call-wallet", "call-confirming"].includes(call.status);
  const amountRaw = parsed !== null && !tooSmall && !tooBig && Number.isFinite(parsed) ? BigInt(Math.round(parsed * 1_000_000)) : null;
  const needsPermission = connected && amountRaw !== null && wallet.allowanceRaw !== null && wallet.allowanceRaw < amountRaw;
  const canConfirm = connected && !wrongNetwork && !busy && !!chain && !chain.paused && !!side && amountRaw !== null && amountRaw >= chain.minStake;
  const estimate = chain && side && amountRaw !== null ? estimatePayout(side, amountRaw, chain.upTotal, chain.downTotal) : null;
  const confirmLabel = !chain
    ? "Loading…"
    : chain.paused
      ? "This market is paused"
      : !side
        ? "Pick UP or DOWN"
        : amountRaw === null || parsed === null
          ? "Enter an amount"
          : !connected
            ? "Connect your wallet to call"
            : wrongNetwork
              ? "Switch network in your wallet"
              : `Call ${side} on ${market.key} · ${frameWords(market.roundSeconds)} · ${dollars(parsed)}`;

  return (
    <Tile
      id="your-call"
      title={`Your call · ${market.pair}`}
      accent
      action={
        <span className="rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider" style={{ borderColor: "color-mix(in oklch, black 35%, transparent)" }}>
          Beta
        </span>
      }
      index={index}
      className={cn("p-4 sm:p-6", className)}
    >
      {/* countdown: the call is always for the NEXT round */}
      <div className="flex items-center gap-3">
        <Ring secondsLeft={secondsLeft} roundSeconds={market.roundSeconds} />
        <div className="min-w-0">
          <p className="font-mono text-[34px] font-semibold leading-none tracking-[-0.04em] tabular-nums" aria-label="next round starts in">
            {secondsLeft === null ? "--:--" : formatCountdown(secondsLeft)}
          </p>
          <p className="mt-1 text-[12px] font-medium opacity-75">Calling for the next round closes in</p>
        </div>
      </div>

      {backing ? (
        <div className="mt-4 flex items-center gap-2.5 rounded-2xl p-2 pr-3" style={{ background: "color-mix(in oklch, black 12%, transparent)" }}>
          <AgentAvatar agent={backing} size={40} />
          <p className="min-w-0 flex-1 text-[12px] font-semibold leading-snug">
            Backing Agent {backing.number} · {backing.name}
          </p>
          <button type="button" onClick={onClearBacking} className="shrink-0 rounded-full px-2 py-1 text-[12px] font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current">
            Stop
          </button>
        </div>
      ) : null}

      {/* time frame: one row */}
      <div role="group" aria-label="Time frame" className="mt-4">
        <p className="mb-1.5 text-[12px] font-semibold opacity-75">Time frame</p>
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${frames.length}, minmax(0, 1fr))` }}>
          {frames.map((f) => {
            const on = f === frame;
            return (
              <button
                key={f}
                type="button"
                aria-pressed={on}
                onClick={() => onFrame(f)}
                className="h-11 rounded-2xl border-2 px-1 text-[14px] font-bold tracking-[-0.01em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-2"
                style={on ? { background: INK, borderColor: INK, color: "var(--color-up)" } : { background: "color-mix(in oklch, white 28%, transparent)", borderColor: "color-mix(in oklch, black 20%, transparent)", color: INK }}
              >
                {frameWords(f)}
              </button>
            );
          })}
        </div>
      </div>

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
              style={on ? { background: INK, borderColor: INK, color: colour } : { background: "color-mix(in oklch, white 28%, transparent)", borderColor: "color-mix(in oklch, black 20%, transparent)", color: INK }}
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
            placeholder="1"
            value={amount}
            onChange={(e) => onAmount(cleanAmount(e.target.value))}
            onBlur={() => {
              if (parsed === null) onAmount("1");
            }}
            aria-invalid={tooSmall || tooBig}
            aria-describedby={`${inputId}-hint`}
            className="min-w-0 flex-1 bg-transparent font-mono text-[40px] font-semibold leading-none tracking-[-0.04em] tabular-nums outline-none placeholder:opacity-30"
          />
        </div>
        <p id={`${inputId}-hint`} className={cn("mt-1.5 text-[12px]", tooSmall || tooBig ? "font-semibold" : "opacity-70")}>
          {tooBig ? `Beta limit: ${MAX_STAKE} USDC per round.` : tooSmall ? `The smallest call is $${minStake.toFixed(2)}.` : `Minimum $${minStake.toFixed(2)} · Beta limit ${MAX_STAKE} USDC per round`}
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

      {/* money on the round and the estimate (from the contract) */}
      {chain ? (
        <div className="mt-5 rounded-2xl px-3.5 py-3 text-[13px]" style={{ background: "color-mix(in oklch, black 10%, transparent)" }}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-semibold">Total in this round</span>
            <span className="font-mono text-[18px] font-semibold tabular-nums">{usdc(chain.upTotal + chain.downTotal)}</span>
          </div>
          <div className="mt-1 flex items-center gap-4 font-mono text-[12px] tabular-nums opacity-80">
            <span>▲ UP {usdc(chain.upTotal)}</span>
            <span>▼ DOWN {usdc(chain.downTotal)}</span>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span>
              <span className="font-semibold">Estimated payout</span>
              <span className="block text-[11px] opacity-70">Changes until the round starts</span>
            </span>
            <span className="text-right font-mono font-semibold tabular-nums">
              {estimate ? (estimate.kind === "win" ? usdc(estimate.payout) : <span className="font-sans text-[12px] font-medium">Your money back for now</span>) : "—"}
            </span>
          </div>
        </div>
      ) : null}

      {/* before the one-time permission is asked for: say what it is */}
      {needsPermission && call.status === "idle" ? (
        <div className="mt-4 rounded-2xl p-3 text-[12px] leading-snug" style={{ background: "color-mix(in oklch, black 10%, transparent)" }}>
          <p>{APPROVAL_NOTICE}</p>
          <label className="mt-2 flex items-center gap-2 font-semibold">
            Permission amount
            <span className="flex items-center gap-1 rounded-xl border-2 px-2 py-1" style={{ borderColor: "color-mix(in oklch, black 25%, transparent)" }}>
              <span className="font-mono opacity-60">$</span>
              <input
                inputMode="decimal"
                autoComplete="off"
                value={permission}
                onChange={(e) => setPermission(cleanAmount(e.target.value))}
                aria-label="Permission amount in USDC"
                className="w-16 bg-transparent font-mono tabular-nums outline-none"
              />
            </span>
          </label>
        </div>
      ) : null}

      {/* confirm */}
      <button
        type="button"
        disabled={!canConfirm}
        onClick={() => {
          if (side && chain) {
            setSent({ marketId: market.id, roundIndex: chain.nextRound });
            void call.makeCall({ marketId: market.id, round: chain.nextRound, side, amountUsdc: amount, approvalUsdc: permission });
          }
        }}
        className="mt-4 flex min-h-14 w-full items-center justify-center rounded-2xl px-3 py-2 text-center text-[16px] font-bold leading-tight transition-opacity disabled:cursor-not-allowed"
        style={canConfirm ? { background: INK, color: "var(--color-up)" } : { background: "color-mix(in oklch, black 22%, transparent)", color: INK, opacity: 0.6 }}
      >
        {busy ? STATUS_TEXT[call.status].replace("…", "") : confirmLabel}
      </button>

      {call.status !== "idle" ? (
        <div className="mt-2 text-center text-[12px] leading-snug" role="status">
          <p className="font-semibold">{call.status === "failed" ? (call.errorMessage ?? STATUS_TEXT.failed) : STATUS_TEXT[call.status]}</p>
          {call.errorTechnical && call.status === "failed" ? <p className="mt-0.5 break-words text-[11px] opacity-60">{call.errorTechnical}</p> : null}
          {call.approveTxHash ? (
            <a href={txLink(call.approveTxHash) ?? undefined} target="_blank" rel="noreferrer" className="mr-3 underline underline-offset-2">
              Permission
            </a>
          ) : null}
          {call.status === "done" && sent ? (
            <button type="button" onClick={() => onCalled(sent.marketId, sent.roundIndex)} className="underline underline-offset-2">
              View your call
            </button>
          ) : null}
          {call.status === "done" || call.status === "failed" ? (
            <button type="button" onClick={call.reset} className="ml-3 underline underline-offset-2">
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}

      {/* the rule, in one line */}
      <p className="mt-4 text-center text-[11px] leading-snug opacity-80">
        2% fee on winnings only · Money back if no one is on the other side ·{" "}
        <Link href="/how-it-works" className="font-semibold underline underline-offset-2">
          How it works →
        </Link>
      </p>
    </Tile>
  );
}
