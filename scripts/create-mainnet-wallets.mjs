// Kairo Markets: make the two mainnet wallets and write their keys into .env.
//
//   node scripts/create-mainnet-wallets.mjs
//
// Creates two brand-new wallets: the DEPLOYER (it will own the contracts) and the RUNNER (it pushes prices and settles; it becomes the
// relay feeds' pusher). Their keys are written to .env as MAINNET_DEPLOYER_PRIVATE_KEY and MAINNET_RUNNER_PRIVATE_KEY, and nowhere else.
// Only the two public ADDRESSES are printed: createWallets() returns nothing but addresses, so no key is ever in reach of a print.
//
// It refuses to run (and changes nothing) when .env does not exist, is not ignored by git, or already has a value for either key.
// An empty `NAME=` line (copied from .env.example) is filled in; otherwise the two lines are added at the end. Every other line
// stays exactly as it was. Nothing is sent to any chain and nothing is spent.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseEnv, ROOT } from './lib.mjs';

export const NAMES = ['MAINNET_DEPLOYER_PRIVATE_KEY', 'MAINNET_RUNNER_PRIVATE_KEY'];
const lineOf = (name) => new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`);
const valueOf = (raw) => raw.replace(/^(["'])(.*)\1$/, '$2');

/**
 * Puts the two keys into the text of an .env file. Returns { text } or { error } (the error names the setting, never a value).
 * `keys` is { MAINNET_DEPLOYER_PRIVATE_KEY, MAINNET_RUNNER_PRIVATE_KEY }.
 */
export function placeKeys(text, keys) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  for (const name of NAMES) {
    for (const line of lines) {
      const m = line.match(lineOf(name));
      if (m && valueOf(m[1])) return { error: `${name} already has a value in .env. Nothing was changed. Delete that line yourself first if you really want a new wallet (any funds in the old one are lost without its key).` };
    }
  }
  const missing = [];
  for (const name of NAMES) {
    const at = lines.findIndex((l) => lineOf(name).test(l)); // an empty placeholder line
    if (at >= 0) lines[at] = `${name}=${keys[name]}`;
    else missing.push(name);
  }
  if (missing.length) {
    if (lines[lines.length - 1] === '') lines.pop(); // the file's final newline
    lines.push('', '# Mainnet wallets made by scripts/create-mainnet-wallets.mjs (SECRET: never share, never commit)');
    for (const name of missing) lines.push(`${name}=${keys[name]}`);
    lines.push('');
  }
  return { text: lines.join(eol) };
}

/** git's own answer to "is this file ignored?" (so a missing git counts as no). */
export function gitIgnores(file, cwd = ROOT) {
  try { execFileSync('git', ['check-ignore', '-q', file], { cwd, stdio: 'ignore' }); return true; } catch { return false; }
}

/**
 * Makes the wallets and writes .env. Returns { addresses: { deployer, runner } } or { error }.
 * generate and isIgnored can be replaced (tests); the keys never leave this function.
 */
export function createWallets({ envPath = path.join(ROOT, '.env'), generate = generatePrivateKey, isIgnored = () => gitIgnores('.env') } = {}) {
  if (!fs.existsSync(envPath)) return { error: 'There is no .env file. Copy .env.example to .env first.' };
  if (!isIgnored()) return { error: '.env is not ignored by git, so keys written there could be committed. Add .env to .gitignore first. Nothing was changed.' };
  const original = fs.readFileSync(envPath, 'utf8');
  const keys = { MAINNET_DEPLOYER_PRIVATE_KEY: generate(), MAINNET_RUNNER_PRIVATE_KEY: generate() };
  const accounts = Object.fromEntries(NAMES.map((n) => [n, privateKeyToAccount(keys[n])]));
  if (accounts[NAMES[0]].address === accounts[NAMES[1]].address) return { error: 'The two wallets came out the same. Nothing was changed; run it again.' };
  const placed = placeKeys(original, keys);
  if (placed.error) return placed;

  // Write beside .env, then swap it in, so a crash can never leave a half-written .env.
  const temp = `${envPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, placed.text, { mode: 0o600 });
    fs.renameSync(temp, envPath);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    return { error: `Could not write .env (${e.code || 'error'}). Nothing was changed.` };
  }
  // Read it back: both keys must be there and give the printed addresses.
  const back = parseEnv(fs.readFileSync(envPath, 'utf8'));
  for (const n of NAMES) {
    if (back[n] !== keys[n]) return { error: `${n} did not come back correctly from .env. Check the file by hand before using it.` };
  }
  return { addresses: { deployer: accounts[NAMES[0]].address, runner: accounts[NAMES[1]].address } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = createWallets();
  if (r.error) { console.error(`STOP: ${r.error}`); process.exit(1); }
  console.log('Two new Arc mainnet wallets were created. Their keys are in .env (MAINNET_DEPLOYER_PRIVATE_KEY and MAINNET_RUNNER_PRIVATE_KEY). They are not shown here.\n');
  console.log(`  Deployer (will own the contracts) : ${r.addresses.deployer}`);
  console.log(`  Runner (pushes prices, settles)   : ${r.addresses.runner}`);
  console.log('\nNothing has been sent or spent. Keep a private backup of .env: if it is lost, so is any USDC in these wallets.');
  console.log('Next: node scripts/deploy.mjs --set mainnet   (a dry run: it only estimates the cost)');
}
