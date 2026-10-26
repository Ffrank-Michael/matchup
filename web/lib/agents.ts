// The four house agents as the site shows them: name, short name (for phones), own colour, tagline and one line on how each decides.
// The "how" lines come from the agents' real rules (agents/*.mjs). Their calls, reasons, win rates, profits
// and recent results are NOT here: those come from the contract once it is live, so the site shows
// "not live yet" for them. Lime and lilac are reserved for UP and DOWN, so no agent uses them.

export type AgentKey = "trend-follower" | "contrarian" | "chart-reader" | "coin-flipper";

export const AGENTS: ReadonlyArray<{ key: AgentKey; number: number; name: string; short: string; tagline: string; colour: string; how: string; rule?: string }> = [
  { key: "trend-follower", number: 1, name: "Trend Follower", short: "Trend", tagline: "Rides the trend", colour: "oklch(0.8 0.12 185)", how: "Calls the same way the last round went." },
  { key: "contrarian", number: 2, name: "Contrarian", short: "Contrarian", tagline: "Fades the crowd", colour: "oklch(0.74 0.17 48)", how: "Calls against the side with more money on it." },
  { key: "chart-reader", number: 3, name: "Chart Reader", short: "Chart", tagline: "Reads the chart", colour: "oklch(0.87 0.16 95)", how: "Reads 1-minute candles. Never skips: when the signals disagree it follows the last candle.", rule: "Reads 1-minute candles and calls every round. UP when the 5-candle average is above the 20-candle average and the last candle closed higher, DOWN for the opposite. When those two disagree it follows the last candle: UP if it closed higher, DOWN if lower, and the 5-candle trend if it closed exactly flat." },
  { key: "coin-flipper", number: 4, name: "Coin Flipper", short: "Coin Flip", tagline: "Leaves it to luck", colour: "oklch(0.78 0.11 235)", how: "Picks UP or DOWN at random." },
];

export type Agent = (typeof AGENTS)[number];

/** What the contract will tell the site about an agent. Every field is missing until the contract is live. */
export type AgentLive = {
  /** The agent's call for the round that is open now */
  call?: "UP" | "DOWN";
  /** Its one-line reason for that call */
  reason?: string;
  /** Share of finished rounds won, 0 to 1 */
  winRate?: number;
  /** Profit in USDC */
  profit?: number;
  /** The last five results, newest first */
  last5?: ReadonlyArray<"won" | "lost" | "refunded">;
};
