// Server side of "Continue with Google" (Circle user-controlled wallets). Only app/api/circle/route.ts uses this file: it holds
// the Circle API key, which must never reach the browser. The browser sends { action, ...fields } and gets back only the fields
// picked out below, never Circle's raw answer and never the key. Exactly eight actions are accepted:
//   createDeviceToken { deviceId }              -> { deviceToken, deviceEncryptionKey }   (before the Google sign-in)
//   initializeUser    { userToken }             -> { challengeId }   or 409 { code: 155106 } when the player already has a wallet
//                                                  (a new player's wallet is an EOA on ARC)
//   createEoaWallet   { userToken }             -> { challengeId }   an EOA on ARC for a player who already has a wallet
//   listWallets       { userToken }             -> { wallets: [{ id, address, blockchain, accountType, state }] }
//   getTokenBalance   { userToken, walletId }   -> { tokenBalances: [{ amount, symbol, name, tokenAddress, isNative, decimals }] }
//   estimateTransferFee { userToken, walletId, destinationAddress, amount } -> { networkFee }   (Circle's MEDIUM estimate)
//   createTransfer      { userToken, walletId, destinationAddress, amount } -> { challengeId }  (nothing moves until the player
//                                                                              approves it on Circle's confirmation screen)
//   listTransfers       { userToken, walletId } -> { transfers: [{ id, state, txHash, destinationAddress, amounts, errorReason }] }
//   approveArena        { userToken, walletId, amount }  -> { challengeId }   USDC approve(arena, amount), at most 1000 USDC
//   placeCall           { userToken, walletId, marketId, roundIndex, up, amount } -> { challengeId }   the arena's placeCall,
//                                                                              at most the beta limit (10 USDC)
//   claimRounds         { userToken, walletId, marketIds: string[], roundIndexes: string[] } -> { challengeId }   the arena's
//                                                                              claim (one round) or claimMany (2 to 20 rounds)
//   listContractCalls   { userToken, walletId } -> { calls: [{ id, state, txHash, contractAddress, abiFunctionSignature, errorReason }] }
// Google users have no PIN: Circle's social login is a sign-in method of its own, and they approve actions on Circle's
// confirmation screen. Money can only move through createTransfer (USDC on Arc: the server looks up the wallet's own USDC
// token itself and checks the address, amount and balance again) and the arena contract calls above (a claim only pays the
// wallet that sends it: the contract pays msg.sender). For those the server
// fixes the contract (USDC or the Matchup arena on Arc mainnet, from the deployment), the function and the spender itself;
// the browser only supplies checked numbers. No other contract can be called, and nothing is signed.
// Wallets are EOAs (accountType "EOA"): an EOA pays its own network fee in USDC. Phase 1 made smart-contract wallets (SCA);
// on Arc mainnet Circle refuses to send from those without a Gas Station (paymaster) policy (the owner has now set one up
// for them). A player who already has one keeps it (nothing is deleted) and gets an EOA next to it, which is the main wallet.

export const CIRCLE_BASE_URL = "https://api.circle.com";
/** Arc mainnet in Circle's names (the tutorial uses ARC-TESTNET; Matchup plays on mainnet). */
export const CIRCLE_BLOCKCHAIN = "ARC";
/** The wallet type the site makes: pays its own fee in USDC, needs no Gas Station policy */
export const CIRCLE_ACCOUNT_TYPE = "EOA";
export const ALREADY_INITIALIZED = 155106;

export const CIRCLE_ACTIONS = [
  "createDeviceToken",
  "initializeUser",
  "createEoaWallet",
  "listWallets",
  "getTokenBalance",
  "estimateTransferFee",
  "createTransfer",
  "listTransfers",
  "approveArena",
  "placeCall",
  "claimRounds",
  "listContractCalls",
] as const;
/** USDC on Arc (the ERC-20 view of the gas money; the same address on mainnet and testnet) */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";
export type CircleAction = (typeof CIRCLE_ACTIONS)[number];

/** The exact functions the Google wallet may call (Circle's confirmation screen shows these) */
export const APPROVE_SIGNATURE = "approve(address,uint256)";
export const PLACE_CALL_SIGNATURE = "placeCall(uint256,uint256,bool,uint256)";
export const CLAIM_SIGNATURE = "claim(uint256,uint256)";
export const CLAIM_MANY_SIGNATURE = "claimMany(uint256[],uint256[])";
/** The most rounds one claim may hold */
export const MAX_CLAIM_ROUNDS = 20;
/** The largest permission the Google wallet may give the arena (the site asks for 50 by default) */
export const MAX_APPROVAL_MICRO = 1000n * 1_000_000n;
/** The beta limit: at most 10 USDC per wallet per round (the site checks the per-round total; this caps a single call) */
export const MAX_CALL_MICRO = 10n * 1_000_000n;

