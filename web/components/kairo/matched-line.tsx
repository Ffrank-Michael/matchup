import { oneSidedText } from "@/lib/one-sided";
import { estimatePayout, usdc } from "@/onchain";

/**
 * The matched-calls line for a call: how much of the stake plays against the other side, what a win adds, and what comes back
 * either way. An estimate until calling closes (the other side can still grow). From the same maths as the contract.
 */
export function matchedLine(side: "UP" | "DOWN", stake: bigint, upTotal: bigint, downTotal: bigint): string | null {
  const e = estimatePayout(side, stake, upTotal, downTotal);
  if (e.kind === "refund") return null;
  const parts = [`Matched ${usdc(e.matched)} of your ${usdc(stake)}`, `If you win +${usdc(e.bonus)}`];
  if (e.unmatched > 0n) parts.push(`${usdc(e.unmatched)} comes back either way`);
  return parts.join(" · ");
}

/**
 * `stake` already counts in upTotal/downTotal when the call is made (the watch sheet); for a call that is still being typed
 * (the call panel) the totals do not include it yet, so pass `includesStake={false}`.
 */
export function MatchedLine({
  side,
  stake,
  upTotal,
  downTotal,
  includesStake,
  closed = false,
  className = "",
}: {
  side: "UP" | "DOWN";
  stake: bigint;
  upTotal: bigint;
  downTotal: bigint;
  includesStake: boolean;
  /** calling has closed: nobody can join the other side any more */
  closed?: boolean;
  className?: string;
}) {
  const up = includesStake && side === "UP" ? upTotal - stake : upTotal;
  const down = includesStake && side === "DOWN" ? downTotal - stake : downTotal;
  const text = matchedLine(side, stake, up, down);
  return (
    <p className={className} data-testid="matched-line">
      {text ?? oneSidedText(closed)}
    </p>
  );
}
