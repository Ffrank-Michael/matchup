// node --test scripts/make-server-env.test.mjs
// The server settings file (audit part 2, P2-03). Throwaway values in a temp folder: the real .env is never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from './lib.mjs';
import { serverEnvText, makeServerEnv, SERVER_NAMES, NEVER_ON_SERVER, SERVER_ENV_FILE } from './make-server-env.mjs';
import { RUNNER_ENV_NAMES } from '../runner/mainnet.mjs';

const OWNER = '0x' + 'aa'.repeat(32);
const RUNNER = '0x' + 'bb'.repeat(32);
const PC = [
  `MAINNET_DEPLOYER_PRIVATE_KEY=${OWNER}`,
  `MAINNET_RUNNER_PRIVATE_KEY=${RUNNER}`,
  'MAINNET_ARENA_ADDRESS=0x' + '11'.repeat(20),
  'DEPLOYER_PRIVATE_KEY=0x' + 'cc'.repeat(32),
  'CIRCLE_API_KEY=TEST_API_KEY:x:y', 'CIRCLE_ENTITY_SECRET=s', 'GEMINI_API_KEY=g', 'NTFY_TOPIC=t',
  'UPSTASH_REDIS_REST_URL=https://u.example', 'UPSTASH_REDIS_REST_TOKEN=tok',
  'FINAL_OWNER_ADDRESS=0x' + '22'.repeat(20), 'SOMETHING_ELSE=q', 'EMPTY_ONE=',
].join('\r\n');

test('the mainnet owner key is never in the server file', () => {
  const { text, left } = serverEnvText(PC);
  assert.ok(!text.includes(OWNER));
  assert.ok(!/MAINNET_DEPLOYER_PRIVATE_KEY/.test(text));
  assert.ok(left.includes('MAINNET_DEPLOYER_PRIVATE_KEY'));
  assert.ok(NEVER_ON_SERVER.every((n) => !SERVER_NAMES.includes(n)), 'not in the list either');
});

test('only the names the server needs are copied, with their values unchanged', () => {
  const { text, written, left } = serverEnvText(PC);
  const env = parseEnv(text);
  assert.equal(env.MAINNET_RUNNER_PRIVATE_KEY, RUNNER);
  assert.equal(env.CIRCLE_API_KEY, 'TEST_API_KEY:x:y');
  assert.deepEqual(Object.keys(env).sort(), [...written].sort());
  assert.ok(written.every((n) => SERVER_NAMES.includes(n)));
  for (const n of ['FINAL_OWNER_ADDRESS', 'SOMETHING_ELSE']) { assert.ok(!(n in env)); assert.ok(left.includes(n)); }
  assert.ok(!left.includes('EMPTY_ONE') && !('EMPTY_ONE' in env), 'empty values are neither copied nor listed');
});

test('everything the mainnet runner reads from .env is on the server list', () => {
  for (const n of RUNNER_ENV_NAMES) assert.ok(SERVER_NAMES.includes(n), n);
});

test('makeServerEnv writes .env.server beside .env and refuses when git would not ignore it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matchup-server-env-'));
  fs.writeFileSync(path.join(dir, '.env'), PC);
  assert.match(makeServerEnv({ root: dir, isIgnored: () => false }).error, /would not be ignored by git/);
  assert.ok(!fs.existsSync(path.join(dir, SERVER_ENV_FILE)));
  const r = makeServerEnv({ root: dir, isIgnored: () => true });
  assert.equal(r.error, undefined);
  const written = fs.readFileSync(path.join(dir, SERVER_ENV_FILE), 'utf8');
  assert.ok(!written.includes(OWNER));
  assert.equal(parseEnv(written).MAINNET_RUNNER_PRIVATE_KEY, RUNNER);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.env', SERVER_ENV_FILE], 'no temp file left behind');
});

test('makeServerEnv: no .env, nothing written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matchup-server-env-'));
  assert.match(makeServerEnv({ root: dir, isIgnored: () => true }).error, /no \.env/);
});
