// Matchup: how far Bitfinex's ETH/BTC is from Chainlink's ETH/USD ÷ BTC/USD on Arc mainnet (PLAN_V3 R1,
// docs/RATIO_MAINNET_CHECKLIST.md "Measure the Bitfinex-vs-Chainlink ratio gap for a week"). READ ONLY.
//
//   node scripts/ratio-gap.mjs                     one sample: print it and add it to the log file
//   node scripts/ratio-gap.mjs --every 300         a sample every 300 s, for ever (Ctrl+C stops it; the server runs it as a service)
//   node scripts/ratio-gap.mjs --summary           the largest and the typical gap in the log file
//   node scripts/ratio-gap.mjs --summary --days 7  the same, for the last 7 days only
//   --file <path>                                  another log file (default data/ratio-gap-mainnet.jsonl)
//
// No keys and no transactions: it reads public data only. It does not read .env. The Arc RPC is ARC_MAINNET_RPC_URL from the
// shell if set, otherwise Arc's public RPC.
//
// What one sample is (the same prices the runner would push for an ETH/BTC end price, and the same check the relay makes):
//   Bitfinex  the median of the ETH/USD trades in the last 90 s and of the BTC/USD trades in the last 60 s, both windows closing
//             2 s ago (runner/exchangePrices.mjs, WINDOWS), ratio = ETH * 10^18 / BTC (runner/pairs.mjs ratio18)
//   Chainlink latestRoundData() of the ETH/USD and BTC/USD proxies on Arc mainnet, ratio worked out like RatioGuard._ratio
//   gap       (Bitfinex - Chainlink) / Chainlink, in basis points (100 bps = 1%); the ETH/BTC relay will accept at most 250
// It also logs each coin's own gap (the ETH relay accepts 150 bps, the BTC relay 100) and how old each Chainlink answer is.
// A sample that fails (too few trades, Bitfinex or the RPC down) is logged with its error, so gaps in the data are visible.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createPublicClient, http } from 'viem';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_FILE = path.join(ROOT, 'data', 'ratio-gap-mainnet.jsonl');
export const RATIO_BAND_BPS = 250; // the ETH/BTC relay's band (scripts/markets.mjs ratioBandBps('ethbtc'))
export const LEG_BAND_BPS = { eth: 150, btc: 100 }; // the USD relays' bands (scripts/markets.mjs COINS)
export const MIN_EVERY_SECONDS = 60; // Bitfinex is shared with the runner: never sample more often than once a minute

const FEED_ABI = [
  { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

/** The command line. Returns { every, summary, days, file, error }. Pure. */
export function parseArgs(args) {
  const out = { every: 0, summary: false, days: null, file: DEFAULT_FILE, error: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--summary') out.summary = true;
    else if (a === '--every' || a === '--days' || a === '--file') {
      const v = args[++i];
      if (v === undefined) return { ...out, error: `${a} needs a value` };
      if (a === '--file') out.file = path.resolve(v);
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return { ...out, error: `${a} must be a number above 0` };
        if (a === '--every') {
          if (n < MIN_EVERY_SECONDS) return { ...out, error: `--every must be at least ${MIN_EVERY_SECONDS} seconds (Bitfinex is shared with the runner)` };
          out.every = Math.floor(n);
        } else out.days = n;
      }
    } else return { ...out, error: `unknown argument "${a}"` };
  }
  if (out.summary && out.every) return { ...out, error: '--summary and --every cannot be used together' };
  return out;
}

/** ETH/BTC with 18 decimals from two 8-decimal Chainlink answers, exactly as RatioGuard._ratio (8/8): a * 10^26 / (b * 10^8). Pure. */
export const chainlinkRatio18 = (eth8, btc8) => (BigInt(eth8) * 10n ** 26n) / (BigInt(btc8) * 10n ** 8n);

/** (a - b) / b in basis points, to 0.01 bps, signed. a and b are BigInts on the same scale; b > 0. Pure. */
export const gapBps = (a, b) => Number(((BigInt(a) - BigInt(b)) * 1_000_000n) / BigInt(b)) / 100;

/**
 * One log line from a Bitfinex ratio quote (runner/exchangePrices.mjs quote('ETH/BTC 1h', { endsAt })) and the two Chainlink
 * answers ({ answer, updatedAt } each), taken at `now` (unix seconds). Pure.
 */
export function makeEntry(now, q, cl) {
  const eth = q.legs.find((l) => l.pair === 'ETH/USD');
  const btc = q.legs.find((l) => l.pair === 'BTC/USD');
  const clRatio = chainlinkRatio18(cl.eth.answer, cl.btc.answer);
  return {
    t: now,
    iso: new Date(now * 1000).toISOString(),
    gapBps: gapBps(q.price, clRatio),
    bitfinex: Number(q.price) / 1e18,
    chainlink: Number(clRatio) / 1e18,
    eth: { gapBps: gapBps(eth.price, cl.eth.answer), bitfinex: eth.usd, chainlink: Number(cl.eth.answer) / 1e8, trades: eth.trades, chainlinkAgeSec: now - Number(cl.eth.updatedAt) },
    btc: { gapBps: gapBps(btc.price, cl.btc.answer), bitfinex: btc.usd, chainlink: Number(cl.btc.answer) / 1e8, trades: btc.trades, chainlinkAgeSec: now - Number(cl.btc.updatedAt) },
  };
}

/** The value at fraction p (0..1) of a list sorted from small to large (nearest rank). Pure. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Reads a JSONL log: the entries, and how many lines could not be read. Pure apart from the text it is given. */
export function parseLog(text) {
  const entries = [];
  let unreadable = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { unreadable++; }
  }
  return { entries, unreadable };
}

