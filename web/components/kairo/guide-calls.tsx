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

/** An agent's last five guide calls on the selected market, newest first: the side, how it ended, and when it was made. */
export function GuideRecent({ info, className }: { info?: AgentLive; className?: string }) {
  const rows = info?.guideRecent;
  if (!rows || rows.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-1.5", className)} aria-label="Last five calls, newest first">
      {rows.map((p) => (
        <li key={p.round} className="text-[12px] leading-tight">
          <p className="flex items-baseline gap-2">
            <span className="w-[4.5rem] shrink-0 whitespace-nowrap font-mono font-semibold" style={{ color: p.call === "UP" ? "var(--color-up)" : "var(--color-down)" }}>
              {p.call === "UP" ? "▲" : "▼"} {p.call}
            </span>
            <span className="font-medium" style={{ color: RESULT[p.res].colour }}>{RESULT[p.res].word}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">{GUIDE_LABEL} · made {timeOf(p.at)}</p>
        </li>
      ))}
    </ul>
  );
}
