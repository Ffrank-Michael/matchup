// node --test lib/site-wording.test.ts
// The site must not say more than is true: Matchup holds no money but its runner sends the prices, and the live price is the
// latest trade while a round's start and end follow the window rules (lib/price-rule.ts).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LIVE_PRICE_NOTE, LIVE_PRICE_SHORT, MONEY_AND_PRICES_NOTE, PERMISSION_NOTE, PERMISSION_USDC } from "./price-rule.ts";

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

// The one-time permission: the contract pulls USDC only in placeCall, from the caller, the amount of that call
// (contracts/PredictionArena.sol). The site must say exactly that, in one shared sentence.
test("the one-time permission: the agreed wording, from one shared file, on How it works and the call sheet", () => {
  assert.equal(
    PERMISSION_NOTE,
    "Your first call asks your wallet for a one-time permission. The permission does not move any of your money to Matchup. It costs only Arc's tiny network fee, like every action. It lets the Matchup contract use up to 50 USDC of yours for calls, and nothing else. Each call takes only the amount you choose, at the moment you confirm that call. If you call 10 USDC, 10 USDC moves. You will not be asked again until the 50 USDC has been used up. In a browser wallet such as MetaMask you can lower the amount or remove the permission at any time.",
  );
  assert.equal(PERMISSION_USDC, 50);
  assert.doesNotMatch(PERMISSION_NOTE, /—/);
  assert.match(howItWorks, /\{PERMISSION_NOTE\}/);
  const makeCall = read("onchain", "useMakeCall.ts");
  assert.match(makeCall, /export const APPROVAL_NOTICE = PERMISSION_NOTE;/);
  assert.match(makeCall, /export const DEFAULT_APPROVAL_USDC = PERMISSION_USDC;/);
  assert.match(read("components", "kairo", "your-call.tsx"), /\{APPROVAL_NOTICE\}/);
});

test("no text says Matchup itself takes the money or has access to it", () => {
  const wallet = read("components", "kairo", "wallet-button.tsx");
  for (const [name, src] of [["how-it-works", howItWorks], ["wallet-button", wallet], ["useMakeCall", read("onchain", "useMakeCall.ts")]] as const) {
    assert.doesNotMatch(src, /let Matchup take/, name);
    assert.doesNotMatch(src, /lets Matchup take/, name);
    assert.doesNotMatch(src, /Matchup(&apos;|')s access/, name);
  }
  assert.match(wallet, /Remove the Matchup contract&apos;s permission to use my USDC/);
});
