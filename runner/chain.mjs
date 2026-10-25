// Reads the chain (read-only) and builds the snapshot that planTick() works from.
// Nothing here sends a transaction.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, usdcBalance, erc20Abi } from '../scripts/lib.mjs';
import { compile } from '../scripts/compile.mjs';
import { CFG } from './config.mjs';
import { lockTime } from './plan.mjs';

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

  return async function readSnapshot() {
    const block = await pub.getBlock();
    const now = Number(block.timestamp);
    const count = Number(await read(A, art.arena.abi, 'marketCount'));
    const markets = [];
    for (let id = 0; id < count; id++) {
      const [feedA, , roundLength, startOffset, minStake, paused] = await read(A, art.arena.abi, 'markets', [BigInt(id)]);
      const name = await read(A, art.arena.abi, 'marketName', [BigInt(id)]);
      const nextRound = Number(await read(A, art.arena.abi, 'nextBettableRound', [BigInt(id)]));
      const m = { id, name, roundLength: Number(roundLength), startOffset: Number(startOffset), minStake: Number(minStake), paused, nextRound, rounds: {}, feed: { address: feedA, updates: [] } };
      const first = Math.max(0, nextRound - CFG.lookback);
      const indexes = Array.from({ length: nextRound - first + 1 }, (_, i) => first + i);
      const rows = await Promise.all(indexes.map((j) => read(A, art.arena.abi, 'rounds', [BigInt(id), BigInt(j)])));
      indexes.forEach((j, i) => {
        const r = rows[i];
        m.rounds[j] = { up: Number(r[0]), down: Number(r[1]), startPrice: r[4], endPrice: r[5], state: STATES[Number(r[6])] };
      });
      m.feed.updates = await feedUpdates(feedA, lockTime(m, first));
      markets.push(m);
    }
    const agents = [];
    for (const a of deployments.circle.agents) {
      const balance = Number((await usdcBalance(pub, usdc, a.address)).raw);
      const allowance = Number(await read(usdc, allowanceAbi, 'allowance', [a.address, A]));
      const positions = {};
      const asks = markets.flatMap((m) =>
        Array.from({ length: m.nextRound - Math.max(0, m.nextRound - CFG.lookback) + 1 }, (_, i) => ({ id: m.id, j: Math.max(0, m.nextRound - CFG.lookback) + i })));
      const rows = await Promise.all(asks.map((q) => read(A, art.arena.abi, 'positions', [BigInt(q.id), BigInt(q.j), a.address])));
      asks.forEach((q, i) => {
        const p = rows[i];
        if (p[0] > 0n || p[1] > 0n) positions[`${q.id}:${q.j}`] = { up: Number(p[0]), down: Number(p[1]), claimed: p[2] };
      });
      agents.push({ key: a.key, name: a.name, address: a.address, walletId: a.walletId, balance, allowance, positions });
    }
    return { now, markets, agents, art };
  };
}
