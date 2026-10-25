# Kairo Markets: which tests cover which rule (step 7)

Rule numbers match `docs/RULES.md`. Test names are exact; search for them in `contracts/test/`.
Files: `PredictionArena.t.sol` (markets, betting), `Settle.t.sol` (feed + settle), `Claim.t.sol` (payouts),
`ClaimInvariant.t.sol` (random money checks), `Rules.t.sol` (gap tests added in step 7).

Every deliberate-break check (`ci/mutations.json`, 41 breaks) is caught by these tests.

## A. Markets and timing
| Rule | Covered by |
|---|---|
| 1 Three markets, stored settings, feedB slot | `test_createMarket_succeeds`, `test_productionMarkets_namesAndCount`, `test_createMarket_revertIfFeedBNonZero` |
| 2 Hourly rounds, offsets :00 / :20 / :40, end of k = lock of k+1 | `test_productionMarkets_offsets`, `test_lockTime_round0_btc`, `test_lockTime_round1_eth`, `test_endTime_round0_btc`, `test_endTime_equalsLockTimeOfNextRound` |
| 3 Round length is per market | `test_10minMarkets_roundLength`, `test_10minMarkets_offsets`, `test_createMarket_revertIfRoundTooShort`, `test_createMarket_revertIfOffsetEqualsRoundLength` |
| 4 Settings never change | `test_rule4_marketSettingsNeverChange` (a full lifecycle, pause, fee withdrawal and an ownership change leave every market's settings identical) + the function-list guard `ci/abi-surface.txt` (no setter exists) |

## B. Betting
| Rule | Covered by |
|---|---|
| 5 Next round only; bet at lock refused | `test_placeBet_allowedAtLockMinus1`, `test_placeBet_atLockTimeRevertsNotNextRound`, `test_placeBet_pastRoundRevertsNotNextRound`, `test_placeBet_nextPlusOneRevertsNotNextRound`, `test_placeBet_farFutureRoundRevertsNotNextRound`, `test_nextBettableRound_*` |
| 6 USDC only, approve first | `test_placeBet_noAllowanceReverts`, `test_placeBet_insufficientBalanceReverts`, `test_usdcAddress`, `test_constructor_revertIfUsdcZero` |
| 7 Minimum stake | `test_placeBet_belowMinimumReverts`, `test_placeBet_zeroAmountReverts`, `test_placeBet_exactlyMinimumSucceeds` |
| 8 Top-ups OK, one side only, any wallet | `test_placeBet_topUpSameSideAdds`, `test_placeBet_oppositeSideRevertsWrongSide`, `test_placeBet_twoPlayersOppositesSidesOk`, `test_rule8_contractWalletCanBetAndClaim` |

## C. Prices
| Rule | Covered by |
|---|---|
| 9 Chainlink interface only | `test_feed_decimalsAndVersion`, and every settle test reads the feed through the interface |
| 10 Start = first update at/after lock, end = last at/before end | `test_lockBoundary_*`, `test_endBoundary_*`, `testFuzz_settle_correctPairOnly` |
| 11 Strict settle time and checked ids (no cheating) | `test_settle_tooEarlyAtExactlyEnd`, `test_settle_worksAtEndPlusOne`, `test_cheat_*` (12 cases), `test_settle_twice_reverts` |
| 12 Start price unknown while betting is open | follows from rule 5 (no bets at/after lock) and rule 10; covered by the rule 5 and `test_lockBoundary_*` tests |
| 13 Test feed labelled, owner-only prices | `test_feed_descriptionStartsWithWarning`, `test_feed_constructorRejectsWrongDescription`, `test_feed_setPriceOnlyOwner`, `test_feed_updatedAtDoesNotAcceptBackdate` |

## D. Refunds (no fee)
| Rule | Covered by |
|---|---|
| 14 One-sided | `test_refund_oneSided_noFee`, `test_refund_oneSided_aliceGetsStakeBack` |
| 15 Unchanged price | `test_refund_equalPrices`, `test_refund_unchangedPrice_bothGetStakeBack` |
| 16 End not after start | `test_singleUpdateInRound_refundEndNotAfterStart`, `test_refund_endNotAfterStart_bothGetStakeBack` |
| 17 No update since lock | `test_refund_noUpdate_startId0`, `test_refund_noUpdate_feedEmpty_startId0`, `test_refund_noUpdateInRound_updatesBeforeAndAfter`, `test_refund_noUpdate_bothGetStakeBack` |
| 18 Zero or negative price | `test_refund_zeroPriceAtStart/AtEnd`, `test_refund_negativePriceAtStart/AtEnd`, `test_refund_invalidPrice_bothGetStakeBack` |
| 19 Nobody settled in 1 hour | `test_markRefunded_*`, `test_settleClosedAfterDeadline_markRefundedWorks`, `test_refund_timeout_viaAutoFinalise`, `test_claimExactlyAtDeadline_reverts`, `test_claimOneSecondAfterDeadline_pays`, `test_rule19_claimFirstThenMarkRefundedReverts`, `test_rule19_markRefundedFirstThenBothClaim` |
| 20 Phase edge | `test_phase_startIsFirstOfPhase2_phaseEdgeRefund`, `test_phase_endSuccessorMissingNotLatest_phaseEdgeRefund`, `test_phase_*_reason_phaseEdge`, `test_phase_firstUpdateOfPhase1_validStart` |

D2 / D3 details (window, ids, events, mock feed): `test_settle_windowClosedAfterDeadline`, `test_settle_storesRoundData`, `test_settle_emitsRoundSettledEvent`, `test_settle_balanceUnchanged`, all `test_feed_*` tests.
Unknown market ids on every entry point: `test_placeBet_unknownMarketReverts`, `test_unknownMarket_settleMarkRefundedClaimAndClaimManyRevert`.

## E. Payouts
| Rule | Covered by |
|---|---|
| 21 Stake back plus a proportional share | `test_upWins_*Payout`, `test_downWins_*Payout`, `test_orderIndependent_*` (all six claim orders) |
| 22 Fee: 2% of winnings, none if you lose or are refunded | `test_fee_upWins_unequalBets`, `test_fee_downWins_unequalBets`, `test_fee_rounding_down_to_zero`, all `test_refund_*_bothGetStakeBack` (exact stake, no fee), `test_upWins_loserReverts`, `test_downWins_loserReverts` |
| 23 Round down, dust to fees | `test_dust_notEmittedUntilLastWinner`, `test_dust_emittedOnLastWinner`, `test_dust_noSweep_unclamedWinnerCanClaimLater`, `test_handlerCoverage_*` (exact dust of 1) |
| 24 Pull-based, one blocked wallet freezes nobody | all claim tests (nothing is pushed), `test_rule24_blockedWalletFreezesNobodyElse` |

E2 claim details: `test_alreadyClaimed_*`, `test_stranger_nothingToClaim`, `test_claimInsideWindow_reverts`, `test_claimMany_*` (9 cases), `test_claimMany_acrossTwoMarkets`, `test_claimable_*` (6 cases), `test_rule3_winningsStillClaimableTenYearsLater`, `test_withdrawFees_guard_*`, and the four always-true money checks in `ClaimInvariant.t.sol` (solvency: the contract holds at least what it owes; exact balance; its own owed-money counter matches an independent count; conservation: nothing is created or lost).

## F. Owner powers and limits
| Rule | Covered by |
|---|---|
| 25 Owner can create markets, pause, withdraw fees only | `test_createMarket_onlyOwner`, `test_setMarketPaused_*`, `test_withdrawFees_onlyOwner`, `test_withdrawFees_revert*`, `test_placeBet_pausedMarketReverts`, `test_placeBet_pauseDoesNotAffectExistingPosition`, `test_rule25_pausedMarketStillSettlesAndPays` |
| 26 Owner cannot take the pot or change results | no such function exists. Guarded by the function-list check (`ci/abi-surface.txt`, run on every push: adding any new function fails the build until it is reviewed), plus `test_withdrawFees_cannotDrainBetMoney`, `test_dust_ownerCannotWithdrawPlayerMoney`, `test_withdrawFees_guard_triggersWhenFeesWouldTouchPlayerFunds` and the random money checks |
| 27 Only claims and fee withdrawals move USDC out | the function-list check, the money checks, and the deliberate-break results |
| 25a Two-step ownership | `test_transferOwnership_*`, `test_acceptOwnership_*` |
| 25b Renounce disabled | `test_renounceOwnership_revertsForOwner`, `test_renounceOwnership_revertsForStranger` |

## G. Built for later
Rule 28 (head-to-head) and rule 29 (Pyth) are not built. Today the contract refuses a second feed (`test_createMarket_revertIfFeedBNonZero`).

## H. Testnet setup: 10-minute rounds (file `contracts/test/TenMinuteRounds.t.sol`, 21 tests)
Rules 2, 3, 6, 14, 15, 19: the same rules, proven with the exact testnet settings (round length 600 s, BTC offset 0, ETH 180, SOL 360, one test feed per market) and the runner's 3-push pattern (start at lock + 3 s, middle at lock + 300 s, end at end - 30 s).
| What | Tests |
|---|---|
| Market settings and lock minutes (:00 / :03 / :06) | `test_tenMin_marketSettings`, `test_tenMin_locksLandOnTheRightMinutes`, `test_tenMin_nextBettableRound_staggered`, `test_tenMin_roundLengthLimits` |
| Bet window is 10 minutes, closes at lock | `test_tenMin_betWindowIsTenMinutes` |
| A full round and payout on each market | `test_tenMin_fullRound_BTC`, `..._ETH`, `..._SOL`, `test_tenMin_downWins_evenWhenTheMiddlePriceWasHigher` |
| Judged from the lock price | `test_tenMin_judgedFromTheLockPrice_notFromTheMomentOfTheBet`, `test_tenMin_onlyTheFirstUpdateAfterLockIsAValidStart`, `test_tenMin_theNextRoundsFirstPushIsNotThisRoundsEnd`, `test_tenMin_secondRoundOnSameFeed` |
| Refunds with no fee | `test_tenMin_onlyTheStartPriceArrived_isRefunded`, `test_tenMin_noPriceAtAll_isRefunded`, `test_tenMin_unchangedPrice_isRefunded`, `test_tenMin_oneSidedRound_isRefunded` |
| 1-hour settle window, then refund | `test_tenMin_settleWindow_oneHourAfterTheEnd`, `test_tenMin_nobodySettled_everyoneGetsARefund` |
| Three staggered markets independent | `test_tenMin_threeMarketsSettleIndependently` |
| Gas measurements for the cost estimate | `test_tenMin_gasReport` |
