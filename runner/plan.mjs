// The round runner's brain: given a snapshot of the chain and the clock, decide what to do now.
// Pure logic. It reads nothing and sends nothing, so it can be tested without a blockchain.
//
//   planTick(snapshot, cfg, decided) -> { actions, decisions }
//
// snapshot = {
//   now,                                   // unix seconds (latest block time)
//   markets: [{ id, name, roundLength, startOffset, minStake, paused,
//               nextRound,                 // the round that can be bet on right now
//               feed: { updates: [{ id: BigInt, updatedAt, price: BigInt }] },   // oldest first
//               rounds: { [k]: { state, up, down, startPrice, endPrice } } }],  // state: 'Unsettled' | 'SettledUp' | 'SettledDown' | 'Refunded'
//   agents:  [{ key, balance, allowance, positions: { 'marketId:k': { up, down, claimed } } }],
//   candles: { 'BTC/USD': [{ open, close }, ...] }   closed 1-minute Bitfinex candles, oldest first (for the chart reader; optional)
// }
// decided = Set of decision ids ("market:round:agent") that were already taken this round, so an
//           agent never decides twice (a skip counts as a decision).
//
// Actions:  pushPrice | approve | bet | settle | claim   (the executor turns them into transactions)
//           pushPrice carries { round } = the running round the price belongs to; every live push is written to the public price log (priceLog.mjs)
import * as trendFollower from '../agents/trendFollower.mjs';
import * as chartReader from '../agents/chartReader.mjs';
import * as coinFlipper from '../agents/coinFlipper.mjs';
import * as contrarian from '../agents/contrarian.mjs';
import { findSettleIds } from './settleIds.mjs';
import { AI_AGENTS, MIN_CANDLES, COULDNT_DECIDE, candlesFor, frameLabel } from '../agents/ai.mjs';
import { legalStake, fmtUsdc, opposite } from '../agents/lib.mjs';

const LOGIC = {
  'trend-follower': trendFollower,
  'chart-reader': chartReader,
  'coin-flipper': coinFlipper,
  contrarian,
};
export const EARLY = ['trend-follower', 'chart-reader', 'coin-flipper']; // bet early, in this order
export const LATE = 'contrarian'; // bets last, after the three early agents, once there is money on one side

/** How many past rounds to look at: enough to cover the contract's whole settle window (cfg.lookback is the minimum). */
export const lookbackFor = (m, cfg) => Math.max(cfg.lookback, Math.ceil(cfg.settleWindow / m.roundLength) + 2);

export const lockTime = (m, k) => m.startOffset + k * m.roundLength;
export const endTime = (m, k) => lockTime(m, k) + m.roundLength;
const opensAt = (m, k) => (k === 0 ? 0 : lockTime(m, k - 1));
const posKey = (m, k) => `${m.id}:${k}`;
const decisionId = (m, k, agent) => `${m.id}:${k}:${agent}`;

/** Money on round k of a market that is not one of the house agents' own: what real people put in (micro-USDC). */
function realMoney(m, k, agents) {
  const r = m.rounds[k];
  if (!r) return 0;
  let house = 0;
  for (const a of agents) {
    const p = a.positions[posKey(m, k)];
    if (p) house += p.up + p.down;
  }
  return Math.max(0, r.up + r.down - house);
}

/**
 * How the last few finished rounds went, worked out from the PRICE FEED (not from what the
 * contract settled), so rounds nobody bet on still count. A round's start price is the first
 * update at or after its lock and its end price is the last update at or before its end, the
 * same rule the contract uses. Round k-1 is still running, so the newest finished round is k-2.
 * Oldest first, in the form the agents expect (USD numbers).
 */
function historyFor(m, cfg) {
  const out = [];
  for (let j = Math.max(0, m.nextRound - lookbackFor(m, cfg)); j <= m.nextRound - 2; j++) {
    const { startId, endId } = findSettleIds(m.feed.updates, lockTime(m, j), endTime(m, j));
    if (startId === 0n || endId <= startId) continue; // the feed did not move during that round
    const s = m.feed.updates.find((u) => u.id === startId);
    const e = m.feed.updates.find((u) => u.id === endId);
    out.push({ startPrice: Number(s.price) / 1e8, endPrice: Number(e.price) / 1e8 });
  }
  return out;
}

const coinOf = (m) => m.name.split(' ')[0];
/** One AI call per coin per opening moment: every market of the coin whose next round opens at the same time shares it. */
const batchId = (m, k) => `ai:${coinOf(m)}:${opensAt(m, k)}`;
/** Does the AI play this market? (cfg.aiMarkets: a list of market names, or 'all'.) */
const aiHere = (m, cfg) => !cfg.aiMarkets || cfg.aiMarkets === 'all' || cfg.aiMarkets.includes(m.name);

