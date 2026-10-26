// node --test runner/supervise.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { restartDelay, notify, BASE_DELAY_S, LOOP_DELAY_S } from './supervise.mjs';

test('one stop waits the short delay', () => {
  assert.deepEqual(restartDelay([1000], 1000), { seconds: BASE_DELAY_S, loop: false });
});

test('five stops within ten minutes is a crash loop and waits five minutes', () => {
  const now = 10_000;
  assert.deepEqual(restartDelay([now - 500, now - 400, now - 300, now - 200, now], now), { seconds: LOOP_DELAY_S, loop: true });
  assert.equal(restartDelay([now - 500, now - 400, now - 300, now], now).loop, false);
});

test('old stops do not count towards a crash loop', () => {
  const now = 10_000;
  assert.equal(restartDelay([now - 5000, now - 4000, now - 3000, now - 2000, now], now).loop, false);
});

test('notify posts one plain line to the topic and never throws', async () => {
  const calls = [];
  const ok = await notify('my-topic', 'T', 'hello', async (url, init) => { calls.push([url, init.body, init.headers.Title]); return { ok: true }; });
  assert.equal(ok, true);
  assert.deepEqual(calls, [['https://ntfy.sh/my-topic', 'hello', 'T']]);
  assert.equal(await notify('', 'T', 'x', async () => { throw new Error('should not be called'); }), false);
  assert.equal(await notify('t', 'T', 'x', async () => { throw new Error('offline'); }), false);
});
