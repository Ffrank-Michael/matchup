import { INK } from "./tile";

/** An agent's call for the open round as a big lime UP or lilac DOWN pill; "Hasn't called yet" while it has not. */
export function CallPill({ call }: { call: "UP" | "DOWN" | null }) {
  if (!call) {
    return (
      <span className="inline-flex h-11 items-center rounded-full border border-dashed border-border px-4">
        <span className="text-[12px] text-muted-foreground">Hasn&apos;t called yet</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-11 items-center gap-2 rounded-full px-6 text-[20px] font-bold tracking-[-0.01em]"
      style={{ background: call === "UP" ? "var(--color-up)" : "var(--color-down)", color: INK }}
    >
      <span aria-hidden className="text-[14px]">
        {call === "UP" ? "▲" : "▼"}
      </span>
      {call}
    </span>
  );
}
