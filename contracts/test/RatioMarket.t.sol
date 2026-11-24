// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Matchup – a coin-vs-coin market on the UNCHANGED arena
//
//  ETH vs BTC, 1-hour rounds. The pieces, all unchanged except
//  RatioGuard (new):
//    two Chainlink mocks (MockPriceFeed, 8 decimals: ETH/USD, BTC/USD)
//      -> RatioGuard (ETH/USD divided by BTC/USD, 18 decimals)
//      -> GuardedRelayFeed (band 2.5%, the pusher pushes the ratio)
//      -> PredictionArena market "ETH/BTC 1h" (feedA = the relay)
//  UP means "ETH beats BTC": the ratio ended higher than it started,
//  which is exactly "ETH's % move was bigger than BTC's".
//
//  Covers: createMarket, calls on both sides, start and end pushes,
//  settle, claim, the money invariant, a one-sided refund, an
//  unchanged ratio (both coins moved by the same %), a broken
//  Chainlink answer (0) stopping every push so the round refunds,
//  and pushes just inside / just outside the band during a round.
//  Every expected payout is worked out by hand (MatchedCalls rules).
// =============================================================

import {Test}             from "forge-std/Test.sol";
import {PredictionArena}  from "../PredictionArena.sol";
import {GuardedRelayFeed} from "../GuardedRelayFeed.sol";
import {RatioGuard}       from "../RatioGuard.sol";
import {MockPriceFeed}    from "../mocks/MockPriceFeed.sol";
import {MockUSDC}         from "./MockUSDC.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

