/**
 * onchain/useMakeCall.ts
 * Makes a call (the contract's placeCall) on a market's next round. From Arc Studio's turn T3: the constants, the status
 * texts and the two check functions are theirs. Their hook stopped after the checks and left the sending to the demo
 * page; this version runs the whole flow in makeCall(), so the call panel only calls it and shows `status`.
 *
 * Flow (each step waits for its receipt before the next):
 *   1. checks, nothing sent, plain-words error if one fails
 *   2. if the allowance is below the amount: a one-time approval (50 USDC by default, the visitor can change it), so later
 *      calls need one confirmation only; it can be removed at any time (useRevokeApproval)
 *   3. simulate placeCall (a revert reason shows before the wallet opens), then send it
 *   4. wait for the receipt, refresh the screens
 *
 * Google wallet (a Circle EOA on Arc mainnet, see onchain/usePlayer.ts): the same checks, read from the chain with its address;
 * then the permission and placeCall each go through Circle (our server builds the contract call, the player confirms it on
 * Circle's "Contract interaction" screen; lib/use-google-wallet.tsx contractCall). Circle's screen takes a moment, so a Google
 * call is refused when less than 30 seconds are left before calling closes, checked before each Circle step.
 *
 * Words on screen: "call", "position". Function names such as placeCall stay in code only.
 */

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePublicClient, useWriteContract } from "wagmi";
import { parseUnits } from "viem";

import { ARENA_ABI, ERC20_ABI } from "./abi";
import { ARENA_ADDRESSES } from "./addresses";
import { USDC_ADDRESS } from "./chains";
import { NETWORK } from "./env";
import { explainError } from "./errors";
import { useEnsureNetwork } from "./wagmiConfig";
import { usePlayer, type PlayerSource } from "./usePlayer";
import { useGoogleWallet } from "@/lib/use-google-wallet";
import { APPROVE_SIGNATURE, PLACE_CALL_SIGNATURE, lockTimeProblem, microToUsdc } from "@/lib/circle-calls";
import { PERMISSION_NOTE, PERMISSION_USDC } from "@/lib/price-rule";

// ── Beta limit ────────────────────────────────────────────────

/** The most USDC one wallet may have on one round (all its positions there). Enforced here; the contract has no maximum. */
export const BETA_LIMIT_USDC = 10;

/** The beta limit in 6-decimal USDC units. */
export const BETA_LIMIT_RAW = BigInt(BETA_LIMIT_USDC) * 1_000_000n;

/** The one-time permission asked for before the first call (the visitor can change the amount). */
export const DEFAULT_APPROVAL_USDC = PERMISSION_USDC;

/** The words shown BEFORE the permission is asked for (the shared wording in lib/price-rule.ts). */
export const APPROVAL_NOTICE = PERMISSION_NOTE;

/** Kept back for network fees (Arc pays fees in USDC). */
export const GAS_RESERVE_RAW = 10_000n; // $0.01 (the approval and the call cost about $0.004 together)

// ── Status ────────────────────────────────────────────────────

export type MakeCallStatus = "idle" | "checking" | "approve-wallet" | "approve-confirming" | "call-wallet" | "call-confirming" | "done" | "failed";

export const STATUS_TEXT: Record<MakeCallStatus, string> = {
  idle: "",
  checking: "Checking your call…",
  "approve-wallet": "Confirm in your wallet.",
  "approve-confirming": "Waiting for the approval to confirm…",
  "call-wallet": "Confirm your call in your wallet.",
  "call-confirming": "Waiting for your call to confirm…",
  done: "Your call is in. Good luck.",
  failed: "Your call was not made.",
};

export interface MakeCallParams {
  marketId: number;
  round: number;
  side: "UP" | "DOWN";
  /** Dollars as text, e.g. "1.50", at most 6 decimals */
  amountUsdc: string;
  /** How much to allow in the one-time permission, in dollars as text. Default 50; never less than the call itself. */
  approvalUsdc?: string;
}

export interface UseMakeCallReturn {
  makeCall: (params: MakeCallParams) => Promise<void>;
  status: MakeCallStatus;
  /** Plain-words reason, or null */
  errorMessage: string | null;
  /** The technical detail for the fine print */
  errorTechnical: string | null;
  reset: () => void;
  txHash: `0x${string}` | null;
  approveTxHash: `0x${string}` | null;
  /** which wallet the call goes through (the waiting texts differ for Google: Circle's window) */
  via: PlayerSource;
}

// ── Pure checks (exported for tests) ──────────────────────────

/** null if the amount is a usable number, otherwise a plain-words error. */
export function validateAmount(amountStr: string): string | null {
  if (!amountStr || amountStr.trim() === "") return "Please enter an amount.";
  const n = Number(amountStr);
  if (Number.isNaN(n) || !Number.isFinite(n)) return "Please enter a valid number.";
  if (n <= 0) return "The amount must be more than zero.";
  const parts = amountStr.split(".");
  if (parts[1] && parts[1].length > 6) return "USDC has 6 decimal places. Please shorten the amount.";
  return null;
}

