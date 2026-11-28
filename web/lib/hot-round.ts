// A "hot" round: calls are waiting on one side only and calling is still open, so someone on the other side is needed.
// The round card shows a flame for it (and, from feature 2, a line that says which side is waiting and how much).
// No React and no network, so it can be tested. The amounts are the round's own totals, read from the contract.

type RoundLike = {
  state: "open" | "locked" | "unsettled" | "up" | "down" | "refunded";
  upTotal: bigint;
  downTotal: bigint;
  lockTimeSec: number;
};

export type Waiting = {
  /** The side that has calls */
  side: "UP" | "DOWN";
  /** How much is on that side, in micro USDC (6 decimals), exactly as the contract holds it */
  amount: bigint;
  /** The side that has no calls yet */
  needs: "UP" | "DOWN";
};

/**
 * Which side is waiting, or null: calls on both sides, no calls at all, calling has closed (by the contract's state or by the
 * page's clock), or the clock is not known yet.
 */
export function waitingSide(round: RoundLike | null | undefined, nowSec: number | null): Waiting | null {
  if (!round || nowSec === null) return null;
  if (round.state !== "open" || nowSec >= round.lockTimeSec) return null; // calling has closed
  const up = round.upTotal > 0n;
  const down = round.downTotal > 0n;
  if (up === down) return null; // both sides, or nobody
  return up ? { side: "UP", amount: round.upTotal, needs: "DOWN" } : { side: "DOWN", amount: round.downTotal, needs: "UP" };
}

/** True when the round card should show the flame */
export const isHot = (round: RoundLike | null | undefined, nowSec: number | null) => waitingSide(round, nowSec) !== null;
