// The four house agents as the site shows them: name, short name (for phones), own colour, tagline and one line on how each decides.
// The "how" lines come from the agents' real rules (agents/*.mjs). Their calls, reasons, win rates, profits
// and recent results are NOT here: those come from the contract once it is live, so the site shows
// "not live yet" for them. Lime and lilac are reserved for UP and DOWN, so no agent uses them.

export type AgentKey = "trend-follower" | "contrarian" | "chart-reader" | "coin-flipper";

export const AGENTS: ReadonlyArray<{ key: AgentKey; number: number; name: string; short: string; tagline: string; colour: string; how: string; rule?: string; ai?: boolean }> = [
  { key: "trend-follower", number: 1, name: "Trend Follower", short: "Trend", tagline: "Rides the trend", colour: "oklch(0.8 0.12 185)", how: "An AI that reads the recent candles and rides the trend.", ai: true, rule: "Every 10 minutes an AI model is shown the latest one-minute candles and gives every open round its own call, so every 5-minute round is covered. This agent believes in momentum: a price that has been moving one way tends to keep going. It answers UP or DOWN with one short sentence. If the AI does not answer in time, it skips the round." },
  { key: "contrarian", number: 2, name: "Contrarian", short: "Contrarian", tagline: "Fades the crowd", colour: "oklch(0.74 0.17 48)", how: "An AI that fades the crowd and stretched moves.", ai: true, rule: "Every 10 minutes an AI model is shown the latest one-minute candles and gives every open round its own call, so every 5-minute round is covered. This agent fades the crowd and stretched moves: when the price has run hard one way, it leans the other way. It goes last in each round, after the others have called. If one side has no money yet, the rules of the game fix its call to that side and its reason says so. If the AI does not answer in time, it skips the round." },
  { key: "chart-reader", number: 3, name: "Chart Reader", short: "Chart", tagline: "Reads the chart", colour: "oklch(0.87 0.16 95)", how: "An AI that reads candle shapes and levels.", ai: true, rule: "Every 10 minutes an AI model is shown the latest one-minute candles and gives every open round its own call, so every 5-minute round is covered. This agent reads candle shapes and levels: sizes, wicks, highs and lows, and how the short average sits against the longer one. It answers UP or DOWN with one short sentence. If the AI does not answer in time, it skips the round." },
  { key: "coin-flipper", number: 4, name: "Coin Flipper", short: "Coin Flip", tagline: "Leaves it to luck", colour: "oklch(0.78 0.11 235)", how: "Picks UP or DOWN at random. The benchmark: can AI beat a coin flip?" },
];

export type Agent = (typeof AGENTS)[number];

/** What the contract will tell the site about an agent. Every field is missing until the contract is live. */
export type AgentLive = {
  /** The agent's call for the round that is open now */
  call?: "UP" | "DOWN";
  /** Its one-line reason for that call (an AI note, written by the model) */
  reason?: string;
  /** The reason was written by the game's rules (a side with no money was fixed), not by the AI */
  ruleReason?: boolean;
  /** The AI could not decide this round, so the agent skipped it */
  skipped?: boolean;
  /** Share of finished rounds won, 0 to 1 */
  winRate?: number;
  /** Profit in USDC */
  profit?: number;
  /** The last five results, newest first */
  last5?: ReadonlyArray<"won" | "lost" | "refunded">;
  /** The call above is a guide call: made for the round whether or not anyone plays, no money, nothing on chain */
  guide?: boolean;
  /** When the call above was made (seconds) */
  callAt?: number;
  /** The call above is a real call sent on chain by the agent's wallet: the transaction */
  callTx?: string;
  /** Guide calls only: the last five calls on this market, newest first, and how each ended (pending until the round ends) */
  guideRecent?: ReadonlyArray<{ round: number; call: "UP" | "DOWN"; at: number; res: "won" | "lost" | "none" | "pending" }>;
  /** Guide calls only: how many calls the win rate comes from */
  guideDecided?: number;
};