contract RatioMarketTest is Test {

    PredictionArena  arena;
    MockUSDC         usdc;
    MockPriceFeed    ethUsd;   // Chainlink mock
    MockPriceFeed    btcUsd;   // Chainlink mock
    RatioGuard       guard;
    GuardedRelayFeed relay;
    uint256          mid;

    address owner   = makeAddr("owner");
    address pusher  = makeAddr("pusher");
    address settler = makeAddr("settler");
    address alice   = makeAddr("alice");
    address bob     = makeAddr("bob");
    address carol   = makeAddr("carol");

    uint32  constant ROUND  = 3600;      // 1-hour rounds
    uint32  constant OFFSET = 50;        // the deploy script's ETH/BTC offset
    uint128 constant MIN    = 500_000;   // $0.50
    uint16  constant BAND   = 250;       // 2.5%
    uint80  constant P1     = uint80(1) << 64; // phase 1 of the relay's round ids
    uint32  constant AGE    = 25 hours;  // each Chainlink leg: 24 h heartbeat + 1 h

    function setUp() public {
        vm.warp(10);
        vm.startPrank(owner);
        usdc   = new MockUSDC();
        ethUsd = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / Chainlink stand-in ETH/USD");
        btcUsd = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / Chainlink stand-in BTC/USD");
        ethUsd.setPrice(3_000e8);
        btcUsd.setPrice(100_000e8);
        guard = new RatioGuard(ethUsd, btcUsd, AGE, AGE, ethUsd.description(), btcUsd.description(), "Matchup ratio guard ETH / BTC");
        relay = new GuardedRelayFeed(owner, pusher, guard, BAND, "Matchup relay ETH / BTC (TESTNET REHEARSAL)");
        arena = new PredictionArena(address(usdc), owner);
        mid = arena.marketCount();
        arena.createMarket("ETH/BTC 1h", address(relay), address(0), ROUND, OFFSET, MIN);
        vm.stopPrank();
    }

    // ── helpers ──────────────────────────────────────────────

    function _call(address who, bool ethWins, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.prank(who);
        usdc.approve(address(arena), amt);
        vm.prank(who);
        arena.placeCall(mid, 1, ethWins, amt);
    }

    /// The two Chainlink mocks move (they update at the current block time).
    function _chainlink(int256 eth, int256 btc) internal {
        vm.startPrank(owner);
        ethUsd.setPrice(eth);
        btcUsd.setPrice(btc);
        vm.stopPrank();
    }

    function _push(int256 ratio) internal {
        vm.prank(pusher);
        relay.setPrice(ratio);
    }

    /// The money invariant: the contract always holds what it owes players plus the fees.
    function _invariant() internal view {
        assertGe(usdc.balanceOf(address(arena)), arena.totalPlayerFunds() + arena.feesAccrued(), "balance >= owed + fees");
    }

    /// Runs round 1: a push before the lock (id 1), then the start (id 2) and end (id 3) pushes, each the
    /// guard's own ratio of the Chainlink prices at that moment. Settles with ids 2 and 3.
    function _runRound(int256 ethStart, int256 btcStart, int256 ethEnd, int256 btcEnd) internal {
        uint256 lt = arena.lockTime(mid, 1);
        uint256 et = arena.endTime(mid, 1);
        vm.warp(lt - 30);
        _push(_ratioNow());                                          // id 1: before the lock (not used)
        vm.warp(lt + 5);
        _chainlink(ethStart, btcStart);
        _push(_ratioNow());                                          // id 2: start
        vm.warp(et - 60);
        _chainlink(ethEnd, btcEnd);
        _push(_ratioNow());                                          // id 3: end
        vm.warp(et + 1);
        vm.prank(settler);
        arena.settle(mid, 1, P1 | 2, P1 | 3);
    }

    function _ratioNow() internal view returns (int256 r) {
        (, r, , , ) = guard.latestRoundData();
    }

    function _round() internal view returns (uint128 up, uint128 down, int256 sp, int256 ep, PredictionArena.RoundState st) {
        (up, down, , , sp, ep, st) = arena.rounds(mid, 1);
    }

    // =========================================================
    //  The market
    // =========================================================

    function test_createMarket_ethVsBtc1h() public view {
        (AggregatorV3Interface feedA, AggregatorV3Interface feedB, uint32 len, uint32 off, uint128 minStake, bool paused) = arena.markets(mid);
        assertEq(address(feedA), address(relay));
        assertEq(address(feedB), address(0), "one feed: the ratio relay");
        assertEq(len, 3600);
        assertEq(off, OFFSET);
        assertEq(minStake, MIN);
        assertFalse(paused);
        assertEq(arena.marketName(mid), "ETH/BTC 1h");
        assertEq(relay.decimals(), 18);
        assertEq(arena.lockTime(mid, 1), uint256(OFFSET) + 3600);
    }

    function test_callWindow_isTheNextRound() public {
        vm.warp(arena.lockTime(mid, 1) - 100);
        assertEq(arena.nextCallableRound(mid), 1);
    }

    // =========================================================
    //  Full rounds
    // =========================================================

    /// ETH +1%, BTC flat: the ratio goes up, so "ETH wins" (UP) wins.
    /// Alice ETH 10, Bob BTC 6: M = 6, F = 0.12, Dist = 5.88. Alice gets 10 + 5.88 = 15.88, Bob nothing.
    function test_fullRound_ethBeatsBtc() public {
        vm.warp(arena.lockTime(mid, 1) - 100);
        _call(alice, true, 10_000_000);
        _call(bob, false, 6_000_000);
        _invariant();

        _runRound(3_000e8, 100_000e8, 3_030e8, 100_000e8);
        (, , int256 sp, int256 ep, PredictionArena.RoundState st) = _round();
        assertEq(sp, 3e16, "start ratio 0.03");
        assertEq(ep, 3.03e16, "end ratio 0.0303");
        assertEq(uint256(st), uint256(PredictionArena.RoundState.SettledUp), "ETH won");
        assertEq(arena.feesAccrued(), 120_000);
        _invariant();

        vm.prank(alice);
        arena.claim(mid, 1);
        assertEq(usdc.balanceOf(alice), 15_880_000);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.NothingToClaim.selector, mid, 1));
        arena.claim(mid, 1);
        assertEq(arena.totalPlayerFunds(), 0);
        assertEq(usdc.balanceOf(address(arena)), 120_000);
        _invariant();
    }

    /// Both coins go up, BTC by more (ETH +1%, BTC +3%): the ratio falls, so "BTC wins" (DOWN) wins
    /// even though ETH's price rose. Alice ETH 5, Bob BTC 5, Carol BTC 3: M = 5 (UP), T = 8 (DOWN).
    /// F = 0.10, Dist = 4.90. Bob: matched floor(5*5/8) = 3.125 -> 3_125_000, bonus floor(3_125_000*4_900_000/5_000_000) = 3_062_500,
    /// pays 5 + 3.0625 = 8.0625. Carol: matched floor(3*5/8) = 1_875_000, bonus 1_837_500, pays 4.8375.
    function test_fullRound_btcBeatsEth_bothUp() public {
        vm.warp(arena.lockTime(mid, 1) - 100);
        _call(alice, true, 5_000_000);
        _call(bob, false, 5_000_000);
        _call(carol, false, 3_000_000);

        _runRound(3_000e8, 100_000e8, 3_030e8, 103_000e8);
        (, , int256 sp, int256 ep, PredictionArena.RoundState st) = _round();
        assertLt(ep, sp, "ratio fell");
        assertEq(uint256(st), uint256(PredictionArena.RoundState.SettledDown), "BTC won");

        vm.prank(bob);
        arena.claim(mid, 1);
        vm.prank(carol);
        arena.claim(mid, 1);
        assertEq(usdc.balanceOf(bob), 8_062_500);
        assertEq(usdc.balanceOf(carol), 4_837_500);
        assertEq(arena.claimable(mid, 1, alice), 0, "ETH caller lost its matched stake");
        _invariant();
    }

    /// ETH +2% and BTC +2%: the ratio is exactly the same at the end, so the round refunds (price unchanged), no fee.
    function test_ratioUnchanged_refundsEveryone() public {
        vm.warp(arena.lockTime(mid, 1) - 100);
        _call(alice, true, 4_000_000);
        _call(bob, false, 2_000_000);

        _runRound(3_000e8, 100_000e8, 3_060e8, 102_000e8);
        (, , int256 sp, int256 ep, PredictionArena.RoundState st) = _round();
        assertEq(sp, ep, "3060 / 102000 is exactly 0.03, like 3000 / 100000");
        assertEq(uint256(st), uint256(PredictionArena.RoundState.Refunded));
        assertEq(arena.feesAccrued(), 0, "a refund takes no fee");

        vm.prank(alice);
        arena.claim(mid, 1);
        vm.prank(bob);
        arena.claim(mid, 1);
        assertEq(usdc.balanceOf(alice), 4_000_000);
        assertEq(usdc.balanceOf(bob), 2_000_000);
        assertEq(arena.totalPlayerFunds(), 0);
        _invariant();
    }

    /// Calls on one side only: refunded without looking at any price (ids 0), full stake back.
    function test_oneSided_refund() public {
        vm.warp(arena.lockTime(mid, 1) - 100);
        _call(alice, true, 3_000_000);
        _call(carol, true, 1_000_000);
        vm.warp(arena.endTime(mid, 1) + 1);
        vm.prank(settler);
        arena.settle(mid, 1, 0, 0);
        (, , , , PredictionArena.RoundState st) = _round();
        assertEq(uint256(st), uint256(PredictionArena.RoundState.Refunded));
        vm.prank(alice);
        arena.claim(mid, 1);
        vm.prank(carol);
        arena.claim(mid, 1);
        assertEq(usdc.balanceOf(alice), 3_000_000);
        assertEq(usdc.balanceOf(carol), 1_000_000);
        assertEq(arena.feesAccrued(), 0);
        assertEq(arena.totalPlayerFunds(), 0);
        _invariant();
    }

    /// Chainlink's BTC answer goes to 0 after the lock: the relay refuses every push, the round has no start price,
    /// and it refunds (no update since lock). Nobody loses money.
    function test_chainlinkZero_noPush_roundRefunds() public {
        uint256 lt = arena.lockTime(mid, 1);
        vm.warp(lt - 100);
        _call(alice, true, 2_000_000);
        _call(bob, false, 2_000_000);
        vm.warp(lt - 30);
        _push(_ratioNow()); // id 1, before the lock
        vm.warp(lt + 5);
        vm.prank(owner);
        btcUsd.setPrice(0);
        vm.prank(pusher);
        vm.expectRevert(GuardedRelayFeed.GuardUnavailable.selector);
        relay.setPrice(3e16);

        vm.warp(arena.endTime(mid, 1) + 1);
        vm.prank(settler);
        arena.settle(mid, 1, 0, 0); // "no update since the lock" is accepted because the latest update is before the lock
        (, , , , PredictionArena.RoundState st) = _round();
        assertEq(uint256(st), uint256(PredictionArena.RoundState.Refunded));
        vm.prank(alice);
        arena.claim(mid, 1);
        assertEq(usdc.balanceOf(alice), 2_000_000);
        _invariant();
    }

    /// A negative Chainlink answer is refused the same way.
    function test_chainlinkNegative_pushRefused() public {
        vm.prank(owner);
        ethUsd.setPrice(-3_000e8);
        vm.prank(pusher);
        vm.expectRevert(GuardedRelayFeed.GuardUnavailable.selector);
        relay.setPrice(3e16);
    }

    /// A stale Chainlink leg (BTC not updated for over 25 hours, its own limit in the guard) stops the relay;
    /// ETH alone being fresh is not enough.
    function test_staleChainlink_pushRefused() public {
        vm.warp(10 + AGE);
        vm.prank(owner);
        ethUsd.setPrice(3_000e8); // fresh ETH
        _push(3e16);              // BTC exactly 25 h old: accepted
        vm.warp(10 + AGE + 1);
        vm.prank(pusher);
        vm.expectRevert(GuardedRelayFeed.GuardUnavailable.selector);
        relay.setPrice(3e16);
    }

    /// During a round the pusher's ratio may differ from Chainlink's by at most 2.5% (inclusive), never more.
    function test_band_justInside_justOutside() public {
        // guard 0.03: 2.5% is 0.00075, so 0.03075 is the highest and 0.02925 the lowest accepted
        _push(3.075e16);
        _push(2.925e16);
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.OutsideBand.selector, int256(3.075e16 + 1), int256(3e16), BAND));
        relay.setPrice(3.075e16 + 1);
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.OutsideBand.selector, int256(2.925e16 - 1), int256(3e16), BAND));
        relay.setPrice(2.925e16 - 1);
    }

    /// Only the pusher can push a ratio.
    function test_onlyPusher() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.NotPusher.selector, alice, pusher));
        relay.setPrice(3e16);
    }

    /// Fuzz: any ETH and BTC moves of up to +-20% settle the way the % moves say (or refund when equal),
    /// and the money invariant holds after every claim.
    function testFuzz_outcomeFollowsPercentMoves(uint256 ethBps, uint256 btcBps) public {
        ethBps = bound(ethBps, 8_000, 12_000); // 0.80x .. 1.20x
        btcBps = bound(btcBps, 8_000, 12_000);
        vm.warp(arena.lockTime(mid, 1) - 100);
        _call(alice, true, 1_000_000);
        _call(bob, false, 1_000_000);
        int256 ethEnd = int256(3_000e8 * ethBps / 10_000);
        int256 btcEnd = int256(100_000e8 * btcBps / 10_000);
        _runRound(3_000e8, 100_000e8, ethEnd, btcEnd);
        (, , , , PredictionArena.RoundState st) = _round();
        // compare the % moves directly: ethEnd/3000 vs btcEnd/100000, i.e. ethEnd*100000 vs btcEnd*3000
        int256 a = ethEnd * 100_000;
        int256 b = btcEnd * 3_000;
        if (a > b) assertEq(uint256(st), uint256(PredictionArena.RoundState.SettledUp));
        else if (a < b) assertEq(uint256(st), uint256(PredictionArena.RoundState.SettledDown));
        else assertEq(uint256(st), uint256(PredictionArena.RoundState.Refunded));
        if (arena.claimable(mid, 1, alice) > 0) { vm.prank(alice); arena.claim(mid, 1); }
        if (arena.claimable(mid, 1, bob) > 0) { vm.prank(bob); arena.claim(mid, 1); }
        _invariant();
        assertEq(arena.totalPlayerFunds(), 0);
    }
}
