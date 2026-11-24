// node --test lib/thin-market.test.ts
// SOL markets say their price is a single trade from a thin market (owner decision, docs/RUNBOOK.md "Known limits").
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { THIN_MARKET_KEYS, THIN_MARKET_NOTE, WINDOWS, usesThinMarket } from "./price-rule.ts";

test("every SOL market, and only those, gets the notice", () => {
  assert.equal(usesThinMarket("SOL"), true);
  assert.equal(usesThinMarket("SOLBTC"), true);
  for (const k of ["BTC", "ETH", "ETHBTC"]) assert.equal(usesThinMarket(k), false, k);
  assert.ok(THIN_MARKET_KEYS.every((k) => !WINDOWS[k]), "a thin market has no window");
});

test("the notice says it is a thin market and uses one trade (the last one for the end)", () => {
  assert.match(THIN_MARKET_NOTE, /^SOL prices come from a thin market/);
  assert.match(THIN_MARKET_NOTE, /single trade, not an average/);
  assert.match(THIN_MARKET_NOTE, /last trade about one minute before the end/);
});

test("the call panel shows it next to the buttons of a SOL market", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "components", "kairo", "your-call.tsx"), "utf8");
  assert.match(src, /\{usesThinMarket\(market\.key\) \? <ThinMarketNotice \/> : null\}/);
  assert.match(src, /\{THIN_MARKET_NOTE\}/);
});
