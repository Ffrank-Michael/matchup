// node --test lib/price-rule.test.ts
// The words and numbers the site uses for the start and end price must match what the runner does (audit part 2, P2-04, P2-01).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { END_RULE, END_TAKEN_SECONDS_BEFORE, START_AFTER_SECONDS, START_RULE, TOO_FEW_RULE, WINDOWS, endBeingTaken, median } from "./price-rule.ts";

const runnerFile = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "runner", f), "utf8");

test("the end is taken the runner's endMargin before the end, the start window opens startAfter after the lock", () => {
  const cfg = runnerFile("config.mjs");
  assert.equal(END_TAKEN_SECONDS_BEFORE, Number(cfg.match(/endMargin:\s*(\d+)/)?.[1]));
  assert.equal(START_AFTER_SECONDS, Number(cfg.match(/startAfter:\s*(\d+)/)?.[1]));
  assert.match(END_RULE, /last minute does not count/);
});

test("the site's windows are the runner's windows (BTC 60 s, ETH 90 s, at least 3 trades; none for SOL)", () => {
  const src = runnerFile("exchangePrices.mjs");
  for (const [coin, w] of Object.entries(WINDOWS)) {
    const m = src.match(new RegExp(`'${coin}/USD': \\{ seconds: (\\d+), minTrades: (\\d+) \\}`));
    assert.ok(m, `${coin} has a window in the runner`);
    assert.deepEqual([Number(m[1]), Number(m[2])], [w.seconds, w.minTrades], coin);
  }
  assert.doesNotMatch(src, /'SOL\/USD': \{ seconds:/, "SOL keeps the single trade in the runner too");
  assert.equal(WINDOWS.SOL, undefined);
});

test("the rules say what happens, in plain words", () => {
  assert.match(START_RULE, /middle price of all Bitfinex trades in the first 60 seconds after calling closes \(90 seconds for ETH\)/);
  assert.match(START_RULE, /For SOL it is the first trade/);
  assert.match(END_RULE, /60 seconds \(90 for ETH\) before the last minute/);
  assert.match(TOO_FEW_RULE, /fewer than 3 trades .* everyone gets their money back/);
});

test("median: as the runner computes it", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("the last-minute notice shows from 60 s before the end until the end, not before and not after", () => {
  assert.equal(endBeingTaken(1000 - 61, 1000), false);
  assert.equal(endBeingTaken(1000 - 60, 1000), true);
  assert.equal(endBeingTaken(999, 1000), true);
  assert.equal(endBeingTaken(1000, 1000), false);
});

test("How it works uses these rules and no longer says the end price is the price at the moment the round ends", () => {
  const page = fs.readFileSync(path.resolve(import.meta.dirname, "..", "app", "how-it-works", "page.tsx"), "utf8");
  assert.doesNotMatch(page, /When the round ends, the price at that moment is the end price/);
  assert.doesNotMatch(page, /first trade after calling closes; the end ratio uses each coin&apos;s last trade/);
  for (const name of ["START_RULE", "END_RULE", "TOO_FEW_RULE"]) assert.match(page, new RegExp(`\\{${name}\\}`));
});
