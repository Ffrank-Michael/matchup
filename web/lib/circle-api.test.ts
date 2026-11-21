// node --test lib/circle-api.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { describeFailure, runCircleAction } from "./circle-api.ts";

const KEY = "TEST_API_KEY:abc:def";
const WALLET = "0b0c0a3e-1111-4222-8333-444455556666";
const TO = "0x1111111111111111111111111111111111111111";
const TOKEN = "7adb2b7d-c9cd-4d0d-9e6b-111111111111";

type Sent = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };

/** A fake Circle: records every request and answers with the given status and JSON. */
function fakeCircle(status: number, json: unknown) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof globalThis.fetch;
  return { sent, opts: { apiKey: KEY, fetch, baseUrl: "https://circle.test", uuid: () => "uuid-1" } };
}

test("only the twelve actions are accepted; anything else never reaches Circle", async () => {
  const c = fakeCircle(200, { data: {} });
  for (const action of ["createContractExecution", "createContractExecutionChallenge", "signMessage", "createTransaction", "accelerateTransaction", "getUser", "createPinChallenge", "", "__proto__", "toString"]) {
    const r = await runCircleAction({ action, userToken: "t" }, c.opts);
    assert.equal(r.status, 400, action);
  }
  for (const input of [null, "createDeviceToken", [], { action: 1 }]) {
    assert.equal((await runCircleAction(input, c.opts)).status, 400);
  }
  assert.equal(c.sent.length, 0);
});

test("without an API key the route says it is not set up and calls nothing", async () => {
  const c = fakeCircle(200, { data: {} });
  const r = await runCircleAction({ action: "listWallets", userToken: "t" }, { ...c.opts, apiKey: "" });
  assert.equal(r.status, 503);
  assert.equal(c.sent.length, 0);
});

test("a key without its LIVE_API_KEY:/TEST_API_KEY: start is caught here, with a clear message, and calls nothing", async () => {
  const c = fakeCircle(200, { data: {} });
  for (const apiKey of ["abc:def", "LIVE_API_KEY:abc", "KEY:abc:def", "LIVE_API_KEY:abc:def "]) {
    const r = await runCircleAction({ action: "createDeviceToken", deviceId: "d" }, { ...c.opts, apiKey });
    assert.equal(r.status, 503, apiKey);
    assert.match(String(r.body.error), /CIRCLE_API_KEY is incomplete/);
    assert.ok(!JSON.stringify(r).includes(apiKey.trim()), "the message never quotes the key");
  }
  assert.equal(c.sent.length, 0);
  const ok = await runCircleAction({ action: "createDeviceToken", deviceId: "d" }, { ...c.opts, apiKey: "LIVE_API_KEY:abc:def" });
  assert.notEqual(ok.status, 503);
});

