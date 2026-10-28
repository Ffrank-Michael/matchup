import test from 'node:test';
import assert from 'node:assert/strict';
import { deployMode, UNDERSTAND_FLAG } from './deployFlags.mjs';

test('mainnet: no flag is a dry run, the long flag sends, --send alone is refused', () => {
  assert.deepEqual(deployMode([], { mainnet: true }), { send: false, error: null });
  assert.deepEqual(deployMode(['--set', 'mainnet'], { mainnet: true }), { send: false, error: null });
  assert.deepEqual(deployMode([UNDERSTAND_FLAG], { mainnet: true }), { send: true, error: null });
  assert.deepEqual(deployMode(['--send', UNDERSTAND_FLAG], { mainnet: true }), { send: true, error: null });
  const r = deployMode(['--send'], { mainnet: true });
  assert.equal(r.send, false);
  assert.match(r.error, /Mainnet spends real USDC/);
});

test('mainnet: --verify-only never sends, even with the flag', () => {
  assert.equal(deployMode(['--verify-only', UNDERSTAND_FLAG], { mainnet: true }).send, false);
});

test('testnet is unchanged: --send sends, the long flag means nothing', () => {
  assert.deepEqual(deployMode([], { mainnet: false }), { send: false, error: null });
  assert.deepEqual(deployMode(['--send'], { mainnet: false }), { send: true, error: null });
  assert.deepEqual(deployMode([UNDERSTAND_FLAG], { mainnet: false }), { send: false, error: null });
});
