// Watches the relays and the arena for changes of who controls the prices (audit part 1 R-02; part 2 P2-06).
//
// The relay owner can hand the pusher role to any address at once (GuardedRelayFeed.setPusher), and whoever is the pusher
// decides the results inside the band. So every one of these is an ALERT, even an expected one (a planned key change): a
// phone push via ntfy (NTFY_TOPIC in .env) and a line in the log.
//   on every relay:  PusherChanged, OwnershipTransferStarted, OwnershipTransferred
//   on the arena:    OwnershipTransferStarted, OwnershipTransferred, MarketCreated, MarketPausedChanged
//
// Three checks, at most once a minute:
//   1. Those events since the last block checked, read in chunks of at most MAX_LOG_RANGE blocks. A chunk that fails is read
//      again next time (nothing is skipped); a failure also halves the chunk size (down to MIN_LOG_RANGE), in case the node
//      refuses big ranges. The last block checked is saved in a small file (data/pusher-watch-mainnet.json), so a restart
//      goes on from there and does not alert old events again; with no file it starts START_LOOKBACK_BLOCKS back.
//   2. pusher() of every relay against the runner's own address, so a change made while the runner was down is still
//      noticed. One alert per relay until it is the runner again.
//   3. If the events cannot be read for more than READ_FAIL_ALERT_MS, that is an alert too ("the watch is blind"), repeated
//      at most once an hour while it lasts.
// The watch never stops the runner: a problem is logged and tried again on the next check.
// Nothing secret is ever sent: only addresses, block numbers, market ids and transaction hashes, which are public on chain.
import fs from 'node:fs';
import path from 'node:path';
import { getAddress, parseAbiItem } from 'viem';

export const PUSHER_CHANGED = parseAbiItem('event PusherChanged(address indexed oldPusher, address indexed newPusher)');
export const OWNERSHIP_STARTED = parseAbiItem('event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)');
export const OWNERSHIP_TRANSFERRED = parseAbiItem('event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)');
export const MARKET_CREATED = parseAbiItem('event MarketCreated(uint256 indexed marketId, string name, address indexed feedA, address feedB, uint32 roundLength, uint32 startOffset, uint128 minStake)');
export const MARKET_PAUSED = parseAbiItem('event MarketPausedChanged(uint256 indexed marketId, bool paused)');
export const WATCHED_EVENTS = [PUSHER_CHANGED, OWNERSHIP_STARTED, OWNERSHIP_TRANSFERRED, MARKET_CREATED, MARKET_PAUSED];
export const PUSHER_ABI = [{ type: 'function', name: 'pusher', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];
export const CHECK_EVERY_MS = 60_000;
export const MAX_LOG_RANGE = 2_000n;
export const MIN_LOG_RANGE = 100n;
export const START_LOOKBACK_BLOCKS = 2_000n;
export const READ_FAIL_ALERT_MS = 5 * 60_000;
export const READ_FAIL_REPEAT_MS = 60 * 60_000;

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const IF_NOT_YOU = 'If you did not do this, the owner key may be in someone else\'s hands: pause the markets (setMarketPaused) and follow docs/RUNBOOK.md, section 2.';

/** The alert for one watched event. Pure, so it can be tested. `arena` is the arena's address (to tell it from a relay). */
export function eventAlert(log, runner, { names = {}, arena = null } = {}) {
  const at = getAddress(log.address);
  const isArena = arena && at === getAddress(arena);
  const who = isArena ? `Arena ${at}` : `${names[at] || 'Relay'} ${at}`;
  const where = `at block ${log.blockNumber}, tx ${log.transactionHash}`;
  const a = log.args ?? {};
  switch (log.eventName) {
    case 'PusherChanged': {
      const toRunner = getAddress(a.newPusher) === getAddress(runner);
      return { title: 'Matchup: relay pusher changed', message: `${who}: pusher ${a.oldPusher} -> ${a.newPusher}${toRunner ? ' (this runner)' : ' (NOT this runner)'} ${where}. ${IF_NOT_YOU}` };
    }
    case 'OwnershipTransferStarted':
      return { title: 'Matchup: ownership transfer started', message: `${who}: owner ${a.previousOwner} proposed ${a.newOwner} as the new owner ${where}. It takes effect when that address accepts. ${IF_NOT_YOU}` };
    case 'OwnershipTransferred':
      return { title: 'Matchup: owner changed', message: `${who}: owner ${a.previousOwner} -> ${a.newOwner} ${where}. ${IF_NOT_YOU}` };
    case 'MarketCreated':
      return { title: 'Matchup: market created', message: `${who}: new market ${a.marketId} "${a.name}" on feed ${a.feedA} ${where}. ${IF_NOT_YOU}` };
    case 'MarketPausedChanged':
      return { title: a.paused ? 'Matchup: market paused' : 'Matchup: market unpaused', message: `${who}: market ${a.marketId} ${a.paused ? 'paused' : 'unpaused'} ${where}.` };
    default:
      return { title: 'Matchup: contract event', message: `${who}: ${log.eventName} ${where}.` };
  }
}

/** Kept for older callers and tests: the alert for one PusherChanged log. */
export const pusherChangedMessage = (log, runner, names = {}) => eventAlert({ ...log, eventName: 'PusherChanged' }, runner, { names });

/** The last block checked, from a small JSON file; null when there is none (or it cannot be read). */
function loadBlock(file) {
  if (!file) return null;
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return typeof v.nextBlock === 'string' ? BigInt(v.nextBlock) : null; } catch { return null; }
}
function saveBlock(file, nextBlock, log) {
  if (!file) return;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ nextBlock: String(nextBlock), savedAt: new Date().toISOString() }) + '\n'); }
  catch (e) { log(`pusher watch: could not save its place (${String(e.message).slice(0, 80)}); a restart may alert recent events again`); }
}