test("createDeviceToken: sends the key only as a header and returns only the two device fields", async () => {
  const c = fakeCircle(201, { data: { deviceToken: "dt", deviceEncryptionKey: "dek", extra: "x" } });
  const r = await runCircleAction({ action: "createDeviceToken", deviceId: "dev-1" }, c.opts);
  assert.deepEqual(r, { status: 200, body: { deviceToken: "dt", deviceEncryptionKey: "dek" } });
  assert.equal(c.sent[0].url, "https://circle.test/v1/w3s/users/social/token");
  assert.equal(c.sent[0].method, "POST");
  assert.equal(c.sent[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(c.sent[0].body, { idempotencyKey: "uuid-1", deviceId: "dev-1" });
  assert.equal((await runCircleAction({ action: "createDeviceToken" }, c.opts)).status, 400);
});

test("initializeUser: an EOA on Arc mainnet (ARC), the player's token as X-User-Token, returns the challenge", async () => {
  const c = fakeCircle(201, { data: { challengeId: "ch-1" } });
  const r = await runCircleAction({ action: "initializeUser", userToken: "ut" }, c.opts);
  assert.deepEqual(r, { status: 200, body: { challengeId: "ch-1" } });
  assert.equal(c.sent[0].url, "https://circle.test/v1/w3s/user/initialize");
  assert.equal(c.sent[0].headers["x-user-token"], "ut");
  assert.deepEqual(c.sent[0].body, { idempotencyKey: "uuid-1", accountType: "EOA", blockchains: ["ARC"] });
});

test("initializeUser: 155106 (already has a wallet) comes back as 409 with the code", async () => {
  const c = fakeCircle(400, { code: 155106, message: "user already initialized" });
  const r = await runCircleAction({ action: "initializeUser", userToken: "ut" }, c.opts);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 155106);
});

test("listWallets: only the listed wallet fields leave the server", async () => {
  const c = fakeCircle(200, {
    data: { wallets: [{ id: WALLET, address: "0xabc", blockchain: "ARC", accountType: "SCA", state: "LIVE", userId: "secret-user", custodyType: "ENDUSER" }] },
  });
  const r = await runCircleAction({ action: "listWallets", userToken: "ut" }, c.opts);
  assert.deepEqual(r.body, { wallets: [{ id: WALLET, address: "0xabc", blockchain: "ARC", accountType: "SCA", state: "LIVE" }] });
  assert.equal(c.sent[0].method, "GET");
  assert.equal(c.sent[0].body, null);
});

test("getTokenBalance: needs a real wallet id (no path tricks) and returns plain balances", async () => {
  const c = fakeCircle(200, {
    data: { tokenBalances: [{ amount: "12.5", updateDate: "x", token: { symbol: "USDC", name: "USDC", tokenAddress: "0x36", isNative: false, decimals: 6, id: "tok" } }] },
  });
  for (const walletId of [undefined, "../users", `${WALLET}/../../x`, "abc"]) {
    assert.equal((await runCircleAction({ action: "getTokenBalance", userToken: "ut", walletId }, c.opts)).status, 400);
  }
  assert.equal(c.sent.length, 0);
  const r = await runCircleAction({ action: "getTokenBalance", userToken: "ut", walletId: WALLET }, c.opts);
  assert.equal(c.sent[0].url, `https://circle.test/v1/w3s/wallets/${WALLET}/balances`);
  assert.deepEqual(r.body, { tokenBalances: [{ amount: "12.5", symbol: "USDC", name: "USDC", tokenAddress: "0x36", isNative: false, decimals: 6 }] });
});

test("Circle errors pass on only their code and message; a 5xx becomes 502; a network error is caught", async () => {
  const c = fakeCircle(401, { code: 155104, message: "Invalid user token", stack: "internal" });
  assert.deepEqual(await runCircleAction({ action: "listWallets", userToken: "ut" }, c.opts), {
    status: 401,
    body: { error: "Invalid user token", code: 155104 },
  });
  const down = fakeCircle(503, "not json");
  assert.equal((await runCircleAction({ action: "listWallets", userToken: "ut" }, down.opts)).status, 502);
  const broken = { apiKey: KEY, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch };
  assert.equal((await runCircleAction({ action: "listWallets", userToken: "ut" }, broken)).status, 502);
});

test("the API key never appears in any answer, even when Circle quotes it in an error", async () => {
  const cases = [
    { action: "createDeviceToken", deviceId: "d" },
    { action: "initializeUser", userToken: "u" },
    { action: "createEoaWallet", userToken: "u" },
    { action: "listWallets", userToken: "u" },
    { action: "getTokenBalance", userToken: "u", walletId: WALLET },
    { action: "estimateTransferFee", userToken: "u", walletId: WALLET, destinationAddress: TO, amount: "1" },
    { action: "createTransfer", userToken: "u", walletId: WALLET, destinationAddress: TO, amount: "1" },
    { action: "listTransfers", userToken: "u", walletId: WALLET },
    { action: "approveArena", userToken: "u", walletId: WALLET, amount: "50" },
    { action: "placeCall", userToken: "u", walletId: WALLET, marketId: "0", roundIndex: "1", up: true, amount: "1" },
    { action: "listContractCalls", userToken: "u", walletId: WALLET },
    { action: "claimRounds", userToken: "u", walletId: WALLET, marketIds: ["0"], roundIndexes: ["1"] },
    { action: "nope" },
  ];
  const ok = fakeCircle(200, { data: { deviceToken: "dt", deviceEncryptionKey: "k", challengeId: "c", wallets: [], tokenBalances: [] } });
  const echo = fakeCircle(400, { code: 1, message: `bad key ${KEY}` });
  for (const input of cases) {
    for (const opts of [ok.opts, echo.opts]) {
      const r = await runCircleAction(input, opts);
      assert.ok(!JSON.stringify(r).includes(KEY), `${input.action} leaked the key`);
    }
  }
});

test("describeFailure: names the action, status, Circle code and message, and nothing from the request", () => {
  const line = describeFailure({ action: "createDeviceToken", deviceId: "secret-device" }, 401, { error: "Invalid credentials.", code: 401 });
  assert.equal(line, '[circle] createDeviceToken failed: HTTP 401, Circle code 401, message "Invalid credentials."');
  assert.equal(describeFailure({ action: "evil", userToken: "tok" }, 400, { error: "Unknown action" }), '[circle] (unknown action) failed: HTTP 400, Circle code none, message "Unknown action"');
});

// ── Send USDC ───────────────────────────────────────────────

/** A fake Circle that answers by path: the wallet's balances, a fee estimate, a transfer challenge, the transfer list. */
function routedCircle(over: { balances?: unknown; balanceStatus?: number; transfer?: [number, unknown]; estimate?: [number, unknown]; list?: unknown } = {}) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    sent.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body });
    const path = new URL(url).pathname;
    const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
    if (path.endsWith("/balances")) return reply(over.balanceStatus ?? 200, { data: { tokenBalances: over.balances ?? [usdcEntry("5")] } });
    if (path === "/v1/w3s/transactions/transfer/estimateFee") {
      return reply(...(over.estimate ?? [200, { data: { low: { networkFee: "0.001" }, medium: { networkFee: "0.002", gasLimit: "1" } } }]));
    }
    if (path === "/v1/w3s/user/transactions/transfer") return reply(...(over.transfer ?? [201, { data: { challengeId: "ch-send" } }]));
    if (path === "/v1/w3s/transactions") return reply(200, over.list ?? { data: { transactions: [] } });
    return reply(404, { message: "no route" });
  }) as unknown as typeof globalThis.fetch;
  return { sent, opts: { apiKey: KEY, fetch, baseUrl: "https://circle.test", uuid: () => "uuid-9" } };
}
function usdcEntry(amount: string, extra: Record<string, unknown> = {}) {
  return {
    amount,
    token: { id: TOKEN, blockchain: "ARC", symbol: "USDC", name: "USDC", tokenAddress: "0x3600000000000000000000000000000000000000", isNative: false, decimals: 6, ...extra },
  };
}
const sendReq = (over: Record<string, unknown> = {}) => ({ action: "createTransfer", userToken: "ut", walletId: WALLET, destinationAddress: TO, amount: "1", ...over });
const bodyOf = (s: Sent) => s.body as Record<string, unknown>;

