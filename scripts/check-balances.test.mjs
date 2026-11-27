// node --test scripts/check-balances.test.mjs
// The mainnet balance check against a fake chain (no network): the table, the labels, the low-balance warnings and the fee lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getAddress } from 'viem';
import { parseArgs, walletList, collect, warnings, report, OWNER, RUNNER, ARENA, MAINNET_CHAIN_ID } from './check-balances.mjs';

const U = (n) => BigInt(Math.round(n * 1e6));
const OTHER = '0x00000000000000000000000000000000000000aa';
const ZERO = '0x0000000000000000000000000000000000000000';

function fakeChain({ chainId = MAINNET_CHAIN_ID, balances = {}, arena = {}, failBalance = [], code = '0x6080' } = {}) {
  const bal = Object.fromEntries(Object.entries(balances).map(([a, v]) => [getAddress(a), v]));
  const reads = { feesAccrued: U(12.5), totalPlayerFunds: U(300), owner: getAddress(OWNER), pendingOwner: ZERO, ...arena };
  const calls = [];
  return {
    calls,
    chainId: async () => chainId,
    balance: async (a) => { calls.push(['balance', a]); if (failBalance.includes(a)) throw new Error('rpc timeout'); return bal[a] ?? 0n; },
    code: async () => code,
    read: async (a, fn) => { calls.push(['read', a, fn]); assert.equal(a, getAddress(ARENA)); if (reads[fn] instanceof Error) throw reads[fn]; return reads[fn]; },
  };
}

const healthy = { [OWNER]: U(2), [RUNNER]: U(5), [ARENA]: U(312.5) };

test('the command line takes addresses only', () => {
  assert.deepEqual(parseArgs([]), { extra: [], error: null });
  assert.deepEqual(parseArgs([OTHER]).extra, [getAddress(OTHER)]);
  assert.match(parseArgs(['--key']).error, /not an address/);
  assert.match(parseArgs(['0x123']).error, /not an address/);
});

test('labels: owner, runner, arena, then other; each address once', () => {
  const list = walletList([OTHER, RUNNER, OTHER.toUpperCase().replace('0X', '0x')]);
  assert.deepEqual(list.map((w) => w.label), ['owner', 'runner', 'arena', 'other']);
  assert.equal(list[1].address, getAddress(RUNNER));
});

test('refuses a chain that is not Arc mainnet', async () => {
  await assert.rejects(collect(fakeChain({ chainId: 5042002 })), /not Arc mainnet/);
});

test('a healthy setup: table, arena totals, fee recipient and caller, no warnings', async () => {
  const data = await collect(fakeChain({ balances: { ...healthy, [OTHER]: U(0.25) } }), [OTHER]);
  assert.deepEqual(warnings(data), []);
  const text = report(data);
  assert.match(text, new RegExp(`owner\\s+${getAddress(OWNER)}\\s+2\\n`));
  assert.match(text, new RegExp(`runner\\s+${getAddress(RUNNER)}\\s+5\\n`));
  assert.match(text, new RegExp(`arena\\s+${getAddress(ARENA)}\\s+312.5\\n`));
  assert.match(text, new RegExp(`other\\s+${getAddress(OTHER)}\\s+0.25\\n`));
  assert.match(text, /total USDC held\s+312.5 USDC/);
  assert.match(text, /unclaimed fees\s+12.5 USDC/);
  assert.match(text, /owed to players\s+300 USDC/);
  assert.match(text, /no fixed recipient/);
  assert.match(text, new RegExp(`only the arena's owner\\(\\), which is now ${getAddress(OWNER)} \\(the owner wallet above\\)`));
  assert.match(text, /No warnings/);
});

test('warns when the runner is below 1 USDC and the owner below 0.5 USDC (exactly the limit is fine)', async () => {
  let w = warnings(await collect(fakeChain({ balances: { ...healthy, [RUNNER]: U(0.999999), [OWNER]: U(0.4) } })));
  assert.equal(w.length, 2);
  assert.match(w[0], /runner has 0.999999 USDC, below 1 USDC/);
  assert.match(w[1], /owner has 0.4 USDC, below 0.5 USDC/);
  w = warnings(await collect(fakeChain({ balances: { ...healthy, [RUNNER]: U(1), [OWNER]: U(0.5) } })));
  assert.deepEqual(w, []);
  assert.match(report(await collect(fakeChain({ balances: { ...healthy, [RUNNER]: 0n } }))), /WARNINGS:\n  - The runner has 0 USDC/);
});

test('warns when the on-chain owner differs, an ownership move is pending, or the arena is short', async () => {
  const other = getAddress(OTHER);
  const w = warnings(await collect(fakeChain({ balances: { ...healthy, [ARENA]: U(100) }, arena: { owner: other, pendingOwner: other } })));
  assert.ok(w.some((x) => /owner\(\) is .* not the owner wallet/.test(x)));
  assert.ok(w.some((x) => /ownership move is waiting/.test(x)));
  assert.ok(w.some((x) => /less USDC than players are owed/.test(x)));
  assert.ok(warnings(await collect(fakeChain({ balances: healthy, code: '0x' }))).some((x) => /no contract at the arena/.test(x)));
});

test('a failed read is shown on its line and does not hide the rest', async () => {
  const data = await collect(fakeChain({ balances: healthy, failBalance: [getAddress(RUNNER)], arena: { feesAccrued: new Error('revert') } }));
  const text = report(data);
  assert.match(text, /runner\s+\S+\s+could not read \(rpc timeout\)/);
  assert.match(text, /unclaimed fees\s+could not read/);
  assert.match(text, /owner\s+\S+\s+2\n/);
  assert.ok(warnings(data).includes('Could not read the runner balance.'));
});

test('the script never reads .env or a key', () => {
  const src = fs.readFileSync(new URL('./check-balances.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /['"`/]\.env|dotenv|loadEnv|PRIVATE_KEY|privateKeyToAccount|readFileSync|createWalletClient|lib\.mjs/);
});
