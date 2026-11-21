"use client";

// "Continue with Google": a Circle user-controlled wallet on Arc mainnet, next to the normal wallet connect (which is unchanged).
// Steps (Circle's "Social login" tutorial): a device token from our server, Google sign-in (the page goes to Google and comes
// back), initialize the player (a challenge that makes the wallet), then the wallet's address and USDC are read.
// No PIN: Circle's social login is a sign-in method of its own; the player's Google account protects the wallet and actions are
// approved on Circle's confirmation screen. Every Circle API call goes through /api/circle, which holds the API key.
// Sending USDC (phase 2, part A): our server asks Circle for a transfer challenge, the player approves it on Circle's
// confirmation screen (sdk.execute), then the wallet's recent transfers are read until this one is final. No contract calls.
// Wallets are EOAs on ARC (they pay their own fee in USDC). The first players got a smart-contract wallet (SCA) in phase 1;
// those players get an EOA made next to it (one challenge in Circle's window, the first time they load the wallet) and the
// EOA is the main wallet. The SCA is never deleted: the wallet window shows it with its USDC (oldWallet) and its own Withdraw,
// whose network fee is paid by the Gas Station policy the owner set up on Arc mainnet (Circle refuses SCA sends without one).
//
// What is kept in the browser: the device token across the Google redirect, and the session (userToken, encryptionKey) for
// this tab only, in sessionStorage: closing the tab signs out. Circle's own SDK keeps its login state/nonce in localStorage.
import * as React from "react";
import type { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";
import type { SocialLoginProvider } from "@circle-fin/w3s-pw-web-sdk/dist/src/types";

import { CIRCLE_APP_ID, GOOGLE_CLIENT_ID } from "@/onchain/env";
import { pickArcWallets, pickUsdc, walletStep, type CircleBalance, type CircleWallet, type PickedWallet } from "@/lib/circle-wallet-pick";
import {
  challengeErrorText,
  failedStateText,
  feeToUnits,
  findNewTransfer,
  isFailedState,
  isFinalState,
  transferErrorText,
  type Transfer,
} from "@/lib/circle-send";
import { findNewContractCall, type ContractCall } from "@/lib/circle-calls";

export type GooglePhase = "idle" | "starting" | "verifying" | "creating" | "loading" | "ready" | "error";
/** preparing: asking Circle for the transfer; approving: Circle's confirmation screen is open; sending: approved, waiting for
 *  the chain; done: complete; pending: approved but not final after 2 minutes; error: nothing sent, or the transfer failed */
export type SendPhase = "idle" | "preparing" | "approving" | "sending" | "done" | "pending" | "error";
export type OldWallet = { address: `0x${string}`; usdc: string | null };
/** Which wallet a withdrawal comes from: the main EOA, or the older smart-contract wallet */
export type SendFrom = "main" | "old";
export type SendState = { phase: SendPhase; error: string | null; txHash: string | null; amount: string | null; to: string | null };
export type GoogleWallet = {
  /** false when the site has no Circle app id or Google client id: the option is not shown */
  enabled: boolean;
  phase: GooglePhase;
  address: `0x${string}` | null;
  /** whole USDC, e.g. "12.5"; null while unknown */
  usdc: string | null;
  error: string | null;
  start: () => void;
  retry: () => void;
  refresh: () => void;
  signOut: () => void;
  /** The player's old smart-contract wallet (SCA) from phase 1, if any. Shown with its address and USDC so they are never
   *  hidden, and it has its own Withdraw: its network fee is paid by the Gas Station policy the owner set up on Arc mainnet. */
  oldWallet: OldWallet | null;
  /** The main (EOA) wallet's withdrawal */
  sendState: SendState;
  /** The older wallet's withdrawal (its fee is paid by the Gas Station policy) */
  oldSendState: SendState;
  /** true while any withdrawal runs (only one at a time) */
  sendBusy: boolean;
  /** Circle's fee estimate for sending `amount` to `to`, in micro-USDC (rounded up); null when it could not be estimated */
  estimateFee: (to: string, amount: string) => Promise<bigint | null>;
  /** Send USDC (already checked by the form); the player approves it on Circle's confirmation screen */
  send: (to: string, amount: string, from?: SendFrom) => void;
  /** A Matchup contract call from the main (EOA) wallet: "approve" (USDC permission for the arena), "placeCall" or "claim". Creates
   *  Circle's challenge, opens Circle's confirmation screen, then follows the transaction until it is final. `contract` and
   *  `signature` say which call to look for afterwards. `onApproved` runs once the player has confirmed in Circle's window. */
  contractCall: (
    kind: "approve" | "placeCall" | "claim",
    fields: Record<string, string | boolean | string[]>,
    match: { contract: string; signature: string },
    onApproved?: () => void,
  ) => Promise<ContractCallResult>;
  resetSend: (from?: SendFrom) => void;
};

/** The server action behind each kind of contract call (lib/circle-api.ts) */
const CALL_ACTION = { approve: "approveArena", placeCall: "placeCall", claim: "claimRounds" } as const;

export type ContractCallResult = { ok: true; txHash: string | null } | { ok: false; error: string; txHash: string | null };

const NO_SEND: SendState = { phase: "idle", error: null, txHash: null, amount: null, to: null };
/** Circle's confirmation screen (the Web SDK's iframe); its messages come from here */
const CIRCLE_UI_ORIGIN = "https://pw-auth.circle.com";
type ChallengeEnd = { ok: true } | { ok: false; closed?: boolean; code?: number | null; message?: string | null };

type Device = { deviceToken: string; deviceEncryptionKey: string };
type Session = { userToken: string; encryptionKey: string };

const DEVICE_KEY = "matchup:google:device";
const SESSION_KEY = "matchup:google:session";
const ALREADY_INITIALIZED = 155106;
const INVALID_USER_TOKEN = 155104;

const read = <T,>(key: string): T | null => {
  try {
    const v = sessionStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};
const write = (key: string, v: unknown) => {
  try {
    if (v === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked (private mode): the sign-in still works in this page, it is just not kept */
  }
};

type Answer = { ok: boolean; status: number; body: Record<string, unknown> };
async function circle(action: string, fields: Record<string, string | boolean | string[]>): Promise<Answer> {
  try {
    const res = await fetch("/api/circle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...fields }) });
    const body = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const loginConfigs = (device?: Device) => ({
  deviceToken: device?.deviceToken ?? "",
  deviceEncryptionKey: device?.deviceEncryptionKey ?? "",
  google: { clientId: GOOGLE_CLIENT_ID ?? "", redirectUri: window.location.origin, selectAccountPrompt: true },
});

const GoogleWalletContext = React.createContext<GoogleWallet | null>(null);

export function GoogleWalletProvider({ children }: { children: React.ReactNode }) {
  const enabled = Boolean(CIRCLE_APP_ID && GOOGLE_CLIENT_ID);
  const [phase, setPhase] = React.useState<GooglePhase>("idle");
  const [address, setAddress] = React.useState<`0x${string}` | null>(null);
  const [walletId, setWalletId] = React.useState<string | null>(null);
  const [usdc, setUsdc] = React.useState<string | null>(null);
  // The old smart-contract wallet (SCA) from phase 1, if the player has one: read only, never deleted (see circle-wallet-pick)
  const [oldWallet, setOldWalletState] = React.useState<OldWallet | null>(null);
  const oldRef = React.useRef<PickedWallet | null>(null);
  const setOldWallet = React.useCallback((w: OldWallet | null) => {
    if (w === null) oldRef.current = null;
    setOldWalletState(w);
  }, []);
  const [error, setError] = React.useState<string | null>(null);
  const sdkRef = React.useRef<W3SSdk | null>(null);
  const sessionRef = React.useRef<Session | null>(null);
  const [sendStates, setSendStates] = React.useState<Record<SendFrom, SendState>>({ main: NO_SEND, old: NO_SEND });
  const sendingRef = React.useRef(false); // one withdrawal at a time (a second click while one runs does nothing)
  const [sendBusy, setSendBusy] = React.useState(false);

  const fail = React.useCallback((message: string) => {
    setError(message);
    setPhase("error");
  }, []);

  const signOut = React.useCallback(() => {
    write(SESSION_KEY, null);
    write(DEVICE_KEY, null);
    sessionRef.current = null;
    setAddress(null);
    setWalletId(null);
    setUsdc(null);
    setOldWallet(null);
    setError(null);
    setSendStates({ main: NO_SEND, old: NO_SEND });
    setPhase("idle");
  }, [setOldWallet]);

  // A Circle answer that says the sign-in has run out: sign out and say so
  const expired = React.useCallback(
    (a: Answer) => {
      if (a.status !== 401 && a.body.code !== INVALID_USER_TOKEN && a.body.code !== 155105) return false;
      signOut();
      fail("Your Google sign-in has run out. Sign in again.");
      return true;
    },
    [signOut, fail],
  );

  const loadBalance = React.useCallback(async (session: Session, id: string) => {
    const b = await circle("getTokenBalance", { userToken: session.userToken, walletId: id });
    if (expired(b)) return;
    setUsdc(b.ok && Array.isArray(b.body.tokenBalances) ? pickUsdc(b.body.tokenBalances as CircleBalance[]) : null);
  }, [expired]);

  // The old smart-contract wallet's USDC (phase 1 made SCA wallets; see lib/circle-wallet-pick.ts). Shown read only.
  const loadOldBalance = React.useCallback(
    async (session: Session, old: PickedWallet) => {
      oldRef.current = old;
      const b = await circle("getTokenBalance", { userToken: session.userToken, walletId: old.id });
      setOldWallet({ address: old.address, usdc: b.ok && Array.isArray(b.body.tokenBalances) ? pickUsdc(b.body.tokenBalances as CircleBalance[]) : null });
    },
    [setOldWallet],
  );

  const getSdk = React.useCallback(async (device?: Device, onLogin?: (e: unknown, r: unknown) => void) => {
    const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk"); // loaded only when Google is used: most visitors never need it
    const configs = { appSettings: { appId: CIRCLE_APP_ID ?? "" }, loginConfigs: loginConfigs(device) };
    // The SDK is one shared object: constructing it again only updates its settings (and checks for a Google reply in the address)
    sdkRef.current = new W3SSdk(configs, onLogin as never);
    return sdkRef.current;
  }, []);

  // Runs one Circle challenge in Circle's own window and says how it ended. The SDK (1.1.11) calls back on success and on an
  // error, but when the player just closes the window it only removes it and never calls back, so Circle's "close" message is
  // also heard here. It waits 1.5 s first, so an answer that arrives just after the close still wins.
  const runChallenge = React.useCallback(
    async (session: Session, challengeId: string): Promise<ChallengeEnd> => {
      const sdk = sdkRef.current ?? (await getSdk());
      await sdk.getDeviceId(); // opens the SDK's link to Circle: without it Circle's window never appears
      sdk.setAuthentication({ userToken: session.userToken, encryptionKey: session.encryptionKey });
      return new Promise<ChallengeEnd>((resolve) => {
        let ended = false;
        const finish = (end: ChallengeEnd) => {
          if (ended) return;
          ended = true;
          window.removeEventListener("message", onMessage);
          resolve(end);
        };
        const onMessage = (e: MessageEvent) => {
          if (e.origin !== CIRCLE_UI_ORIGIN) return;
          const d = e.data as { onClose?: unknown } | null;
          if (d && typeof d === "object" && d.onClose) setTimeout(() => finish({ ok: false, closed: true }), 1500);
        };
        window.addEventListener("message", onMessage);
        sdk.execute(challengeId, (err, result) => {
          if (err) return finish({ ok: false, code: typeof err.code === "number" ? err.code : null, message: err.message ?? null });
          const status = (result as { status?: string } | undefined)?.status;
          if (status === "FAILED" || status === "EXPIRED") return finish({ ok: false, message: status === "EXPIRED" ? "the request ran out" : "it failed" });
          finish({ ok: true });
        });
      });
    },
    [getSdk],
  );

  // Finds the player's EOA on Arc and uses it. A player who only has the old smart-contract wallet (SCA, from phase 1) gets an
  // EOA made once (a challenge in Circle's window); the SCA is kept and its balance stays visible. A new wallet can take a few
  // seconds to show up after Circle makes it, so the list is read a few times.
  const loadWallet = React.useCallback(
    async (session: Session, tries = 1) => {
      setPhase("loading");
      let eoaRequested = false;
      for (let i = 0; i < tries; i++) {
        if (i > 0) await sleep(2000);
        const w = await circle("listWallets", { userToken: session.userToken });
        if (expired(w)) return;
        if (!w.ok) continue;
        const found = pickArcWallets(Array.isArray(w.body.wallets) ? (w.body.wallets as CircleWallet[]) : []);
        if (found.sca) void loadOldBalance(session, found.sca);
        else setOldWallet(null);
        const step = walletStep(found, eoaRequested);
        if (step === "create") {
          eoaRequested = true;
          const c = await circle("createEoaWallet", { userToken: session.userToken });
          if (expired(c)) return;
          const challengeId = typeof c.body.challengeId === "string" ? c.body.challengeId : null;
          if (!c.ok || !challengeId) return fail("Circle could not make your new wallet. Try again.");
          setPhase("creating");
          try {
            if (!(await runChallenge(session, challengeId)).ok) return fail("Circle's window was closed before your new wallet was made. Try again.");
          } catch {
            return fail("Circle's window could not open. Try again.");
          }
          setPhase("loading");
          tries = Math.max(tries, i + 9); // look for the new wallet for about 16 more seconds
          continue;
        }
        if (step === "wait" || !found.eoa) continue;
        setAddress(found.eoa.address);
        setWalletId(found.eoa.id);
        setError(null);
        setPhase("ready");
        await loadBalance(session, found.eoa.id);
        return;
      }
      fail("Your wallet could not be loaded. Try again in a moment.");
    },
    [expired, fail, loadBalance, loadOldBalance, runChallenge, setOldWallet],
  );

  // After Google: initialize the player. A new player's wallet is made by a challenge in Circle's window; a returning player
  // already has one (155106) and it is just loaded.
  const afterLogin = React.useCallback(
    async (session: Session) => {
      setError(null);
      setPhase("loading");
      const init = await circle("initializeUser", { userToken: session.userToken });
      if (init.status === 409 || init.body.code === ALREADY_INITIALIZED) return loadWallet(session);
      if (expired(init)) return;
      const challengeId = typeof init.body.challengeId === "string" ? init.body.challengeId : null;
      if (!init.ok || !challengeId) return fail("Circle could not set up your wallet. Try again.");

      try {
        setPhase("creating");
        if (!(await runChallenge(session, challengeId)).ok) return fail("Circle's window was closed before your wallet was made. Try again.");
      } catch {
        return fail("Circle's window could not open. Try again.");
      }
      await loadWallet(session, 8);
    },
    [expired, fail, runChallenge, loadWallet],
  );

  const onLogin = React.useCallback(
    (err: unknown, result: unknown) => {
      write(DEVICE_KEY, null);
      const r = result as Partial<Session> | undefined;
      if (err || !r?.userToken || !r.encryptionKey) return fail("Google sign-in did not finish. Try again.");
      const session = { userToken: r.userToken, encryptionKey: r.encryptionKey };
      sessionRef.current = session;
      write(SESSION_KEY, session);
      void afterLogin(session);
    },
    [afterLogin, fail],
  );

  // On page load: a session in this tab is loaded again; a page that just came back from Google hands the reply to the SDK.
  // Runs once (the callbacks it uses never change identity after the first render, apart from state setters).
  const booted = React.useRef(false);
  React.useEffect(() => {
    if (!enabled || booted.current) return;
    booted.current = true;
    const session = read<Session>(SESSION_KEY);
    if (session) {
      sessionRef.current = session;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- once per page load, from this tab's storage (not readable while rendering on the server)
      void loadWallet(session);
      return;
    }
    const device = read<Device>(DEVICE_KEY);
    if (!device) return;
    if (!/(^|[#&])(id_token|state)=/.test(window.location.hash)) {
      write(DEVICE_KEY, null); // left for Google but came back without an answer (back button, or Google said no)
      return;
    }
    setPhase("verifying");
    getSdk(device, onLogin).catch(() => fail("Circle could not be reached. Try again."));
    // The SDK reports nothing if Circle never answers: give up after 25 s. (No cleanup: this effect runs once, see booted.)
    setTimeout(() => {
      if (!sessionRef.current) {
        write(DEVICE_KEY, null);
        fail("Google sign-in took too long. Try again.");
      }
    }, 25_000);
  }, [enabled, loadWallet, getSdk, onLogin, fail]);

  const start = React.useCallback(() => {
    if (!enabled) return;
    setError(null);
    setPhase("starting");
    void (async () => {
      try {
        const sdk = await getSdk();
        const deviceId = await sdk.getDeviceId();
        const t = await circle("createDeviceToken", { deviceId });
        const deviceToken = typeof t.body.deviceToken === "string" ? t.body.deviceToken : null;
        const deviceEncryptionKey = typeof t.body.deviceEncryptionKey === "string" ? t.body.deviceEncryptionKey : null;
        if (!t.ok || !deviceToken || !deviceEncryptionKey) return fail("Google sign-in is not available right now. Try again later.");
        const device = { deviceToken, deviceEncryptionKey };
        write(DEVICE_KEY, device); // kept for the page that Google sends the player back to
        sdk.updateConfigs({ appSettings: { appId: CIRCLE_APP_ID ?? "" }, loginConfigs: loginConfigs(device) }, onLogin as never);
        await sdk.performLogin("Google" as SocialLoginProvider); // the page now goes to Google
      } catch {
        write(DEVICE_KEY, null);
        fail("Google sign-in could not start. Try again.");
      }
    })();
  }, [enabled, getSdk, onLogin, fail]);

  // Still signed in (for example Circle's window was closed): carry on from where it stopped; otherwise a new Google sign-in
  const retry = React.useCallback(() => {
    const session = sessionRef.current;
    if (session) void afterLogin(session);
    else start();
  }, [afterLogin, start]);

  const refresh = React.useCallback(() => {
    const session = sessionRef.current;
    if (!session || !walletId || phase !== "ready") return;
    void loadBalance(session, walletId);
    if (oldRef.current) void loadOldBalance(session, oldRef.current);
  }, [loadBalance, loadOldBalance, walletId, phase]);

  // ── Send USDC ───────────────────────────────────────────────
  const estimateFee = React.useCallback(
    async (to: string, amount: string) => {
      const session = sessionRef.current;
      if (!session || !walletId) return null;
      const r = await circle("estimateTransferFee", { userToken: session.userToken, walletId, destinationAddress: to.trim(), amount });
      return r.ok ? feeToUnits(typeof r.body.networkFee === "string" ? r.body.networkFee : null) : null;
    },
    [walletId],
  );

  const resetSend = React.useCallback((from: SendFrom = "main") => {
    if (!sendingRef.current) setSendStates((s) => ({ ...s, [from]: NO_SEND }));
  }, []);

  // One flow for both wallets: "main" is the EOA; "old" is the older smart-contract wallet (SCA), whose network fee is paid by
  // the Gas Station policy the owner set up on Arc mainnet. Only one withdrawal runs at a time (Circle shows one window).
  const send = React.useCallback(
    (toRaw: string, amountRaw: string, from: SendFrom = "main") => {
      const session = sessionRef.current;
      const fromId = from === "main" ? walletId : (oldRef.current?.id ?? null);
      const old = oldRef.current;
      if (!session || !fromId || sendingRef.current) return;
      sendingRef.current = true;
      setSendBusy(true);
      const walletId_ = fromId;
      const setSendState = (s: SendState) => setSendStates((all) => ({ ...all, [from]: s }));
      const to = toRaw.trim();
      const amount = amountRaw.trim();
      const base = { to, amount, txHash: null };
      const stop = (phase: SendPhase, err: string | null, txHash: string | null = null) => {
        setSendState({ ...base, phase, error: err, txHash });
        sendingRef.current = false;
        setSendBusy(false);
        if (from === "main") void loadBalance(session, walletId_);
        else if (old) void loadOldBalance(session, old);
      };
      const recent = async (): Promise<Transfer[] | null> => {
        const r = await circle("listTransfers", { userToken: session.userToken, walletId: walletId_ });
        return r.ok && Array.isArray(r.body.transfers) ? (r.body.transfers as Transfer[]) : null;
      };

      void (async () => {
        try {
          setSendState({ ...base, phase: "preparing", error: null });
          // The transfers that already exist, so the new one can be told apart afterwards
          const before = new Set(((await recent()) ?? []).map((t) => t.id).filter((id): id is string => id !== null));

          const c = await circle("createTransfer", { userToken: session.userToken, walletId: walletId_, destinationAddress: to, amount });
          const challengeId = typeof c.body.challengeId === "string" ? c.body.challengeId : null;
          if (!c.ok || !challengeId) {
            sendingRef.current = false;
            setSendBusy(false);
            if (expired(c)) return;
            return stop("error", c.status === 0 ? "Matchup's server could not be reached. Nothing was sent." : transferErrorText(c.body.code, c.body.error));
          }

          setSendState({ ...base, phase: "approving", error: null });
          let end: ChallengeEnd;
          try {
            end = await runChallenge(session, challengeId);
          } catch {
            return stop("error", "Circle's confirmation screen could not open. Try again. Nothing was sent.");
          }

          // Look for the transfer, then follow it until it is final (Arc is final within seconds); up to 2 minutes.
          // Even when the window was reported closed, the list is checked once, in case it had already been approved.
          setSendState({ ...base, phase: end.ok ? "sending" : "approving", error: null });
          let hash: string | null = null;
          for (let i = 0; i < (end.ok ? 60 : 2); i++) {
            if (i > 0) await sleep(2000);
            const list = await recent();
            const t = list ? findNewTransfer(list, before, to, amount) : null;
            if (!t) continue;
            if (!end.ok) {
              end = { ok: true };
              i = 0;
            }
            hash = t.txHash ?? hash;
            setSendState({ ...base, phase: "sending", error: null, txHash: hash });
            if (isFinalState(t.state)) {
              return isFailedState(t.state) ? stop("error", failedStateText(t.state, t.errorReason), hash) : stop("done", null, hash);
            }
          }
          if (!end.ok) return stop("error", challengeErrorText(end));
          stop("pending", "Approved, but Circle has not confirmed it yet. Check your wallet on the explorer in a minute.", hash);
        } catch {
          stop("error", "Something went wrong while sending. Check your balance before trying again.");
        }
      })();
    },
    [walletId, expired, runChallenge, loadBalance, loadOldBalance],
  );

  // A Matchup contract call from the main (EOA) wallet. The server fixes the contract and function (lib/circle-api.ts); this
  // creates the challenge, opens Circle's "Contract interaction" screen, then follows the transaction like a withdrawal does.
  // Shares the one-at-a-time lock with withdrawals, so Circle never has two windows open.
  const contractCall = React.useCallback(
    async (
      kind: "approve" | "placeCall" | "claim",
      fields: Record<string, string | boolean | string[]>,
      match: { contract: string; signature: string },
      onApproved?: () => void,
    ): Promise<ContractCallResult> => {
      const session = sessionRef.current;
      if (!session || !walletId) return { ok: false, error: "Sign in with Google again, then call.", txHash: null };
      if (sendingRef.current) return { ok: false, error: "Another Circle confirmation is open. Finish it first.", txHash: null };
      sendingRef.current = true;
      setSendBusy(true);
      const done = (r: ContractCallResult) => {
        sendingRef.current = false;
        setSendBusy(false);
        void loadBalance(session, walletId);
        return r;
      };
      const recent = async (): Promise<ContractCall[] | null> => {
        const r = await circle("listContractCalls", { userToken: session.userToken, walletId });
        return r.ok && Array.isArray(r.body.calls) ? (r.body.calls as ContractCall[]) : null;
      };
      try {
        const before = new Set(((await recent()) ?? []).map((c) => c.id).filter((id): id is string => id !== null));
        const c = await circle(CALL_ACTION[kind], { userToken: session.userToken, walletId, ...fields });
        const challengeId = typeof c.body.challengeId === "string" ? c.body.challengeId : null;
        if (!c.ok || !challengeId) {
          sendingRef.current = false;
          setSendBusy(false);
          if (expired(c)) return { ok: false, error: "Your Google sign-in has run out. Sign in again.", txHash: null };
          return done({ ok: false, error: c.status === 0 ? "Matchup's server could not be reached. Nothing was sent." : transferErrorText(c.body.code, c.body.error), txHash: null });
        }
        let end: ChallengeEnd;
        try {
          end = await runChallenge(session, challengeId);
        } catch {
          return done({ ok: false, error: "Circle's confirmation screen could not open. Try again. Nothing was sent.", txHash: null });
        }
        if (end.ok) onApproved?.();
        // Follow it until final (Arc is final within seconds), up to 2 minutes; when the window was reported closed, look once
        // anyway in case it had already been approved.
        let hash: string | null = null;
        for (let i = 0; i < (end.ok ? 60 : 2); i++) {
          if (i > 0) await sleep(2000);
          const list = await recent();
          const t = list ? findNewContractCall(list, before, match.contract, match.signature) : null;
          if (!t) continue;
          if (!end.ok) {
            end = { ok: true };
            onApproved?.();
            i = 0;
          }
          hash = t.txHash ?? hash;
          if (isFinalState(t.state)) {
            return done(isFailedState(t.state) ? { ok: false, error: failedStateText(t.state, t.errorReason), txHash: hash } : { ok: true, txHash: hash });
          }
        }
        if (!end.ok) return done({ ok: false, error: challengeErrorText(end), txHash: null });
        return done({ ok: false, error: "Approved, but Circle has not confirmed it yet. Check your wallet on the explorer in a minute before trying again.", txHash: hash });
      } catch {
        return done({ ok: false, error: "Something went wrong. Check your wallet on the explorer before trying again.", txHash: null });
      }
    },
    [walletId, expired, runChallenge, loadBalance],
  );

  const value = React.useMemo<GoogleWallet>(
    () => ({
      enabled,
      phase,
      address,
      usdc,
      oldWallet,
      error,
      start,
      retry,
      refresh,
      signOut,
      sendState: sendStates.main,
      oldSendState: sendStates.old,
      sendBusy,
      estimateFee,
      send,
      resetSend,
      contractCall,
    }),
    [enabled, phase, address, usdc, oldWallet, error, start, retry, refresh, signOut, sendStates, sendBusy, estimateFee, send, resetSend, contractCall],
  );
  return <GoogleWalletContext.Provider value={value}>{children}</GoogleWalletContext.Provider>;
}

export function useGoogleWallet(): GoogleWallet {
  const v = React.useContext(GoogleWalletContext);
  if (!v) throw new Error("useGoogleWallet needs GoogleWalletProvider (components/providers.tsx)");
  return v;
}
