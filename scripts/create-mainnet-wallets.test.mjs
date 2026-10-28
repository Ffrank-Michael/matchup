// node --test scripts/create-mainnet-wallets.test.mjs
// Throwaway keys and a temp folder: nothing here touches the real .env.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { parseEnv } from './lib.mjs';
import { placeKeys, createWallets, NAMES } from './create-mainnet-wallets.mjs';

const K_DEP = '0x' + 'aa'.repeat(32);
const K_RUN = '0x' + 'bb'.repeat(32);
const KEYS = { MAINNET_DEPLOYER_PRIVATE_KEY: K_DEP, MAINNET_RUNNER_PRIVATE_KEY: K_RUN };
const seq = (...keys) => { let i = 0; return () => keys[i++]; };
const tempEnv = (text) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-env-')); const p = path.join(dir, '.env'); if (text !== null) fs.writeFileSync(p, text); return p; };
const ok = () => true;

test('placeKeys: two new lines are added at the end, everything else stays exactly as it was', () => {
  const before = 'A=1\n# a comment\nNTFY_TOPIC=abc\n';
  const { text } = placeKeys(before, KEYS);
  assert.ok(text.startsWith(before));
  const env = parseEnv(text);
  assert.equal(env.MAINNET_DEPLOYER_PRIVATE_KEY, K_DEP);
  assert.equal(env.MAINNET_RUNNER_PRIVATE_KEY, K_RUN);
  assert.equal(env.A, '1');
  assert.ok(text.endsWith('\n'));
});

test('placeKeys: a file without a final newline, and a Windows (CRLF) file, are handled', () => {
  assert.equal(parseEnv(placeKeys('A=1', KEYS).text).MAINNET_RUNNER_PRIVATE_KEY, K_RUN);
  const crlf = placeKeys('A=1\r\nB=2\r\n', KEYS).text;
  assert.ok(!/[^\r]\n/.test(crlf), 'every line break stays CRLF');
  assert.equal(parseEnv(crlf).B, '2');
});

test('placeKeys: empty placeholder lines (from .env.example) are filled in place; commented lines are ignored', () => {
  const before = '# MAINNET_DEPLOYER_PRIVATE_KEY=\nMAINNET_DEPLOYER_PRIVATE_KEY=\nX=1\nMAINNET_RUNNER_PRIVATE_KEY=   \n';
  const { text } = placeKeys(before, KEYS);
  assert.equal(text, `# MAINNET_DEPLOYER_PRIVATE_KEY=\nMAINNET_DEPLOYER_PRIVATE_KEY=${K_DEP}\nX=1\nMAINNET_RUNNER_PRIVATE_KEY=${K_RUN}\n`);
});

test('placeKeys: refuses when either key already has a value, quoted or not, and says only the name', () => {
  for (const line of [`MAINNET_DEPLOYER_PRIVATE_KEY=${'0x' + 'cc'.repeat(32)}`, `MAINNET_RUNNER_PRIVATE_KEY="${'0x' + 'cc'.repeat(32)}"`, '  MAINNET_RUNNER_PRIVATE_KEY = x']) {
    const r = placeKeys(`A=1\n${line}\n`, KEYS);
    assert.match(r.error, /MAINNET_(DEPLOYER|RUNNER)_PRIVATE_KEY already has a value/);
    assert.ok(!r.error.includes('cc'.repeat(8)));
    assert.equal(r.text, undefined);
  }
});

test('createWallets: writes both keys, returns only the two addresses', () => {
  const p = tempEnv('A=1\n');
  const r = createWallets({ envPath: p, generate: seq(K_DEP, K_RUN), isIgnored: ok });
  assert.deepEqual(Object.keys(r), ['addresses']);
  assert.deepEqual(r.addresses, { deployer: privateKeyToAccount(K_DEP).address, runner: privateKeyToAccount(K_RUN).address });
  const env = parseEnv(fs.readFileSync(p, 'utf8'));
  assert.equal(env.MAINNET_DEPLOYER_PRIVATE_KEY, K_DEP);
  assert.equal(env.MAINNET_RUNNER_PRIVATE_KEY, K_RUN);
  assert.equal(env.A, '1');
  assert.ok(!JSON.stringify(r).includes('aaaaaaaa') && !JSON.stringify(r).includes('bbbbbbbb'), 'no key in the result');
  assert.deepEqual(fs.readdirSync(path.dirname(p)), ['.env'], 'no temp file is left behind');
});

test('createWallets: refuses to overwrite an existing key and leaves .env byte for byte as it was', () => {
  for (const have of [NAMES[0], NAMES[1]]) {
    const before = `A=1\n${have}=${'0x' + 'dd'.repeat(32)}\n`;
    const p = tempEnv(before);
    const r = createWallets({ envPath: p, generate: seq(K_DEP, K_RUN), isIgnored: ok });
    assert.match(r.error, /already has a value/);
    assert.equal(fs.readFileSync(p, 'utf8'), before);
  }
});

test('createWallets: refuses when .env is missing or not ignored by git, and changes nothing', () => {
  assert.match(createWallets({ envPath: tempEnv(null), generate: seq(K_DEP, K_RUN), isIgnored: ok }).error, /no .env file/);
  const p = tempEnv('A=1\n');
  const r = createWallets({ envPath: p, generate: seq(K_DEP, K_RUN), isIgnored: () => false });
  assert.match(r.error, /not ignored by git/);
  assert.equal(fs.readFileSync(p, 'utf8'), 'A=1\n');
});

test('createWallets: two identical wallets are refused (the keys must differ)', () => {
  const p = tempEnv('A=1\n');
  assert.match(createWallets({ envPath: p, generate: seq(K_DEP, K_DEP), isIgnored: ok }).error, /came out the same/);
  assert.equal(fs.readFileSync(p, 'utf8'), 'A=1\n');
});

test('createWallets: running it twice with real random keys: the second run refuses', () => {
  const p = tempEnv('A=1\n');
  assert.ok(createWallets({ envPath: p, isIgnored: ok }).addresses);
  const once = fs.readFileSync(p, 'utf8');
  assert.match(createWallets({ envPath: p, isIgnored: ok }).error, /already has a value/);
  assert.equal(fs.readFileSync(p, 'utf8'), once);
});

test('source: the only values the script prints are addresses and error messages', () => {
  const src = fs.readFileSync(new URL('./create-mainnet-wallets.mjs', import.meta.url), 'utf8');
  const prints = src.split('\n').filter((l) => /console\.(log|error)/.test(l));
  assert.ok(prints.length >= 4);
  const shown = prints.flatMap((l) => [...l.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]));
  assert.ok(shown.length >= 3);
  for (const expr of shown) assert.match(expr, /^r\.(addresses\.(deployer|runner)|error)$/, `prints ${expr}`);
  for (const l of prints) assert.match(l, /console\.(log|error)\(['`]/, 'every print starts with a plain message');
});
