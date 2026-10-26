// Chart reader: reads the 1-minute chart. If the average of the last 5 closes is above the average of the last 20 closes
// and the newest candle closed higher than it opened, it calls UP. The opposite, DOWN. When the two signals disagree it follows
// the last candle (the 5-candle trend if that candle is exactly flat). It never skips a round because the chart is unclear.
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

  // Two signals: the averages (5 vs 20 candles) and the direction of the last candle. When they agree it calls that side.
  // When they disagree it follows the last candle: UP if it closed higher, DOWN if lower. If that candle is exactly flat it
  // follows the 5-candle trend (short average against long average). It never sits a round out because the chart is unclear.
  const trend = fast > slow ? 'UP' : fast < slow ? 'DOWN' : null;
  const candle = last.close > last.open ? 'UP' : last.close < last.open ? 'DOWN' : null;
  let side;
  let why;
  if (trend && candle && trend === candle) {
    side = candle;
    why = side === 'UP' ? 'the short average is above the long one and the last candle closed higher' : 'the short average is below the long one and the last candle closed lower';
  } else if (candle) {
    side = candle;
    why = trend
      ? `the averages say ${trend} but the last candle closed ${candle === 'UP' ? 'higher' : 'lower'}, so I follow the last candle`
      : `the averages are level and the last candle closed ${candle === 'UP' ? 'higher' : 'lower'}, so I follow the last candle`;
  } else if (trend) {
    side = trend;
    why = `the last candle closed exactly where it opened, so I follow the 5-candle trend (the short average is ${trend === 'UP' ? 'above' : 'below'} the long one)`;
  } else {
    // A completely flat chart (practically never real data): the newest candle that moved decides; if none moved, UP.
    const moved = [...recent].reverse().find((c) => c.close !== c.open);
    side = moved && moved.close < moved.open ? 'DOWN' : 'UP';
    why = moved ? `the chart is flat, so I follow the newest candle that moved (it closed ${side === 'UP' ? 'higher' : 'lower'})` : 'twenty minutes without a move, so I call UP';
  }
  const s = legalStake(BASE_STAKE, ctx);
  if (s.skip) return skip(s.skip);
  return bet(side, s.stake, `${ctx.market} ${numbers}: ${why}. I call ${side}.`);
}
