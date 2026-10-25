// Tests for the four house agents. Run with:  node --test agents/agents.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import * as trend from './trendFollower.mjs';
import * as contrarian from './contrarian.mjs';
import * as streak from './streakHunter.mjs';
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

// ---------------------------------------------------------------- streak hunter

test('streak hunter: 3 UP rounds in a row -> bets DOWN (the boundary)', () => {
  const history = [up(100000, 101000), up(101000, 102000), up(102000, 103000)];
  const d = streak.decide(ctx({ history }));
  assert.equal(d.action, 'BET');
  assert.equal(d.side, 'DOWN');
  assert.equal(d.stake, 600_000);
  assert.equal(d.reason, 'BTC/USD went UP 3 rounds in a row (100,000.00 -> 103,000.00, +3.00%), a streak of 3 or more, so I bet against it: DOWN.');
});

test('streak hunter: a long DOWN streak -> bets UP, counting the whole streak', () => {
  const history = [up(90, 100), down(100, 98), down(98, 96), down(96, 94), down(94, 92), down(92, 90)];
  const d = streak.decide(ctx({ history }));
  assert.equal(d.side, 'UP');
  assert.match(d.reason, /went DOWN 5 rounds in a row \(100\.00 -> 90\.00, -10\.00%\)/);
});

test('streak hunter: only 2 in a row -> follows the trend instead', () => {
  const history = [down(100000, 99000), up(100000, 101000), up(101000, 102000)];
  const d = streak.decide(ctx({ history }));
  assert.equal(d.side, 'UP');
  assert.equal(d.stake, 300_000);
  assert.equal(d.reason, 'BTC/USD has only gone UP 2 rounds in a row (100,000.00 -> 102,000.00, +2.00%), under 3, so I follow the trend: UP.');
});

test('streak hunter: one round -> singular wording, follows the trend', () => {
  const d = streak.decide(ctx({ history: [down(100000, 99000)] }));
  assert.equal(d.side, 'DOWN');
  assert.match(d.reason, /only gone DOWN 1 round in a row/);
});

test('streak hunter: a broken streak does not count (UP UP DOWN UP UP is a streak of 2)', () => {
  const history = [up(1, 2), up(2, 3), down(3, 2), up(2, 3), up(3, 4)];
  assert.deepEqual(currentStreak(history), { side: 'UP', length: 2 });
  assert.equal(streak.decide(ctx({ history })).side, 'UP'); // follows, does not fade
});

test('streak hunter: a flat round ends a streak, and a flat LAST round means skip', () => {
  assert.deepEqual(currentStreak([up(1, 2), up(2, 3), up(3, 4), flat(4)]), { side: null, length: 0 });
  const d = streak.decide(ctx({ history: [up(1, 2), up(2, 3), up(3, 4), flat(4)] }));
  assert.equal(d.action, 'SKIP');
  assert.match(d.reason, /flat/);
  assert.deepEqual(currentStreak([up(1, 2), up(2, 3), flat(3), up(3, 4), up(4, 5), up(5, 6)]), { side: 'UP', length: 3 });
});

test('streak hunter: no history -> skips', () => {
  const d = streak.decide(ctx());
  assert.equal(d.action, 'SKIP');
  assert.match(d.reason, /no finished rounds/);
});

test('streak hunter: ignores how much money is on each side', () => {
  const history = [up(1, 2), up(2, 3), up(3, 4)];
  assert.equal(streak.decide(ctx({ history, bets: { up: 0, down: 9_000_000 } })).side, 'DOWN');
  assert.equal(streak.decide(ctx({ history, bets: { up: 9_000_000, down: 0 } })).side, 'DOWN');
});

test('streak hunter: stake respects the balance', () => {
  const history = [up(1, 2), up(2, 3), up(3, 4)];
  assert.equal(streak.decide(ctx({ history, balance: 250_000 })).stake, 250_000);
  assert.equal(streak.decide(ctx({ history, balance: 99_999 })).action, 'SKIP');
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
    const d = a.decide(ctx({ history, bets, balance: 5_000_000, random: sequence(0.3, 0.4) }));
    assert.equal(d.action, 'BET', `${a.name} should bet here`);
    assert.ok(d.side === 'UP' || d.side === 'DOWN');
    assert.ok(Number.isInteger(d.stake) && d.stake >= MIN && d.stake <= 5_000_000, `${a.name} stake ${d.stake}`);
    assert.match(d.reason, /\d/, `${a.name} reason has no numbers`);
    assert.ok(!d.reason.includes('\n'), `${a.name} reason is more than one line`);
  }
});

test('every agent: the four have different names, and none touches the input', () => {
  assert.deepEqual(agents.map((a) => a.name), ['Agent 1 · Trend Follower', 'Agent 2 · Contrarian', 'Agent 3 · Streak Hunter', 'Agent 4 · Coin Flipper']);
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
      const d = a.decide(ctx({ history, bets, balance, random: sequence(r / 4, (r + 1) / 5) }));
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
  assert.equal(displayName('streak-hunter'), 'Agent 3 · Streak Hunter');
  assert.equal(displayName('coin-flipper'), 'Agent 4 · Coin Flipper');
  assert.equal(displayName('someone-else'), 'someone-else');
});
