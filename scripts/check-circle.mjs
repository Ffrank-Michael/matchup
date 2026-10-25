// Checks that Circle accepts the API key and the entity secret from .env.
// It NEVER prints the key or the secret (only yes/no format checks and Circle's answers).
//
//   node scripts/check-circle.mjs                      read-only: format checks + API key check
//   node scripts/check-circle.mjs --create-wallet-set  also creates one empty wallet set called
//                                                      "Kairo house agents". Creating anything needs
//                                                      the entity secret, so this is the real test
//                                                      that Circle accepts it.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { loadEnv, ROOT } from './lib.mjs';

const CREATE = process.argv.includes('--create-wallet-set');
const STATE = path.join(ROOT, 'deployments', 'circle-testnet.json');
const WALLET_SET_NAME = 'Kairo house agents';

const env = loadEnv();
const apiKey = env.CIRCLE_API_KEY || '';
const secret = env.CIRCLE_ENTITY_SECRET || '';

const yes = (b) => (b ? 'yes' : 'NO');
const parts = apiKey.split(':');
const formatOk = {
  'CIRCLE_API_KEY is set': apiKey.length > 0,
  'API key is a TESTNET key (starts with TEST_API_KEY:)': apiKey.startsWith('TEST_API_KEY:'),
  'API key is NOT a live (mainnet) key': !apiKey.startsWith('LIVE_API_KEY:'),
  'API key has the 3 parts PREFIX:ID:SECRET': parts.length === 3 && parts.every((p) => p.length > 0),
  'CIRCLE_ENTITY_SECRET is set': secret.length > 0,
  'entity secret is 64 hex characters (32 bytes)': /^[0-9a-fA-F]{64}$/.test(secret),
  'no quotes or spaces around either value': !/["'\s]/.test(apiKey) && !/["'\s]/.test(secret),
};
console.log('Format checks (values are not shown):');
for (const [k, v] of Object.entries(formatOk)) console.log(`  ${yes(v)}  ${k}`);
if (!Object.values(formatOk).every(Boolean)) {
  console.error('\nSTOP: fix the lines marked NO in .env, then run this again.');
  process.exit(1);
}

/** Error text that cannot contain the key: only HTTP status and Circle's own message. */
function safeError(e) {
  const status = e?.response?.status;
  const data = e?.response?.data;
  const msg = data?.message || data?.error || e?.code || 'request failed';
  return `${status ? 'HTTP ' + status + ': ' : ''}${String(msg).slice(0, 200)}`;
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret: secret });

try {
  // 1) API key: a read-only call that needs a valid key but not the entity secret.
  const sets = await client.listWalletSets({});
  const existing = sets.data?.walletSets || [];
  console.log(`\nAPI key: ACCEPTED by Circle. Wallet sets in this account: ${existing.length}.`);

  if (!CREATE) {
    console.log('Entity secret: not tested yet (needs a signed request). Re-run with --create-wallet-set.');
    process.exit(0);
  }

  // 2) Entity secret: creating a wallet set needs a fresh ciphertext of the secret on every request.
  const already = existing.find((w) => w.name === WALLET_SET_NAME);
  if (already) {
    console.log(`A wallet set called "${WALLET_SET_NAME}" already exists (id ${already.id}); not creating another.`);
    console.log('Entity secret: NOT re-tested this time (nothing needed signing).');
    process.exit(0);
  }
  const res = await client.createWalletSet({ name: WALLET_SET_NAME, idempotencyKey: randomUUID() });
  const ws = res.data?.walletSet;
  if (!ws?.id) throw new Error('Circle answered without a wallet set.');
  console.log(`Entity secret: ACCEPTED by Circle (it signed the request for a new wallet set).`);
  console.log(`Created wallet set "${ws.name}" with id ${ws.id}.`);
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ network: 'ARC-TESTNET', walletSetId: ws.id, walletSetName: ws.name, createdAt: ws.createDate || new Date().toISOString() }, null, 2) + '\n');
  console.log('Saved the (public) wallet set id to deployments/circle-testnet.json.');
} catch (e) {
  console.error('\nCircle said no: ' + safeError(e));
  process.exit(1);
}
