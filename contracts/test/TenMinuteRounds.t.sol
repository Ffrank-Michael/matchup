// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Matchup – tests for the TESTNET setup: 10-minute rounds
//
//  The contract is the same for any round length of 5 minutes or more; these tests
//  prove it with the exact settings used on testnet:
//
//      round length 600 s, three markets, each with its OWN test price feed
//        BTC/USD  offset   0  -> locks at :00, :10, :20 ...
//        ETH/USD  offset 180  -> locks at :03, :13, :23 ...
//        SOL/USD  offset 360  -> locks at :06, :16, :26 ...
//
//  and the runner's price pattern, about 3 pushes per round per market:
//        lock + 3 s       (start price: first update at or after lock)
//        lock + 300 s     (middle of the round)
//        end  - 30 s      (end price: last update at or before the end)
//
//  Time starts at T0 = 1_800_000_000, which is a multiple of 600 (3_000_000 * 600),
//  so T0 is an exact "x:x0:00" mark, like a real 10-minute boundary.
//
//  Worked numbers (v1.1 matched calls, by hand), 300_000 UP vs 200_000 DOWN, UP wins:
//     M=min(300_000,200_000)=200_000; fee=floor(200_000*200/10_000)=4_000; Dist=196_000
//     alice (UP bigger, won): matched=floor(300_000*200_000/300_000)=200_000; bonus=196_000; payout=496_000
//
//  The GASREPORT lines are measurements for the cost estimate (run with -vv).
// =============================================================

import {Test}            from "forge-std/Test.sol";
import {PredictionArena} from "../PredictionArena.sol";
import {MockPriceFeed}   from "../mocks/MockPriceFeed.sol";
import {MockUSDC}        from "./MockUSDC.sol";

