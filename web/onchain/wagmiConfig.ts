/**
 * onchain/wagmiConfig.ts
 * wagmi config for Kairo Markets, from Arc Studio's version. Both Arc chains are known to wagmi (the types need that); the site only ever uses activeChain.
 * Connectors: injected() (browser wallets, found by EIP-6963) and walletConnect() only when a project id exists.
 * Wrong network: useEnsureNetwork() switches (the wallet adds Arc first if it does not know it).
 */
import { useCallback } from "react";
import { createConfig, http, useConnection, useSwitchChain } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";

import { arcMainnet, arcTestnet } from "./chains";
import { NETWORK, WALLETCONNECT_PROJECT_ID } from "./env";

export const activeChain: typeof arcTestnet | typeof arcMainnet = NETWORK === "mainnet" ? arcMainnet : arcTestnet;

export const wagmiConfig = createConfig({
  chains: NETWORK === "mainnet" ? [arcMainnet, arcTestnet] : [arcTestnet, arcMainnet], // the site's own chain first: it is the default for reads
  connectors: [
    injected(),
    ...(WALLETCONNECT_PROJECT_ID
      ? [
          walletConnect({
            projectId: WALLETCONNECT_PROJECT_ID,
            showQrModal: true, // a QR code on a computer, a list of wallet apps on a phone
            metadata: {
              name: "Kairo Markets",
              description: "Call the next round of BTC, ETH and SOL: UP or DOWN, with USDC on Arc.",
              url: typeof window !== "undefined" ? window.location.origin : "https://kairo.markets",
              icons: [typeof window !== "undefined" ? `${window.location.origin}/favicon.svg` : "https://kairo.markets/favicon.svg"],
            },
          }),
        ]
      : []),
  ],
  transports: { [arcTestnet.id]: http(), [arcMainnet.id]: http() },
  multiInjectedProviderDiscovery: true,
  ssr: true,
});

export function useEnsureNetwork() {
  const { chainId } = useConnection();
  const { mutateAsync: switchChainAsync } = useSwitchChain();
  const isWrongNetwork = chainId !== undefined && chainId !== activeChain.id;

  const ensureNetwork = useCallback(async () => {
    if (!isWrongNetwork) return;
    await switchChainAsync({ chainId: activeChain.id });
  }, [isWrongNetwork, switchChainAsync]);

  return { ensureNetwork, isWrongNetwork, requiredChainId: activeChain.id };
}
