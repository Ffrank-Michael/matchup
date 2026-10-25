/**
 * Which side is winning right now: the live price against the round's start price.
 * null until there is a start price (it only exists once the round has started and been recorded),
 * so the site never shows a "winning" label it cannot back up.
 */
export type Winning = "UP" | "DOWN" | "LEVEL";

export function winningSide(price: number | null, startPrice: number | null): Winning | null {
  if (price === null || startPrice === null) return null;
  if (price > startPrice) return "UP";
  if (price < startPrice) return "DOWN";
  return "LEVEL";
}

export const WINNING_TEXT: Record<Winning, string> = {
  UP: "UP winning",
  DOWN: "DOWN winning",
  LEVEL: "Level with start price",
};
