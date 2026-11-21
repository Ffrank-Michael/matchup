import Link from "next/link";
import type * as React from "react";

/** Where players can write to Matchup. Fill this in before going live; until it holds an "@" it is shown as plain text. */
export const CONTACT_EMAIL = "<your email>";

/** The contact address, as a mailto link once it is filled in */
export function ContactEmail() {
  if (!CONTACT_EMAIL.includes("@")) return <span className="font-semibold text-foreground">{CONTACT_EMAIL}</span>;
  return (
    <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-foreground underline underline-offset-2">
      {CONTACT_EMAIL}
    </a>
  );
}

/** The frame of the Privacy and Terms pages: the same header and width as How it works. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
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

      <h1 className="text-[32px] font-bold leading-tight tracking-[-0.03em]">{title}</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">Last updated {updated}</p>

      <div className="mt-6 flex flex-col">{children}</div>
    </main>
  );
}

/** One titled part of a legal page */
export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 first:mt-0">
      <h2 className="text-[22px] font-bold tracking-[-0.02em]">{title}</h2>
      <div className="mt-2 flex flex-col gap-2 text-[15px] leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export const legalList = "flex list-disc flex-col gap-2 pl-5";
export const strong = "font-semibold text-foreground";
export const linkClass = "underline underline-offset-2 hover:text-foreground";
