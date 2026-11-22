// A round with money on only one side has nothing to play against: the contract refunds it in full, with no fee (rule 14,
// docs/MATCHED_CALLS.md). These are the words the site uses for it, in one place, so the round card, Your calls, the watch
// sheet and the call panel all say the same thing. No React and no network, so it can be tested.

/** While calling is still open: someone can still join the other side */
export const WAITING_TEXT = "Waiting for someone on the other side. If nobody joins, you get your money back.";
/** Calling has closed with money on one side only: the round is a refund */
export const NOBODY_JOINED_TEXT = "Nobody joined the other side, so this round is a refund. You get your money back, with no fee.";

type RoundLike = {
  state: "open" | "locked" | "unsettled" | "up" | "down" | "refunded";
  upTotal: bigint;
  downTotal: bigint;
  lockTimeSec: number;
};

/** The words for one side's money alone: "open" while calls are taken, "closed" after. */
export const oneSidedText = (closed: boolean) => (closed ? NOBODY_JOINED_TEXT : WAITING_TEXT);

/**
 * The note for a round that has calls on only one side and no result yet, or null (calls on both sides, no calls at all, or
 * the round already has its result). `nowSec` (the page's clock) can close calling before the next read of the round does.
 */
export function oneSidedNote(round: RoundLike, nowSec: number | null): string | null {
  if (round.upTotal > 0n === round.downTotal > 0n) return null; // both sides, or nobody
  if (round.state !== "open" && round.state !== "locked" && round.state !== "unsettled") return null; // the result is in
  const closed = round.state !== "open" || (nowSec !== null && nowSec >= round.lockTimeSec);
  return oneSidedText(closed);
}
