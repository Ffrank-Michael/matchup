/**
 * onchain/wagmiConfig.ts
 * wagmi config for Matchup, from Arc Studio's version. Both Arc chains are known to wagmi (the types need that); the site only ever uses activeChain.
 * Connectors: injected() (browser wallets, found by EIP-6963) and walletConnect() only when a project id exists.
 * Wrong network: useEnsureNetwork() switches (the wallet adds Arc first if it does not know it).
 */
import { useCallback } from "react";
import { createConfig, http, useConnection, useDisconnect, useSwitchChain } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";

import { arcMainnet, arcTestnet } from "./chains";
import { NETWORK, WALLETCONNECT_PROJECT_ID } from "./env";

export const activeChain: typeof arcTestnet | typeof arcMainnet = NETWORK === "mainnet" ? arcMainnet : arcTestnet;

export const RECOMMENDED_WALLET_IDS = [
  "4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0", // Trust Wallet
  "1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369", // Rainbow
  "a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393", // Phantom
  "ecc4036f814562b41a5268adc86270fba1365471402006302e70169465b7ac18", // Zerion
  "fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa", // Coinbase Wallet (now Base)
  "18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1", // Rabby
  "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96", // MetaMask
];

export const wagmiConfig = createConfig({
  chains: NETWORK === "mainnet" ? [arcMainnet, arcTestnet] : [arcTestnet, arcMainnet], // the site's own chain first: it is the default for reads
  connectors: [
    injected(),
    ...(WALLETCONNECT_PROJECT_ID
      ? [
          walletConnect({
            projectId: WALLETCONNECT_PROJECT_ID,
            showQrModal: true, // a QR code on a computer, a list of wallet apps on a phone
            // Shown first in the wallet list (Reown wallet ids): Trust, Rainbow, Phantom, Zerion, Coinbase, Rabby, MetaMask. The rest of Reown's list follows.
            qrModalOptions: { explorerRecommendedWalletIds: RECOMMENDED_WALLET_IDS },
            metadata: {
              name: "Matchup",
              description: "The prediction market where AI agents compete. Call BTC, ETH and SOL, or back an agent.",
              url: "https://www.playmatchup.xyz", // the public address, whatever address the page is opened on
              icons: ["https://www.playmatchup.xyz/brand/icon-512.png"],
            },
          }),
        ]
      : []),
  ],
  transports: { [arcTestnet.id]: http(), [arcMainnet.id]: http() },
  multiInjectedProviderDiscovery: true,
  ssr: true,
});

/** A browser wallet that announced itself (own name and icon), as opposed to the plain "window.ethereum" connector. */
export const isAnnouncedWallet = (c: { type: string; id: string }) => c.type === "injected" && c.id !== "injected";

/** Disconnect, and make sure nothing reconnects by itself on the next visit: the visitor picks a wallet again. `then` runs once it is done. */
export function useDisconnectWallet() {
  const { mutateAsync } = useDisconnect();
  // The promise form: the buttons that call this disappear the moment the wallet is disconnected, and callbacks given to mutate() would be dropped.
  return useCallback(
    async (then?: () => void) => {
      try {
        await mutateAsync();
      } catch {
        /* nothing to disconnect */
      }
      // wagmi remembers "disconnected" per connector, so mark every browser-wallet connector (they can share one provider)
      const { storage, connectors } = wagmiConfig;
      try {
        await storage?.removeItem("recentConnectorId");
        for (const c of connectors) if (c.type === "injected") await storage?.setItem(`${c.id}.disconnected`, true);
      } catch {
        /* storage not available: the wallet's own disconnected mark still holds */
      }
      then?.();
    },
    [mutateAsync],
  );
}

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
