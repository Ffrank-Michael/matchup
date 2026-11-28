// The share link for a round: it opens the site on that round's market with the call panel ready. It only picks the
// market and time frame and scrolls to the panel. It never picks a side, never sets an amount and never places a call:
// the visitor still has to choose and confirm, and a visitor with no wallet sees the same page as everyone else.
// No React and no network, so it can be tested.

type MarketLike = { id: number; key: string; roundSeconds: number };

export type Shared = { marketId: number; key: string; roundSeconds: number; roundIndex: number };

/** The link for one round, e.g. https://www.playmatchup.xyz/?market=3&round=5871234 */
export function shareUrl(origin: string, marketId: number, roundIndex: number): string {
  const u = new URL("/", origin);
  u.searchParams.set("market", String(marketId));
  u.searchParams.set("round", String(roundIndex));
  return u.toString();
}

const wholeNumber = (v: string | null) => (v !== null && /^\d{1,12}$/.test(v) ? Number(v) : null);

/** The round a link points to, or null when the link has none, or names a market this site does not have. */
export function readShare(search: string, markets: readonly MarketLike[]): Shared | null {
  const q = new URLSearchParams(search);
  const marketId = wholeNumber(q.get("market"));
  const roundIndex = wholeNumber(q.get("round"));
  if (marketId === null || roundIndex === null) return null;
  const m = markets.find((x) => x.id === marketId);
  if (!m) return null;
  return { marketId, key: m.key, roundSeconds: m.roundSeconds, roundIndex };
}

export const SHARED_OPEN_TEXT = "You opened a shared round. Pick UP or DOWN and an amount. Nothing is called until you confirm.";
export const SHARED_CLOSED_TEXT = "The shared round has closed. This is the round you can call now.";
export const SHARED_LATER_TEXT = "The shared round is not open yet. This is the round you can call now.";

/** The note on the call panel for a shared link, or null (no link, the market is not the one shown, or rounds not read yet). */
export function sharedNote(shared: Shared | null, shownMarketId: number, nextRound: number | null): string | null {
  if (!shared || shared.marketId !== shownMarketId || nextRound === null) return null;
  if (shared.roundIndex === nextRound) return SHARED_OPEN_TEXT;
  return shared.roundIndex < nextRound ? SHARED_CLOSED_TEXT : SHARED_LATER_TEXT;
}
