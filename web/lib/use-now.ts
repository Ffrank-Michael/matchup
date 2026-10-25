"use client";

import * as React from "react";

function subscribe(onChange: () => void) {
  const id = window.setInterval(onChange, 1000);
  return () => window.clearInterval(id);
}
const getNow = () => Math.floor(Date.now() / 1000);

/** Current time in whole seconds, ticking every second. null on the server (so pages never freeze a time). */
export function useNowSeconds(): number | null {
  return React.useSyncExternalStore(subscribe, getNow, () => null);
}
