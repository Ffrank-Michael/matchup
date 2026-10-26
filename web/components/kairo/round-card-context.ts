"use client";

import * as React from "react";

/** The round a "Verify" link opens. */
export type RoundRef = { marketId: number; roundIndex: number };

export const OpenRoundCard = React.createContext<((ref: RoundRef) => void) | null>(null);

/** Opens the round result card. Null outside the provider (the caller then falls back to a plain link). */
export const useOpenRoundCard = () => React.useContext(OpenRoundCard);
