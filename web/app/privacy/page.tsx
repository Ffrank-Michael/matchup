import type { Metadata } from "next";

import { ContactEmail, LegalPage, LegalSection, legalList, linkClass, strong } from "@/components/kairo/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy | Matchup",
  description: "What Matchup receives, what it keeps, and what is public on the Arc blockchain.",
};

// Written from what the code does (lib/use-google-wallet.tsx, lib/circle-api.ts, app/api/circle/route.ts, lib/backed.ts,
// lib/price-feed.ts, onchain/chains.ts). If any of those change what is sent or kept, change this page too.
export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy" updated="21 November 2026">
      <LegalSection title="The short version">
        <p>
          Matchup has no accounts and no player database. We don&apos;t ask for your name or email, and we don&apos;t use
          analytics or ad trackers. Your calls and your wallet&apos;s balance are on the Arc blockchain, which is public.
        </p>
      </LegalSection>

      <LegalSection title="Continue with Google">
        <p>
          Continue with Google is used for one thing only: to create or open a Circle wallet for you on Arc. The sign-in
          runs through Circle&apos;s own sign-in tools. Google tells Circle that it is you, and Circle gives your browser a
          session for your wallet.
        </p>
        <p>
          Matchup&apos;s code never asks for or reads your name, email address or Google profile, and our server never
          receives them. Your wallet is a{" "}
          <a href="https://www.circle.com/wallets" target="_blank" rel="noreferrer" className={linkClass}>
            Circle
          </a>{" "}
          user-controlled wallet: Circle runs it, and you approve each action on Circle&apos;s own confirmation screen.
        </p>
      </LegalSection>

      <LegalSection title="What our server receives">
        <p>
          Circle needs a secret key that must stay on our server, so the Google wallet&apos;s requests pass through it on
          their way to Circle. They contain:
        </p>
        <ul className={legalList}>
          <li>a device id made by Circle&apos;s sign-in tools, and your Circle session token</li>
          <li>your Circle wallet id</li>
          <li>what you asked to do: the amount and address of a withdrawal, or the market, round, side and amount of a call, or the rounds you claim</li>
        </ul>
        <p>
          Our server passes these to Circle and hands back Circle&apos;s answer. <span className={strong}>It does not save
          them.</span> When a request fails, the server log gets one line: which kind of request it was, the error number,
          and Circle&apos;s error message. Your session token is never written to the log.
        </p>
        <p>
          Like most websites, our hosting provider may keep basic request logs, such as IP address, time and page.
        </p>
      </LegalSection>

      <LegalSection title="What is kept in your browser">
        <ul className={legalList}>
          <li>
            <span className={strong}>Your Google wallet session</span>, for this tab only (session storage). Closing the tab
            signs you out.
          </li>
          <li>
            <span className={strong}>Circle&apos;s own sign-in state</span>, kept by Circle&apos;s tools in your browser&apos;s
            local storage.
          </li>
          <li>
            <span className={strong}>Which agent you backed</span> for a call (your wallet address, the market, the round and
            the agent). The blockchain doesn&apos;t record this, so your browser remembers it to show it in Your calls. It
            stays in this browser and is never sent to us.
          </li>
        </ul>
        <p>Matchup sets no cookies. Fonts are served from our own site.</p>
      </LegalSection>

      <LegalSection title="The blockchain is public">
        <p>
          Every call, claim and withdrawal is a transaction on the Arc blockchain. Your wallet address, the amounts, the
          side you called and your USDC balance can be seen by anyone, for example in the{" "}
          <a href="https://explorer.arc.io" target="_blank" rel="noreferrer" className={linkClass}>
            Arc explorer
          </a>
          . Transactions are permanent: nobody, including us, can change or delete them.
        </p>
      </LegalSection>

      <LegalSection title="Services your browser talks to">
        <p>These services see your IP address, as with any web request, and have their own privacy policies:</p>
        <ul className={legalList}>
          <li><span className={strong}>Circle</span>: the Google wallet, its sign-in and its confirmation screen.</li>
          <li><span className={strong}>Google</span>: the sign-in itself, when you use Continue with Google.</li>
          <li><span className={strong}>Arc</span>: the site reads markets, rounds and balances from Arc&apos;s public network.</li>
          <li><span className={strong}>Bitfinex</span>: your browser connects to Bitfinex for the live prices and charts.</li>
          <li><span className={strong}>WalletConnect</span>: only if you connect a wallet app with WalletConnect.</li>
        </ul>
        <p>
          The AI agents&apos; calls come from Google&apos;s Gemini models, which only receive price candles. No player
          information is sent to them.
        </p>
      </LegalSection>

      <LegalSection title="Changes and contact">
        <p>If what we receive or keep changes, we will update this page and its date.</p>
        <p>
          Questions: <ContactEmail />
        </p>
      </LegalSection>
    </LegalPage>
  );
}
