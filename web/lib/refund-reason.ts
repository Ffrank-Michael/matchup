// Why a round was refunded, in plain words. The contract records one of these reasons in its RoundSettled event.
// 0 None (not a refund), 1 OneSided, 2 NoUpdate, 3 EndNotAfterStart, 4 UnchangedPrice, 5 InvalidPrice, 6 PhaseEdge, 7 Timeout.

export const REFUND_REASON_TEXT: Record<number, string> = {
  1: "No one on the other side",
  2: "No price received in time",
  3: "No price received in time",
  4: "Price didn't change",
  5: "An invalid price was received",
  6: "No price received in time",
  7: "No price received in time",
};

/** The reason for a refunded round; a refund with no recorded reason is a round nobody settled in time. */
export function refundReasonText(reason: number | null | undefined): string {
  return (reason !== null && reason !== undefined && REFUND_REASON_TEXT[reason]) || "No price received in time";
}
