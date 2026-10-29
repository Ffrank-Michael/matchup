"use client";

import * as React from "react";
import { IS_MAINNET } from "@/lib/network";
import { useConnect, useConnection, useConnectors, useSwitchChain } from "wagmi";

import { chipAddress } from "@/lib/arc";
import { useRevokeApproval, useUsdc, usdcRaw } from "@/onchain";
import { activeChain, isAnnouncedWallet, useDisconnectWallet } from "@/onchain/wagmiConfig";
import { cn } from "@/lib/utils";

// "Connect wallet" for the site's Arc network (NEXT_PUBLIC_NETWORK; browser wallets and wallet apps; Google sign-in comes later).
// - Wallets are found automatically. On a phone they appear when this page is opened inside a wallet
//   app's own browser; from a normal phone browser the window offers "open in <wallet app>" links.
// - After connecting, a wallet on another network is asked to switch to the site's Arc network, and to add it first
//   if it does not know it. A pill in the top bar stays amber ("Wrong network") until that is done.

const pillBase =
  "whitespace-nowrap rounded-full px-3 py-1.5 font-mono text-[12px] font-semibold transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function friendly(error: Error | null) {
  if (!error) return null;
  const m = error.message || "";
  if (/reject|denied|cancel/i.test(m)) return "The wallet request was closed. Nothing was changed.";
  if (/already pending|-32002/i.test(m)) return "Your wallet already has a request open. Open your wallet and answer it.";
  return "Could not connect. Try again, or open your wallet and check for a request.";
}

