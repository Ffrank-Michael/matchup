import { cn } from "@/lib/utils";

/** What state a round is in, for the badge: running now, taking calls, or finished (with how it ended). */
export type RoundStatus = { kind: "live" } | { kind: "next" } | { kind: "ended"; result: string } | { kind: "waiting" };

/** The status of a round from the clock and the chain: `result` is "UP", "DOWN" or "Refunded" once the contract has settled it. */
export function roundStatusOf(lockSec: number, endSec: number, nowSec: number | null, result: string | null): RoundStatus {
  if (result) return { kind: "ended", result };
  if (nowSec === null) return { kind: "waiting" };
  if (nowSec < lockSec) return { kind: "next" };
  if (nowSec < endSec) return { kind: "live" };
  return { kind: "waiting" };
}

/**
 * A clear badge on every round: a blinking dot with LIVE for the running round, NEXT for the round taking calls, and a
 * grey ENDED with the result for a finished one.
 */
export function RoundBadge({ status, className }: { status: RoundStatus; className?: string }) {
  const base = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase leading-none tracking-[0.06em]";
  if (status.kind === "live") {
    return (
      <span className={cn(base, "border border-[oklch(0.66_0.2_22/0.5)] text-[oklch(0.75_0.17_22)]", className)}>
        <span aria-hidden className="kairo-blink size-1.5 rounded-full bg-[oklch(0.66_0.2_22)]" />
        Live
      </span>
    );
  }
  if (status.kind === "next") {
    return <span className={cn(base, "border border-foreground/40 text-foreground", className)}>Next</span>;
  }
  if (status.kind === "waiting") {
    return <span className={cn(base, "bg-muted text-muted-foreground", className)}>Ended · result coming</span>;
  }
  return <span className={cn(base, "bg-muted text-muted-foreground", className)}>Ended · {status.result}</span>;
}
