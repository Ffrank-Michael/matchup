/**
 * onchain/payout.ts
 * What a call would pay if it wins, from the money on the round NOW. It is an estimate: the pots change until calling closes.
 * Same rule as the contract's claim: the fee is 2% of the LOSING side's total, taken from winnings only; the winners share
 * the rest of the losing side in proportion to their stake; a round with nobody on the other side is refunded in full.
 * All amounts are 6-decimal USDC units (bigint).
 */
const FEE_BPS = 200n;
const BPS = 10_000n;

export type PayoutEstimate =
  | { kind: "win"; payout: bigint }
  /** Nobody on the other side yet: the stake would come back, no fee */
  | { kind: "refund"; payout: bigint };

export function estimatePayout(side: "UP" | "DOWN", stake: bigint, upTotal: bigint, downTotal: bigint): PayoutEstimate {
  const mine = (side === "UP" ? upTotal : downTotal) + stake; // the pot on my side including my stake
  const other = side === "UP" ? downTotal : upTotal;
  if (other === 0n) return { kind: "refund", payout: stake };
  const fee = (other * FEE_BPS) / BPS;
  const share = ((other - fee) * stake) / mine;
  return { kind: "win", payout: stake + share };
}
