// node --test scripts/ratio-gap.test.mjs
// The Bitfinex vs Chainlink ETH/BTC gap logger: the maths, one sample against fakes (no network), and the summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, chainlinkRatio18, gapBps, makeEntry, percentile, parseLog, summarize, summaryText, sample, DEFAULT_FILE, RATIO_BAND_BPS, LEG_BAND_BPS } from './ratio-gap.mjs';
import { ratio18 } from '../runner/pairs.mjs';
import { ratioBandBps, COINS } from './markets.mjs';

const NOW = 1_800_000_000;

test('the command line: one sample by default, --every at least 60 s, --summary with --days, nothing else', () => {
  assert.deepEqual(parseArgs([]), { every: 0, summary: false, days: null, file: DEFAULT_FILE, error: null });
  assert.equal(parseArgs(['--every', '300']).every, 300);
  assert.match(parseArgs(['--every', '10']).error, /at least 60/);
  assert.match(parseArgs(['--every']).error, /needs a value/);
  assert.match(parseArgs(['--every', 'x']).error, /number above 0/);
  assert.deepEqual([parseArgs(['--summary', '--days', '7']).summary, parseArgs(['--summary', '--days', '7']).days], [true, 7]);
  assert.match(parseArgs(['--summary', '--every', '300']).error, /cannot be used together/);
  assert.match(parseArgs(['--send']).error, /unknown argument/);
});

test('the bands it compares with are the deployed ones', () => {
  assert.equal(RATIO_BAND_BPS, ratioBandBps('ethbtc'));
  assert.equal(LEG_BAND_BPS.eth, COINS.eth.bandBps);
  assert.equal(LEG_BAND_BPS.btc, COINS.btc.bandBps);
});

test('the Chainlink ratio is the RatioGuard maths, and equals the runner ratio for the same prices', () => {
  const eth = 3_000n * 10n ** 8n, btc = 100_000n * 10n ** 8n;
  assert.equal(chainlinkRatio18(eth, btc), 3n * 10n ** 16n);
  assert.equal(chainlinkRatio18(171_595_000_000n, 6_121_806_200_000n), ratio18(171_595_000_000n, 6_121_806_200_000n));
});

test('gap in basis points: signed, to 0.01 bps', () => {
  assert.equal(gapBps(10_100n, 10_000n), 100);
  assert.equal(gapBps(9_750n, 10_000n), -250);
  assert.equal(gapBps(1_000_123n, 1_000_000n), 1.23);
  assert.equal(gapBps(5n, 5n), 0);
});

// a ratio quote in the shape runner/exchangePrices.mjs returns
const quote = (ethUsd, btcUsd) => {
  const e = BigInt(Math.round(ethUsd * 1e8)), b = BigInt(Math.round(btcUsd * 1e8));
  return { price: ratio18(e, b), legs: [{ pair: 'ETH/USD', usd: ethUsd, price: String(e), trades: 40 }, { pair: 'BTC/USD', usd: btcUsd, price: String(b), trades: 90 }] };
};
const cl = (ethUsd, btcUsd, ethAge = 600, btcAge = 60) => ({
  eth: { answer: BigInt(Math.round(ethUsd * 1e8)), updatedAt: BigInt(NOW - ethAge) },
  btc: { answer: BigInt(Math.round(btcUsd * 1e8)), updatedAt: BigInt(NOW - btcAge) },
});

test('one entry: the ratio gap, each coin\'s gap and each Chainlink age', () => {
  const e = makeEntry(NOW, quote(3030, 100_000), cl(3000, 100_000));
  assert.equal(e.t, NOW);
  assert.equal(e.gapBps, 100); // ETH 1% above Chainlink, BTC equal: the ratio is 1% above
  assert.equal(e.eth.gapBps, 100);
  assert.equal(e.btc.gapBps, 0);
  assert.equal(e.eth.chainlinkAgeSec, 600);
  assert.equal(e.btc.chainlinkAgeSec, 60);
  assert.equal(e.eth.trades, 40);
  assert.equal(e.bitfinex, 0.0303);
  assert.equal(e.chainlink, 0.03);
  assert.doesNotThrow(() => JSON.stringify(e)); // no BigInt left in the line
});

