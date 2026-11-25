// How the runner takes a round's start and end price, in one place, so every page says the same thing (audit part 2, P2-04
// and P2-01). Keep these in step with runner/config.mjs (startAfter, endMargin) and runner/exchangePrices.mjs (WINDOWS); a test
// checks they match.

/** The start window opens this many seconds after calling closes (the lock). */
export const START_AFTER_SECONDS = 2;

/** The end price is taken from this many seconds before the round ends: price moves after that do not count. */
export const END_TAKEN_SECONDS_BEFORE = 60;

/**
 * Coins whose start and end are the MEDIAN of all Bitfinex trades in a short window (P2-01): one trade can no longer set the
 * price. With fewer than minTrades trades in a window there is no price and the round refunds. SOL trades too rarely on
 * Bitfinex for this, so it keeps the single trade (a known limit, docs/RUNBOOK.md).
 */
export const WINDOWS: Record<string, { seconds: number; minTrades: number }> = {
  BTC: { seconds: 60, minTrades: 3 },
  ETH: { seconds: 90, minTrades: 3 },
};

/** The median of a list of numbers (the mean of the middle two for an even count). */
export function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** The start price, in plain words. */
export const START_RULE =
  "The start price is the middle price of all Bitfinex trades in the first 60 seconds after calling closes (90 seconds for ETH). For SOL it is the first trade after calling closes.";

/** The end price, in plain words. */
export const END_RULE =
  "The end price is the middle price of the trades in the 60 seconds (90 for ETH) before the last minute of the round; for SOL, the last trade about one minute before the end. The last minute does not count.";

/** The live price against a round's start and end price, in plain words (How it works, under the rules). */
export const LIVE_PRICE_NOTE =
  "The live price on this site is the latest trade on Bitfinex. The start and end price of a round follow the rules above: the middle price of the trades in a window for BTC and ETH, and a single trade for SOL.";

/** The same, short, for the home page footer (no rules above it there). */
export const LIVE_PRICE_SHORT = "Live price: the latest trade on Bitfinex. A round's start and end price follow the rules in";

/**
 * Who holds the money and who sends the prices, in plain words. The contract holds the pot and only pays the fee to Matchup, but
 * the runner pushes every start and end price; the relay only refuses a price far from Chainlink's (1% BTC, 1.5% ETH and SOL).
 */
export const MONEY_AND_PRICES_NOTE =
  "The money sits in the contract, not with Matchup, and Matchup's only cut is the 2% fee. But the Matchup runner sends the start and end prices to the contract, so you are trusting it to send the right ones. A safety check in the contract rejects any price that is far from Chainlink's price.";

/** When there are too few trades, in plain words. */
export const TOO_FEW_RULE =
  "If BTC or ETH has fewer than 3 trades in one of these windows, there is no price and everyone gets their money back.";

/**
 * Markets whose price uses SOL, which keeps the single-trade rule because Bitfinex SOL/USD is too thin for an average
 * (docs/RUNBOOK.md, "Known limits"). Every one of them shows THIN_MARKET_NOTE next to its call buttons.
 */
export const THIN_MARKET_KEYS: readonly string[] = ["SOL", "SOLBTC"];
export const usesThinMarket = (key: string) => THIN_MARKET_KEYS.includes(key);

/** The notice on SOL markets, in plain words. */
export const THIN_MARKET_NOTE =
  "SOL prices come from a thin market. Bitfinex's SOL/USD often goes a minute or more without a trade, so a SOL price is a single trade, not an average: the first trade after calling closes for the start, and the last trade about one minute before the end for the end. One trade can move it more than an average of many trades would.";

/** Shown on a live round once its end price is being taken. */
export const END_BEING_TAKEN = "The end price is being taken now. Moves from here to the end do not count.";

/** Is the end price already being taken for a round that ends at endSec? */
export function endBeingTaken(nowSec: number, endSec: number): boolean {
  return nowSec < endSec && endSec - nowSec <= END_TAKEN_SECONDS_BEFORE;
}
