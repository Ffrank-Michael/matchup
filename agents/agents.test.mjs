// Tests for the four house agents. Run with:  node --test agents/agents.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import * as trend from './trendFollower.mjs';
import * as contrarian from './contrarian.mjs';
import * as reader from './chartReader.mjs';
import * as flipper from './coinFlipper.mjs';
import { agents, displayName } from './index.mjs';
import { currentStreak } from './lib.mjs';

const MIN = 100_000; // 0.10 USDC

// Rounds that went UP, DOWN or nowhere. Prices are USD.
const up = (from, to) => ({ startPrice: from, endPrice: to });
const down = (from, to) => ({ startPrice: from, endPrice: to });
const flat = (p) => ({ startPrice: p, endPrice: p });

const ctx = (over = {}) => ({
  market: 'BTC/USD',
  history: [],
  bets: { up: 0, down: 0 },
  minStake: MIN,
  ...over,
});

/** A "random" function that hands out the given numbers one by one. */
const sequence = (...values) => { let i = 0; return () => values[i++]; };

/** Small seeded random generator so the "fair coin" test gives the same answer every time. */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- trend follower

test('trend follower: last round UP -> bets UP, with the real prices in the reason', () => {
  const d = trend.decide(ctx({ history: [down(101000, 100000), up(100000, 100500)] }));
  assert.equal(d.action, 'BET');
  assert.equal(d.side, 'UP');
  assert.equal(d.stake, 500_000);
  assert.equal(d.reason, 'BTC/USD last round went UP (100,000.00 -> 100,500.00, +0.50%), so I follow the trend and bet UP.');
});

test('trend follower: last round DOWN -> bets DOWN', () => {
  const d = trend.decide(ctx({ history: [up(99000, 100000), down(100000, 99000)] }));
  assert.equal(d.side, 'DOWN');
  assert.equal(d.reason, 'BTC/USD last round went DOWN (100,000.00 -> 99,000.00, -1.00%), so I follow the trend and bet DOWN.');
});

test('trend follower: only the LAST round counts', () => {
  const d = trend.decide(ctx({ history: [up(1, 2), up(2, 3), up(3, 4), down(4, 3)] }));
  assert.equal(d.side, 'DOWN');
});

test('trend follower: no history or a flat last round -> skips and says why', () => {
  const none = trend.decide(ctx());
  assert.equal(none.action, 'SKIP');
  assert.match(none.reason, /no finished rounds/);
  const f = trend.decide(ctx({ history: [up(1, 2), flat(100000)] }));
  assert.equal(f.action, 'SKIP');
  assert.match(f.reason, /flat at 100,000\.00/);
});

test('trend follower: stake respects the minimum bet and the balance', () => {
  assert.equal(trend.decide(ctx({ history: [up(1, 2)], minStake: 700_000 })).stake, 700_000);
  assert.equal(trend.decide(ctx({ history: [up(1, 2)], balance: 300_000 })).stake, 300_000);
  assert.equal(trend.decide(ctx({ history: [up(1, 2)], balance: MIN })).stake, MIN);
  const broke = trend.decide(ctx({ history: [up(1, 2)], balance: 50_000 }));
  assert.equal(broke.action, 'SKIP');
  assert.match(broke.reason, /only \$0\.05 left/);
});

// ---------------------------------------------------------------- contrarian

test('contrarian: more money on UP -> bets DOWN', () => {
  const d = contrarian.decide(ctx({ bets: { up: 1_500_000, down: 500_000 } }));
  assert.equal(d.action, 'BET');
  assert.equal(d.side, 'DOWN');
  assert.equal(d.stake, 400_000);
  assert.equal(d.reason, 'BTC/USD: $1.50 is on UP and $0.50 on DOWN (75% on UP), so I bet against the crowd: DOWN.');
});

test('contrarian: more money on DOWN -> bets UP', () => {
  const d = contrarian.decide(ctx({ bets: { up: 200_000, down: 800_000 } }));
  assert.equal(d.side, 'UP');
  assert.equal(d.reason, 'BTC/USD: $0.20 is on UP and $0.80 on DOWN (80% on DOWN), so I bet against the crowd: UP.');
});

test('contrarian: a one-cent lead is still a lead', () => {
  assert.equal(contrarian.decide(ctx({ bets: { up: 510_000, down: 500_000 } })).side, 'DOWN');
});

