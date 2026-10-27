"use client";

import Link from "next/link";
import * as React from "react";
import { useConnection, useDisconnect } from "wagmi";

const itemClass =
  "flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-background/40 px-4 py-3 text-left text-[14px] font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The phone's menu: a ☰ button in the top bar that opens a small sheet from the bottom. Laptops keep the plain "How it works" link. */
export function PhoneMenu() {
  const { address, status } = useConnection();
  const { mutate: disconnect } = useDisconnect();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDialogElement>(null);
  const connected = status === "connected" && address !== undefined;

  React.useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const close = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        aria-label="Menu"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="grid size-8 place-items-center rounded-full border border-border text-[16px] leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
      >
        <span aria-hidden>☰</span>
      </button>
      <dialog
        ref={ref}
        onClose={close}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        aria-label="Menu"
        className="mb-3 mt-auto w-[calc(100%-1.5rem)] max-w-md rounded-[26px] border border-border bg-card p-5 text-card-foreground backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      >
        {open ? (
          <>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-[16px] font-semibold tracking-tight">Menu</h2>
              <button type="button" onClick={close} aria-label="Close" className="grid size-8 place-items-center rounded-full border border-border text-muted-foreground hover:bg-muted">
                ×
              </button>
            </div>
            <nav className="flex flex-col gap-2">
              <Link href="/how-it-works" onClick={close} className={itemClass}>
                How it works
              </Link>
              <Link href="/how-it-works#fees" onClick={close} className={itemClass}>
                Rules &amp; fees
              </Link>
              {connected ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      disconnect();
                      close();
                    }}
                    className={itemClass}
                  >
                    Disconnect
                  </button>
                </>
              ) : null}
            </nav>
          </>
        ) : null}
      </dialog>
    </>
  );
}
