/**
 * onchain/env.ts
 * The ONLY file that reads environment variables (Next.js build: NEXT_PUBLIC_ variables must be written out in full so they
 * are put into the page). Arc Studio's version reads Vite variables; this is the Next.js version of the same file.
 */

/** "testnet" | "mainnet", default testnet */
export const NETWORK: "testnet" | "mainnet" = process.env.NEXT_PUBLIC_NETWORK === "mainnet" ? "mainnet" : "testnet";

/** WalletConnect project id (optional): the WalletConnect connector is skipped without it */
export const WALLETCONNECT_PROJECT_ID: string | undefined = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || undefined;

/** "Continue with Google" (Circle user-controlled wallets): both public; the option is hidden unless both are set */
export const CIRCLE_APP_ID: string | undefined = process.env.NEXT_PUBLIC_CIRCLE_APP_ID || undefined;
export const GOOGLE_CLIENT_ID: string | undefined = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || undefined;
