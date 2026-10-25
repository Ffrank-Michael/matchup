"use client";

import * as React from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Web3Allocation {
  symbol: string;
  value: number;
}

export interface Web3Activity {
  id: string;
  kind: "swap" | "bridge" | "stake" | "mint" | "receive";
  title: string;
  detail: string;
  amount: string;
  status: "confirmed" | "pending" | "failed";
  time: string;
}

export interface Web3BentoProps {
  /** ENS or short address shown in the greeting */
  account?: string;
  network?: string;
  /** Portfolio value, oldest → newest, one point per day (at least 30) */
  history?: number[];
  /** Benchmark (e.g. ETH price) on the same scale, same length as history */
  benchmark?: number[];
  allocation?: Web3Allocation[];
  staking?: { asset: string; staked: number; apy: number; rewards: number; usdPrice: number };
  liquidity?: { pair: string; fee: string; min: number; max: number; price: number; fees: number };
  activity?: Web3Activity[];
  /** Cards in the stack, back → front */
  cards?: Web3Card[];
  /** Main accent (default warm amber) and secondary accent (default lilac) */
  accent?: string;
  accent2?: string;
  locale?: string;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Demo data                                                          */
/* ------------------------------------------------------------------ */

function walk(seed: number, n: number, start: number, drift: number, vol: number) {
  let h = seed;
  const rnd = () => {
    h = (h * 16807) % 2147483647;
    return h / 2147483647;
  };
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    v *= 1 + drift + (rnd() - 0.5) * vol;
    out.push(v);
  }
  return out.map((_, i) => {
    const w = out.slice(Math.max(0, i - 3), i + 1);
    return w.reduce((s, x) => s + x, 0) / w.length;
  });
}

export const DEMO = {
  account: "vasnev.eth",
  network: "Ethereum",
  history: walk(7, 365, 61000, 0.0011, 0.045),
  benchmark: walk(11, 365, 61000, 0.0006, 0.05),
  allocation: [
    { symbol: "ETH", value: 58200 },
    { symbol: "USDC", value: 21400 },
    { symbol: "ARB", value: 9800 },
    { symbol: "OP", value: 6100 },
    { symbol: "Other", value: 4300 },
  ],
  staking: { asset: "ETH", staked: 32, apy: 3.42, rewards: 0.41837215, usdPrice: 3368.5 },
  liquidity: { pair: "ETH / USDC", fee: "0.05%", min: 3120, max: 3640, price: 3368.5, fees: 412.8 },
  activity: [
    { id: "a1", kind: "bridge", title: "Bridge to Base", detail: "via Across", amount: "−1.20 ETH", status: "pending", time: "now" },
    { id: "a2", kind: "swap", title: "Swap ETH → USDC", detail: "Uniswap v4", amount: "+4,210 USDC", status: "confirmed", time: "12m" },
    { id: "a3", kind: "stake", title: "Stake", detail: "Lido", amount: "−2.00 ETH", status: "confirmed", time: "2h" },
    { id: "a4", kind: "mint", title: "Mint · Genesis Pass #418", detail: "Zora", amount: "−0.01 ETH", status: "confirmed", time: "1d" },
    { id: "a5", kind: "receive", title: "Received", detail: "from 0x8f…21c4", amount: "+500 USDC", status: "confirmed", time: "2d" },
  ] as Web3Activity[],
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function useReducedMotion() {
  const [r, setR] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const u = () => setR(mq.matches);
    u();
    mq.addEventListener("change", u);
    return () => mq.removeEventListener("change", u);
  }, []);
  return r;
}

function useMounted() {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return on;
}

