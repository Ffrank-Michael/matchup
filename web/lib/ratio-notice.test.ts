// node --test lib/ratio-notice.test.ts
// The coin-vs-coin trust text must say what really happens (audit part 2, P2-13): the ratio is on chain, the two trades are not
// published, so nobody may be told they can check a push against Bitfinex.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (...p: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, "..", ...p), "utf8");

test("no page claims a ratio push can be checked against Bitfinex", () => {
  for (const f of [["components", "kairo", "your-call.tsx"], ["app", "how-it-works", "page.tsx"]]) {
    const text = read(...f).replace(/\s+/g, " ");
    assert.doesNotMatch(text, /can be checked against Bitfinex/, f.join("/"));
    assert.match(text, /kept only in the runner&apos;s own log/, f.join("/"));
  }
});
