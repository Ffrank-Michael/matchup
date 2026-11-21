// node --test lib/circle-calls.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import {
  APPROVE_SIGNATURE,
  CLAIM_MANY_SIGNATURE,
  CLAIM_SIGNATURE,
  GOOGLE_MIN_SECONDS_LEFT,
  MAX_CLAIM_ROUNDS,
  claimSignature,
  PLACE_CALL_SIGNATURE,
  findNewContractCall,
  lockTimeProblem,
  microToUsdc,
  pickPlayer,
  type ContractCall,
} from "./circle-calls.ts";
import {
  APPROVE_SIGNATURE as SERVER_APPROVE,
  CLAIM_MANY_SIGNATURE as SERVER_CLAIM_MANY,
  CLAIM_SIGNATURE as SERVER_CLAIM,
  MAX_CLAIM_ROUNDS as SERVER_MAX_CLAIM_ROUNDS,
  PLACE_CALL_SIGNATURE as SERVER_PLACE_CALL,
} from "./circle-api.ts";

const ARENA = "0xaebac196c76a2c9338a30aef663e4799ffa0d364";
const USDC = "0x3600000000000000000000000000000000000000";
const BROWSER = "0x1111111111111111111111111111111111111111";
const GOOGLE = "0x2222222222222222222222222222222222222222";

test("the browser and the server look for and build the same two functions", () => {
  assert.equal(APPROVE_SIGNATURE, SERVER_APPROVE);
  assert.equal(PLACE_CALL_SIGNATURE, SERVER_PLACE_CALL);
  assert.equal(PLACE_CALL_SIGNATURE, "placeCall(uint256,uint256,bool,uint256)");
});

test("pickPlayer: a browser wallet first; the Google wallet only on mainnet and when ready", () => {
  const ready = { phase: "ready", address: GOOGLE as `0x${string}` };
  assert.deepEqual(pickPlayer(BROWSER, ready, "mainnet"), { address: BROWSER, source: "browser" });
  assert.deepEqual(pickPlayer(undefined, ready, "mainnet"), { address: GOOGLE, source: "google" });
  assert.deepEqual(pickPlayer(undefined, ready, "testnet"), { address: undefined, source: null }, "the Google wallet is on mainnet only");
  assert.deepEqual(pickPlayer(undefined, { phase: "loading", address: GOOGLE }, "mainnet"), { address: undefined, source: null });
  assert.deepEqual(pickPlayer(undefined, { phase: "ready", address: null }, "mainnet"), { address: undefined, source: null });
  assert.deepEqual(pickPlayer(undefined, { phase: "idle", address: null }, "mainnet"), { address: undefined, source: null });
});

const call = (over: Partial<ContractCall>): ContractCall => ({
  id: "c-new",
  state: "SENT",
  txHash: null,
  contractAddress: ARENA,
  abiFunctionSignature: PLACE_CALL_SIGNATURE,
  errorReason: null,
  ...over,
});

test("findNewContractCall: the newest new call on the same contract and function", () => {
  const before = new Set(["c-old"]);
  assert.equal(findNewContractCall([call({ id: "c-old" })], before, ARENA, PLACE_CALL_SIGNATURE), null, "an older call is not this one");
  assert.equal(findNewContractCall([call({ contractAddress: USDC })], before, ARENA, PLACE_CALL_SIGNATURE), null, "another contract");
  assert.equal(findNewContractCall([call({ abiFunctionSignature: APPROVE_SIGNATURE })], before, ARENA, PLACE_CALL_SIGNATURE), null, "another function");
  assert.equal(findNewContractCall([call({ id: null })], before, ARENA, PLACE_CALL_SIGNATURE), null);
  assert.equal(findNewContractCall([call({ contractAddress: ARENA.toUpperCase().replace("0X", "0x") })], before, ARENA, PLACE_CALL_SIGNATURE)?.id, "c-new");
  assert.equal(findNewContractCall([call({ abiFunctionSignature: null })], before, ARENA, PLACE_CALL_SIGNATURE)?.id, "c-new", "Circle may leave the function out");
  assert.equal(findNewContractCall([call({ abiFunctionSignature: "placeCall(uint256, uint256, bool, uint256)" })], before, ARENA, PLACE_CALL_SIGNATURE)?.id, "c-new");
  assert.equal(findNewContractCall([call({ id: "a" }), call({ id: "b" })], before, ARENA, PLACE_CALL_SIGNATURE)?.id, "a");
});

test("lockTimeProblem: a Google call needs at least 30 seconds before calling closes", () => {
  assert.equal(GOOGLE_MIN_SECONDS_LEFT, 30);
  assert.equal(lockTimeProblem(1_000, 900), null);
  assert.equal(lockTimeProblem(1_000, 970), null, "exactly 30 s left is enough");
  assert.match(lockTimeProblem(1_000, 971) ?? "", /Less than 30 seconds left.*not sent/);
  assert.match(lockTimeProblem(1_000, 1_000) ?? "", /just closed/);
  assert.match(lockTimeProblem(1_000, 1_200) ?? "", /just closed/);
});

test("microToUsdc: exact whole-USDC text for the server", () => {
  assert.equal(microToUsdc(50_000_000n), "50");
  assert.equal(microToUsdc(1_500_000n), "1.5");
  assert.equal(microToUsdc(500_000n), "0.5");
  assert.equal(microToUsdc(1n), "0.000001");
  assert.equal(microToUsdc(10_000_000n), "10");
});

test("claims: the browser and the server use the same functions and limit; one round is claim, more are claimMany", () => {
  assert.equal(CLAIM_SIGNATURE, SERVER_CLAIM);
  assert.equal(CLAIM_MANY_SIGNATURE, SERVER_CLAIM_MANY);
  assert.equal(MAX_CLAIM_ROUNDS, SERVER_MAX_CLAIM_ROUNDS);
  assert.equal(claimSignature(1), "claim(uint256,uint256)");
  assert.equal(claimSignature(2), "claimMany(uint256[],uint256[])");
  assert.equal(claimSignature(20), "claimMany(uint256[],uint256[])");
});