function useCountUp(target: number, enabled: boolean, duration = 1300) {
  const [v, setV] = React.useState(enabled ? 0 : target);
  React.useEffect(() => {
    if (!enabled) return setV(target);
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      setV(target * (1 - Math.pow(1 - p, 4)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, enabled, duration]);
  return v;
}

function smooth(pts: ReadonlyArray<readonly [number, number]>) {
  return pts
    .map(([x, y], i) => {
      if (i === 0) return `M ${x.toFixed(1)} ${y.toFixed(1)}`;
      const [px, py] = pts[i - 1];
      const m = (px + x) / 2;
      return `C ${m.toFixed(1)} ${py.toFixed(1)}, ${m.toFixed(1)} ${y.toFixed(1)}, ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

type Fmt = { usd: (v: number, d?: number) => string; num: (v: number, d?: number) => string };

/* ------------------------------------------------------------------ */
/*  Shell                                                              */
/* ------------------------------------------------------------------ */

function Tile({
  title,
  action,
  className,
  style,
  children,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cx("relative flex min-w-0 flex-col overflow-hidden rounded-[26px] border border-border bg-card p-5 text-card-foreground", className)}
      style={style}
    >
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h3 className="text-[13px] font-medium text-muted-foreground">{title}</h3>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

function Pills<T extends string>({ value, options, onChange, label }: { value: T; options: T[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={o === value}
          onClick={() => onChange(o)}
          className={cx(
            "rounded-full px-2.5 py-1 font-mono text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            o === value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Hero: greeting, net worth, 30-day PnL strip                        */
/* ------------------------------------------------------------------ */

function HeroTile({ account, history, fmt, accent, accent2, reduced }: { account: string; history: number[]; fmt: Fmt; accent: string; accent2: string; reduced: boolean }) {
  const mounted = useMounted();
  const value = history[history.length - 1];
  const shown = useCountUp(value, !reduced);
  const month = history.slice(-31);
  const daily = month.slice(1).map((v, i) => (v / month[i] - 1) * 100);
  const maxAbs = Math.max(...daily.map(Math.abs), 0.01);
  const change = value - month[0];
  const pct = (value / month[0] - 1) * 100;
  const [hover, setHover] = React.useState<number | null>(null);
  const today = new Date();
  const dayLabel = (i: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (daily.length - 1 - i));
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <Tile className="sm:col-span-2 lg:col-span-2 lg:col-start-1 lg:row-start-1">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="text-[28px] font-semibold leading-[1.1] tracking-[-0.03em] sm:text-[34px]">
            gm, <span style={{ color: accent }}>{account}</span>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Here’s your onchain month at a glance.</p>
        </div>
        <div className="text-right">
          <p className="text-[12px] text-muted-foreground">Net worth</p>
          <p className="font-mono text-[34px] font-semibold leading-none tracking-[-0.04em] tabular-nums sm:text-[40px]">{fmt.usd(shown)}</p>
          <p className="mt-1.5 font-mono text-[12px] tabular-nums">
            <span style={{ color: change >= 0 ? accent : accent2 }}>
              {change >= 0 ? "+" : "−"}
              {fmt.usd(Math.abs(change))} ({pct.toFixed(1)}%)
            </span>
            <span className="text-muted-foreground"> · 30d</span>
          </p>
        </div>
      </div>

      {/* PnL strip */}
      <div className="mt-6 flex flex-1 flex-col">
        <div className="flex flex-1 items-end gap-[3px]" style={{ minHeight: 64 }} onPointerLeave={() => setHover(null)}>
          {daily.map((d, i) => {
            const h = 18 + (Math.abs(d) / maxAbs) * 82;
            const up = d >= 0;
            return (
              <button
                key={i}
                type="button"
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${dayLabel(i)}: ${up ? "+" : "−"}${Math.abs(d).toFixed(2)}%`}
                className="relative flex-1 rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{
                  height: mounted ? `${h}%` : "6%",
                  background: up ? accent : accent2,
                  opacity: hover === null ? 0.35 + (Math.abs(d) / maxAbs) * 0.65 : hover === i ? 1 : 0.25,
                  transition: `height 900ms ${EASE} ${i * 18}ms, opacity 200ms ease`,
                }}
              />
            );
          })}
        </div>
        <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-muted-foreground">
          <span>{dayLabel(0)}</span>
          <span className="text-foreground" aria-live="polite">
            {hover !== null ? `${dayLabel(hover)} · ${daily[hover] >= 0 ? "+" : "−"}${Math.abs(daily[hover]).toFixed(2)}%` : "Daily PnL"}
          </span>
          <span>Today</span>
        </div>
      </div>
    </Tile>
  );
}

/* ------------------------------------------------------------------ */
/*  Cards: fanned stack, click a card to bring it forward              */
/* ------------------------------------------------------------------ */

export interface Web3Card {
  id: string;
  /** Card name, shown when no logo is passed */
  label: string;
  last4: string;
  holder?: string;
  expiry?: string;
  balance?: string;
  /** Payment network logo (pass the official SVG of Visa, Mastercard, PayPal, etc.) */
  logo?: React.ReactNode;
  /** Base color of the card face */
  color: string;
  /** Second color of the gradient */
  color2: string;
  /** Text color on the card */
  ink: string;
}

function Chip() {
  return (
    <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
      <rect x="0.5" y="0.5" width="25" height="19" rx="4.5" fill="oklch(0.9 0.06 90)" stroke="oklch(0.62 0.07 80 / 0.6)" />
      <path d="M0.5 7h7.5v6H0.5M25.5 7H18v6h7.5M8 0.5v19M18 0.5v19M8 10h10" fill="none" stroke="oklch(0.6 0.07 80 / 0.55)" strokeWidth="0.9" />
    </svg>
  );
}

