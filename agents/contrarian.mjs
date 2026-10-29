// Contrarian: goes against the side that already has more money on it.
import { UNITS, fmtUsdc, opposite, legalStake, makeCall, skip } from './lib.mjs';

export const name = 'Agent 2 · Contrarian';
export const BASE_STAKE = 0.4 * UNITS;

export function decide(ctx) {
  const { up, down } = ctx.calls;
  const total = up + down;
  if (total === 0) return skip(`${ctx.market}: nobody has called on this round yet, so there is no crowd to go against.`);
  if (up === down) return skip(`${ctx.market}: ${fmtUsdc(up)} on UP and ${fmtUsdc(down)} on DOWN is an even split, so there is no crowd to go against.`);

  const crowd = up > down ? 'UP' : 'DOWN';
  const share = Math.round((Math.max(up, down) / total) * 100);
  const side = opposite(crowd);

  const s = legalStake(BASE_STAKE, ctx);
  if (s.skip) return skip(s.skip);
  return makeCall(side, s.stake,
    `${ctx.market}: ${fmtUsdc(up)} is on UP and ${fmtUsdc(down)} on DOWN (${share}% on ${crowd}), so I go against the crowd: ${side}.`);
}
