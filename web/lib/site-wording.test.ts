// node --test lib/site-wording.test.ts
// The site must not say more than is true: Matchup holds no money but its runner sends the prices, and the live price is the
// latest trade while a round's start and end follow the window rules (lib/price-rule.ts).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LIVE_PRICE_NOTE, LIVE_PRICE_SHORT, MONEY_AND_PRICES_NOTE } from "./price-rule.ts";

const read = (...p: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, "..", ...p), "utf8");
const howItWorks = read("app", "how-it-works", "page.tsx");
const home = read("components", "kairo", "kairo-home.tsx");

test("money and prices: the contract holds the money, the fee is the only cut, the runner sends the prices, Chainlink check", () => {
  assert.match(MONEY_AND_PRICES_NOTE, /money sits in the contract, not with Matchup/);
  assert.match(MONEY_AND_PRICES_NOTE, /only cut is the 2% fee/);
  assert.match(MONEY_AND_PRICES_NOTE, /runner sends the start and end prices/);
  assert.match(MONEY_AND_PRICES_NOTE, /trusting it to send the right ones/);
  assert.match(MONEY_AND_PRICES_NOTE, /rejects any price that is far from Chainlink's price/);
});

test("live price against a round's prices: latest trade live, window for BTC and ETH, single trade for SOL", () => {
  assert.match(LIVE_PRICE_NOTE, /live price on this site is the latest trade on Bitfinex/);
  assert.match(LIVE_PRICE_NOTE, /middle price of the trades in a window for BTC and ETH/);
  assert.match(LIVE_PRICE_NOTE, /single trade for SOL/);
  assert.match(LIVE_PRICE_SHORT, /^Live price: the latest trade on Bitfinex/);
});

test("How it works and the home page use the new wording, and the old lines are gone", () => {
  assert.match(howItWorks, /\$\{MONEY_AND_PRICES_NOTE\}/);
  assert.match(howItWorks, /\{LIVE_PRICE_NOTE\}/);
  assert.doesNotMatch(howItWorks, /can only take its 2% fee/);
  assert.doesNotMatch(howItWorks, /Prices are the last live trade/);
  assert.match(home, /\{LIVE_PRICE_SHORT\}/);
  assert.doesNotMatch(home, /Prices: last trade on/);
});

test("no em dashes in the new wording", () => {
  for (const s of [MONEY_AND_PRICES_NOTE, LIVE_PRICE_NOTE, LIVE_PRICE_SHORT]) assert.doesNotMatch(s, /—/);
});
