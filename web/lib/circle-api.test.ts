// node --test lib/circle-api.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { describeFailure, runCircleAction } from "./circle-api.ts";

const KEY = "TEST_API_KEY:abc:def";
const WALLET = "0b0c0a3e-1111-4222-8333-444455556666";

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

test("only the four actions are accepted; anything else never reaches Circle", async () => {
  const c = fakeCircle(200, { data: {} });
  for (const action of ["createTransfer", "createContractExecutionChallenge", "getUser", "createPinChallenge", "", "__proto__", "toString"]) {
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

test("initializeUser: Arc mainnet (ARC), the player's token as X-User-Token, returns the challenge", async () => {
  const c = fakeCircle(201, { data: { challengeId: "ch-1" } });
  const r = await runCircleAction({ action: "initializeUser", userToken: "ut" }, c.opts);
  assert.deepEqual(r, { status: 200, body: { challengeId: "ch-1" } });
  assert.equal(c.sent[0].url, "https://circle.test/v1/w3s/user/initialize");
  assert.equal(c.sent[0].headers["x-user-token"], "ut");
  assert.deepEqual(c.sent[0].body, { idempotencyKey: "uuid-1", accountType: "SCA", blockchains: ["ARC"] });
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
    { action: "listWallets", userToken: "u" },
    { action: "getTokenBalance", userToken: "u", walletId: WALLET },
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
