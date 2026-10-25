import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";

import { arcTestnet } from "@/lib/arc";

// Wallet connection. Only Arc testnet is configured, so a wallet on any other network is asked
// to switch (and to add Arc testnet first if it does not know it).
//  - Browser wallets (MetaMask, Rabby, Coinbase Wallet ...) are found automatically (EIP-6963).
//  - On phones the wallet apps' built-in browsers provide the same thing, so the same code works there;
//    the connect window also offers "open this page in your wallet app" links.
// WalletConnect (QR code / wallet apps from a normal phone browser) needs a free project id and is not added yet.
export const config = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: { [arcTestnet.id]: http() },
  multiInjectedProviderDiscovery: true,
  ssr: true,
});