test("createTransfer: looks up the wallet's own USDC, then asks Circle for a challenge naming only that token", async () => {
  const c = routedCircle();
  const r = await runCircleAction(sendReq({ amount: " 1.5 " }), c.opts);
  assert.deepEqual(r, { status: 200, body: { challengeId: "ch-send" } });
  assert.equal(c.sent.length, 2);
  assert.equal(c.sent[0].url, `https://circle.test/v1/w3s/wallets/${WALLET}/balances`);
  assert.equal(c.sent[1].url, "https://circle.test/v1/w3s/user/transactions/transfer");
  assert.equal(c.sent[1].method, "POST");
  assert.equal(c.sent[1].headers["x-user-token"], "ut");
  assert.equal(c.sent[1].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(c.sent[1].body, {
    idempotencyKey: "uuid-9",
    walletId: WALLET,
    tokenId: TOKEN,
    destinationAddress: TO,
    amounts: ["1.5"],
    feeLevel: "MEDIUM",
    refId: "matchup-send",
  });
});

test("createTransfer: the browser cannot choose the token, chain or fee; extra fields are ignored", async () => {
  const c = routedCircle();
  await runCircleAction(sendReq({ tokenId: "evil", tokenAddress: "0xevil", blockchain: "ETH", feeLevel: "HIGH", gasLimit: "9", maxFee: "9" }), c.opts);
  const b = bodyOf(c.sent[1]);
  assert.equal(b.tokenId, TOKEN);
  assert.equal(b.feeLevel, "MEDIUM");
  for (const k of ["tokenAddress", "blockchain", "gasLimit", "maxFee"]) assert.ok(!(k in b), k);
});

test("createTransfer: bad addresses, amounts and wallet ids are refused before Circle is asked", async () => {
  const c = routedCircle();
  const bad: Record<string, unknown>[] = [
    { destinationAddress: "" },
    { destinationAddress: "0x123" },
    { destinationAddress: "0x0000000000000000000000000000000000000000" },
    { destinationAddress: `${TO}00` },
    { destinationAddress: "1111111111111111111111111111111111111111" },
    { amount: "0" },
    { amount: "0.000000" },
    { amount: "-1" },
    { amount: "1e3" },
    { amount: "0.0000001" },
    { amount: "abc" },
    { amount: 1 },
    { amount: "" },
    { walletId: "../x" },
    { userToken: "" },
  ];
  for (const over of bad) assert.equal((await runCircleAction(sendReq(over), c.opts)).status, 400, JSON.stringify(over));
  assert.equal(c.sent.length, 0);
});

test("createTransfer: more than the balance, or a wallet with no USDC on Arc, is refused without a challenge", async () => {
  const more = routedCircle();
  assert.equal((await runCircleAction(sendReq({ amount: "5.000001" }), more.opts)).status, 400);
  assert.equal(more.sent.length, 1, "only the balance was read");
  assert.equal((await runCircleAction(sendReq({ amount: "5" }), routedCircle().opts)).status, 200, "the whole balance passes here; Circle checks the fee");

  const otherChain = routedCircle({ balances: [usdcEntry("9", { blockchain: "ETH" })] });
  assert.equal((await runCircleAction(sendReq(), otherChain.opts)).status, 400);
  const lookalike = routedCircle({ balances: [usdcEntry("9", { tokenAddress: "0x9999999999999999999999999999999999999999" })] });
  assert.equal((await runCircleAction(sendReq(), lookalike.opts)).status, 400, "a token merely named USDC is not USDC");
  assert.equal(otherChain.sent.length + lookalike.sent.length, 2, "no challenge was asked for");
});

test("createTransfer: the native USDC entry is used when it is the only one; the ERC-20 entry wins when both exist", async () => {
  const nativeOnly = routedCircle({ balances: [usdcEntry("3.123456789012345678", { id: "native-id", isNative: true, tokenAddress: "" })] });
  assert.equal((await runCircleAction(sendReq({ amount: "3.123456" }), nativeOnly.opts)).status, 200);
  assert.equal(bodyOf(nativeOnly.sent[1]).tokenId, "native-id");
  const both = routedCircle({ balances: [usdcEntry("3", { id: "native-id", isNative: true, tokenAddress: "" }), usdcEntry("3")] });
  await runCircleAction(sendReq(), both.opts);
  assert.equal(bodyOf(both.sent[1]).tokenId, TOKEN);
});

test("createTransfer: Circle's refusal passes on its code (for the plain-word message); an expired token keeps its status", async () => {
  const low = routedCircle({ transfer: [400, { code: 155258, message: "insufficient" }] });
  assert.deepEqual(await runCircleAction(sendReq(), low.opts), { status: 400, body: { error: "insufficient", code: 155258 } });
  const exp = routedCircle({ balanceStatus: 403 });
  assert.equal((await runCircleAction(sendReq(), exp.opts)).status, 403);
});

test("estimateTransferFee: Circle's MEDIUM network fee only, for the wallet's USDC", async () => {
  const c = routedCircle();
  const r = await runCircleAction(sendReq({ action: "estimateTransferFee", amount: "0.01" }), c.opts);
  assert.deepEqual(r, { status: 200, body: { networkFee: "0.002" } });
  assert.equal(c.sent[1].url, "https://circle.test/v1/w3s/transactions/transfer/estimateFee");
  assert.equal(c.sent[1].headers["x-user-token"], "ut");
  assert.deepEqual(c.sent[1].body, { walletId: WALLET, tokenId: TOKEN, destinationAddress: TO, amounts: ["0.01"] });
  const none = routedCircle({ estimate: [200, { data: {} }] });
  assert.equal((await runCircleAction(sendReq({ action: "estimateTransferFee" }), none.opts)).status, 502);
});

test("listTransfers: this wallet's outgoing transfers only, and only the listed fields leave the server", async () => {
  const c = routedCircle({
    list: {
      data: {
        transactions: [
          { id: "t1", state: "COMPLETE", txHash: "0xabc", destinationAddress: TO, amounts: ["1"], errorReason: null, userId: "secret", sourceAddress: "0xme", networkFee: "0.002" },
        ],
      },
    },
  });
  const r = await runCircleAction({ action: "listTransfers", userToken: "ut", walletId: WALLET }, c.opts);
  assert.deepEqual(r.body, { transfers: [{ id: "t1", state: "COMPLETE", txHash: "0xabc", destinationAddress: TO, amounts: ["1"], errorReason: null }] });
  const url = new URL(c.sent[0].url);
  assert.equal(url.pathname, "/v1/w3s/transactions");
  assert.equal(url.searchParams.get("walletIds"), WALLET);
  assert.equal(url.searchParams.get("txType"), "OUTBOUND");
  assert.equal(url.searchParams.get("operation"), "TRANSFER");
  assert.equal(c.sent[0].headers["x-user-token"], "ut");
  assert.equal((await runCircleAction({ action: "listTransfers", userToken: "ut", walletId: "x&walletIds=other" }, c.opts)).status, 400);
});

test("describeFailure never includes the user token, address or amount of a send", () => {
  const line = describeFailure(sendReq({ userToken: "very-secret-token" }), 400, { error: "insufficient", code: 155258 });
  assert.ok(!line.includes("very-secret-token"));
  assert.ok(!line.includes(TO));
  assert.equal(line, '[circle] createTransfer failed: HTTP 400, Circle code 155258, message "insufficient"');
});

// ── EOA wallets ─────────────────────────────────────────────

test("createEoaWallet: always one EOA on ARC, via Circle's Create wallets challenge; the browser cannot change it", async () => {
  const c = fakeCircle(201, { data: { challengeId: "ch-eoa" } });
  const r = await runCircleAction({ action: "createEoaWallet", userToken: "ut", accountType: "SCA", blockchains: ["ETH"], metadata: "x" }, c.opts);
  assert.deepEqual(r, { status: 200, body: { challengeId: "ch-eoa" } });
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].url, "https://circle.test/v1/w3s/user/wallets");
  assert.equal(c.sent[0].method, "POST");
  assert.equal(c.sent[0].headers["x-user-token"], "ut");
  assert.deepEqual(c.sent[0].body, {
    idempotencyKey: "uuid-1",
    accountType: "EOA",
    blockchains: ["ARC"],
    metadata: [{ name: "Matchup wallet", refId: "matchup-eoa" }],
  });
});

