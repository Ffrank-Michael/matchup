// The start price that DECIDES a round, read from the chain (audit part 2, P2-05): the first update of the market's price relay
// at or after the round's lock, the same rule as the contract and as runner/settleIds.mjs. The site used to show its own
// Bitfinex lookup instead until the round was settled, which hid a start price that differed from it.
// Pure: the reads are passed in, so this can be tested without a chain.

export type RoundData = readonly [roundId: bigint, answer: bigint, startedAt: bigint, updatedAt: bigint, answeredInRound: bigint];
export type FeedReader = {
  latest: () => Promise<RoundData>;
  round: (id: bigint) => Promise<RoundData>;
};
export type ChainStart = { roundId: bigint; answer: bigint; updatedAt: number };

const ROUND_IN_PHASE = BigInt("0xffffffffffffffff");

/**
 * The first update at or after `lockSec`, or null when there is none yet. Walks back from the newest update; stops after
 * `maxSteps` reads (null: try again later rather than guess). A read that fails throws, so the caller tries again.
 */
export async function findChainStart(read: FeedReader, lockSec: number, maxSteps = 200): Promise<ChainStart | null> {
  let cur = await read.latest();
  if (Number(cur[3]) < lockSec) return null; // nothing on chain since the lock yet
  for (let i = 0; i < maxSteps; i++) {
    const first = (cur[0] & ROUND_IN_PHASE) <= BigInt(1); // the feed's first update: nothing before it
    const prev = first ? null : await read.round(cur[0] - BigInt(1));
    if (first || Number((prev as RoundData)[3]) < lockSec) {
      return { roundId: cur[0], answer: cur[1], updatedAt: Number(cur[3]) }; // the one before is before the lock: cur is the start
    }
    cur = prev as RoundData;
  }
  return null; // ran out of steps: cur may not be the first one, so say "not known" instead of a wrong start
}

/**
 * Do the chain's start and the site's own Bitfinex lookup disagree? Both use the same rounding, so anything beyond a tiny
 * float difference means the runner pushed something else (or a late push became the start).
 */
export function startsDiffer(chain: number | null, bitfinex: number | null): boolean {
  if (chain === null || bitfinex === null) return false;
  return Math.abs(chain - bitfinex) > Math.max(1e-12, Math.abs(bitfinex) * 1e-9);
}

export const START_DIFFERS =
  "The start price on chain differs from Bitfinex's first trade after the lock. The chain's price is the one that counts.";
export const START_NOT_ON_CHAIN = "Start price not on chain yet";
