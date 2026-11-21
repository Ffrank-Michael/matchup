"use client";

// "Deposit" and "Withdraw" in the Google wallet window. Withdraw: an address, an amount, Max and Withdraw. The checks live in
// lib/circle-send.ts; the sending (Circle transfer challenge, Circle's confirmation screen, following the transfer) in
// lib/use-google-wallet.tsx. Only USDC on Arc mainnet can be withdrawn. Nothing here places calls or touches the arena contract.
// The same Withdraw is used twice: for the main wallet (an EOA: pays its own fee in USDC, Max keeps some back) and for the
// older smart-contract wallet (its fee is paid by the Gas Station policy, so Max takes the whole balance).
import * as React from "react";

import { arcMainnet } from "@/onchain/chains";
import type { GoogleWallet, SendFrom } from "@/lib/use-google-wallet";
import {
  LARGE_SEND,
  balanceToUnits,
  checkSend,
  explorerTxUrl,
  feeReserve,
  fromUnits,
  isAddress,
  maxWithdraw,
  toUnits,
} from "@/lib/circle-send";

const EXPLORER = arcMainnet.blockExplorers.default.url;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const link = "inline-block font-medium underline underline-offset-2";

const BUSY_LABEL: Record<string, string> = {
  preparing: "Preparing…",
  approving: "Confirm in Circle's window…",
  sending: "Withdrawing…",
};

/** Where to deposit: the wallet's address, Copy address, and which network to use. (No QR code: the project has no QR
 *  library of its own, only one buried inside WalletConnect, and adding one was not wanted.) */
export function GoogleDeposit({ address }: { address: `0x${string}` }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard not allowed here: the address is shown in full anyway */
    }
  };
  return (
    <section className="mt-4 rounded-2xl border border-border px-4 py-3" aria-labelledby="google-deposit-title">
      <h3 id="google-deposit-title" className="text-[13px] font-semibold">
        Deposit
      </h3>
      <p className="mt-1 text-[12px] text-muted-foreground">Send USDC to this address:</p>
      <p className="mt-2 break-all rounded-xl bg-muted px-3 py-2 font-mono text-[12px]">{address}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={copy} className="flex-1 rounded-full border border-border px-3 py-2 text-[12px] font-medium hover:bg-muted">
          {copied ? "Copied" : "Copy address"}
        </button>
        <a
          href={`${EXPLORER}/address/${address}`}
          target="_blank"
          rel="noreferrer"
          className="flex-1 rounded-full border border-border px-3 py-2 text-center text-[12px] font-medium hover:bg-muted"
        >
          View on explorer
        </a>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">Send USDC on Arc mainnet only. Sending other coins or using another network can lose them.</p>
    </section>
  );
}

