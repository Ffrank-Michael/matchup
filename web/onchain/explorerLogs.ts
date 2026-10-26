/**
 * onchain/explorerLogs.ts
 * Event logs from the Arc block explorer's API. The public RPC refuses log searches over about 5,000 blocks (under an
 * hour), so history (a finished call's receipt, the prices of an older round) is read from the explorer, which indexes
 * the whole chain. It sends no key requirement and allows browsers. Everything it returns is also on the chain itself:
 * the "Verify" links on the site open the transactions these logs came from.
 */
import { activeChain } from "./wagmiConfig";

export interface ExplorerLog {
  topics: (`0x${string}` | null)[];
  data: `0x${string}`;
  txHash: `0x${string}`;
  block: number;
  logIndex: number;
  /** unix seconds of the block */
  time: number;
}

const word = (n: bigint | number) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
/** An address as a 32-byte topic. */
export const addressTopic = (a: string) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
/** A number as a 32-byte topic. */
export const numberTopic = word;

/** Logs of one contract, matched on up to four topics (null = any), from a block to the latest. */
export async function explorerLogs(opts: { address: string; topics: (string | null)[]; fromBlock: number | bigint }): Promise<ExplorerLog[]> {
  const base = activeChain.blockExplorers.default.url;
  const q = new URLSearchParams({ module: "logs", action: "getLogs", fromBlock: String(opts.fromBlock), toBlock: "latest", address: opts.address });
  const given = opts.topics.map((t, i) => [i, t] as const).filter(([, t]) => t !== null);
  for (const [i, t] of given) q.set(`topic${i}`, t as string);
  for (let a = 0; a < given.length; a++) for (let b = a + 1; b < given.length; b++) q.set(`topic${given[a][0]}_${given[b][0]}_opr`, "and");
  const res = await fetch(`${base}/api?${q.toString()}`);
  if (!res.ok) throw new Error(`explorer answered ${res.status}`);
  const body: { status: string; message: string; result: null | { topics: (string | null)[]; data: string; transactionHash: string; blockNumber: string; logIndex: string; timeStamp: string }[] } = await res.json();
  if (!Array.isArray(body.result)) {
    if (body.message === "No logs found") return [];
    throw new Error(body.message || "explorer gave no answer");
  }
  return body.result.map((l) => ({
    topics: l.topics as ExplorerLog["topics"],
    data: l.data as `0x${string}`,
    txHash: l.transactionHash as `0x${string}`,
    block: Number(BigInt(l.blockNumber)),
    logIndex: l.logIndex === "0x" ? 0 : Number(BigInt(l.logIndex)),
    time: Number(BigInt(l.timeStamp)),
  }));
}