test('contrarian: an empty round or an even split -> skips', () => {
  const empty = contrarian.decide(ctx());
  assert.equal(empty.action, 'SKIP');
  assert.match(empty.reason, /nobody has bet/);
  const even = contrarian.decide(ctx({ bets: { up: 500_000, down: 500_000 } }));
  assert.equal(even.action, 'SKIP');
  assert.match(even.reason, /even split/);
});

test('contrarian: ignores prices completely', () => {
  const a = contrarian.decide(ctx({ bets: { up: 900_000, down: 100_000 }, history: [up(1, 2)] }));
  const b = contrarian.decide(ctx({ bets: { up: 900_000, down: 100_000 }, history: [down(2, 1)] }));
  assert.equal(a.side, 'DOWN');
  assert.equal(b.side, 'DOWN');
});

test('contrarian: stake respects the balance', () => {
  assert.equal(contrarian.decide(ctx({ bets: { up: 1, down: 0 }, balance: 150_000 })).stake, 150_000);
  assert.equal(contrarian.decide(ctx({ bets: { up: 1, down: 0 }, balance: 90_000 })).action, 'SKIP');
});

// ---------------------------------------------------------------- chart reader

// 20 one-minute candles built from closes; each candle opens at the previous close, the last one can be set apart.
const candlesFrom = (closes, lastOpen) => closes.map((close, i) => ({ open: i === closes.length - 1 && lastOpen !== undefined ? lastOpen : (i === 0 ? close : closes[i - 1]), close }));
const rising = () => candlesFrom(Array.from({ length: 20 }, (_, i) => 100 + i)); // 100 ... 119, last candle closes higher
const falling = () => candlesFrom(Array.from({ length: 20 }, (_, i) => 120 - i)); // 120 ... 101, last candle closes lower

test('chart reader: 5-candle average above the 20-candle average and the last candle closed higher -> UP', () => {
  const d = reader.decide(ctx({ candles: rising() }));
  assert.equal(d.action, 'BET');
  assert.equal(d.side, 'UP');
  assert.equal(d.stake, 500_000);
  assert.equal(d.reason, 'BTC/USD 5-candle average 117.00, 20-candle average 109.50, last candle 118.00 -> 119.00: the short average is above the long one and the last candle closed higher. I call UP.');
});

test('chart reader: 5-candle average below the 20-candle average and the last candle closed lower -> DOWN', () => {
  const d = reader.decide(ctx({ candles: falling() }));
  assert.equal(d.action, 'BET');
  assert.equal(d.side, 'DOWN');
});

test('chart reader: the averages say UP but the last candle closed lower -> follows the last candle: DOWN', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const d = reader.decide(ctx({ candles: candlesFrom(closes, 125) })); // opened at 125, closed at 119
  assert.equal(d.action, 'BET');
  assert.equal(d.side, 'DOWN');
  assert.equal(d.stake, 500_000);
  assert.equal(d.reason, 'BTC/USD 5-candle average 117.00, 20-candle average 109.50, last candle 125.00 -> 119.00: the averages say UP but the last candle closed lower, so I follow the last candle. I call DOWN.');
});

test('chart reader: the averages say DOWN but the last candle closed higher -> follows the last candle: UP', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 120 - i);
  const d = reader.decide(ctx({ candles: candlesFrom(closes, 90) })); // opened at 90, closed at 101
  assert.equal(d.action, 'BET');
  assert.equal(d.side, 'UP');
});

test('chart reader: the last candle closing exactly where it opened -> follows the 5-candle trend', () => {
  const up5 = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.equal(reader.decide(ctx({ candles: candlesFrom(up5, 119) })).side, 'UP'); // short average above the long one
  const down5 = Array.from({ length: 20 }, (_, i) => 120 - i);
  const d = reader.decide(ctx({ candles: candlesFrom(down5, 101) })); // last candle flat, short average below the long one
  assert.equal(d.side, 'DOWN');
  assert.match(d.reason, /closed exactly where it opened, so I follow the 5-candle trend/);
});

test('chart reader: a completely flat chart follows the newest candle that moved, and calls UP if nothing moved', () => {
  const quiet = Array.from({ length: 20 }, () => ({ open: 100, close: 100 }));
  const none = reader.decide(ctx({ candles: quiet }));
  assert.equal(none.action, 'BET'); // never skips
  assert.equal(none.side, 'UP');
  // Averages equal (the two moves cancel), last candle flat: the newest candle that moved decides.
  const dipThenRise = quiet.map((c, i) => (i === 5 ? { open: 101, close: 99 } : i === 6 ? { open: 99, close: 101 } : c));
  assert.equal(reader.decide(ctx({ candles: dipThenRise })).side, 'UP');
  const riseThenDip = quiet.map((c, i) => (i === 5 ? { open: 99, close: 101 } : i === 6 ? { open: 101, close: 99 } : c));
  assert.equal(reader.decide(ctx({ candles: riseThenDip })).side, 'DOWN');
});

