"use client";

import * as React from "react";
import { formatUnits } from "viem";
import { IS_MAINNET } from "@/lib/network";
import { useBalance, useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { chipAddress } from "@/lib/arc";
import { APPROVAL_NOTICE, DEFAULT_APPROVAL_USDC, usdc, useRevokeApproval, useUsdc } from "@/onchain";
import { activeChain as arcTestnet } from "@/onchain/wagmiConfig";
import { cn } from "@/lib/utils";

// "Connect wallet" for Arc testnet (browser wallets and wallet apps; Google sign-in comes later).
// - Wallets are found automatically. On a phone they appear when this page is opened inside a wallet
//   app's own browser; from a normal phone browser the window offers "open in <wallet app>" links.
// - After connecting, a wallet on another network is asked to switch to Arc Testnet, and to add it first
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
  const { mutate: connect, isPending, variables, error, reset } = useConnect();

  // Wallets announced by the browser (EIP-6963). Older wallet browsers only provide window.ethereum.
  // WalletConnect (Reown): phone users in any browser pick a wallet app, which opens and asks to connect. Only present when a project id is set.
  const walletConnect = connectors.find((c) => c.id === "walletConnect");
  const announced = connectors.filter((c) => c.rdns);
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
                  connect({ connector: c, chainId: arcTestnet.id }, { onSuccess: onDone });
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
          {isMobile ? "No wallet found in this browser." : "No wallet found in this browser. Install one, then reload this page:"}
        </p>
      )}

      {walletConnect ? (
        <div className={wallets.length > 0 ? "mt-2" : "mt-3"}>
          <Row
            disabled={isPending}
            onClick={() => {
              reset();
              connect({ connector: walletConnect, chainId: arcTestnet.id }, { onSuccess: onDone });
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
        <p className="mt-4 text-[12px] text-muted-foreground">Kairo runs on Arc. If your wallet does not have the network yet, it will ask to add it. Fees are paid in USDC.</p>
      ) : (
        <p className="mt-4 text-[12px] text-muted-foreground">
          Kairo runs on Arc Testnet. If your wallet does not have it yet, it will ask to add it. Fees are paid in test USDC (free from{" "}
          <a className="underline underline-offset-2 hover:text-foreground" href="https://faucet.circle.com" target="_blank" rel="noreferrer">faucet.circle.com</a>
          ).
        </p>
      )}
    </>
  );
}

/** The one-time permission ("spending limit"): how much Kairo may take from the wallet. Change it or remove it here. */
export function SpendingLimit() {
  const wallet = useUsdc();
  const approval = useRevokeApproval();
  const [value, setValue] = React.useState(String(DEFAULT_APPROVAL_USDC));
  const busy = approval.status === "wallet" || approval.status === "confirming";
  const left = wallet.allowanceRaw;
  return (
    <div className="mt-3 rounded-2xl border border-border px-4 py-3 text-[13px]">
      <p className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">Spending limit</span>
        <span className="font-mono font-semibold tabular-nums">{left === null ? "…" : left > 0n ? `${usdc(left)} left` : "None set"}</span>
      </p>
      <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{APPROVAL_NOTICE}</p>
      <div className="mt-3 flex items-center gap-2">
        <span className="flex h-10 min-w-0 flex-1 items-center gap-1 rounded-xl border border-border px-3">
          <span className="font-mono text-muted-foreground">$</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, "").slice(0, 10))}
            aria-label="Spending limit in USDC"
            className="w-full min-w-0 bg-transparent font-mono tabular-nums outline-none"
          />
        </span>
        <button
          type="button"
          disabled={busy || value === "" || value === "."}
          onClick={() => void approval.setLimit(value)}
          className="h-10 rounded-xl bg-foreground px-4 text-[13px] font-semibold text-background disabled:opacity-50"
        >
          Change
        </button>
      </div>
      {left !== null && left > 0n ? (
        <button type="button" disabled={busy} onClick={() => void approval.revoke()} className="mt-2 text-[12px] font-medium underline underline-offset-2 disabled:opacity-50">
          Remove permission
        </button>
      ) : null}
      <p className="mt-2 text-[11px] text-muted-foreground" role="status">
        {busy ? "Confirm in your wallet…" : approval.status === "failed" && approval.errorMessage ? approval.errorMessage : approval.status === "done" ? "Done." : ""}
      </p>
    </div>
  );
}

function AccountView({ address, wrongNetwork, onDone }: { address: `0x${string}`; wrongNetwork: boolean; onDone: () => void }) {
  const { mutate: disconnect } = useDisconnect();
  const { mutate: switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const { data: balance } = useBalance({ address, chainId: arcTestnet.id, query: { enabled: !wrongNetwork } });
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
          href={`${arcTestnet.blockExplorers.default.url}/address/${address}`}
          target="_blank"
          rel="noreferrer"
          className="flex-1 rounded-full border border-border px-3 py-2 text-center text-[12px] font-medium hover:bg-muted"
        >
          View on explorer
        </a>
      </div>

      {wrongNetwork ? (
        <div className="mt-4 rounded-2xl border border-amber-400/50 bg-amber-400/10 p-3">
          <p className="text-[13px]">Your wallet is on a different network. Kairo runs on Arc Testnet.</p>
          <button
            type="button"
            disabled={switching}
            onClick={() => switchChain({ chainId: arcTestnet.id })}
            className="mt-2 w-full rounded-full bg-foreground px-4 py-2.5 text-[13px] font-semibold text-background disabled:opacity-60"
          >
            {switching ? "Check your wallet…" : "Switch to Arc Testnet"}
          </button>
          {switchError ? <p className="mt-2 text-[12px] text-muted-foreground">{friendly(switchError)}</p> : null}
        </div>
      ) : (
        <p className="mt-4 flex items-center justify-between rounded-2xl border border-border px-4 py-3 text-[13px]">
          <span className="text-muted-foreground">Arc Testnet · balance</span>
          <span className="font-mono font-semibold tabular-nums">
            {balance ? `${Number(formatUnits(balance.value, balance.decimals)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC` : "…"}
          </span>
        </p>
      )}

      {wrongNetwork ? null : <SpendingLimit />}

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
    </>
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
  const wrongNetwork = connected && chainId !== arcTestnet.id;

  let button: React.ReactNode;
  if (status === "reconnecting" || status === "connecting") {
    button = (
      <button type="button" disabled className={cn(pillBase, "border border-border text-muted-foreground")}>
        {address ? chipAddress(address) : "Connecting…"}
      </button>
    );
  } else if (connected && wrongNetwork) {
    // one tap asks the wallet to switch (and to add Arc Testnet first if needed)
    button = (
      <button
        type="button"
        disabled={switching}
        onClick={() => switchChain({ chainId: arcTestnet.id })}
        className={cn(pillBase, "bg-amber-400 text-black hover:opacity-90")}
      >
        {switching ? "Check your wallet…" : "Wrong network"}
      </button>
    );
  } else if (connected) {
    button = (
      <button type="button" onClick={() => setOpen(true)} className={cn(pillBase, "flex items-center gap-2 border border-border hover:bg-muted")}>
        <span className="size-2 rounded-full bg-up" aria-hidden />
        {chipAddress(address)}
      </button>
    );
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
