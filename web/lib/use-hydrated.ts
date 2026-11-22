"use client";

import * as React from "react";

const noSubscribe = () => () => {};

/**
 * false on the server and while React hydrates the server's HTML, true right after (React re-renders once with true).
 * For anything whose first browser value can differ from what the server drew: render the server's version until this is
 * true, so hydration matches. Example: the wallet button, because wagmi starts reconnecting (and the Google wallet restores
 * its session) in effects that can run before the header hydrates, the page being hydrated in parts.
 */
export function useHydrated(): boolean {
  return React.useSyncExternalStore(noSubscribe, () => true, () => false);
}
