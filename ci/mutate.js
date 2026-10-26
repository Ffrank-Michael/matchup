// Applies ONE mutation from ci/mutations.json to its contract (contracts/PredictionArena.sol, or the file named in the break's "file" field).
//   node ci/mutate.js check          -> verifies every `find` text occurs exactly `count` times (default 1)
//   node ci/mutate.js apply <id>     -> rewrites the contract with that mutation (CI only; never commit the result)
//   node ci/mutate.js list           -> prints the ids as a JSON array (used to build the CI matrix)
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const fileOf = (m) => path.join(root, 'contracts', m.file || 'PredictionArena.sol');
const muts = JSON.parse(fs.readFileSync(path.join(__dirname, 'mutations.json'), 'utf8'));
const cmd = process.argv[2];

function count(text, needle) {
  return text.split(needle).length - 1;
}

if (cmd === 'list') {
  // optional filter: ONLY="P26,M01" (comma separated); empty means all
  const only = (process.env.ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
  const pick = only.length ? muts.filter((m) => only.includes(m.id)) : muts;
  if (only.length && pick.length !== only.length) { console.error('unknown id in ONLY'); process.exit(2); }
  console.log(JSON.stringify(pick.map((m) => m.id)));
} else if (cmd === 'check') {
  let bad = 0;
  const ids = new Set();
  for (const m of muts) {
    const src = fs.readFileSync(fileOf(m), 'utf8');
    const want = m.count || 1;
    const got = count(src, m.find);
    if (ids.has(m.id)) { console.log(`DUPLICATE ID ${m.id}`); bad++; }
    ids.add(m.id);
    if (got !== want) { console.log(`BAD ${m.id}: found ${got} times, expected ${want}`); bad++; }
    if (m.find === m.replace) { console.log(`BAD ${m.id}: replace equals find`); bad++; }
  }
  console.log(bad ? `${bad} problem(s)` : `all ${muts.length} mutations OK`);
  process.exit(bad ? 1 : 0);
} else if (cmd === 'apply') {
  const m = muts.find((x) => x.id === process.argv[3]);
  if (!m) { console.error('unknown mutation id'); process.exit(2); }
  const file = fileOf(m);
  const src = fs.readFileSync(file, 'utf8');
  const want = m.count || 1;
  if (count(src, m.find) !== want) { console.error(`${m.id}: anchor count mismatch`); process.exit(2); }
  fs.writeFileSync(file, src.split(m.find).join(m.replace));
  console.log(`applied ${m.id}: ${m.desc}`);
} else {
  console.error('usage: node ci/mutate.js check | list | apply <id>');
  process.exit(2);
}
