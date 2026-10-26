"use client";

import * as React from "react";

import type { Round } from "@/onchain";

/** The round a "Verify" link opens. `round` is given for an old round (Round history) that the page does not hold itself. */
export type RoundRef = { marketId: number; roundIndex: number; round?: Round };

export const OpenRoundCard = React.createContext<((ref: RoundRef) => void) | null>(null);

/** Opens the round result card. Null outside the provider (the caller then falls back to a plain link). */
export const useOpenRoundCard = () => React.useContext(OpenRoundCard);
