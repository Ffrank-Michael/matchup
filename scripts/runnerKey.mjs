// Which key the round runner signs with (price pushes and settles), and who may be the relay's pusher on mainnet.
// Secrets are only read from the env object that is passed in and are never printed; only addresses come out of here.
import { getAddress, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const KEY_FORMAT = /^0x[0-9a-fA-F]{64}$/;

const addressOf = (key) => getAddress(privateKeyToAccount(key).address);

/**
 * The runner's key for a network.
 *   mainnet: MAINNET_RUNNER_PRIVATE_KEY only. The deployer key is never read, so a runner can never sign as the owner.
 *   testnet: RUNNER_PRIVATE_KEY if it is set, otherwise the deployer key (the rehearsal feeds are owned by the deployer wallet).
 * Returns { key, source } or throws an error that says what to fix.
 */
export function runnerKeyFor(network, env) {
  const name = network === 'mainnet' ? 'MAINNET_RUNNER_PRIVATE_KEY' : 'RUNNER_PRIVATE_KEY';
  const own = env[name] || '';
  if (own) {
    if (!KEY_FORMAT.test(own)) throw new Error(`${name} in .env is not 0x + 64 hex characters.`);
    return { key: own, source: name };
  }
  if (network === 'mainnet') throw new Error('MAINNET_RUNNER_PRIVATE_KEY is missing in .env. On mainnet the runner needs its own wallet key, separate from the deployer and from any wallet people play with.');
  const dep = env.DEPLOYER_PRIVATE_KEY || '';
  if (!KEY_FORMAT.test(dep)) throw new Error('DEPLOYER_PRIVATE_KEY in .env is missing or not 0x + 64 hex characters.');
  return { key: dep, source: 'DEPLOYER_PRIVATE_KEY' };
}

/**
 * The mainnet pusher: the address of MAINNET_RUNNER_PRIVATE_KEY. `others` lists addresses it must not be, as [label, address] pairs
 * (the owner, the final owner, the house agents' wallets, ...). Returns { address, problems }.
 */
export function mainnetPusher(env, others = []) {
  const problems = [];
  const own = env.MAINNET_RUNNER_PRIVATE_KEY || '';
  if (!own) return { address: null, problems: ['MAINNET_RUNNER_PRIVATE_KEY is missing in .env. The mainnet runner needs its own key, separate from the deployer and from any wallet people play with. Run node scripts/create-mainnet-wallets.mjs to make it.'] };
  if (!KEY_FORMAT.test(own)) return { address: null, problems: ['MAINNET_RUNNER_PRIVATE_KEY in .env is not 0x + 64 hex characters.'] };
  const address = addressOf(own);
  const deployerKey = env.MAINNET_DEPLOYER_PRIVATE_KEY || '';
  if (deployerKey && own.toLowerCase() === deployerKey.toLowerCase()) problems.push('MAINNET_RUNNER_PRIVATE_KEY is the same key as MAINNET_DEPLOYER_PRIVATE_KEY. The runner must have its own key.');
  const testnetKey = env.DEPLOYER_PRIVATE_KEY || '';
  if (testnetKey && own.toLowerCase() === testnetKey.toLowerCase()) problems.push('MAINNET_RUNNER_PRIVATE_KEY is the same key as the testnet deployer key. Use a fresh key for the mainnet runner.');
  const testnetRunnerKey = env.RUNNER_PRIVATE_KEY || '';
  if (testnetRunnerKey && own.toLowerCase() === testnetRunnerKey.toLowerCase()) problems.push('MAINNET_RUNNER_PRIVATE_KEY is the same key as the testnet runner key. Use a fresh key for the mainnet runner.');
  for (const [label, who] of [['MAINNET_DEPLOYER_ADDRESS', env.MAINNET_DEPLOYER_ADDRESS], ['FINAL_OWNER_ADDRESS', env.FINAL_OWNER_ADDRESS], ...others]) {
    if (who && isAddress(who) && getAddress(who) === address) problems.push(`The runner address is also ${label}. The runner must be its own wallet.`);
  }
  return { address, problems };
}