/**
 * The AI agents (trend follower, contrarian, chart reader) are decided by a small Gemini model. The planner stays a plain function:
 * when a coin's next rounds open it puts ONE REQUEST per coin in `aiRequests` (listing every time frame that opens then); the runner
 * asks the model in the background and hands the answer back through `cfg.ai.results` (batch id -> { ok, decisions }); the next tick
 * turns it into bets or skips. Without `cfg.ai` (the tests and the simulation) every agent uses its plain rule from agents/*.mjs.
 */
function planAiRequests(snap, cfg, decided, aiRequests, agentByKey) {
  const groups = new Map();
  for (const m of snap.markets) {
    const k = m.nextRound;
    if (m.paused || !aiHere(m, cfg)) continue;
    if (snap.now < opensAt(m, k) + cfg.aiAskAfter || snap.now >= lockTime(m, k) - cfg.earlyCutoff) continue;
    // nothing to ask when every AI agent has already acted on this round or has no money to call with
    const needed = AI_AGENTS.some((key) => {
      const a = agentByKey[key];
      const p = a.positions[posKey(m, k)];
      return !(p && p.up + p.down > 0) && !decided.has(decisionId(m, k, key)) && a.balance - cfg.gasReserve >= m.minStake;
    });
    if (!needed) continue;
    const id = batchId(m, k);
    if (!groups.has(id)) groups.set(id, { id, coin: coinOf(m), opensAt: opensAt(m, k), frames: [] });
    groups.get(id).frames.push({ marketId: m.id, market: m.name, label: frameLabel(m.roundLength), roundSeconds: m.roundLength, round: k, secondsToLock: lockTime(m, k) - snap.now });
  }
  for (const g of groups.values()) {
    if (cfg.ai.results.has(g.id)) continue; // answered (or failed): the agents read it below
    const candles = snap.candles?.[g.coin] ?? [];
    if (candles.length < MIN_CANDLES) continue; // the agents skip with "no chart data" below
    g.frames.sort((x, y) => x.roundSeconds - y.roundSeconds);
    aiRequests.push({ ...g, candles: candles.slice(-candlesFor(g.frames[g.frames.length - 1].roundSeconds)) });
  }
}

/**
 * One AI agent's decision for round k of a market, from the coin's shared answer. Returns the decision, or null while the answer is
 * still on its way. The contrarian cannot see the crowd when the AI answers (nobody has called yet), so once it acts the rules of the
 * game apply: with no money on one side it takes that side (a round needs two sides), and its reason then says so in plain numbers.
 */
function decideWithAi(m, k, agent, cfg, ctx) {
  const key = agent.key;
  // things that need no model: no money to call with, or (contrarian) nobody on the round yet
  const s = legalStake(LOGIC[key].BASE_STAKE, ctx);
  if (s.skip) return { action: 'SKIP', reason: s.skip };
  const { up, down } = ctx.bets;
  if (key === LATE && up + down === 0) return LOGIC[key].decide(ctx); // "nobody has bet yet": looked at again next tick
  if (ctx.candles.length < MIN_CANDLES) return { action: 'SKIP', reason: COULDNT_DECIDE, aiFailed: true, detail: 'no chart data' };
  const res = cfg.ai.results.get(batchId(m, k));
  if (!res) return null;
  if (!res.ok) return { action: 'SKIP', reason: COULDNT_DECIDE, aiFailed: true, detail: res.error };
  const view = res.decisions[m.id]?.[key];
  if (!view) return { action: 'SKIP', reason: COULDNT_DECIDE, aiFailed: true, detail: 'missing from the answer' };
  if (key === LATE) {
    const forced = up === 0 ? 'UP' : down === 0 ? 'DOWN' : null;
    if (forced && view.call !== forced) {
      const crowd = opposite(forced);
      return { action: 'BET', side: forced, stake: s.stake, ai: true, rule: true, reason: `All the money is on ${crowd} (${fmtUsdc(crowd === 'UP' ? up : down)}), so I take ${forced}.` };
    }
  }
  return { action: 'BET', side: view.call, stake: s.stake, reason: view.reason, ai: true };
}

