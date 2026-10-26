// Chart reader: reads the 1-minute chart. If the average of the last 5 closes is above the average of the last 20 closes
// and the newest candle closed higher than it opened, it calls UP. The opposite, DOWN. Anything else, it skips the round.
import { UNITS, fmtPrice, legalStake, bet, skip } from './lib.mjs';

export const name = 'Agent 3 · Chart Reader';
export const BASE_STAKE = 0.5 * UNITS;
export const FAST = 5;   // candles in the short average
export const SLOW = 20;  // candles in the long average

const average = (list) => list.reduce((sum, c) => sum + c.close, 0) / list.length;

export function decide(ctx) {
  const candles = ctx.candles ?? [];
  if (candles.length < SLOW) {
    return skip(`${ctx.market}: only ${candles.length} one-minute candles so far, and I need ${SLOW} to read the chart.`);
  }
  const recent = candles.slice(-SLOW);
  const fast = average(recent.slice(-FAST));
  const slow = average(recent);
  const last = recent[recent.length - 1];
  const numbers = `5-candle average ${fmtPrice(fast)}, 20-candle average ${fmtPrice(slow)}, last candle ${fmtPrice(last.open)} -> ${fmtPrice(last.close)}`;

  let side = null;
  if (fast > slow && last.close > last.open) side = 'UP';
  else if (fast < slow && last.close < last.open) side = 'DOWN';
  if (!side) {
    return skip(`${ctx.market}: the chart does not agree with itself (${numbers}), so I sit this round out.`);
  }
  const s = legalStake(BASE_STAKE, ctx);
  if (s.skip) return skip(s.skip);
  return bet(side, s.stake,
    `${ctx.market} ${numbers}: ${side === 'UP' ? 'the short average is above the long one and the last candle closed higher' : 'the short average is below the long one and the last candle closed lower'}, so I call ${side}.`);
}
