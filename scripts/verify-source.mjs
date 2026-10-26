// Publishes the source code of the deployed contracts on the Arc explorer (Blockscout) so anyone can read it.
// Reads addresses from deployments/arc-testnet.json (--set rehearsal, the default) or arc-mainnet.json (--set mainnet).
// Needs no secrets. Chainlink's own proxies (mainnet guards) are not ours and are skipped.
//   node scripts/verify-source.mjs [--set rehearsal|mainnet]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';
import { compile } from './compile.mjs';
import { COINS } from './markets.mjs';

const setArg = process.argv.indexOf('--set');
const SET_NAME = setArg >= 0 ? process.argv[setArg + 1] : 'rehearsal';
if (!['rehearsal', 'mainnet'].includes(SET_NAME)) throw new Error('--set must be rehearsal or mainnet');
const MAINNET = SET_NAME === 'mainnet';
const EXPLORER = MAINNET ? 'https://explorer.arc.io' : 'https://explorer.testnet.arc.io';
const COMPILER = 'v0.8.28+commit.7893614a';
const stateFile = path.join(ROOT, 'deployments', MAINNET ? 'arc-mainnet.json' : 'arc-testnet.json');
if (!fs.existsSync(stateFile)) throw new Error(`No ${path.basename(stateFile)} yet. Deploy first.`);
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const { standardInput } = compile();

const targets = [{ name: 'PredictionArena', address: st.arena.address }];
for (const coin of Object.keys(COINS)) {
  targets.push({ name: `GuardedRelayFeed (${COINS[coin].pair})`, address: st.feeds[coin].address });
  if (!MAINNET) targets.push({ name: `MockPriceFeed, Chainlink stand-in (${COINS[coin].pair})`, address: st.guards[coin].address });
}

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
