// Shared helpers for the four house agents. Pure logic: no wallets, no network, no blockchain.
//
// What every agent receives (`ctx`):
//   market    "BTC/USD"
//   history   settled rounds, OLDEST FIRST, newest last: [{ startPrice, endPrice }, ...]
//             prices are plain USD numbers. A round with endPrice > startPrice went UP,
//             endPrice < startPrice went DOWN, equal prices are "flat" (that round is refunded).
//   calls      what is already on the coming round, in USDC micro-units (6 decimals):
//             { up: 1500000, down: 500000 }  means 1.50 USDC on UP and 0.50 USDC on DOWN
//   minStake  the market minimum call in micro-units (100000 = 0.10 USDC)
//   balance   (optional) the USDC the agent has, in micro-units; it never stakes more than this
//   candles   (optional) closed 1-minute candles of the coin, OLDEST FIRST: [{ open, close }, ...]; only the chart reader uses them
//   random    (optional) a function returning a number in [0, 1); only the coin flipper uses it
//
// What every agent returns:
//   { action: 'CALL',  side: 'UP' | 'DOWN', stake: <micro-units>, reason: '<one line with real numbers>' }
//   { action: 'SKIP', reason: '<one line saying why not>' }

export const UNITS = 1_000_000; // micro-units per USDC

export function directionOf(round) {
  if (round.endPrice > round.startPrice) return 'UP';
  if (round.endPrice < round.startPrice) return 'DOWN';
  return null; // flat
}

export const opposite = (side) => (side === 'UP' ? 'DOWN' : 'UP');

/** How many of the newest rounds in a row went the same way (a flat round ends the streak). */
export function currentStreak(history) {
  const last = history.length ? directionOf(history[history.length - 1]) : null;
  if (!last) return { side: null, length: 0 };
  let length = 0;
  for (let i = history.length - 1; i >= 0 && directionOf(history[i]) === last; i--) length++;
  return { side: last, length };
}

export const fmtPrice = (p) =>
  p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtUsdc = (units) => '$' + (units / UNITS).toFixed(2);

export const fmtPct = (from, to) => {
  const pct = ((to - from) / from) * 100;
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
};

/** Turns a wished-for stake into a legal one, or explains why the agent has to sit out. */
export function legalStake(wanted, ctx) {
  let stake = Math.max(Math.round(wanted), ctx.minStake);
  if (ctx.balance !== undefined) {
    if (ctx.balance < ctx.minStake) {
      return { skip: `only ${fmtUsdc(ctx.balance)} left, below the ${fmtUsdc(ctx.minStake)} minimum call` };
    }
    stake = Math.min(stake, ctx.balance);
  }
  return { stake };
}

export const makeCall = (side, stake, reason) => ({ action: 'CALL', side, stake, reason });
export const skip = (reason) => ({ action: 'SKIP', reason });