export type CircleResult = { status: number; body: Record<string, unknown> };
type Options = {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  uuid?: () => string;
  /** The Matchup arena on Arc mainnet and its market ids (from the deployment). Without them contract calls are refused. */
  arena?: string | null;
  marketIds?: number[];
};

const KEY_SHAPE = /^(LIVE|TEST)_API_KEY:[^:\s]+:[^:\s]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
/** Whole USDC, e.g. "1" or "0.5", in micro-USDC; null for anything else. `maxDecimals` 6 for what a player types; Circle's own
 *  balances may have more (the native view), which are cut down to micro-USDC. */
const toMicro = (s: string, maxDecimals = 6): bigint | null => {
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(s);
  if (!m || (m[2] ?? "").length > maxDecimals) return null;
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").slice(0, 6).padEnd(6, "0"));
};
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
          accountType: CIRCLE_ACCOUNT_TYPE,
          blockchains: [CIRCLE_BLOCKCHAIN],
        });
        if (r.json?.code === ALREADY_INITIALIZED) return { status: 409, body: { error: "Already has a wallet", code: ALREADY_INITIALIZED } };
        if (!r.ok) return failed(r);
        const challengeId = str(r.data?.challengeId);
        if (!challengeId) return { status: 502, body: { error: "Circle sent no challenge" } };
        return { status: 200, body: { challengeId } };
      }
      case "createEoaWallet": {
        // Circle's "Create wallets" (POST /v1/w3s/user/wallets): a challenge the player runs in Circle's window. The body is
        // fixed here: always one EOA on ARC; the browser cannot ask for another chain or type.
        const userToken = text(req.userToken, 8000);
        if (!userToken) return bad("Missing userToken");
        const r = await call("POST", "/v1/w3s/user/wallets", userToken, {
          idempotencyKey: uuid(),
          accountType: CIRCLE_ACCOUNT_TYPE,
          blockchains: [CIRCLE_BLOCKCHAIN],
          metadata: [{ name: "Matchup wallet", refId: "matchup-eoa" }],
        });
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
      case "estimateTransferFee":
      case "createTransfer": {
        const userToken = text(req.userToken, 8000);
        const walletId = typeof req.walletId === "string" && UUID.test(req.walletId) ? req.walletId : null;
        if (!userToken || !walletId) return bad("Missing userToken or walletId");
        const destinationAddress = typeof req.destinationAddress === "string" ? req.destinationAddress.trim() : "";
        if (!ADDRESS.test(destinationAddress) || ZERO_ADDRESS.test(destinationAddress)) return bad("Invalid destination address");
        const amount = typeof req.amount === "string" ? req.amount.trim() : "";
        const micro = amount.length <= 22 ? toMicro(amount) : null;
        if (micro === null || micro <= 0n) return bad("Invalid amount");

        // The wallet's own USDC on Arc, looked up here, so the browser can only ever send USDC on Arc
        const b = await call("GET", `/v1/w3s/wallets/${walletId}/balances`, userToken);
        if (!b.ok) return failed(b);
        const usdc = pickArcUsdc(Array.isArray(b.data?.tokenBalances) ? (b.data.tokenBalances as unknown[]) : []);
        if (!usdc) return { status: 400, body: { error: "This wallet has no USDC on Arc yet", code: null } };
        if (usdc.micro !== null && micro > usdc.micro) return { status: 400, body: { error: "More than the wallet's balance", code: null } };

        if (action === "estimateTransferFee") {
          const r = await call("POST", "/v1/w3s/transactions/transfer/estimateFee", userToken, {
            walletId,
            tokenId: usdc.tokenId,
            destinationAddress,
            amounts: [amount],
          });
          if (!r.ok) return failed(r);
          const networkFee = str(obj(r.data?.medium)?.networkFee);
          if (!networkFee) return { status: 502, body: { error: "Circle sent no fee estimate" } };
          return { status: 200, body: { networkFee } };
        }
        const r = await call("POST", "/v1/w3s/user/transactions/transfer", userToken, {
          idempotencyKey: uuid(),
          walletId,
          tokenId: usdc.tokenId,
          destinationAddress,
          amounts: [amount],
          feeLevel: "MEDIUM",
          refId: "matchup-send",
        });
        if (!r.ok) return failed(r);
        const challengeId = str(r.data?.challengeId);
        if (!challengeId) return { status: 502, body: { error: "Circle sent no challenge" } };
        return { status: 200, body: { challengeId } };
      }
      case "listTransfers": {
        const userToken = text(req.userToken, 8000);
        const walletId = typeof req.walletId === "string" && UUID.test(req.walletId) ? req.walletId : null;
        if (!userToken || !walletId) return bad("Missing userToken or walletId");
        const q = new URLSearchParams({ walletIds: walletId, operation: "TRANSFER", txType: "OUTBOUND", pageSize: "10", order: "DESC" });
        const r = await call("GET", `/v1/w3s/transactions?${q}`, userToken);
        if (!r.ok) return failed(r);
        const list = Array.isArray(r.data?.transactions) ? (r.data.transactions as unknown[]) : [];
        const transfers = list.map(obj).filter((t) => t !== null).map((t) => ({
          id: str(t.id),
          state: str(t.state),
          txHash: str(t.txHash),
          destinationAddress: str(t.destinationAddress),
          amounts: Array.isArray(t.amounts) ? t.amounts.filter((a): a is string => typeof a === "string") : [],
          errorReason: str(t.errorReason),
        }));
        return { status: 200, body: { transfers } };
      }
      case "approveArena":
      case "placeCall": {
        const userToken = text(req.userToken, 8000);
        const walletId = typeof req.walletId === "string" && UUID.test(req.walletId) ? req.walletId : null;
        if (!userToken || !walletId) return bad("Missing userToken or walletId");
        const arena = typeof opts.arena === "string" && ADDRESS.test(opts.arena) ? opts.arena : null;
        if (!arena) return { status: 503, body: { error: "Calls from a Google wallet need the Arc mainnet arena, which this server does not have" } };
        const amount = typeof req.amount === "string" ? req.amount.trim() : "";
        const micro = amount.length <= 22 ? toMicro(amount) : null;
        if (micro === null || micro <= 0n) return bad("Invalid amount");

        let contractAddress: string;
        let abiFunctionSignature: string;
        let abiParameters: (string | boolean)[];
        if (action === "approveArena") {
          if (micro > MAX_APPROVAL_MICRO) return bad("Permission too large");
          contractAddress = ARC_USDC;
          abiFunctionSignature = APPROVE_SIGNATURE;
          abiParameters = [arena, micro.toString()];
        } else {
          if (micro > MAX_CALL_MICRO) return bad("More than the beta limit");
          const marketId = typeof req.marketId === "string" && /^\d{1,6}$/.test(req.marketId) ? Number(req.marketId) : null;
          if (marketId === null || !(opts.marketIds ?? []).includes(marketId)) return bad("Unknown market");
          const roundIndex = typeof req.roundIndex === "string" && /^\d{1,12}$/.test(req.roundIndex) ? req.roundIndex : null;
          if (roundIndex === null) return bad("Invalid round");
          if (typeof req.up !== "boolean") return bad("Missing side");
          contractAddress = arena;
          abiFunctionSignature = PLACE_CALL_SIGNATURE;
          abiParameters = [String(marketId), String(BigInt(roundIndex)), req.up, micro.toString()];
        }
        // walletId names the wallet (Circle: walletId and blockchain must not both be sent)
        const r = await call("POST", "/v1/w3s/user/transactions/contractExecution", userToken, {
          idempotencyKey: uuid(),
          walletId,
          contractAddress,
          abiFunctionSignature,
          abiParameters,
          feeLevel: "MEDIUM",
          refId: action === "approveArena" ? "matchup-approve" : "matchup-call",
        });
        if (!r.ok) return failed(r);
        const challengeId = str(r.data?.challengeId);
        if (!challengeId) return { status: 502, body: { error: "Circle sent no challenge" } };
        return { status: 200, body: { challengeId } };
      }
      case "claimRounds": {
        const userToken = text(req.userToken, 8000);
        const walletId = typeof req.walletId === "string" && UUID.test(req.walletId) ? req.walletId : null;
        if (!userToken || !walletId) return bad("Missing userToken or walletId");
        const arena = typeof opts.arena === "string" && ADDRESS.test(opts.arena) ? opts.arena : null;
        if (!arena) return { status: 503, body: { error: "Claims from a Google wallet need the Arc mainnet arena, which this server does not have" } };
        const ms = req.marketIds;
        const rs = req.roundIndexes;
        if (!Array.isArray(ms) || !Array.isArray(rs) || ms.length !== rs.length || ms.length < 1 || ms.length > MAX_CLAIM_ROUNDS) {
          return bad(`Give 1 to ${MAX_CLAIM_ROUNDS} rounds, with one market for each`);
        }
        const markets: string[] = [];
        const rounds: string[] = [];
        const seen = new Set<string>();
        for (let i = 0; i < ms.length; i++) {
          const m = ms[i];
          const r = rs[i];
          if (typeof m !== "string" || !/^\d{1,6}$/.test(m) || !(opts.marketIds ?? []).includes(Number(m))) return bad("Unknown market");
          if (typeof r !== "string" || !/^\d{1,12}$/.test(r)) return bad("Invalid round");
          const key = `${Number(m)}:${BigInt(r)}`;
          if (seen.has(key)) return bad("The same round twice"); // claimMany would revert on the second one anyway
          seen.add(key);
          markets.push(String(Number(m)));
          rounds.push(String(BigInt(r)));
        }
        const single = markets.length === 1;
        const r = await call("POST", "/v1/w3s/user/transactions/contractExecution", userToken, {
          idempotencyKey: uuid(),
          walletId,
          contractAddress: arena,
          abiFunctionSignature: single ? CLAIM_SIGNATURE : CLAIM_MANY_SIGNATURE,
          abiParameters: single ? [markets[0], rounds[0]] : [markets, rounds],
          feeLevel: "MEDIUM",
          refId: "matchup-claim",
        });
        if (!r.ok) return failed(r);
        const challengeId = str(r.data?.challengeId);
        if (!challengeId) return { status: 502, body: { error: "Circle sent no challenge" } };
        return { status: 200, body: { challengeId } };
      }
      case "listContractCalls": {
        const userToken = text(req.userToken, 8000);
        const walletId = typeof req.walletId === "string" && UUID.test(req.walletId) ? req.walletId : null;
        if (!userToken || !walletId) return bad("Missing userToken or walletId");
        const q = new URLSearchParams({ walletIds: walletId, operation: "CONTRACT_EXECUTION", pageSize: "10", order: "DESC" });
        const r = await call("GET", `/v1/w3s/transactions?${q}`, userToken);
        if (!r.ok) return failed(r);
        const list = Array.isArray(r.data?.transactions) ? (r.data.transactions as unknown[]) : [];
        const calls = list.map(obj).filter((t) => t !== null).map((t) => ({
          id: str(t.id),
          state: str(t.state),
          txHash: str(t.txHash),
          contractAddress: str(t.contractAddress),
          abiFunctionSignature: str(t.abiFunctionSignature),
          errorReason: str(t.errorReason),
        }));
        return { status: 200, body: { calls } };
      }
    }
  } catch {
    return { status: 502, body: { error: "Could not reach Circle" } };
  }
  return bad("Unknown action");
}

/** The USDC entry of a Circle balance list on Arc mainnet: the ERC-20 (0x3600…) first, else the native entry (on Arc they are
 *  the same money). Returns Circle's token id (what a transfer names) and the balance in micro-USDC (null if unreadable). */
export function pickArcUsdc(list: unknown[]): { tokenId: string; micro: bigint | null } | null {
  const usdc = list
    .map(obj)
    .filter((b) => b !== null)
    .map((b) => ({ amount: str(b.amount), token: obj(b.token) }))
    .filter(
      ({ token }) =>
        token !== null &&
        token.blockchain === CIRCLE_BLOCKCHAIN &&
        typeof token.id === "string" &&
        token.id.length > 0 &&
        typeof token.symbol === "string" &&
        token.symbol.toUpperCase().startsWith("USDC") &&
        (token.isNative === true || (typeof token.tokenAddress === "string" && token.tokenAddress.toLowerCase() === ARC_USDC)),
    );
  const pick = usdc.find(({ token }) => token?.isNative !== true) ?? usdc[0];
  if (!pick?.token) return null;
  return { tokenId: pick.token.id as string, micro: pick.amount ? toMicro(pick.amount, 18) : null };
}