function CardFace({ c, glare }: { c: Web3Card; glare: number }) {
  return (
    <>
      <span
        aria-hidden
        className="absolute inset-0 overflow-hidden rounded-[12px]"
        style={{
          backgroundImage: [
            "linear-gradient(180deg, oklch(1 0 0 / 0.3) 0%, transparent 34%)",
            `radial-gradient(110% 90% at 100% 0%, ${c.color2} 0%, transparent 60%)`,
            `linear-gradient(135deg, ${c.color} 0%, ${c.color2} 100%)`,
          ].join(", "),
          boxShadow: "inset 0 1px 0 oklch(1 0 0 / 0.5), inset 0 0 0 1px oklch(1 0 0 / 0.16)",
        }}
      >
        {/* holographic film */}
        <span
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(115deg, transparent 18%, oklch(0.9 0.12 350 / 0.55) 32%, oklch(0.92 0.1 220 / 0.55) 42%, oklch(0.94 0.14 130 / 0.5) 52%, oklch(0.92 0.12 60 / 0.45) 62%, transparent 78%)",
            backgroundSize: "260% 100%",
            backgroundPosition: `${glare}% 0`,
            mixBlendMode: "soft-light",
            transition: "background-position 700ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        />
      </span>

      <span className="relative flex items-center justify-between gap-3 px-4 pt-4">
        <span className="flex min-w-0 items-center gap-2.5">
          {c.logo ?? <Chip />}
          <span className="truncate text-[13px] font-bold tracking-tight">{c.label}</span>
        </span>
        <span className="shrink-0 font-mono text-[12px] font-semibold tabular-nums">**** {c.last4}</span>
      </span>

      <span className="absolute bottom-3.5 right-4 opacity-70" aria-hidden>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M8.5 7.5a6 6 0 0 1 0 9M12 5a9.5 9.5 0 0 1 0 14M15.5 2.5a13 13 0 0 1 0 19" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      </span>
    </>
  );
}

function CardsTile({ cards, reduced }: { cards: Web3Card[]; reduced: boolean }) {
  const [order, setOrder] = React.useState(() => cards.map((c) => c.id));
  const mounted = useMounted();
  const PEEK = 46;
  const depth = order.length - 1;
  const front = cards.find((c) => c.id === order[order.length - 1])!;
  const [glare, setGlare] = React.useState(30);
  React.useEffect(() => {
    if (reduced) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      setGlare((g) => (dragGlare.current ? g : 30 + Math.sin((now - t0) / 2600) * 30));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);
  const dragGlare = React.useRef(false);

  return (
    <Tile
      title={
        <span>
          Cards <sup className="font-mono text-[10px]">{cards.length}</sup>
        </span>
      }
      className="lg:col-start-3 lg:row-start-1"
    >
      <div
        className="relative -mx-5 -mb-5 flex flex-1 flex-col justify-end overflow-hidden pt-1"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          dragGlare.current = true;
          setGlare(((e.clientX - r.left) / r.width) * 100);
        }}
        onPointerLeave={() => {
          dragGlare.current = false;
        }}
      >
        <div className="relative">
        {order.map((id, pos) => {
          const c = cards.find((x) => x.id === id)!;
          const fromFront = order.length - 1 - pos; // 0 = front
          const isFront = fromFront === 0;
          return (
            <button
              key={id}
              type="button"
              onClick={() => !isFront && setOrder((o) => [...o.filter((x) => x !== id), id])}
              aria-label={`${c.label} card ending ${c.last4}${isFront ? ", selected" : ", bring to front"}`}
              aria-pressed={isFront}
              className="group absolute left-1/2 block w-[calc(100%-32px)] max-w-[300px] rounded-[12px] p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{
                top: (depth - fromFront) * PEEK,
                zIndex: pos + 1,
                transform: `translateX(-50%) scale(${1 - fromFront * 0.055}) translateY(${mounted ? 0 : 20}px)`,
                transformOrigin: "top center",
                opacity: mounted ? 1 : 0,
                color: c.ink,
                boxShadow: "0 -10px 28px -14px oklch(0 0 0 / 0.75)",
                transition: reduced
                  ? "none"
                  : `top 650ms cubic-bezier(0.34, 1.35, 0.64, 1), transform 650ms cubic-bezier(0.34, 1.35, 0.64, 1), opacity 500ms ease ${pos * 90}ms`,
                cursor: isFront ? "default" : "pointer",
              }}
            >
              {/* fixed bank-card ratio (85.6 × 54 mm) without relying on aspect-ratio on a button */}
              <span className="relative block w-full" style={{ paddingTop: "63.08%" }}>
                <span className="absolute inset-0 block">
                  <CardFace c={c} glare={glare + fromFront * 18} />
                </span>
              </span>
            </button>
          );
        })}

        {/* Spacer: gives the stack its real height so the front card is never squeezed */}
        <div aria-hidden className="invisible mx-auto w-[calc(100%-32px)] max-w-[300px] shrink-0" style={{ marginTop: depth * PEEK }}>
          {/* only the top part of the front card shows; the rest slides under the panel */}
          <div style={{ paddingTop: "30%" }} />
        </div>
        </div>

        {/* Frosted panel the stack tucks under */}
        <div
          className="relative z-10 flex shrink-0 items-end justify-between gap-3 px-5 pb-4"
          style={{
            height: 88,
            background: "color-mix(in oklch, var(--color-card) 72%, transparent)",
            backdropFilter: "blur(18px) saturate(1.3)",
            WebkitBackdropFilter: "blur(18px) saturate(1.3)",
            borderTop: "1px solid color-mix(in oklch, var(--color-foreground) 10%, transparent)",
          }}
          aria-live="polite"
        >
          <div className="min-w-0">
            <p className="truncate font-mono text-[15px] font-semibold tabular-nums tracking-[0.08em]">•••• •••• •••• {front.last4}</p>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {front.holder ?? front.label}
              {front.expiry ? ` · ${front.expiry}` : ""}
            </p>
          </div>
          {front.balance && <p className="shrink-0 font-mono text-[15px] font-semibold tabular-nums">{front.balance}</p>}
        </div>
      </div>
    </Tile>
  );
}

