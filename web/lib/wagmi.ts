// Wallet connection: the config comes from onchain/wagmiConfig.ts (Arc Studio turn T2, adapted to this site).
// Only the site's network is configured (NEXT_PUBLIC_NETWORK: testnet by default), so a wallet on any other network is
// asked to switch (the wallet adds Arc first if it does not know it).
export { wagmiConfig as config } from "@/onchain/wagmiConfig";
