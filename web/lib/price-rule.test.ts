// node --test lib/price-rule.test.ts
// The words the site uses for the start and end price must match what the runner does (audit part 2, P2-04).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { END_RULE, END_TAKEN_SECONDS_BEFORE, endBeingTaken } from "./price-rule.ts";

test("the end price is said to be taken about a minute before the end, the runner's endMargin", async () => {
  const cfg = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "runner", "config.mjs"), "utf8");
  const endMargin = Number(cfg.match(/endMargin:\s*(\d+)/)?.[1]);
  assert.equal(END_TAKEN_SECONDS_BEFORE, endMargin);
  assert.match(END_RULE, /one minute before the round ends/);
  assert.match(END_RULE, /last minute does not count/);
});

test("the last-minute notice shows from 60 s before the end until the end, not before and not after", () => {
  assert.equal(endBeingTaken(1000 - 61, 1000), false);
  assert.equal(endBeingTaken(1000 - 60, 1000), true);
  assert.equal(endBeingTaken(999, 1000), true);
  assert.equal(endBeingTaken(1000, 1000), false);
});

test("How it works no longer says the end price is the price at the moment the round ends", () => {
  const page = fs.readFileSync(path.resolve(import.meta.dirname, "..", "app", "how-it-works", "page.tsx"), "utf8");
  assert.doesNotMatch(page, /When the round ends, the price at that moment is the end price/);
  assert.doesNotMatch(page, /last trade before the end\./);
  assert.match(page, /END_RULE/);
});
