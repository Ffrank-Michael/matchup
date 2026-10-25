// Coin flipper: random direction and a random stake (from the minimum up to 3x the minimum,
// in 0.01 USDC steps).
import { fmtUsdc, legalStake, bet, skip } from './lib.mjs';

export const name = 'Coin flipper';
const STEP = 10_000; // 0.01 USDC

export function decide(ctx) {
  const random = ctx.random || Math.random;
  const flip = random();
  const side = flip >= 0.5 ? 'UP' : 'DOWN';
  const steps = Math.floor((2 * ctx.minStake) / STEP) + 1; // adds 0 .. 2x the minimum
  const wanted = ctx.minStake + Math.floor(random() * steps) * STEP;

  const s = legalStake(wanted, ctx);
  if (s.skip) return skip(s.skip);
  return bet(side, s.stake,
    `${ctx.market}: coin flip gave ${flip.toFixed(2)} (${flip >= 0.5 ? '0.50 or more' : 'under 0.50'}), so ${side}, with a random ${fmtUsdc(s.stake)} stake.`);
}