function planBet(m, k, agent, cfg, actions, decisions, candles) {
  const round = m.rounds[k];
  const ctx = {
    market: m.name,
    history: historyFor(m, cfg),
    candles: candles?.[m.name.split(' ')[0]] ?? [],
    bets: { up: round ? round.up : 0, down: round ? round.down : 0 },
    minStake: m.minStake,
    balance: Math.max(0, agent.balance - cfg.gasReserve),
    random: cfg.random,
  };
  // the AI plays the markets in cfg.aiMarkets; on any other market the agents (the contrarian) use their plain rule
  const d = cfg.ai && AI_AGENTS.includes(agent.key) && aiHere(m, cfg) ? decideWithAi(m, k, agent, cfg, ctx) : LOGIC[agent.key].decide(ctx);
  if (d === null) return; // the model's answer is not here yet
  // The contrarian's skip is not final when nobody (or an even crowd) is on the round: it is looked at again.
  decisions.push({ id: decisionId(m, k, agent.key), agent: agent.key, market: m.name, marketId: m.id, round: k, decision: d, retry: agent.key === LATE && d.action === 'SKIP' && !d.aiFailed });
  if (d.action !== 'BET') return;
  const stake = Math.min(d.stake, cfg.maxStake);
  if (stake < m.minStake) return;
  if (agent.allowance < stake) actions.push({ type: 'approve', agent: agent.key, amount: cfg.approveAmount });
  actions.push({ type: 'bet', agent: agent.key, market: m.id, marketName: m.name, round: k, side: d.side, stake, reason: d.reason, ai: !!d.ai, rule: !!d.rule });
}

/**
 * Which price (if any) is due for the round that is running now (round k-1) of a market.
 *   'start': no update at or after the lock yet, from lock + startAfter until startGiveUp of the round has passed
 *   'end'  : the round has its start price and the end price is not in yet, from endMargin seconds before the end
 * Also used by the runner to tick faster while a price is due.
 */
/**
 * Matched calls: a caller on the BIGGER side who lost still gets the unmatched part of the stake back at claim.
 * Same maths as the contract: the loser's matched part is ceil(stake * M / T) (M = smaller side, T = bigger side),
 * so what comes back is stake - ceil(stake * M / T). BigInt, because stake * M can pass 2^53. Zero for anyone else.
 */
export function unmatchedBack(r, p) {
  if (r.state !== 'SettledUp' && r.state !== 'SettledDown') return 0n;
  const upWon = r.state === 'SettledUp';
  const stake = BigInt(upWon ? p.down : p.up);
  const U = BigInt(r.up), D = BigInt(r.down);
  const biggerLost = upWon ? D > U : U > D;
  if (stake === 0n || !biggerLost) return 0n;
  const M = U < D ? U : D, T = U > D ? U : D;
  return stake - (stake * M + T - 1n) / T;
}

export function priceDue(m, now, cfg) {
  const k = m.nextRound;
  if (k < 1) return null;
  const lockR = lockTime(m, k - 1);
  const endR = endTime(m, k - 1);
  const updates = m.feed.updates;
  const latest = updates.length ? updates[updates.length - 1] : null;
  if (!latest || latest.updatedAt < lockR) {
    return now >= lockR + cfg.startAfter && now < lockR + m.roundLength * cfg.startGiveUp ? 'start' : null;
  }
  if (now >= endR - cfg.endMargin && now < endR && latest.updatedAt < endR - cfg.endMargin) return 'end';
  return null;
}

/** Seconds to wait before the next look: short while any market is waiting for a start or end price. */
export function tickDelay(snap, cfg) {
  // Look one slow tick (plus a few seconds for reading the chain) ahead, so the first look inside the end window is not late.
  const ahead = cfg.tickSeconds + 5;
  if (snap.markets.some((m) => priceDue(m, snap.now, cfg) || priceDue(m, snap.now + ahead, cfg))) return cfg.fastTickSeconds;
  // the AI agents decide just after a round opens: look often then, so they act within seconds of the opening
  // (an opening is the lock of the round before: the next one is the lock of the round that takes calls now, the last one is when that round opened)
  const around = (o) => snap.now + ahead >= o + cfg.aiAskAfter && snap.now < o + cfg.earlyDelay + cfg.contrarianAfterEarly + 10;
  if (cfg.ai && snap.markets.some((m) => aiHere(m, cfg) && !m.paused && (around(lockTime(m, m.nextRound)) || around(opensAt(m, m.nextRound))))) return cfg.fastTickSeconds;
  return cfg.tickSeconds;
}

