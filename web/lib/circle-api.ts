// Server side of "Continue with Google" (Circle user-controlled wallets). Only app/api/circle/route.ts uses this file: it holds
// the Circle API key, which must never reach the browser. The browser sends { action, ...fields } and gets back only the fields
// picked out below, never Circle's raw answer and never the key. Exactly four actions are accepted:
//   createDeviceToken { deviceId }              -> { deviceToken, deviceEncryptionKey }   (before the Google sign-in)
//   initializeUser    { userToken }             -> { challengeId }   or 409 { code: 155106 } when the player already has a wallet
//   listWallets       { userToken }             -> { wallets: [{ id, address, blockchain, accountType, state }] }
//   getTokenBalance   { userToken, walletId }   -> { tokenBalances: [{ amount, symbol, name, tokenAddress, isNative, decimals }] }
// Google users have no PIN: Circle's social login is a sign-in method of its own, and they approve actions on Circle's
// confirmation screen. Nothing here moves money: no transfers, no contract calls (phase 1 is sign-in and wallet only).

export const CIRCLE_BASE_URL = "https://api.circle.com";
/** Arc mainnet in Circle's names (the tutorial uses ARC-TESTNET; Matchup plays on mainnet). */
export const CIRCLE_BLOCKCHAIN = "ARC";
export const ALREADY_INITIALIZED = 155106;

export const CIRCLE_ACTIONS = ["createDeviceToken", "initializeUser", "listWallets", "getTokenBalance"] as const;
export type CircleAction = (typeof CIRCLE_ACTIONS)[number];

export type CircleResult = { status: number; body: Record<string, unknown> };
type Options = { apiKey: string; fetch?: typeof fetch; baseUrl?: string; uuid?: () => string };

const KEY_SHAPE = /^(LIVE|TEST)_API_KEY:[^:\s]+:[^:\s]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (error: string): CircleResult => ({ status: 400, body: { error } });
const text = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** One line for the server log about a failed request: the action, the status, and Circle's error code and message. Built only
 *  from the answer the browser gets (which never holds the key), never from the request's tokens. */
export function describeFailure(input: unknown, status: number, body: Record<string, unknown>): string {
  const action = obj(input)?.action;
  const name = typeof action === "string" && (CIRCLE_ACTIONS as readonly string[]).includes(action) ? action : "(unknown action)";
  const code = typeof body.code === "number" ? body.code : "none";
  const message = typeof body.error === "string" ? body.error : "no message";
  return `[circle] ${name} failed: HTTP ${status}, Circle code ${code}, message "${message}"`;
}

export async function runCircleAction(input: unknown, opts: Options): Promise<CircleResult> {
  const req = obj(input);
  const action = req?.action;
  if (!req || typeof action !== "string" || !(CIRCLE_ACTIONS as readonly string[]).includes(action)) return bad("Unknown action");
  if (!opts.apiKey) return { status: 503, body: { error: "Google sign-in is not set up on this server" } };
  // A Circle key is "LIVE_API_KEY:<id>:<secret>" (or TEST_API_KEY). Without the first part Circle answers only "Invalid credentials".
  if (!KEY_SHAPE.test(opts.apiKey)) {
    return { status: 503, body: { error: "CIRCLE_API_KEY is incomplete: copy the whole key from the Circle console, starting with LIVE_API_KEY: (or TEST_API_KEY:)" } };
  }

  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? CIRCLE_BASE_URL;
  const uuid = opts.uuid ?? (() => crypto.randomUUID());
  const call = async (method: "GET" | "POST", path: string, userToken: string | null, body?: object) => {
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${opts.apiKey}` };
    if (body) headers["content-type"] = "application/json";
    if (userToken) headers["x-user-token"] = userToken;
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    const json = obj(await res.json().catch(() => null));
    return { ok: res.ok, status: res.status, json, data: obj(json?.data) };
  };
  // Circle's error, reduced to its number and message (Circle's status is kept, a 5xx becomes 502). The key is cut out of the
  // message in case Circle ever quotes it back.
  const failed = (r: { status: number; json: Record<string, unknown> | null }): CircleResult => ({
    status: r.status >= 500 ? 502 : r.status,
    body: {
      error: (str(r.json?.message) ?? "Circle request failed").split(opts.apiKey).join("[key]"),
      code: typeof r.json?.code === "number" ? r.json.code : null,
    },
  });

  try {
    switch (action as CircleAction) {
      case "createDeviceToken": {
        const deviceId = text(req.deviceId, 200);
        if (!deviceId) return bad("Missing deviceId");
        const r = await call("POST", "/v1/w3s/users/social/token", null, { idempotencyKey: uuid(), deviceId });
        if (!r.ok) return failed(r);
        const deviceToken = str(r.data?.deviceToken);
        const deviceEncryptionKey = str(r.data?.deviceEncryptionKey);
        if (!deviceToken || !deviceEncryptionKey) return { status: 502, body: { error: "Circle sent no device token" } };
        return { status: 200, body: { deviceToken, deviceEncryptionKey } };
      }
      case "initializeUser": {
        const userToken = text(req.userToken, 8000);
        if (!userToken) return bad("Missing userToken");
        const r = await call("POST", "/v1/w3s/user/initialize", userToken, {
          idempotencyKey: uuid(),
          accountType: "SCA",
          blockchains: [CIRCLE_BLOCKCHAIN],
        });
        if (r.json?.code === ALREADY_INITIALIZED) return { status: 409, body: { error: "Already has a wallet", code: ALREADY_INITIALIZED } };
        if (!r.ok) return failed(r);
        const challengeId = str(r.data?.challengeId);
        if (!challengeId) return { status: 502, body: { error: "Circle sent no challenge" } };
        return { status: 200, body: { challengeId } };
      }
      case "listWallets": {
        const userToken = text(req.userToken, 8000);
        if (!userToken) return bad("Missing userToken");
        const r = await call("GET", "/v1/w3s/wallets", userToken);
        if (!r.ok) return failed(r);
        const list = Array.isArray(r.data?.wallets) ? (r.data.wallets as unknown[]) : [];
        const wallets = list.map(obj).filter((w) => w !== null).map((w) => ({
          id: str(w.id),
          address: str(w.address),
          blockchain: str(w.blockchain),
          accountType: str(w.accountType),
          state: str(w.state),
        }));
        return { status: 200, body: { wallets } };
      }
      case "getTokenBalance": {
        const userToken = text(req.userToken, 8000);
        const walletId = typeof req.walletId === "string" && UUID.test(req.walletId) ? req.walletId : null;
        if (!userToken || !walletId) return bad("Missing userToken or walletId");
        const r = await call("GET", `/v1/w3s/wallets/${walletId}/balances`, userToken);
        if (!r.ok) return failed(r);
        const list = Array.isArray(r.data?.tokenBalances) ? (r.data.tokenBalances as unknown[]) : [];
        const tokenBalances = list.map(obj).filter((b) => b !== null).map((b) => {
          const token = obj(b.token);
          return {
            amount: str(b.amount), // already in whole USDC ("20.5"), not the smallest unit
            symbol: str(token?.symbol),
            name: str(token?.name),
            tokenAddress: str(token?.tokenAddress),
            isNative: token?.isNative === true,
            decimals: typeof token?.decimals === "number" ? token.decimals : null,
          };
        });
        return { status: 200, body: { tokenBalances } };
      }
    }
  } catch {
    return { status: 502, body: { error: "Could not reach Circle" } };
  }
  return bad("Unknown action");
}
