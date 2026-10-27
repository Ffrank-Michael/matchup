import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from './lib.mjs';

test('parseEnv: plain, quoted and commented lines', () => {
  const env = parseEnv('A=plain\r\nB="https://x.example"\nC=\'single\'\n# D=hidden\nE=  spaced  \nF="unmatched\nG=');
  assert.equal(env.A, 'plain');
  assert.equal(env.B, 'https://x.example');
  assert.equal(env.C, 'single');
  assert.equal('D' in env, false);
  assert.equal(env.E, 'spaced');
  assert.equal(env.F, '"unmatched');
  assert.equal(env.G, '');
});
