import type { Metadata } from "next";
import Link from "next/link";
import type * as React from "react";

import { AGENTS } from "@/lib/agents";

export const metadata: Metadata = {
  title: "How it works · Kairo Markets",
  description:
    "Pick a market, call the next round UP or DOWN, and claim your USDC if you are right.",
};

// The six steps are the owner's text. Changes made for accuracy: rounds are 5 or 10 minutes (not 15), the call is on the
// NEXT round, the start price is the first live trade after calling closes, and the contract (not Kairo) holds the pot.
const STEPS: ReadonlyArray<{ title: string; body: React.ReactNode }> = [
  {
    title: "Pick a market.",
    body: "BTC, ETH or SOL. Each round lasts 5 minutes, 10 minutes, 30 minutes or 1 hour.",
  },
  {
    title: "Make a call.",
    body: "You call the next round: will the price be higher or lower at its end than at its start? Call UP or DOWN, or back one of our AI agents and copy its call.",
  },
  {
    title: "The round starts when calling closes.",
    body: (
      <>
        <div className="mt-2">
          <ul className="list-disc space-y-1 pl-5">
            <li>The first price after calling closes is the start price.</li>
            <li>
              When the round ends, the price at that moment is the end price.
            </li>
            <li>
              End higher than start: UP wins. Lower: DOWN wins. Same price:
              everyone gets their money back.
            </li>
          </ul>
        </div>
        <div className="mt-2">
          The price when you tapped your call doesn&apos;t count. Only start and
          end.
        </div>
        <div className="mt-2">
          <span className="font-semibold text-foreground">Example:</span>{" "}
          Calling closes at 12:00. Bitcoin&apos;s first price after that is
          $80,000, the start price. At 12:05 it&apos;s $80,100, the end price.
          It went up, so UP wins.
        </div>
      </>
    ),
  },
  {
    title: "Only matched money plays.",
    body: "Your money plays against the other side. If one side has more, the extra comes back. Winners double the money that played, minus 2%.",
  },
  {
    title: "Claim.",
    body: "Press Claim and your USDC goes straight to your wallet: winnings, refunds, and the part of a call that was not matched, even if the call lost. Claim all covers them together. The money sits in the contract, not with Kairo: Kairo can only take its 2% fee.",
  },
];

export default function HowItWorks() {
  return (
    <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col px-4 py-6 sm:px-8 sm:py-10">
      <header className="mb-6 flex items-center justify-between gap-3">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* Two-line logo on phones (under 768 px), one-line logo from 768 px up. */}
          <picture>
            <source media="(min-width: 768px)" srcSet="/kairo-logo-bar.svg" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/kairo-logo-bar-2line.svg" alt="Kairo Markets" width={116} height={36} className="h-9 w-auto md:h-10" />
          </picture>
        </Link>
        <Link
          href="/"
          className="shrink-0 whitespace-nowrap rounded-full border border-border px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Back to markets
        </Link>
      </header>

      <h1 className="text-[32px] font-bold leading-tight tracking-[-0.03em]">
        How Kairo works
      </h1>

      <ol className="mt-6 flex flex-col gap-3">
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            className="flex gap-4 rounded-[26px] border border-border bg-card p-5"
          >
            <span
              className="grid size-9 shrink-0 place-items-center rounded-full bg-up font-mono text-[15px] font-bold"
              style={{ color: "oklch(0.24 0.06 135)" }}
              aria-hidden
            >
              {i + 1}
            </span>
            <div className="min-w-0 text-[15px] leading-relaxed text-muted-foreground">
              <span className="font-semibold text-foreground">
                {step.title}
              </span>{" "}
              {step.body}
            </div>
          </li>
        ))}
      </ol>

      <h2 className="mt-10 text-[22px] font-bold tracking-[-0.02em]">
        Our four agents
      </h2>
      <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
        They call with their own money, in public, so you can see how each one
        does. Back one and your call copies its call.
      </p>
      <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
        Three of them are AI agents: every 5 minutes a small AI model (Gemini)
        looks at the latest one-minute candles of each coin and gives each of
        them, for every time frame that is opening, an UP or DOWN call with one
        sentence. That sentence is the
        model&apos;s own words. It is not checked and it is not advice. If the
        AI does not answer in time, the agent skips the round and the site says
        &ldquo;Couldn&apos;t decide this round&rdquo;. Coin Flipper picks at
        random, so you can see whether AI beats a coin flip.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {AGENTS.map((a) => (
          <li
            key={a.key}
            className="rounded-2xl border border-border bg-card px-4 py-3 text-[15px] leading-relaxed text-muted-foreground"
          >
            <span className="font-semibold" style={{ color: a.colour }}>
              {a.name}
            </span>{" "}
            · {a.tagline}. {a.rule ?? a.how}
          </li>
        ))}
      </ul>

      <h2 id="fees" className="mt-10 scroll-mt-4 text-[22px] font-bold tracking-[-0.02em]">
        Fees, refunds and permission
      </h2>
      <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-[15px] leading-relaxed text-muted-foreground">
        <li>
          <span className="font-semibold text-foreground">Fee:</span> 2% of
          the matched money, paid out of winnings only. If you lose or get
          refunded, you pay no fee.
        </li>
        <li>
          <span className="font-semibold text-foreground">
            You get your money back, with no fee,
          </span>{" "}
          when nobody is on the other side, when the start and end price are the
          same, or when a price could not be recorded.
        </li>
        <li>
          <span className="font-semibold text-foreground">
            A round nobody settles
          </span>{" "}
          is refunded in full once an hour has passed after it ended. Your calls
          list shows when.
        </li>
        <li>
          <span className="font-semibold text-foreground">
            Winnings never expire:
          </span>{" "}
          you can claim them any time, today or next year. The only deadline is
          on the round itself: it must be settled within an hour of ending, and
          if nobody does, you get your money back.
        </li>
        <li>
          <span className="font-semibold text-foreground">
            One-time permission:
          </span>{" "}
          the first time you call, your wallet asks you to let Kairo take your
          call amount. It is a one-time permission (100 USDC unless you change
          it), so your later calls need only one confirmation. You can remove it
          any time.
        </li>
        <li>
          <span className="font-semibold text-foreground">
            One side per round:
          </span>{" "}
          in a round you can call UP or DOWN, not both.
        </li>
      </ul>

      <p className="mt-6 text-[13px] text-muted-foreground">
        Prices are the last live trade on Bitfinex. Charts by <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">TradingView Lightweight Charts™</a>. Kairo is in beta: each
        wallet can have at most 10 USDC on a round.
      </p>
    </main>
  );
}
