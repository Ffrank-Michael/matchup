// Matchup: write the settings file for the SERVER, with only what the runner needs (audit part 2, P2-03).
//
//   node scripts/make-server-env.mjs
//
// Reads this PC's .env and writes .env.server next to it, holding ONLY the names in SERVER_NAMES (the testnet and mainnet
// runners, their supervisor, the AI guide calls and the alerts). The mainnet OWNER key (MAINNET_DEPLOYER_PRIVATE_KEY) is never
// written: it can hand price control to anyone (docs/RUNBOOK.md, section 1), so it must not be on a server. Nor is anything else
// the server does not use (deploy-only addresses, other keys you may keep in .env).
// Then copy .env.server to the server as its .env (docs/MAINNET_AGENTS.md, step 6) and delete it from this PC.
//
// It prints only NAMES, never a value. It refuses to run when .env.server would not be ignored by git.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, ROOT } from './lib.mjs';
import { gitIgnores } from './create-mainnet-wallets.mjs';

/** Every name the server's code reads (runner/, agents/, scripts/lib.mjs and runnerKey.mjs). Nothing else is copied. */
export const SERVER_NAMES = [
  // the mainnet runner (runner/mainnet.mjs, RUNNER_ENV_NAMES)
  'MAINNET_RUNNER_PRIVATE_KEY', 'MAINNET_ARENA_ADDRESS', 'ARC_MAINNET_RPC_URL', 'USDC_ADDRESS',
  // the testnet runner (runner/run.mjs): its own key, or the testnet deployer key that owns the rehearsal feeds; the house agents' Circle wallets
  'RUNNER_PRIVATE_KEY', 'DEPLOYER_PRIVATE_KEY', 'ARC_TESTNET_RPC_URL', 'ARC_TESTNET_CHAIN_ID', 'CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET', 'AI_MARKETS',
  // the AI agents and the guide calls
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_FALLBACK_MODEL', 'GEMINI_TIMEOUT_SECONDS', 'GEMINI_FALLBACK_TIMEOUT_SECONDS',
  'GEMINI_MAX_CALLS_PER_DAY', 'GEMINI_MAX_PER_MINUTE', 'GEMINI_PRICE_IN_PER_M', 'GEMINI_PRICE_OUT_PER_M',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  // the phone alerts (supervisor and pusher watch)
  'NTFY_TOPIC',
];
/** Never written to the server file, whatever SERVER_NAMES says. */
export const NEVER_ON_SERVER = ['MAINNET_DEPLOYER_PRIVATE_KEY'];
export const SERVER_ENV_FILE = '.env.server';

/**
 * The server file's text from the PC's .env text. Pure, so it can be tested.
 * Returns { text, written: [names], left: [names in .env that were not copied] }. Empty values are not copied.
 */
export function serverEnvText(pcText) {
  const env = parseEnv(pcText);
  const written = SERVER_NAMES.filter((n) => !NEVER_ON_SERVER.includes(n) && env[n]);
  const left = Object.keys(env).filter((n) => !written.includes(n) && env[n]).sort();
  const lines = [
    '# Matchup runner settings for the SERVER, made by scripts/make-server-env.mjs from the PC .env.',
    '# Only what the runner needs. The mainnet owner key is never in this file. Keep it chmod 600.',
    ...written.map((n) => `${n}=${env[n]}`),
  ];
  return { text: lines.join('\n') + '\n', written, left };
}

/** Writes .env.server. Returns { written, left, file } or { error } (errors name a setting or a file, never a value). */
export function makeServerEnv({ root = ROOT, isIgnored = () => gitIgnores(SERVER_ENV_FILE, root) } = {}) {
  const pcFile = path.join(root, '.env');
  if (!fs.existsSync(pcFile)) return { error: 'There is no .env file on this PC.' };
  if (!isIgnored()) return { error: `${SERVER_ENV_FILE} would not be ignored by git, so it could be committed. Nothing was written.` };
  const { text, written, left } = serverEnvText(fs.readFileSync(pcFile, 'utf8'));
  for (const n of NEVER_ON_SERVER) if (parseEnv(text)[n]) return { error: `${n} ended up in the server file. Nothing was written.` }; // belt and braces
  const file = path.join(root, SERVER_ENV_FILE);
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
  return { written, left, file };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = makeServerEnv();
  if (r.error) { console.error('STOP: ' + r.error); process.exit(1); }
  console.log(`Wrote ${SERVER_ENV_FILE} with ${r.written.length} settings (names only): ${r.written.join(', ')}`);
  console.log(`Not copied (not needed on the server${r.left.includes('MAINNET_DEPLOYER_PRIVATE_KEY') ? ', and the mainnet owner key never is' : ''}): ${r.left.join(', ') || 'none'}`);
  console.log(`\nNext (PowerShell on this PC), see docs/MAINNET_AGENTS.md step 6:`);
  console.log(`  ssh -i <KEY> ubuntu@<SERVER_IP> "umask 077 && touch /home/ubuntu/arc-arena/.env"`);
  console.log(`  scp -i <KEY> ${SERVER_ENV_FILE} ubuntu@<SERVER_IP>:/home/ubuntu/arc-arena/.env`);
  console.log(`Then delete ${SERVER_ENV_FILE} from this PC.`);
}
