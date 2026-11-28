"use client";

import * as React from "react";

/**
 * Shares a link (the phone's share menu where there is one, otherwise it copies the link) and says what happened.
 * The link is made only when tapped, so it always uses the address the site is open on.
 */
export function ShareButton({ makeUrl, label, testId }: { makeUrl: () => string; label: string; testId?: string }) {
  const [done, setDone] = React.useState<"copied" | "failed" | null>(null);
  React.useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(null), 2500);
    return () => window.clearTimeout(t);
  }, [done]);

  const onShare = async () => {
    const url = makeUrl();
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Matchup", text: label, url });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return; // the visitor closed the share menu
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setDone("copied");
    } catch {
      setDone("failed");
    }
  };

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onShare}
      aria-label={label}
      className="shrink-0 rounded-full border border-border px-3 py-1 text-[12px] font-semibold text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span aria-live="polite">{done === "copied" ? "Link copied" : done === "failed" ? "Could not copy" : "Share"}</span>
    </button>
  );
}
