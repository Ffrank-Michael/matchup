// Trend follower: calls the same direction as the last round.
import { UNITS, directionOf, fmtPrice, fmtPct, legalStake, makeCall, skip } from './lib.mjs';

export const name = 'Agent 1 · Trend Follower';
export const BASE_STAKE = 0.5 * UNITS;

export function decide(ctx) {
  if (ctx.history.length === 0) return skip(`${ctx.market}: no finished rounds yet, so there is no trend to follow.`);
  const last = ctx.history[ctx.history.length - 1];
  const side = directionOf(last);
  if (!side) return skip(`${ctx.market}: last round was flat at ${fmtPrice(last.startPrice)}, so there is no trend to follow.`);

  const s = legalStake(BASE_STAKE, ctx);
  if (s.skip) return skip(s.skip);
  return makeCall(side, s.stake,
    `${ctx.market} last round went ${side} (${fmtPrice(last.startPrice)} -> ${fmtPrice(last.endPrice)}, ${fmtPct(last.startPrice, last.endPrice)}), so I follow the trend and call ${side}.`);
}
