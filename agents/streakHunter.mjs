// Streak hunter: bets AGAINST a streak of 3 or more rounds in the same direction,
// otherwise follows the trend (same direction as the last round).
import { UNITS, currentStreak, fmtPrice, fmtPct, opposite, legalStake, bet, skip } from './lib.mjs';

export const name = 'Streak hunter';
export const STREAK_LENGTH = 3;
export const FOLLOW_STAKE = 0.3 * UNITS;
export const FADE_STAKE = 0.6 * UNITS; // bigger bet when it thinks a streak is due to end

export function decide(ctx) {
  const { side, length } = currentStreak(ctx.history);
  if (!side) {
    return skip(ctx.history.length === 0
      ? `${ctx.market}: no finished rounds yet, so there is no streak or trend.`
      : `${ctx.market}: last round was flat, so there is no streak or trend.`);
  }
  const first = ctx.history[ctx.history.length - length];
  const last = ctx.history[ctx.history.length - 1];
  const span = `${fmtPrice(first.startPrice)} -> ${fmtPrice(last.endPrice)}, ${fmtPct(first.startPrice, last.endPrice)}`;

  if (length >= STREAK_LENGTH) {
    const s = legalStake(FADE_STAKE, ctx);
    if (s.skip) return skip(s.skip);
    return bet(opposite(side), s.stake,
      `${ctx.market} went ${side} ${length} rounds in a row (${span}), a streak of ${STREAK_LENGTH} or more, so I bet against it: ${opposite(side)}.`);
  }
  const s = legalStake(FOLLOW_STAKE, ctx);
  if (s.skip) return skip(s.skip);
  return bet(side, s.stake,
    `${ctx.market} has only gone ${side} ${length} round${length === 1 ? '' : 's'} in a row (${span}), under ${STREAK_LENGTH}, so I follow the trend: ${side}.`);
}
