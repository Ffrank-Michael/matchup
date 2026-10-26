/**
 * onchain/payout.ts
 * Matched calls (docs/MATCHED_CALLS.md). Your money plays against the other side. The matched amount M is the smaller of the two
 * sides; the smaller side is fully matched, and on the bigger side everyone is matched in proportion, so the extra comes back.
 * Winners get their stake back plus their matched share of M less the 2% fee (fee = 2% of M); the matched part of a losing call
 * is lost, the unmatched part comes back either way.
 *
 * Same maths as the contract (bigger side WON: matched rounds down; bigger side LOST: matched rounds up).
 * An estimate before the round starts: the pots change until calling closes. All amounts are 6-decimal USDC units (bigint).
 */
const FEE_BPS = 200n;
const BPS = 10_000n;

/** How much of a stake is matched. mine/other are the two whole sides (including this stake). */
export function matchedPart(stake: bigint, mine: bigint, other: bigint, won: boolean): bigint {
  if (mine <= other) return stake; // the smaller side (or a tie) is matched in full
  const exact = stake * other; // other is M, mine is T
  return won ? exact / mine : (exact + mine - 1n) / mine;
}

export type PayoutEstimate =
  /** Matched `matched` of the stake. Win: payout = stake + bonus. Either way `unmatched` comes back. */
  | { kind: "win"; payout: bigint; matched: bigint; unmatched: bigint; bonus: bigint }
  /** Nobody on the other side yet: the stake would come back, no fee */
  | { kind: "refund"; payout: bigint };

export function estimatePayout(side: "UP" | "DOWN", stake: bigint, upTotal: bigint, downTotal: bigint): PayoutEstimate {
  const mine = (side === "UP" ? upTotal : downTotal) + stake; // the pot on my side including my stake
  const other = side === "UP" ? downTotal : upTotal;
  if (other === 0n) return { kind: "refund", payout: stake };
  const M = mine < other ? mine : other;
  const matched = matchedPart(stake, mine, other, true);
  const bonus = (matched * (M - (M * FEE_BPS) / BPS)) / M;
  return { kind: "win", payout: stake + bonus, matched, unmatched: stake - matched, bonus };
}

/**
 * What a call is paid once the round has settled. `won` = this call's side won. Winners: the stake plus the matched share of
 * the pot less 2%. Losers: only the unmatched part of the stake comes back (0 for the smaller side).
 * mine/other are the whole totals of the call's side and of the other side.
 */
export function settledPayout(stake: bigint, mine: bigint, other: bigint, won: boolean): bigint {
  if (other === 0n || mine === 0n) return stake;
  const M = mine < other ? mine : other;
  const matched = matchedPart(stake, mine, other, won);
  if (!won) return stake - matched;
  return stake + (matched * (M - (M * FEE_BPS) / BPS)) / M;
}

/** How much of a settled call was matched (and how much came or comes back). */
export function settledSplit(stake: bigint, mine: bigint, other: bigint, won: boolean): { matched: bigint; unmatched: bigint } {
  if (other === 0n || mine === 0n) return { matched: 0n, unmatched: stake };
  const matched = matchedPart(stake, mine, other, won);
  return { matched, unmatched: stake - matched };
}
