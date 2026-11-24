// How the runner takes a round's start and end price, in one place, so every page says the same thing (audit part 2, P2-04).
// Keep these in step with runner/config.mjs (startAfter, endMargin, endCutoff).

/** The end price is taken from this many seconds before the round ends: price moves after that do not count. */
export const END_TAKEN_SECONDS_BEFORE = 60;

/** One plain sentence on the start price. */
export const START_RULE = "The first price after calling closes is the start price.";

/** One plain sentence on the end price. */
export const END_RULE =
  "The end price is taken about one minute before the round ends, so the last minute does not count.";

/** Shown on a live round once its end price is being taken. */
export const END_BEING_TAKEN = "The end price is being taken now. Moves from here to the end do not count.";

/** Is the end price already being taken for a round that ends at endSec? */
export function endBeingTaken(nowSec: number, endSec: number): boolean {
  return nowSec < endSec && endSec - nowSec <= END_TAKEN_SECONDS_BEFORE;
}