export function planTick(snap, cfg, decided = new Set()) {
  const { now } = snap;
  const actions = [];
  const decisions = [];
  const aiRequests = [];
  const pushedNow = new Set(); // markets of one coin share a feed: one price push per feed and kind of price per tick
  const agentByKey = Object.fromEntries(snap.agents.map((a) => [a.key, a]));
  if (cfg.ai) planAiRequests(snap, cfg, decided, aiRequests, agentByKey);

  for (const m of snap.markets) {
    const k = m.nextRound;
    const updates = m.feed.updates;

    // ---- 1. settle rounds that have ended (and still have a chance) ----
    for (let j = Math.max(0, k - lookbackFor(m, cfg)); j < k; j++) {
      const r = m.rounds[j];
      if (!r || r.state !== 'Unsettled' || r.up + r.down === 0) continue;
      const et = endTime(m, j);
      if (now <= et || now > et + cfg.settleWindow) continue;
      const ids = r.up === 0 || r.down === 0
        ? { startId: 0n, endId: 0n } // one-sided: the contract refunds without looking at ids
        : findSettleIds(updates, lockTime(m, j), et);
      actions.push({ type: 'settle', market: m.id, marketName: m.name, round: j, ...ids });
    }

    // ---- 2. prices for the round that is running now (round k-1): real market prices pushed to the TEST feed ----
    const due = priceDue(m, now, cfg);
    if (due && !pushedNow.has(`${m.feed.address ?? 'market' + m.id}:${due}`)) {
      pushedNow.add(`${m.feed.address ?? 'market' + m.id}:${due}`);
      const r = k - 1;
      const where = { market: m.id, marketName: m.name, round: r, feed: m.feed.address };
      if (due === 'start') {
        // First trade whose own time is at least startAfter seconds after the lock (the executor asks Bitfinex for exactly that trade).
        actions.push({ type: 'pushPrice', ...where, why: 'start price', firstTradeAfter: lockTime(m, r) + cfg.startAfter });
      } else {
        actions.push({ type: 'pushPrice', ...where, why: 'end price', endsAt: endTime(m, r) });
      }
    }

    // ---- 3. bets on round k ----
    if (!m.paused) {
      const lockK = lockTime(m, k);
      const hasPosition = (a) => {
        const p = a.positions[posKey(m, k)];
        return !!p && p.up + p.down > 0;
      };
      const finished = (key) => hasPosition(agentByKey[key]) || decided.has(decisionId(m, k, key));
      // The house agents (the three AI agents and the coin flipper) play the markets in cfg.aiMarkets (the free AI allowance and the gas budget are small).
      // On any other market the contrarian only answers money that is not the house agents' own, i.e. a real person's call.
      const aiOn = !cfg.ai || aiHere(m, cfg);
      const early = aiOn ? EARLY : [];
      const lateHere = aiOn || realMoney(m, k, snap.agents) > 0;

      if (now >= opensAt(m, k) + cfg.earlyDelay && now < lockK - cfg.earlyCutoff) {
        for (const key of early) {
          if (!finished(key)) planBet(m, k, agentByKey[key], cfg, actions, decisions, snap.candles);
        }
      }
      // The contrarian goes last: only once every early agent has bet or skipped (in an earlier tick), so it sees their
      // real money, and from shortly after they are due, whatever the round length. It always takes the side with less money.
      if (now >= opensAt(m, k) + cfg.earlyDelay + cfg.contrarianAfterEarly && now < lockK - cfg.contrarianCutoff
          && lateHere && early.every(finished) && !finished(LATE)) {
        planBet(m, k, agentByKey[LATE], cfg, actions, decisions, snap.candles);
      }
    }

    // ---- 4. claims: winnings, refunds, and timed-out rounds ----
    for (const a of snap.agents) {
      for (let j = Math.max(0, k - lookbackFor(m, cfg)); j < k; j++) {
        const p = a.positions[posKey(m, j)];
        const r = m.rounds[j];
        if (!p || !r || p.claimed || p.up + p.down === 0) continue;
        const wins = (r.state === 'SettledUp' && p.up > 0) || (r.state === 'SettledDown' && p.down > 0);
        const refund = r.state === 'Refunded' || (r.state === 'Unsettled' && now > endTime(m, j) + cfg.settleWindow);
        if (wins || refund || unmatchedBack(r, p) > 0n) actions.push({ type: 'claim', agent: a.key, market: m.id, marketName: m.name, round: j });
      }
    }
  }
  // Time-critical work first: price pushes (the start price must be the first trade after the lock), then settles; the sort is stable,
  // so an agent's approval still comes right before its bet.
  const rank = (a) => (a.type === 'pushPrice' ? 0 : a.type === 'settle' ? 1 : 2);
  actions.sort((x, y) => rank(x) - rank(y));
  return { actions, decisions, aiRequests };
}
