// Fails if PredictionArena's external function list differs from ci/abi-surface.txt.
// The list is the full set of ways anyone (owner included) can touch the contract, so any
// new function must be added to ci/abi-surface.txt on purpose, in a reviewed commit.
//   forge inspect PredictionArena methodIdentifiers --json | node ci/check-abi.js
const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  const actual = Object.keys(JSON.parse(input)).sort();
  const expected = fs.readFileSync(path.join(__dirname, 'abi-surface.txt'), 'utf8').split('\n').filter(Boolean);
  const added = actual.filter((s) => !expected.includes(s));
  const removed = expected.filter((s) => !actual.includes(s));
  added.forEach((s) => console.log(`NEW function not in ci/abi-surface.txt: ${s}`));
  removed.forEach((s) => console.log(`function missing from the contract: ${s}`));
  if (added.length || removed.length) process.exit(1);
  console.log(`external function list matches ci/abi-surface.txt (${actual.length} functions)`);
});
