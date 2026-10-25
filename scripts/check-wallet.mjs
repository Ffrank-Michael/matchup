// Prints the deployer wallet's PUBLIC address and its testnet USDC balance. No secrets.
import { setup, usdcBalance } from './lib.mjs';

const { pub, account, usdc, chain } = setup();
const id = await pub.getChainId();
if (id !== chain.id) throw new Error(`RPC reports chain ${id}, expected ${chain.id}`);
const bal = await usdcBalance(pub, usdc, account.address);
console.log('Network      : Arc testnet (chain id ' + id + ')');
console.log('Deployer addr:', account.address);
console.log('USDC balance :', bal.text, 'USDC');
console.log('Explorer     :', chain.blockExplorers.default.url + '/address/' + account.address);
