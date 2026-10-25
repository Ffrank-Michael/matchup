// Turns planned actions into transactions.
//   - agent actions (approve, bet, claim) go through Circle developer-controlled wallets
//   - runner actions (pushPrice, settle) are sent by the deployer wallet (it owns the test feeds)
// DRY-RUN is the default: it prints what it WOULD send and sends nothing.
import { randomUUID } from 'node:crypto';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createWalk } from './priceWalk.mjs';
import { START_PRICES } from './config.mjs';

const usdcText = (u) => '$' + (u / 1e6).toFixed(2);

export function describe(a) {
  switch (a.type) {
    case 'pushPrice': return `runner pushes a test price to the ${a.marketName} feed (${a.why})`;
    case 'settle': return `runner settles ${a.marketName} round ${a.round} (start id ${a.startId}, end id ${a.endId})`;
    case 'approve': return `${a.agent} lets the arena take up to ${usdcText(a.amount)}`;
    case 'bet': return `${a.agent} bets ${a.side} ${usdcText(a.stake)} on ${a.marketName} round ${a.round}: ${a.reason}`;
    case 'claim': return `${a.agent} claims ${a.marketName} round ${a.round}`;
    default: return JSON.stringify(a);
  }
}

export function makeExecutor({ live, env, deployments, pub, wallet, usdc, arenaAbi, feedAbi }) {
  const arena = deployments.arena.arena.address;
  const agentWallets = Object.fromEntries(deployments.circle.agents.map((a) => [a.key, a.walletId]));
  const walks = {};
  const priceFor = (marketName) => (walks[marketName] ||= createWalk(START_PRICES[marketName] ?? 100)).next();
  const feedFor = (marketId) => deployments.arena.feeds[['btc', 'eth', 'sol'][marketId]].address;

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

  async function deployerCall(address, abi, functionName, args) {
    const hash = await wallet.writeContract({ address, abi, functionName, args });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
    return hash;
  }

  return async function execute(a) {
    if (!live) return { dryRun: true };
    switch (a.type) {
      case 'pushPrice': return { tx: await deployerCall(feedFor(a.market), feedAbi, 'setPrice', [priceFor(a.marketName)]) };
      case 'settle': return { tx: await deployerCall(arena, arenaAbi, 'settle', [BigInt(a.market), BigInt(a.round), a.startId, a.endId]) };
      case 'approve': return { tx: await circleCall(a.agent, usdc, 'approve(address,uint256)', [arena, String(a.amount)]) };
      case 'bet': return { tx: await circleCall(a.agent, arena, 'placeBet(uint256,uint256,bool,uint256)', [String(a.market), String(a.round), String(a.side === 'UP'), String(a.stake)]) };
      case 'claim': return { tx: await circleCall(a.agent, arena, 'claim(uint256,uint256)', [String(a.market), String(a.round)]) };
      default: throw new Error('unknown action ' + a.type);
    }
  };
}
