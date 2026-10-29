// Helpers for the MAINNET round runner (runner/run-mainnet.mjs). Real USDC is at stake here, so everything that decides
// "may this send a transaction?" lives in this file, small and tested (runner/mainnet.test.mjs).
//
//   - the runner reads only the names in RUNNER_ENV_NAMES from .env: its own key and the arena address, plus the Gemini and Upstash
//     settings of the guide calls (no money, nothing on chain), never the deployer key
//   - nothing is sent unless --i-understand-this-spends-real-usdc is given; without it the executor only logs what it would do
//   - a price is checked against Chainlink off chain first (the same band the relay enforces), so a bad price never costs gas
// Nothing in here prints a key: error messages name the setting, never its value.
import path from 'node:path';
import { getAddress, isAddress } from 'viem';
import { ROOT, parseEnv } from '../scripts/lib.mjs';
import { createExchangePrices } from './exchangePrices.mjs';
import { appendPriceLog, makePriceLogEntry } from './priceLog.mjs';

export const MAINNET_CHAIN_ID = 5042;
export const SEND_FLAG = '--i-understand-this-spends-real-usdc';
export const MAINNET_PRICE_LOG_FILE = path.join(ROOT, 'data', 'price-log-mainnet.jsonl');
export const MIN_RUNNER_BALANCE = 100_000_000_000_000_000n; // 0.10 USDC in the 18-decimal native view: below this a live runner stops (the supervisor alerts)

/** The only settings the mainnet runner takes from .env. Everything else in the file is ignored, so no other key is ever held. */
export const RUNNER_ENV_NAMES = [
  'MAINNET_RUNNER_PRIVATE_KEY', 'MAINNET_ARENA_ADDRESS', 'ARC_MAINNET_RPC_URL', 'USDC_ADDRESS',
  // the guide calls (runner/guide.mjs): the key for the AI models (which model each agent uses is in the code) and the place the website reads the calls from
  'GEMINI_API_KEY',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
];
export const readRunnerEnv = (text) => {
  const all = parseEnv(text);
  return Object.fromEntries(RUNNER_ENV_NAMES.filter((n) => all[n]).map((n) => [n, all[n]]));
};

/** { live, error } from the command line. Only the long flag sends; the testnet runner's --live is refused so nobody mixes the two up. */
export function parseArgs(argv) {
  if (argv.includes('--live')) return { live: false, error: `--live is the testnet runner's flag. The mainnet runner sends only with ${SEND_FLAG}.` };
  return { live: argv.includes(SEND_FLAG), once: argv.includes('--once'), error: null };
}

/** The runner's settings from the (already filtered) env: { key, arena, rpc, usdc, problems }. Problems say what to fix, never a value. */
export function parseRunnerConfig(env) {
  const problems = [];
  const key = env.MAINNET_RUNNER_PRIVATE_KEY || '';
  if (!key) problems.push('MAINNET_RUNNER_PRIVATE_KEY is missing in .env. The mainnet runner needs its own wallet key.');
  else if (!/^0x[0-9a-fA-F]{64}$/.test(key)) problems.push('MAINNET_RUNNER_PRIVATE_KEY in .env is not 0x + 64 hex characters.');
  const arenaText = env.MAINNET_ARENA_ADDRESS || '';
  const arenaOk = isAddress(arenaText, { strict: false });
  if (!arenaText) problems.push('MAINNET_ARENA_ADDRESS is missing in .env (the address of the mainnet PredictionArena contract).');
  else if (!arenaOk) problems.push('MAINNET_ARENA_ADDRESS in .env is not an address (0x + 40 hex characters).');
  return {
    key, problems,
    arena: arenaOk ? getAddress(arenaText.toLowerCase()) : null,
    rpc: env.ARC_MAINNET_RPC_URL || '',
    usdc: env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000',
  };
}

/**
 * The relay's own test (GuardedRelayFeed.setPrice), in the same integer maths, run off chain before anything is sent.
 * price and guardAnswer are the 8-decimal numbers; guardUpdatedAt and now are unix seconds. Returns { ok, reason, deviationBps }.
 */
export function checkAgainstGuard({ price, guardAnswer, guardUpdatedAt, bandBps, maxAgeSeconds, now }) {
  const p = BigInt(price), g = BigInt(guardAnswer), at = BigInt(guardUpdatedAt);
  if (p <= 0n) return { ok: false, reason: 'the price is not positive' };
  if (g <= 0n || at === 0n || g > (1n << 128n) - 1n) return { ok: false, reason: 'Chainlink has no usable answer' };
  if (at > BigInt(now) || BigInt(now) - at > BigInt(maxAgeSeconds)) return { ok: false, reason: `Chainlink's last update is too old (${Math.round((now - Number(at)) / 3600)} h; the relay accepts up to ${Math.round(maxAgeSeconds / 3600)} h)` };
  const diff = p > g ? p - g : g - p;
  const deviationBps = Number((diff * 1_000_000n) / g) / 100;
  if (diff > (g * BigInt(bandBps)) / 10_000n) return { ok: false, reason: `the Bitfinex price is ${deviationBps / 100}% away from Chainlink; the relay accepts at most ${bandBps / 100}%`, deviationBps };
  return { ok: true, reason: '', deviationBps };
}

const usd = (p) => '$' + (Number(p) / 1e8).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quoteText = (q) => (q.quotedAt ? `${q.source ?? 'exchange'} last trade at ${new Date((q.tradeAt ?? q.quotedAt) * 1000).toISOString().slice(11, 19)} UTC` : `${q.source ?? 'exchange'} quote`);

