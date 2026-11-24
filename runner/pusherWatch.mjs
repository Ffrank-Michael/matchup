// Watches the relay feeds for a change of pusher (docs/AUDIT_RATIO_PART1.md, R-02).
//
// The relay owner can hand the pusher role to any address at once (GuardedRelayFeed.setPusher), and whoever is the pusher
// decides the results inside the band. So every PusherChanged event on a relay the runner pushes to is an ALERT, even an
// expected one (the owner rotating the runner key): a phone push via ntfy (NTFY_TOPIC in .env) and a line in the log.
//
// Two checks, at most once a minute:
//   1. PusherChanged logs since the last block checked (on start: the last START_LOOKBACK_BLOCKS blocks), read in chunks
//      of at most MAX_LOG_RANGE blocks. A chunk that fails is read again next time, so nothing is skipped.
//   2. pusher() of every relay against the runner's own address, so a change made while the runner was down (older than
//      the lookback) is still noticed. One alert per relay until it is the runner again.
// The watch never stops the runner: a problem reading the chain is logged and tried again on the next check.
// Nothing secret is ever sent: only addresses, block numbers and transaction hashes, which are public on chain.
import { getAddress, parseAbiItem } from 'viem';

export const PUSHER_CHANGED = parseAbiItem('event PusherChanged(address indexed oldPusher, address indexed newPusher)');
export const PUSHER_ABI = [{ type: 'function', name: 'pusher', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];
export const CHECK_EVERY_MS = 60_000;
export const MAX_LOG_RANGE = 2_000n;
export const START_LOOKBACK_BLOCKS = 2_000n;

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The alert text for one PusherChanged log. Pure, so it can be tested. */
export function pusherChangedMessage(log, runner, names = {}) {
  const feed = getAddress(log.address);
  const { oldPusher, newPusher } = log.args;
  const toRunner = getAddress(newPusher) === getAddress(runner);
  return {
    title: 'Matchup: relay pusher changed',
    message: `${names[feed] || 'Relay'} ${feed}: pusher ${oldPusher} -> ${newPusher}${toRunner ? ' (this runner)' : ' (NOT this runner)'}`
      + ` at block ${log.blockNumber}, tx ${log.transactionHash}. If you did not do this, pause the relay's markets (setMarketPaused) and check the owner key.`,
  };
}

/**
 * createPusherWatch({ pub, runner, alert, log, names, now }) -> check(feeds)
 *   pub     a viem public client (getBlockNumber, getLogs, readContract)
 *   runner  the address that should be the pusher of every feed
 *   alert   async (title, message) => sends the phone push (never throws)
 *   log     (line) => writes the runner log
 *   names   optional { feedAddress: 'ETH/BTC relay' } for readable alerts
 * check(feeds, names?) does nothing if it ran less than CHECK_EVERY_MS ago; it returns the alerts it sent (for tests).
 */
export function createPusherWatch({ pub, runner, alert, log = () => {}, names = {}, now = () => Date.now() }) {
  let nextBlock = null;          // the first block not read yet
  let lastCheck = -Infinity;
  const seen = new Set();        // `${tx}:${logIndex}` already alerted
  const notRunner = new Set();   // feeds whose pusher() is someone else, already alerted

  async function send(a, sent) {
    log(`ALERT: ${a.title}: ${a.message}`);
    await alert(a.title, a.message);
    sent.push(a);
  }

  return async function check(feedList, givenNames = names) {
    const sent = [];
    const nameMap = Object.fromEntries(Object.entries(givenNames).map(([k, v]) => [getAddress(k), v])); // any address case
    if (now() - lastCheck < CHECK_EVERY_MS) return sent;
    lastCheck = now();
    const feeds = [...new Set(feedList.map((f) => getAddress(f)))];
    if (!feeds.length) return sent;

    try {
      const latest = await pub.getBlockNumber();
      if (nextBlock === null) nextBlock = latest > START_LOOKBACK_BLOCKS ? latest - START_LOOKBACK_BLOCKS : 0n;
      while (nextBlock <= latest) {
        const to = nextBlock + MAX_LOG_RANGE - 1n < latest ? nextBlock + MAX_LOG_RANGE - 1n : latest;
        const logs = await pub.getLogs({ address: feeds, event: PUSHER_CHANGED, fromBlock: nextBlock, toBlock: to });
        for (const l of logs) {
          const key = `${l.transactionHash}:${l.logIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await send(pusherChangedMessage(l, runner, nameMap), sent);
        }
        nextBlock = to + 1n; // only after the chunk was read: a failed chunk is read again next time
      }
    } catch (e) {
      log(`pusher watch: could not read PusherChanged logs (${String(e.shortMessage || e.message).slice(0, 120)}); trying again in a minute`);
    }

    for (const feed of feeds) {
      let pusher;
      try { pusher = await pub.readContract({ address: feed, abi: PUSHER_ABI, functionName: 'pusher' }); } catch { continue; } // not a relay, or the node is down
      if (getAddress(pusher) === getAddress(runner)) { notRunner.delete(feed); continue; }
      if (notRunner.has(feed)) continue;
      notRunner.add(feed);
      await send({
        title: 'Matchup: runner is not the pusher',
        message: `${nameMap[feed] || 'Relay'} ${feed}: pusher() is ${pusher}, not this runner (${short(getAddress(runner))}). Its price pushes will be refused, and that address now decides the results inside the band.`,
      }, sent);
    }
    return sent;
  };
}
