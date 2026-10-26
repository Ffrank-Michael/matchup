// Turns planned actions into transactions.
//   - agent actions (approve, bet, claim) go through Circle developer-controlled wallets
//   - runner actions (pushPrice, settle) are sent by the deployer wallet (it owns the test feeds)
// DRY-RUN is the default: it prints what it WOULD send and sends nothing.
import { randomUUID } from 'node:crypto';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { displayName } from '../agents/index.mjs';
import { createExchangePrices } from './exchangePrices.mjs';
import { appendPriceLog, makePriceLogEntry } from './priceLog.mjs';

const usdcText = (u) => '$' + (u / 1e6).toFixed(2);

export function describe(a) {
  switch (a.type) {
    case 'pushPrice': return `runner pushes the real ${a.marketName} price to its TEST feed (${a.why})`;
    case 'settle': return `runner settles ${a.marketName} round ${a.round} (start id ${a.startId}, end id ${a.endId})`;
    case 'approve': return `${displayName(a.agent)} lets the arena take up to ${usdcText(a.amount)}`;
    case 'bet': return `${displayName(a.agent)} bets ${a.side} ${usdcText(a.stake)} on ${a.marketName} round ${a.round}: ${a.reason}`;
    case 'claim': return `${displayName(a.agent)} claims ${a.marketName} round ${a.round}`;
    default: return JSON.stringify(a);
  }
}

export function makeExecutor({ live, env, deployments, pub, wallet, usdc, arenaAbi, feedAbi, relayAbi, prices, explorer = 'https://explorer.testnet.arc.io', chainId = 5042002, logPush = appendPriceLog }) {
  const arena = deployments.arena.arena.address;
  const agentWallets = Object.fromEntries(deployments.circle.agents.map((a) => [a.key, a.walletId]));
  prices ||= createExchangePrices();
  const usd = (p) => '$' + (Number(p) / 1e8).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const quoteText = (q) => (q.quotedAt ? `${q.source ?? 'exchange'} last trade at ${new Date((q.tradeAt ?? q.quotedAt) * 1000).toISOString().slice(11, 19)} UTC, asked at ${new Date(q.quotedAt * 1000).toISOString().slice(11, 19)} UTC` : `${q.source ?? 'exchange'} quote (no time given)`);
  // The feed to push to is the one the market uses (the planner reads it from the chain). In the testnet rehearsal each coin's
  // stand-in for Chainlink (deployments.arena.guards) is pushed the same price first, so the relay's guard never goes stale.
  const feedFor = (a) => a.feed ?? deployments.arena.feeds[['btc', 'eth', 'sol'][a.market]].address;
  const standInFor = (a) => deployments.arena.guards?.[a.marketName.split(' ')[0].slice(0, 3).toLowerCase()]?.kind === 'test stand-in'
    ? deployments.arena.guards[a.marketName.split(' ')[0].slice(0, 3).toLowerCase()].address : null;

  let circle;
  const circleClient = () => (circle ||= initiateDeveloperControlledWalletsClient({ apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET }));

  /** One Circle contract call; waits until Circle reports a final state. */
  async function circleCall(agentKey, contractAddress, abiFunctionSignature, abiParameters) {
    const c = circleClient();
    const res = await c.createContractExecutionTransaction({
      walletId: agentWallets[agentKey], contractAddress, abiFunctionSignature, abiParameters,
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } }, idempotencyKey: randomUUID(),
    });
    const id = res.data?.id;
    if (!id) throw new Error('Circle did not return a transaction id');
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const t = (await c.getTransaction({ id })).data?.transaction;
      if (t?.state === 'COMPLETE') return t.txHash;
      if (['FAILED', 'DENIED', 'CANCELLED'].includes(t?.state)) throw new Error(`Circle transaction ${t.state}: ${t.errorReason || ''}`);
    }
    throw new Error('Circle transaction still pending after 2 minutes');
  }

  async function deployerSend(address, abi, functionName, args) {
    const hash = await wallet.writeContract({ address, abi, functionName, args });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
    return { hash, rc };
  }
  const deployerCall = async (...a) => (await deployerSend(...a)).hash;

  return async function execute(a) {
    if (!live) {
      if (a.type !== 'pushPrice') return { dryRun: true };
      const q = await prices.quote(a.marketName, { firstTradeAfter: a.firstTradeAfter });
      return { dryRun: true, note: `would push the real price ${usd(q.price)}, ${quoteText(q)}, to the TEST feed` };
    }
    switch (a.type) {
      case 'pushPrice': {
        const q = await prices.quote(a.marketName, { firstTradeAfter: a.firstTradeAfter }); // throws if the API fails or there is no trade after the lock yet: then nothing is pushed
        const feed = feedFor(a);
        const standIn = standInFor(a);
        if (standIn) await deployerSend(standIn, feedAbi, 'setPrice', [q.price]);
        const { hash, rc } = await deployerSend(feed, relayAbi ?? feedAbi, 'setPrice', [q.price]);
        let note = `real price ${usd(q.price)}, ${quoteText(q)}, pushed to the TEST feed`;
        try { // the price is already on chain; a log problem must be loud but must not look like a failed push
          const block = await pub.getBlock({ blockNumber: rc.blockNumber });
          logPush(makePriceLogEntry({ action: a, quote: q, txHash: hash, blockNumber: rc.blockNumber, blockTimestamp: block.timestamp, feed, explorer, chainId }));
        } catch (e) { note += `
         WARNING: the price is on chain but could not be written to the price log: ${e.message}`; }
        return { tx: hash, note };
      }
      case 'settle': return { tx: await deployerCall(arena, arenaAbi, 'settle', [BigInt(a.market), BigInt(a.round), a.startId, a.endId]) };
      case 'approve': return { tx: await circleCall(a.agent, usdc, 'approve(address,uint256)', [arena, String(a.amount)]) };
      case 'bet': return { tx: await circleCall(a.agent, arena, 'placeBet(uint256,uint256,bool,uint256)', [String(a.market), String(a.round), String(a.side === 'UP'), String(a.stake)]) };
      case 'claim': return { tx: await circleCall(a.agent, arena, 'claim(uint256,uint256)', [String(a.market), String(a.round)]) };
      default: throw new Error('unknown action ' + a.type);
    }
  };
}
