// node --test lib/circle-send.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import {
  balanceToUnits,
  challengeErrorText,
  checkSend,
  explorerTxUrl,
  failedStateText,
  feeReserve,
  feeToUnits,
  findNewTransfer,
  fromUnits,
  isFailedState,
  isFinalState,
  maxSendable,
  maxWithdraw,
  toUnits,
  transferErrorText,
  type Transfer,
} from "./circle-send.ts";

const OWN = "0xAbCdEf0000000000000000000000000000000001";
const TO = "0x2222222222222222222222222222222222222222";
const form = (over: Partial<Parameters<typeof checkSend>[0]> = {}) => checkSend({ to: TO, amount: "1", own: OWN, balance: 5_000_000n, fee: null, ...over });

test("toUnits / fromUnits: exact micro-USDC, at most 6 decimals, no floating point", () => {
  assert.equal(toUnits("1"), 1_000_000n);
  assert.equal(toUnits("0.5"), 500_000n);
  assert.equal(toUnits(" 12.345678 "), 12_345_678n);
  assert.equal(toUnits("0.1"), 100_000n); // 0.1 is not 0.1000000000000000055 here
  for (const bad of ["", ".5", "1.", "1.2345678", "-1", "1e3", "abc", "1,5", "0x10", "1 000"]) assert.equal(toUnits(bad), null, bad);
  assert.equal(fromUnits(1_500_000n), "1.5");
  assert.equal(fromUnits(1_000_000n), "1");
  assert.equal(fromUnits(1n), "0.000001");
  assert.equal(fromUnits(0n), "0");
});

test("Circle's numbers: fees round UP, balances round DOWN, so neither is ever in the player's favour by mistake", () => {
  assert.equal(feeToUnits("0.002"), 2_000n);
  assert.equal(feeToUnits("0.0000001"), 1n);
  assert.equal(feeToUnits("0.000412345678901234"), 413n);
  assert.equal(feeToUnits("0.000412000000000000"), 412n);
  assert.equal(feeToUnits(null), null);
  assert.equal(feeToUnits("abc"), null);
  assert.equal(balanceToUnits("3.123456789"), 3_123_456n);
  assert.equal(balanceToUnits("20"), 20_000_000n);
  assert.equal(balanceToUnits(null), null);
});

test("Max keeps twice the fee estimate back (at least 0.01), or 0.05 when there is no estimate, and never goes below 0", () => {
  assert.equal(feeReserve(null), 50_000n);
  assert.equal(feeReserve(2_000n), 10_000n); // 2 x 0.002 = 0.004 is under the 0.01 floor
  assert.equal(feeReserve(30_000n), 60_000n);
  assert.equal(maxSendable(5_000_000n, null), 4_950_000n);
  assert.equal(maxSendable(5_000_000n, 30_000n), 4_940_000n);
  assert.equal(maxSendable(40_000n, null), 0n);
  assert.equal(maxSendable(0n, 1n), 0n);
  // what Max fills in passes the form check
  const bal = 1_234_567n;
  for (const fee of [null, 1n, 4_000n, 30_000n]) assert.equal(form({ amount: fromUnits(maxSendable(bal, fee)), balance: bal, fee }), null);
});

test("checkSend: the address must be filled in, valid, not the zero address and not this wallet", () => {
  assert.match(form({ to: "" }) ?? "", /Enter the address/);
  assert.match(form({ to: "   " }) ?? "", /Enter the address/);
  assert.match(form({ to: "0x123" }) ?? "", /not a valid address/);
  assert.match(form({ to: "2222222222222222222222222222222222222222" }) ?? "", /not a valid address/);
  assert.match(form({ to: `${TO}0` }) ?? "", /not a valid address/);
  assert.match(form({ to: "0x0000000000000000000000000000000000000000" }) ?? "", /zero address/);
  assert.match(form({ to: OWN.toLowerCase() }) ?? "", /own address/);
  assert.match(form({ to: ` ${OWN.toUpperCase().replace("0X", "0x")} ` }) ?? "", /own address/);
  assert.equal(form({ to: ` ${TO} ` }), null);
});

test("checkSend: the amount must be a number above 0, not more than the balance, and leave room for a known fee", () => {
  assert.match(form({ amount: "" }) ?? "", /Enter an amount/);
  assert.match(form({ amount: "abc" }) ?? "", /as a number/);
  assert.match(form({ amount: "1.1234567" }) ?? "", /at most 6 decimals/);
  assert.match(form({ amount: "0" }) ?? "", /more than 0/);
  assert.match(form({ amount: "0.000000" }) ?? "", /more than 0/);
  assert.match(form({ balance: null }) ?? "", /still loading/);
  assert.match(form({ amount: "5.000001" }) ?? "", /more than your balance \(5 USDC\)/);
  assert.equal(form({ amount: "5" }), null, "with no fee estimate yet, the whole balance is allowed (Circle refuses if short)");
  assert.match(form({ amount: "5", fee: 2_000n }) ?? "", /Leave about 0\.002 USDC/);
  assert.equal(form({ amount: "4.998", fee: 2_000n }), null);
  assert.equal(form({ amount: "0.000001" }), null);
});

