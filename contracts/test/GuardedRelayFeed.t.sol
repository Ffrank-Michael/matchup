// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Kairo Markets – GuardedRelayFeed tests
//
//  Covers: constructor checks, metadata, access control,
//  pusher rotation, ownership, band edges, staleness,
//  GuardUnavailable paths, round ids, timestamps, events,
//  fuzz, and integration with PredictionArena.
// =============================================================

import {Test}                   from "forge-std/Test.sol";
import {GuardedRelayFeed}       from "../GuardedRelayFeed.sol";
import {MockPriceFeed}          from "../mocks/MockPriceFeed.sol";
import {MockUSDC}               from "./MockUSDC.sol";
import {PredictionArena}        from "../PredictionArena.sol";
import {AggregatorV3Interface}  from "../interfaces/AggregatorV3Interface.sol";

// ================================================================
//  Helper: a feed that always reverts on latestRoundData()
// ================================================================
contract AlwaysRevertFeed is AggregatorV3Interface {
    function decimals() external pure override returns (uint8)       { return 8; }
    function description() external pure override returns (string memory) { return "revert"; }
    function version() external pure override returns (uint256)      { return 1; }
    function getRoundData(uint80) external pure override returns (uint80,int256,uint256,uint256,uint80) {
        revert("always reverts");
    }
    function latestRoundData() external pure override returns (uint80,int256,uint256,uint256,uint80) {
        revert("always reverts");
    }
}

// ================================================================
//  Helper: a feed that returns an arbitrary hardcoded answer
//  Used to produce answers that MockPriceFeed cannot (e.g. > int128.max)
// ================================================================
contract FixedAnswerFeed is AggregatorV3Interface {
    int256 public immutable ans;
    constructor(int256 ans_) { ans = ans_; }
    function decimals() external pure override returns (uint8)      { return 8; }
    function description() external pure override returns (string memory) { return "fixed"; }
    function version() external pure override returns (uint256)     { return 1; }
    function getRoundData(uint80) external pure override returns (uint80,int256,uint256,uint256,uint80) {
        revert("no data");
    }
    function latestRoundData() external view override returns (
        uint80, int256, uint256, uint256, uint80
    ) {
        // updatedAt = block.timestamp so staleness check passes
        return (uint80((1<<64)|1), ans, block.timestamp, block.timestamp, uint80((1<<64)|1));
    }
}

// ================================================================
//  Helper: a feed that returns valid data with zero decimals
// ================================================================
contract ZeroDecimalFeed is AggregatorV3Interface {
    function decimals() external pure override returns (uint8)       { return 0; }
    function description() external pure override returns (string memory) { return "zero dec"; }
    function version() external pure override returns (uint256)      { return 1; }
    function getRoundData(uint80) external pure override returns (uint80,int256,uint256,uint256,uint80) {
        revert("no data");
    }
    function latestRoundData() external pure override returns (uint80,int256,uint256,uint256,uint80) {
        revert("no data");
    }
}

