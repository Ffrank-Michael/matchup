// Which Arc network the site is pointed at. Mainnet is the target; testnet is a short rehearsal.
// Set NEXT_PUBLIC_NETWORK=mainnet for the real site. (The wallet code for mainnet comes with the onchain features.)
export const IS_MAINNET = process.env.NEXT_PUBLIC_NETWORK === "mainnet";
