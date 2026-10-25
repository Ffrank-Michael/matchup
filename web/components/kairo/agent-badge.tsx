import type { Agent, AgentKey } from "@/lib/agents";

const PATHS: Record<AgentKey, React.ReactNode> = {
  // an arrow climbing
  "trend-follower": <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
  // two arrows going opposite ways
  contrarian: <path d="M7 7h12l-3-3M17 17H5l3 3" />,
  // a flame
  "streak-hunter": <path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9Z" />,
  // a coin
  "coin-flipper": (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
};

/** The agent's own colour and a simple icon, in a rounded square. */
export function AgentBadge({ agent, size = 40 }: { agent: Agent; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-xl"
      style={{ width: size, height: size, background: `color-mix(in oklch, ${agent.colour} 20%, transparent)`, color: agent.colour }}
      aria-hidden
    >
      <svg width={size * 0.52} height={size * 0.52} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {PATHS[agent.key]}
      </svg>
    </span>
  );
}
