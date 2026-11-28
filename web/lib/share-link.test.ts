// Tests for the share link of a round.  Run:  node --test lib/share-link.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { readShare, shareUrl, sharedNote, SHARED_CLOSED_TEXT, SHARED_LATER_TEXT, SHARED_OPEN_TEXT } from "./share-link.ts";

const MARKETS = [
  { id: 0, key: "BTC", roundSeconds: 300 },
  { id: 3, key: "ETH", roundSeconds: 900 },
];
const read = (...p: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, "..", ...p), "utf8");

test("the link names the market and the round, on the site's own address", () => {
  assert.equal(shareUrl("https://www.playmatchup.xyz", 3, 5871234), "https://www.playmatchup.xyz/?market=3&round=5871234");
  assert.equal(shareUrl("http://localhost:3000", 0, 7), "http://localhost:3000/?market=0&round=7");
});

test("a link opens on its market and time frame", () => {
  assert.deepEqual(readShare("?market=3&round=42", MARKETS), { marketId: 3, key: "ETH", roundSeconds: 900, roundIndex: 42 });
  const url = new URL(shareUrl("https://www.playmatchup.xyz", 0, 9));
  assert.deepEqual(readShare(url.search, MARKETS), { marketId: 0, key: "BTC", roundSeconds: 300, roundIndex: 9 });
});

test("a bad or unknown link is ignored and the page opens as usual", () => {
  for (const s of ["", "?market=3", "?round=4", "?market=9&round=1", "?market=-1&round=1", "?market=1.5&round=1", "?market=3&round=abc", "?market=3&round=1e3"]) {
    assert.equal(readShare(s, MARKETS), null, s);
  }
});

test("the call panel says plainly what the link did", () => {
  const s = readShare("?market=3&round=42", MARKETS);
  assert.equal(sharedNote(s, 3, 42), SHARED_OPEN_TEXT);
  assert.equal(sharedNote(s, 3, 43), SHARED_CLOSED_TEXT);
  assert.equal(sharedNote(s, 3, 41), SHARED_LATER_TEXT);
  assert.equal(sharedNote(s, 0, 42), null); // the visitor picked another market
  assert.equal(sharedNote(s, 3, null), null); // rounds not read yet
  assert.equal(sharedNote(null, 3, 42), null);
  for (const t of [SHARED_OPEN_TEXT, SHARED_CLOSED_TEXT, SHARED_LATER_TEXT]) {
    assert.doesNotMatch(t, /—/);
    assert.doesNotMatch(t, /\b(bet|wager|odds)\b/i);
  }
});

test("opening a link never places a call: it only picks the market and time frame and scrolls to the call panel", () => {
  const home = read("components", "kairo", "kairo-home.tsx");
  const block = home.slice(home.indexOf("// share link: start"), home.indexOf("// share link: end"));
  assert.ok(block.length > 0, "the share link block is in kairo-home.tsx");
  assert.match(block, /readShare\(window\.location\.search, MARKETS\)/);
  assert.match(block, /setSelected\(/);
  assert.match(block, /setFrame\(/);
  for (const bad of [/setSide\(/, /setAmount\(/, /setBacking\(/, /\.call\(/, /makeCall|placeCall|useMakeCall|writeContract/, /usePlayer|address/]) {
    assert.doesNotMatch(block, bad);
  }
  // nothing in the share code itself can reach the wallet or the contract
  assert.doesNotMatch(read("lib", "share-link.ts"), /^import /m);
});

test("the share button is on the round that takes calls, and the call panel shows the note", () => {
  const live = read("components", "kairo", "live-calls.tsx");
  assert.match(live, /testId="share-round"/);
  assert.match(read("components", "kairo", "share-button.tsx"), /data-testid={testId}/);
  assert.match(live, /shareUrl\(window\.location\.origin, market\.id, roundIndex\)/);
  assert.match(read("components", "kairo", "your-call.tsx"), /data-testid="shared-note"/);
});
