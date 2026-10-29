// Reads the chain (read-only) and builds the snapshot that planTick() works from.
// Nothing here sends a transaction.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, usdcBalance, erc20Abi } from '../scripts/lib.mjs';
import { compile } from '../scripts/compile.mjs';
import { CFG } from './config.mjs';
import { lockTime, lookbackFor } from './plan.mjs';

const STATES = ['Unsettled', 'SettledUp', 'SettledDown', 'Refunded'];
const allowanceAbi = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

export function loadDeployments() {
  const read = (f) => {
    const p = path.join(ROOT, 'deployments', f);
    if (!fs.existsSync(p)) throw new Error(`Missing deployments/${f}. ${f === 'arc-testnet.json' ? 'Deploy the contracts first.' : 'Create the agent wallets first.'}`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  };
  const arena = read('arc-testnet.json');
  const circle = read('circle-testnet.json');
  if (!circle.agents || circle.agents.length !== 4) throw new Error('deployments/circle-testnet.json has no four agent wallets.');
  return { arena, circle };
}

export function makeReader({ pub, usdc, deployments }) {
  const art = compile();
  const A = deployments.arena.arena.address;
  const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

  // A price goes in about every minute, so the feed is remembered between passes and only the
  // newest updates are fetched. Updates never change once written, so remembering them is safe.
  const feedCache = {};
  async function feedUpdates(feedAddress, oldestNeeded) {
    let latest;
    try { latest = await read(feedAddress, art.feed.abi, 'latestRoundData'); } catch { return []; } // no price yet
    const cached = feedCache[feedAddress] || [];
    const lastKnown = cached.length ? cached[cached.length - 1].id : null;
    let [id, answer, , updatedAt] = latest;
    const fresh = [];
    let joined = false; // did the walk back reach what we already remembered?
    for (let i = 0; i < 500; i++) {
      if (lastKnown !== null && id <= lastKnown) { joined = true; break; }
      fresh.unshift({ id, updatedAt: Number(updatedAt), price: answer });
      if (Number(updatedAt) < oldestNeeded || (id & 0xffffffffffffffffn) <= 1n) break; // went back far enough, or reached the first update
      try { [id, answer, , updatedAt] = await read(feedAddress, art.feed.abi, 'getRoundData', [id - 1n]); } catch { break; }
    }
    let all = joined ? cached.concat(fresh) : fresh;
    // keep everything from the newest update that is older than we need (the contract looks one back too)
    let keepFrom = 0;
    for (let i = 0; i < all.length; i++) if (all[i].updatedAt < oldestNeeded) keepFrom = i;
    all = all.slice(keepFrom);
    feedCache[feedAddress] = all;
    return all;
  }

  // Reading one round at a time (hundreds of requests per pass) trips the public RPC's rate limit once passes come every
  // 3 seconds, so each pass asks Multicall3 (the standard contract at the same address on every chain) for many reads at once.
  const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
  const batch = (contracts) => pub.multicall({ contracts, allowFailure: false, multicallAddress: MULTICALL3, batchSize: 60_000 });
  const arenaCall = (functionName, args = []) => ({ address: A, abi: art.arena.abi, functionName, args });

  return async function readSnapshot() {
    const [block, marketCount] = await Promise.all([pub.getBlock(), read(A, art.arena.abi, 'marketCount')]);
    const now = Number(block.timestamp);
    const count = Number(marketCount);
    const ids = Array.from({ length: count }, (_, i) => i);

    // 1. every market's settings, name and next callable round
    const head = await batch(ids.flatMap((id) => [arenaCall('markets', [BigInt(id)]), arenaCall('marketName', [BigInt(id)]), arenaCall('nextCallableRound', [BigInt(id)])]));
    const markets = ids.map((id) => {
      const [feedA, , roundLength, startOffset, minStake, paused] = head[id * 3];
      return { id, name: head[id * 3 + 1], roundLength: Number(roundLength), startOffset: Number(startOffset), minStake: Number(minStake), paused, nextRound: Number(head[id * 3 + 2]), rounds: {}, feed: { address: feedA, updates: [] } };
    });
    for (const m of markets) {
      const first = Math.max(0, m.nextRound - lookbackFor(m, CFG));
      m.indexes = Array.from({ length: m.nextRound - first + 1 }, (_, i) => first + i);
      m.firstRound = first;
    }

    // 2. all rounds, and every agent's balance, allowance and positions, in one go
    const roundAsks = markets.flatMap((m) => m.indexes.map((j) => arenaCall('rounds', [BigInt(m.id), BigInt(j)])));
    const agentsIn = deployments.circle.agents;
    const posAsks = markets.flatMap((m) => m.indexes.map((j) => ({ id: m.id, j })));
    const agentAsks = agentsIn.flatMap((a) => [
      { address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [a.address] },
      { address: usdc, abi: allowanceAbi, functionName: 'allowance', args: [a.address, A] },
      ...posAsks.map((q) => arenaCall('positions', [BigInt(q.id), BigInt(q.j), a.address])),
    ]);
    const out = await batch([...roundAsks, ...agentAsks]);

    let at = 0;
    for (const m of markets) {
      for (const j of m.indexes) {
        const r = out[at++];
        m.rounds[j] = { up: Number(r[0]), down: Number(r[1]), startPrice: r[4], endPrice: r[5], state: STATES[Number(r[6])] };
      }
    }

    // 3. the price feeds: markets of one coin share a feed, so it is read once, back to the oldest time any of them needs
    const oldest = {};
    for (const m of markets) oldest[m.feed.address] = Math.min(oldest[m.feed.address] ?? Infinity, lockTime(m, m.firstRound));
    const updatesOf = {};
    await Promise.all(Object.entries(oldest).map(async ([address, from]) => { updatesOf[address] = await feedUpdates(address, from); }));
    for (const m of markets) m.feed.updates = updatesOf[m.feed.address];

    const agents = agentsIn.map((a) => {
      const balance = Number(out[at++]);
      const allowance = Number(out[at++]);
      const positions = {};
      for (const q of posAsks) {
        const p = out[at++];
        if (p[0] > 0n || p[1] > 0n) positions[`${q.id}:${q.j}`] = { up: Number(p[0]), down: Number(p[1]), claimed: p[2] };
      }
      return { key: a.key, name: a.name, address: a.address, walletId: a.walletId, balance, allowance, positions };
    });
    for (const m of markets) { delete m.indexes; delete m.firstRound; }
    return { now, markets, agents, art };
  };
}
