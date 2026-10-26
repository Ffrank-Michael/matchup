/**
 * onchain/useClaim.ts
 * Claims winnings and refunds. From Arc Studio's turn T3 (claim, and claimMany for several rounds in one transaction);
 * this version waits for the receipt itself and refreshes the screens once, instead of doing that while rendering.
 *
 * A win and a refund use the same contract function. The screen text differs: "Claim your winnings" / "Get your money back".
 */

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePublicClient, useWriteContract } from "wagmi";

import { ARENA_ABI } from "./abi";
import { ARENA_ADDRESSES } from "./addresses";
import { NETWORK } from "./env";
import { explainError } from "./errors";
import type { ClaimableKind } from "./useMyPositions";

export type ClaimStatus = "idle" | "claim-wallet" | "claim-confirming" | "done" | "failed";

export const CLAIM_STATUS_TEXT: Record<ClaimStatus, string> = {
  idle: "",
  "claim-wallet": "Confirm in your wallet.",
  "claim-confirming": "Waiting for the confirmation…",
  done: "Done. The money is in your wallet.",
  failed: "Nothing was claimed.",
};

/** The button text for a position. */
export const claimLabel = (kind: ClaimableKind) =>
  kind === "win" ? "Claim your winnings" : kind === "partial" ? "Get back" : "Get your money back";

export interface ClaimTarget {
  marketId: number;
  roundIndex: number;
  claimableKind: ClaimableKind;
  claimableAmount: bigint;
}

export function useClaim() {
  const arenaAddress = ARENA_ADDRESSES[NETWORK];
  const client = usePublicClient();
  const queryClient = useQueryClient();
  const { mutateAsync: writeContractAsync } = useWriteContract();

  const [status, setStatus] = useState<ClaimStatus>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorTechnical, setErrorTechnical] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStatus("idle");
    setTxHash(null);
    setErrorMessage(null);
    setErrorTechnical(null);
  }, []);

  /** Sends one claim or one claimMany for the targets that really have something to claim. */
  const send = useCallback(
    async (targets: ClaimTarget[]) => {
      reset();
      const list = targets.filter((t) => t.claimableKind !== "none" && t.claimableAmount > 0n);
      if (!arenaAddress || !client) {
        setErrorMessage("Kairo Markets is not deployed on this network yet.");
        return setStatus("failed");
      }
      if (list.length === 0) {
        setErrorMessage("There is nothing to claim right now.");
        return setStatus("failed");
      }
      try {
        setStatus("claim-wallet");
        const arena = { address: arenaAddress, abi: ARENA_ABI } as const;
        // All or nothing: claimMany reverts as a whole if one entry cannot be claimed, so nothing is half paid.
        const hash =
          list.length === 1
            ? await writeContractAsync({ ...arena, functionName: "claim", args: [BigInt(list[0].marketId), BigInt(list[0].roundIndex)] })
            : await writeContractAsync({ ...arena, functionName: "claimMany", args: [list.map((t) => BigInt(t.marketId)), list.map((t) => BigInt(t.roundIndex))] });
        setTxHash(hash);
        setStatus("claim-confirming");
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          setErrorMessage("The claim did not go through. Nothing was paid out.");
          return setStatus("failed");
        }
        setStatus("done");
        for (const key of ["rounds", "myPositions", "usdc"]) void queryClient.invalidateQueries({ queryKey: [key] });
      } catch (err) {
        const explained = explainError(err);
        setErrorMessage(explained.message);
        setErrorTechnical(explained.technical || null);
        setStatus("failed");
      }
    },
    [arenaAddress, client, queryClient, reset, writeContractAsync],
  );

  const claim = useCallback((target: ClaimTarget) => send([target]), [send]);
  const claimAll = useCallback((targets: ClaimTarget[]) => send(targets), [send]);

  return { claim, claimAll, status, txHash, errorMessage, errorTechnical, reset };
}