function Row({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-3 rounded-2xl border border-border bg-background/40 px-4 py-3 text-left text-[14px] font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function ConnectView({ onDone }: { onDone: () => void }) {
  const connectors = useConnectors();
  // onSuccess is set here, not on connect(): this list is replaced by the account view the moment the wallet connects
  const { mutate: connect, isPending, variables, error, reset } = useConnect({ mutation: { onSuccess: onDone } });

  // Every wallet extension announced by the browser (EIP-6963) gets its own row, with its own name and icon. Older wallet
  // browsers only provide window.ethereum: they get one plain "Browser wallet" row.
  // WalletConnect (Reown): phone users in any browser pick a wallet app, which opens and asks to connect. Only present when a project id is set.
  const walletConnect = connectors.find((c) => c.id === "walletConnect");
  const announced = connectors.filter(isAnnouncedWallet).sort((a, b) => a.name.localeCompare(b.name));
  const hasLegacy = typeof window !== "undefined" && "ethereum" in window;
  const wallets = announced.length ? announced : hasLegacy ? connectors.filter((c) => c.id === "injected") : [];

  const isMobile = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const here = typeof window !== "undefined" ? window.location : null;
  const publicSite = here !== null && !/^(localhost|127\.)/.test(here.hostname);
  const url = here ? here.href : "";
  const appLinks = [
    { name: "MetaMask", href: `https://metamask.app.link/dapp/${here?.host ?? ""}${here?.pathname ?? ""}` },
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}` },
    { name: "Trust Wallet", href: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}` },
  ];

  return (
    <>
      {wallets.length > 0 ? (
        <ul className="space-y-2">
          {wallets.map((c) => (
            <li key={c.uid}>
              <Row
                disabled={isPending}
                onClick={() => {
                  reset();
                  connect({ connector: c, chainId: activeChain.id });
                }}
              >
                {c.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.icon} alt="" className="size-7 rounded-lg" />
                ) : (
                  <span className="size-7 rounded-lg bg-muted" aria-hidden />
                )}
                <span className="flex-1">{announced.length ? c.name : "Browser wallet"}</span>
                {isPending && variables?.connector === c ? <span className="font-mono text-[11px] text-muted-foreground">check your wallet…</span> : null}
              </Row>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {isMobile ? "No browser wallet found." : "No browser wallet found. Install one, then reload this page:"}
        </p>
      )}

      {walletConnect ? (
        <div className={wallets.length > 0 ? "mt-2" : "mt-3"}>
          <Row
            disabled={isPending}
            onClick={() => {
              reset();
              connect({ connector: walletConnect, chainId: activeChain.id });
              // Close this window now: it is a native modal <dialog> (top layer), so Reown's wallet list, which opens outside it, would sit behind it and could not be tapped.
              onDone();
            }}
          >
            <span className="grid size-7 place-items-center rounded-lg bg-muted text-[13px]" aria-hidden>
              ⌁
            </span>
            <span className="flex-1">{isMobile ? "Open a wallet app" : "WalletConnect"}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{isMobile ? "any browser" : "phone wallet"}</span>
          </Row>
        </div>
      ) : null}

      {error ? <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-[12px]">{friendly(error)}</p> : null}

      {wallets.length === 0 && !isMobile ? (
        <ul className="mt-3 space-y-2">
          <li><a className="block rounded-2xl border border-border px-4 py-3 text-[14px] font-medium hover:bg-muted" href="https://metamask.io/download" target="_blank" rel="noreferrer">Get MetaMask</a></li>
          <li><a className="block rounded-2xl border border-border px-4 py-3 text-[14px] font-medium hover:bg-muted" href="https://rabby.io" target="_blank" rel="noreferrer">Get Rabby</a></li>
        </ul>
      ) : null}

      {isMobile && wallets.length === 0 ? (
        <div className="mt-3">
          {publicSite ? (
            <>
              <p className="mb-2 text-[12px] text-muted-foreground">Open this page inside your wallet app:</p>
              <ul className="space-y-2">
                {appLinks.map((l) => (
                  <li key={l.name}>
                    <a className="block rounded-2xl border border-border px-4 py-3 text-[14px] font-medium hover:bg-muted" href={l.href}>
                      Open in {l.name}
                    </a>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[12px] text-muted-foreground">Another wallet (Rabby and others)? Open its built-in browser and go to this address.</p>
            </>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              Open this page in your wallet app&apos;s built-in browser. (The wallet-app links need the public site, not an address on your own computer.)
            </p>
          )}
        </div>
      ) : null}

      {IS_MAINNET ? (
        <p className="mt-4 text-[12px] text-muted-foreground">Matchup runs on {activeChain.name}. If your wallet does not have the network yet, it will ask to add it. Fees are paid in USDC.</p>
      ) : (
        <p className="mt-4 text-[12px] text-muted-foreground">
          Matchup runs on Arc Testnet. If your wallet does not have it yet, it will ask to add it. Fees are paid in test USDC (free from{" "}
          <a className="underline underline-offset-2 hover:text-foreground" href="https://faucet.circle.com" target="_blank" rel="noreferrer">faucet.circle.com</a>
          ).
        </p>
      )}
    </>
  );
}

/** A small grey link at the bottom of the wallet window: takes back Matchup's permission to use the wallet's USDC (after a yes/no question). */
function RemoveAccess() {
  const wallet = useUsdc();
  const approval = useRevokeApproval();
  const [asking, setAsking] = React.useState(false);
  const busy = approval.status === "wallet" || approval.status === "confirming";
  const hasAccess = wallet.allowanceRaw !== null && wallet.allowanceRaw > 0n;

  if (asking || busy) {
    return (
      <div className="mt-4 text-center text-[12px] text-muted-foreground" role="status">
        <p>Are you sure? You&apos;ll need to approve again on your next call.</p>
        {busy ? (
          <p className="mt-2">Confirm in your wallet…</p>
        ) : (
          <div className="mt-2 flex justify-center gap-4">
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                void approval.revoke();
              }}
              className="font-medium underline underline-offset-2 hover:text-foreground"
            >
              Yes, remove
            </button>
            <button type="button" onClick={() => setAsking(false)} className="underline underline-offset-2 hover:text-foreground">
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4 text-center">
      {hasAccess ? (
        <button type="button" onClick={() => setAsking(true)} className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
          Remove Matchup&apos;s access to my USDC
        </button>
      ) : null}
      <p className="text-[11px] text-muted-foreground" role="status">
        {approval.status === "failed" && approval.errorMessage ? approval.errorMessage : approval.status === "done" ? "Matchup's access was removed." : ""}
      </p>
    </div>
  );
}

function AccountView({ address, wrongNetwork, onDone }: { address: `0x${string}`; wrongNetwork: boolean; onDone: () => void }) {
  const disconnect = useDisconnectWallet();
  const { mutate: switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const { balanceRaw } = useUsdc(); // the USDC token (6 decimals), never the 18-decimal native view of the same money
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard not allowed here: the address is shown in full above anyway */
    }
  };

  return (
    <>
      <p className="break-all rounded-2xl bg-muted px-4 py-3 font-mono text-[12px]">{address}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={copy} className="flex-1 rounded-full border border-border px-3 py-2 text-[12px] font-medium hover:bg-muted">
          {copied ? "Copied" : "Copy address"}
        </button>
        <a
          href={`${activeChain.blockExplorers.default.url}/address/${address}`}
          target="_blank"
          rel="noreferrer"
          className="flex-1 rounded-full border border-border px-3 py-2 text-center text-[12px] font-medium hover:bg-muted"
        >
          View on explorer
        </a>
      </div>

      {wrongNetwork ? (
        <div className="mt-4 rounded-2xl border border-amber-400/50 bg-amber-400/10 p-3">
          <p className="text-[13px]">Your wallet is on a different network. Matchup runs on {activeChain.name}.</p>
          <button
            type="button"
            disabled={switching}
            onClick={() => switchChain({ chainId: activeChain.id })}
            className="mt-2 w-full rounded-full bg-foreground px-4 py-2.5 text-[13px] font-semibold text-background disabled:opacity-60"
          >
            {switching ? "Check your wallet…" : `Switch to ${activeChain.name}`}
          </button>
          {switchError ? <p className="mt-2 text-[12px] text-muted-foreground">{friendly(switchError)}</p> : null}
        </div>
      ) : (
        <p className="mt-4 flex items-center justify-between rounded-2xl border border-border px-4 py-3 text-[13px]">
          <span className="text-muted-foreground">{activeChain.name} · balance</span>
          <span className="font-mono font-semibold tabular-nums">
            {balanceRaw !== null ? `${usdcRaw(balanceRaw)} USDC` : "…"}
          </span>
        </p>
      )}

      <button
        type="button"
        onClick={() => {
          disconnect();
          onDone();
        }}
        className="mt-4 w-full rounded-full border border-border px-4 py-2.5 text-[13px] font-medium hover:bg-muted"
      >
        Disconnect
      </button>

      {wrongNetwork ? null : <RemoveAccess />}
    </>
  );
}

const menuItem =
  "block w-full rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The address button's small menu: copy the address, pick another wallet, disconnect (and the full wallet window for the rest). */
function AccountMenu({ address, onSwitch, onDetails }: { address: `0x${string}`; onSwitch: () => void; onDetails: () => void }) {
  const disconnect = useDisconnectWallet();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const wrap = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!menuOpen) return;
    const away = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [menuOpen]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setMenuOpen(false);
      }, 900);
    } catch {
      setMenuOpen(false); // clipboard not allowed here: the full address is in "Wallet details"
    }
  };

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
        className={cn(pillBase, "flex items-center gap-2 border border-border hover:bg-muted")}
      >
        <span className="size-2 rounded-full bg-up" aria-hidden />
        {chipAddress(address)}
      </button>
      {menuOpen ? (
        <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-48 rounded-2xl border border-border bg-card p-1.5 text-card-foreground shadow-lg">
          <button type="button" role="menuitem" onClick={copy} className={menuItem}>
            {copied ? "Copied" : "Copy address"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              disconnect(onSwitch); // the wallet list opens once the old wallet is disconnected
            }}
            className={menuItem}
          >
            Switch wallet
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onDetails();
            }}
            className={menuItem}
          >
            Wallet details
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              disconnect();
            }}
            className={menuItem}
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function WalletButton() {
  const { address, chainId, status } = useConnection();
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const connected = status === "connected" && address !== undefined;
  const wrongNetwork = connected && chainId !== activeChain.id;

  let button: React.ReactNode;
  if (status === "reconnecting" || status === "connecting") {
    button = (
      <button type="button" disabled className={cn(pillBase, "border border-border text-muted-foreground")}>
        {address ? chipAddress(address) : "Connecting…"}
      </button>
    );
  } else if (connected && wrongNetwork) {
    // one tap asks the wallet to switch (and to add the Arc network first if needed)
    button = (
      <button
        type="button"
        disabled={switching}
        onClick={() => switchChain({ chainId: activeChain.id })}
        className={cn(pillBase, "bg-amber-400 text-black hover:opacity-90")}
      >
        {switching ? "Check your wallet…" : "Wrong network"}
      </button>
    );
  } else if (connected) {
    button = <AccountMenu address={address} onSwitch={() => setOpen(true)} onDetails={() => setOpen(true)} />;
  } else {
    button = (
      <button type="button" onClick={() => setOpen(true)} className={cn(pillBase, "bg-foreground text-background hover:opacity-90")}>
        Connect<span className="hidden sm:inline">&nbsp;wallet</span>
      </button>
    );
  }

  return (
    <>
      {button}
      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpen(false);
        }}
        aria-label={connected ? "Your wallet" : "Connect wallet"}
        className="mb-3 mt-auto w-[calc(100%-1.5rem)] max-w-md rounded-[26px] border border-border bg-card p-5 text-card-foreground backdrop:bg-black/60 backdrop:backdrop-blur-sm sm:m-auto"
      >
        {open ? (
          <>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-[16px] font-semibold tracking-tight">{connected ? "Your wallet" : "Connect wallet"}</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="grid size-8 place-items-center rounded-full border border-border text-muted-foreground hover:bg-muted">
                ×
              </button>
            </div>
            {connected ? <AccountView address={address} wrongNetwork={wrongNetwork} onDone={() => setOpen(false)} /> : <ConnectView onDone={() => setOpen(false)} />}
          </>
        ) : null}
      </dialog>
    </>
  );
}
