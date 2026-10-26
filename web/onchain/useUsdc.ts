/**
 * src/onchain/useUsdc.ts
 * ─────────────────────────────────────────────────────────────
 * USDC balance and arena allowance for the connected wallet.
 *
 * IMPORTANT: Arc has USDC as native gas token (18 decimals native) AND
 * as an ERC-20 (6 decimals).  They are the SAME pool of money.
 * We read ONLY the ERC-20 balanceOf — never show the native balance,
 * never sum the two.  (See chains.ts for the full explanation.)
 */

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { useConnection } from "wagmi";
import { ERC20_ABI } from "./abi";
import { USDC_ADDRESS } from "./chains";
import { ARENA_ADDRESSES } from "./addresses";
import { NETWORK } from "./env";
import { usdc as formatUsdc } from "./format";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const REFETCH_MS = 5_000;

export interface UsdcState {
  /** Raw balance in 6-decimal ERC-20 units */
  balanceRaw: bigint | null;
  /** Formatted balance, e.g. "$12.34" */
  balanceFormatted: string | null;
  /** Raw allowance approved to the arena */
  allowanceRaw: bigint | null;
  /** Formatted allowance, e.g. "$5.00" */
  allowanceFormatted: string | null;
  isLoading: boolean;
}

/**
 * Returns USDC balance and arena allowance for the connected wallet.
 * All values are null while loading or when no wallet is connected.
 */
export function useUsdc(): UsdcState {
  const client = usePublicClient();
  const { address } = useConnection();
  const arenaAddress = ARENA_ADDRESSES[NETWORK];

  const { data, isLoading } = useQuery({
    queryKey: ["usdc", NETWORK, address],
    queryFn: async () => {
      if (!client || !address) throw new Error("not connected");

      const calls = [
        {
          address: USDC_ADDRESS as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "balanceOf" as const,
          args: [address],
        },
        ...(arenaAddress
          ? [
              {
                address: USDC_ADDRESS as `0x${string}`,
                abi: ERC20_ABI,
                functionName: "allowance" as const,
                args: [address, arenaAddress],
              },
            ]
          : []),
      ];

      const results = await client.multicall({
        contracts: calls,
        allowFailure: false,
        multicallAddress: MULTICALL3,
        batchSize: 60_000,
      });

      return {
        balance: results[0],
        allowance: arenaAddress ? (results[1]) : null,
      };
    },
    enabled: !!client && !!address,
    refetchInterval: REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: REFETCH_MS,
    retry: 3,
  });

  return {
    balanceRaw: data?.balance ?? null,
    balanceFormatted: data ? formatUsdc(data.balance) : null,
    allowanceRaw: data?.allowance ?? null,
    allowanceFormatted: data?.allowance !== null && data?.allowance !== undefined
      ? formatUsdc(data.allowance)
      : null,
    isLoading,
  };
}