/**
 * createPusherWatch({ pub, runner, arena, alert, log, names, now, stateFile }) -> check(feeds, names?)
 *   pub        a viem public client (getBlockNumber, getLogs, readContract)
 *   runner     the address that should be the pusher of every relay
 *   arena      the arena's address (its ownership and market events are watched too); optional
 *   alert      async (title, message) => sends the phone push (never throws)
 *   log        (line) => writes the runner log
 *   stateFile  where the last block checked is kept between runs (none: start START_LOOKBACK_BLOCKS back every time)
 * check() does nothing if it ran less than CHECK_EVERY_MS ago; it returns the alerts it sent (for tests).
 */
export function createPusherWatch({ pub, runner, arena = null, alert, log = () => {}, names = {}, now = () => Date.now(), stateFile = null }) {
  let nextBlock = loadBlock(stateFile); // the first block not read yet
  let range = MAX_LOG_RANGE;
  let lastCheck = -Infinity;
  let failingSince = null;      // when reading the events started failing (ms), or null
  let lastBlindAlert = -Infinity;
  const seen = new Set();       // `${tx}:${logIndex}` already alerted (within this run)
  const notRunner = new Set();  // relays whose pusher() is someone else, already alerted

  async function send(a, sent) {
    log(`ALERT: ${a.title}: ${a.message}`);
    await alert(a.title, a.message);
    sent.push(a);
  }

  return async function check(feedList, givenNames = names) {
    const sent = [];
    if (now() - lastCheck < CHECK_EVERY_MS) return sent;
    lastCheck = now();
    const nameMap = Object.fromEntries(Object.entries(givenNames).map(([k, v]) => [getAddress(k), v])); // any address case
    const feeds = [...new Set(feedList.map((f) => getAddress(f)))];
    const addresses = [...new Set([...feeds, ...(arena ? [getAddress(arena)] : [])])];
    if (!addresses.length) return sent;

    try {
      const latest = await pub.getBlockNumber();
      if (nextBlock === null) nextBlock = latest > START_LOOKBACK_BLOCKS ? latest - START_LOOKBACK_BLOCKS : 0n;
      while (nextBlock <= latest) {
        const to = nextBlock + range - 1n < latest ? nextBlock + range - 1n : latest;
        const logs = await pub.getLogs({ address: addresses, events: WATCHED_EVENTS, fromBlock: nextBlock, toBlock: to });
        for (const l of logs) {
          const key = `${l.transactionHash}:${l.logIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await send(eventAlert(l, runner, { names: nameMap, arena }), sent);
        }
        nextBlock = to + 1n; // only after the chunk was read: a failed chunk is read again next time
        saveBlock(stateFile, nextBlock, log);
      }
      failingSince = null;
      range = MAX_LOG_RANGE;
    } catch (e) {
      failingSince ??= now();
      if (range > MIN_LOG_RANGE) range = range / 2n > MIN_LOG_RANGE ? range / 2n : MIN_LOG_RANGE; // the node may refuse big ranges
      log(`pusher watch: could not read the contract events (${String(e.shortMessage || e.message).slice(0, 120)}); trying again in a minute with ${range} blocks at a time`);
      if (now() - failingSince > READ_FAIL_ALERT_MS && now() - lastBlindAlert > READ_FAIL_REPEAT_MS) {
        lastBlindAlert = now();
        await send({ title: 'Matchup: pusher watch cannot read the chain', message: `For ${Math.round((now() - failingSince) / 60_000)} minutes the runner has not been able to read the relay and arena events, so a change of pusher or owner would not be noticed. Check the RPC node.` }, sent);
      }
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
