import * as React from "react";

import { cn } from "@/lib/utils";

// The Web3 Bento tile look: 26px rounded card, quiet title, rise-in animation (see globals.css).

/** The same dark ink the Bento staking tile uses on its solid lime background. */
export const INK = "oklch(0.24 0.06 135)";

export function NotLive({ onAccent, className }: { onAccent?: boolean; className?: string }) {
  return (
    // A span, not a p: it is also used inside buttons, where a p is not allowed.
    <span
      className={cn("flex items-center justify-center gap-2 font-mono text-[12px] text-muted-foreground", className)}
      style={onAccent ? { color: INK, opacity: 0.7 } : undefined}
    >
      <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden />
      not live yet
    </span>
  );
}

export function Tile({
  id,
  title,
  action,
  className,
  index = 0,
  accent,
  children,
}: {
  id?: string;
  title: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /** Position on the page, used to stagger the rise-in animation */
  index?: number;
  /** Solid lime tile */
  accent?: boolean;
  /** Leave empty for a tile that is not live yet */
  children?: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "kairo-rise relative flex min-w-0 flex-col overflow-hidden rounded-[26px] border p-5",
        accent ? "border-transparent bg-up" : "border-border bg-card text-card-foreground",
        className,
      )}
      style={{ animationDelay: `${index * 70}ms`, ...(accent ? { color: INK } : null) }}
    >
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2 className={cn("text-[13px] font-medium", accent ? "font-semibold opacity-75" : "text-muted-foreground")}>{title}</h2>
        {action}
      </header>
      {children ?? <NotLive onAccent={accent} className="flex-1" />}
    </section>
  );
}
