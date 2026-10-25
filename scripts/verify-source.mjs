// Publishes the source code of the deployed contracts on the Arc testnet explorer (Blockscout)
// so anyone can read it. Reads addresses from deployments/arc-testnet.json. Needs no secrets.
//   node scripts/verify-source.mjs
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';
import { compile } from './compile.mjs';

const EXPLORER = 'https://explorer.testnet.arc.io';
const COMPILER = 'v0.8.28+commit.7893614a';
const stateFile = path.join(ROOT, 'deployments', 'arc-testnet.json');
if (!fs.existsSync(stateFile)) throw new Error('No deployments/arc-testnet.json yet. Deploy first.');
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const { standardInput } = compile();

const targets = [
  { name: 'PredictionArena', address: st.arena.address },
  { name: 'MockPriceFeed (BTC/USD)', address: st.feeds.btc.address },
  { name: 'MockPriceFeed (ETH/USD)', address: st.feeds.eth.address },
  { name: 'MockPriceFeed (SOL/USD)', address: st.feeds.sol.address },
];

async function status(address) {
  const r = await fetch(`${EXPLORER}/api/v2/smart-contracts/${address}`);
  if (!r.ok) return null;
  return r.json();
}

let failed = 0;
for (const t of targets) {
  const before = await status(t.address);
  if (before && before.is_verified) {
    console.log(`${t.name}: already verified (${before.is_fully_verified ? 'full' : 'partial'} match)`);
    continue;
  }
  const form = new FormData();
  form.append('compiler_version', COMPILER);
  form.append('license_type', 'mit');
  form.append('autodetect_constructor_args', 'true');
  form.append('files[0]', new Blob([JSON.stringify(standardInput)], { type: 'application/json' }), 'standard-input.json');
  const res = await fetch(`${EXPLORER}/api/v2/smart-contracts/${t.address}/verification/via/standard-input`, { method: 'POST', body: form });
  const body = await res.text();
  console.log(`${t.name}: submitted (HTTP ${res.status}) ${body.slice(0, 200)}`);
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const now = await status(t.address);
    if (now && now.is_verified) {
      ok = true;
      console.log(`${t.name}: VERIFIED (${now.is_fully_verified ? 'full' : 'partial'} match) ${EXPLORER}/address/${t.address}?tab=contract`);
    }
  }
  if (!ok) { failed++; console.log(`${t.name}: NOT verified yet. Check ${EXPLORER}/address/${t.address}`); }
}
process.exit(failed ? 1 : 0);
