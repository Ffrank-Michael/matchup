"use client";

// "Continue with Google": a Circle user-controlled wallet on Arc mainnet, next to the normal wallet connect (which is unchanged).
// Steps (Circle's "Social login" tutorial): a device token from our server, Google sign-in (the page goes to Google and comes
// back), initialize the player (a challenge that makes the wallet), then the wallet's address and USDC are read.
// No PIN: Circle's social login is a sign-in method of its own; the player's Google account protects the wallet and actions are
// approved on Circle's confirmation screen. Every Circle API call goes through /api/circle, which holds the API key.
// Phase 1 only: nothing here sends money, signs or calls a contract.
//
// What is kept in the browser: the device token across the Google redirect, and the session (userToken, encryptionKey) for
// this tab only, in sessionStorage: closing the tab signs out. Circle's own SDK keeps its login state/nonce in localStorage.
import * as React from "react";
import type { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";
import type { SocialLoginProvider } from "@circle-fin/w3s-pw-web-sdk/dist/src/types";

import { CIRCLE_APP_ID, GOOGLE_CLIENT_ID } from "@/onchain/env";
import { pickArcWallet, pickUsdc, type CircleBalance, type CircleWallet } from "@/lib/circle-wallet-pick";

export type GooglePhase = "idle" | "starting" | "verifying" | "creating" | "loading" | "ready" | "error";
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
};

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
async function circle(action: string, fields: Record<string, string>): Promise<Answer> {
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
  const [error, setError] = React.useState<string | null>(null);
  const sdkRef = React.useRef<W3SSdk | null>(null);
  const sessionRef = React.useRef<Session | null>(null);

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
    setError(null);
    setPhase("idle");
  }, []);

  // A Circle answer that says the sign-in has run out: sign out and say so
  const expired = React.useCallback(
    (a: Answer) => {
      if (a.status !== 401 && a.body.code !== INVALID_USER_TOKEN) return false;
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

  // A new wallet can take a few seconds to show up after Circle makes it, so it is looked for a few times
  const loadWallet = React.useCallback(
    async (session: Session, tries = 1) => {
      setPhase("loading");
      for (let i = 0; i < tries; i++) {
        if (i > 0) await sleep(2000);
        const w = await circle("listWallets", { userToken: session.userToken });
        if (expired(w)) return;
        if (!w.ok) continue;
        const found = pickArcWallet(Array.isArray(w.body.wallets) ? (w.body.wallets as CircleWallet[]) : []);
        if (!found) continue;
        setAddress(found.address);
        setWalletId(found.id);
        setError(null);
        setPhase("ready");
        await loadBalance(session, found.id);
        return;
      }
      fail("Your wallet could not be loaded. Try again in a moment.");
    },
    [expired, fail, loadBalance],
  );

  const getSdk = React.useCallback(async (device?: Device, onLogin?: (e: unknown, r: unknown) => void) => {
    const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk"); // loaded only when Google is used: most visitors never need it
    const configs = { appSettings: { appId: CIRCLE_APP_ID ?? "" }, loginConfigs: loginConfigs(device) };
    // The SDK is one shared object: constructing it again only updates its settings (and checks for a Google reply in the address)
    sdkRef.current = new W3SSdk(configs, onLogin as never);
    return sdkRef.current;
  }, []);

  // Runs one Circle challenge in Circle's own window; resolves true when the player finished it
  const runChallenge = React.useCallback(
    async (session: Session, challengeId: string) => {
      const sdk = sdkRef.current ?? (await getSdk());
      await sdk.getDeviceId(); // opens the SDK's link to Circle: without it Circle's window never appears
      sdk.setAuthentication({ userToken: session.userToken, encryptionKey: session.encryptionKey });
      return new Promise<boolean>((resolve) => sdk.execute(challengeId, (err) => resolve(!err)));
    },
    [getSdk],
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
        if (!(await runChallenge(session, challengeId))) return fail("Circle's window was closed before your wallet was made. Try again.");
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
    if (session && walletId && phase === "ready") void loadBalance(session, walletId);
  }, [loadBalance, walletId, phase]);

  const value = React.useMemo<GoogleWallet>(
    () => ({ enabled, phase, address, usdc, error, start, retry, refresh, signOut }),
    [enabled, phase, address, usdc, error, start, retry, refresh, signOut],
  );
  return <GoogleWalletContext.Provider value={value}>{children}</GoogleWalletContext.Provider>;
}

export function useGoogleWallet(): GoogleWallet {
  const v = React.useContext(GoogleWalletContext);
  if (!v) throw new Error("useGoogleWallet needs GoogleWalletProvider (components/providers.tsx)");
  return v;
}
