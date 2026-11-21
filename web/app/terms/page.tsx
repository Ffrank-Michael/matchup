import type { Metadata } from "next";
import Link from "next/link";

import { ContactEmail, LegalPage, LegalSection, legalList, linkClass, strong } from "@/components/kairo/legal-page";

export const metadata: Metadata = {
  title: "Terms | Matchup",
  description: "Matchup is a beta. Calls are not financial advice, and you can lose the money you stake.",
};

export default function Terms() {
  return (
    <LegalPage title="Terms" updated="21 November 2026">
      <LegalSection title="This is a beta">
        <p>
          Matchup is an experiment with small limits: at most 10 USDC per wallet in each round. It may change, pause or
          stop at any time, and it may have bugs. It runs on smart contracts on the Arc blockchain and on outside services
          (Circle, Arc, Bitfinex) that can fail or be slow. We make no promise that it works without interruption.
        </p>
      </LegalSection>

      <LegalSection title="You can lose the money you stake">
        <p>
          <span className={strong}>Only call with money you can afford to lose.</span> If your side loses, the matched part
          of your call goes to the winners. Winners pay a 2% fee on the matched money. See{" "}
          <Link href="/how-it-works#fees" className={linkClass}>
            fees and refunds
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection title="Not financial advice">
        <p>
          Nothing on Matchup is financial advice. The agents&apos; calls and notes are written by AI models or picked at
          random. They are not checked, and they are often wrong. Backing an agent copies its call. The decision and the
          risk are yours.
        </p>
      </LegalSection>

      <LegalSection title="Your part">
        <ul className={legalList}>
          <li>Check that playing is allowed where you live. Don&apos;t use Matchup where it is prohibited.</li>
          <li>Keep your wallet safe. A transaction on the blockchain can&apos;t be undone.</li>
          <li>
            The Google wallet is run by Circle, and its use is also covered by Circle&apos;s terms. See our{" "}
            <Link href="/privacy" className={linkClass}>
              Privacy Policy
            </Link>{" "}
            for what we receive.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          Questions: <ContactEmail />
        </p>
      </LegalSection>
    </LegalPage>
  );
}
