// Agent notes: the one-sentence reason each AI agent gave for its call (or "Couldn't decide this round"), for the website.
// Written to data/agent-notes.jsonl (local, for development) and, when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set,
// to Upstash Redis (free) where the website reads them. Nothing here ever throws: a missing note must never stop a bet.
//
// A note: { m: marketId, r: round, a: agent key, s: 'called' | 'skipped', c: 'UP' | 'DOWN' | null, t: text, at: unix seconds, model }
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../scripts/lib.mjs';

export const NOTES_FILE = path.join(ROOT, 'data', 'agent-notes.jsonl');
export const NOTE_TTL_SECONDS = 3 * 24 * 3600; // the site only shows the last day or two
export const noteKey = (n) => `kairo:note:${n.m}:${n.r}:${n.a}`;

export function createNotes({ env = process.env, fetchFn = fetch, file = NOTES_FILE, log = () => {} } = {}) {
  const url = String(env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
  const token = env.UPSTASH_REDIS_REST_TOKEN || '';
  let warned = false;
  return {
    remote: !!(url && token),
    async publish(note) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(note) + '\n');
      } catch (e) {
        log(`notes: could not write the local file (${String(e.message).slice(0, 80)})`);
      }
      if (!url || !token) return;
      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(['SET', noteKey(note), JSON.stringify(note), 'EX', NOTE_TTL_SECONDS]),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        if (!warned) { warned = true; log(`notes: could not save to Upstash (${String(e.message).slice(0, 80)}); the site will not show reasons until this works`); }
      }
    },
  };
}
