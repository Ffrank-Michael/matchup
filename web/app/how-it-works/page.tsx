import { END_RULE, START_RULE, TOO_FEW_RULE } from "@/lib/price-rule";
import type { Metadata } from "next";
import Link from "next/link";
import type * as React from "react";

import { ContractNote } from "@/components/kairo/contract-note";
import { AGENTS } from "@/lib/agents";
import { LIVE_MATCHUPS } from "@/lib/markets";

export const metadata: Metadata = {
  title: "How it works | Matchup",
  description:
    "Pick a market, call the next round UP or DOWN, and claim your USDC if you are right.",
};

// The six steps are the owner's text. Changes made for accuracy: rounds are 5 or 10 minutes (not 15), the call is on the
// NEXT round, the start price is the first live trade after calling closes, and the contract (not Matchup) holds the pot.
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
            <li>{START_RULE}</li>
            <li>{END_RULE}</li>
            <li>
              End higher than start: UP wins. Lower: DOWN wins. Same price:
              everyone gets their money back.
            </li>
            <li>{TOO_FEW_RULE}</li>
          </ul>
        </div>
        <div className="mt-2">
          The price when you tapped your call doesn&apos;t count. Only start and
          end.
        </div>
        <div className="mt-2">
          <span className="font-semibold text-foreground">Example:</span>{" "}
          Calling closes at 12:00. Bitcoin&apos;s trades from 12:00:02 to 12:01:02 have a
          middle price of $80,000: the start price. The round ends at 12:05; the trades from
          12:03:00 to 12:04:00 have a middle price of $80,100: the end price. It went up, so UP
          wins, whatever happens in the last minute.
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
    body: "Press Claim and your USDC goes straight to your wallet: winnings, refunds, and the part of a call that was not matched, even if the call lost. Claim all covers them together. The money sits in the contract, not with Matchup: Matchup can only take its 2% fee.",
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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/matchup-logo.svg" alt="Matchup" width={154} height={40} className="h-10 w-auto sm:h-12" />
        </Link>
        <Link
          href="/"
          className="shrink-0 whitespace-nowrap rounded-full border border-border px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Back to markets
        </Link>
      </header>

      <h1 className="text-[32px] font-bold leading-tight tracking-[-0.03em]">
        How Matchup works
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

      {LIVE_MATCHUPS.length ? (
        <>
          <h2 id="coin-vs-coin" className="mt-10 scroll-mt-4 text-[22px] font-bold tracking-[-0.02em]">
            Coin vs coin
          </h2>
          <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
            {LIVE_MATCHUPS.map((p) => `${p.a} vs ${p.b}`).join(" and ")}: which coin does better over the hour? Rounds last 1
            hour. You call <span className="font-semibold text-foreground">{LIVE_MATCHUPS[0].a} wins</span> or{" "}
            <span className="font-semibold text-foreground">{LIVE_MATCHUPS[0].b} wins</span>. Only the % move counts: if both coins
            go up, the one that went up more wins; if both go down, the one that fell less wins.
          </p>
          <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-[15px] leading-relaxed text-muted-foreground">
            <li>
              The price of a round is the ratio of the two coins: {LIVE_MATCHUPS[0].a}&apos;s dollar price divided by{" "}
              {LIVE_MATCHUPS[0].b}&apos;s (how many {LIVE_MATCHUPS[0].b} one {LIVE_MATCHUPS[0].a} is worth). The start ratio uses
              each coin&apos;s own start price and the end ratio each coin&apos;s own end price, as above: the middle price of a
              short window of trades for BTC and ETH, a single trade for SOL. The last minute does not count, and too few
              trades means no price and money back.
            </li>
            <li>
              Ratio up at the end: {LIVE_MATCHUPS[0].a} wins. Ratio down: {LIVE_MATCHUPS[0].b} wins. Exactly the same ratio
              (both coins moved by the same %): everyone gets their money back.
            </li>
            <li>
              <span className="font-semibold text-foreground">Example:</span> at the start ETH is $3,000 and BTC $100,000, a
              ratio of 0.03. At the end ETH is $3,060 (+2%) and BTC $101,000 (+1%), a ratio of about 0.0303. The ratio went up, so
              ETH wins, even though both coins rose.
            </li>
          </ul>
          <div role="note" className="mt-3 rounded-2xl border border-border bg-card px-4 py-3 text-[15px] leading-relaxed text-muted-foreground">
            <span className="font-semibold text-foreground">The prices are relayed.</span> Our runner reads the two coins on
            Bitfinex, divides them and pushes the ratio to the contract. The contract only accepts a ratio within 2.5% of the
            ratio of Chainlink&apos;s own prices, and a typical hour moves much less than that (about 0.2%). So the check stops a
            broken or far-off price, but it does not stop our runner from choosing the result: you are trusting it to push the
            real ratio. Each pushed ratio is public on the chain, but the two Bitfinex trades it was worked out from are kept only
            in the runner&apos;s own log, so for now you cannot check a ratio against Bitfinex yourself.
          </div>
        </>
      ) : null}

      <h2 className="mt-10 text-[22px] font-bold tracking-[-0.02em]">
        Our four agents
      </h2>
      <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
        They make their calls in public, so you can see how each one does. Their
        calls are guide calls: they show what each agent thinks, and no money
        moves. Back one and your call copies its call.
      </p>
      <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
        Three of them are AI agents. Each one asks an AI model (Gemini) once
        every 10 minutes. The model looks at the latest one-minute candles and
        gives that agent an UP or DOWN call, with one sentence, for every round
        that is open, so every 5-minute round gets a call too. That sentence is
        the model&apos;s own words. It is not checked and it is not advice. If
        the AI does not answer in time, the agent skips those rounds and the
        site says &ldquo;Couldn&apos;t decide this round&rdquo;. Coin Flipper
        picks at random, so you can see whether AI beats a coin flip.
      </p>
      <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
        Agent notes are written by AI models. Nothing here is financial advice.
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
          the first time you call, your wallet asks you to let Matchup take your
          call amount. It is a one-time permission (50 USDC unless you change
          it), so your later calls need only one confirmation. You can remove it
          any time.
        </li>
        <li>
          <span className="font-semibold text-foreground">
            Network fee:
          </span>{" "}
          Arc fees are paid in USDC and are tiny, about $0.004 for the
          permission and a call together. Matchup asks you to keep $0.01 in your
          wallet on top of your call for them.
        </li>
        <li>
          <span className="font-semibold text-foreground">
            One side per round:
          </span>{" "}
          in a round you can call UP or DOWN, not both.
        </li>
      </ul>
      <ContractNote className="mt-3 text-[15px] leading-relaxed text-muted-foreground" />

      <p className="mt-6 text-[13px] text-muted-foreground">
        Prices are the last live trade on Bitfinex. Charts by <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">TradingView Lightweight Charts™</a>. Matchup is in beta: each
        wallet can have at most 10 USDC on a round.
      </p>
      <p className="mt-2 text-[13px] text-muted-foreground">
        Beta experiment with small limits. Check your local rules. Not for use where prohibited.
      </p>
    </main>
  );
}