test("createEoaWallet: needs the player's token; Circle's refusal passes on its code; no challenge is a 502", async () => {
  const c = fakeCircle(201, { data: { challengeId: "ch-eoa" } });
  assert.equal((await runCircleAction({ action: "createEoaWallet" }, c.opts)).status, 400);
  assert.equal((await runCircleAction({ action: "createEoaWallet", userToken: "" }, c.opts)).status, 400);
  assert.equal(c.sent.length, 0);
  const refused = fakeCircle(400, { code: 155501, message: "wallet error" });
  assert.deepEqual(await runCircleAction({ action: "createEoaWallet", userToken: "ut" }, refused.opts), { status: 400, body: { error: "wallet error", code: 155501 } });
  const empty = fakeCircle(201, { data: {} });
  assert.equal((await runCircleAction({ action: "createEoaWallet", userToken: "ut" }, empty.opts)).status, 502);
});

test("no action asks Circle for an SCA any more", async () => {
  for (const input of [{ action: "initializeUser", userToken: "ut" }, { action: "createEoaWallet", userToken: "ut" }]) {
    const c = fakeCircle(201, { data: { challengeId: "c" } });
    await runCircleAction(input, c.opts);
    assert.ok(!JSON.stringify(c.sent).includes("SCA"), input.action);
  }
});