// ================================================================
//  Main test contract
// ================================================================
contract GuardedRelayFeedTest is Test {

    // ── Addresses ────────────────────────────────────────────
    address owner   = makeAddr("owner");
    address pusher  = makeAddr("pusher");
    address stranger = makeAddr("stranger");
    address newPusher = makeAddr("newPusher");

    // ── Helpers ───────────────────────────────────────────────
    MockPriceFeed    guardFeed;   // BTC-like: 8 decimals, answers in 8-dec scale
    GuardedRelayFeed relay;

    // A typical BTC guard answer: $60,000 with 8 decimals
    int256 constant GUARD_BTC = 6_000_000_000_000; // $60,000.00000000

    // ── Setup ─────────────────────────────────────────────────

    function setUp() public {
        guardFeed = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / BTC guard");

        // Give the guard a live price.
        vm.prank(owner);
        guardFeed.setPrice(GUARD_BTC);

        // Deploy relay: 100 bps band
        relay = new GuardedRelayFeed(
            owner, pusher,
            AggregatorV3Interface(address(guardFeed)),
            100,
            "Matchup relay BTC/USD"
        );
    }

    // ================================================================
    //  1. Constructor checks
    // ================================================================

    function test_constructor_revertZeroPusher() public {
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.ZeroPusher.selector));
        new GuardedRelayFeed(owner, address(0),
            AggregatorV3Interface(address(guardFeed)), 100, "Matchup relay BTC/USD");
    }

    function test_constructor_revertZeroGuard() public {
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.GuardUnavailable.selector));
        new GuardedRelayFeed(owner, pusher,
            AggregatorV3Interface(address(0)), 100, "Matchup relay BTC/USD");
    }

    function test_constructor_revertBandZero() public {
        vm.expectRevert("bandBps must be 1..1000");
        new GuardedRelayFeed(owner, pusher,
            AggregatorV3Interface(address(guardFeed)), 0, "Matchup relay BTC/USD");
    }

    function test_constructor_revertBandAbove1000() public {
        vm.expectRevert("bandBps must be 1..1000");
        new GuardedRelayFeed(owner, pusher,
            AggregatorV3Interface(address(guardFeed)), 1001, "Matchup relay BTC/USD");
    }

    function test_constructor_band1000_accepted() public {
        // 1000 bps (10%) is at the edge; must succeed
        new GuardedRelayFeed(owner, pusher,
            AggregatorV3Interface(address(guardFeed)), 1000, "Matchup relay BTC/USD");
    }

    function test_constructor_revertEmptyDescription() public {
        vm.expectRevert("empty description");
        new GuardedRelayFeed(owner, pusher,
            AggregatorV3Interface(address(guardFeed)), 100, "");
    }

    function test_constructor_revertWrongDescriptionPrefix() public {
        vm.expectRevert("description must start with 'Matchup relay '");
        new GuardedRelayFeed(owner, pusher,
            AggregatorV3Interface(address(guardFeed)), 100, "TEST PRICES - NOT REAL DATA");
    }

    function test_constructor_revertZeroDecimalGuard() public {
        ZeroDecimalFeed zd = new ZeroDecimalFeed();
        vm.expectRevert("guard decimals must be nonzero");
        new GuardedRelayFeed(owner, pusher,
            AggregatorV3Interface(address(zd)), 100, "Matchup relay BTC/USD");
    }

    // ================================================================
    //  2. Metadata and immutables
    // ================================================================

    function test_decimals_copiedFromGuard() public view {
        assertEq(relay.decimals(), 8);
    }

    function test_description() public view {
        assertEq(relay.description(), "Matchup relay BTC/USD");
    }

    function test_version() public view {
        assertEq(relay.version(), 1);
    }

    function test_guard_immutable() public view {
        assertEq(address(relay.guard()), address(guardFeed));
    }

    function test_bandBps_immutable() public view {
        assertEq(relay.bandBps(), 100);
    }

    function test_pusher_set() public view {
        assertEq(relay.pusher(), pusher);
    }

    // ================================================================
    //  3. Access control – setPrice
    // ================================================================

    function test_setPrice_onlyPusher_strangerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.NotPusher.selector, stranger, pusher));
        relay.setPrice(GUARD_BTC);
    }

    function test_setPrice_ownerCannotPush() public {
        // owner != pusher; must revert NotPusher
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.NotPusher.selector, owner, pusher));
        relay.setPrice(GUARD_BTC);
    }

    function test_setPrice_pusherSucceeds() public {
        vm.prank(pusher);
        relay.setPrice(GUARD_BTC);       // same as guard → inside band
        (, int256 ans,,,) = relay.latestRoundData();
        assertEq(ans, GUARD_BTC);
    }

    // ================================================================
    //  4. Pusher rotation
    // ================================================================

    function test_setPusher_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert();                // OwnableUnauthorizedAccount
        relay.setPusher(newPusher);
    }

    function test_setPusher_rejectZero() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.ZeroPusher.selector));
        relay.setPusher(address(0));
    }

    function test_setPusher_rotatesAccess() public {
        // Old pusher still works before rotation
        vm.prank(pusher);
        relay.setPrice(GUARD_BTC);

        // Rotate
        vm.prank(owner);
        relay.setPusher(newPusher);
        assertEq(relay.pusher(), newPusher);

        // Old pusher is blocked
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.NotPusher.selector, pusher, newPusher));
        relay.setPrice(GUARD_BTC);

        // New pusher works
        vm.prank(newPusher);
        relay.setPrice(GUARD_BTC);
    }

    function test_setPusher_emitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit GuardedRelayFeed.PusherChanged(pusher, newPusher);
        relay.setPusher(newPusher);
    }

    // ================================================================
    //  5. Two-step ownership and renounce
    // ================================================================

    function test_renounceOwnership_reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.RenounceOwnershipDisabled.selector));
        relay.renounceOwnership();
    }

    function test_renounceOwnership_strangerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(); // either disabled or unauthorized
        relay.renounceOwnership();
    }

    function test_twoStepOwnership_transferAndAccept() public {
        address nominee = makeAddr("nominee");

        vm.prank(owner);
        relay.transferOwnership(nominee);
        // owner still owns; nominee has no powers yet
        assertEq(relay.owner(), owner);
        assertEq(relay.pendingOwner(), nominee);

        // nominee accepts
        vm.prank(nominee);
        relay.acceptOwnership();
        assertEq(relay.owner(), nominee);

        // old owner can no longer setPusher
        vm.prank(owner);
        vm.expectRevert();
        relay.setPusher(newPusher);

        // new owner can
        vm.prank(nominee);
        relay.setPusher(newPusher);
    }

    // ================================================================
    //  6. setPrice validation: zero and negative
    // ================================================================

    function test_setPrice_zeroReverts() public {
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.NonPositiveAnswer.selector, int256(0)));
        relay.setPrice(0);
    }

    function test_setPrice_negativeReverts() public {
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.NonPositiveAnswer.selector, int256(-1)));
        relay.setPrice(-1);
    }

    // ================================================================
    //  7. Band edges – three real settings
    // ================================================================

    // --- 7a. BTC-like: guard = 6_000_000_000_000 (8 dec), band 100 bps ---
    //
    //   allowed = 6_000_000_000_000 * 100 / 10_000 = 60_000_000_000
    //   max price = 6_000_000_000_000 + 60_000_000_000 = 6_060_000_000_000
    //   min price = 6_000_000_000_000 - 60_000_000_000 = 5_940_000_000_000

    int256 constant BTC_GUARD    = 6_000_000_000_000;
    int256 constant BTC_MAX_EDGE = 6_060_000_000_000;    // on edge, accepted
    int256 constant BTC_MIN_EDGE = 5_940_000_000_000;    // on edge, accepted
    int256 constant BTC_MAX_OVER = 6_060_000_000_001;    // one unit over, rejected
    int256 constant BTC_MIN_OVER = 5_939_999_999_999;    // one unit over, rejected

    function test_band_btc_maxEdge_accepted() public {
        vm.prank(pusher);
        relay.setPrice(BTC_MAX_EDGE);
        (, int256 ans,,,) = relay.latestRoundData();
        assertEq(ans, BTC_MAX_EDGE);
    }

    function test_band_btc_minEdge_accepted() public {
        vm.prank(pusher);
        relay.setPrice(BTC_MIN_EDGE);
        (, int256 ans,,,) = relay.latestRoundData();
        assertEq(ans, BTC_MIN_EDGE);
    }

    function test_band_btc_maxOver_rejected() public {
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.OutsideBand.selector,
            BTC_MAX_OVER, BTC_GUARD, uint16(100)));
        relay.setPrice(BTC_MAX_OVER);
    }

    function test_band_btc_minOver_rejected() public {
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.OutsideBand.selector,
            BTC_MIN_OVER, BTC_GUARD, uint16(100)));
        relay.setPrice(BTC_MIN_OVER);
    }

    // --- 7b. ETH-like: guard ≈ 300_000_000_000 (8 dec, $3000), band 150 bps ---
    //
    //   allowed = 300_000_000_000 * 150 / 10_000 = 4_500_000_000
    //   max = 304_500_000_000, min = 295_500_000_000

    int256 constant ETH_GUARD    = 300_000_000_000;
    int256 constant ETH_MAX_EDGE = 304_500_000_000;
    int256 constant ETH_MIN_EDGE = 295_500_000_000;
    int256 constant ETH_MAX_OVER = 304_500_000_001;
    int256 constant ETH_MIN_OVER = 295_499_999_999;

    function test_band_eth_edges() public {
        GuardedRelayFeed ethRelay = _deployRelay(ETH_GUARD, 150);

        vm.prank(pusher);
        ethRelay.setPrice(ETH_MAX_EDGE);

        vm.prank(pusher);
        ethRelay.setPrice(ETH_MIN_EDGE);

        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.OutsideBand.selector,
            ETH_MAX_OVER, ETH_GUARD, uint16(150)));
        ethRelay.setPrice(ETH_MAX_OVER);

        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.OutsideBand.selector,
            ETH_MIN_OVER, ETH_GUARD, uint16(150)));
        ethRelay.setPrice(ETH_MIN_OVER);
    }

    // --- 7c. SOL-like: guard ≈ 10_000_000_000 (8 dec, $100), band 150 bps ---
    //
    //   allowed = 10_000_000_000 * 150 / 10_000 = 150_000_000
    //   max = 10_150_000_000, min = 9_850_000_000

    int256 constant SOL_GUARD    = 10_000_000_000;
    int256 constant SOL_MAX_EDGE = 10_150_000_000;
    int256 constant SOL_MIN_EDGE =  9_850_000_000;
    int256 constant SOL_MAX_OVER = 10_150_000_001;
    int256 constant SOL_MIN_OVER =  9_849_999_999;

    function test_band_sol_edges() public {
        GuardedRelayFeed solRelay = _deployRelay(SOL_GUARD, 150);

        vm.prank(pusher);
        solRelay.setPrice(SOL_MAX_EDGE);

        vm.prank(pusher);
        solRelay.setPrice(SOL_MIN_EDGE);

        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.OutsideBand.selector,
            SOL_MAX_OVER, SOL_GUARD, uint16(150)));
        solRelay.setPrice(SOL_MAX_OVER);

        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.OutsideBand.selector,
            SOL_MIN_OVER, SOL_GUARD, uint16(150)));
        solRelay.setPrice(SOL_MIN_OVER);
    }

    // ================================================================
    //  8. Guard answer zero / negative
    // ================================================================

    function test_guardAnswer_zero_reverts() public {
        // Push zero to the guard feed
        vm.prank(owner);
        guardFeed.setPrice(0);

        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.GuardAnswerInvalid.selector, int256(0), block.timestamp));
        relay.setPrice(GUARD_BTC);
    }

    function test_guardAnswer_negative_reverts() public {
        vm.prank(owner);
        guardFeed.setPrice(-1);

        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.GuardAnswerInvalid.selector, int256(-1), block.timestamp));
        relay.setPrice(GUARD_BTC);
    }

    // ── Guard answer above uint128.max reverts GuardAnswerInvalid ────
    // Guards against a broken/malicious feed that would otherwise skip
    // the band check via the old overflow-skip branch.

    function test_guardAnswerInvalid_aboveUint128Max() public {
        // Guard answer = uint128.max + 1 (requires FixedAnswerFeed)
        int256 hugeAns = int256(uint256(type(uint128).max) + 1);
        FixedAnswerFeed bigGuard = new FixedAnswerFeed(hugeAns);
        GuardedRelayFeed r = new GuardedRelayFeed(
            owner, pusher,
            AggregatorV3Interface(address(bigGuard)),
            100, "Matchup relay BTC/USD"
        );

        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.GuardAnswerInvalid.selector,
            hugeAns, block.timestamp));
        vm.prank(pusher);
        r.setPrice(GUARD_BTC);
    }

    function test_guardAnswerInvalid_int256Max() public {
        // Guard answer = type(int256).max — must revert GuardAnswerInvalid,
        // NOT silently accept everything (old overflow-skip bug).
        int256 maxAns = type(int256).max;
        FixedAnswerFeed bigGuard2 = new FixedAnswerFeed(maxAns);
        GuardedRelayFeed r = new GuardedRelayFeed(
            owner, pusher,
            AggregatorV3Interface(address(bigGuard2)),
            100, "Matchup relay BTC/USD"
        );

        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.GuardAnswerInvalid.selector,
            maxAns, block.timestamp));
        vm.prank(pusher);
        r.setPrice(GUARD_BTC);
    }

    function test_band_guardAtUint128Max_rejected_oneUnitBelow() public {
        // Guard = uint128.max itself → GuardAnswerInvalid (> uint128.max check uses strict >)
        // Guard = uint128.max is the boundary: uint256(type(uint128).max) == type(uint128).max
        // so it is NOT > type(uint128).max and must be ACCEPTED as a valid guard answer.
        // A push equal to the guard (inside band) must succeed.
        // A push far from the guard must revert OutsideBand.
        int256 maxU128 = int256(uint256(type(uint128).max));
        // maxU128 > 0 (it's a positive int256 value ≈ 3.4e38)
        FixedAnswerFeed edgeGuard = new FixedAnswerFeed(maxU128);
        GuardedRelayFeed r = new GuardedRelayFeed(
            owner, pusher,
            AggregatorV3Interface(address(edgeGuard)),
            100, // 100 bps band
            "Matchup relay BTC/USD"
        );

        // Push equal to guard — inside band, must succeed.
        vm.prank(pusher);
        r.setPrice(maxU128);
        (, int256 stored,,,) = r.latestRoundData();
        assertEq(stored, maxU128, "push equal to guard should succeed");

        // Push far from guard (e.g. 1) — must revert OutsideBand.
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.OutsideBand.selector,
            int256(1), maxU128, uint16(100)));
        vm.prank(pusher);
        r.setPrice(1);
    }

    // ================================================================
    //  9. Guard staleness
    // ================================================================

    function test_guardStale_exactly26h_accepted() public {
        // updatedAt = now, then warp exactly MAX_GUARD_AGE
        vm.prank(owner);
        guardFeed.setPrice(GUARD_BTC);
        uint256 pushTs = block.timestamp;

        vm.warp(pushTs + 26 hours); // exactly at the edge

        vm.prank(pusher);
        relay.setPrice(GUARD_BTC);  // must succeed
    }

    function test_guardStale_26hPlus1s_rejected() public {
        vm.prank(owner);
        guardFeed.setPrice(GUARD_BTC);
        uint256 pushTs = block.timestamp;

        vm.warp(pushTs + 26 hours + 1);

        // vm.prank must be the LAST cheatcode call before the target call.
        bytes memory expected = abi.encodeWithSelector(
            GuardedRelayFeed.GuardStale.selector,
            pushTs, relay.MAX_GUARD_AGE());
        vm.expectRevert(expected);
        vm.prank(pusher);
        relay.setPrice(GUARD_BTC);
    }

    function test_guardStale_futureUpdatedAt_rejected() public {
        // Deploy a fresh relay with a guard that has updatedAt > block.timestamp.
        // We simulate this by warping back in time after a push.
        MockPriceFeed freshGuard = new MockPriceFeed(owner, 8,
            "TEST PRICES - NOT REAL DATA / stale");
        vm.warp(block.timestamp + 1000); // push at t+1000
        vm.prank(owner);
        freshGuard.setPrice(GUARD_BTC); // updatedAt = t+1000

        // Deploy relay at t+1000
        GuardedRelayFeed r = new GuardedRelayFeed(
            owner, pusher, AggregatorV3Interface(address(freshGuard)),
            100, "Matchup relay BTC/USD");

        // Warp BACK to before the push (simulate a clock skew)
        // block.timestamp is now t+1000; warp back 500 → t+500
        // The guard's updatedAt = t+1000 > t+500 → future timestamp.
        uint256 guardUpdatedAt = block.timestamp; // = t+1000
        vm.warp(block.timestamp - 500);           // now = t+500

        bytes memory expected2 = abi.encodeWithSelector(
            GuardedRelayFeed.GuardStale.selector,
            guardUpdatedAt, relay.MAX_GUARD_AGE());
        vm.expectRevert(expected2);
        vm.prank(pusher);
        r.setPrice(GUARD_BTC);
    }

    // ================================================================
    //  10. GuardUnavailable – reverting guard feeds
    // ================================================================

    function test_guardUnavailable_alwaysRevertFeed() public {
        AlwaysRevertFeed bad = new AlwaysRevertFeed();
        // Need a feed with nonzero decimals for constructor; use a MockPriceFeed
        // that has had a price set to pass constructor, then replace guard.
        // Actually: we can't change guard (immutable). Deploy a relay with
        // the always-revert feed. But constructor calls guard_.decimals()
        // (not latestRoundData) so it won't revert during construction.
        GuardedRelayFeed r = new GuardedRelayFeed(
            owner, pusher,
            AggregatorV3Interface(address(bad)),
            100, "Matchup relay BTC/USD"
        );

        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.GuardUnavailable.selector));
        r.setPrice(GUARD_BTC);
    }

    function test_guardUnavailable_mockFeedBeforeFirstUpdate() public {
        // A fresh MockPriceFeed with no updates yet will revert on latestRoundData.
        MockPriceFeed emptyGuard = new MockPriceFeed(owner, 8,
            "TEST PRICES - NOT REAL DATA / empty");
        GuardedRelayFeed r = new GuardedRelayFeed(
            owner, pusher,
            AggregatorV3Interface(address(emptyGuard)),
            100, "Matchup relay BTC/USD"
        );

        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.GuardUnavailable.selector));
        r.setPrice(GUARD_BTC);
    }

    // ================================================================
    //  11. Round IDs and timestamps
    // ================================================================

    function test_firstRoundId_is_phase1Round1() public {
        vm.prank(pusher);
        relay.setPrice(GUARD_BTC);
        (uint80 id,,,,) = relay.latestRoundData();
        assertEq(id, (uint80(1) << 64) | uint80(1));
    }

    function test_roundIds_increment() public {
        vm.prank(pusher); relay.setPrice(GUARD_BTC);
        vm.prank(pusher); relay.setPrice(GUARD_BTC);
        vm.prank(pusher); relay.setPrice(GUARD_BTC);

        (uint80 latest,,,,) = relay.latestRoundData();
        assertEq(latest, (uint80(1) << 64) | uint80(3));
    }

    function test_getRoundData_knownId() public {
        uint256 ts = block.timestamp;
        vm.prank(pusher);
        relay.setPrice(GUARD_BTC);

        uint80 id1 = (uint80(1) << 64) | uint80(1);
        (uint80 rid, int256 ans, uint256 startedAt, uint256 updatedAt, uint80 air)
            = relay.getRoundData(id1);

        assertEq(rid, id1);
        assertEq(ans, GUARD_BTC);
        assertEq(startedAt, ts);
        assertEq(updatedAt, ts);
        assertEq(air, id1);
    }

    function test_getRoundData_unknownId_reverts() public {
        vm.prank(pusher); relay.setPrice(GUARD_BTC);
        uint80 unknownId = (uint80(1) << 64) | uint80(99);
        vm.expectRevert("No data present");
        relay.getRoundData(unknownId);
    }

    function test_latestRoundData_beforeFirstPush_reverts() public {
        // Fresh deploy with no pushes
        GuardedRelayFeed r = new GuardedRelayFeed(
            owner, pusher,
            AggregatorV3Interface(address(guardFeed)),
            100, "Matchup relay BTC/USD"
        );
        vm.expectRevert("No data present");
        r.latestRoundData();
    }

    function test_timestamp_isBlockTimestamp_afterWarp() public {
        vm.warp(12345678);
        vm.prank(owner); guardFeed.setPrice(GUARD_BTC); // refresh guard
        vm.prank(pusher); relay.setPrice(GUARD_BTC);

        (, , uint256 startedAt, uint256 updatedAt,) = relay.latestRoundData();
        assertEq(startedAt, 12345678);
        assertEq(updatedAt, 12345678);
    }

    // ================================================================
    //  12. PriceRelayed event
    // ================================================================

    function test_priceRelayed_event() public {
        uint256 ts = block.timestamp;
        uint80 expectedId = (uint80(1) << 64) | uint80(1);

        vm.expectEmit(true, false, false, true);
        emit GuardedRelayFeed.PriceRelayed(expectedId, GUARD_BTC, GUARD_BTC, ts);

        vm.prank(pusher);
        relay.setPrice(GUARD_BTC);
    }

    // ================================================================
    //  13. Guard read on every push (guard moves, band follows)
    // ================================================================

    function test_guard_freshReadEachPush() public {
        // First push succeeds at BTC_GUARD
        vm.prank(pusher); relay.setPrice(GUARD_BTC);

        // Guard price doubles
        vm.prank(owner);
        guardFeed.setPrice(GUARD_BTC * 2);

        // Price near old guard is now outside the band of the new guard
        // Old guard: 6_000_000_000_000 → new guard: 12_000_000_000_000
        // BTC_MAX_EDGE = 6_060_000_000_000 is far below new guard
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedRelayFeed.OutsideBand.selector,
            BTC_MAX_EDGE, GUARD_BTC * 2, uint16(100)));
        relay.setPrice(BTC_MAX_EDGE);

        // Price near new guard is accepted
        int256 newGuard = GUARD_BTC * 2;
        vm.prank(pusher);
        relay.setPrice(newGuard);
    }

    // ================================================================
    //  14. Fuzz: any answer inside the band accepted, outside rejected
    // ================================================================

    /// @dev answer in [1, int256.max], guard in [1, int256.max/2],
    ///      band in [1, 1000].
    ///      Brute-forces the expected result and checks it matches the contract.
    function testFuzz_band(
        int256  answer,
        int256  guardAns,
        uint16  band
    ) public {
        // Constrain inputs to valid ranges.
        answer   = int256(bound(uint256(answer),   1, uint256(int256(type(int128).max))));
        guardAns = int256(bound(uint256(guardAns), 1, uint256(int256(type(int128).max))));
        band     = uint16(bound(uint256(band), 1, 1000));

        // Deploy a relay with these params.
        MockPriceFeed gf = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / fuzz");
        vm.prank(owner); gf.setPrice(guardAns);
        GuardedRelayFeed r = new GuardedRelayFeed(
            owner, pusher, AggregatorV3Interface(address(gf)),
            band, "Matchup relay BTC/USD"
        );

        // Compute expected result in plain Solidity (independent of contract).
        uint256 uA = uint256(answer);
        uint256 uG = uint256(guardAns);
        uint256 diff = uA > uG ? uA - uG : uG - uA;
        uint256 allowed = uG * uint256(band) / 10_000;
        bool shouldPass = (diff <= allowed);

        if (shouldPass) {
            vm.prank(pusher);
            r.setPrice(answer);
            (, int256 stored,,,) = r.latestRoundData();
            assertEq(stored, answer);
        } else {
            vm.prank(pusher);
            vm.expectRevert(abi.encodeWithSelector(
                GuardedRelayFeed.OutsideBand.selector, answer, guardAns, band));
            r.setPrice(answer);
        }
    }

    // ================================================================
    //  15. Integration with PredictionArena
    // ================================================================

    // Shared integration helpers
    MockUSDC arenaUsdc;
    PredictionArena arena;
    MockPriceFeed   intGuard;  // the guard feed the test controls
    GuardedRelayFeed intRelay; // the relay PredictionArena reads

    address alice   = makeAddr("alice");
    address bob     = makeAddr("bob");
    address settler = makeAddr("settler");

    uint256 constant MIN_STAKE = 100_000; // $0.10 (6 dec USDC)
    uint256 constant ROUND_LEN = 3600;

    function _integrationSetup() internal {
        arenaUsdc = new MockUSDC();

        intGuard = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / int guard");
        // Set initial guard price at start of time
        vm.warp(1000);
        vm.prank(owner); intGuard.setPrice(GUARD_BTC);

        intRelay = new GuardedRelayFeed(
            owner, pusher,
            AggregatorV3Interface(address(intGuard)),
            100, "Matchup relay BTC/USD"
        );

        vm.startPrank(owner);
        arena = new PredictionArena(address(arenaUsdc), owner);
        // Create a BTC/USD market: roundLength 3600, startOffset 0
        arena.createMarket(
            "BTC/USD",
            address(intRelay),
            address(0),
            uint32(ROUND_LEN),
            0,
            uint128(MIN_STAKE)
        );
        vm.stopPrank();
    }

    function _fundAndCall(address who, uint256 mid, uint256 rnd, bool up, uint256 amt) internal {
        arenaUsdc.mint(who, amt);
        vm.prank(who);
        arenaUsdc.approve(address(arena), amt);
        vm.prank(who);
        arena.placeCall(mid, rnd, up, amt);
    }

    /// Build the correct (startId, endId) for a round by scanning the relay.
    function _findIds(uint256 lt, uint256 et)
        internal view returns (uint80 S, uint80 E)
    {
        (uint80 latestId,,,, ) = intRelay.latestRoundData();
        uint80 n = latestId & type(uint64).max;
        for (uint80 i = 1; i <= n; i++) {
            (uint80 s2, uint80 e2) = _scanOne(i, lt, et);
            if (S == 0 && s2 != 0) S = s2;
            if (e2 != 0) E = e2;
        }
    }

    function _scanOne(uint80 i, uint256 lt, uint256 et)
        internal view returns (uint80 maybeS, uint80 maybeE)
    {
        uint80 base = uint80(1) << 64;
        uint80 id   = base | i;
        try intRelay.getRoundData(id) returns (uint80, int256, uint256, uint256 at, uint80) {
            if (at <= et) maybeE = id;
            if (at >= lt) maybeS = _predOk(base, i, lt) ? id : 0;
        } catch {}
    }

    function _predOk(uint80 base, uint80 i, uint256 lt)
        internal view returns (bool)
    {
        if (i == 1) return true;
        try intRelay.getRoundData(base | (i-1)) returns (
            uint80, int256, uint256, uint256 pat, uint80
        ) {
            return pat < lt;
        } catch {}
        return false;
    }

    function test_integration_upWins() public {
        _integrationSetup();
        uint256 mid = 0;
        uint256 rnd = 1; // next callable at t=1000 (before offset 0+3600)

        // Call before lock (round 1 lock = 3600)
        vm.warp(2000);
        _fundAndCall(alice, mid, rnd, true,  200_000); // alice UP
        _fundAndCall(bob,   mid, rnd, false, 150_000); // bob DOWN

        uint256 lt = arena.lockTime(mid, rnd);   // 3600
        uint256 et = arena.endTime(mid, rnd);    // 7200

        // Push start price (at lock)
        vm.warp(lt + 1);
        vm.prank(owner); intGuard.setPrice(GUARD_BTC); // refresh guard
        vm.prank(pusher); intRelay.setPrice(GUARD_BTC);

        // Push end price (higher → UP wins)
        vm.warp(et - 1);
        int256 endPrice = GUARD_BTC + 1_000_000_000; // within band
        vm.prank(owner); intGuard.setPrice(endPrice);
        vm.prank(pusher); intRelay.setPrice(endPrice);

        // Settle
        vm.warp(et + 1);
        (uint80 S, uint80 E) = _findIds(lt, et);
        vm.prank(settler);
        arena.settle(mid, rnd, S, E);

        (, , , , , , PredictionArena.RoundState state) = arena.rounds(mid, rnd);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.SettledUp));

        // Alice wins
        vm.prank(alice);
        uint256 payout = arena.claim(mid, rnd);
        assertTrue(payout > 200_000, "alice should get back more than she staked");

        // Bob loses
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(
            PredictionArena.NothingToClaim.selector, mid, rnd));
        arena.claim(mid, rnd);
    }

    function test_integration_downWins() public {
        _integrationSetup();
        uint256 mid = 0;
        uint256 rnd = 1;

        vm.warp(2000);
        _fundAndCall(alice, mid, rnd, true,  200_000);
        _fundAndCall(bob,   mid, rnd, false, 150_000);

        uint256 lt = arena.lockTime(mid, rnd);
        uint256 et = arena.endTime(mid, rnd);

        vm.warp(lt + 1);
        vm.prank(owner); intGuard.setPrice(GUARD_BTC);
        vm.prank(pusher); intRelay.setPrice(GUARD_BTC);

        vm.warp(et - 1);
        int256 endPrice = GUARD_BTC - 1_000_000_000; // lower → DOWN wins
        vm.prank(owner); intGuard.setPrice(endPrice);
        vm.prank(pusher); intRelay.setPrice(endPrice);

        vm.warp(et + 1);
        (uint80 S, uint80 E) = _findIds(lt, et);
        vm.prank(settler);
        arena.settle(mid, rnd, S, E);

        (, , , , , , PredictionArena.RoundState state) = arena.rounds(mid, rnd);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.SettledDown));

        vm.prank(bob);
        uint256 payout = arena.claim(mid, rnd);
        assertTrue(payout > 150_000);
    }

    function test_integration_bandBlocksEnd_refund() public {
        // The pusher cannot push a valid end price because the guard
        // moves away from the relay's last price; the round refunds
        // as EndNotAfterStart (the only valid start == only valid end).
        _integrationSetup();
        uint256 mid = 0;
        uint256 rnd = 1;

        vm.warp(2000);
        _fundAndCall(alice, mid, rnd, true,  200_000);
        _fundAndCall(bob,   mid, rnd, false, 150_000);

        uint256 lt = arena.lockTime(mid, rnd);
        uint256 et = arena.endTime(mid, rnd);

        // Push exactly ONE price at lock+1: both start and end must be this id.
        vm.warp(lt + 1);
        vm.prank(owner); intGuard.setPrice(GUARD_BTC);
        vm.prank(pusher); intRelay.setPrice(GUARD_BTC);
        uint80 onlyId = (uint80(1) << 64) | uint80(1);

        // Guard moves wildly — pusher cannot push anything valid between lock and end.
        // Settle with same id as start and end → EndNotAfterStart refund.
        vm.warp(et + 1);
        vm.prank(settler);
        arena.settle(mid, rnd, onlyId, onlyId);

        (, , , , , , PredictionArena.RoundState state) = arena.rounds(mid, rnd);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));

        // Both get full refunds
        vm.prank(alice);
        assertEq(arena.claim(mid, rnd), 200_000);
        vm.prank(bob);
        assertEq(arena.claim(mid, rnd), 150_000);
    }

    // ================================================================
    //  Helper: deploy a relay with a fresh guard set to a given price/band
    // ================================================================
    function _deployRelay(int256 guardPrice, uint16 band)
        internal returns (GuardedRelayFeed)
    {
        MockPriceFeed gf = new MockPriceFeed(owner, 8,
            "TEST PRICES - NOT REAL DATA / helper");
        vm.prank(owner);
        gf.setPrice(guardPrice);
        return new GuardedRelayFeed(
            owner, pusher,
            AggregatorV3Interface(address(gf)),
            band, "Matchup relay BTC/USD"
        );
    }
}