const tr = (over: Partial<Transfer>): Transfer => ({ id: "t-new", state: "SENT", txHash: null, destinationAddress: TO, amounts: ["1"], errorReason: null, ...over });

test("findNewTransfer: the newest transfer that was not there before, to the same address, for the same amount", () => {
  const before = new Set(["t-old"]);
  assert.equal(findNewTransfer([tr({ id: "t-old" })], before, TO, "1"), null, "an older identical transfer is not this one");
  assert.equal(findNewTransfer([tr({ destinationAddress: OWN })], before, TO, "1"), null);
  assert.equal(findNewTransfer([tr({ amounts: ["1.5"] })], before, TO, "1"), null);
  assert.equal(findNewTransfer([tr({ id: null })], before, TO, "1"), null);
  assert.equal(findNewTransfer([tr({ amounts: [] })], before, TO, "1"), null);
  assert.equal(findNewTransfer([tr({ destinationAddress: TO.toUpperCase().replace("0X", "0x") })], before, ` ${TO} `, "1.000")?.id, "t-new");
  assert.equal(findNewTransfer([tr({ amounts: ["1.000000"] })], before, TO, "1")?.id, "t-new");
  assert.equal(findNewTransfer([tr({ id: "a" }), tr({ id: "b" })], before, TO, "1")?.id, "a", "the newest (Circle lists newest first)");
});

test("final states: COMPLETE is done; FAILED, DENIED, CANCELLED are failed; the rest are still moving", () => {
  for (const s of ["COMPLETE", "FAILED", "DENIED", "CANCELLED"]) assert.ok(isFinalState(s), s);
  for (const s of ["INITIATED", "CLEARED", "QUEUED", "SENT", "STUCK", "CONFIRMED", null]) assert.ok(!isFinalState(s), String(s));
  assert.ok(!isFailedState("COMPLETE"));
  assert.ok(isFailedState("DENIED"));
});

test("explorer link only for a real transaction hash", () => {
  const h = `0x${"ab".repeat(32)}`;
  assert.equal(explorerTxUrl("https://explorer.arc.io", h), `https://explorer.arc.io/tx/${h}`);
  assert.equal(explorerTxUrl("https://explorer.arc.io", "0xabc"), null);
  assert.equal(explorerTxUrl("https://explorer.arc.io", `${h}/../x`), null);
});

test("plain-word errors: closing Circle's window, an expired sign-in, Circle refusing, a failed transfer", () => {
  assert.match(challengeErrorText({ closed: true }), /closed Circle's confirmation screen, so nothing was sent/);
  assert.match(challengeErrorText({ code: 155701, message: "User canceled" }), /closed/);
  assert.match(challengeErrorText({ code: 155104 }), /sign-in has run out/);
  assert.match(challengeErrorText({ code: 155706 }), /could not be reached/);
  assert.match(challengeErrorText({ code: 999, message: "boom" }), /boom.*Nothing was sent/);
  assert.match(transferErrorText(155258, "x"), /not enough USDC/);
  assert.match(transferErrorText(155219, "x"), /address cannot receive/);
  assert.match(transferErrorText(null, "This wallet has no USDC on Arc yet"), /refused the transfer: This wallet has no USDC/);
  assert.match(transferErrorText(null, null), /refused the transfer\. Try again/);
  assert.match(failedStateText("DENIED", "RISK_SCREENING"), /safety check.*risk screening.*did not move/);
  assert.match(failedStateText("FAILED", "FAILED_ON_CHAIN"), /failed \(failed on chain\)/);
  assert.match(failedStateText("CANCELLED", null), /cancelled/);
});

test("maxWithdraw: the main wallet keeps the fee reserve back; the sponsored older wallet withdraws everything", () => {
  assert.equal(maxWithdraw(5_000_000n, null, false), maxSendable(5_000_000n, null));
  assert.equal(maxWithdraw(5_000_000n, 30_000n, false), 4_940_000n);
  assert.equal(maxWithdraw(5_000_000n, null, true), 5_000_000n);
  assert.equal(maxWithdraw(5_000_000n, 30_000n, true), 5_000_000n, "a fee estimate is ignored when the fee is sponsored");
  assert.equal(maxWithdraw(1n, null, true), 1n);
  assert.equal(maxWithdraw(0n, null, true), 0n);
  // the whole balance passes the form check (no fee estimate is used for a sponsored wallet)
  assert.equal(form({ amount: fromUnits(maxWithdraw(1_234_567n, null, true)), balance: 1_234_567n, fee: null }), null);
});

test("Circle refusing the sponsored fee (no or used-up Gas Station policy) is said in plain words", () => {
  const msg = "Entity needs to setup paymaster policy in developer console before sending transaction on mainnet";
  assert.match(transferErrorText(155601, msg), /network fee for this wallet is not covered.*Gas Station.*Nothing was sent/);
  assert.match(transferErrorText(null, "gas station policy limit reached"), /not covered/);
  assert.match(transferErrorText(155258, "insufficient"), /not enough USDC/, "other refusals are unchanged");
});