// ── Contract calls (approve USDC for the arena, placeCall) ──────────────

const ARENA = "0xaebac196c76a2c9338a30aef663e4799ffa0d364";
const callOpts = (c: ReturnType<typeof fakeCircle>, over: Record<string, unknown> = {}) => ({ ...c.opts, arena: ARENA, marketIds: [0, 1, 2, 11], ...over });
const placeReq = (over: Record<string, unknown> = {}) => ({
  action: "placeCall",
  userToken: "ut",
  walletId: WALLET,
  marketId: "2",
  roundIndex: "5901234",
  up: true,
  amount: "1.5",
  ...over,
});

test("approveArena: USDC approve(arena, amount) only; the spender is always the arena from the deployment", async () => {
  const c = fakeCircle(201, { data: { challengeId: "ch-ap" } });
  const r = await runCircleAction({ action: "approveArena", userToken: "ut", walletId: WALLET, amount: "50", spender: "0x9999999999999999999999999999999999999999", contractAddress: "0xevil" }, callOpts(c));
  assert.deepEqual(r, { status: 200, body: { challengeId: "ch-ap" } });
  assert.equal(c.sent[0].url, "https://circle.test/v1/w3s/user/transactions/contractExecution");
  assert.equal(c.sent[0].method, "POST");
  assert.equal(c.sent[0].headers["x-user-token"], "ut");
  assert.deepEqual(c.sent[0].body, {
    idempotencyKey: "uuid-1",
    walletId: WALLET,
    contractAddress: "0x3600000000000000000000000000000000000000",
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [ARENA, "50000000"],
    feeLevel: "MEDIUM",
    refId: "matchup-approve",
  });
});

