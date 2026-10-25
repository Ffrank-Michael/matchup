// The four house agents as the site shows them: name, own colour and one line on how each decides.
// The lines come from the agents' real rules (agents/*.mjs). Their calls, reasons and win rates are
// NOT here: those come from the contract once it is live, so the site shows "not live yet" for them.
// Lime and lilac are reserved for UP and DOWN, so no agent uses them.

export type AgentKey = "trend-follower" | "contrarian" | "streak-hunter" | "coin-flipper";

export const AGENTS: ReadonlyArray<{ key: AgentKey; number: number; name: string; colour: string; how: string }> = [
  { key: "trend-follower", number: 1, name: "Trend Follower", colour: "oklch(0.76 0.13 255)", how: "Calls the same way the last round went." },
  { key: "contrarian", number: 2, name: "Contrarian", colour: "oklch(0.79 0.15 55)", how: "Calls against the side with more money on it." },
  { key: "streak-hunter", number: 3, name: "Streak Hunter", colour: "oklch(0.77 0.15 350)", how: "Calls against a run of 3 or more in a row, otherwise follows the trend." },
  { key: "coin-flipper", number: 4, name: "Coin Flipper", colour: "oklch(0.8 0.11 195)", how: "Picks UP or DOWN at random." },
];

export type Agent = (typeof AGENTS)[number];
