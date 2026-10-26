import deployment from "./deployment.generated.json";
import { AGENTS, type Agent } from "./agents";

// Who a wallet address on the chain is, in words: one of the four house agents (their public addresses are in the
// deployment file), "You" for the connected wallet, or "Player 0x37…C4" for anyone else. The site never shows a raw address.

const AGENT_BY_ADDRESS = new Map<string, Agent>(
  (deployment.agents ?? []).flatMap((a) => {
    const agent = AGENTS.find((x) => x.key === a.key);
    return agent ? [[a.address.toLowerCase(), agent] as const] : [];
  }),
);

export type Who = { kind: "you" } | { kind: "agent"; agent: Agent } | { kind: "player" };

/** "0x37…C4": the first four characters and the last two. */
export const playerTag = (address: string) => `${address.slice(0, 4)}…${address.slice(-2).toUpperCase()}`;

export function whoIs(address: string, me: string | undefined): Who {
  if (me && address.toLowerCase() === me.toLowerCase()) return { kind: "you" };
  const agent = AGENT_BY_ADDRESS.get(address.toLowerCase());
  return agent ? { kind: "agent", agent } : { kind: "player" };
}

/** The name shown for a wallet: "You", the agent's name, or "Player 0x37…C4". */
export function whoName(address: string, me: string | undefined): string {
  const w = whoIs(address, me);
  return w.kind === "you" ? "You" : w.kind === "agent" ? w.agent.name : `Player ${playerTag(address)}`;
}