test("approveArena: the permission must be above 0 and at most 1000 USDC", async () => {
  const c = fakeCircle(201, { data: { challengeId: "x" } });
  for (const amount of ["0", "1000.000001", "abc", "", "-5", 50]) {
    assert.equal((await runCircleAction({ action: "approveArena", userToken: "ut", walletId: WALLET, amount }, callOpts(c))).status, 400, String(amount));
  }
  assert.equal(c.sent.length, 0);
  assert.equal((await runCircleAction({ action: "approveArena", userToken: "ut", walletId: WALLET, amount: "1000" }, callOpts(c))).status, 200);
});

test("placeCall: the arena's placeCall with checked numbers; the browser cannot pick the contract or function", async () => {
  const c = fakeCircle(201, { data: { challengeId: "ch-call" } });
  const r = await runCircleAction(placeReq({ contractAddress: "0xevil", abiFunctionSignature: "transferFrom(address,address,uint256)" }), callOpts(c));
  assert.deepEqual(r, { status: 200, body: { challengeId: "ch-call" } });
  assert.deepEqual(c.sent[0].body, {
    idempotencyKey: "uuid-1",
    walletId: WALLET,
    contractAddress: ARENA,
    abiFunctionSignature: "placeCall(uint256,uint256,bool,uint256)",
    abiParameters: ["2", "5901234", true, "1500000"],
    feeLevel: "MEDIUM",
    refId: "matchup-call",
  });
  const down = fakeCircle(201, { data: { challengeId: "d" } });
  await runCircleAction(placeReq({ up: false, roundIndex: "007" }), callOpts(down));
  assert.deepEqual((down.sent[0].body as Record<string, unknown>).abiParameters, ["2", "7", false, "1500000"]);
});

test("placeCall: unknown markets, bad rounds, a missing side and amounts over the beta limit are refused before Circle", async () => {
  const c = fakeCircle(201, { data: { challengeId: "x" } });
  const bad: Record<string, unknown>[] = [
    { marketId: "3" },
    { marketId: 2 },
    { marketId: "-1" },
    { marketId: "1e2" },
    { roundIndex: "" },
    { roundIndex: "1.5" },
    { roundIndex: "-3" },
    { roundIndex: 12 },
    { up: "true" },
    { up: undefined },
    { amount: "10.000001" },
    { amount: "0" },
    { amount: "1.0000001" },
    { walletId: "x" },
    { userToken: "" },
  ];
  for (const over of bad) assert.equal((await runCircleAction(placeReq(over), callOpts(c))).status, 400, JSON.stringify(over));
  assert.equal(c.sent.length, 0);
  assert.equal((await runCircleAction(placeReq({ amount: "10" }), callOpts(c))).status, 200, "exactly the beta limit is allowed");
});

test("contract calls are refused when the server has no Arc mainnet arena (a testnet build)", async () => {
  const c = fakeCircle(201, { data: { challengeId: "x" } });
  for (const input of [placeReq(), { action: "approveArena", userToken: "ut", walletId: WALLET, amount: "50" }]) {
    assert.equal((await runCircleAction(input, { ...c.opts, arena: null, marketIds: [] })).status, 503);
    assert.equal((await runCircleAction(input, c.opts)).status, 503);
  }
  assert.equal(c.sent.length, 0);
});

test("contract calls: Circle's refusal passes on its code and message", async () => {
  const c = fakeCircle(400, { code: 155258, message: "insufficient" });
  assert.deepEqual(await runCircleAction(placeReq(), callOpts(c)), { status: 400, body: { error: "insufficient", code: 155258 } });
});