/**
 * The largest and the typical gap over a list of log entries, optionally only those at or after sinceSec. Pure.
 * Returns null when there is no good sample. Gaps are compared by size (a negative gap counts like a positive one).
 */
export function summarize(entries, { sinceSec = null } = {}) {
  const use = entries.filter((e) => sinceSec === null || e.t >= sinceSec);
  const good = use.filter((e) => !e.error && typeof e.gapBps === 'number');
  const failed = use.filter((e) => e.error);
  if (!good.length) return { samples: 0, failed: failed.length, from: use[0]?.iso ?? null, to: use.at(-1)?.iso ?? null };
  const stats = (pick, band) => {
    const vals = good.map(pick).filter((v) => typeof v === 'number');
    const abs = vals.map(Math.abs).sort((a, b) => a - b);
    const worst = good.reduce((w, e) => (Math.abs(pick(e)) > Math.abs(pick(w)) ? e : w));
    return {
      maxAbs: abs.at(-1), maxAt: worst.iso, maxSigned: pick(worst),
      median: percentile(abs, 0.5), p95: percentile(abs, 0.95), p99: percentile(abs, 0.99),
      meanSigned: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100,
      band, overHalfBand: abs.filter((v) => v > band / 2).length, overBand: abs.filter((v) => v > band).length,
    };
  };
  return {
    samples: good.length, failed: failed.length, from: good[0].iso, to: good.at(-1).iso,
    ratio: stats((e) => e.gapBps, RATIO_BAND_BPS),
    eth: stats((e) => e.eth.gapBps, LEG_BAND_BPS.eth),
    btc: stats((e) => e.btc.gapBps, LEG_BAND_BPS.btc),
    oldestChainlinkSec: { eth: Math.max(...good.map((e) => e.eth.chainlinkAgeSec)), btc: Math.max(...good.map((e) => e.btc.chainlinkAgeSec)) },
  };
}

/** The summary as plain lines. Pure. */
export function summaryText(s, { days = null, unreadable = 0 } = {}) {
  const lines = [];
  lines.push(`Bitfinex ETH/BTC against Chainlink ETH/USD ÷ BTC/USD${days ? `, last ${days} day(s)` : ''}`);
  if (!s.samples) { lines.push(`No good samples yet (${s.failed} failed).`); return lines.join('\n'); }
  lines.push(`${s.samples} samples from ${s.from} to ${s.to}; ${s.failed} failed${unreadable ? `; ${unreadable} unreadable line(s)` : ''}.`);
  lines.push('Gaps in basis points (100 bps = 1%), by size:');
  const row = (name, x) => `  ${name.padEnd(8)} max ${x.maxAbs.toFixed(2)} (${x.maxSigned > 0 ? '+' : ''}${x.maxSigned.toFixed(2)} at ${x.maxAt}), typical (median) ${x.median.toFixed(2)}, 95% under ${x.p95.toFixed(2)}, 99% under ${x.p99.toFixed(2)}, average with sign ${x.meanSigned}; band ${x.band}: over half of it ${x.overHalfBand} time(s), over it ${x.overBand} time(s)`;
  lines.push(row('ETH/BTC', s.ratio), row('ETH/USD', s.eth), row('BTC/USD', s.btc));
  lines.push(`Oldest Chainlink answer seen: ETH ${(s.oldestChainlinkSec.eth / 3600).toFixed(1)} h, BTC ${(s.oldestChainlinkSec.btc / 3600).toFixed(1)} h (the RatioGuard refuses a leg over 25 h).`);
  return lines.join('\n');
}

