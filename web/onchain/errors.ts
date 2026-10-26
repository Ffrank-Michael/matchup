/**
 * src/onchain/errors.ts
 * ─────────────────────────────────────────────────────────────
 * Maps every on-chain error and wallet error to a plain-English sentence
 * a beginner can understand.
 *
 * Error names come from PredictionArena.sol (custom errors section).
 * Wallet errors come from EIP-1193 / MetaMask conventions.
 */

// ── Types ─────────────────────────────────────────────────────

export interface ExplainedError {
  /** Short plain sentence for the user. */
  message: string;
  /**
   * Brief technical note (error name, short message).
   * Used for the fine-print below the main message.
   * Empty string when not helpful.
   */
  technical: string;
}

// ── ABI-decode helper ─────────────────────────────────────────

/**
 * Extract the error name from a viem/ethers revert error.
 * Tries: error.name, error.cause?.name, the "ContractFunctionRevertedError"
 * data.errorName field, and a plain text search through error.message.
 */
const WRAPPER_ERROR_NAMES = new Set([
  "Error",
  "TransactionExecutionError",
  "CallExecutionError",
  "EstimateGasExecutionError",
  "RawContractError",
  "BaseError",
]);

function extractErrorName(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const e = err as Record<string, unknown>;

  // viem ContractFunctionRevertedError exposes data.errorName — highest priority
  if (e.data && typeof e.data === "object") {
    const d = e.data as Record<string, unknown>;
    if (typeof d.errorName === "string" && d.errorName) return d.errorName;
  }

  // Nested cause first when the outer name is a known wrapper class —
  // this lets TransactionExecutionError → ContractFunctionRevertedError work.
  if (e.cause && typeof e.cause === "object") {
    const inner = extractErrorName(e.cause);
    if (inner) return inner;
  }

  // viem/ethers puts the Solidity name in e.name; skip generic wrapper names
  if (typeof e.name === "string" && e.name && !WRAPPER_ERROR_NAMES.has(e.name)) {
    return e.name;
  }

  // Last resort: search the message string for "ErrorName(" pattern
  if (typeof e.message === "string") {
    const m = e.message.match(/([A-Z][A-Za-z0-9]+)\(/);
    if (m) return m[1];
  }

  return "";
}

/** Extract a short technical string (class name + up to 120 chars of message). */
function technicalNote(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as Record<string, unknown>;
  const name = typeof e.name === "string" ? e.name : "";
  const msg = typeof e.message === "string" ? e.message.slice(0, 120) : "";
  if (!name && !msg) return "";
  if (!name) return msg;
  if (!msg) return name;
  return `${name}: ${msg}`;
}

// ── Error message map ─────────────────────────────────────────
// Each key is the Solidity custom error name exactly as declared in PredictionArena.sol.

const CONTRACT_MESSAGES: Record<string, string> = {
  // ── Market / round checks (placeBet) ──────────────────────
  MarketNotFound:
    "That market does not exist. Please refresh and try again.",
  MarketPaused:
    "This market is paused right now. Calling is temporarily disabled.",
  NotNextRound:
    "Calling for this round just closed. Your call was not sent.",
  StakeBelowMinimum:
    "Your amount is below the minimum for this market. Please increase it.",
  AmountExceedsUint128:
    "That amount is too large to fit in the contract. Please reduce it.",
  WrongSide:
    "You already called the other side in this round. One side per round.",

  // ── Settle / refund ───────────────────────────────────────
  SettleTooEarly:
    "This round has not ended yet. Settlement opens once the round closes.",
  SettleWindowClosed:
    "The 1-hour settlement window has closed. This round will be refunded.",
  RoundAlreadySettled:
    "This round has already been settled. Nothing to do.",
  InvalidStartRound:
    "The start price ID is wrong. Please wait for an automatic retry.",
  InvalidEndRound:
    "The end price ID is wrong. Please wait for an automatic retry.",
  RefundTooEarly:
    "The settlement window has not closed yet. Please wait 1 hour after the round ends.",

  // ── Claim ─────────────────────────────────────────────────
  RoundNotSettled:
    "This round has not been settled yet. Try again after the settlement window.",
  AlreadyClaimed:
    "You have already claimed your payout for this round.",
  NothingToClaim:
    "You are on the losing side (or have no call) in this round. Nothing to claim.",
  ArrayLengthMismatch:
    "Internal error: claim list length mismatch. Please refresh and try again.",
  EmptyClaim:
    "Nothing to claim: the list is empty.",

  // ── Fee / ownership (owner-only, shown for completeness) ──
  InsufficientFees:
    "Not enough fees have been collected to withdraw that amount.",
  FeesWouldTouchPlayerFunds:
    "This withdrawal would touch player funds. Contact the protocol team.",
  RenounceOwnershipDisabled:
    "Ownership cannot be renounced.",
  FeedBNotSupportedYet:
    "Head-to-head markets are not available yet.",
};

// ── Wallet / network error patterns ──────────────────────────

function matchWalletError(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  const msg =
    (typeof e.message === "string" ? e.message : "") +
    (typeof e.details === "string" ? " " + e.details : "") +
    (typeof e.reason === "string" ? " " + e.reason : "");
  const lower = msg.toLowerCase();

  // User cancelled in their wallet
  if (
    lower.includes("user rejected") ||
    lower.includes("user denied") ||
    lower.includes("cancelled") ||
    lower.includes("rejected the request") ||
    e.code === 4001
  ) {
    return "You cancelled the transaction. Nothing was sent.";
  }

  // Insufficient native gas (Arc USDC = gas, but use the plain phrase)
  if (
    lower.includes("insufficient funds for gas") ||
    lower.includes("insufficient funds for intrinsic gas")
  ) {
    return "Not enough USDC to cover the network fee. Keep at least $0.05 spare.";
  }

  // Network / RPC unreachable
  if (
    lower.includes("network error") ||
    lower.includes("failed to fetch") ||
    lower.includes("could not connect") ||
    lower.includes("connection refused")
  ) {
    return "Could not reach the network. Check your connection and try again.";
  }

  // Allowance too low (safeTransferFrom path)
  if (lower.includes("allowance") || lower.includes("erc20: insufficient allowance")) {
    return "The contract is not approved to use your USDC. Please approve first.";
  }

  // Balance too low
  if (
    lower.includes("transfer amount exceeds balance") ||
    lower.includes("insufficient balance")
  ) {
    return "Your USDC balance is too low for this call.";
  }

  return null;
}

// ── Main export ───────────────────────────────────────────────

/**
 * Convert any thrown error to a plain-English ExplainedError.
 *
 * Usage:
 *   catch (err) {
 *     const { message, technical } = explainError(err);
 *   }
 */
export function explainError(err: unknown): ExplainedError {
  // 1. Try to match a wallet/network pattern first (they sit on top of the error chain)
  const walletMsg = matchWalletError(err);
  if (walletMsg) {
    return { message: walletMsg, technical: technicalNote(err) };
  }

  // 2. Try to match a Solidity custom error name
  const name = extractErrorName(err);
  if (name && CONTRACT_MESSAGES[name]) {
    return { message: CONTRACT_MESSAGES[name], technical: name };
  }

  // 3. Unknown error
  return {
    message:
      "Something went wrong. Nothing was taken from your wallet unless the transaction link below shows it went through.",
    technical: technicalNote(err),
  };
}
