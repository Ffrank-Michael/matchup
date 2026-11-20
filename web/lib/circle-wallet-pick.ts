// Picks the player's Arc mainnet wallet and its USDC out of the lists /api/circle returns (see lib/circle-api.ts).
export type CircleWallet = { id: string | null; address: string | null; blockchain: string | null; accountType: string | null; state: string | null };
export type CircleBalance = { amount: string | null; symbol: string | null; name: string | null; tokenAddress: string | null; isNative: boolean; decimals: number | null };

/** The first live wallet on Arc mainnet ("ARC") with an id and an address, or null. */
export function pickArcWallet(wallets: CircleWallet[]): { id: string; address: `0x${string}` } | null {
  const w = wallets.find((w) => w.blockchain === "ARC" && w.state !== "FROZEN" && w.id && w.address && /^0x[0-9a-fA-F]{40}$/.test(w.address));
  return w ? { id: w.id as string, address: w.address as `0x${string}` } : null;
}

/** The wallet's USDC in whole dollars ("12.5"). On Arc, USDC is both the gas money and a token: they are the same money, so
 *  one entry is shown (the token first, like the rest of the site). No USDC entry means nothing was ever received: "0". */
export function pickUsdc(balances: CircleBalance[]): string {
  const usdc = balances.filter((b) => b.symbol?.toUpperCase().startsWith("USDC") && b.amount !== null && Number.isFinite(Number(b.amount)));
  const pick = usdc.find((b) => !b.isNative) ?? usdc[0];
  return pick ? (pick.amount as string) : "0";
}