/* ------------------------------------------------------------------ */
/*  Gas: semicircle gauge with live gwei                               */
/* ------------------------------------------------------------------ */

function GasTile({ accent, reduced }: { accent: string; reduced: boolean }) {
  const [gwei, setGwei] = React.useState(14.2);
  const [tier, setTier] = React.useState<"Slow" | "Normal" | "Fast">("Normal");
  React.useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setGwei((g) => Math.max(4, Math.min(60, g + (Math.random() - 0.5) * 3.2))), 2200);
    return () => window.clearInterval(id);
  }, [reduced]);

  const mult = { Slow: 0.85, Normal: 1, Fast: 1.35 }[tier];
  const value = gwei * mult;
  const t = Math.min(1, value / 60);
  const R = 62;
  const len = Math.PI * R;
  const angle = -90 + t * 180;
  const cost = (value * 21000 * 1e-9 * 3368).toFixed(2);

  return (
    <Tile title="Gas" className="lg:col-start-4 lg:row-start-1" action={<span className="font-mono text-[11px] text-muted-foreground">live</span>}>
      <div className="flex flex-1 flex-col items-center justify-center">
        <div className="relative" style={{ width: 150, height: 86 }}>
          <svg width="150" height="86" viewBox="0 0 150 86" aria-hidden>
            <path d="M 13 78 A 62 62 0 0 1 137 78" fill="none" strokeWidth="10" strokeLinecap="round" style={{ stroke: "var(--color-muted)" }} />
            <path
              d="M 13 78 A 62 62 0 0 1 137 78"
              fill="none"
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={len}
              style={{ stroke: accent, strokeDashoffset: len * (1 - t), transition: `stroke-dashoffset 900ms ${EASE}` }}
            />
            <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: "75px 78px", transition: `transform 900ms ${EASE}` }}>
              <line x1="75" y1="78" x2="75" y2="30" strokeWidth="2.5" strokeLinecap="round" style={{ stroke: "var(--color-foreground)" }} />
            </g>
            <circle cx="75" cy="78" r="5" style={{ fill: "var(--color-foreground)" }} />
          </svg>
        </div>
        <p className="mt-2 font-mono text-[26px] font-semibold leading-none tabular-nums">
          {value.toFixed(1)} <span className="text-sm text-muted-foreground">gwei</span>
        </p>
        <p className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">≈ ${cost} per transfer</p>
      </div>
      <div className="mt-4 flex justify-center">
        <Pills label="Speed" value={tier} options={["Slow", "Normal", "Fast"]} onChange={setTier} />
      </div>
    </Tile>
  );
}

/* ------------------------------------------------------------------ */
/*  Portfolio chart vs benchmark                                       */
/* ------------------------------------------------------------------ */

type Range = "1W" | "1M" | "1Y";

