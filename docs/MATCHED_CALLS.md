# Matched calls (v1.1 payout rules) — spec for the contract change

Status: **planned**, not built. Decision (owner, 26 Oct 2026): build it now with a checkpoint on **Wed 28 Oct 21:00 Lagos**.
If the new contract passes every test and has run cleanly on testnet for several hours, mainnet uses it. If not, mainnet launches
with the current rules and matched calls become v2. Everything else in `docs/RULES.md` stays as it is.

## The rule, in plain words

Per round, **matched = the smaller of the UP total and the DOWN total**.

- The side with less money is matched in full.
- On the bigger side every caller is matched pro rata (`stake × matched ÷ side total`). The part that is not matched is
  **returned in full at claim, whether the call wins or loses**.
- Winners get their whole stake back, plus their share of the losers' **matched** money, minus the **2% fee on that profit only**.
- Losers lose only their **matched** part.
- Refund cases are unchanged (one-sided, unchanged price, end ≤ start, no update, price ≤ 0, timeout): everything back, no fee.
  A one-sided round has matched = 0, so it is a refund anyway.
- No fee on refunds or on unmatched money. Fee stays the constant `FEE_BPS = 200`.

Worked example: UP 10, DOWN 6. matched = 6. An UP caller with 10 is matched for 6, 4 is unmatched.
UP wins: fee = 2% of 6 = 0.12, they get 10 + (6 − 0.12) = 15.88. DOWN loses 6, gets 0.
DOWN wins instead: the DOWN caller gets 6 + 5.88 = 11.88 and the UP caller gets back their 4 unmatched.

## Exact maths (all integers, floor division unless said)

```
U = upTotal, D = downTotal, M = min(U, D)        // matched pool, same on both sides
T = total of the bigger side (max(U, D));  if U == D the "bigger side" is neither: everyone is fully matched
matched_i = s_i                                   // caller on the smaller side (or on a tied round)
matched_i = ceil(s_i * M / T)  if the bigger side LOST   // so the sum of matched is never below M
matched_i = floor(s_i * M / T) if the bigger side WON    // so the sum of matched is never above M
unmatched_i = s_i - matched_i                     // always >= 0, returned at claim

F      = floor(M * FEE_BPS / BPS)                 // booked at settle: feesAccrued += F, totalPlayerFunds -= F
Dist   = M - F
winner payout = s_i + floor(matched_i * Dist / M)
loser  payout = unmatched_i                       // 0 for a loser on the smaller side -> NothingToClaim as today
refund payout = up + down                         // unchanged
```

Why the two roundings: the contract must never owe more than it holds. If the bigger side loses, the winners (smaller side) are
paid `M + Dist` and the losers get back `T - sum(matched)`, so `sum(matched) >= M` is needed. If the bigger side wins, winners'
bonuses are `sum(floor(matched_i*Dist/M))` which needs `sum(matched) <= M`. The remaining rounding dust (at most a few micro-USDC
per round) goes to `feesAccrued` as today (`RoundDustToFees`).

## What changes in `PredictionArena.sol`

`_winnerBonus`, `_computePayout`, `_claimOne` (including `PayoutProgress` dust tracking), `claimable`, `_finaliseRound` (fee is 2% of
**M**, not of the losing side's whole total). New view `matchedStake(marketId, roundIndex, player) returns (matched, unmatched)` for
the site. `placeCall`, `settle`, `markRefunded`, the settle window, events, errors, ownership and pausing stay as they are.
`claim` must now succeed for a loser on the bigger side (pays the unmatched part) and still revert `NothingToClaim` when the payout is 0.
No new owner powers. No on-chain maximum stake.

## Invariants the tests must prove (add a fuzz/invariant test)

1. Money in = money out + fees + dust, per round and for the whole contract (fuzz stakes, sides, claim order, who wins).
2. `USDC balance >= totalPlayerFunds + feesAccrued` after every action; a full claim by everyone leaves only fees and dust.
3. No caller is ever paid more than `s + bonus`, and never less than `unmatched` (a loser) or `s` (a winner).
4. A tie, a one-sided round and every refund reason behave exactly as before.
5. The sum of `matched_i` on the bigger side is `>= M` when it lost and `<= M` when it won (the rounding rule).
6. `claimable()` equals what `claim()` then pays, for winners, losers (unmatched), refunds, timeouts.

Existing tests that assert the old payout/fee numbers need new expected values: `Claim.t.sol` (95), `ClaimInvariant.t.sol` (43),
`PredictionArena.t.sol` (65), `Settle.t.sol` (19), `Rules.t.sol` (10), `TenMinuteRounds.t.sol` (10). Rounds where both sides are equal
keep the old numbers except that the fee is now 2% of the matched pool (which equals the losing side's total).

## Outside the contract

- Runner: claims lost rounds too (the unmatched part); agents' stakes are at least 0.50 USDC; `runner/simulate.mjs` has its own payout formula.
- Site: `onchain/payout.ts` (`estimatePayout`, `settledPayout`), `useMyPositions.ts` (new claim kind "partial return"), the call panel
  ("Matched: $6 of your $10 · If you win: $11.88", with a note that the other $4 comes back either way), receipts get a "Matched" row,
  round result card and Watch sheet totals, How it works.
- Docs: `docs/RULES.md`, `docs/WEBSITE.md`, README, submission text.
