// node --test lib/circle-wallet-pick.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import { pickArcWallet, pickUsdc, type CircleBalance } from "./circle-wallet-pick.ts";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const w = (id: string, address: string, blockchain: string, state = "LIVE") => ({ id, address, blockchain, accountType: "SCA", state });
const bal = (amount: string, symbol: string, isNative: boolean): CircleBalance => ({ amount, symbol, name: symbol, tokenAddress: null, isNative, decimals: 6 });

test("pickArcWallet: only an Arc mainnet wallet counts", () => {
  assert.equal(pickArcWallet([]), null);
  assert.equal(pickArcWallet([w("t", A, "ARC-TESTNET"), w("e", B, "ETH")]), null);
  assert.deepEqual(pickArcWallet([w("t", A, "ARC-TESTNET"), w("m", B, "ARC")]), { id: "m", address: B });
  assert.equal(pickArcWallet([w("m", "not-an-address", "ARC")]), null);
  assert.equal(pickArcWallet([w("m", B, "ARC", "FROZEN")]), null);
});

test("pickUsdc: the token entry first, the native one otherwise, 0 when there is none", () => {
  assert.equal(pickUsdc([]), "0");
  assert.equal(pickUsdc([bal("3", "EURC", false)]), "0");
  assert.equal(pickUsdc([bal("12.5", "USDC", true)]), "12.5");
  assert.equal(pickUsdc([bal("12.5", "USDC", true), bal("12.5", "USDC", false)]), "12.5");
  assert.equal(pickUsdc([bal("1", "USDC", true), bal("2", "USDC", false)]), "2");
});