function ChartTile({ history, benchmark, fmt, accent, reduced }: { history: number[]; benchmark: number[]; fmt: Fmt; accent: string; reduced: boolean }) {
  const uid = React.useId().replace(/:/g, "");
  const [range, setRange] = React.useState<Range>("1Y");
  const [hover, setHover] = React.useState<number | null>(null);
  const mounted = useMounted();
  const take = { "1W": 8, "1M": 31, "1Y": history.length }[range];
  const step = range === "1Y" ? 7 : 1;
  const pick = (a: number[]) => a.slice(-take).filter((_, i, arr) => i % step === 0 || i === arr.length - 1);
  const a = pick(history);
  const b = pick(benchmark);
  const W = 640;
  const H = 220;
  const lo = Math.min(...a, ...b);
  const hi = Math.max(...a, ...b);
  const y = (v: number) => H - 16 - ((v - lo) / (hi - lo || 1)) * (H - 40);
  const pa = a.map((v, i) => [(i / (a.length - 1)) * W, y(v)] as const);
  const pb = b.map((v, i) => [(i / (b.length - 1)) * W, y(v)] as const);
  const la = smooth(pa);
  const lb = smooth(pb);
  const idx = hover ?? a.length - 1;
  const lead = ((a[a.length - 1] / a[0] - 1) - (b[b.length - 1] / b[0] - 1)) * 100;

  const labels =
    range === "1Y"
      ? ["Nov", "Jan", "Mar", "May", "Jul", "Sep", "Now"]
      : range === "1M"
        ? ["4w", "3w", "2w", "1w", "Now"]
        : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Now"];

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(a.length - 1, Math.round(((e.clientX - r.left) / r.width) * (a.length - 1)))));
  };

  const left = `${(pa[idx][0] / W) * 100}%`;

  return (
    <Tile
      title="Portfolio vs ETH"
      className="sm:col-span-2 lg:col-span-2 lg:col-start-1 lg:row-span-2 lg:row-start-2"
      action={<Pills label="Chart range" value={range} options={["1W", "1M", "1Y"]} onChange={setRange} />}
    >
      <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
        <div>
          <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className="h-[3px] w-4 rounded-full" style={{ background: accent }} aria-hidden />
            Portfolio
          </p>
          <p className="mt-1 font-mono text-[22px] font-semibold tabular-nums">{fmt.usd(a[idx])}</p>
        </div>
        <div>
          <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className="h-0 w-4 border-t-2 border-dashed border-muted-foreground" aria-hidden />
            Holding ETH only
          </p>
          <p className="mt-1 font-mono text-[22px] font-semibold tabular-nums text-muted-foreground">{fmt.usd(b[idx])}</p>
        </div>
        <span className="ml-auto rounded-full px-2.5 py-1 font-mono text-[11px] font-semibold tabular-nums" style={{ background: `color-mix(in oklch, ${accent} 18%, transparent)`, color: accent }}>
          {lead >= 0 ? "+" : "−"}
          {Math.abs(lead).toFixed(1)}% vs ETH
        </span>
      </div>

      <div
        className="relative mt-4 flex-1 touch-pan-y"
        style={{ minHeight: 220 }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`Portfolio ${fmt.usd(a[a.length - 1])} versus ETH-only ${fmt.usd(b[b.length - 1])} over ${range}`}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <linearGradient id={`${uid}-f`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" style={{ stopColor: accent, stopOpacity: 0.28 }} />
              <stop offset="1" style={{ stopColor: accent, stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} vectorEffect="non-scaling-stroke" strokeDasharray="1 5" style={{ stroke: "var(--color-border)" }} />
          ))}
          <path d={`${la} L ${W} ${H} L 0 ${H} Z`} fill={`url(#${uid}-f)`} style={{ opacity: mounted ? 1 : 0, transition: "opacity 900ms ease 400ms" }} />
          <path d={lb} fill="none" strokeWidth={1.5} strokeDasharray="4 5" vectorEffect="non-scaling-stroke" style={{ stroke: "var(--color-muted-foreground)" }} />
          <path
            key={range}
            d={la}
            fill="none"
            strokeWidth={2.5}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            pathLength={1}
            style={{ stroke: accent, strokeDasharray: 1, strokeDashoffset: mounted || reduced ? 0 : 1, transition: reduced ? "none" : `stroke-dashoffset 1300ms ${EASE}` }}
          />
        </svg>
        <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-border" style={{ left, opacity: hover !== null ? 1 : 0 }} />
        <span
          aria-hidden
          className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-card"
          style={{ left, top: `${(pa[idx][1] / H) * 100}%`, background: accent }}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-muted-foreground"
          style={{ left, top: `${(pb[idx][1] / H) * 100}%`, opacity: hover !== null ? 1 : 0 }}
        />
      </div>
      <div className="mt-3 flex justify-between font-mono text-[11px] text-muted-foreground" aria-hidden>
        {labels.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
    </Tile>
  );
}

/* ------------------------------------------------------------------ */
/*  Allocation: segmented bar                                          */
/* ------------------------------------------------------------------ */

