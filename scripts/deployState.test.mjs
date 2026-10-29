import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrArchiveState, wouldArchive, CONTRACT_VERSION } from './deployState.mjs';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deploystate-'));
const write = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n');

test('no state file: nothing to load, nothing archived', () => {
  const d = dir();
  assert.deepEqual(loadOrArchiveState(path.join(d, 'm.json'), path.join(d, 'm-v1.json')), { state: null, archived: null });
  assert.equal(wouldArchive(path.join(d, 'm.json')), null);
});

test('the old (v1) file is copied to the archive first and a fresh state starts', () => {
  const d = dir(); const f = path.join(d, 'm.json'); const a = path.join(d, 'm-v1.json');
  write(f, { network: 'arc-mainnet', arena: { address: '0xold' } });
  assert.equal(wouldArchive(f), 'm.json');
  const r = loadOrArchiveState(f, a);
  assert.equal(r.state, null);
  assert.equal(r.archived, a);
  assert.equal(fs.readFileSync(a, 'utf8'), fs.readFileSync(f, 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(a, 'utf8')).arena.address, '0xold');
});

test('a v2 file is a deployment in progress: it is loaded and nothing is archived', () => {
  const d = dir(); const f = path.join(d, 'm.json'); const a = path.join(d, 'm-v1.json');
  write(f, { contractVersion: CONTRACT_VERSION, arena: { address: '0xnew' } });
  assert.equal(wouldArchive(f), null);
  const r = loadOrArchiveState(f, a);
  assert.equal(r.state.arena.address, '0xnew');
  assert.equal(r.archived, null);
  assert.equal(fs.existsSync(a), false);
});

test('an existing, different archive is never overwritten', () => {
  const d = dir(); const f = path.join(d, 'm.json'); const a = path.join(d, 'm-v1.json');
  write(f, { arena: { address: '0xold' } });
  write(a, { arena: { address: '0xother' } });
  assert.throws(() => loadOrArchiveState(f, a), /already exists and is different/);
  assert.equal(JSON.parse(fs.readFileSync(a, 'utf8')).arena.address, '0xother');
});

test('running again after the archive was made (same content) is fine', () => {
  const d = dir(); const f = path.join(d, 'm.json'); const a = path.join(d, 'm-v1.json');
  write(f, { arena: { address: '0xold' } });
  loadOrArchiveState(f, a);
  assert.equal(loadOrArchiveState(f, a).archived, a);
});
