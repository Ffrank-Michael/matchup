// node --test lib/chain-start.test.ts
// The start price from the chain (audit part 2, P2-05): the first relay update at or after the lock, as the contract decides it.
import test from "node:test";
import assert from "node:assert/strict";
import { findChainStart, startsDiffer, type FeedReader, type RoundData } from "./chain-start.ts";

const P1 = BigInt(1) << BigInt(64);
/** A pretend relay: times[i] is when update P1|(i+1) landed; its answer is 1000 + (i+1). */
function relay(times: number[]): FeedReader & { reads: number } {
  const r = {
    reads: 0,
    latest: async (): Promise<RoundData> => {
      r.reads++;
      const n = times.length;
      if (!n) throw new Error("No data present");
      return [P1 | BigInt(n), BigInt(1000 + n), BigInt(0), BigInt(times[n - 1]), P1 | BigInt(n)];
    },
    round: async (id: bigint): Promise<RoundData> => {
      r.reads++;
      const i = Number(id - P1);
      if (i < 1 || i > times.length) throw new Error("No data present");
      return [id, BigInt(1000 + i), BigInt(0), BigInt(times[i - 1]), id];
    },
  };
  return r;
}

test("the start is the first update at or after the lock, not the newest one", async () => {
  const s = await findChainStart(relay([900, 1005, 1300, 1580]), 1000);
  assert.deepEqual(s, { roundId: P1 | BigInt(2), answer: BigInt(1002), updatedAt: 1005 });
});

test("an update exactly at the lock is the start (same rule as the contract)", async () => {
  const s = await findChainStart(relay([900, 1000, 1001]), 1000);
  assert.equal(s?.updatedAt, 1000);
});

test("nothing since the lock yet: no start (the site says it is not on chain yet)", async () => {
  assert.equal(await findChainStart(relay([900, 950]), 1000), null);
});

test("the very first update of a relay can be a start", async () => {
  const s = await findChainStart(relay([1010, 1200]), 1000);
  assert.equal(s?.roundId, P1 | BigInt(1));
});

test("a late end price of the round before IS the start on chain, and the site shows it (it is what counts)", async () => {
  // the previous round's end price was mined 3 s after its end = this round's lock (P2-02 made this rare, but the chain decides)
  const s = await findChainStart(relay([700, 1003, 1035]), 1000);
  assert.equal(s?.updatedAt, 1003);
});

test("too many updates to walk: no answer rather than a wrong one", async () => {
  const times = Array.from({ length: 50 }, (_, i) => 1000 + i);
  assert.equal(await findChainStart(relay(times), 1000, 10), null);
  assert.equal((await findChainStart(relay(times), 1000, 60))?.updatedAt, 1000);
});

test("a failed read throws, so the hook asks again instead of showing a wrong start", async () => {
  const r = relay([900, 1005]);
  await assert.rejects(findChainStart({ latest: r.latest, round: async () => { throw new Error("rpc down"); } }, 1000), /rpc down/);
});

test("startsDiffer: equal or float-close numbers agree; a different push is flagged; nothing to compare is not flagged", () => {
  assert.equal(startsDiffer(80000.12, 80000.12), false);
  assert.equal(startsDiffer(0.033925, 0.033925 * (1 + 1e-12)), false);
  assert.equal(startsDiffer(80100, 80000), true);
  assert.equal(startsDiffer(0.0339, 0.0338), true);
  assert.equal(startsDiffer(null, 80000), false);
  assert.equal(startsDiffer(80000, null), false);
});
