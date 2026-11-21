// "Send USDC" from the Google (Circle) wallet: the checks and sums, with no React and no network, so they can be tested.
// All money is handled as whole numbers of micro-USDC (6 decimals, bigint), never as floating point.

export const USDC_UNIT = 1_000_000n;
/** Kept back by "Max" when Circle's fee estimate is not known yet (0.05 USDC) */
export const DEFAULT_RESERVE = 50_000n;
/** The smallest amount "Max" keeps back, even when the estimate is tiny (0.01 USDC, like the browser-wallet path) */
export const MIN_RESERVE = 10_000n;
/** Above this a line asks the player to check twice */
export const LARGE_SEND = 100n * USDC_UNIT;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^(\d{1,12})(?:\.(\d{1,6}))?$/;

/** "12.5" -> 12500000n. Null for anything that is not a plain positive-or-zero number with at most 6 decimals. */
export function toUnits(s: string): bigint | null {
  const m = AMOUNT.exec(s.trim());
  if (!m) return null;
  return BigInt(m[1]) * USDC_UNIT + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** 12500000n -> "12.5" */
export function fromUnits(u: bigint): string {
  const neg = u < 0n;
  const a = neg ? -u : u;
  const frac = (a % USDC_UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / USDC_UNIT}${frac ? `.${frac}` : ""}`;
}

/** A fee from Circle ("0.000412345678901234", any number of decimals) in micro-USDC, ROUNDED UP so it is never under-counted. */
export function feeToUnits(s: string | null | undefined): bigint | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  let u = BigInt(m[1]) * USDC_UNIT + BigInt(frac.slice(0, 6).padEnd(6, "0"));
  if (/[1-9]/.test(frac.slice(6))) u += 1n;
  return u;
}

/** A balance from Circle ("12.5", maybe more than 6 decimals) in micro-USDC, ROUNDED DOWN so it is never over-counted. */
export function balanceToUnits(s: string | null | undefined): bigint | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(s.trim());
  return m ? BigInt(m[1]) * USDC_UNIT + BigInt((m[2] ?? "").slice(0, 6).padEnd(6, "0")) : null;
}

/** What "Max" keeps back for the network fee: twice Circle's estimate (fees can rise a little), at least 0.01 USDC;
 *  0.05 USDC when there is no estimate. */
export function feeReserve(fee: bigint | null): bigint {
  if (fee === null) return DEFAULT_RESERVE;
  const twice = fee * 2n;
  return twice > MIN_RESERVE ? twice : MIN_RESERVE;
}

/** The largest amount "Max" fills in: the balance minus the reserve, never below zero. */
export function maxSendable(balance: bigint, fee: bigint | null): bigint {
  const left = balance - feeReserve(fee);
  return left > 0n ? left : 0n;
}

/** What "Max" fills in for a withdrawal. A sponsored wallet (the older smart-contract wallet, whose fee the Gas Station policy
 *  pays) keeps nothing back: the whole balance. Otherwise the same as maxSendable (balance minus the fee reserve). */
export function maxWithdraw(balance: bigint, fee: bigint | null, sponsored: boolean): bigint {
  return sponsored ? (balance > 0n ? balance : 0n) : maxSendable(balance, fee);
}

export function isAddress(s: string): boolean {
  return ADDRESS.test(s.trim());
}

/** The first problem with the form, in plain words, or null when it can be sent. `fee` is Circle's estimate (null = unknown). */
export function checkSend(f: { to: string; amount: string; own: string | null; balance: bigint | null; fee: bigint | null }): string | null {
  const to = f.to.trim();
  if (!to) return "Enter the address to send to.";
  if (!isAddress(to)) return "That is not a valid address. It starts with 0x and has 40 letters and numbers after it.";
  if (/^0x0{40}$/i.test(to)) return "That is the zero address. Nobody can use USDC sent there.";
  if (f.own && to.toLowerCase() === f.own.toLowerCase()) return "That is this wallet's own address. Enter a different one.";
  if (!f.amount.trim()) return "Enter an amount.";
  const amount = toUnits(f.amount);
  if (amount === null) return "Enter the amount as a number, like 1 or 0.5 (at most 6 decimals).";
  if (amount <= 0n) return "The amount must be more than 0.";
  if (f.balance === null) return "Your balance is still loading.";
  if (amount > f.balance) return `That is more than your balance (${fromUnits(f.balance)} USDC).`;
  if (f.fee !== null && amount + f.fee > f.balance) {
    return `Leave about ${fromUnits(f.fee)} USDC for the network fee. "Max" does this for you.`;
  }
  return null;
}

// ── After the player approves ─────────────────────────────────

export type Transfer = {
  id: string | null;
  state: string | null;
  txHash: string | null;
  destinationAddress: string | null;
  amounts: string[];
  errorReason: string | null;
};

const FINAL_OK = new Set(["COMPLETE"]);
const FINAL_BAD = new Set(["FAILED", "DENIED", "CANCELLED"]);
export const isFinalState = (s: string | null) => s !== null && (FINAL_OK.has(s) || FINAL_BAD.has(s));
export const isFailedState = (s: string | null) => s !== null && FINAL_BAD.has(s);

/** The transfer this send made: the newest one that was not in the list before the send, to the same address, for the same
 *  amount. (Circle's approval answer does not include the transaction id, so it is found in the wallet's recent transfers.) */
export function findNewTransfer(list: Transfer[], before: Set<string>, to: string, amount: string): Transfer | null {
  const want = toUnits(amount);
  return (
    list.find(
      (t) =>
        t.id !== null &&
        !before.has(t.id) &&
        t.destinationAddress?.toLowerCase() === to.trim().toLowerCase() &&
        want !== null &&
        t.amounts.length > 0 &&
        feeToUnits(t.amounts[0]) === want,
    ) ?? null
  );
}

export function explorerTxUrl(explorer: string, hash: string): string | null {
  return /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${explorer}/tx/${hash}` : null;
}

// ── Plain-word errors ─────────────────────────────────────────

/** Circle's window ended without approving (Web SDK error codes) */
export function challengeErrorText(e: { code?: number | null; message?: string | null; closed?: boolean }): string {
  if (e.closed || e.code === 155701) return "You closed Circle's confirmation screen, so nothing was sent.";
  switch (e.code) {
    case 155104:
    case 155105:
    case 155718:
      return "Your Google sign-in has run out. Sign in again, then send.";
    case 155121:
      return "The confirmation took too long and ran out. Nothing was sent. Press Send again.";
    case 155706:
      return "Circle could not be reached. Check your connection; nothing was sent.";
    case 155713:
      return "Circle says too many tries. Wait a while and try again. Nothing was sent.";
    case 155702:
      return "Circle's confirmation screen could not open. Allow pop-ups for this site and try again.";
    default:
      return `Circle did not send it${e.message ? `: ${e.message}` : "."} Nothing was sent.`;
  }
}

/** Circle refused to prepare the transfer (API error codes from /api/circle) */
export function transferErrorText(code: unknown, message: unknown): string {
  // A smart-contract wallet whose fee is meant to be sponsored, but Circle finds no Gas Station policy that covers it
  if (typeof message === "string" && /paymaster|gas station/i.test(message)) {
    return "Circle says the network fee for this wallet is not covered right now (its Gas Station fee sponsorship is not set up or has run out). Nothing was sent.";
  }
  switch (code) {
    case 155201:
    case 155204:
    case 155205:
    case 155258:
      return "Circle says there is not enough USDC for this amount plus the network fee. Try a smaller amount or press Max.";
    case 155219:
      return "Circle says that address cannot receive this transfer. Check it and try again.";
    case 155264:
      return "This wallet already has transfers waiting. Wait a minute and try again.";
    case 155104:
    case 155105:
      return "Your Google sign-in has run out. Sign in again, then send.";
    default:
      return typeof message === "string" && message ? `Circle refused the transfer: ${message}` : "Circle refused the transfer. Try again.";
  }
}

/** A transfer that ended badly (Circle's transaction states), in plain words */
export function failedStateText(state: string | null, reason: string | null): string {
  const why = reason ? ` (${reason.toLowerCase().replace(/_/g, " ")})` : "";
  if (state === "DENIED") return `Circle's safety check stopped this transfer${why}. Your USDC did not move.`;
  if (state === "CANCELLED") return "The transfer was cancelled before it went on chain. Your USDC did not move.";
  return `The transfer failed${why}. Check your balance; a network fee may have been taken.`;
}