test('a sample asks for an end price whose windows closed 3 s ago, and logs an error instead of crashing', async () => {
  let asked;
  const ok = await sample({ nowSec: () => NOW + 0.7, endMargin: 60, settleSec: 2, quote: async (endsAt) => { asked = endsAt; return quote(3000, 100_000); }, readChainlink: async () => cl(3000, 100_000) });
  assert.equal(asked, NOW - 3 + 60); // the windows close at endsAt - endMargin = now - 3
  assert.equal(ok.gapBps, 0);
  const bad = await sample({ nowSec: () => NOW, endMargin: 60, settleSec: 2, quote: async () => { throw new Error('only 2 ETH/USD trades'); }, readChainlink: async () => assert.fail('not read') });
  assert.deepEqual(bad, { t: NOW, iso: new Date(NOW * 1000).toISOString(), error: 'only 2 ETH/USD trades' });
});

test('percentile and the log reader', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
  const { entries, unreadable } = parseLog('{"t":1}\n\nnot json\n{"t":2}\n');
  assert.deepEqual(entries.map((e) => e.t), [1, 2]);
  assert.equal(unreadable, 1);
});

test('the summary: the largest gap by size with its sign and time, the typical gap, counts against the band, failures', () => {
  const at = (i) => NOW + i * 300;
  const entries = [
    makeEntry(at(0), quote(3003, 100_000), cl(3000, 100_000)),   // +10 bps
    makeEntry(at(1), quote(2985, 100_000), cl(3000, 100_000)),   // -50 bps
    makeEntry(at(2), quote(3000, 100_000), cl(3000, 100_000)),   // 0
    makeEntry(at(3), quote(3000, 96_200), cl(3000, 100_000)),    // BTC 3.8% low: ratio about +395 bps, over the band
    { t: at(4), iso: new Date(at(4) * 1000).toISOString(), error: 'Bitfinex answered HTTP 429' },
  ];
  const s = summarize(entries);
  assert.equal(s.samples, 4);
  assert.equal(s.failed, 1);
  assert.ok(s.ratio.maxAbs > 390 && s.ratio.maxAbs < 400);
  assert.equal(s.ratio.maxAt, entries[3].iso);
  assert.ok(s.ratio.maxSigned > 0);
  assert.equal(s.ratio.median, 10);
  assert.equal(s.ratio.overBand, 1);
  assert.equal(s.ratio.overHalfBand, 1);
  assert.equal(s.btc.overBand, 1); // 380 bps against the BTC relay's 100
  assert.equal(s.eth.maxAbs, 50);
  assert.equal(s.oldestChainlinkSec.eth, 600 + 3 * 300); // the fake Chainlink time stays put while the samples move on

  const recent = summarize(entries, { sinceSec: at(2) });
  assert.equal(recent.samples, 2);
  assert.equal(recent.failed, 1);

  const text = summaryText(s, { days: 7 });
  assert.match(text, /last 7 day\(s\)/);
  assert.match(text, /4 samples from .* 1 failed/);
  assert.match(text, /ETH\/BTC +max 39\d\.\d\d \(\+39\d\.\d\d at /);
  assert.match(text, /typical \(median\) 10\.00/);
  assert.match(text, /band 250: over half of it 1 time\(s\), over it 1 time\(s\)/);
});

test('the summary of a log with no good sample says so', () => {
  const s = summarize([{ t: NOW, iso: 'x', error: 'down' }]);
  assert.equal(s.samples, 0);
  assert.match(summaryText(s), /No good samples yet \(1 failed\)/);
});