export function describe(a) {
  switch (a.type) {
    case 'pushPrice': return `runner pushes the ${a.marketName.split(' ')[0]} ${a.why} (round ${a.round} of ${a.marketName}) to the relay feed`;
    case 'settle': return `runner settles ${a.marketName} round ${a.round} (start id ${a.startId}, end id ${a.endId})`;
    default: return JSON.stringify(a);
  }
}

/**
 * Turns the planned actions (price pushes and settles only) into transactions.
 * live false (the default): nothing is sent, and `wallet` may be null; it only logs what it would do.
 * Before a price is sent it is checked against Chainlink; a price outside the relay's band is not sent.
 */
export function makeMainnetExecutor({ live, pub, wallet, arena, arenaAbi, relayAbi, guardAbi, prices, explorer, chainId, logPush = (e) => appendPriceLog(e, MAINNET_PRICE_LOG_FILE), nowSec = () => Math.floor(Date.now() / 1000) }) {
  if (live && !wallet) throw new Error('live mode needs a wallet');
  prices ||= createExchangePrices();
  const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
  const relays = {}; // feed address -> { guard, bandBps, maxAge }: set at deploy and never changed, so read once
  async function relayOf(feed) {
    if (!relays[feed]) {
      const [guard, bandBps, maxAge] = await Promise.all([read(feed, relayAbi, 'guard'), read(feed, relayAbi, 'bandBps'), read(feed, relayAbi, 'MAX_GUARD_AGE')]);
      relays[feed] = { guard, bandBps: Number(bandBps), maxAge: Number(maxAge) };
    }
    return relays[feed];
  }

  /** Asks Bitfinex for the price and checks it against Chainlink. Throws (so nothing is sent) when either fails. */
  async function checkedQuote(a) {
    const q = await prices.quote(a.marketName, { firstTradeAfter: a.firstTradeAfter }); // throws when the API fails or there is no trade after the lock yet
    const r = await relayOf(a.feed);
    const [, answer, , updatedAt] = await read(r.guard, guardAbi, 'latestRoundData');
    const res = checkAgainstGuard({ price: q.price, guardAnswer: answer, guardUpdatedAt: updatedAt, bandBps: r.bandBps, maxAgeSeconds: r.maxAge, now: nowSec() });
    if (!res.ok) throw new Error(`price not sent: ${res.reason}`);
    return { q, guardAnswer: answer, res, r };
  }

  async function send(address, abi, functionName, args) {
    const hash = await wallet.writeContract({ address, abi, functionName, args }); // viem asks the node to estimate first: a call that would revert is not sent
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
    return { hash, rc };
  }

  return async function execute(a) {
    if (a.type !== 'pushPrice' && a.type !== 'settle') throw new Error('unknown action ' + a.type);
    if (a.type === 'settle') {
      if (!live) return { dryRun: true };
      const { hash } = await send(arena, arenaAbi, 'settle', [BigInt(a.market), BigInt(a.round), a.startId, a.endId]);
      return { tx: hash };
    }
    const { q, guardAnswer, res } = await checkedQuote(a);
    let note = `${quoteText(q)}: ${usd(q.price)}, Chainlink ${usd(guardAnswer)}, ${(res.deviationBps / 100).toFixed(2)}% apart (limit ${(await relayOf(a.feed)).bandBps / 100}%)`;
    if (!live) return { dryRun: true, note: `would push ${note}` };
    const { hash, rc } = await send(a.feed, relayAbi, 'setPrice', [q.price]);
    try { // the price is already on chain; a log problem must be loud but must not look like a failed push
      const block = await pub.getBlock({ blockNumber: rc.blockNumber });
      if (a.endsAt) {
        const spare = a.endsAt - Number(block.timestamp);
        note += `\n         end price landed ${spare} s before the round ends${spare < 30 ? ' (LESS THAN 30 s: too close)' : ''}`;
      }
      logPush(makePriceLogEntry({ action: a, quote: q, txHash: hash, blockNumber: rc.blockNumber, blockTimestamp: block.timestamp, feed: a.feed, explorer, chainId, label: 'Bitfinex last trade, checked against Chainlink' }));
    } catch (e) { note += `\n         WARNING: the price is on chain but could not be written to the price log: ${e.message}`; }
    return { tx: hash, note };
  };
}

/** The problem with the node's chain, or null when it is Arc mainnet. Run before anything else is read. */
export async function chainProblem(pub) {
  const chainId = await pub.getChainId();
  return chainId === MAINNET_CHAIN_ID ? null : `the RPC is chain ${chainId}, not Arc mainnet (${MAINNET_CHAIN_ID})`;
}

/**
 * Checks everything that must be true before the runner may run, reading the chain only. Returns the problems (empty = fine):
 * the node is Arc mainnet, the arena exists, the runner is not the arena's owner, and the runner is the pusher of every feed it will push to.
 */
export async function preflight({ pub, arena, arenaAbi, relayAbi, runner, feeds }) {
  const problems = [];
  const wrongChain = await chainProblem(pub);
  if (wrongChain) return [wrongChain];
  const code = await pub.getCode({ address: arena });
  if (!code || code === '0x') return [`no contract at MAINNET_ARENA_ADDRESS (${arena}) on Arc mainnet`];
  const owner = await pub.readContract({ address: arena, abi: arenaAbi, functionName: 'owner' });
  if (getAddress(owner) === getAddress(runner)) problems.push('the runner wallet is also the arena owner; the runner must be its own wallet');
  for (const feed of feeds) {
    try {
      const pusher = await pub.readContract({ address: feed, abi: relayAbi, functionName: 'pusher' });
      if (getAddress(pusher) !== getAddress(runner)) problems.push(`the runner (${runner}) is not the pusher of feed ${feed} (it is ${pusher}); its prices would be refused`);
    } catch { problems.push(`feed ${feed} does not answer pusher(): it is not a Matchup relay`); }
  }
  return problems;
}
