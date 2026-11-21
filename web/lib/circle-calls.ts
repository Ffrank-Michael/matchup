// Calls from the Google (Circle) wallet: the pieces with no React and no network, so they can be tested.
// The flow itself is in lib/use-google-wallet.tsx (contractCall) and onchain/useMakeCall.ts (the Google path).

/** The two functions the Google wallet calls (the server in lib/circle-api.ts uses the same strings; a test checks this) */
export const APPROVE_SIGNATURE = "approve(address,uint256)";
export const PLACE_CALL_SIGNATURE = "placeCall(uint256,uint256,bool,uint256)";
/** Claiming winnings and refunds: one round, or several in one transaction (all or nothing, like the browser-wallet path) */
export const CLAIM_SIGNATURE = "claim(uint256,uint256)";
export const CLAIM_MANY_SIGNATURE = "claimMany(uint256[],uint256[])";
/** The most rounds one Google claim may hold (the server enforces the same number) */
export const MAX_CLAIM_ROUNDS = 20;
/** Which function a claim of `count` rounds uses */
export const claimSignature = (count: number) => (count === 1 ? CLAIM_SIGNATURE : CLAIM_MANY_SIGNATURE);

export type ContractCall = {
  id: string | null;
  state: string | null;
  txHash: string | null;
  contractAddress: string | null;
  abiFunctionSignature: string | null;
  errorReason: string | null;
};

/** The contract call this approval made: the newest one that was not in the list before, on the same contract, for the same
 *  function (when Circle includes the function). Circle's approval answer does not include the transaction id. */
export function findNewContractCall(list: ContractCall[], before: Set<string>, contract: string, signature: string): ContractCall | null {
  return (
    list.find(
      (c) =>
        c.id !== null &&
        !before.has(c.id) &&
        c.contractAddress?.toLowerCase() === contract.toLowerCase() &&
        (c.abiFunctionSignature === null || c.abiFunctionSignature.replace(/\s/g, "") === signature),
    ) ?? null
  );
}

/** Circle's confirmation screen takes a moment, so a Google call needs this much time before calling closes. */
export const GOOGLE_MIN_SECONDS_LEFT = 30;

/** null when there is time to call from a Google wallet; otherwise why not, in plain words. Times are unix seconds. */
export function lockTimeProblem(lockTime: number, now: number, min = GOOGLE_MIN_SECONDS_LEFT): string | null {
  const left = lockTime - now;
  if (left <= 0) return "Calling for this round just closed. Your call was not sent.";
  if (left < min) {
    return `Less than ${min} seconds left to call this round. Circle's confirmation takes a moment, so wait for the next round. Your call was not sent.`;
  }
  return null;
}

/** "1500000" (micro-USDC) -> "1.5", for the server, which takes whole USDC */
export function microToUsdc(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export type PlayerSource = "browser" | "google" | null;

/** Which wallet the screens use (onchain/usePlayer.ts): a connected browser wallet first; otherwise the Google wallet, but
 *  only when the site is on Arc mainnet (where the Google wallet lives) and the wallet is ready. */
export function pickPlayer(
  browser: `0x${string}` | undefined,
  google: { phase: string; address: `0x${string}` | null },
  network: "testnet" | "mainnet",
): { address: `0x${string}` | undefined; source: PlayerSource } {
  if (browser) return { address: browser, source: "browser" };
  if (network === "mainnet" && google.phase === "ready" && google.address) return { address: google.address, source: "google" };
  return { address: undefined, source: null };
}

/** The call panel's waiting texts when the Google wallet is used (Circle's window instead of a browser wallet) */
export const GOOGLE_STATUS_TEXT = {
  "approve-wallet": "Approve the permission in Circle's window.",
  "approve-confirming": "Waiting for the permission to confirm…",
  "call-wallet": "Confirm your call in Circle's window.",
  "call-confirming": "Waiting for your call to confirm…",
} as const;

/** The claim waiting texts when the Google wallet is used */
export const GOOGLE_CLAIM_STATUS_TEXT = {
  "claim-wallet": "Confirm in Circle's window.",
  "claim-confirming": "Waiting for the confirmation…",
} as const;
