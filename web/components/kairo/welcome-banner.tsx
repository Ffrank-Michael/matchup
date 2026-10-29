"use client";

import Link from "next/link";
import * as React from "react";

// The first-visit banner under the header. Dismissing it is remembered in this browser only (a per-visitor convenience: the site
// works the same without storage, the banner then simply shows again next time).
const STORAGE_KEY = "kairo.welcome.dismissed.v1";
const EVENT = "kairo-welcome";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
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

export function WelcomeBanner() {
  // the server renders it hidden, so there is no flash of the banner for someone who already closed it
  const dismissed = React.useSyncExternalStore(subscribe, readDismissed, () => true);
  const [closedNow, setClosedNow] = React.useState(false);
  if (dismissed || closedNow) return null;

  const dismiss = () => {
    setClosedNow(true);
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
      window.dispatchEvent(new Event(EVENT));
    } catch {
      /* no storage: it is closed for this visit */
    }
  };

  return (
    <div role="note" className="kairo-rise mb-3 flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-2.5 text-[13px]">
      <Link href="/how-it-works" className="min-w-0 flex-1 font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        New here? See how Matchup works in <span className="whitespace-nowrap">30 seconds →</span>
      </Link>
      <button type="button" onClick={dismiss} aria-label="Close this message" className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        ✕
      </button>
    </div>
  );
}