test('chart reader: fewer than 20 candles, or none -> skips and says why', () => {
  const d = reader.decide(ctx({ candles: rising().slice(-19) }));
  assert.equal(d.action, 'SKIP');
  assert.equal(d.reason, 'BTC/USD: only 19 one-minute candles so far, and I need 20 to read the chart.');
  assert.equal(reader.decide(ctx()).action, 'SKIP');
});

test('chart reader: uses only the newest 20 candles when it is given more', () => {
  const old = Array.from({ length: 10 }, () => ({ open: 500, close: 500 }));
  const d = reader.decide(ctx({ candles: [...old, ...rising()] }));
  assert.equal(d.side, 'UP');
  assert.match(d.reason, /20-candle average 109.50/);
});

test('chart reader: ignores the rounds history and the money on each side', () => {
  const history = [up(1, 2), up(2, 3), up(3, 4)];
  assert.equal(reader.decide(ctx({ candles: rising(), history, bets: { up: 0, down: 9_000_000 } })).side, 'UP');
  assert.equal(reader.decide(ctx({ candles: falling(), history, bets: { up: 9_000_000, down: 0 } })).side, 'DOWN');
});

test('chart reader: stake respects the minimum and the balance', () => {
  assert.equal(reader.decide(ctx({ candles: rising(), minStake: 700_000 })).stake, 700_000);
  assert.equal(reader.decide(ctx({ candles: rising(), balance: 250_000, minStake: 100_000 })).stake, 250_000);
  assert.equal(reader.decide(ctx({ candles: rising(), balance: 99_999 })).action, 'SKIP');
});

test('current streak helper: a flat round ends a streak, and a broken streak does not count', () => {
  assert.deepEqual(currentStreak([up(1, 2), up(2, 3), up(3, 4), flat(4)]), { side: null, length: 0 });
  assert.deepEqual(currentStreak([up(1, 2), up(2, 3), flat(3), up(3, 4), up(4, 5), up(5, 6)]), { side: 'UP', length: 3 });
  assert.deepEqual(currentStreak([up(1, 2), up(2, 3), down(3, 2), up(2, 3), up(3, 4)]), { side: 'UP', length: 2 });
});

// ---------------------------------------------------------------- coin flipper

test('coin flipper: low number -> DOWN, high number -> UP, with exact stakes', () => {
  const lo = flipper.decide(ctx({ random: sequence(0.1, 0) }));
  assert.equal(lo.side, 'DOWN');
  assert.equal(lo.stake, 100_000);
  assert.equal(lo.reason, 'BTC/USD: coin flip gave 0.10 (under 0.50), so DOWN, with a random $0.10 stake.');
  const hi = flipper.decide(ctx({ random: sequence(0.9, 0.999) }));
  assert.equal(hi.side, 'UP');
  assert.equal(hi.stake, 300_000);
  assert.equal(hi.reason, 'BTC/USD: coin flip gave 0.90 (0.50 or more), so UP, with a random $0.30 stake.');
});

test('coin flipper: exactly 0.50 is UP', () => {
  assert.equal(flipper.decide(ctx({ random: sequence(0.5, 0.5) })).side, 'UP');
});

test('coin flipper: ignores prices and bets', () => {
  const r = () => sequence(0.7, 0.2);
  const plain = flipper.decide(ctx({ random: r() }));
  const loaded = flipper.decide(ctx({ random: r(), history: [down(2, 1), down(3, 2), down(4, 3)], bets: { up: 0, down: 9_000_000 } }));
  assert.equal(plain.side, loaded.side);
  assert.equal(plain.stake, loaded.stake);
});

test('coin flipper: 1000 seeded flips are about half UP and every stake is legal', () => {
  const random = mulberry32(42);
  let ups = 0;
  for (let i = 0; i < 1000; i++) {
    const d = flipper.decide(ctx({ random }));
    if (d.side === 'UP') ups++;
    assert.ok(d.stake >= MIN && d.stake <= 3 * MIN, `stake ${d.stake} outside 0.10 to 0.30 USDC`);
    assert.equal(d.stake % 10_000, 0);
  }
  assert.ok(ups > 450 && ups < 550, `expected about 500 UP, got ${ups}`);
});

