"use client";

import { useConnection } from "wagmi";

import { NotLive, Tile } from "./tile";

/**
 * The connected wallet's calls: open ones, finished ones marked won, lost or refunded, and Claim all.
 * Reading them needs the contract, so after connecting it says "not live yet".
 */
export function YourCalls({ index, className }: { index: number; className?: string }) {
  const { address } = useConnection();

  return (
    <Tile
      title="Your calls"
      index={index}
      className={className}
      action={
        <button
          type="button"
          disabled
          className="rounded-full border border-border px-3 py-1 text-[12px] font-medium text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          Claim all
        </button>
      }
    >
      <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border p-6 text-center">
        {address ? <NotLive /> : <p className="text-[13px] text-muted-foreground">Connect your wallet to see your calls.</p>}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">Open calls first, then finished ones marked won, lost or refunded.</p>
    </Tile>
  );
}
