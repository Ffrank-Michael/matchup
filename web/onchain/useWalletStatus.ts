/** onchain/useWalletStatus.ts: everything the screens need to know about the connected wallet. */
import { useConnection } from "wagmi";

import { arcMainnet } from "./chains";
import { NETWORK } from "./env";
import { activeChain } from "./wagmiConfig";

export interface WalletStatus {
  connected: boolean;
  address: `0x${string}` | undefined;
  /** the wallet is connected to a different chain than the site's */
  isWrongNetwork: boolean;
  /** real funds (Arc mainnet) */
  isMainnet: boolean;
  requiredChainId: number;
}

export function useWalletStatus(): WalletStatus {
  const { address, isConnected, chainId } = useConnection();
  return {
    connected: isConnected,
    address,
    isWrongNetwork: isConnected && chainId !== undefined && chainId !== activeChain.id,
    isMainnet: NETWORK === "mainnet" || chainId === arcMainnet.id,
    requiredChainId: activeChain.id,
  };
}
