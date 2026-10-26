import type { Metadata } from "next";
import Link from "next/link";
import type * as React from "react";

export const metadata: Metadata = {
  title: "How it works · Kairo Markets",
  description: "Pick a market, call the next round UP or DOWN, and claim your USDC if you are right.",
};

// The six steps are the owner's text. Changes made for accuracy: rounds are 5 or 10 minutes (not 15), the call is on the
// NEXT round, the start price is the first live trade after calling closes, and the contract (not Kairo) holds the pot.
const STEPS: ReadonlyArray<{ title: string; body: React.ReactNode }> = [
  {
    title: "Pick a market.",
    body: "BTC, ETH or SOL. Each round lasts 5 or 10 minutes.",
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
            <li>When the round ends, the price at that moment is the end price.</li>
            <li>End higher than start: UP wins. Lower: DOWN wins. Same price: everyone gets their money back.</li>
          </ul>
        </div>
        <div className="mt-2">The price when you tapped your call doesn&apos;t count. Only start and end.</div>
        <div className="mt-2">
          <span className="font-semibold text-foreground">Example:</span> Calling closes at 12:00. Bitcoin&apos;s first price after that is $80,000, the start price. At 12:05 it&apos;s $80,100, the end price. It went up, so UP wins.
        </div>
      </>
    ),
  },
  {
    title: "The round ends.",
    body: "If the end price is higher than the start price, UP wins. Lower, DOWN wins. Same price, everyone gets their money back.",
  },
  {
    title: "Winners share the pot.",
    body: "Winners get their money back plus a share of the losing side's money, based on how much each called. Kairo takes 2% of winnings. If you lose or get refunded, you pay no fee.",
  },
  {
    title: "Claim.",
    body: "Press Claim and your USDC goes straight to your wallet. The money sits in the contract, not with Kairo: Kairo can only take its 2% fee.",
  },
];

export default function HowItWorks() {
  return (
    <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col px-4 py-6 sm:px-8 sm:py-10">
      <header className="mb-6 flex items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-2.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="size-2.5 rounded-full bg-up" aria-hidden />
          <span className="text-[17px] font-semibold tracking-[-0.02em]">Kairo Markets</span>
        </Link>
        <Link href="/" className="rounded-full border border-border px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Back to markets
        </Link>
      </header>

      <h1 className="text-[32px] font-bold leading-tight tracking-[-0.03em]">How Kairo works</h1>

      <ol className="mt-6 flex flex-col gap-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-4 rounded-[26px] border border-border bg-card p-5">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-up font-mono text-[15px] font-bold" style={{ color: "oklch(0.24 0.06 135)" }} aria-hidden>
              {i + 1}
            </span>
            <div className="min-w-0 text-[15px] leading-relaxed text-muted-foreground">
              <span className="font-semibold text-foreground">{step.title}</span> {step.body}
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-6 text-[13px] text-muted-foreground">
        Prices are the last live trade on Bitfinex. Kairo is in beta: calls are limited to 10 USDC.
      </p>
    </main>
  );
}
