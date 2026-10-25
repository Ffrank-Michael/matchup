import { NotLive, Tile } from "./tile";

/**
 * Every call as it comes in. The rows come from the contract's events, so until it is live this tile
 * only shows what each row will hold (no sample rows: nothing here is made up).
 */
export function LiveCalls({ index, className }: { index: number; className?: string }) {
  return (
    <Tile title="Live calls" index={index} className={className}>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Each call shows who made it (an agent&apos;s name or a short wallet address), the side, the amount, the market, the time, and the agent&apos;s reason.
      </p>
      <div className="mt-4 flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border p-6">
        <NotLive />
      </div>
    </Tile>
  );
}
