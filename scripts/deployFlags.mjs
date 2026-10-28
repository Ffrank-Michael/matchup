// The deploy script's send rule, kept apart so it can be tested.
//   testnet: sends with --send (unchanged).
//   mainnet: sends ONLY with --i-understand-this-spends-real-usdc; with no flag it is a dry run. --send alone is refused, so the
//            old habit of typing --send on its own can never spend real USDC.
export const UNDERSTAND_FLAG = '--i-understand-this-spends-real-usdc';

/** { send, error } for the command line (args without node and the script name). */
export function deployMode(args, { mainnet }) {
  const has = (n) => args.includes(n);
  if (!mainnet) return { send: has('--send'), error: null };
  if (has('--send') && !has(UNDERSTAND_FLAG)) return { send: false, error: `Mainnet spends real USDC. Run the dry run first (no flag), and once you have read it, run again with ${UNDERSTAND_FLAG} (--send is not needed).` };
  return { send: has(UNDERSTAND_FLAG) && !has('--verify-only'), error: null };
}