/** null if this call keeps the wallet within the beta limit for the round, otherwise a plain-words error. */
export function checkBetaLimit(existingUp: bigint, existingDown: bigint, newAmount: bigint): string | null {
  const total = existingUp + existingDown + newAmount;
  if (total <= BETA_LIMIT_RAW) return null;
  const remaining = BETA_LIMIT_RAW - existingUp - existingDown;
  const left = remaining > 0n ? (Number(remaining) / 1_000_000).toFixed(2) : "0.00";
  return `Beta limit: $${BETA_LIMIT_USDC} per wallet in each round. You can add at most $${left} more here.`;
}

// ── Hook ──────────────────────────────────────────────────────

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export function useMakeCall(): UseMakeCallReturn {
  const { address, source } = usePlayer();
  const google = useGoogleWallet();
  const client = usePublicClient();
  const { ensureNetwork } = useEnsureNetwork();
  const { mutateAsync: writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const arenaAddress = ARENA_ADDRESSES[NETWORK];

  const [status, setStatus] = useState<MakeCallStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorTechnical, setErrorTechnical] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [approveTxHash, setApproveTxHash] = useState<`0x${string}` | null>(null);

  const reset = useCallback(() => {
    setStatus("idle");
    setErrorMessage(null);
    setErrorTechnical(null);
    setTxHash(null);
    setApproveTxHash(null);
  }, []);

  const makeCall = useCallback(
    async (params: MakeCallParams) => {
      reset();
      setStatus("checking");
      /** Nothing (more) was sent: say why, in plain words. */
      const stop = (message: string) => {
        setErrorMessage(message);
        setStatus("failed");
      };

      try {
        if (!address) return stop("Connect your wallet first.");
        if (!arenaAddress) return stop("Matchup is not deployed on this network yet.");
        if (!client) return stop("No network connection. Please refresh the page.");

        const amountErr = validateAmount(params.amountUsdc);
        if (amountErr) return stop(amountErr);
        let amountRaw: bigint; // money is a bigint in 6-decimal units, never a float
        try {
          amountRaw = parseUnits(params.amountUsdc, 6);
        } catch {
          return stop("Could not read that amount. Please check it.");
        }

        // Everything the checks need, read from the chain right now (the site's clock can be a second behind).
        const arena = { address: arenaAddress, abi: ARENA_ABI } as const;
        const [market, nextRound, position, balance, allowance] = await client.multicall({
          contracts: [
            { ...arena, functionName: "markets", args: [BigInt(params.marketId)] },
            { ...arena, functionName: "nextCallableRound", args: [BigInt(params.marketId)] },
            { ...arena, functionName: "positions", args: [BigInt(params.marketId), BigInt(params.round), address] },
            { address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [address] },
            { address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "allowance", args: [address, arenaAddress] },
          ],
          allowFailure: false,
          multicallAddress: MULTICALL3,
        });
        const [, , , , minStake, paused] = market;
        const [existingUp, existingDown] = position;

        if (paused) return stop("This market is paused right now. Calling is switched off for the moment.");
        if (BigInt(params.round) !== nextRound) return stop("Calling for this round just closed. Your call was not sent.");
        if (amountRaw < BigInt(minStake)) return stop(`The minimum call for this market is $${(Number(minStake) / 1_000_000).toFixed(2)}.`);
        const betaErr = checkBetaLimit(existingUp, existingDown, amountRaw);
        if (betaErr) return stop(betaErr);
        if ((params.side === "UP" && existingDown > 0n) || (params.side === "DOWN" && existingUp > 0n)) {
          return stop("You already called the other side in this round. One side per round.");
        }
        if (balance < amountRaw + GAS_RESERVE_RAW) {
          return stop(
            `Your USDC balance is too low. You need at least $${(Number(amountRaw + GAS_RESERVE_RAW) / 1_000_000).toFixed(2)}: the call plus $${(Number(GAS_RESERVE_RAW) / 1_000_000).toFixed(2)} kept for network fees (Arc pays fees in USDC).`,
          );
        }

        if (source === "google") {
          // ── Google wallet: the permission and the call go through Circle ──
          const lt = Number(await client.readContract({ ...arena, functionName: "lockTime", args: [BigInt(params.marketId), BigInt(params.round)] }));
          const tooLate = () => lockTimeProblem(lt, Math.floor(Date.now() / 1000));
          let late = tooLate();
          if (late) return stop(late);
          const hex = (h: string | null) => (h && /^0x[0-9a-fA-F]{64}$/.test(h) ? (h as `0x${string}`) : null);

          if (allowance < amountRaw) {
            let allowRaw = parseUnits(String(DEFAULT_APPROVAL_USDC), 6);
            if (params.approvalUsdc !== undefined && validateAmount(params.approvalUsdc) === null) allowRaw = parseUnits(params.approvalUsdc, 6);
            if (allowRaw < amountRaw) allowRaw = amountRaw;
            setStatus("approve-wallet");
            const a = await google.contractCall(
              "approve",
              { amount: microToUsdc(allowRaw) },
              { contract: USDC_ADDRESS, signature: APPROVE_SIGNATURE },
              () => setStatus("approve-confirming"),
            );
            setApproveTxHash(hex(a.txHash));
            if (!a.ok) return stop(`The permission was not given, so no call was made. ${a.error}`);
            late = tooLate();
            if (late) return stop(`The permission is done (later calls skip it), but this round is closing. ${late}`);
          }

          // Catch a revert reason before Circle's window opens (a read: the Google wallet's address is enough).
          const googleArgs = [BigInt(params.marketId), BigInt(params.round), params.side === "UP", amountRaw] as const;
          await client.simulateContract({ ...arena, functionName: "placeCall", args: googleArgs, account: address });

          setStatus("call-wallet");
          const r = await google.contractCall(
            "placeCall",
            { marketId: String(params.marketId), roundIndex: String(params.round), up: params.side === "UP", amount: microToUsdc(amountRaw) },
            { contract: arenaAddress, signature: PLACE_CALL_SIGNATURE },
            () => setStatus("call-confirming"),
          );
          setTxHash(hex(r.txHash));
          if (!r.ok) return stop(`Your call was not made. ${r.error}`);
          setStatus("done");
          for (const key of ["rounds", "myPositions", "usdc", "markets", "myCalls"]) void queryClient.invalidateQueries({ queryKey: [key] });
          return;
        }

        await ensureNetwork();

        // The one-time permission, only when the current one is too small. The visitor can change its size; it is never below the call.
        if (allowance < amountRaw) {
          let allowRaw = parseUnits(String(DEFAULT_APPROVAL_USDC), 6);
          if (params.approvalUsdc !== undefined && validateAmount(params.approvalUsdc) === null) allowRaw = parseUnits(params.approvalUsdc, 6);
          if (allowRaw < amountRaw) allowRaw = amountRaw;
          setStatus("approve-wallet");
          const approveHash = await writeContractAsync({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve", args: [arenaAddress, allowRaw] });
          setApproveTxHash(approveHash);
          setStatus("approve-confirming");
          const approval = await client.waitForTransactionReceipt({ hash: approveHash });
          if (approval.status !== "success") return stop("The approval did not go through, so no call was made. Nothing was taken except the network fee.");
        }

        // Catch a revert reason before the wallet opens.
        const callArgs = [BigInt(params.marketId), BigInt(params.round), params.side === "UP", amountRaw] as const;
        await client.simulateContract({ ...arena, functionName: "placeCall", args: callArgs, account: address });

        setStatus("call-wallet");
        const hash = await writeContractAsync({ ...arena, functionName: "placeCall", args: callArgs });
        setTxHash(hash);
        setStatus("call-confirming");
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") return stop("Your call did not go through. Nothing was taken except the network fee.");

        setStatus("done");
        for (const key of ["rounds", "myPositions", "usdc", "markets"]) void queryClient.invalidateQueries({ queryKey: [key] });
      } catch (err) {
        const explained = explainError(err);
        setErrorMessage(explained.message);
        setErrorTechnical(explained.technical || null);
        setStatus("failed");
      }
    },
    [address, source, google, arenaAddress, client, ensureNetwork, queryClient, reset, writeContractAsync],
  );

  return { makeCall, status, errorMessage, errorTechnical, reset, txHash, approveTxHash, via: source };
}

/** Removes the permission (sets it to zero; the next call then needs a new one-time permission). */
export function useRevokeApproval() {
  const client = usePublicClient();
  const queryClient = useQueryClient();
  const { mutateAsync: writeContractAsync } = useWriteContract();
  const arenaAddress = ARENA_ADDRESSES[NETWORK];
  const [status, setStatus] = useState<"idle" | "wallet" | "confirming" | "done" | "failed">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const setLimitRaw = useCallback(
    async (limit: bigint) => {
    if (!arenaAddress || !client) return;
    setErrorMessage(null);
    try {
      setStatus("wallet");
      const hash = await writeContractAsync({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve", args: [arenaAddress, limit] });
      setStatus("confirming");
      const receipt = await client.waitForTransactionReceipt({ hash });
      setStatus(receipt.status === "success" ? "done" : "failed");
      void queryClient.invalidateQueries({ queryKey: ["usdc"] });
    } catch (err) {
      setErrorMessage(explainError(err).message);
      setStatus("failed");
    }
    },
    [arenaAddress, client, queryClient, writeContractAsync],
  );
  const revoke = useCallback(() => setLimitRaw(0n), [setLimitRaw]);

  return { revoke, status, errorMessage };
}
