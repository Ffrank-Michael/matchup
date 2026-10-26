/**
 * src/onchain/format.ts
 * ─────────────────────────────────────────────────────────────
 * Display helpers: USDC amounts, addresses, explorer links.
 * No blockchain calls; pure functions that take numbers and strings.
 */

import { NETWORK } from "./env";
import { arcTestnet, arcMainnet, USDC_DECIMALS } from "./chains";

// ── USDC display ─────────────────────────────────────────────

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdFmtWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Format a USDC amount (in the 6-decimal ERC-20 unit) as a dollar string.
 * e.g. 1_250_000n → "$1.25"
 *
 * Uses bigint input to avoid floating-point loss on large amounts.
 * Returns "$0.00" for null/undefined; returns null only if passed null explicitly.
 */
export function usdc(amount: bigint | number | null | undefined): string | null {
  if (amount === null || amount === undefined) return null;
  const n = typeof amount === "bigint" ? Number(amount) : amount;
  const dollars = n / 10 ** USDC_DECIMALS;
  // Use whole-dollar format for amounts >= $10,000 to reduce visual noise.
  return dollars >= 10_000 ? usdFmtWhole.format(dollars) : usdFmt.format(dollars);
}

/**
 * Format a raw USDC unit count as a plain number (no $ sign).
 * e.g. 1_250_000n → "1.25"
 */
export function usdcRaw(amount: bigint | number): string {
  const n = typeof amount === "bigint" ? Number(amount) : amount;
  const dollars = n / 10 ** USDC_DECIMALS;
  return dollars.toFixed(2);
}

// ── Address display ──────────────────────────────────────────

/**
 * Shorten an address for display: "0x1234…abcd"
 */
export function shortAddress(address: string): string {
  if (address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// ── Explorer links ───────────────────────────────────────────

const explorerBase =
  NETWORK === "mainnet"
    ? arcMainnet.blockExplorers.default.url
    : arcTestnet.blockExplorers.default.url;

/**
 * Explorer link for a transaction hash.
 */
export function txExplorerUrl(txHash: string): string {
  return `${explorerBase}/tx/${txHash}`;
}

/**
 * A clickable explorer link for a transaction.
 * Alias of txExplorerUrl — named txLink for ergonomics in JSX.
 * e.g. <a href={txLink(hash)}>View transaction</a>
 */
export function txLink(hash: string | null | undefined): string | null {
  if (!hash) return null;
  return txExplorerUrl(hash);
}

/**
 * Explorer link for an address.
 */
export function addressExplorerUrl(address: string): string {
  return `${explorerBase}/address/${address}`;
}

// ── Price display ────────────────────────────────────────────

/**
 * Format a raw Chainlink 8-decimal price as a USD string.
 * e.g. 6_000_000_000_000n → "$60,000" or "$60,000.00" depending on magnitude.
 */
export function formatPrice(rawPrice: bigint | number | null | undefined): string | null {
  if (rawPrice === null || rawPrice === undefined) return null;
  const n = typeof rawPrice === "bigint" ? Number(rawPrice) : rawPrice;
  const dollars = n / 1e8;
  const fmt =
    dollars >= 10_000
      ? usdFmtWhole
      : dollars >= 1
      ? usdFmt
      : new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 4,
          maximumFractionDigits: 4,
        });
  return fmt.format(dollars);
}

// ── Time helpers ─────────────────────────────────────────────

/**
 * Format a countdown as "MM:SS".
 */
export function formatCountdown(totalSeconds: number): string {
  const secs = Math.max(0, totalSeconds);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Format a Unix timestamp as "HH:MM" in the viewer's time zone.
 */
export function formatHm(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