/** One sample. deps: { quote(endsAt) -> ratio quote, readChainlink() -> { eth, btc }, nowSec(), endMargin, settleSec }. */
export async function sample(deps) {
  const now = Math.floor(deps.nowSec());
  try {
    // an end price of a round "ending" now + endMargin - settleSec - 1: both windows closed 3 s ago, like the runner's end price
    const q = await deps.quote(now - deps.settleSec - 1 + deps.endMargin);
    const cl = await deps.readChainlink();
    return makeEntry(now, q, cl);
  } catch (e) {
    return { t: now, iso: new Date(now * 1000).toISOString(), error: String(e?.shortMessage || e?.message || e).slice(0, 300) };
  }
}

const shortLine = (e) => (e.error
  ? `${e.iso}  no sample: ${e.error}`
  : `${e.iso}  ETH/BTC gap ${e.gapBps.toFixed(2)} bps (Bitfinex ${e.bitfinex.toPrecision(8)}, Chainlink ${e.chainlink.toPrecision(8)}); ETH ${e.eth.gapBps.toFixed(2)} bps, BTC ${e.btc.gapBps.toFixed(2)} bps; Chainlink ages ETH ${e.eth.chainlinkAgeSec} s, BTC ${e.btc.chainlinkAgeSec} s`);

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.error) { console.error('STOP: ' + opt.error); process.exit(1); }

  if (opt.summary) {
    if (!fs.existsSync(opt.file)) { console.error(`STOP: no log file at ${opt.file} yet.`); process.exit(1); }
    const { entries, unreadable } = parseLog(fs.readFileSync(opt.file, 'utf8'));
    const sinceSec = opt.days ? Math.floor(Date.now() / 1000 - opt.days * 86400) : null;
    console.log(summaryText(summarize(entries, { sinceSec }), { days: opt.days, unreadable }));
    return;
  }

  const { NETWORKS, arcChain } = await import('./lib.mjs');
  const { CHAINLINK_MAINNET } = await import('./markets.mjs');
  const { createExchangePrices, WINDOW_SETTLE_SEC } = await import('../runner/exchangePrices.mjs');
  const { CFG } = await import('../runner/config.mjs');
  const net = NETWORKS.mainnet;
  const rpc = process.env.ARC_MAINNET_RPC_URL || net.rpc;
  const pub = createPublicClient({ chain: arcChain(net, rpc), transport: http(rpc) });
  if ((await pub.getChainId()) !== net.id) { console.error(`STOP: the RPC is not Arc mainnet (${net.id}).`); process.exit(1); }
  const leg = async (address) => {
    const [dec, r] = await Promise.all([
      pub.readContract({ address, abi: FEED_ABI, functionName: 'decimals' }),
      pub.readContract({ address, abi: FEED_ABI, functionName: 'latestRoundData' }),
    ]);
    if (Number(dec) !== 8) throw new Error(`Chainlink ${address} has ${dec} decimals, expected 8`);
    if (r[1] <= 0n) throw new Error(`Chainlink ${address} answered ${r[1]}`);
    return { answer: r[1], updatedAt: r[3] };
  };
  const deps = {
    nowSec: () => Date.now() / 1000,
    endMargin: CFG.endMargin,
    settleSec: WINDOW_SETTLE_SEC,
    // a fresh price reader for every sample, so one big move between two samples is never refused as a "jump"
    quote: (endsAt) => createExchangePrices().quote('ETH/BTC 1h', { endsAt }),
    readChainlink: async () => {
      const [eth, btc] = await Promise.all([leg(CHAINLINK_MAINNET.eth), leg(CHAINLINK_MAINNET.btc)]);
      return { eth, btc };
    },
  };
  fs.mkdirSync(path.dirname(opt.file), { recursive: true });
  const once = async () => {
    const e = await sample(deps);
    fs.appendFileSync(opt.file, JSON.stringify(e) + '\n');
    console.log(shortLine(e));
  };
  await once();
  if (!opt.every) return;
  console.log(`Logging a sample every ${opt.every} s to ${opt.file}.`);
  for (;;) {
    await new Promise((r) => setTimeout(r, opt.every * 1000));
    await once();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error('ERROR: ' + (e?.shortMessage || e?.message || e)); process.exit(1); });
}
