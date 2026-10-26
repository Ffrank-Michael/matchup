/**
 * A round nobody settles (for example when only one side was called) is refunded in full by the contract once the
 * 1-hour settle window after the round's end has passed (SETTLE_WINDOW in PredictionArena.sol; claim() works
 * from one second after it). These helpers give that moment.
 */
export const SETTLE_WINDOW_SECONDS = 3600;

/** Unix seconds from which a round that ended at `endSec` can be refunded by claiming. */
export function refundAvailableAt(endSec: number) {
  return endSec + SETTLE_WINDOW_SECONDS + 1;
}

/** "14:35" in the viewer's own time zone. */
export function formatHm(unixSec: number) {
  return new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** For the next round of a market: the text under the call panel, from the clock and the schedule only. */
export function nextRoundRefundText(nowSec: number, secondsToLock: number, roundSeconds: number) {
  const endSec = nowSec + secondsToLock + roundSeconds;
  return `Refund available at ${formatHm(refundAvailableAt(endSec))}`;
}
