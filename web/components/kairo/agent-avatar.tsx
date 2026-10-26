import * as React from "react";

import type { Agent, AgentKey } from "@/lib/agents";
import { cn } from "@/lib/utils";

// Four robot heads that look like one team: the same size, the same visor, the same chin lights. Each one differs
// slightly (head corners, antenna, ears) so they are easy to tell apart, and each visor acts out its agent's
// personality in a loop (keyframes in app/globals.css; they switch off for people who prefer reduced motion).
// Once the agent has made its call for the current round, the outline of the head glows lime (UP) or lilac (DOWN).
//
// Drawing space is 64 x 64. Head x 9..55, y 14..54. Visor x 14..50, y 24..46 (the art is clipped to it).

const VISOR = { x: 14, y: 24, w: 36, h: 22 };

/** The small differences between the four heads (corner roundness, antenna and ears). */
const HEAD: Record<AgentKey, { rx: number; antenna: (c: string) => React.ReactNode; ears: (c: string) => React.ReactNode }> = {
  // round head, one ball on a stalk, round ear discs
  "trend-follower": {
    rx: 15,
    antenna: (c) => (
      <>
        <path d="M32 14V8" stroke={c} strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="32" cy="6.5" r="2.8" fill={c} />
      </>
    ),
    ears: (c) => (
      <>
        <circle cx="6" cy="34" r="3.6" fill={c} opacity="0.85" />
        <circle cx="58" cy="34" r="3.6" fill={c} opacity="0.85" />
      </>
    ),
  },
  // squarer head, two little horns leaning out, tall flat ears
  contrarian: {
    rx: 9,
    antenna: (c) => (
      <>
        <path d="M24 15L19 7M40 15L45 7" stroke={c} strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="18.5" cy="6.5" r="2.2" fill={c} />
        <circle cx="45.5" cy="6.5" r="2.2" fill={c} />
      </>
    ),
    ears: (c) => (
      <>
        <rect x="3.5" y="26" width="5" height="17" rx="2" fill={c} opacity="0.85" />
        <rect x="55.5" y="26" width="5" height="17" rx="2" fill={c} opacity="0.85" />
      </>
    ),
  },
  // medium head, a fin on top, bolts as ears
  "chart-reader": {
    rx: 11,
    antenna: (c) => <path d="M25 14L32 5L39 14Z" fill={c} strokeLinejoin="round" stroke={c} strokeWidth="1.6" />,
    ears: (c) => (
      <>
        <rect x="4" y="29" width="5" height="9" rx="1.5" fill={c} opacity="0.85" />
        <rect x="55" y="29" width="5" height="9" rx="1.5" fill={c} opacity="0.85" />
        <circle cx="6.5" cy="33.5" r="1" fill="rgba(0,0,0,0.5)" />
        <circle cx="57.5" cy="33.5" r="1" fill="rgba(0,0,0,0.5)" />
      </>
    ),
  },
  // roundest head, a dome button on top instead of an antenna, no ears (side dials)
  "coin-flipper": {
    rx: 17,
    antenna: (c) => <path d="M25 14A7 7 0 0 1 39 14Z" fill={c} />,
    ears: (c) => (
      <>
        <rect x="5" y="31" width="4" height="6" rx="2" fill={c} opacity="0.85" />
        <rect x="55" y="31" width="4" height="6" rx="2" fill={c} opacity="0.85" />
      </>
    ),
  },
};

