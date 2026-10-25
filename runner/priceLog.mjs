// The public price log: one line of JSON for every price the runner puts on chain.
//
// Why it exists: the chain stores only the price and the block time of each push. The website also
// needs to show which source the price came from, when that source made its own quote, and a link
// to the transaction. This file keeps that, one JSON object per line (data/price-log.jsonl).
// Nothing secret is in it, so it can be published as it is.
//
// A line looks like:
//   {"v":1,"label":"TEST PRICES - NOT REAL DATA","chainId":5042002,"market":"BTC/USD","marketId":0,
//    "round":12345,"kind":"start","price":"8047700000000","priceUsd":80477,"decimals":8,
//    "source":"CoinGecko","sourceQuoteAt":1792947711,"sourceQuoteAgeSec":48,
//    "recordedAt":1792947760,"recordedAtIso":"2026-10-25T17:02:40.000Z",
//    "txHash":"0x...","blockNumber":"123","feed":"0x...","explorerUrl":"https://explorer.testnet.arc.io/tx/0x..."}
// "round" is the round the price belongs to (the round that was running when it was pushed).
// kind is "start", "mid" or "end". recordedAt is the block time, the same time the contract sees.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../scripts/lib.mjs';

export const PRICE_LOG_FILE = path.join(ROOT, 'data', 'price-log.jsonl');
const KINDS = { 'start price': 'start', 'mid-round price': 'mid', 'end price': 'end' };
export const kindOf = (why) => KINDS[why] ?? why;

/** Builds one log entry from a pushed price. All numbers come from the quote and the chain, none are made up. */
export function makePriceLogEntry({ action, quote, txHash, blockNumber, blockTimestamp, feed, explorer, chainId, nowSec }) {
  return {
    v: 1,
    label: 'TEST PRICES - NOT REAL DATA',
    chainId,
    market: action.marketName,
    marketId: action.market,
    round: action.round,
    kind: kindOf(action.why),
    price: String(quote.price),
    priceUsd: quote.usd,
    decimals: 8,
    source: 'CoinGecko',
    sourceQuoteAt: quote.quotedAt,
    sourceQuoteAgeSec: quote.quotedAt ? Math.max(0, Math.round(Number(blockTimestamp) - quote.quotedAt)) : null,
    recordedAt: Number(blockTimestamp),
    recordedAtIso: new Date(Number(blockTimestamp) * 1000).toISOString(),
    txHash,
    blockNumber: String(blockNumber),
    feed,
    explorerUrl: `${explorer}/tx/${txHash}`,
  };
}

export function appendPriceLog(entry, file = PRICE_LOG_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

/** Reads the log back. A half-written or damaged line is skipped instead of breaking everything. */
export function readPriceLog(file = PRICE_LOG_FILE) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}