test("listContractCalls: this wallet's contract executions only, with the listed fields", async () => {
  const c = fakeCircle(200, {
    data: {
      transactions: [
        { id: "t1", state: "COMPLETE", txHash: "0xabc", contractAddress: ARENA, abiFunctionSignature: "placeCall(uint256,uint256,bool,uint256)", abiParameters: ["1"], userId: "secret", errorReason: null },
      ],
    },
  });
  const r = await runCircleAction({ action: "listContractCalls", userToken: "ut", walletId: WALLET }, c.opts);
  assert.deepEqual(r.body, {
    calls: [{ id: "t1", state: "COMPLETE", txHash: "0xabc", contractAddress: ARENA, abiFunctionSignature: "placeCall(uint256,uint256,bool,uint256)", errorReason: null }],
  });
  const url = new URL(c.sent[0].url);
  assert.equal(url.pathname, "/v1/w3s/transactions");
  assert.equal(url.searchParams.get("walletIds"), WALLET);
  assert.equal(url.searchParams.get("operation"), "CONTRACT_EXECUTION");
  assert.equal((await runCircleAction({ action: "listContractCalls", userToken: "ut", walletId: "bad" }, c.opts)).status, 400);
});

// ── Claims from the Google wallet ───────────────────────────

const claimReq = (marketIds: unknown, roundIndexes: unknown, over: Record<string, unknown> = {}) => ({
  action: "claimRounds",
  userToken: "ut",
  walletId: WALLET,
  marketIds,
  roundIndexes,
  ...over,
});

test("claimRounds: one round is the arena's claim(market, round)", async () => {
  const c = fakeCircle(201, { data: { challengeId: "ch-claim" } });
  const r = await runCircleAction(claimReq(["2"], ["5901234"], { contractAddress: "0xevil", abiFunctionSignature: "withdrawFees(address,uint256)" }), callOpts(c));
  assert.deepEqual(r, { status: 200, body: { challengeId: "ch-claim" } });
  assert.equal(c.sent[0].url, "https://circle.test/v1/w3s/user/transactions/contractExecution");
  assert.equal(c.sent[0].headers["x-user-token"], "ut");
  assert.deepEqual(c.sent[0].body, {
    idempotencyKey: "uuid-1",
    walletId: WALLET,
    contractAddress: ARENA,
    abiFunctionSignature: "claim(uint256,uint256)",
    abiParameters: ["2", "5901234"],
    feeLevel: "MEDIUM",
    refId: "matchup-claim",
  });
});

test("claimRounds: several rounds are one claimMany([markets], [rounds]), in the same order", async () => {
  const c = fakeCircle(201, { data: { challengeId: "ch-many" } });
  await runCircleAction(claimReq(["0", "11", "2"], ["10", "007", "30"]), callOpts(c));
  const b = c.sent[0].body as Record<string, unknown>;
  assert.equal(b.abiFunctionSignature, "claimMany(uint256[],uint256[])");
  assert.deepEqual(b.abiParameters, [["0", "11", "2"], ["10", "7", "30"]]);
  assert.equal(b.contractAddress, ARENA);
});

test("claimRounds: bad lists, unknown markets, repeated rounds and more than 20 rounds are refused before Circle", async () => {
  const c = fakeCircle(201, { data: { challengeId: "x" } });
  const many = Array.from({ length: 21 }, (_, i) => String(i));
  const bad = [
    claimReq([], []),
    claimReq(["0"], []),
    claimReq(["0", "1"], ["5"]),
    claimReq("0", "5"),
    claimReq(["3"], ["5"]),
    claimReq([0], ["5"]),
    claimReq(["0"], [5]),
    claimReq(["0"], ["-5"]),
    claimReq(["0"], ["1.5"]),
    claimReq(["0", "0"], ["5", "05"]),
    claimReq(many.map(() => "0"), many),
    claimReq(["0"], ["5"], { walletId: "x" }),
    claimReq(["0"], ["5"], { userToken: "" }),
  ];
  for (const input of bad) assert.equal((await runCircleAction(input, callOpts(c))).status, 400, JSON.stringify(input));
  assert.equal(c.sent.length, 0);
  const twenty = many.slice(0, 20);
  assert.equal((await runCircleAction(claimReq(twenty.map(() => "1"), twenty), callOpts(c))).status, 200, "exactly 20 rounds is allowed");
});

test("claimRounds: refused when the server has no Arc mainnet arena", async () => {
  const c = fakeCircle(201, { data: { challengeId: "x" } });
  assert.equal((await runCircleAction(claimReq(["0"], ["5"]), { ...c.opts, arena: null, marketIds: [] })).status, 503);
  assert.equal(c.sent.length, 0);
});
