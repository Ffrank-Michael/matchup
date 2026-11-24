// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Matchup – SOL vs BTC end to end, next to ETH vs BTC
//
//  The second coin-vs-coin pair through the unchanged arena:
//    Chainlink mocks SOL/USD, ETH/USD, BTC/USD (8 decimals)
//      -> RatioGuard SOL/BTC (and ETH/BTC), 18 decimals, 25 h per leg
//      -> GuardedRelayFeed, band 2.5%, the pusher pushes the ratio
//      -> markets "SOL/BTC 1h" (offset 150 s) and "ETH/BTC 1h"
//         (offset 50 s), as in scripts/markets.mjs
//  SOL/BTC is about 0.0015: a decimal place smaller than ETH/BTC,
//  so this also checks that 18 decimals leave plenty of room.
//  Every expected payout is worked out by hand (MatchedCalls rules).
// =============================================================

import {Test}             from "forge-std/Test.sol";
import {PredictionArena}  from "../PredictionArena.sol";
import {GuardedRelayFeed} from "../GuardedRelayFeed.sol";
import {RatioGuard}       from "../RatioGuard.sol";
import {MockPriceFeed}    from "../mocks/MockPriceFeed.sol";
import {MockUSDC}         from "./MockUSDC.sol";

contract RatioSolBtcTest is Test {

    PredictionArena  arena;
    MockUSDC         usdc;
    MockPriceFeed    solUsd;
    MockPriceFeed    ethUsd;
    MockPriceFeed    btcUsd;
    RatioGuard       solGuard;
    RatioGuard       ethGuard;
    GuardedRelayFeed solRelay;
    GuardedRelayFeed ethRelay;
    uint256          solMid;
    uint256          ethMid;

    address owner  = makeAddr("owner");
    address pusher = makeAddr("pusher");
    address alice  = makeAddr("alice");
    address bob    = makeAddr("bob");
    address carol  = makeAddr("carol");

    uint32  constant ROUND = 3600;
    uint128 constant MIN   = 500_000;
    uint16  constant BAND  = 250;
    uint32  constant AGE   = 25 hours;
    uint80  constant P1    = uint80(1) << 64;

    function setUp() public {
        vm.warp(10);
        vm.startPrank(owner);
        usdc   = new MockUSDC();
        solUsd = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / Chainlink stand-in SOL/USD");
        ethUsd = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / Chainlink stand-in ETH/USD");
        btcUsd = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / Chainlink stand-in BTC/USD");
        solUsd.setPrice(150e8);
        ethUsd.setPrice(3_000e8);
        btcUsd.setPrice(100_000e8);
        solGuard = new RatioGuard(solUsd, btcUsd, AGE, AGE, solUsd.description(), btcUsd.description(), "Matchup ratio guard SOL / BTC");
        ethGuard = new RatioGuard(ethUsd, btcUsd, AGE, AGE, ethUsd.description(), btcUsd.description(), "Matchup ratio guard ETH / BTC");
        solRelay = new GuardedRelayFeed(owner, pusher, solGuard, BAND, "Matchup relay SOL / BTC (TESTNET REHEARSAL)");
        ethRelay = new GuardedRelayFeed(owner, pusher, ethGuard, BAND, "Matchup relay ETH / BTC (TESTNET REHEARSAL)");
        arena = new PredictionArena(address(usdc), owner);
        ethMid = arena.marketCount();
        arena.createMarket("ETH/BTC 1h", address(ethRelay), address(0), ROUND, 50, MIN);
        solMid = arena.marketCount();
        arena.createMarket("SOL/BTC 1h", address(solRelay), address(0), ROUND, 150, MIN);
        vm.stopPrank();
    }

    // ── helpers ──────────────────────────────────────────────

    function _call(uint256 m, address who, bool topWins, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.prank(who);
        usdc.approve(address(arena), amt);
        vm.prank(who);
        arena.placeCall(m, 1, topWins, amt);
    }

    function _setChainlink(MockPriceFeed f, int256 p) internal {
        vm.prank(owner);
        f.setPrice(p);
    }

    /// The runner's push: the guard's own ratio of the Chainlink prices at this moment.
    function _pushGuardRatio(GuardedRelayFeed r, RatioGuard g) internal {
        (, int256 ratio, , , ) = g.latestRoundData();
        vm.prank(pusher);
        r.setPrice(ratio);
    }

    function _round(uint256 m) internal view returns (int256 sp, int256 ep, PredictionArena.RoundState st) {
        (, , , , sp, ep, st) = arena.rounds(m, 1);
    }

    function _invariant() internal view {
        assertGe(usdc.balanceOf(address(arena)), arena.totalPlayerFunds() + arena.feesAccrued(), "balance >= owed + fees");
    }

    // =========================================================
    //  SOL vs BTC
    // =========================================================

    function test_solBtc_marketAndGuard() public view {
        (, int256 ratio, , , ) = solGuard.latestRoundData();
        assertEq(ratio, 15e14, "150 / 100,000 = 0.0015");
        assertEq(solRelay.decimals(), 18);
        assertEq(arena.marketName(solMid), "SOL/BTC 1h");
        assertEq(arena.lockTime(solMid, 1), 150 + 3600);
    }

    /// SOL +2%, BTC +1%: the ratio goes up, so "SOL wins" (UP) wins although both coins rose.
    /// Alice SOL 4, Bob BTC 10, Carol BTC 2: U = 4, D = 12, M = 4, T = 12, F = 0.08, Dist = 3.92.
    /// Alice (smaller side, fully matched): 4 + floor(4_000_000 * 3_920_000 / 4_000_000) = 7.92.
    /// Bob (bigger-side loser): matched ceil(10 * 4 / 12) = ceil(3_333_333.33) = 3_333_334, gets back 6_666_666.
    /// Carol: matched ceil(2 * 4 / 12) = ceil(666_666.67) = 666_667, gets back 1_333_333.
    /// Loser dust: 3_333_334 + 666_667 - 4_000_000 = 1 unit, to fees. Fees 80_000 + 1.
    function test_solBtc_fullRound_solBeatsBtc() public {
        uint256 lt = arena.lockTime(solMid, 1);
        uint256 et = arena.endTime(solMid, 1);
        vm.warp(lt - 100);
        _call(solMid, alice, true, 4_000_000);
        _call(solMid, bob, false, 10_000_000);
        _call(solMid, carol, false, 2_000_000);
        _invariant();

        vm.warp(lt + 3);
        _pushGuardRatio(solRelay, solGuard);                // id 1: start, 0.0015
        vm.warp(et - 60);
        _setChainlink(solUsd, 153e8);                       // SOL +2%
        _setChainlink(btcUsd, 101_000e8);                   // BTC +1%
        _pushGuardRatio(solRelay, solGuard);                // id 2: end
        vm.warp(et + 1);
        arena.settle(solMid, 1, P1 | 1, P1 | 2);

        (int256 sp, int256 ep, PredictionArena.RoundState st) = _round(solMid);
        assertEq(sp, 15e14);
        assertEq(ep, int256(uint256(153e8) * 1e18 / 101_000e8), "153 / 101,000, rounded down");
        assertEq(ep, 1_514_851_485_148_514);
        assertEq(uint256(st), uint256(PredictionArena.RoundState.SettledUp), "SOL won");
        assertEq(arena.feesAccrued(), 80_000);

        vm.prank(alice); arena.claim(solMid, 1);
        vm.prank(bob);   arena.claim(solMid, 1);
        vm.prank(carol); arena.claim(solMid, 1);
        assertEq(usdc.balanceOf(alice), 7_920_000);
        assertEq(usdc.balanceOf(bob),   6_666_666);
        assertEq(usdc.balanceOf(carol), 1_333_333);
        assertEq(arena.feesAccrued(), 80_001, "fee + 1 unit of loser dust");
        assertEq(arena.totalPlayerFunds(), 0);
        assertEq(usdc.balanceOf(address(arena)), 80_001);
        _invariant();
    }

    /// SOL falls 1% while BTC is flat: "BTC wins" (DOWN). Equal sides: M = T = 5, F = 0.10, Dist = 4.90.
    function test_solBtc_fullRound_btcBeatsSol() public {
        uint256 lt = arena.lockTime(solMid, 1);
        uint256 et = arena.endTime(solMid, 1);
        vm.warp(lt - 100);
        _call(solMid, alice, true, 5_000_000);
        _call(solMid, bob, false, 5_000_000);
        vm.warp(lt + 3);
        _pushGuardRatio(solRelay, solGuard);
        vm.warp(et - 60);
        _setChainlink(solUsd, 148.5e8);                     // SOL -1%
        _pushGuardRatio(solRelay, solGuard);
        vm.warp(et + 1);
        arena.settle(solMid, 1, P1 | 1, P1 | 2);
        (, int256 ep, PredictionArena.RoundState st) = _round(solMid);
        assertEq(ep, 1_485e12, "148.5 / 100,000 = 0.001485");
        assertEq(uint256(st), uint256(PredictionArena.RoundState.SettledDown));
        vm.prank(bob); arena.claim(solMid, 1);
        assertEq(usdc.balanceOf(bob), 9_900_000);
        assertEq(arena.claimable(solMid, 1, alice), 0);
        _invariant();
    }

    /// The 2.5% band on a ratio of 0.0015: 0.0015375 is the highest accepted push, one unit more is refused.
    function test_solBtc_bandEdges() public {
        vm.prank(pusher);
        solRelay.setPrice(15e14 + 375e11);
        vm.prank(pusher);
        solRelay.setPrice(15e14 - 375e11);
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.OutsideBand.selector, int256(15e14 + 375e11 + 1), int256(15e14), BAND));
        solRelay.setPrice(15e14 + 375e11 + 1);
    }

    /// Chainlink SOL not updated for over 25 hours (BTC fresh): the SOL/BTC relay refuses, the ETH/BTC relay still works.
    function test_solBtc_staleSol_onlySolPairStops() public {
        vm.warp(10 + AGE + 1);
        _setChainlink(btcUsd, 100_000e8);
        _setChainlink(ethUsd, 3_000e8);
        vm.prank(pusher);
        vm.expectRevert(GuardedRelayFeed.GuardUnavailable.selector);
        solRelay.setPrice(15e14);
        _pushGuardRatio(ethRelay, ethGuard);
    }

    // =========================================================
    //  Both pairs on one arena: claimMany across them
    // =========================================================

    /// One wallet wins SOL/BTC and gets a refund on ETH/BTC (unchanged ratio), and claims both in one call.
    function test_bothPairs_claimManyAcrossMarkets() public {
        uint256 ltE = arena.lockTime(ethMid, 1);
        uint256 ltS = arena.lockTime(solMid, 1);   // 100 s after ETH/BTC's
        uint256 etS = arena.endTime(solMid, 1);
        vm.warp(ltE - 100);
        _call(ethMid, alice, true, 3_000_000);
        _call(ethMid, bob, false, 3_000_000);
        _call(solMid, alice, true, 2_000_000);
        _call(solMid, bob, false, 2_000_000);

        vm.warp(ltE + 3);
        _pushGuardRatio(ethRelay, ethGuard);       // ETH/BTC start 0.03
        vm.warp(ltS + 3);
        _pushGuardRatio(solRelay, solGuard);       // SOL/BTC start 0.0015
        vm.warp(arena.endTime(ethMid, 1) - 60);
        _setChainlink(ethUsd, 3_030e8);            // ETH +1%
        _setChainlink(btcUsd, 101_000e8);          // BTC +1%: ETH/BTC unchanged
        _setChainlink(solUsd, 153e8);              // SOL +2%: SOL/BTC up
        _pushGuardRatio(ethRelay, ethGuard);
        _pushGuardRatio(solRelay, solGuard);
        vm.warp(etS + 1);
        arena.settle(ethMid, 1, P1 | 1, P1 | 2);
        arena.settle(solMid, 1, P1 | 1, P1 | 2);
        (, , PredictionArena.RoundState stE) = _round(ethMid);
        (, , PredictionArena.RoundState stS) = _round(solMid);
        assertEq(uint256(stE), uint256(PredictionArena.RoundState.Refunded), "ETH/BTC unchanged: refund");
        assertEq(uint256(stS), uint256(PredictionArena.RoundState.SettledUp), "SOL/BTC up");

        uint256[] memory ms = new uint256[](2);
        uint256[] memory rs = new uint256[](2);
        (ms[0], ms[1], rs[0], rs[1]) = (ethMid, solMid, 1, 1);
        vm.prank(alice);
        uint256 paid = arena.claimMany(ms, rs);
        // ETH/BTC refund 3 + SOL/BTC win 2 + floor(2 * 1.96 / 2) = 3 + 3.96
        assertEq(paid, 6_960_000);
        assertEq(usdc.balanceOf(alice), 6_960_000);
        vm.prank(bob);
        arena.claim(ethMid, 1);
        assertEq(usdc.balanceOf(bob), 3_000_000);
        assertEq(arena.totalPlayerFunds(), 0);
        assertEq(arena.feesAccrued(), 40_000);
        _invariant();
    }
}