test('coin flipper: works with the default random source, and respects the balance', () => {
  const d = flipper.decide(ctx());
  assert.equal(d.action, 'BET');
  assert.ok(d.side === 'UP' || d.side === 'DOWN');
  assert.equal(flipper.decide(ctx({ random: sequence(0.9, 0.999), balance: 120_000 })).stake, 120_000);
  assert.equal(flipper.decide(ctx({ random: sequence(0.9, 0.999), balance: 10_000 })).action, 'SKIP');
});

// ---------------------------------------------------------------- all four together

test('every agent: any BET is UP or DOWN, a whole number of micro-USDC, within limits, with a reason containing real numbers', () => {
  const history = [up(100000, 101000), up(101000, 102000), up(102000, 103000), down(103000, 102500)];
  const bets = { up: 1_200_000, down: 300_000 };
  for (const a of agents) {
    const d = a.decide(ctx({ history, bets, candles: rising(), balance: 5_000_000, random: sequence(0.3, 0.4) }));
    assert.equal(d.action, 'BET', `${a.name} should bet here`);
    assert.ok(d.side === 'UP' || d.side === 'DOWN');
    assert.ok(Number.isInteger(d.stake) && d.stake >= MIN && d.stake <= 5_000_000, `${a.name} stake ${d.stake}`);
    assert.match(d.reason, /\d/, `${a.name} reason has no numbers`);
    assert.ok(!d.reason.includes('\n'), `${a.name} reason is more than one line`);
  }
});

test('every agent: the four have different names, and none touches the input', () => {
  assert.deepEqual(agents.map((a) => a.name), ['Agent 1 · Trend Follower', 'Agent 2 · Contrarian', 'Agent 3 · Chart Reader', 'Agent 4 · Coin Flipper']);
  const input = ctx({ history: [up(1, 2), up(2, 3), up(3, 4)], bets: { up: 5, down: 1 } });
  const copy = JSON.stringify(input);
  for (const a of agents) a.decide({ ...input, random: sequence(0.5, 0.5) });
  assert.equal(JSON.stringify(input), copy);
});

test('every agent: reasons read as normal sentences (words never stuck together, no double spaces)', () => {
  const histories = [
    [],
    [up(100, 101)],
    [down(100, 99), up(99, 100), up(100, 101)],
    [up(100, 101), up(101, 102), up(102, 103), up(103, 104)],
    [down(104, 103), down(103, 102), down(102, 101)],
    [up(100, 101), flat(101)],
  ];
  const crowds = [{ up: 0, down: 0 }, { up: 800_000, down: 200_000 }, { up: 100_000, down: 900_000 }, { up: 500_000, down: 500_000 }];
  let checked = 0;
  for (const a of agents) for (const history of histories) for (const bets of crowds) for (const balance of [undefined, 5_000_000, 50_000]) {
    for (let r = 0; r < 4; r++) {
      const d = a.decide(ctx({ history, bets, candles: [rising(), falling(), []][r % 3], balance, random: sequence(r / 4, (r + 1) / 5) }));
      const text = d.reason;
      assert.ok(typeof text === 'string' && text.length > 10, `${a.name}: empty reason`);
      assert.doesNotMatch(text, /(UP|DOWN)[a-z]|[a-z](UP|DOWN)\b/, `${a.name}: UP/DOWN stuck to a word: ${text}`);
      assert.doesNotMatch(text, / {2,}/, `${a.name}: double space: ${text}`);
      assert.doesNotMatch(text, /[a-z]\$/, `${a.name}: money sign stuck to a word: ${text}`);
      assert.doesNotMatch(text, /undefined|NaN|\[object/, `${a.name}: bad text: ${text}`);
      checked++;
    }
  }
  assert.ok(checked > 800);
});

test('agent names: Agent 1 to 4, and the wallet keys map to them', () => {
  assert.equal(displayName('trend-follower'), 'Agent 1 · Trend Follower');
  assert.equal(displayName('contrarian'), 'Agent 2 · Contrarian');
  assert.equal(displayName('chart-reader'), 'Agent 3 · Chart Reader');
  assert.equal(displayName('coin-flipper'), 'Agent 4 · Coin Flipper');
  assert.equal(displayName('someone-else'), 'someone-else');
});
