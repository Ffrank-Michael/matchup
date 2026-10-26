// Tests for the site's market list copy (no network).  Run:  node --test scripts/sync-web-deployment.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { toWebDeployment, syncWebDeployment } from './sync-web-deployment.mjs';

const ARENA = '0xec52762e8f91b2380d39cf2d03101412a8a3530c';
const rec = (markets) => ({ network: 'arc-testnet', chainId: 5042002, arena: { address: ARENA, tx: '0xsecret-looking-but-public' }, owner: '0x1', markets, guards: {}, feeds: {} });
const m = (id, name, round, offset) => ({ id, name, coin: name.slice(0, 3).toLowerCase(), round, offset, feed: '0xfeed', tx: '0xabc', block: 5 });

test('copies only the public market facts, sorted by id', () => {
  const out = toWebDeployment(rec([m(1, 'ETH/USD 5m', 300, 100), m(0, 'BTC/USD 5m', 300, 0)]));
  assert.deepEqual(out.markets.map((x) => x.id), [0, 1]);
  assert.deepEqual(Object.keys(out.markets[0]).sort(), ['coin', 'feed', 'id', 'name', 'offset', 'round']);
  assert.deepEqual(Object.keys(out).sort(), ['arena', 'chainId', 'markets', 'network']);
  assert.equal(out.arena, ARENA);
});

test('refuses an unusable deployment with a plain message', () => {
  assert.throws(() => toWebDeployment(null), /empty/);
  assert.throws(() => toWebDeployment({ markets: [m(0, 'BTC/USD 5m', 300, 0)] }), /arena address/);
  assert.throws(() => toWebDeployment(rec([])), /no markets/);
  assert.throws(() => toWebDeployment(rec([m(0, 'BTC/USD 5m', 299, 0)])), /incomplete/);
  assert.throws(() => toWebDeployment(rec([m(0, 'BTC/USD 5m', 300, 300)])), /incomplete/);
  assert.throws(() => toWebDeployment(rec([m(0, 'BTC/USD 5m', 300, 0), m(0, 'ETH/USD 5m', 300, 100)])), /share an id/);
});

test('writes web/lib/deployment.generated.json, and says so when the deployment file is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-sync-'));
  fs.mkdirSync(path.join(root, 'deployments'));
  fs.mkdirSync(path.join(root, 'web', 'lib'), { recursive: true });
  assert.throws(() => syncWebDeployment({ network: 'mainnet', root }), /arc-mainnet\.json does not exist/);
  fs.writeFileSync(path.join(root, 'deployments', 'arc-testnet.json'), JSON.stringify(rec([m(0, 'BTC/USD 5m', 300, 0)])));
  const { to } = syncWebDeployment({ network: 'testnet', root });
  assert.equal(JSON.parse(fs.readFileSync(to, 'utf8')).markets[0].name, 'BTC/USD 5m');
});

test('the committed site copy matches the testnet deployment file', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const dep = JSON.parse(fs.readFileSync(path.join(root, 'deployments', 'arc-testnet.json'), 'utf8'));
  const copy = JSON.parse(fs.readFileSync(path.join(root, 'web', 'lib', 'deployment.generated.json'), 'utf8'));
  assert.deepEqual(copy, toWebDeployment(dep), 'run: node scripts/sync-web-deployment.mjs');
});
