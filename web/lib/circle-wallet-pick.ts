// Picks the player's Arc mainnet wallets and their USDC out of the lists /api/circle returns (see lib/circle-api.ts).
export type CircleWallet = { id: string | null; address: string | null; blockchain: string | null; accountType: string | null; state: string | null };
export type CircleBalance = { amount: string | null; symbol: string | null; name: string | null; tokenAddress: string | null; isNative: boolean; decimals: number | null };

export type PickedWallet = { id: string; address: `0x${string}` };

const usable = (w: CircleWallet) => w.blockchain === "ARC" && w.state !== "FROZEN" && Boolean(w.id) && Boolean(w.address) && /^0x[0-9a-fA-F]{40}$/.test(w.address ?? "");
const picked = (w: CircleWallet | undefined): PickedWallet | null => (w ? { id: w.id as string, address: w.address as `0x${string}` } : null);

/** The player's wallets on Arc mainnet ("ARC"):
 *  - eoa: the first live EOA. This is the wallet the site uses: it pays its own network fee in USDC.
 *  - sca: the first live smart-contract wallet (SCA). The first Google players got one of these (phase 1 made SCA wallets).
 *    On Arc mainnet Circle only lets an SCA send with a Gas Station (paymaster) policy; the owner has set one up, so the
 *    wallet window shows this wallet with its balance and its own Withdraw (fee sponsored). It is NOT deleted and its USDC is
 *    not hidden. If both exist, the EOA is always the main wallet. */
export function pickArcWallets(wallets: CircleWallet[]): { eoa: PickedWallet | null; sca: PickedWallet | null } {
  const live = wallets.filter(usable);
  return {
    eoa: picked(live.find((w) => w.accountType === "EOA")),
    sca: picked(live.find((w) => w.accountType === "SCA")),
  };
}

/** What to do with the wallets just listed:
 *  - "use": there is an EOA on ARC, use it (whatever else exists);
 *  - "create": only an old SCA on ARC, and no EOA has been asked for yet in this load: ask Circle for an EOA (once);
 *  - "wait": nothing usable yet (a wallet Circle is still making can take a few seconds to show up): look again. */
export function walletStep(found: { eoa: PickedWallet | null; sca: PickedWallet | null }, eoaRequested: boolean): "use" | "create" | "wait" {
  if (found.eoa) return "use";
  if (found.sca && !eoaRequested) return "create";
  return "wait";
}

/** The wallet's USDC in whole dollars ("12.5"). On Arc, USDC is both the gas money and a token: they are the same money, so
 *  one entry is shown (the token first, like the rest of the site). No USDC entry means nothing was ever received: "0". */
export function pickUsdc(balances: CircleBalance[]): string {
  const usdc = balances.filter((b) => b.symbol?.toUpperCase().startsWith("USDC") && b.amount !== null && Number.isFinite(Number(b.amount)));
  const pick = usdc.find((b) => !b.isNative) ?? usdc[0];
  return pick ? (pick.amount as string) : "0";
}
