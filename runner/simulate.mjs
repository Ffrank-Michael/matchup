// A tiny pretend blockchain, used to watch the round runner work for a few hours of fake time
// without sending anything. It copies the contract's rules in simplified form (the real
// contract is tested separately), so it can only show that the RUNNER does the right things in
// the right order.  Try it:   node runner/simulate.mjs --hours 4
import { CFG } from './config.mjs';
import { createWalk } from './priceWalk.mjs';
import { planTick, lockTime, endTime } from './plan.mjs';

export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ['trend-follower', 'contrarian', 'streak-hunter', 'coin-flipper'];
const usdc = (u) => '$' + (u / 1e6).toFixed(2);
const clock = (t0, t) => {
  const s = t - t0;
  return `+${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function createWorld({ now, seed = 1, startUsd = 100000 }) {
  const random = mulberry32(seed);
  return {
    now,
    random,
    walk: createWalk(startUsd, random),
    markets: [{ id: 0, name: 'BTC/USD', roundLength: 3600, startOffset: 0, minStake: 100_000, paused: false, nextRound: 0, feed: { updates: [] }, rounds: {} }],
    agents: KEYS.map((key) => ({ key, balance: 5_000_000, allowance: 0, positions: {} })),
  };
}

const round = (m, k) => (m.rounds[k] ||= { state: 'Unsettled', up: 0, down: 0, startPrice: 0n, endPrice: 0n });
const nextRoundAt = (m, now) => (now < m.startOffset ? 0 : Math.floor((now - m.startOffset) / m.roundLength) + 1);

/** Applies one planned action to the pretend chain, with the same refusals the contract has. */
function apply(world, a) {
  const m = world.markets[a.market ?? 0];
  const agent = world.agents.find((x) => x.key === a.agent);
  switch (a.type) {
    case 'pushPrice': {
      const price = world.walk.next();
      m.feed.updates.push({ id: (1n << 64n) | BigInt(m.feed.updates.length + 1), updatedAt: world.now, price });
      return `${a.why}: ${(Number(price) / 1e8).toFixed(2)}`;
    }
    case 'approve':
      agent.allowance += a.amount;
      return `approves ${usdc(a.amount)}`;
    case 'bet': {
      if (a.round !== nextRoundAt(m, world.now)) throw new Error('not the next round');
      const pos = (agent.positions[`${m.id}:${a.round}`] ||= { up: 0, down: 0, claimed: false });
      if ((a.side === 'UP' ? pos.down : pos.up) > 0) throw new Error('wrong side');
      if (a.stake < m.minStake || a.stake > agent.balance || a.stake > agent.allowance) throw new Error('stake/balance/allowance');
      agent.balance -= a.stake; agent.allowance -= a.stake;
      pos[a.side === 'UP' ? 'up' : 'down'] += a.stake;
      round(m, a.round)[a.side === 'UP' ? 'up' : 'down'] += a.stake;
      return `bets ${a.side} ${usdc(a.stake)} on round ${a.round}: ${a.reason}`;
    }
    case 'settle': {
      const r = round(m, a.round);
      const lt = lockTime(m, a.round), et = endTime(m, a.round);
      if (r.state !== 'Unsettled' || !(world.now > et && world.now <= et + CFG.settleWindow)) throw new Error('cannot settle now');
      const byId = (id) => m.feed.updates.find((u) => u.id === id);
      let state;
      if (r.up === 0 || r.down === 0) state = 'Refunded';
      else if (a.startId === 0n) {
        const latest = m.feed.updates[m.feed.updates.length - 1];
        if (latest && latest.updatedAt >= lt) throw new Error('InvalidStartRound(0)');
        state = 'Refunded';
      } else {
        const s = byId(a.startId), e = byId(a.endId);
        if (!s || s.updatedAt < lt) throw new Error('InvalidStartRound');
        const prev = byId(a.startId - 1n);
        if ((a.startId & 0xffffffffffffffffn) !== 1n && (!prev || prev.updatedAt >= lt)) throw new Error('InvalidStartRound (predecessor)');
        if (!e || e.updatedAt > et) throw new Error('InvalidEndRound');
        const next = byId(a.endId + 1n);
        if (next && next.updatedAt <= et) throw new Error('InvalidEndRound (not last)');
        if (a.endId <= a.startId || s.price <= 0n || e.price <= 0n || s.price === e.price) state = 'Refunded';
        else state = e.price > s.price ? 'SettledUp' : 'SettledDown';
        r.startPrice = s.price; r.endPrice = e.price;
      }
      r.state = state;
      return `settles round ${a.round} -> ${state} (ids ${a.startId & 0xffffn}/${a.endId & 0xffffn})`;
    }
    case 'claim': {
      const p = agent.positions[`${m.id}:${a.round}`];
      const r = round(m, a.round);
      if (!p || p.claimed) throw new Error('nothing to claim');
      let state = r.state;
      if (state === 'Unsettled') { if (world.now <= endTime(m, a.round) + CFG.settleWindow) throw new Error('RoundNotSettled'); state = r.state = 'Refunded'; }
      let payout = 0;
      if (state === 'Refunded') payout = p.up + p.down;
      else {
        const W = state === 'SettledUp' ? r.up : r.down, L = state === 'SettledUp' ? r.down : r.up;
        const s = state === 'SettledUp' ? p.up : p.down;
        if (s === 0) throw new Error('NothingToClaim');
        payout = s + Math.floor((s * (L - Math.floor((L * 200) / 10000))) / W);
      }
      p.claimed = true; agent.balance += payout;
      return `claims ${usdc(payout)} from round ${a.round}`;
    }
    default: throw new Error('unknown action ' + a.type);
  }
}

/** Runs the runner against the pretend chain. Returns { lines, world, failures }. */
export function simulate({ hours = 3, seed = 1, startAt = 36000 } = {}) {
  const world = createWorld({ now: startAt, seed });
  const cfg = { ...CFG, random: world.random };
  const decided = new Set();
  const lines = [];
  let failures = 0;
  for (let t = startAt; t < startAt + hours * 3600; t += cfg.tickSeconds) {
    world.now = t;
    for (const m of world.markets) m.nextRound = nextRoundAt(m, t);
    const { actions, decisions } = planTick(world, cfg, decided);
    for (const d of decisions) {
      decided.add(d.id);
      if (d.decision.action === 'SKIP') lines.push(`${clock(startAt, t)}  ${d.agent} skips round ${d.round}: ${d.decision.reason}`);
    }
    for (const a of actions) {
      const who = a.agent || 'runner';
      try { lines.push(`${clock(startAt, t)}  ${who} ${apply(world, a)}`); }
      catch (e) { failures++; lines.push(`${clock(startAt, t)}  ${who} FAILED ${a.type}: ${e.message}`); }
    }
  }
  return { lines, world, failures };
}

if (process.argv[1] && process.argv[1].endsWith('simulate.mjs')) {
  const i = process.argv.indexOf('--hours');
  const { lines, world, failures } = simulate({ hours: i >= 0 ? Number(process.argv[i + 1]) : 3 });
  console.log(lines.join('\n'));
  console.log(`\n${failures} failed actions. Final balances:`);
  for (const a of world.agents) console.log(`  ${a.key.padEnd(15)} ${usdc(a.balance)}`);
}