export function GoogleWithdraw({
  google,
  from = "main",
  address,
  usdc,
  sponsored = false,
}: {
  google: GoogleWallet;
  from?: SendFrom;
  /** the address this wallet withdraws from */
  address: `0x${string}`;
  /** its balance in whole USDC */
  usdc: string | null;
  /** true when the Gas Station policy pays the fee (the older smart-contract wallet) */
  sponsored?: boolean;
}) {
  const [to, setTo] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [tried, setTried] = React.useState(false);
  const { estimateFee, send, resetSend } = google;
  const sendState = from === "main" ? google.sendState : google.oldSendState;
  const balance = balanceToUnits(usdc);
  const mine = sendState.phase === "preparing" || sendState.phase === "approving" || sendState.phase === "sending";
  const busy = mine || google.sendBusy; // one withdrawal at a time, from either wallet
  const id = (s: string) => `google-${from}-withdraw-${s}`;

  // Circle's fee estimate for this address (and the typed amount when it is usable), fetched 0.6 s after typing stops.
  // Kept with the address and amount it was made for, so a stale estimate is never used. A sponsored wallet needs none.
  const target = to.trim();
  const ownAddress = target.toLowerCase() === address.toLowerCase();
  const typed = toUnits(amount);
  const estimateAmount =
    typed !== null && typed > 0n && balance !== null && typed <= balance ? fromUnits(typed) : balance !== null && balance >= 10_000n ? "0.01" : null;
  const feeKey = !sponsored && isAddress(target) && !ownAddress && estimateAmount ? `${target.toLowerCase()}|${estimateAmount}` : null;
  const [feeFor, setFeeFor] = React.useState<{ key: string; fee: bigint | null } | null>(null);
  React.useEffect(() => {
    if (!feeKey || !estimateAmount) return;
    let live = true;
    const t = setTimeout(() => {
      void estimateFee(target, estimateAmount).then((fee) => {
        if (live) setFeeFor({ key: feeKey, fee });
      });
    }, 600);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [feeKey, estimateAmount, target, estimateFee]);
  const fee = !sponsored && feeFor && feeFor.key === feeKey ? feeFor.fee : null;

  const problem = checkSend({ to, amount, own: address, balance, fee });
  const showProblem = tried || (to.trim() !== "" && amount.trim() !== "");

  const onMax = () => {
    if (balance === null) return;
    setAmount(fromUnits(maxWithdraw(balance, fee, sponsored)));
  };

  const onWithdraw = () => {
    setTried(true);
    if (problem || busy) return;
    send(to, amount, from);
  };

  const startOver = () => {
    resetSend(from);
    setTo("");
    setAmount("");
    setTried(false);
  };

  const txUrl = sendState.txHash ? explorerTxUrl(EXPLORER, sendState.txHash) : null;

  if (sendState.phase === "done") {
    return (
      <section className="mt-3 rounded-2xl border border-border px-4 py-3 text-[13px]" aria-live="polite">
        <p className="font-semibold">Withdrew {sendState.amount} USDC</p>
        <p className="mt-1 text-[12px] text-muted-foreground">to {sendState.to ? short(sendState.to) : "the address"} on {arcMainnet.name} mainnet.</p>
        {txUrl ? (
          <a href={txUrl} target="_blank" rel="noreferrer" className={`mt-2 text-[12px] ${link}`}>
            View the transaction on the explorer
          </a>
        ) : null}
        <button type="button" onClick={startOver} className="mt-3 w-full rounded-full border border-border px-4 py-2 text-[12px] font-medium hover:bg-muted">
          Withdraw more
        </button>
      </section>
    );
  }

  return (
    <section className="mt-3 rounded-2xl border border-border px-4 py-3" aria-labelledby={id("title")}>
      <h3 id={id("title")} className="text-[13px] font-semibold">
        Withdraw
      </h3>

      <label className="mt-3 block text-[12px] text-muted-foreground" htmlFor={id("to")}>
        Withdraw to address
      </label>
      <input
        id={id("to")}
        value={to}
        onChange={(e) => setTo(e.target.value)}
        disabled={busy}
        placeholder="0x…"
        autoComplete="off"
        spellCheck={false}
        inputMode="text"
        className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none focus:border-foreground/40 disabled:opacity-60"
      />

      <label className="mt-3 block text-[12px] text-muted-foreground" htmlFor={id("amount")}>
        Amount (USDC)
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id={id("amount")}
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(",", "."))}
          disabled={busy}
          placeholder="0.00"
          autoComplete="off"
          inputMode="decimal"
          className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 font-mono text-[13px] tabular-nums outline-none focus:border-foreground/40 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={onMax}
          disabled={busy || balance === null || balance === 0n}
          className="rounded-full border border-border px-4 py-2 text-[12px] font-medium hover:bg-muted disabled:opacity-50"
        >
          Max
        </button>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {sponsored
          ? "The network fee for this wallet is paid for you (Gas Station), so Max withdraws everything."
          : fee !== null
            ? `Network fee: about ${fromUnits(fee)} USDC (paid in USDC). Max keeps ${fromUnits(feeReserve(fee))} USDC back for it.`
            : `The network fee is paid in USDC. Max keeps ${fromUnits(feeReserve(null))} USDC back until the fee is known.`}
      </p>

      {showProblem && problem ? (
        <p className="mt-2 text-[12px] text-destructive" role="alert">
          {problem}
        </p>
      ) : null}
      {!problem && typed !== null && typed > LARGE_SEND ? (
        <p className="mt-2 text-[12px] font-medium">That is more than {fromUnits(LARGE_SEND)} USDC. Check the address twice.</p>
      ) : null}

      {sendState.phase === "error" || sendState.phase === "pending" ? (
        <div className="mt-2 text-[12px]" role="alert">
          <p className={sendState.phase === "error" ? "text-destructive" : ""}>{sendState.error}</p>
          {txUrl ? (
            <a href={txUrl} target="_blank" rel="noreferrer" className={`mt-1 ${link}`}>
              View the transaction on the explorer
            </a>
          ) : sendState.phase === "pending" ? (
            <a href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer" className={`mt-1 ${link}`}>
              Open your wallet on the explorer
            </a>
          ) : null}
        </div>
      ) : null}
      {sendState.phase === "sending" && txUrl ? (
        <a href={txUrl} target="_blank" rel="noreferrer" className={`mt-2 text-[12px] ${link}`}>
          View the transaction on the explorer
        </a>
      ) : null}

      <button
        type="button"
        onClick={onWithdraw}
        disabled={busy}
        className="mt-3 w-full rounded-full bg-foreground px-4 py-2.5 text-[13px] font-semibold text-background hover:opacity-90 disabled:opacity-60"
      >
        {mine ? BUSY_LABEL[sendState.phase] : google.sendBusy ? "Another withdrawal is running…" : "Withdraw"}
      </button>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Withdraw sends real USDC on {arcMainnet.name} mainnet and cannot be undone. You confirm it on Circle&apos;s screen before
        anything moves.
      </p>
    </section>
  );
}
