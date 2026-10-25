// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Kairo Markets – Settlement tests (Step 5)
//
//  Covers:
//   - MockPriceFeed behaviour (ownership, timestamps, IDs, phases,
//     zero/negative prices, description check)
//   - settle() timing window (too early, on boundary, window closed)
//   - Happy path UP wins and DOWN wins (BTC, ETH, SOL offsets)
//   - Cheating settlers (wrong start ID, wrong end ID, swapped, etc.)
//   - Refund cases: one-sided, no update, endId<=startId, zero price,
//     negative price, equal price, phase edge, timeout
//   - markRefunded (timing, double-call, any caller)
//   - Fuzz: random updates around lock/end; correct pair accepted,
//     neighbours rejected; balance unchanged after settle
// =============================================================

import {Test, console} from "forge-std/Test.sol";
import {PredictionArena} from "../PredictionArena.sol";
import {MockPriceFeed}   from "../mocks/MockPriceFeed.sol";
import {MockUSDC}        from "./MockUSDC.sol";

contract SettleTest is Test {

    // =========================================================
    //  Fixtures
    // =========================================================

    PredictionArena arena;
    MockUSDC        usdc;
    MockPriceFeed   feed;

    address owner  = makeAddr("owner");
    address alice  = makeAddr("alice");
    address bob    = makeAddr("bob");
    address settler = makeAddr("settler"); // anyone can settle

    // 1-hour BTC market (offset 0)
    uint256 btcId;
    uint256 ethId;
    uint256 solId;

    uint32 constant ROUND  = 3600;
    uint32 constant OFF_BTC = 0;
    uint32 constant OFF_ETH = 1200;
    uint32 constant OFF_SOL = 2400;
    uint128 constant MIN    = 100_000; // $0.10

    // =========================================================
    //  setUp
    // =========================================================

    function setUp() public {
        vm.startPrank(owner);
        usdc  = new MockUSDC();
        feed  = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / BTC/USD");
        arena = new PredictionArena(address(usdc), owner);
        btcId = arena.marketCount();
        arena.createMarket("BTC/USD", address(feed), address(0), ROUND, OFF_BTC, MIN);
        ethId = arena.marketCount();
        arena.createMarket("ETH/USD", address(feed), address(0), ROUND, OFF_ETH, MIN);
        solId = arena.marketCount();
        arena.createMarket("SOL/USD", address(feed), address(0), ROUND, OFF_SOL, MIN);
        vm.stopPrank();
    }

    // =========================================================
    //  Helpers
    // =========================================================

    /// Give `who` some USDC and approve the arena.
    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(arena), amount);
    }

    /// Place bets so a round has both sides (needed for non-one-sided settle).
    function _placeBothBets(uint256 mid, uint256 roundIdx, uint256 amt) internal {
        _fund(alice, amt);
        _fund(bob,   amt);
        vm.prank(alice); arena.placeBet(mid, roundIdx, true,  amt);
        vm.prank(bob);   arena.placeBet(mid, roundIdx, false, amt);
    }

    /// Convenience: lock time of round k on the BTC market.
    function _lock(uint256 k) internal view returns (uint256) {
        return arena.lockTime(btcId, k);
    }
    function _end(uint256 k) internal view returns (uint256) {
        return arena.endTime(btcId, k);
    }

    // =========================================================
    //  MockPriceFeed – basic behaviour
    // =========================================================

    function test_feed_descriptionStartsWithWarning() public view {
        string memory d = feed.description();
        // Must start with "TEST PRICES - NOT REAL DATA"
        bytes memory b = bytes(d);
        bytes memory prefix = bytes("TEST PRICES - NOT REAL DATA");
        assertTrue(b.length >= prefix.length, "description too short");
        for (uint256 i = 0; i < prefix.length; i++) {
            assertEq(b[i], prefix[i], "description prefix mismatch");
        }
    }

    function test_feed_constructorRejectsWrongDescription() public {
        vm.expectRevert();
        new MockPriceFeed(owner, 8, "Not a warning");
    }

    function test_feed_latestRevertsBeforeAnyUpdate() public {
        MockPriceFeed fresh = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / fresh");
        vm.expectRevert("No data present");
        fresh.latestRoundData();
    }

    function test_feed_getRoundDataRevertsOnMissingId() public {
        vm.expectRevert("No data present");
        feed.getRoundData(1);
    }

    function test_feed_getRoundDataRevertsOnLargeId() public {
        vm.expectRevert("No data present");
        feed.getRoundData(type(uint80).max);
    }

    function test_feed_getRoundDataRevertsOnRoundPartZero() public {
        // ID with roundInPhase == 0 is never written.
        uint80 badId = uint80(1) << 64; // phase 1, round 0
        vm.expectRevert("No data present");
        feed.getRoundData(badId);
    }

    function test_feed_setPriceOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        feed.setPrice(1000);
    }

    function test_feed_startNewPhaseOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        feed.startNewPhase();
    }

    function test_feed_firstIdIs_phase1Round1() public {
        vm.warp(1000);
        vm.prank(owner); feed.setPrice(100);
        (uint80 id, , , , ) = feed.latestRoundData();
        assertEq(id, (uint80(1) << 64) | 1, "first id should be (1<<64)|1");
    }

    function test_feed_updatedAtIsBlockTimestamp() public {
        vm.warp(99_999);
        vm.prank(owner); feed.setPrice(500);
        (, , , uint256 upAt, ) = feed.latestRoundData();
        assertEq(upAt, 99_999, "updatedAt must be block.timestamp");
    }

    function test_feed_updatedAtDoesNotAcceptBackdate() public {
        // There is no function that accepts a timestamp parameter.
        // This test confirms the only way to set a price is setPrice(int256).
        // We verify by checking the interface has no timestamp function.
        // Since Solidity is typed, we just ensure setPrice compiles with one arg.
        vm.warp(5000); vm.prank(owner); feed.setPrice(1);
        vm.warp(4000); // warp BACKWARD to simulate an earlier block (vm.warp allows this)
        vm.prank(owner); feed.setPrice(2);
        // The second update's updatedAt must reflect the new warp, not a backdate.
        (, , , uint256 upAt, ) = feed.latestRoundData();
        assertEq(upAt, 4000, "updatedAt must equal block.timestamp at call time");
    }

    function test_feed_twoUpdatesInSameBlock() public {
        vm.warp(2000);
        vm.prank(owner); feed.setPrice(10);
        vm.prank(owner); feed.setPrice(20); // same block, same timestamp
        (uint80 id1, , , uint256 at1, ) = feed.getRoundData((uint80(1) << 64) | 1);
        (uint80 id2, , , uint256 at2, ) = feed.getRoundData((uint80(1) << 64) | 2);
        assertEq(at1, 2000);
        assertEq(at2, 2000);                     // same timestamp
        assertEq(uint256(id2), uint256(id1) + 1); // ids +1
    }

    function test_feed_idsStrictlyIncrease() public {
        for (uint256 i = 0; i < 5; i++) {
            vm.warp(1000 + i * 100);
            vm.prank(owner); feed.setPrice(int256(i + 1));
        }
        uint80 prev;
        for (uint80 i = 1; i <= 5; i++) {
            (uint80 rid, , , , ) = feed.getRoundData((uint80(1) << 64) | i);
            assertTrue(rid > prev);
            prev = rid;
        }
    }

    function test_feed_timestampsNonDecreasing() public {
        vm.warp(100); vm.prank(owner); feed.setPrice(1);
        vm.warp(200); vm.prank(owner); feed.setPrice(2);
        vm.warp(300); vm.prank(owner); feed.setPrice(3);
        (, , , uint256 a1, ) = feed.getRoundData((uint80(1) << 64) | 1);
        (, , , uint256 a2, ) = feed.getRoundData((uint80(1) << 64) | 2);
        (, , , uint256 a3, ) = feed.getRoundData((uint80(1) << 64) | 3);
        assertTrue(a1 <= a2 && a2 <= a3);
    }

    function test_feed_zeroPriceAccepted() public {
        vm.prank(owner); feed.setPrice(0);
        (, int256 ans, , , ) = feed.latestRoundData();
        assertEq(ans, 0);
    }

    function test_feed_negativePriceAccepted() public {
        vm.prank(owner); feed.setPrice(-42);
        (, int256 ans, , , ) = feed.latestRoundData();
        assertEq(ans, -42);
    }

    function test_feed_startNewPhase_nextIdCorrect() public {
        vm.prank(owner); feed.setPrice(1); // phase 1, round 1
        vm.prank(owner); feed.startNewPhase();
        vm.warp(500); vm.prank(owner); feed.setPrice(2); // phase 2, round 1
        (uint80 id, , , , ) = feed.latestRoundData();
        assertEq(id, (uint80(2) << 64) | 1, "after startNewPhase id should be (2<<64)|1");
    }

    function test_feed_decimalsAndVersion() public view {
        assertEq(feed.decimals(), 8);
        assertEq(feed.version(),  1);
    }

    // =========================================================
    //  Settle window boundaries
    // =========================================================

    function _setupBtcRound1WithBets() internal returns (uint256 lockTs, uint256 endTs) {
        // BTC round 1: lock=3600, end=7200
        vm.warp(1); // before lock
        _placeBothBets(btcId, 1, MIN);
        lockTs = _lock(1); // 3600
        endTs  = _end(1);  // 7200

        // Put a feed update before lock and one after lock
        vm.warp(lockTs - 10); vm.prank(owner); feed.setPrice(100_000e8);
        vm.warp(lockTs + 1);  vm.prank(owner); feed.setPrice(110_000e8);
        vm.warp(endTs   - 1); vm.prank(owner); feed.setPrice(120_000e8);
    }

    function test_settle_tooEarlyAtExactlyEnd() public {
        (, uint256 endTs) = _setupBtcRound1WithBets();
        vm.warp(endTs); // exactly at end – NOT strictly after
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.SettleTooEarly.selector,
                endTs, endTs
            )
        );
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);
    }

    function test_settle_worksAtEndPlusOne() public {
        (, uint256 endTs) = _setupBtcRound1WithBets();
        vm.warp(endTs + 1);
        // start = id 2 (lockTs+1), end = id 3 (endTs-1)
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);
        (,,,,,,PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertTrue(state == PredictionArena.RoundState.SettledUp ||
                   state == PredictionArena.RoundState.SettledDown ||
                   state == PredictionArena.RoundState.Refunded);
    }

    function test_settle_worksAtExactDeadline() public {
        (, uint256 endTs) = _setupBtcRound1WithBets();
        vm.warp(endTs + 1 hours); // exactly at deadline
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);
        (,,,,,,PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertTrue(state != PredictionArena.RoundState.Unsettled);
    }

    function test_settle_windowClosedAfterDeadline() public {
        (, uint256 endTs) = _setupBtcRound1WithBets();
        uint256 deadline = endTs + 1 hours;
        vm.warp(deadline + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.SettleWindowClosed.selector,
                deadline + 1, deadline
            )
        );
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);
    }

    function test_settle_twice_reverts() public {
        (, uint256 endTs) = _setupBtcRound1WithBets();
        vm.warp(endTs + 1);
        vm.prank(settler); arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.RoundAlreadySettled.selector, btcId, 1
            )
        );
        vm.prank(settler); arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);
    }

    function test_settle_beforeRoundEnds_reverts() public {
        uint256 lockTs = _lock(1);
        vm.warp(lockTs - 1); // still betting open
        _placeBothBets(btcId, 1, MIN);
        uint256 endTs = _end(1);
        vm.warp(endTs - 1); // round not ended yet
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.SettleTooEarly.selector,
                endTs - 1, endTs
            )
        );
        vm.prank(settler);
        arena.settle(btcId, 1, 0, 0);
    }

    // =========================================================
    //  Happy path – UP wins (BTC)
    // =========================================================

    function test_settle_upWins_btc() public {
        // Round 1: lock=3600, end=7200
        vm.warp(1);
        _placeBothBets(btcId, 1, 1_000_000); // $1 each side

        uint256 lt = _lock(1);
        uint256 et = _end(1);

        // Feed: update before lock, start after lock, end update
        vm.warp(lt - 5);   vm.prank(owner); feed.setPrice(100_000e8); // pre-lock
        vm.warp(lt + 1);   vm.prank(owner); feed.setPrice(100_000e8); // start (id 2)
        vm.warp(et - 1);   vm.prank(owner); feed.setPrice(101_000e8); // end (id 3)

        vm.warp(et + 1);
        uint80 startId = (uint80(1)<<64)|2;
        uint80 endId   = (uint80(1)<<64)|3;
        vm.prank(settler);
        arena.settle(btcId, 1, startId, endId);

        (uint128 upTotal, uint128 downTotal, uint80 sId, uint80 eId,
         int256 sPrice, int256 ePrice, PredictionArena.RoundState state) =
            arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.SettledUp));

        // Winning round: reason in the event must be None, not OneSided.
        // We verify by reading the stored round state (event already checked in
        // test_settle_emitsRoundSettledEvent). Stored startId/endId must match.
        assertEq(sId,    (uint80(1)<<64)|2);
        assertEq(eId,    (uint80(1)<<64)|3);
        assertEq(sPrice, 100_000e8);
        assertEq(ePrice, 101_000e8);

        // fee = downTotal * 200 / 10000 = 1_000_000 * 2% = 20_000
        uint256 expectedFee = uint256(downTotal) * 200 / 10_000;
        assertEq(arena.feesAccrued(), expectedFee);

        // USDC balance unchanged (settle moves no USDC)
        assertEq(usdc.balanceOf(address(arena)),
                 uint256(upTotal) + uint256(downTotal));
    }

    function test_settle_downWins_btc() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, 2_000_000);

        uint256 lt = _lock(1);
        uint256 et = _end(1);

        vm.warp(lt - 5);  vm.prank(owner); feed.setPrice(50_000e8);
        vm.warp(lt + 1);  vm.prank(owner); feed.setPrice(50_000e8); // start (id 2)
        vm.warp(et - 1);  vm.prank(owner); feed.setPrice(49_000e8); // end (id 3)

        vm.warp(et + 1);
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        (uint128 upTotal, uint128 downTotal,,,,, PredictionArena.RoundState state) =
            arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.SettledDown));

        // fee = upTotal * 2%
        uint256 expectedFee = uint256(upTotal) * 200 / 10_000;
        assertEq(arena.feesAccrued(), expectedFee);
        assertEq(usdc.balanceOf(address(arena)),
                 uint256(upTotal) + uint256(downTotal));
    }

    // =========================================================
    //  Happy path – ETH and SOL offsets
    // =========================================================

    function test_settle_upWins_eth() public {
        // ETH round 1: lock = 1200 + 3600 = 4800, end = 8400
        uint256 lt = arena.lockTime(ethId, 1);
        uint256 et = arena.endTime(ethId, 1);

        // Must bet before lock
        vm.warp(lt - 100);
        _fund(alice, MIN); vm.prank(alice); arena.placeBet(ethId, 1, true,  MIN);
        _fund(bob,   MIN); vm.prank(bob);   arena.placeBet(ethId, 1, false, MIN);

        vm.warp(lt - 5);  vm.prank(owner); feed.setPrice(2000e8);
        vm.warp(lt + 1);  vm.prank(owner); feed.setPrice(2000e8);
        vm.warp(et - 1);  vm.prank(owner); feed.setPrice(2100e8);

        vm.warp(et + 1);
        // id1=pre-lock, id2=first after lock (start), id3=last before end (end)
        uint80 startId = (uint80(1)<<64)|2;
        uint80 endId   = (uint80(1)<<64)|3;
        vm.prank(settler);
        arena.settle(ethId, 1, startId, endId);
        (,,,,,, PredictionArena.RoundState state) = arena.rounds(ethId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.SettledUp));
    }

    function test_settle_downWins_sol() public {
        // SOL round 1: lock = 2400 + 3600 = 6000, end = 9600
        uint256 lt = arena.lockTime(solId, 1);
        uint256 et = arena.endTime(solId, 1);

        vm.warp(lt - 100);
        _fund(alice, MIN); vm.prank(alice); arena.placeBet(solId, 1, true,  MIN);
        _fund(bob,   MIN); vm.prank(bob);   arena.placeBet(solId, 1, false, MIN);

        vm.warp(lt - 5);  vm.prank(owner); feed.setPrice(150e8);
        vm.warp(lt + 1);  vm.prank(owner); feed.setPrice(150e8);
        vm.warp(et - 1);  vm.prank(owner); feed.setPrice(140e8);

        vm.warp(et + 1);
        vm.prank(settler);
        arena.settle(solId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);
        (,,,,,, PredictionArena.RoundState state) = arena.rounds(solId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.SettledDown));
    }

    // =========================================================
    //  Stored IDs and prices after settle
    // =========================================================

    function test_settle_storesRoundData() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        vm.warp(lt - 5);  vm.prank(owner); feed.setPrice(50_000e8);
        vm.warp(lt + 1);  vm.prank(owner); feed.setPrice(51_000e8);
        vm.warp(et - 1);  vm.prank(owner); feed.setPrice(52_000e8);

        uint80 startId = (uint80(1)<<64)|2;
        uint80 endId   = (uint80(1)<<64)|3;
        vm.warp(et + 1);
        vm.prank(settler); arena.settle(btcId, 1, startId, endId);

        (, , uint80 sId, uint80 eId, int256 sPrice, int256 ePrice, ) =
            arena.rounds(btcId, 1);
        assertEq(sId, startId);
        assertEq(eId, endId);
        assertEq(sPrice, 51_000e8);
        assertEq(ePrice, 52_000e8);
    }

    // =========================================================
    //  Cheating settlers
    // =========================================================

    /// Helper: set up BTC round 1 with updates before lock, at lock+1,
    /// at lock+100, at end-1.  Returns (lt, et).
    function _setupBtcRound1_multiUpdates()
        internal
        returns (uint256 lt, uint256 et)
    {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        lt = _lock(1); et = _end(1);

        // id1 = pre-lock (lt-10)
        vm.warp(lt - 10); vm.prank(owner); feed.setPrice(100e8);
        // id2 = first after lock (lt+1) = valid start
        vm.warp(lt + 1);  vm.prank(owner); feed.setPrice(101e8);
        // id3 = mid round (lt+100)
        vm.warp(lt + 100); vm.prank(owner); feed.setPrice(102e8);
        // id4 = last inside round (et-1) = valid end
        vm.warp(et - 1);  vm.prank(owner); feed.setPrice(103e8);
        // id5 = after end
        vm.warp(et + 2);  vm.prank(owner); feed.setPrice(104e8);

        vm.warp(et + 1); // settle window (we'll re-warp in tests if needed)
    }

    function test_cheat_startBeforeLock_reverts() public {
        (, uint256 et) = _setupBtcRound1_multiUpdates();
        vm.warp(et + 1);
        // id1 has updatedAt = lt-10 < lockTime → invalid start
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, (uint80(1)<<64)|1)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|1, (uint80(1)<<64)|4);
    }

    function test_cheat_startMidRound_reverts() public {
        (, uint256 et) = _setupBtcRound1_multiUpdates();
        vm.warp(et + 1);
        // id3 is mid-round: updatedAt >= lockTime (ok), but id2 (predecessor)
        // also has updatedAt >= lockTime → not the FIRST update after lock
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, (uint80(1)<<64)|3)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|3, (uint80(1)<<64)|4);
    }

    function test_cheat_startAfterEnd_reverts() public {
        (, uint256 et) = _setupBtcRound1_multiUpdates();
        vm.warp(et + 1);
        // id5 is after end time: updatedAt = et+2 > lockTime but also > endTime
        // so it doesn't satisfy updatedAt >= lockTime for start check –
        // actually it does satisfy updatedAt >= lockTime but its predecessor
        // id4 also has updatedAt >= lockTime → invalid start
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, (uint80(1)<<64)|5)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|5, (uint80(1)<<64)|4);
    }

    function test_cheat_endAfterEndTime_reverts() public {
        (, uint256 et) = _setupBtcRound1_multiUpdates();
        vm.warp(et + 1);
        // id5 has updatedAt = et+2 > endTime → invalid end
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidEndRound.selector, (uint80(1)<<64)|5)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|5);
    }

    function test_cheat_endMidRound_reverts() public {
        (, uint256 et) = _setupBtcRound1_multiUpdates();
        vm.warp(et + 1);
        // id3 is mid-round: updatedAt <= endTime (ok), but id4 (successor)
        // also has updatedAt <= endTime → not the LAST update before end
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidEndRound.selector, (uint80(1)<<64)|3)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);
    }

    function test_cheat_swappedIds_reverts() public {
        (, uint256 et) = _setupBtcRound1_multiUpdates();
        vm.warp(et + 1);
        // Swap: start=id4 (end update), end=id2 (start update)
        // id4's predecessor id3 has updatedAt >= lockTime → invalid start
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, (uint80(1)<<64)|4)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|4, (uint80(1)<<64)|2);
    }

    function test_cheat_sameIdForBothMultipleUpdates_reverts() public {
        (, uint256 et) = _setupBtcRound1_multiUpdates();
        vm.warp(et + 1);
        // Using id2 as both start and end. id2 is a valid start but as end:
        // its successor id3 exists and has updatedAt <= endTime → invalid end
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidEndRound.selector, (uint80(1)<<64)|2)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|2);
    }

    function test_cheat_nonExistentStartId_hugeNumber() public {
        (, uint256 et) = _setupBtcRound1_multiUpdates();
        vm.warp(et + 1);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, type(uint80).max)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, type(uint80).max, (uint80(1)<<64)|4);
    }

    function test_cheat_nonExistentStartId_phase2Round5() public {
        (, uint256 et) = _setupBtcRound1_multiUpdates();
        vm.warp(et + 1);
        uint80 badId = (uint80(2)<<64)|5;
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, badId)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, badId, (uint80(1)<<64)|4);
    }

    function test_cheat_nonExistentStartId_roundPartZero() public {
        (, uint256 et) = _setupBtcRound1_multiUpdates();
        vm.warp(et + 1);
        uint80 badId = uint80(1) << 64; // roundInPhase == 0
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, badId)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, badId, (uint80(1)<<64)|4);
    }

    function test_cheat_nonExistentEndId_reverts() public {
        (, uint256 et) = _setupBtcRound1_multiUpdates();
        vm.warp(et + 1);
        uint80 badEnd = (uint80(1)<<64)|99;
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidEndRound.selector, badEnd)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, badEnd);
    }

    function test_cheat_startId0_updateExistsAfterLock_reverts() public {
        (, uint256 et) = _setupBtcRound1_multiUpdates();
        vm.warp(et + 1);
        // startRoundId == 0 means "no update since lock", but id2 exists at lt+1
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, 0)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, 0, (uint80(1)<<64)|4);
    }

    // =========================================================
    //  Single update in the round: same id as start and end => EndNotAfterStart refund
    // =========================================================

    function test_singleUpdateInRound_refundEndNotAfterStart() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        vm.warp(lt - 5);  vm.prank(owner); feed.setPrice(100e8); // pre-lock (id1)
        vm.warp(lt + 1);  vm.prank(owner); feed.setPrice(100e8); // only update in round (id2)
        // id2 is the latest; no successor

        vm.warp(et + 1);
        uint80 id2 = (uint80(1)<<64)|2;
        // Same id for both start and end: id2 is valid start, valid end (it is latest).
        // But endRoundId == startRoundId → EndNotAfterStart refund.
        vm.prank(settler);
        arena.settle(btcId, 1, id2, id2);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
        assertEq(arena.feesAccrued(), 0); // no fee on refund
    }

    // =========================================================
    //  Refund cases
    // =========================================================

    function test_refund_oneSided_noFee() public {
        // Only alice bets UP; bob does not bet.
        vm.warp(1);
        _fund(alice, MIN);
        vm.prank(alice); arena.placeBet(btcId, 1, true, MIN);

        uint256 et = _end(1);
        vm.warp(et + 1);

        vm.prank(settler);
        arena.settle(btcId, 1, 0, 0); // IDs ignored for one-sided

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
        assertEq(arena.feesAccrued(), 0);
    }

    function test_refund_noUpdate_startId0() public {
        // Feed has NO update at or after lockTime; caller passes startRoundId=0.
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        // Only update is BEFORE lock
        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8); // id1

        vm.warp(et + 1);
        vm.prank(settler);
        arena.settle(btcId, 1, 0, 0); // 0 = no update since lock

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
        assertEq(arena.feesAccrued(), 0);
    }

    function test_refund_noUpdate_feedEmpty_startId0() public {
        // Feed has NO updates at all.
        MockPriceFeed emptyFeed = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / empty");
        vm.prank(owner);
        arena.createMarket("EMPTY", address(emptyFeed), address(0), ROUND, 0, MIN);
        uint256 emptyId = arena.marketCount() - 1;

        vm.warp(1);
        _fund(alice, MIN); vm.prank(alice); arena.placeBet(emptyId, 1, true,  MIN);
        _fund(bob,   MIN); vm.prank(bob);   arena.placeBet(emptyId, 1, false, MIN);

        uint256 et = arena.endTime(emptyId, 1);
        vm.warp(et + 1);
        vm.prank(settler);
        arena.settle(emptyId, 1, 0, 0);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(emptyId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
    }

    function test_refund_zeroPriceAtStart() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8);    // id1 pre-lock
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(0);        // id2 start = 0
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(100e8);    // id3 end

        vm.warp(et + 1);
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
        assertEq(arena.feesAccrued(), 0);
    }

    function test_refund_zeroPriceAtEnd() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(100e8); // id2
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(0);     // id3 end = 0

        vm.warp(et + 1);
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
        assertEq(arena.feesAccrued(), 0);
    }

    function test_refund_negativePriceAtStart() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(-1);    // id2 negative
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(100e8); // id3

        vm.warp(et + 1);
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
        assertEq(arena.feesAccrued(), 0);
    }

    function test_refund_negativePriceAtEnd() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(100e8); // id2
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(-1);    // id3 negative

        vm.warp(et + 1);
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
        assertEq(arena.feesAccrued(), 0);
    }

    function test_refund_equalPrices() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(100e8); // id2
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(100e8); // id3 same

        vm.warp(et + 1);
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
        assertEq(arena.feesAccrued(), 0);
    }

    // =========================================================
    //  Refund – timeout (markRefunded)
    // =========================================================

    function test_markRefunded_worksAfterWindow() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 et = _end(1);
        // Warp past deadline without settling
        vm.warp(et + 1 hours + 1);

        vm.prank(settler);
        arena.markRefunded(btcId, 1);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
        assertEq(arena.feesAccrued(), 0);
    }

    function test_markRefunded_tooEarlyAtDeadline() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 et = _end(1);
        uint256 earliest = et + 1 hours;
        vm.warp(earliest); // exactly at deadline, NOT strictly after
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.RefundTooEarly.selector,
                earliest, earliest
            )
        );
        vm.prank(settler);
        arena.markRefunded(btcId, 1);
    }

    function test_markRefunded_alreadySettled_reverts() public {
        // Mark round 1 as refunded via timeout, then try again → RoundAlreadySettled.
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 et1 = _end(1);
        vm.warp(et1 + 1 hours + 1);
        vm.prank(settler); arena.markRefunded(btcId, 1);

        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.RoundAlreadySettled.selector, btcId, 1)
        );
        vm.prank(settler); arena.markRefunded(btcId, 1);
    }

    function test_markRefunded_anyCallerCanCall() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 et = _end(1);
        vm.warp(et + 1 hours + 1);

        // stranger (not owner, not alice/bob) can mark refunded
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        arena.markRefunded(btcId, 1);
        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
    }

    function test_settleClosedAfterDeadline_markRefundedWorks() public {
        (, uint256 et) = _setupBtcRound1WithBets();
        uint256 deadline = et + 1 hours;
        // Try settle after deadline → SettleWindowClosed
        vm.warp(deadline + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.SettleWindowClosed.selector,
                deadline + 1, deadline
            )
        );
        vm.prank(settler); arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        // markRefunded works fine
        vm.prank(settler); arena.markRefunded(btcId, 1);
        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
    }

    // =========================================================
    //  Phase edge cases
    // =========================================================

    function test_phase_firstUpdateOfPhase1_validStart() public {
        // Phase 1, round 1 has no predecessor – it is special-cased as valid.
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        // ONLY update ever is at lt+1 (phase 1, round 1)
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(100e8);  // id = (1<<64)|1
        // It is the latest; no successor.

        vm.warp(et + 1);
        uint80 id1 = (uint80(1)<<64)|1;
        // Valid: phase 1 round 1 with no predecessor is the special case.
        // start==end → EndNotAfterStart refund, but should not revert on IDs.
        vm.prank(settler);
        arena.settle(btcId, 1, id1, id1);
        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
    }

    function test_phase_startIsFirstOfPhase2_phaseEdgeRefund() public {
        // startRoundId = (2<<64)|1 (first of phase 2): cannot verify predecessor
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        // Phase 1 update before lock
        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8); // (1<<64)|1
        // Start new phase; next update is (2<<64)|1
        vm.prank(owner); feed.startNewPhase();
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(101e8); // (2<<64)|1 = start
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(102e8); // (2<<64)|2 = potential end

        vm.warp(et + 1);
        uint80 startId = (uint80(2)<<64)|1;
        uint80 endId   = (uint80(2)<<64)|2;
        vm.prank(settler);
        arena.settle(btcId, 1, startId, endId);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
        assertEq(arena.feesAccrued(), 0);
    }

    function test_phase_endSuccessorMissingNotLatest_phaseEdgeRefund() public {
        // endRoundId + 1 does not exist but endRoundId is NOT the latest →
        // phase edge (phase change happened after endRoundId).
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8); // (1<<64)|1
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(101e8); // (1<<64)|2 = start
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(102e8); // (1<<64)|3 = end

        // Phase change: next update is (2<<64)|1, which is NOT (1<<64)|4.
        // So the "successor" of (1<<64)|3 is missing but (1<<64)|3 is NOT the latest.
        vm.prank(owner); feed.startNewPhase();
        vm.warp(et + 2); vm.prank(owner); feed.setPrice(103e8); // (2<<64)|1 = latest

        vm.warp(et + 1);
        uint80 startId = (uint80(1)<<64)|2;
        uint80 endId   = (uint80(1)<<64)|3;
        vm.prank(settler);
        arena.settle(btcId, 1, startId, endId);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
        assertEq(arena.feesAccrued(), 0);
    }

    // =========================================================
    //  Settle moves no USDC
    // =========================================================

    function test_settle_balanceUnchanged() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, 5_000_000);
        uint256 balanceBefore = usdc.balanceOf(address(arena));

        uint256 lt = _lock(1); uint256 et = _end(1);
        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(105e8);

        vm.warp(et + 1);
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        assertEq(usdc.balanceOf(address(arena)), balanceBefore);
    }

    // =========================================================
    //  RoundSettled event
    // =========================================================

    function test_settle_emitsRoundSettledEvent() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(105e8);

        uint80 startId = (uint80(1)<<64)|2;
        uint80 endId   = (uint80(1)<<64)|3;

        vm.warp(et + 1);
        // Check all fields including reason == None (not OneSided).
        vm.expectEmit(true, true, false, true);
        emit PredictionArena.RoundSettled(
            btcId, 1,
            PredictionArena.RoundState.SettledUp,
            startId, endId, 100e8, 105e8,
            PredictionArena.RefundReason.None
        );
        vm.prank(settler);
        arena.settle(btcId, 1, startId, endId);
    }

    // =========================================================
    //  Fuzz: random update schedule → UNIQUENESS via snapshot/revert
    // =========================================================

    /// @dev Full uniqueness + result-correctness fuzz test.
    ///
    ///      Builds 1-8 price updates at timestamps spread from lt-1500
    ///      with gaps of [0, 900] – reaching up to ~lt+5700, well past
    ///      the end time (lt+3600) and inside the settle window (lt+7200).
    ///      Equal-gap runs (gap==0) create same-timestamp updates, exercising
    ///      the equal-price and EndNotAfterStart paths.
    ///
    ///      UNIQUENESS (A-C):
    ///        A) Exactly one (startId,endId) pair succeeds in the candidate
    ///           set when S* and E* exist with E*.id > S*.id; otherwise
    ///           startId=0 succeeds with any endId (no S*), or nothing succeeds.
    ///        B) Every failing pair reverts with InvalidStartRound or
    ///           InvalidEndRound only (no panics).
    ///        C) USDC balance unchanged after the winning settle.
    ///
    ///      RESULT CORRECTNESS (D):
    ///        D) After the final real settle, stored state matches brute-force:
    ///           - startId=0 path → Refunded, reason NoUpdate
    ///           - E*.id <= S*.id → Refunded, reason EndNotAfterStart
    ///           - equalPrices=true → Refunded, reason UnchangedPrice
    ///           - otherwise → SettledUp (prices strictly increase with index),
    ///             reason None, feesAccrued == downTotal * 200 / 10000
    function testFuzz_settle_correctPairOnly(
        uint8  nUpdates,
        uint64[8] calldata gaps,
        uint128 betSize,
        bool   equalPrices
    ) public {
        _fuzzSettle(nUpdates, gaps, betSize, equalPrices);
    }

    // Packed to avoid stack-too-deep in _fuzzSettle.
    struct FuzzCtx {
        uint256 n;
        uint256 lt;
        uint256 et;
        uint256 amt;
        uint256 balBefore;
        int256  cS;
        int256  cE;
        bool    latestBL;
        bool    equalPrices;
    }

    // Split into its own function so the fuzz entry point stays shallow.
    function _fuzzSettle(
        uint8  nUpdates,
        uint64[8] calldata gaps,
        uint128 betSize,
        bool   equalPrices
    ) internal {
        FuzzCtx memory c;
        c.n          = bound(uint256(nUpdates), 1, 8);
        c.amt        = bound(uint256(betSize),  MIN, 1_000_000);
        c.equalPrices = equalPrices;

        vm.warp(1);
        _fund(alice, c.amt); _fund(bob, c.amt);
        vm.prank(alice); arena.placeBet(btcId, 1, true,  c.amt);
        vm.prank(bob);   arena.placeBet(btcId, 1, false, c.amt);

        c.lt = _lock(1);
        c.et = _end(1);

        // Place n updates starting at lt-1500, each gap in [0,900].
        // With n=8 and gap=900 the last update lands at lt-1500+8*900 = lt+5700,
        // well past et=lt+3600 and inside the window deadline lt+7200.
        // Gap=0 keeps ts unchanged (same block), producing equal timestamps.
        uint256 ts = c.lt - 1500;
        for (uint256 i = 0; i < c.n; i++) {
            ts += uint256(gaps[i]) % 901;   // [0, 900]
            if (ts < 1) ts = 1;
            vm.warp(ts);
            vm.prank(owner);
            // equalPrices: all updates get price 5000; else strictly increasing.
            feed.setPrice(equalPrices ? int256(5000) : int256(1000 + i * 100));
        }

        // Brute-force S* and E*.
        c.cS = -1; c.cE = -1;
        for (uint256 i = 0; i < c.n; i++) {
            uint80 id = (uint80(1) << 64) | uint80(i + 1);
            (, , , uint256 upAt, ) = feed.getRoundData(id);
            if (upAt >= c.lt && c.cS < 0) {
                bool predOk;
                if (i == 0) {
                    predOk = true;
                } else {
                    uint80 prevId = (uint80(1) << 64) | uint80(i);
                    (, , , uint256 prevAt, ) = feed.getRoundData(prevId);
                    predOk = (prevAt < c.lt);
                }
                if (predOk) c.cS = int256(i);
            }
            if (upAt <= c.et) c.cE = int256(i);
        }

        // Warp to max(et, last update ts) + 1; assert inside window.
        uint256 settleTs = (ts > c.et ? ts : c.et) + 1;
        assertTrue(settleTs <= c.et + 3600, "settle ts outside window");
        vm.warp(settleTs);

        c.balBefore = usdc.balanceOf(address(arena));
        c.latestBL  = (c.cS < 0) && (c.n == 0 || _feedAt(c.n) < c.lt);

        // Phase A-C: uniqueness sweep.
        _sweepAndCheck(c.n, c.lt, c.et, c.cS, c.cE, c.latestBL, c.balBefore);

        // Phase D: result correctness.
        _checkFuzzResult(c);
    }

    function _feedAt(uint256 i) internal view returns (uint256 upAt) {
        uint80 id = (uint80(1) << 64) | uint80(i);
        (, , , upAt, ) = feed.getRoundData(id);
    }

    // ------------------------------------------------------------------
    //  Phase D: after the sweep, do the real settle and check stored state.
    // ------------------------------------------------------------------
    function _checkFuzzResult(FuzzCtx memory c) internal {
        // Case 1: no valid start → NoUpdate refund.
        if (c.latestBL) {
            vm.expectEmit(true, true, false, true);
            emit PredictionArena.RoundSettled(
                btcId, 1,
                PredictionArena.RoundState.Refunded,
                0, 0, 0, 0,
                PredictionArena.RefundReason.NoUpdate
            );
            vm.prank(settler);
            arena.settle(btcId, 1, 0, 0);
            assertEq(usdc.balanceOf(address(arena)), c.balBefore, "bal D1");
            return;
        }

        // Case 2: no S* or no E* → settle cannot succeed; nothing to assert.
        if (c.cS < 0 || c.cE < 0) return;

        uint80 sId = (uint80(1)<<64)|uint80(uint256(c.cS)+1);
        uint80 eId = (uint80(1)<<64)|uint80(uint256(c.cE)+1);

        (, int256 sPrice, , , ) = feed.getRoundData(sId);
        (, int256 ePrice, , , ) = feed.getRoundData(eId);

        // Determine expected outcome.
        PredictionArena.RoundState    expState;
        PredictionArena.RefundReason  expReason;
        uint256 expFee;

        if (eId <= sId) {
            expState  = PredictionArena.RoundState.Refunded;
            expReason = PredictionArena.RefundReason.EndNotAfterStart;
        } else if (sPrice <= 0 || ePrice <= 0) {
            expState  = PredictionArena.RoundState.Refunded;
            expReason = PredictionArena.RefundReason.InvalidPrice;
        } else if (c.equalPrices || ePrice == sPrice) {
            expState  = PredictionArena.RoundState.Refunded;
            expReason = PredictionArena.RefundReason.UnchangedPrice;
        } else {
            // Prices strictly increase with index → ePrice > sPrice → UP wins.
            expState  = PredictionArena.RoundState.SettledUp;
            expReason = PredictionArena.RefundReason.None;
            expFee    = c.amt * 200 / 10_000; // DOWN side (bob) lost
        }

        vm.expectEmit(true, true, false, true);
        emit PredictionArena.RoundSettled(
            btcId, 1, expState, sId, eId, sPrice, ePrice, expReason
        );
        vm.prank(settler);
        arena.settle(btcId, 1, sId, eId);

        (,, uint80 storedS, uint80 storedE, int256 storedSP, int256 storedEP,
            PredictionArena.RoundState storedState) = arena.rounds(btcId, 1);
        assertEq(uint8(storedState), uint8(expState),  "state D");
        assertEq(storedS,  sId,    "startId D");
        assertEq(storedE,  eId,    "endId D");
        assertEq(storedSP, sPrice, "startPrice D");
        assertEq(storedEP, ePrice, "endPrice D");
        assertEq(arena.feesAccrued(), expFee, "fee D");
        assertEq(usdc.balanceOf(address(arena)), c.balBefore, "bal D");
    }

    function _sweepAndCheck(
        uint256 n,
        uint256 lt,
        uint256 et,
        int256  cS,
        int256  cE,
        bool    latestBL,
        uint256 balBefore
    ) internal {
        uint80[] memory sC = new uint80[](25); uint256 nSC;
        uint80[] memory eC = new uint80[](25); uint256 nEC;
        sC[nSC++] = 0;
        for (uint256 i = 0; i < n; i++) {
            uint80 id = (uint80(1) << 64) | uint80(i + 1);
            if (id > 1 && _push80(sC, nSC, id-1)) nSC++;
            if (_push80(sC, nSC, id)) nSC++;
            if (id < type(uint80).max && _push80(sC, nSC, id+1)) nSC++;
            if (id > 1 && _push80(eC, nEC, id-1)) nEC++;
            if (_push80(eC, nEC, id)) nEC++;
            if (id < type(uint80).max && _push80(eC, nEC, id+1)) nEC++;
        }
        if (_push80(eC, nEC, type(uint80).max)) nEC++;

        // Snapshot/revert loop delegated to a separate function.
        uint256 wins = _sweepLoop(sC, nSC, eC, nEC, cS, cE, latestBL);

        // Count assertions.
        if (cS < 0 && latestBL) {
            assertEq(wins, nEC, "expected nEC wins for no-start");
        } else if (cS < 0 || cE < 0) {
            assertEq(wins, 0, "expected 0 wins");
        } else {
            assertEq(wins, 1, "expected exactly 1 win");
        }

        // The real settle (and balance assertion) is done in _checkFuzzResult.
        // Do NOT settle here; the round is still Unsettled at this point.
        lt; et; // suppress unused-local warnings
    }

    function _sweepLoop(
        uint80[] memory sC, uint256 nSC,
        uint80[] memory eC, uint256 nEC,
        int256 cS, int256 cE, bool latestBL
    ) internal returns (uint256 wins) {
        for (uint256 si = 0; si < nSC; si++) {
            for (uint256 ei = 0; ei < nEC; ei++) {
                wins += _settleOne(sC[si], eC[ei], cS, cE, latestBL);
            }
        }
    }

    // One snapshot/settle/revert for a single (sId, eId) pair.
    function _settleOne(
        uint80 sId, uint80 eId,
        int256 cS, int256 cE, bool latestBL
    ) internal returns (uint256 didSucceed) {
        uint256 snap = vm.snapshotState();
        (bool ok, bytes4 err) = _trySettle(btcId, 1, sId, eId);
        vm.revertToStateAndDelete(snap);
        if (ok) {
            didSucceed = 1;
            if (cS >= 0 && cE >= 0) {
                assertEq(sId, (uint80(1)<<64)|uint80(uint256(cS)+1), "wrong sId");
                assertEq(eId, (uint80(1)<<64)|uint80(uint256(cE)+1), "wrong eId");
            } else if (latestBL) {
                assertEq(sId, 0, "expected sId=0");
            } else { fail(); }
        } else {
            bytes4 selS = PredictionArena.InvalidStartRound.selector;
            bytes4 selE = PredictionArena.InvalidEndRound.selector;
            assertTrue(err == selS || err == selE, "unexpected revert");
        }
    }

    function _push80(uint80[] memory arr, uint256 idx, uint80 val)
        internal pure returns (bool)
    {
        for (uint256 i = 0; i < idx; i++) if (arr[i] == val) return false;
        arr[idx] = val;
        return true;
    }

    /// @dev Try calling settle and return (succeeded, errorSelector).
    ///      Uses a low-level call so we can inspect the revert data.
    function _trySettle(
        uint256 mid,
        uint256 roundIdx,
        uint80  sId,
        uint80  eId
    ) internal returns (bool ok, bytes4 sel) {
        bytes memory data = abi.encodeWithSelector(
            PredictionArena.settle.selector,
            mid, roundIdx, sId, eId
        );
        bytes memory ret;
        (ok, ret) = address(arena).call(data);
        if (!ok && ret.length >= 4) {
            sel = bytes4(ret[0]) | (bytes4(ret[1]) >> 8) |
                  (bytes4(ret[2]) >> 16) | (bytes4(ret[3]) >> 24);
        }
    }

    // =========================================================
    //  Refund – no update inside the round
    //  (updates exist before lock AND after end, but none in [lt, et])
    // =========================================================

    function test_refund_noUpdateInRound_updatesBeforeAndAfter() public {
        // Feed has an update BEFORE lock and one AFTER end, but NONE during
        // the round.  The correct submission is:
        //   startId = id2 (at et+2, first update with updatedAt >= lt ✓,
        //                  predecessor id1 at lt-10 < lt ✓)
        //   endId   = id1 (at lt-10, last update with updatedAt <= et ✓,
        //                  successor id2 at et+2 > et ✓ — so id1 IS the last)
        // Because endId.roundInPhase (1) < startId.roundInPhase (2) the
        // outcome is EndNotAfterStart (Rule 16).
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1);
        uint256 et = _end(1);

        vm.warp(lt - 10); vm.prank(owner); feed.setPrice(100e8); // id1 before lock
        vm.warp(et +  2); vm.prank(owner); feed.setPrice(200e8); // id2 after end

        // Warp to et+3: strictly after et, strictly after the last update
        // (et+2), and well inside the 1-hour settle window.
        // We never warp backwards.
        vm.warp(et + 3);

        uint80 startId = (uint80(1)<<64)|2;
        uint80 endId   = (uint80(1)<<64)|1;

        // Assert the event carries reason EndNotAfterStart (not OneSided or None).
        vm.expectEmit(true, true, false, true);
        emit PredictionArena.RoundSettled(
            btcId, 1,
            PredictionArena.RoundState.Refunded,
            startId, endId,
            200e8,  // startPrice = price of id2
            100e8,  // endPrice   = price of id1
            PredictionArena.RefundReason.EndNotAfterStart
        );
        vm.prank(settler);
        arena.settle(btcId, 1, startId, endId);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded),
            "expected Refunded");

        (, , uint80 sId, uint80 eId, , , ) = arena.rounds(btcId, 1);
        assertEq(sId, startId, "stored startId wrong");
        assertEq(eId, endId,   "stored endId wrong");

        assertEq(arena.feesAccrued(), 0, "no fee on refund");
        assertEq(usdc.balanceOf(address(arena)), uint256(MIN) * 2,
            "balance unchanged");
    }

    // =========================================================
    //  A. End-time boundary (guards against M3 / M4)
    //
    //  Setup: three updates inside one round:
    //    U1 at lt+50  (inside round)
    //    U2 at et     (exactly at endTime)
    //    U3 at et+50  (after end)
    //  start = U1 is a valid start (first after lock, predecessor is pre-lock).
    // =========================================================

    /// Helper: set up BTC round 1 with a pre-lock update, then U1/U2/U3.
    /// Returns (lt, et, idPrelock, idU1, idU2, idU3).
    function _setupEndBoundary()
        internal
        returns (
            uint256 lt, uint256 et,
            uint80 idPre, uint80 idU1, uint80 idU2, uint80 idU3
        )
    {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        lt = _lock(1); et = _end(1);

        // id1 = pre-lock (valid start predecessor)
        vm.warp(lt - 50); vm.prank(owner); feed.setPrice(100e8);
        idPre = (uint80(1)<<64)|1;

        // id2 = U1: inside round (valid start, valid end if U2 didn't exist)
        vm.warp(lt + 50); vm.prank(owner); feed.setPrice(101e8);
        idU1 = (uint80(1)<<64)|2;

        // id3 = U2: exactly at endTime (must be valid end: updatedAt == et <= et)
        vm.warp(et); vm.prank(owner); feed.setPrice(102e8);
        idU2 = (uint80(1)<<64)|3;

        // id4 = U3: after end
        vm.warp(et + 50); vm.prank(owner); feed.setPrice(103e8);
        idU3 = (uint80(1)<<64)|4;
    }

    /// Guard: an update stamped EXACTLY at endTime is a valid end.
    /// Bug caught: M3 changes `endAt > et` to `endAt >= et`, which would
    /// reject U2 (et == et ≥ et is true → reject), letting a non-last update
    /// through.
    function test_endBoundary_exactlyAtEndTime_isValidEnd() public {
        (uint256 lt, uint256 et,, uint80 idU1, uint80 idU2,) =
            _setupEndBoundary();
        // Warp past the update at et+50 to stay in the settle window.
        vm.warp(et + 51);
        // U1 is a valid start (first after lock, predecessor lt-50 < lt).
        // U2 is a valid end: updatedAt == et (on the boundary), successor U3
        // has updatedAt = et+50 > et, so U2 truly is the LAST update at/before end.
        vm.prank(settler);
        arena.settle(btcId, 1, idU1, idU2);
        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        // Must settle (not revert), and state must be terminal.
        assertTrue(state != PredictionArena.RoundState.Unsettled,
            "round should be settled");
        lt; // suppress unused-local warning
    }

    /// Guard: U1 is NOT the last update at/before end – its successor U2 is at
    /// et (i.e. <= et), so U1 must be rejected as end.
    /// Bug caught: M4 changes `nextAt <= et` to `nextAt < et`, which would
    /// accept a successor at exactly et and wrongly let U1 through as end.
    function test_endBoundary_U1_notLastBecauseSuccessorAtEnd_reverts() public {
        (, uint256 et,, uint80 idU1,,) = _setupEndBoundary();
        vm.warp(et + 51);
        // U1's successor is U2 at updatedAt == et (not strictly after et),
        // so U1 is NOT the last valid end update.
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidEndRound.selector, idU1)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2 /*U1 start trick: use U1 as both*/,
                               idU1);
        // Note: the revert is due to the end check (successor U2 has updatedAt
        // == et which is <= et, so U1 is not last). The start selector is not
        // what we're testing here – if start also reverts, adjust.
    }

    /// U3 (after end) must be rejected as end (updatedAt = et+50 > et).
    /// This is also covered by test_cheat_endAfterEndTime_reverts but we
    /// repeat it here with the exact boundary setup for clarity.
    function test_endBoundary_U3_afterEnd_reverts() public {
        (, uint256 et,, uint80 idU1,, uint80 idU3) = _setupEndBoundary();
        vm.warp(et + 51);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidEndRound.selector, idU3)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, idU1, idU3);
    }

    // =========================================================
    //  B. Lock-time boundary (guards against M1 / M2)
    //
    //  Setup:
    //    P  at lt - 50  (before lock, NOT a valid start)
    //    Q  at lt       (exactly at lockTime, IS a valid start)
    //    R  at lt + 100 (inside round, NOT a valid start: predecessor Q >= lt)
    //    E  at et - 100 (valid end inside round)
    // =========================================================

    function _setupLockBoundary()
        internal
        returns (
            uint256 lt, uint256 et,
            uint80 idP, uint80 idQ, uint80 idR, uint80 idE
        )
    {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        lt = _lock(1); et = _end(1);

        vm.warp(lt - 50);  vm.prank(owner); feed.setPrice(100e8); idP = (uint80(1)<<64)|1;
        vm.warp(lt);       vm.prank(owner); feed.setPrice(101e8); idQ = (uint80(1)<<64)|2;
        vm.warp(lt + 100); vm.prank(owner); feed.setPrice(102e8); idR = (uint80(1)<<64)|3;
        vm.warp(et - 100); vm.prank(owner); feed.setPrice(103e8); idE = (uint80(1)<<64)|4;
    }

    /// Q (at exactly lockTime) is a valid start: updatedAt == lt >= lt.
    /// Predecessor P has updatedAt = lt-50 < lt, so Q is the FIRST after lock.
    /// Bug caught: M1 changes `startAt < lt` to `startAt <= lt`, which would
    /// reject Q (startAt == lt → lt <= lt is true → "before lock" → reject).
    function test_lockBoundary_exactlyAtLock_isValidStart() public {
        (, uint256 et, uint80 idP, uint80 idQ, , uint80 idE) = _setupLockBoundary();
        vm.warp(et + 1);
        // Q is a valid start; E is a valid end.
        vm.prank(settler);
        arena.settle(btcId, 1, idQ, idE);
        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertTrue(state != PredictionArena.RoundState.Unsettled,
            "round should be settled");
        idP; // suppress unused warning
    }

    /// P (before lock) is NOT a valid start.
    /// Named unit test so M1 is caught by name, not only the fuzz test.
    /// Bug caught: M1 changes `startAt < lt` to `startAt <= lt`, which would
    /// STILL reject P (lt-50 <= lt is true), so P stays rejected — this test
    /// guards M2 instead (P's predecessor does not exist, so with M2 it would
    /// be accepted). Together with test_lockBoundary_exactlyAtLock_isValidStart,
    /// both M1 and M2 are covered by deterministic tests.
    function test_lockBoundary_beforeLock_reverts() public {
        (, uint256 et, uint80 idP, , , uint80 idE) = _setupLockBoundary();
        vm.warp(et + 1);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, idP)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, idP, idE);
    }

    /// R (inside round) is NOT a valid start because its predecessor Q has
    /// updatedAt = lt (>= lt), so R is not the FIRST update after lock.
    /// Bug caught: M2 changes `prevAt >= lt` to `prevAt > lt`, which would
    /// accept R if prevAt == lt (exactly at lock is no longer disqualifying).
    function test_lockBoundary_R_notFirstAfterLock_reverts() public {
        (, uint256 et, , , uint80 idR, uint80 idE) = _setupLockBoundary();
        vm.warp(et + 1);
        // R's predecessor Q has updatedAt = lt. With correct code (>= lt) this
        // means Q also qualifies, so R is NOT the first after lock.
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, idR)
        );
        vm.prank(settler);
        arena.settle(btcId, 1, idR, idE);
    }

    // =========================================================
    //  C. Fee base with unequal bets (guards against M9 / M9b / M13)
    //
    //  Uses a market with minStake = 1 so we can test rounding to 0.
    // =========================================================

    // Market with minStake 1 for rounding tests.
    uint256 microId;

    function _setupMicroMarket() internal {
        vm.prank(owner);
        arena.createMarket("MICRO", address(feed), address(0), ROUND, 0, 1);
        microId = arena.marketCount() - 1;
    }

    /// Helper: set up a round on the given market with separate UP/DOWN amounts.
    function _placeSplitBets(
        uint256 mid, uint256 roundIdx,
        uint256 upAmt, uint256 downAmt
    ) internal {
        _fund(alice, upAmt);
        _fund(bob,   downAmt);
        vm.prank(alice); arena.placeBet(mid, roundIdx, true,  upAmt);
        vm.prank(bob);   arena.placeBet(mid, roundIdx, false, downAmt);
    }

    /// UP wins with unequal bets: fee = downTotal * 2% (NOT upTotal).
    /// Bug caught: M9 swaps fee base to upTotal for SettledUp.
    function test_fee_upWins_unequalBets() public {
        // UP = 1_000_000 (alice: 600k + 400k top-up not possible since WrongSide
        // – use two different UP bettors instead).
        address alice2 = makeAddr("alice2");
        uint256 upAmt   = 1_000_000; // alice bets all at once
        uint256 downAmt =   250_000; // bob

        vm.warp(1);
        _fund(alice,  upAmt);
        _fund(bob,    downAmt);
        vm.prank(alice); arena.placeBet(btcId, 1, true,  upAmt);
        vm.prank(bob);   arena.placeBet(btcId, 1, false, downAmt);

        uint256 lt = _lock(1); uint256 et = _end(1);
        vm.warp(lt - 5);  vm.prank(owner); feed.setPrice(100e8); // pre-lock
        vm.warp(lt + 1);  vm.prank(owner); feed.setPrice(100e8); // start (id2)
        vm.warp(et - 1);  vm.prank(owner); feed.setPrice(101e8); // end   (id3)
        vm.warp(et + 1);

        vm.prank(settler);
        arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.SettledUp));

        // fee = downTotal * 200 / 10_000 = 250_000 * 200 / 10_000 = 5_000
        assertEq(arena.feesAccrued(), 5_000,
            "fee should be 2% of DOWN total (250_000), not UP total");
        alice2; // suppress unused warning
    }

    /// DOWN wins with unequal bets: fee = upTotal * 2%.
    /// Bug caught: M9b swaps fee base to downTotal for SettledDown.
    function test_fee_downWins_unequalBets() public {
        uint256 upAmt   = 1_000_000;
        uint256 downAmt =   250_000;

        // Need a fresh round (use round 0 on BTC which starts at offset 0).
        // Actually offset 0 so round 0 locks at timestamp 0, already passed.
        // Use btcId round 1 but we need a clean market for the prices.
        // Simplest: use a second round on BTC via a later warp.
        // Instead, use ethId round 1.
        uint256 lt2 = arena.lockTime(ethId, 1);
        uint256 et2 = arena.endTime(ethId, 1);

        vm.warp(lt2 - 100);
        _fund(alice, upAmt);
        _fund(bob,   downAmt);
        vm.prank(alice); arena.placeBet(ethId, 1, true,  upAmt);
        vm.prank(bob);   arena.placeBet(ethId, 1, false, downAmt);

        // These feed updates add to the shared feed. Use fresh ids.
        // (The BTC tests above may have already set prices; ethId uses the same
        //  feed.  We need id1=pre-lock, id2=start, id3=end relative to ethId lt2.)
        // Since this test runs independently in a fresh setUp, the feed is clean.
        vm.warp(lt2 - 5);  vm.prank(owner); feed.setPrice(100e8); // id1 pre-lock
        vm.warp(lt2 + 1);  vm.prank(owner); feed.setPrice(100e8); // id2 start
        vm.warp(et2 - 1);  vm.prank(owner); feed.setPrice(99e8);  // id3 end (down)
        vm.warp(et2 + 1);

        vm.prank(settler);
        arena.settle(ethId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(ethId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.SettledDown));

        // fee = upTotal * 200 / 10_000 = 1_000_000 * 200 / 10_000 = 20_000
        assertEq(arena.feesAccrued(), 20_000,
            "fee should be 2% of UP total (1_000_000), not DOWN total");
    }

    /// Rounding: losing total = 33 (< 10_000 / 200 = 50) → fee rounds DOWN to 0.
    /// Bug caught: M13 adds round-UP bias (+ BPS - 1) so 33 * 200 + 9999 = 16599;
    /// 16599 / 10_000 = 1 instead of 0.
    function test_fee_rounding_down_to_zero() public {
        _setupMicroMarket();

        // Use solId (offset 2400) to avoid timestamp conflicts.
        // Actually use microId (offset 0).  Round 1: lock = 3600.
        uint256 lt3 = arena.lockTime(microId, 1);
        uint256 et3 = arena.endTime(microId, 1);

        vm.warp(1);
        // UP side: some large amount (wins). DOWN side: 33 (loses).
        uint256 winAmt  = MIN;  // 100_000
        uint256 loseAmt = 33;   // fee = 33 * 200 / 10_000 = 0 (rounded down)

        _fund(alice, winAmt);
        _fund(bob,   loseAmt);
        vm.prank(alice); arena.placeBet(microId, 1, true,  winAmt);
        vm.prank(bob);   arena.placeBet(microId, 1, false, loseAmt);

        // Fresh feed (microId uses the same shared feed).
        // This test runs in isolation so the feed is clean.
        vm.warp(lt3 - 5);  vm.prank(owner); feed.setPrice(50e8);   // id1 pre-lock
        vm.warp(lt3 + 1);  vm.prank(owner); feed.setPrice(50e8);   // id2 start
        vm.warp(et3 - 1);  vm.prank(owner); feed.setPrice(51e8);   // id3 end (UP wins)
        vm.warp(et3 + 1);

        vm.prank(settler);
        arena.settle(microId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(microId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.SettledUp));

        // 33 * 200 / 10_000 = 0 (integer division rounds down, not up).
        assertEq(arena.feesAccrued(), 0,
            "fee must round DOWN: 33 * 2% = 0.66 truncates to 0");
    }

    // =========================================================
    //  D. Phase 1 first-update: SettledUp and SettledDown
    //     (guards against M12 which makes phase 1 round 1 a PhaseEdge refund)
    // =========================================================

    /// The very first feed update ever (id = (1<<64)|1) is inside the round
    /// at/after lock.  A second update inside the round is the end with a
    /// higher price.  Expected: SettledUp, reason None.
    ///
    /// Bug caught: M12 changes `startPhase > 1` to `startPhase >= 1`, turning
    /// phase 1 round 1 into a PhaseEdge refund instead of checking prices.
    function test_phase1_firstUpdate_settlesUp() public {
        // Fresh market so the feed has NO previous updates.
        MockPriceFeed freshFeed = new MockPriceFeed(
            owner, 8, "TEST PRICES - NOT REAL DATA / phase1-up"
        );
        vm.prank(owner);
        arena.createMarket("P1UP", address(freshFeed), address(0), ROUND, 0, MIN);
        uint256 p1Id = arena.marketCount() - 1;

        uint256 lt4 = arena.lockTime(p1Id, 1);
        uint256 et4 = arena.endTime(p1Id, 1);

        vm.warp(1);
        _fund(alice, MIN); vm.prank(alice); arena.placeBet(p1Id, 1, true,  MIN);
        _fund(bob,   MIN); vm.prank(bob);   arena.placeBet(p1Id, 1, false, MIN);

        // ONLY updates are inside the round – no pre-lock update.
        vm.warp(lt4 + 1);   vm.prank(owner); freshFeed.setPrice(100e8); // id=(1<<64)|1 start
        vm.warp(lt4 + 100); vm.prank(owner); freshFeed.setPrice(110e8); // id=(1<<64)|2 end (higher)

        vm.warp(et4 + 1);

        uint80 startId = (uint80(1)<<64)|1;
        uint80 endId   = (uint80(1)<<64)|2;

        // Expect SettledUp, reason None.
        vm.expectEmit(true, true, false, true);
        emit PredictionArena.RoundSettled(
            p1Id, 1,
            PredictionArena.RoundState.SettledUp,
            startId, endId, 100e8, 110e8,
            PredictionArena.RefundReason.None
        );
        vm.prank(settler);
        arena.settle(p1Id, 1, startId, endId);

        (,, uint80 sId, uint80 eId,,, PredictionArena.RoundState state) =
            arena.rounds(p1Id, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.SettledUp),
            "must be SettledUp, not PhaseEdge refund");
        assertEq(sId, startId, "stored startId");
        assertEq(eId, endId,   "stored endId");
    }

    /// Mirror: phase 1 first update, end price lower → SettledDown, reason None.
    function test_phase1_firstUpdate_settlesDown() public {
        MockPriceFeed freshFeed2 = new MockPriceFeed(
            owner, 8, "TEST PRICES - NOT REAL DATA / phase1-dn"
        );
        vm.prank(owner);
        arena.createMarket("P1DN", address(freshFeed2), address(0), ROUND, 0, MIN);
        uint256 p1dId = arena.marketCount() - 1;

        uint256 lt5 = arena.lockTime(p1dId, 1);
        uint256 et5 = arena.endTime(p1dId, 1);

        vm.warp(1);
        _fund(alice, MIN); vm.prank(alice); arena.placeBet(p1dId, 1, true,  MIN);
        _fund(bob,   MIN); vm.prank(bob);   arena.placeBet(p1dId, 1, false, MIN);

        vm.warp(lt5 + 1);   vm.prank(owner); freshFeed2.setPrice(100e8); // id1 start
        vm.warp(lt5 + 100); vm.prank(owner); freshFeed2.setPrice(90e8);  // id2 end (lower)

        vm.warp(et5 + 1);

        uint80 startId = (uint80(1)<<64)|1;
        uint80 endId   = (uint80(1)<<64)|2;

        vm.expectEmit(true, true, false, true);
        emit PredictionArena.RoundSettled(
            p1dId, 1,
            PredictionArena.RoundState.SettledDown,
            startId, endId, 100e8, 90e8,
            PredictionArena.RefundReason.None
        );
        vm.prank(settler);
        arena.settle(p1dId, 1, startId, endId);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(p1dId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.SettledDown),
            "must be SettledDown, not PhaseEdge refund");
    }

    /// Existing phase-edge tests now explicitly check reason == PhaseEdge.
    /// (These are separate tests rather than modifying the originals so the
    ///  original tests remain intact as a baseline.)
    function test_phase_startIsFirstOfPhase2_reason_phaseEdge() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8);
        vm.prank(owner); feed.startNewPhase();
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(101e8); // (2<<64)|1
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(102e8); // (2<<64)|2

        uint80 startId = (uint80(2)<<64)|1;
        uint80 endId   = (uint80(2)<<64)|2;

        vm.warp(et + 1);
        vm.expectEmit(true, true, false, true);
        emit PredictionArena.RoundSettled(
            btcId, 1,
            PredictionArena.RoundState.Refunded,
            startId, 0, 101e8, 0,
            PredictionArena.RefundReason.PhaseEdge
        );
        vm.prank(settler);
        arena.settle(btcId, 1, startId, endId);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
    }

    function test_phase_endSuccessorMissingNotLatest_reason_phaseEdge() public {
        vm.warp(1);
        _placeBothBets(btcId, 1, MIN);
        uint256 lt = _lock(1); uint256 et = _end(1);

        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8); // (1<<64)|1
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(101e8); // (1<<64)|2 start
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(102e8); // (1<<64)|3 end

        vm.prank(owner); feed.startNewPhase();
        vm.warp(et + 2); vm.prank(owner); feed.setPrice(103e8); // (2<<64)|1 latest

        uint80 startId = (uint80(1)<<64)|2;
        uint80 endId   = (uint80(1)<<64)|3;

        vm.warp(et + 1);
        vm.expectEmit(true, true, false, true);
        emit PredictionArena.RoundSettled(
            btcId, 1,
            PredictionArena.RoundState.Refunded,
            startId, endId, 101e8, 102e8,
            PredictionArena.RefundReason.PhaseEdge
        );
        vm.prank(settler);
        arena.settle(btcId, 1, startId, endId);

        (,,,,,, PredictionArena.RoundState state) = arena.rounds(btcId, 1);
        assertEq(uint8(state), uint8(PredictionArena.RoundState.Refunded));
    }
}
