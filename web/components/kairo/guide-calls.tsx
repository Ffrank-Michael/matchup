"use client";

import * as React from "react";

import type { AgentLive } from "@/lib/agents";
import { GUIDE_LABEL } from "@/lib/use-guide-calls";
import { cn } from "@/lib/utils";
import { arcMainnet, arcTestnet } from "@/onchain/chains";
import { NETWORK } from "@/onchain/env";

const RESULT = {
  won: { word: "Won", colour: "oklch(0.8 0.16 155)" },
  lost: { word: "Lost", colour: "oklch(0.66 0.2 22)" },
  none: { word: "No result", colour: "var(--color-muted-foreground)" },
  pending: { word: "Not over yet", colour: "var(--color-muted-foreground)" },
} as const;

const timeOf = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Under an agent's current call: what kind of call it is. A guide call moves no money; a call sent on chain keeps its own badge and transaction link. */
export function CallSource({ info, className }: { info?: AgentLive; className?: string }) {
  if (!info?.call) return null;
  if (info.callTx) {
    const explorer = (NETWORK === "mainnet" ? arcMainnet : arcTestnet).blockExplorers.default.url;
    return (
      <p className={cn("mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground", className)}>
        <span className="rounded-full border border-border px-2 py-0.5 font-medium text-foreground">On-chain call</span>
        <a href={`${explorer}/tx/${info.callTx}`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
          View transaction
        </a>
      </p>
    );
  }
  if (!info.guide) return null;
  return (
    <p className={cn("mt-1.5 text-[11px] text-muted-foreground", className)}>
      {GUIDE_LABEL}
      {info.callAt ? <span> · made {timeOf(info.callAt)}</span> : null}
    </p>
  );
}

/** The streak marks, as before: one small round mark per call in a row, newest first. */
const MARK = {
  won: { mark: "✓", background: "oklch(0.8 0.16 155)", colour: "#0b0b0b" },
  lost: { mark: "✕", background: "oklch(0.66 0.2 22)", colour: "#0b0b0b" },
  none: { mark: "", background: "var(--color-muted-foreground)", colour: "transparent" },
  pending: { mark: "", background: "var(--color-muted-foreground)", colour: "transparent" },
} as const;

/**
 * An agent's last five guide calls on the selected market as a streak, newest first: a green check for a call that won, a red X for
 * one that lost, a grey dot for one that is not over yet or had no result. Tap a mark (hover on a laptop) to see its call and when it was made.
 * One label under the row says they are guide calls.
 */
export function GuideRecent({ info, className }: { info?: AgentLive; className?: string }) {
  const rows = info?.guideRecent;
  const [open, setOpen] = React.useState<number | null>(null);
  if (!rows || rows.length === 0) return null;
  const shown = rows.find((p) => p.round === open);
  return (
    <div className={className}>
      <ul className="flex gap-2" aria-label="Last five calls, newest first">
        {rows.map((p) => {
          const m = MARK[p.res];
          const text = `${p.call} · ${RESULT[p.res].word} · made ${timeOf(p.at)}`;
          return (
            <li key={p.round}>
              <button
                type="button"
                title={text}
                aria-label={text}
                aria-pressed={open === p.round}
                onClick={() => setOpen(open === p.round ? null : p.round)}
                className="grid size-[18px] place-items-center rounded-full text-[11px] font-bold leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ background: m.background, color: m.colour }}
              >
                {m.mark}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-1.5 min-h-4 text-[11px] leading-tight text-muted-foreground" aria-live="polite">
        {shown ? `${shown.call} · ${RESULT[shown.res].word} · made ${timeOf(shown.at)}` : "Guide calls, no money"}
      </p>
    </div>
  );
}