function AllocationTile({ allocation, fmt, accent, accent2 }: { allocation: Web3Allocation[]; fmt: Fmt; accent: string; accent2: string }) {
  const mounted = useMounted();
  const total = allocation.reduce((s, a) => s + a.value, 0);
  const colors = [accent, accent2, "oklch(0.78 0.04 280)", "oklch(0.6 0.03 280)", "oklch(0.42 0.02 280)"];
  const [hover, setHover] = React.useState<number | null>(null);

  return (
    <Tile title="Allocation" className="lg:col-start-3 lg:row-start-2">
      <p className="font-mono text-[22px] font-semibold tabular-nums">{fmt.usd(total)}</p>
      <div className="mt-4 flex h-9 gap-1" onPointerLeave={() => setHover(null)}>
        {allocation.map((a, i) => (
          <span
            key={a.symbol}
            onPointerEnter={() => setHover(i)}
            className="rounded-[8px]"
            style={{
              flexBasis: mounted ? `${(a.value / total) * 100}%` : `${100 / allocation.length}%`,
              background: colors[i % colors.length],
              opacity: hover === null || hover === i ? 1 : 0.3,
              transition: `flex-basis 1000ms ${EASE} ${200 + i * 60}ms, opacity 200ms ease`,
            }}
            aria-hidden
          />
        ))}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
        {allocation.map((a, i) => (
          <li
            key={a.symbol}
            className="flex items-center justify-between gap-2 text-[12px]"
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
          >
            <span className="flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ background: colors[i % colors.length] }} aria-hidden />
              {a.symbol}
            </span>
            <span className="font-mono tabular-nums text-muted-foreground">{((a.value / total) * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

/* ------------------------------------------------------------------ */
/*  Staking: solid accent tile with live-accruing rewards              */
/* ------------------------------------------------------------------ */

function StakingTile({ staking, fmt, accent, reduced }: { staking: NonNullable<Web3BentoProps["staking"]>; fmt: Fmt; accent: string; reduced: boolean }) {
  const [rewards, setRewards] = React.useState(staking.rewards);
  const perSecond = (staking.staked * staking.apy) / 100 / (365 * 24 * 3600);
  React.useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setRewards((r) => r + perSecond * 0.1), 100);
    return () => window.clearInterval(id);
  }, [reduced, perSecond]);
  const [claimed, setClaimed] = React.useState(false);
  const EPOCH = 6.4 * 60;
  const [elapsed, setElapsed] = React.useState(211);
  React.useEffect(() => {
    const id = window.setInterval(() => setElapsed((e) => (e + 1) % EPOCH), 1000);
    return () => window.clearInterval(id);
  }, [EPOCH]);
  const left = EPOCH - elapsed;
  const payoutLeft = `${Math.floor(left / 60)}m ${String(Math.floor(left % 60)).padStart(2, "0")}s`;
  const payoutPct = (elapsed / EPOCH) * 100;
  const epochs = [0.62, 0.7, 0.58, 0.81, 0.74, 0.9, 0.86, 0.95, 0.88, 1];
  const ink = "oklch(0.24 0.06 135)";

  return (
    <section
      className="relative flex min-w-0 flex-col overflow-hidden rounded-[26px] p-5 lg:col-start-4 lg:row-span-2 lg:row-start-2"
      style={{ background: accent, color: ink }}
    >
      <header className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold opacity-75">Staking</h3>
        <span className="flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold" style={{ background: "oklch(0.24 0.06 135 / 0.12)" }}>
          <span className="size-1.5 rounded-full" style={{ background: ink }} aria-hidden />
          Earning
        </span>
      </header>

      <p className="mt-5 font-mono text-[52px] font-semibold leading-none tracking-[-0.05em] tabular-nums">
        {staking.apy.toFixed(2)}
        <span className="text-[22px]">%</span>
      </p>
      <p className="mt-1 text-[12px] font-medium opacity-70">APY on {staking.staked} {staking.asset}</p>

      {/* Next payout */}
      <div className="mt-5 rounded-2xl p-3" style={{ background: "oklch(0.24 0.06 135 / 0.1)" }}>
        <div className="flex items-baseline justify-between text-[12px] font-semibold">
          <span className="opacity-70">Next payout</span>
          <span className="font-mono tabular-nums">{payoutLeft}</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: "oklch(0.24 0.06 135 / 0.14)" }}>
          <div className="h-full rounded-full" style={{ width: `${payoutPct}%`, background: ink, transition: "width 1s linear" }} />
        </div>
      </div>
      <dl className="mt-3 space-y-1.5 text-[12px]">
        {[
          ["Validator", "#1,204,381"],
          ["Effectiveness", "99.4%"],
          ["Provider", "Lido"],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between">
            <dt className="opacity-70">{k}</dt>
            <dd className="font-mono font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-auto pt-6">
        <p className="text-[12px] font-semibold opacity-70">Rewards so far</p>
        <p className="mt-1 font-mono text-[20px] font-semibold tabular-nums" aria-live="off">
          {rewards.toFixed(8)} <span className="text-[13px]">{staking.asset}</span>
        </p>
        <p className="font-mono text-[12px] tabular-nums opacity-70">≈ {fmt.usd(rewards * staking.usdPrice)}</p>

        <div className="mt-5 flex h-12 items-end gap-1" aria-hidden>
          {epochs.map((e, i) => (
            <span key={i} className="flex-1 rounded-[4px]" style={{ height: `${e * 100}%`, background: ink, opacity: 0.12 + (i / epochs.length) * 0.5 }} />
          ))}
        </div>
        <p className="mt-1.5 font-mono text-[10px] opacity-60">Last 10 epochs</p>

        <button
          type="button"
          onClick={() => setClaimed(true)}
          disabled={claimed}
          className="mt-4 w-full rounded-2xl py-3 text-sm font-semibold transition-transform active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{ background: ink, color: accent, opacity: claimed ? 0.6 : 1 }}
        >
          {claimed ? "Claim submitted" : "Claim rewards"}
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Liquidity range                                                    */
/* ------------------------------------------------------------------ */

function LiquidityTile({ lp, fmt, accent, accent2, reduced }: { lp: NonNullable<Web3BentoProps["liquidity"]>; fmt: Fmt; accent: string; accent2: string; reduced: boolean }) {
  const [price, setPrice] = React.useState(lp.price);
  React.useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setPrice((p) => p * (1 + (Math.random() - 0.5) * 0.006)), 1800);
    return () => window.clearInterval(id);
  }, [reduced]);
  const lo = lp.min - (lp.max - lp.min) * 0.45;
  const hi = lp.max + (lp.max - lp.min) * 0.45;
  const pos = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const inRange = price >= lp.min && price <= lp.max;

  return (
    <Tile
      title={`${lp.pair} · ${lp.fee}`}
      className="lg:col-start-3 lg:row-start-3"
      action={
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold"
          style={{ background: `color-mix(in oklch, ${inRange ? accent : accent2} 18%, transparent)`, color: inRange ? accent : accent2 }}
        >
          {inRange ? "In range" : "Out of range"}
        </span>
      }
    >
      <p className="font-mono text-[22px] font-semibold tabular-nums">{fmt.usd(price, 2)}</p>
      <p className="font-mono text-[11px] text-muted-foreground">current price</p>

      <div className="relative mt-6 h-10" role="img" aria-label={`Range ${fmt.usd(lp.min)} to ${fmt.usd(lp.max)}, price ${fmt.usd(price, 2)}`}>
        <div className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-muted" />
        <div
          className="absolute top-1/2 h-10 -translate-y-1/2 rounded-[10px]"
          style={{
            left: `${pos(lp.min)}%`,
            width: `${pos(lp.max) - pos(lp.min)}%`,
            background: `repeating-linear-gradient(135deg, color-mix(in oklch, ${accent} 26%, transparent) 0 6px, color-mix(in oklch, ${accent} 12%, transparent) 6px 12px)`,
            boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${accent} 55%, transparent)`,
          }}
        />
        <div
          className="absolute top-1/2 h-14 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
          style={{ left: `${Math.max(2, Math.min(98, pos(price)))}%`, transition: `left 900ms ${EASE}` }}
        />
      </div>
      <div className="mt-2 flex justify-between font-mono text-[11px] tabular-nums text-muted-foreground">
        <span style={{ marginLeft: `${pos(lp.min) - 6}%` }}>{fmt.num(lp.min)}</span>
        <span style={{ marginRight: `${100 - pos(lp.max) - 6}%` }}>{fmt.num(lp.max)}</span>
      </div>
      <p className="mt-auto pt-4 text-[12px] text-muted-foreground">
        Fees earned <span className="font-mono font-semibold tabular-nums text-foreground">{fmt.usd(lp.fees, 2)}</span>
      </p>
    </Tile>
  );
}

/* ------------------------------------------------------------------ */
/*  Block stream                                                       */
/* ------------------------------------------------------------------ */

function BlocksTile({ accent, reduced }: { accent: string; reduced: boolean }) {
  const seed = React.useMemo(() => Array.from({ length: 42 }, (_, i) => 0.35 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.65), []);
  const [blocks, setBlocks] = React.useState(() => seed.map((f, i) => ({ n: 21094290 + i, fill: f, txs: Math.round(80 + f * 180) })));
  const [ago, setAgo] = React.useState(0);
  React.useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => {
      setBlocks((b) => {
        const f = 0.3 + Math.random() * 0.7;
        return [...b.slice(1), { n: b[b.length - 1].n + 1, fill: f, txs: Math.round(80 + f * 180) }];
      });
      setAgo(0);
    }, 3000);
    const t = window.setInterval(() => setAgo((a) => a + 1), 1000);
    return () => {
      window.clearInterval(id);
      window.clearInterval(t);
    };
  }, [reduced]);
  const last = blocks[blocks.length - 1];

  return (
    <Tile title="Block stream" className="sm:col-span-2 lg:col-span-2 lg:col-start-1 lg:row-start-4" action={<span className="font-mono text-[11px] text-muted-foreground">{ago}s ago</span>}>
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[22px] font-semibold tabular-nums">#{last.n.toLocaleString("en-US")}</p>
          <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {last.txs} txs · {(last.fill * 100).toFixed(0)}% full
          </p>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">12s target</p>
      </div>
      <div className="mt-4 flex flex-1 items-end gap-[3px]" style={{ minHeight: 64 }} aria-hidden>
        {blocks.map((b, i) => {
          const isLast = i === blocks.length - 1;
          return (
            <span
              key={b.n}
              className="flex-1 rounded-[3px]"
              style={{
                height: `${b.fill * 100}%`,
                background: isLast ? accent : "var(--color-muted-foreground)",
                opacity: isLast ? 1 : 0.15 + (i / blocks.length) * 0.45,
                animation: isLast && !reduced ? "orbit-pop 500ms cubic-bezier(.3,1.5,.6,1)" : undefined,
                transformOrigin: "bottom",
              }}
            />
          );
        })}
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-3">
        {[
          ["Avg block", "12.1s"],
          ["Gas used", `${Math.round((blocks.reduce((t, b) => t + b.fill, 0) / blocks.length) * 100)}%`],
          ["Throughput", `${(blocks.slice(-10).reduce((t, b) => t + b.txs, 0) / 120).toFixed(1)} tx/s`],
        ].map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">{k}</dt>
            <dd className="mt-0.5 font-mono text-[13px] font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Tile>
  );
}

/* ------------------------------------------------------------------ */
/*  Activity                                                           */
/* ------------------------------------------------------------------ */

function KindIcon({ kind }: { kind: Web3Activity["kind"] }) {
  const p = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (kind === "swap") return <svg {...p}><path d="M7 7h12l-3-3M17 17H5l3 3" /></svg>;
  if (kind === "bridge") return <svg {...p}><path d="M3 17c3-6 15-6 18 0M7 13v4M17 13v4M12 11.5V17" /></svg>;
  if (kind === "stake") return <svg {...p}><path d="M12 3 4 7l8 4 8-4-8-4ZM4 12l8 4 8-4M4 17l8 4 8-4" /></svg>;
  if (kind === "mint") return <svg {...p}><path d="M12 3v18M3 12h18M6 6l12 12M18 6 6 18" /></svg>;
  return <svg {...p}><path d="M12 5v14m0 0-6-6m6 6 6-6" /></svg>;
}

function ActivityTile({ activity, accent, accent2 }: { activity: Web3Activity[]; accent: string; accent2: string }) {
  const mounted = useMounted();
  return (
    <Tile title="Onchain activity" className="sm:col-span-2 lg:col-span-2 lg:col-start-3 lg:row-start-4">
      <ul className="-mx-2 -my-1">
        {activity.slice(0, 4).map((a, i) => (
          <li
            key={a.id}
            className="flex items-center gap-3 rounded-2xl px-2 py-2 transition-colors hover:bg-muted/50"
            style={{ opacity: mounted ? 1 : 0, transform: mounted ? "none" : "translateY(6px)", transition: `opacity 500ms ease ${300 + i * 70}ms, transform 500ms ${EASE} ${300 + i * 70}ms` }}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-foreground">
              <KindIcon kind={a.kind} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{a.title}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {a.detail} · {a.time}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-[13px] font-medium tabular-nums">{a.amount}</p>
              <p className="mt-0.5 flex items-center justify-end gap-1 font-mono text-[10px] font-semibold" style={{ color: a.status === "pending" ? accent : a.status === "failed" ? accent2 : "var(--color-muted-foreground)" }}>
                {a.status === "pending" && (
                  <svg width="10" height="10" viewBox="0 0 24 24" className="animate-spin motion-reduce:animate-none" aria-hidden>
                    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
                    <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                )}
                {a.status}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

/* ------------------------------------------------------------------ */
/*  Dashboard                                                          */
/* ------------------------------------------------------------------ */

export function Web3Bento({
  account = DEMO.account,
  network = DEMO.network,
  history = DEMO.history,
  benchmark = DEMO.benchmark,
  allocation = DEMO.allocation,
  staking = DEMO.staking,
  liquidity = DEMO.liquidity,
  activity = DEMO.activity,
  cards,
  accent = "oklch(0.89 0.2 128)",
  accent2 = "oklch(0.74 0.12 300)",
  locale = "en-US",
  className,
}: Web3BentoProps) {
  const reduced = useReducedMotion();
  const fmt = React.useMemo<Fmt>(() => {
    const cache: Record<string, Intl.NumberFormat> = {};
    const get = (k: string, o: Intl.NumberFormatOptions) => (cache[k] ??= new Intl.NumberFormat(locale, o));
    return {
      usd: (v, d = 0) => get(`u${d}`, { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d }).format(v),
      num: (v, d = 0) => get(`n${d}`, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v),
    };
  }, [locale]);

  return (
    <div className={cx("w-full max-w-[1120px]", className)}>
      <style>{`
        @keyframes orbit-pop { 0% { transform: scaleY(0) } 100% { transform: scaleY(1) } }
      `}</style>

      {/* Top bar */}
      <nav className="mb-3 flex flex-wrap items-center justify-end gap-3 px-1" aria-label="Dashboard">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-[12px] font-medium">
            <span className="size-2 rounded-full" style={{ background: accent }} aria-hidden />
            {network}
          </span>
          <span className="rounded-full bg-foreground px-3 py-1.5 font-mono text-[12px] font-semibold text-background">{account}</span>
        </div>
      </nav>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HeroTile account={account} history={history} fmt={fmt} accent={accent} accent2={accent2} reduced={reduced} />
        <CardsTile
          reduced={reduced}
          cards={
            cards ?? [
              { id: "k3", label: "Savings", last4: "3368", holder: "Roman Vasnev", expiry: "09/29", balance: "$12,480", color: "oklch(0.82 0.11 55)", color2: "oklch(0.7 0.15 30)", ink: "oklch(0.25 0.05 40)" },
              { id: "k2", label: "Virtual", last4: "4352", holder: "Roman Vasnev", expiry: "03/28", balance: "$2,910", color: "oklch(0.8 0.1 300)", color2: "oklch(0.64 0.15 285)", ink: "oklch(0.2 0.06 290)" },
              { id: "k1", label: "Main", last4: "6902", holder: "Roman Vasnev", expiry: "07/27", balance: "$84,316", color: accent, color2: "oklch(0.74 0.17 165)", ink: "oklch(0.22 0.06 140)" },
            ]
          }
        />
        <GasTile accent={accent} reduced={reduced} />
        <ChartTile history={history} benchmark={benchmark} fmt={fmt} accent={accent} reduced={reduced} />
        <AllocationTile allocation={allocation} fmt={fmt} accent={accent} accent2={accent2} />
        <StakingTile staking={staking} fmt={fmt} accent={accent} reduced={reduced} />
        <LiquidityTile lp={liquidity} fmt={fmt} accent={accent} accent2={accent2} reduced={reduced} />
        <BlocksTile accent={accent} reduced={reduced} />
        <ActivityTile activity={activity} accent={accent} accent2={accent2} />
      </div>
    </div>
  );
}

export default Web3Bento;