contract TenMinuteRoundsTest is Test {

    PredictionArena arena;
    MockUSDC        usdc;
    MockPriceFeed[3] feeds;
    uint256[3]      ids;

    address owner   = makeAddr("owner");
    address alice   = makeAddr("alice");
    address dave    = makeAddr("dave");
    address settler = makeAddr("settler");

    uint32  constant ROUND   = 600;
    uint32  constant OFF_BTC = 0;
    uint32  constant OFF_ETH = 180;
    uint32  constant OFF_SOL = 360;
    uint128 constant MIN     = 100_000; // $0.10

    uint256 constant T0 = 1_800_000_000;
    uint256 constant K0 = 3_000_000; // T0 / 600

    function setUp() public {
        vm.warp(T0);
        vm.startPrank(owner);
        usdc  = new MockUSDC();
        arena = new PredictionArena(address(usdc), owner);
        _addMarket(0, "BTC/USD", OFF_BTC);
        _addMarket(1, "ETH/USD", OFF_ETH);
        _addMarket(2, "SOL/USD", OFF_SOL);
        vm.stopPrank();
    }

    /// One market with its own test feed, like the deploy script does.
    function _addMarket(uint256 i, string memory name, uint32 offset) internal {
        feeds[i] = new MockPriceFeed(owner, 8, string.concat("TEST PRICES - NOT REAL DATA / ", name));
        ids[i]   = arena.marketCount();
        arena.createMarket(name, address(feeds[i]), address(0), ROUND, offset, MIN);
    }

    // ── helpers ──────────────────────────────────────────────

    function _makeCall(address who, uint256 i, uint256 k, bool up, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(arena), amt);
        arena.placeCall(ids[i], k, up, amt);
        vm.stopPrank();
    }

    function _push(uint256 i, uint256 at, int256 px) internal returns (uint80 id) {
        vm.warp(at);
        vm.prank(owner);
        feeds[i].setPrice(px);
        (id, , , , ) = feeds[i].latestRoundData();
    }

    /// The runner's pattern for one round: start price at lock + 3, a middle price at lock + 300,
    /// an end price at end - 30.  Leaves the time at end + 1 (settling is allowed).
    function _threePushes(uint256 i, uint256 k, int256 pStart, int256 pMid, int256 pEnd)
        internal returns (uint80 startId, uint80 midId, uint80 endId)
    {
        uint256 lt = arena.lockTime(ids[i], k);
        uint256 et = arena.endTime(ids[i], k);
        startId = _push(i, lt + 3,   pStart);
        midId   = _push(i, lt + 300, pMid);
        endId   = _push(i, et - 30,  pEnd);
        vm.warp(et + 1);
    }

    function _state(uint256 i, uint256 k) internal view returns (PredictionArena.RoundState state) {
        (,,,,,, state) = arena.rounds(ids[i], k);
    }

    function _settle(uint256 i, uint256 k, uint80 s, uint80 e) internal {
        vm.prank(settler);
        arena.settle(ids[i], k, s, e);
    }

    function _claim(address who, uint256 i, uint256 k) internal returns (uint256) {
        vm.prank(who);
        return arena.claim(ids[i], k);
    }

    // =========================================================
    //  The market settings
    // =========================================================

    function test_tenMin_marketSettings() public view {
        assertEq(arena.marketCount(), 3);
        _checkMarket(0, OFF_BTC);
        _checkMarket(1, OFF_ETH);
        _checkMarket(2, OFF_SOL);
    }

    function _checkMarket(uint256 i, uint32 expectedOffset) internal view {
        (, , uint32 rl, uint32 off, uint128 ms, bool paused) = arena.markets(ids[i]);
        assertEq(uint256(rl), 600, "10-minute rounds");
        assertEq(uint256(off), uint256(expectedOffset), "offset");
        assertEq(uint256(ms), uint256(MIN), "min stake");
        assertFalse(paused);
    }

    function test_tenMin_locksLandOnTheRightMinutes() public view {
        for (uint256 k = K0; k < K0 + 12; k++) {
            assertEq(arena.lockTime(ids[0], k) % 600, 0,   "BTC locks at :00");
            assertEq(arena.lockTime(ids[1], k) % 600, 180, "ETH locks at :03");
            assertEq(arena.lockTime(ids[2], k) % 600, 360, "SOL locks at :06");
        }
        for (uint256 i = 0; i < 3; i++) {
            assertEq(arena.endTime(ids[i], K0), arena.lockTime(ids[i], K0 + 1), "end of k is the lock of k+1");
            assertEq(arena.endTime(ids[i], K0) - arena.lockTime(ids[i], K0), 600, "10 minutes long");
        }
        // hand-checked: BTC round K0 locks exactly at T0, ETH K0 at T0 + 180, SOL K0 at T0 + 360
        assertEq(arena.lockTime(ids[0], K0), T0);
        assertEq(arena.lockTime(ids[1], K0), T0 + 180);
        assertEq(arena.lockTime(ids[2], K0), T0 + 360);
    }

    function test_tenMin_nextCallableRound_staggered() public {
        // T0 + 100: BTC round K0 locked at T0; ETH locks at T0+180; SOL locks at T0+360
        vm.warp(T0 + 100);
        assertEq(arena.nextCallableRound(ids[0]), K0 + 1);
        assertEq(arena.nextCallableRound(ids[1]), K0);
        assertEq(arena.nextCallableRound(ids[2]), K0);
        // T0 + 200: ETH has just locked
        vm.warp(T0 + 200);
        assertEq(arena.nextCallableRound(ids[0]), K0 + 1);
        assertEq(arena.nextCallableRound(ids[1]), K0 + 1);
        assertEq(arena.nextCallableRound(ids[2]), K0);
        // T0 + 400: SOL has just locked
        vm.warp(T0 + 400);
        assertEq(arena.nextCallableRound(ids[2]), K0 + 1);
        // T0 + 600: BTC moves on again
        vm.warp(T0 + 600);
        assertEq(arena.nextCallableRound(ids[0]), K0 + 2);
        assertEq(arena.nextCallableRound(ids[1]), K0 + 1);
        assertEq(arena.nextCallableRound(ids[2]), K0 + 1);
    }

    function test_tenMin_callWindowIsTenMinutes() public {
        // BTC round K0 + 1 can be call on from its predecessor's lock (T0 + 0 ... wait: lock(K0) = T0)
        // until its own lock at T0 + 600, and not a second later.
        vm.warp(T0);
        _makeCall(alice, 0, K0 + 1, true, MIN);                        // first second of the window
        vm.warp(T0 + 599);
        _makeCall(dave, 0, K0 + 1, false, MIN);                        // last second of the window
        vm.warp(T0 + 600);
        usdc.mint(alice, MIN);
        vm.startPrank(alice);
        usdc.approve(address(arena), MIN);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.NotNextRound.selector, K0 + 1, K0 + 2));
        arena.placeCall(ids[0], K0 + 1, true, MIN);                // too late: round K0 + 1 has locked
        vm.stopPrank();
    }

    function test_tenMin_roundLengthLimits() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.RoundTooShort.selector, uint32(299), uint32(300)));
        arena.createMarket("X", address(feeds[0]), address(0), 299, 0, MIN);
        arena.createMarket("OK-5min", address(feeds[0]), address(0), 300, 0, MIN);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.OffsetNotLessThanRoundLength.selector, uint32(600), uint32(600)));
        arena.createMarket("Y", address(feeds[0]), address(0), 600, 600, MIN);
        arena.createMarket("OK-edge", address(feeds[0]), address(0), 600, 599, MIN);
        vm.stopPrank();
    }

    // =========================================================
    //  A full round on each market, with the three-push pattern
    // =========================================================

    function _fullRoundUpWins(uint256 i) internal {
        uint256 k = arena.nextCallableRound(ids[i]);
        _makeCall(alice, i, k, true,  300_000);
        _makeCall(dave,  i, k, false, 200_000);

        (uint80 s, , uint80 e) = _threePushes(i, k, 100e8, 100.5e8, 101e8);
        _settle(i, k, s, e);

        assertEq(uint8(_state(i, k)), uint8(PredictionArena.RoundState.SettledUp), "UP wins");
        assertEq(arena.feesAccrued(), 4_000, "2% of the losing side");
        assertEq(_claim(alice, i, k), 496_000, "winner payout");
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.NothingToClaim.selector, ids[i], k));
        arena.claim(ids[i], k);
        assertEq(usdc.balanceOf(address(arena)), 4_000, "only the fee is left in the contract");
    }

    function test_tenMin_fullRound_BTC() public { _fullRoundUpWins(0); }
    function test_tenMin_fullRound_ETH() public { _fullRoundUpWins(1); }
    function test_tenMin_fullRound_SOL() public { _fullRoundUpWins(2); }

    function test_tenMin_downWins_evenWhenTheMiddlePriceWasHigher() public {
        uint256 k = arena.nextCallableRound(ids[0]);
        _makeCall(alice, 0, k, true,  300_000);
        _makeCall(dave,  0, k, false, 200_000);
        // up in the middle, but the END price is below the START price: DOWN wins
        (uint80 s, , uint80 e) = _threePushes(0, k, 100e8, 105e8, 99e8);
        _settle(0, k, s, e);
        assertEq(uint8(_state(0, k)), uint8(PredictionArena.RoundState.SettledDown));
        // v1.1 matched calls: DOWN 200_000 wins (smaller side, fully matched).
        // M = min(300_000, 200_000) = 200_000; F = floor(200_000 * 200 / 10_000) = 4_000; Dist = 196_000.
        // dave bonus = floor(200_000 * 196_000 / 200_000) = 196_000; payout = 396_000.
        // alice (UP loser, bigger side): matched = ceil(300_000 * 200_000 / 300_000) = 200_000; unmatched = 100_000.
        assertEq(arena.feesAccrued(), 4_000);
        assertEq(_claim(dave, 0, k), 396_000);
        // alice gets back her unmatched 100_000.
        assertEq(_claim(alice, 0, k), 100_000, "bigger-side loser gets unmatched back");
    }

    function test_tenMin_judgedFromTheLockPrice_notFromTheMomentOfTheCall() public {
        // A price move BEFORE lock does not matter: only the first update at/after lock is the start price.
        uint256 k = arena.nextCallableRound(ids[0]);
        uint256 lt = arena.lockTime(ids[0], k);
        _push(0, lt - 300, 90e8);              // very different price in the middle of the call window
        _makeCall(alice, 0, k, true,  300_000);
        _push(0, lt - 30, 120e8);              // last price before lock (not the start price)
        _makeCall(dave,  0, k, false, 200_000);
        (uint80 s, , uint80 e) = _threePushes(0, k, 100e8, 100.1e8, 100.2e8);
        _settle(0, k, s, e);
        // the start price is 100 (first update after lock), end 100.2: UP wins, whatever happened before lock
        assertEq(uint8(_state(0, k)), uint8(PredictionArena.RoundState.SettledUp));
        (,,,, int256 sp, int256 ep, ) = arena.rounds(ids[0], k);
        assertEq(sp, 100e8);
        assertEq(ep, 100.2e8);
    }

    // =========================================================
    //  The three-push pattern and the settle id checks
    // =========================================================

    function test_tenMin_onlyTheFirstUpdateAfterLockIsAValidStart() public {
        uint256 k = arena.nextCallableRound(ids[0]);
        _makeCall(alice, 0, k, true,  300_000);
        _makeCall(dave,  0, k, false, 200_000);
        (uint80 s, uint80 m, uint80 e) = _threePushes(0, k, 100e8, 101e8, 102e8);

        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, m));
        arena.settle(ids[0], k, m, e);                                 // middle update as start: its predecessor is also after lock

        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.InvalidEndRound.selector, m));
        arena.settle(ids[0], k, s, m);                                 // middle update as end: a later update is still inside the round

        _settle(0, k, s, e);                                           // start and end are the right ones
        assertEq(uint8(_state(0, k)), uint8(PredictionArena.RoundState.SettledUp));
    }

    function test_tenMin_theNextRoundsFirstPushIsNotThisRoundsEnd() public {
        uint256 k = arena.nextCallableRound(ids[0]);
        _makeCall(alice, 0, k, true,  300_000);
        _makeCall(dave,  0, k, false, 200_000);
        (uint80 s, , uint80 e) = _threePushes(0, k, 100e8, 101e8, 102e8);
        // the runner pushes the next round's start price 3 s after the lock of k+1 = the end of k
        uint80 nextStart = _push(0, arena.endTime(ids[0], k) + 3, 103e8);
        assertEq(uint256(nextStart), uint256(e) + 1);

        _settle(0, k, s, e);                                           // correct: end = last update <= end time
        assertEq(uint8(_state(0, k)), uint8(PredictionArena.RoundState.SettledUp));
    }

    function test_tenMin_secondRoundOnSameFeed() public {
        // Round k: UP.  Round k + 1 (calls placed during round k): DOWN.  Same feed, runner pattern.
        uint256 k = arena.nextCallableRound(ids[0]);
        _makeCall(alice, 0, k, true, 300_000);
        _makeCall(dave, 0, k, false, 200_000);
        // calls for k + 1 are placed once k has locked (T0 + 600): do this after the first lock
        uint256 lt = arena.lockTime(ids[0], k);
        uint80 s1 = _push(0, lt + 3, 100e8);
        vm.warp(lt + 10);
        assertEq(arena.nextCallableRound(ids[0]), k + 1);
        _makeCall(alice, 0, k + 1, false, 300_000);
        _makeCall(dave,  0, k + 1, true,  200_000);
        _push(0, lt + 300, 101e8);
        uint80 e1 = _push(0, arena.endTime(ids[0], k) - 30, 102e8);
        uint80 s2 = _push(0, arena.endTime(ids[0], k) + 3, 102e8);
        _push(0, arena.lockTime(ids[0], k + 1) + 300, 101e8);
        uint80 e2 = _push(0, arena.endTime(ids[0], k + 1) - 30, 100e8);

        // both rounds are over now (time is at the last push); both are still inside the 1-hour settle window
        vm.warp(arena.endTime(ids[0], k + 1) + 1);
        _settle(0, k, s1, e1);
        _settle(0, k + 1, s2, e2);
        assertEq(uint8(_state(0, k)),     uint8(PredictionArena.RoundState.SettledUp));
        assertEq(uint8(_state(0, k + 1)), uint8(PredictionArena.RoundState.SettledDown));
    }

    // =========================================================
    //  Refunds (no fee) when the price feed does not do its job
    // =========================================================

    function test_tenMin_onlyTheStartPriceArrived_isRefunded() public {
        // price API failed after the start push: no later update inside the round
        uint256 k = arena.nextCallableRound(ids[0]);
        _makeCall(alice, 0, k, true,  300_000);
        _makeCall(dave,  0, k, false, 200_000);
        uint80 s = _push(0, arena.lockTime(ids[0], k) + 3, 100e8);
        vm.warp(arena.endTime(ids[0], k) + 1);
        _settle(0, k, s, s);
        assertEq(uint8(_state(0, k)), uint8(PredictionArena.RoundState.Refunded));
        assertEq(arena.feesAccrued(), 0);
        assertEq(_claim(alice, 0, k), 300_000);
        assertEq(_claim(dave,  0, k), 200_000);
    }

    function test_tenMin_noPriceAtAll_isRefunded() public {
        uint256 k = arena.nextCallableRound(ids[0]);
        _makeCall(alice, 0, k, true,  300_000);
        _makeCall(dave,  0, k, false, 200_000);
        _push(0, arena.lockTime(ids[0], k) - 60, 100e8);            // only a price from before lock
        vm.warp(arena.endTime(ids[0], k) + 1);
        _settle(0, k, 0, 0);
        assertEq(uint8(_state(0, k)), uint8(PredictionArena.RoundState.Refunded));
        assertEq(_claim(alice, 0, k), 300_000);
        assertEq(arena.feesAccrued(), 0);
    }

    function test_tenMin_unchangedPrice_isRefunded() public {
        uint256 k = arena.nextCallableRound(ids[1]);
        _makeCall(alice, 1, k, true,  300_000);
        _makeCall(dave,  1, k, false, 200_000);
        (uint80 s, , uint80 e) = _threePushes(1, k, 2300e8, 2310e8, 2300e8);
        _settle(1, k, s, e);
        assertEq(uint8(_state(1, k)), uint8(PredictionArena.RoundState.Refunded));
        assertEq(_claim(dave, 1, k), 200_000);
        assertEq(arena.feesAccrued(), 0);
    }

    function test_tenMin_oneSidedRound_isRefunded() public {
        uint256 k = arena.nextCallableRound(ids[2]);
        _makeCall(alice, 2, k, true, 300_000);
        (uint80 s, , uint80 e) = _threePushes(2, k, 100e8, 101e8, 102e8);
        _settle(2, k, s, e);
        assertEq(uint8(_state(2, k)), uint8(PredictionArena.RoundState.Refunded));
        assertEq(_claim(alice, 2, k), 300_000);
    }

    // =========================================================
    //  The 1-hour settle window is six 10-minute rounds
    // =========================================================

    function test_tenMin_settleWindow_oneHourAfterTheEnd() public {
        uint256 k = arena.nextCallableRound(ids[0]);
        _makeCall(alice, 0, k, true,  300_000);
        _makeCall(dave,  0, k, false, 200_000);
        (uint80 s, , uint80 e) = _threePushes(0, k, 100e8, 100.5e8, 101e8);
        uint256 et = arena.endTime(ids[0], k);

        vm.warp(et);                                                    // not strictly after the end yet
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.SettleTooEarly.selector, et, et));
        arena.settle(ids[0], k, s, e);

        vm.warp(et + 3600 + 1);                                         // window closed (6 rounds later)
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.SettleWindowClosed.selector, et + 3601, et + 3600));
        arena.settle(ids[0], k, s, e);

        vm.warp(et + 3600);                                             // the very last second still works
        _settle(0, k, s, e);
        assertEq(uint8(_state(0, k)), uint8(PredictionArena.RoundState.SettledUp));
    }

    function test_tenMin_nobodySettled_everyoneGetsARefund() public {
        uint256 k = arena.nextCallableRound(ids[1]);
        _makeCall(alice, 1, k, true,  300_000);
        _makeCall(dave,  1, k, false, 200_000);
        _threePushes(1, k, 100e8, 100.5e8, 101e8);
        vm.warp(arena.endTime(ids[1], k) + 3601);
        assertEq(_claim(alice, 1, k), 300_000);
        assertEq(_claim(dave,  1, k), 200_000);
        assertEq(arena.feesAccrued(), 0);
    }

    // =========================================================
    //  Three staggered markets at the same time
    // =========================================================

    function test_tenMin_threeMarketsSettleIndependently() public {
        // At T0 the callable rounds are BTC K0+1 (ends T0+1200), ETH K0 (ends T0+780), SOL K0 (ends T0+960).
        uint256[3] memory ks;
        uint80[3] memory sId;
        uint80[3] memory eId;
        for (uint256 i = 0; i < 3; i++) {
            ks[i] = arena.nextCallableRound(ids[i]);
            _makeCall(alice, i, ks[i], i != 1, 300_000);   // BTC up, ETH down, SOL up
            _makeCall(dave,  i, ks[i], i == 1, 200_000);   // BTC down, ETH up, SOL down
        }
        assertEq(arena.endTime(ids[1], ks[1]), T0 + 780);
        assertEq(arena.endTime(ids[2], ks[2]), T0 + 960);
        assertEq(arena.endTime(ids[0], ks[0]), T0 + 1200);

        // each market gets its own three pushes (different feeds, so the times can interleave)
        for (uint256 i = 0; i < 3; i++) {
            uint256 lt = arena.lockTime(ids[i], ks[i]);
            uint256 et = arena.endTime(ids[i], ks[i]);
            sId[i] = _push(i, lt + 3, 100e8);
            _push(i, lt + 300, 100e8);
            eId[i] = _push(i, et - 30, i == 2 ? int256(99e8) : int256(101e8));   // BTC up, ETH up, SOL down
        }

        // ETH ends first: only ETH can be settled now, not SOL or BTC.
        uint256 etEth = arena.endTime(ids[1], ks[1]);
        uint256 etSol = arena.endTime(ids[2], ks[2]);
        vm.warp(etEth + 1);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.SettleTooEarly.selector, etEth + 1, etSol));
        arena.settle(ids[2], ks[2], sId[2], eId[2]);
        _settle(1, ks[1], sId[1], eId[1]);

        vm.warp(etSol + 1);
        _settle(2, ks[2], sId[2], eId[2]);
        vm.warp(arena.endTime(ids[0], ks[0]) + 1);
        _settle(0, ks[0], sId[0], eId[0]);

        assertEq(uint8(_state(0, ks[0])), uint8(PredictionArena.RoundState.SettledUp));
        assertEq(uint8(_state(1, ks[1])), uint8(PredictionArena.RoundState.SettledUp));   // ETH: price rose, dave (UP) wins
        assertEq(uint8(_state(2, ks[2])), uint8(PredictionArena.RoundState.SettledDown)); // SOL: price fell, dave (DOWN) wins
        // BTC: alice 300_000 UP wins vs dave 200_000 DOWN. M=200_000; bigger UP won.
        // alice matched=200_000; bonus=196_000; payout=496_000 (unchanged).
        assertEq(_claim(alice, 0, ks[0]), 496_000);
        // ETH: dave 200_000 UP wins vs alice 300_000 DOWN. M=200_000 (UP=smaller side, fully matched).
        // dave bonus=floor(200_000*196_000/200_000)=196_000; payout=396_000.
        assertEq(_claim(dave,  1, ks[1]), 396_000);
        // SOL: dave 200_000 DOWN wins vs alice 300_000 UP. M=200_000 (DOWN=smaller side, fully matched).
        // dave bonus=196_000; payout=396_000.
        assertEq(_claim(dave,  2, ks[2]), 396_000);
    }

    // =========================================================
    //  Gas measurements for the cost estimate (see the GASREPORT lines with -vv)
    // =========================================================

    function test_tenMin_gasReport() public {
        uint256 k = arena.nextCallableRound(ids[0]);
        uint256 g;
        uint256 used;

        usdc.mint(alice, 1_000_000);
        vm.prank(alice);
        usdc.approve(address(arena), 1_000_000);
        vm.prank(alice);
        g = gasleft();
        arena.placeCall(ids[0], k, true, 300_000);
        used = g - gasleft();
        emit log_named_uint("GASREPORT placeCall (first call in a round)", used);

        _makeCall(dave, 0, k, false, 200_000);

        uint256 lt = arena.lockTime(ids[0], k);
        vm.warp(lt + 3);
        vm.prank(owner);
        g = gasleft();
        feeds[0].setPrice(100e8);
        used = g - gasleft();
        emit log_named_uint("GASREPORT setPrice (first ever update of a feed)", used);
        (uint80 s, , , , ) = feeds[0].latestRoundData();

        vm.warp(lt + 300);
        vm.prank(owner);
        g = gasleft();
        feeds[0].setPrice(100.5e8);
        used = g - gasleft();
        emit log_named_uint("GASREPORT setPrice (later update)", used);

        vm.warp(arena.endTime(ids[0], k) - 30);
        vm.prank(owner);
        feeds[0].setPrice(101e8);
        (uint80 e, , , , ) = feeds[0].latestRoundData();
        vm.warp(arena.endTime(ids[0], k) + 1);

        vm.prank(settler);
        g = gasleft();
        arena.settle(ids[0], k, s, e);
        used = g - gasleft();
        emit log_named_uint("GASREPORT settle (winner and loser)", used);

        vm.prank(alice);
        g = gasleft();
        arena.claim(ids[0], k);
        used = g - gasleft();
        emit log_named_uint("GASREPORT claim (winner)", used);

        vm.prank(alice);
        g = gasleft();
        usdc.approve(address(arena), 10_000_000);
        used = g - gasleft();
        emit log_named_uint("GASREPORT approve", used);
    }
}
