import * as React from "react";

import type { Agent, AgentKey } from "@/lib/agents";
import { cn } from "@/lib/utils";

// An animated avatar: a glowing circle in the agent's colour with a small loop that acts out its personality
// (keyframes in app/globals.css; they switch off for people who prefer reduced motion).
// Once the agent has made its call for the current round, the ring around it glows lime (UP) or lilac (DOWN).

const ART: Record<AgentKey, (c: string, clip: string) => React.ReactNode> = {
  // a line flowing forward across the circle like a wave
  "trend-follower": (c, clip) => (
    <g clipPath={`url(#${clip})`}>
      <path
        className="kairo-wave"
        d="M-32 34 q8 -14 16 0 t16 0 t16 0 t16 0 t16 0 t16 0 t16 0"
        fill="none"
        stroke={c}
        strokeWidth="3.4"
        strokeLinecap="round"
      />
    </g>
  ),
  // a cluster of small dots drifting one way, one bright dot going the opposite way
  contrarian: (c, clip) => (
    <g clipPath={`url(#${clip})`}>
      {[
        [24, 22, 0],
        [34, 28, 0.5],
        [28, 34, 1.1],
        [38, 40, 1.6],
        [22, 42, 2.2],
      ].map(([x, y, d]) => (
        <circle key={`${x}-${y}`} className="kairo-drift-right" cx={x} cy={y} r="2.4" fill={c} style={{ animationDelay: `${d}s`, opacity: 0.6 }} />
      ))}
      <circle className="kairo-drift-left" cx="32" cy="32" r="4.4" fill="white" style={{ filter: `drop-shadow(0 0 4px ${c})` }} />
    </g>
  ),
  // three bars rising one after another, then a crosshair locks onto the third
  "streak-hunter": (c, clip) => (
    <g clipPath={`url(#${clip})`}>
      <rect className="kairo-bar-1" x="18" y="34" width="7" height="12" rx="2" fill={c} opacity="0.55" />
      <rect className="kairo-bar-2" x="28.5" y="28" width="7" height="18" rx="2" fill={c} opacity="0.75" />
      <rect className="kairo-bar-3" x="39" y="20" width="7" height="26" rx="2" fill={c} />
      <g className="kairo-lock" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="42.5" cy="19" r="6" />
        <path d="M42.5 10.5v4M42.5 23.5v4M34 19h4M47 19h4" />
      </g>
    </g>
  ),
  // a coin flipping in 3D
  "coin-flipper": (c) => (
    <g className="kairo-flip">
      <circle cx="32" cy="34" r="11" fill={c} opacity="0.95" />
      <circle cx="32" cy="34" r="8" fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth="1.6" />
      <path d="M29 37l3-6 3 6" fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  ),
};

export function AgentAvatar({
  agent,
  call,
  size = 64,
  className,
}: {
  agent: Agent;
  /** The agent's call for the round that is open now; lights the ring. Leave out while it is not known. */
  call?: "UP" | "DOWN" | null;
  size?: number;
  className?: string;
}) {
  const uid = React.useId().replace(/:/g, "");
  const ring = call === "UP" ? "var(--color-up)" : call === "DOWN" ? "var(--color-down)" : null;
  const clip = `${uid}-clip`;
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={cn("kairo-avatar shrink-0 overflow-visible", className)}
      role="img"
      aria-label={`${agent.name}${call ? `, calling ${call}` : ""}`}
      style={{ filter: `drop-shadow(0 0 ${ring ? 9 : 6}px ${ring ?? agent.colour})` }}
    >
      <defs>
        <clipPath id={clip}>
          <circle cx="32" cy="32" r="24" />
        </clipPath>
        <radialGradient id={`${uid}-bg`} cx="50%" cy="40%" r="70%">
          <stop offset="0" style={{ stopColor: agent.colour, stopOpacity: 0.32 }} />
          <stop offset="1" style={{ stopColor: agent.colour, stopOpacity: 0.08 }} />
        </radialGradient>
      </defs>
      {/* ring: the agent's own colour until it has called, then lime or lilac */}
      <circle
        className={ring ? "kairo-ring-on" : undefined}
        cx="32"
        cy="32"
        r="29"
        fill="none"
        strokeWidth={ring ? 3.5 : 2}
        style={{ stroke: ring ?? agent.colour, opacity: ring ? 1 : 0.55 }}
      />
      <circle cx="32" cy="32" r="25" fill={`url(#${uid}-bg)`} />
      {ART[agent.key](agent.colour, clip)}
    </svg>
  );
}
