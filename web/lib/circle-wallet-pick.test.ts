// node --test lib/circle-wallet-pick.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { pickArcWallets, pickUsdc, walletStep, type CircleBalance } from "./circle-wallet-pick.ts";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const w = (id: string, address: string, blockchain: string, accountType = "EOA", state = "LIVE") => ({ id, address, blockchain, accountType, state });
const bal = (amount: string, symbol: string, isNative: boolean): CircleBalance => ({ amount, symbol, name: symbol, tokenAddress: null, isNative, decimals: 6 });

test("pickArcWallets: only live Arc mainnet wallets with a real address count", () => {
  assert.deepEqual(pickArcWallets([]), { eoa: null, sca: null });
  assert.deepEqual(pickArcWallets([w("t", A, "ARC-TESTNET"), w("e", B, "ETH")]), { eoa: null, sca: null });
  assert.deepEqual(pickArcWallets([w("t", A, "ARC-TESTNET"), w("m", B, "ARC")]), { eoa: { id: "m", address: B }, sca: null });
  assert.deepEqual(pickArcWallets([w("m", "not-an-address", "ARC")]), { eoa: null, sca: null });
  assert.deepEqual(pickArcWallets([w("m", B, "ARC", "EOA", "FROZEN")]), { eoa: null, sca: null });
  assert.deepEqual(pickArcWallets([w("", B, "ARC")]), { eoa: null, sca: null });
});

test("pickArcWallets: a new player has only an EOA; it is the one used", () => {
  assert.deepEqual(pickArcWallets([w("e", A, "ARC", "EOA")]), { eoa: { id: "e", address: A }, sca: null });
});

test("pickArcWallets: the old SCA is found on its own, and kept next to the EOA when both exist (the EOA is always the one used)", () => {
  assert.deepEqual(pickArcWallets([w("s", A, "ARC", "SCA")]), { eoa: null, sca: { id: "s", address: A } });
  const both = { eoa: { id: "e", address: B }, sca: { id: "s", address: A } };
  assert.deepEqual(pickArcWallets([w("s", A, "ARC", "SCA"), w("e", B, "ARC", "EOA")]), both, "SCA listed first");
  assert.deepEqual(pickArcWallets([w("e", B, "ARC", "EOA"), w("s", A, "ARC", "SCA")]), both, "EOA listed first");
  assert.deepEqual(pickArcWallets([w("x", C, "ARC", null as unknown as string)]), { eoa: null, sca: null }, "an unknown type is not guessed");
});

test("walletStep: use the EOA; make one (once) when only the SCA exists; otherwise wait for Circle", () => {
  const eoa = { id: "e", address: B as `0x${string}` };
  const sca = { id: "s", address: A as `0x${string}` };
  assert.equal(walletStep({ eoa, sca: null }, false), "use");
  assert.equal(walletStep({ eoa, sca }, false), "use", "both: the EOA, no new wallet");
  assert.equal(walletStep({ eoa, sca }, true), "use");
  assert.equal(walletStep({ eoa: null, sca }, false), "create", "the test user: SCA only");
  assert.equal(walletStep({ eoa: null, sca }, true), "wait", "already asked for: never a second EOA in the same load");
  assert.equal(walletStep({ eoa: null, sca: null }, false), "wait", "a new player's wallet is still being made");
});

test("pickUsdc: the token entry first, the native one otherwise, 0 when there is none", () => {
  assert.equal(pickUsdc([]), "0");
  assert.equal(pickUsdc([bal("3", "EURC", false)]), "0");
  assert.equal(pickUsdc([bal("12.5", "USDC", true)]), "12.5");
  assert.equal(pickUsdc([bal("12.5", "USDC", true), bal("12.5", "USDC", false)]), "12.5");
  assert.equal(pickUsdc([bal("1", "USDC", true), bal("2", "USDC", false)]), "2");
});