const ART: Record<AgentKey, (c: string) => React.ReactNode> = {
  // a wave flowing forward across the visor
  "trend-follower": (c) => (
    <path
      className="kairo-wave"
      d="M-4 35 q4 -9 8 0 t8 0 t8 0 t8 0 t8 0 t8 0 t8 0 t8 0 t8 0"
      fill="none"
      stroke={c}
      strokeWidth="3.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ filter: `drop-shadow(0 0 2px ${c})` }}
    />
  ),
  // a row of small arrows going one way (right), one bigger arrow going the other way (left)
  contrarian: (c) => (
    <>
      <g className="kairo-row-right" fill="none" stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.65">
        {[-4, 5, 14, 23, 32, 41, 50].map((x) => (
          <path key={x} d={`M${x} 26.5l3 2.5l-3 2.5`} />
        ))}
      </g>
      <g className="kairo-drift-left" fill="none" stroke="white" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 3px ${c})` }}>
        <path d="M37 39H27M31 34.5L26.5 39L31 43.5" />
      </g>
    </>
  ),
  // three candlesticks (a thin wick, a body) that grow one after another, the last one lit
  "chart-reader": (c) => (
    <>
      <g stroke={c} strokeWidth="1.6" strokeLinecap="round" opacity="0.9">
        <path d="M22 28V46M32 24V44M42 21V40" />
      </g>
      <rect className="kairo-bar-1" x="18.5" y="34" width="7" height="8" rx="1.6" fill={c} opacity="0.55" />
      <rect className="kairo-bar-2" x="28.5" y="30" width="7" height="10" rx="1.6" fill={c} opacity="0.78" />
      <rect className="kairo-bar-3" x="38.5" y="24" width="7" height="13" rx="1.6" fill="white" style={{ filter: `drop-shadow(0 0 3px ${c})` }} />
    </>
  ),
  // a coin with two different faces, flipping with a hop
  "coin-flipper": (c) => (
    <g className="kairo-hop">
      <g className="kairo-face-a">
        <circle cx="32" cy="36" r="9" fill={c} />
        <circle cx="32" cy="36" r="5.6" fill="none" stroke="rgba(0,0,0,0.38)" strokeWidth="1.6" />
        <circle cx="32" cy="36" r="1.7" fill="rgba(0,0,0,0.5)" />
      </g>
      <g className="kairo-face-b">
        <circle cx="32" cy="36" r="9" fill={c} opacity="0.7" />
        <circle cx="32" cy="36" r="5.6" fill="none" stroke="rgba(0,0,0,0.38)" strokeWidth="1.6" />
        <path d="M28.5 36H35.5" stroke="rgba(0,0,0,0.55)" strokeWidth="2.2" strokeLinecap="round" />
      </g>
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
  /** The agent's call for the round that is open now; lights the outline. Leave out while it is not known. */
  call?: "UP" | "DOWN" | null;
  size?: number;
  className?: string;
}) {
  const uid = React.useId().replace(/:/g, "");
  const glow = call === "UP" ? "var(--color-up)" : call === "DOWN" ? "var(--color-down)" : null;
  const clip = `${uid}-visor`;
  const head = HEAD[agent.key];
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={cn("kairo-avatar shrink-0 overflow-visible", className)}
      role="img"
      aria-label={`${agent.name}${call ? `, calling ${call}` : ""}`}
      style={{ filter: `drop-shadow(0 0 ${glow ? 8 : 4}px ${glow ?? agent.colour})` }}
    >
      <defs>
        <clipPath id={clip}>
          <rect x={VISOR.x} y={VISOR.y} width={VISOR.w} height={VISOR.h} rx="8" />
        </clipPath>
      </defs>
      {head.ears(agent.colour)}
      {head.antenna(agent.colour)}
      {/* head: tinted in the agent's colour; the outline turns lime or lilac once the agent has called */}
      <rect
        className={glow ? "kairo-ring-on" : undefined}
        x="9"
        y="14"
        width="46"
        height="40"
        rx={head.rx}
        style={{ fill: `color-mix(in oklch, ${agent.colour} 22%, #11141a)`, stroke: glow ?? agent.colour, strokeWidth: glow ? 3.4 : 2.2, strokeOpacity: glow ? 1 : 0.75 }}
      />
      {/* visor */}
      <rect x={VISOR.x} y={VISOR.y} width={VISOR.w} height={VISOR.h} rx="8" fill="#0b0d12" />
      <g clipPath={`url(#${clip})`}>{ART[agent.key](agent.colour)}</g>
      <rect x={VISOR.x} y={VISOR.y} width={VISOR.w} height={VISOR.h} rx="8" fill="none" stroke={agent.colour} strokeOpacity="0.35" strokeWidth="1" />
      {/* chin lights: the same on every head */}
      <circle cx="25" cy="50" r="1.3" fill={agent.colour} opacity="0.8" />
      <circle cx="32" cy="50" r="1.3" fill={agent.colour} opacity="0.8" />
      <circle cx="39" cy="50" r="1.3" fill={agent.colour} opacity="0.8" />
    </svg>
  );
}
