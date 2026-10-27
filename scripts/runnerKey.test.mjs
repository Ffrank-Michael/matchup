import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { runnerKeyFor, mainnetPusher } from './runnerKey.mjs';

// three throwaway test keys (made up for these tests, never funded)
const K1 = '0x' + '11'.repeat(32);
const K2 = '0x' + '22'.repeat(32);
const K3 = '0x' + '33'.repeat(32);
const addr = (k) => privateKeyToAccount(k).address;

test('mainnet runner key: RUNNER_PRIVATE_KEY only, the deployer key is never used', () => {
  assert.equal(runnerKeyFor('mainnet', { RUNNER_PRIVATE_KEY: K1, MAINNET_DEPLOYER_PRIVATE_KEY: K2 }).key, K1);
  assert.throws(() => runnerKeyFor('mainnet', { MAINNET_DEPLOYER_PRIVATE_KEY: K2, DEPLOYER_PRIVATE_KEY: K3 }), /RUNNER_PRIVATE_KEY is missing/);
  assert.throws(() => runnerKeyFor('mainnet', { RUNNER_PRIVATE_KEY: 'nope' }), /not 0x \+ 64 hex/);
});

test('testnet runner key: its own key if set, else the deployer key', () => {
  assert.deepEqual(runnerKeyFor('testnet', { DEPLOYER_PRIVATE_KEY: K2 }), { key: K2, source: 'DEPLOYER_PRIVATE_KEY' });
  assert.deepEqual(runnerKeyFor('testnet', { DEPLOYER_PRIVATE_KEY: K2, RUNNER_PRIVATE_KEY: K1 }), { key: K1, source: 'RUNNER_PRIVATE_KEY' });
  assert.throws(() => runnerKeyFor('testnet', {}), /DEPLOYER_PRIVATE_KEY/);
});

test('mainnet pusher is the address of RUNNER_PRIVATE_KEY', () => {
  const r = mainnetPusher({ RUNNER_PRIVATE_KEY: K1, MAINNET_DEPLOYER_PRIVATE_KEY: K2 });
  assert.equal(r.address, addr(K1));
  assert.deepEqual(r.problems, []);
});

test('mainnet pusher: refuses a missing key, a bad key, and a key that is also the deployer or the owner', () => {
  assert.match(mainnetPusher({}).problems[0], /RUNNER_PRIVATE_KEY is missing/);
  assert.match(mainnetPusher({ RUNNER_PRIVATE_KEY: 'x' }).problems[0], /not 0x \+ 64 hex/);
  assert.match(mainnetPusher({ RUNNER_PRIVATE_KEY: K1, MAINNET_DEPLOYER_PRIVATE_KEY: K1 }).problems[0], /same key as MAINNET_DEPLOYER_PRIVATE_KEY/);
  assert.match(mainnetPusher({ RUNNER_PRIVATE_KEY: K1, DEPLOYER_PRIVATE_KEY: K1 }).problems[0], /testnet deployer key/);
  assert.match(mainnetPusher({ RUNNER_PRIVATE_KEY: K1, FINAL_OWNER_ADDRESS: addr(K1) }).problems[0], /FINAL_OWNER_ADDRESS/);
  assert.match(mainnetPusher({ RUNNER_PRIVATE_KEY: K1 }, [['the Trend Follower wallet', addr(K1).toLowerCase()]]).problems[0], /Trend Follower wallet/);
});

test('no secret is ever put into a message', () => {
  const all = [
    ...mainnetPusher({ RUNNER_PRIVATE_KEY: K1, MAINNET_DEPLOYER_PRIVATE_KEY: K1 }).problems,
    ...mainnetPusher({ RUNNER_PRIVATE_KEY: K1 + 'zz' }).problems,
  ].join(' ');
  assert.ok(!all.includes('1111') && !all.includes(K1));
  try { runnerKeyFor('mainnet', { RUNNER_PRIVATE_KEY: K3 + 'q' }); } catch (e) { assert.ok(!e.message.includes('3333')); }
});
