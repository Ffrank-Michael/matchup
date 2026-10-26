// Creates the four house-agent wallets (Circle developer-controlled, EOA, Arc testnet) inside the
// "Kairo house agents" wallet set. Safe to re-run: it never creates a second batch.
// Only public information (wallet ids and addresses) is printed or saved.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { loadEnv, ROOT } from './lib.mjs';

const STATE = path.join(ROOT, 'deployments', 'circle-testnet.json');
const AGENTS = [
  { key: 'trend-follower', name: 'Kairo Trend follower' },
  { key: 'contrarian', name: 'Kairo Contrarian' },
  { key: 'chart-reader', name: 'Kairo Chart reader' },
  { key: 'coin-flipper', name: 'Kairo Coin flipper' },
];

const env = loadEnv();
if (!String(env.CIRCLE_API_KEY || '').startsWith('TEST_API_KEY:')) {
  console.error('STOP: CIRCLE_API_KEY must be a TEST_API_KEY (testnet) key.');
  process.exit(1);
}
if (!fs.existsSync(STATE)) { console.error('STOP: run scripts/check-circle.mjs --create-wallet-set first.'); process.exit(1); }
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));

const client = initiateDeveloperControlledWalletsClient({ apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET });
const safeError = (e) => `${e?.response?.status ? 'HTTP ' + e.response.status + ': ' : ''}${String(e?.response?.data?.message || e?.code || e?.message || 'request failed').slice(0, 200)}`;

function show(agents) {
  for (const a of agents) console.log(`  ${a.name.padEnd(22)} ${a.address}\n  ${' '.repeat(22)} https://explorer.testnet.arc.io/address/${a.address}`);
}

try {
  const have = (await client.listWallets({ walletSetId: state.walletSetId })).data?.wallets || [];
  if (have.length > 0) {
    console.log(`The wallet set already has ${have.length} wallet(s); not creating more.`);
    show(have.map((w) => ({ name: w.name || w.refId, address: w.address })));
    process.exit(0);
  }
  const res = await client.createWallets({
    idempotencyKey: randomUUID(),
    walletSetId: state.walletSetId,
    blockchains: ['ARC-TESTNET'],
    accountType: 'EOA',
    count: AGENTS.length,
    metadata: AGENTS.map((a) => ({ name: a.name, refId: a.key })),
  });
  const wallets = res.data?.wallets || [];
  if (wallets.length !== AGENTS.length) throw new Error(`Expected ${AGENTS.length} wallets, Circle returned ${wallets.length}.`);
  state.agents = wallets.map((w, i) => ({ key: AGENTS[i].key, name: AGENTS[i].name, walletId: w.id, address: w.address, blockchain: w.blockchain, accountType: w.accountType }));
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  console.log('Created 4 wallets on ARC-TESTNET (EOA):');
  show(state.agents);
  console.log('\nSaved ids and addresses (public information only) to deployments/circle-testnet.json.');
} catch (e) {
  console.error('Circle said no: ' + safeError(e));
  process.exit(1);
}
