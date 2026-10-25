// Turns planned actions into transactions.
//   - agent actions (approve, bet, claim) go through Circle developer-controlled wallets
//   - runner actions (pushPrice, settle) are sent by the deployer wallet (it owns the test feeds)
// DRY-RUN is the default: it prints what it WOULD send and sends nothing.
import { randomUUID } from 'node:crypto';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { displayName } from '../agents/index.mjs';
import { createRealPrices } from './realPrices.mjs';

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

export function makeExecutor({ live, env, deployments, pub, wallet, usdc, arenaAbi, feedAbi, prices }) {
  const arena = deployments.arena.arena.address;
  const agentWallets = Object.fromEntries(deployments.circle.agents.map((a) => [a.key, a.walletId]));
  prices ||= createRealPrices({ apiKey: env.COINGECKO_API_KEY || undefined });
  const usd = (p) => '$' + (Number(p) / 1e8).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    if (!live) return a.type === 'pushPrice' ? { dryRun: true, note: `would push the real price ${usd(await prices.price(a.marketName))} (CoinGecko) to the TEST feed` } : { dryRun: true };
    switch (a.type) {
      case 'pushPrice': {
        const price = await prices.price(a.marketName); // throws if the API fails: then nothing is pushed
        return { tx: await deployerCall(feedFor(a.market), feedAbi, 'setPrice', [price]), note: `real price ${usd(price)} (CoinGecko) pushed to the TEST feed` };
      }
      case 'settle': return { tx: await deployerCall(arena, arenaAbi, 'settle', [BigInt(a.market), BigInt(a.round), a.startId, a.endId]) };
      case 'approve': return { tx: await circleCall(a.agent, usdc, 'approve(address,uint256)', [arena, String(a.amount)]) };
      case 'bet': return { tx: await circleCall(a.agent, arena, 'placeBet(uint256,uint256,bool,uint256)', [String(a.market), String(a.round), String(a.side === 'UP'), String(a.stake)]) };
      case 'claim': return { tx: await circleCall(a.agent, arena, 'claim(uint256,uint256)', [String(a.market), String(a.round)]) };
      default: throw new Error('unknown action ' + a.type);
    }
  };
}
