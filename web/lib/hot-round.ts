// A "hot" round: calls are waiting on one side only and calling is still open, so someone on the other side is needed.
// The round card shows a flame for it, and under it a line that says which side is waiting and how much.
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

/**
 * A USDC amount for the waiting line, from micro USDC (6 decimals): whole dollars without decimals ("2"), otherwise cents
 * rounded down ("2.50", "0.75"), so the line never says more than is there. Below one cent it shows every digit.
 */
export function usdcPlain(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const rest = micro % 1_000_000n;
  if (rest === 0n) return whole.toString();
  const cents = rest / 10_000n;
  if (whole === 0n && cents === 0n) return `0.${rest.toString().padStart(6, "0").replace(/0+$/, "")}`;
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}

/**
 * The line under the flame: "UP 2 USDC waiting. Needs DOWN." (or the reverse). For coin vs coin the sides have their own
 * names, so it reads "2 USDC waiting on ETH wins. Needs BTC wins." Null when the round is not hot.
 */
export function waitingLine(w: Waiting | null, words: { UP: string; DOWN: string } = { UP: "UP", DOWN: "DOWN" }): string | null {
  if (!w) return null;
  const amount = `${usdcPlain(w.amount)} USDC`;
  const plain = words.UP === "UP" && words.DOWN === "DOWN";
  return plain
    ? `${w.side} ${amount} waiting. Needs ${w.needs}.`
    : `${amount} waiting on ${words[w.side]}. Needs ${words[w.needs]}.`;
}
