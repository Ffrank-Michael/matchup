// Copies the PUBLIC part of the deployment file into the site (web/lib/deployment.generated.json), so the site reads its
// market list (and the arena address) from the deployment instead of a hard-coded list. The site is built from web/ alone
// and cannot import files outside it, which is why this copy exists.
//   node scripts/sync-web-deployment.mjs              testnet rehearsal (deployments/arc-testnet.json), or mainnet when
//                                                      NEXT_PUBLIC_NETWORK=mainnet (deployments/arc-mainnet.json), set in the
//                                                      environment or in web/.env.local (the environment wins)
// Only public facts are copied: network, chain id, arena address, and for each market its id, name, coin, round length,
// offset and feed address. The script runs before `npm run dev` and `npm run build` in web/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The public part of a deployment record. Throws with a plain message if the record is not usable. */
/** The house agents' public addresses (key and address only; wallet ids and everything else stay out of the site). */
export function toWebAgents(circle) {
  return (circle?.agents ?? [])
    .filter((a) => typeof a.key === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a.address || ''))
    .map((a) => ({ key: a.key, address: a.address.toLowerCase() }));
}

export function toWebDeployment(d, agents = []) {
  if (!d || typeof d !== 'object') throw new Error('the deployment file is empty');
  if (!/^0x[0-9a-fA-F]{40}$/.test(d.arena?.address || '')) throw new Error('the deployment has no arena address');
  if (!Array.isArray(d.markets) || d.markets.length === 0) throw new Error('the deployment has no markets');
  const markets = d.markets.map((m) => {
    if (!Number.isInteger(m.id) || typeof m.name !== 'string' || !(m.round >= 300) || !(m.offset >= 0 && m.offset < m.round)) {
      throw new Error(`market ${JSON.stringify(m.id)} is incomplete (needs id, name, round length of at least 300 s, offset below it)`);
    }
    return { id: m.id, name: m.name, coin: m.coin, round: m.round, offset: m.offset, feed: m.feed };
  });
  if (new Set(markets.map((m) => m.id)).size !== markets.length) throw new Error('two markets share an id');
  return { network: d.network, chainId: d.chainId, arena: d.arena.address, markets: markets.sort((a, b) => a.id - b.id), agents };
}

/** One variable from a .env file's text (KEY=value lines; # comments, `export ` and surrounding quotes allowed); undefined if absent. */
export function readEnvValue(text, key) {
  let value;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq).trim() !== key) continue;
    let v = line.slice(eq + 1).trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/\s+#.*$/, '');
    value = v; // the last line wins, as in dotenv
  }
  return value;
}

/**
 * The site's network, decided the way Next.js decides it: a real environment variable wins (the host's settings),
 * otherwise NEXT_PUBLIC_NETWORK from web/.env.local. This script runs as plain node before `next dev`/`next build`,
 * so Next.js has not loaded .env.local yet and it is read here. Anything other than "mainnet" means testnet.
 */
export function siteNetwork({ root = ROOT, env = process.env } = {}) {
  let value = env.NEXT_PUBLIC_NETWORK;
  if (value === undefined) {
    const file = path.join(root, 'web', '.env.local');
    if (fs.existsSync(file)) value = readEnvValue(fs.readFileSync(file, 'utf8'), 'NEXT_PUBLIC_NETWORK');
  }
  return value === 'mainnet' ? 'mainnet' : 'testnet';
}

export function syncWebDeployment({ root = ROOT, network = siteNetwork({ root }) } = {}) {
  const from = path.join(root, 'deployments', network === 'mainnet' ? 'arc-mainnet.json' : 'arc-testnet.json');
  if (!fs.existsSync(from)) throw new Error(`${path.relative(root, from)} does not exist yet: deploy the contracts first`);
  const circleFile = path.join(root, 'deployments', network === 'mainnet' ? 'circle-mainnet.json' : 'circle-testnet.json');
  const agents = fs.existsSync(circleFile) ? toWebAgents(JSON.parse(fs.readFileSync(circleFile, 'utf8'))) : [];
  const out = toWebDeployment(JSON.parse(fs.readFileSync(from, 'utf8')), agents);
  const to = path.join(root, 'web', 'lib', 'deployment.generated.json');
  fs.writeFileSync(to, JSON.stringify(out, null, 2) + '\n');
  return { from, to, out };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const { to, out } = syncWebDeployment();
    console.log(`Site market list (${out.network}): ${out.markets.length} markets (${out.markets.map((m) => m.name).join(', ')}) -> ${path.relative(ROOT, to)}`);
  } catch (e) {
    console.error('STOP: ' + e.message);
    process.exit(1);
  }
}
