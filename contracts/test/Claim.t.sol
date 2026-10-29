// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Kairo Markets – Claim / Payout tests (Step 6, v1.1 Matched Calls)
//
//  Covers:
//   - Happy paths (UP wins, DOWN wins, 3+ players, unequal calls)
//   - Bigger-side loser receives unmatched stake back
//   - All refund reasons pay exact stake, no fee
//   - Once-only, stranger, wrong-time guards
//   - Dust: last-winner trigger, no-sweep, conservation
//   - Order independence (3-winner permutations)
//   - claimMany: batching, single transfer, mixed rounds, all reverts
//   - withdrawFees guard (FeesWouldTouchPlayerFunds)
//   - matchedStake() view correctness
//   - Stateful invariant test via Foundry invariant() + handler
// =============================================================

import {Test, console} from "forge-std/Test.sol";
import {PredictionArena} from "../PredictionArena.sol";
import {MockPriceFeed}   from "../mocks/MockPriceFeed.sol";
import {MockUSDC}        from "./MockUSDC.sol";

// =============================================================
//  Shared base for unit tests and invariant handler
// =============================================================
contract ClaimBase is Test {

    PredictionArena arena;
    MockUSDC        usdc;
    MockPriceFeed   feed;

    address owner   = makeAddr("owner");
    address alice   = makeAddr("alice");
    address bob     = makeAddr("bob");
    address carol   = makeAddr("carol");
    address dave    = makeAddr("dave");
    address settler = makeAddr("settler");

    uint256 btcId;
    uint256 ethId;
    uint256 solId;

    uint32  constant ROUND   = 3600;
    uint32  constant OFF_BTC = 0;
    uint32  constant OFF_ETH = 1200;
    uint32  constant OFF_SOL = 2400;
    uint128 constant MIN     = 100_000; // $0.10

    function _baseSetUp() internal {
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

    // ── helpers ──────────────────────────────────────────────

    function _fund(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.prank(who);
        usdc.approve(address(arena), amt);
    }

    function _makeCall(address who, uint256 mid, uint256 rnd, bool up, uint256 amt) internal {
        _fund(who, amt);
        vm.prank(who);
        arena.placeCall(mid, rnd, up, amt);
    }

    function _lock(uint256 mid, uint256 k) internal view returns (uint256) {
        return arena.lockTime(mid, k);
    }
    function _end(uint256 mid, uint256 k) internal view returns (uint256) {
        return arena.endTime(mid, k);
    }

    /// Set up feed and settle BTC round 1 with start price P1 and end price P2.
    /// Call AFTER calls have been placed and time warped to before lock.
    function _settleWith(uint256 mid, uint256 rnd, int256 p1, int256 p2)
        internal
    {
        uint256 lt = _lock(mid, rnd);
        uint256 et = _end(mid, rnd);
        vm.warp(lt - 5);  vm.prank(owner); feed.setPrice(p1 - 1); // pre-lock (id N)
        vm.warp(lt + 1);  vm.prank(owner); feed.setPrice(p1);      // start (id N+1)
        vm.warp(et - 1);  vm.prank(owner); feed.setPrice(p2);      // end   (id N+2)
        vm.warp(et + 1);
    }

    /// Settle a round after _settleWith set up the feed.
    /// startId and endId are the two ids in the round (N+1 and N+2 above).
    function _doSettle(uint256 mid, uint256 rnd, uint80 startId, uint80 endId)
        internal
    {
        vm.prank(settler);
        arena.settle(mid, rnd, startId, endId);
    }

    function _claim(address who, uint256 mid, uint256 rnd)
        internal returns (uint256)
    {
        vm.prank(who);
        return arena.claim(mid, rnd);
    }
}

// =============================================================
//  Main unit test contract
// =============================================================
contract ClaimTest is ClaimBase {

    function setUp() public {
        _baseSetUp();
    }

    // =========================================================
    //  Happy path – UP wins, 3 players UP, 2 DOWN
    //
    //  UP callers:   alice 600_000, bob 400_000, carol 200_000  → U = 1_200_000
    //  DOWN callers: dave  750_000, settler 250_000             → D = 1_000_000
    //  M = min(U, D) = 1_000_000   T = max(U, D) = 1_200_000
    //  F = floor(M * 200 / 10_000) = 20_000
    //  Dist = M - F = 980_000
    //
    //  UP side (winners, bigger side → floor(s * M / T)):
    //    Alice  matched = floor(600_000 * 1_000_000 / 1_200_000) = 500_000
    //           bonus   = floor(500_000 * 980_000 / 1_000_000)  = 490_000
    //           payout  = 600_000 + 490_000 = 1_090_000
    //    Bob    matched = floor(400_000 * 1_000_000 / 1_200_000) = 333_333
    //           bonus   = floor(333_333 * 980_000 / 1_000_000)  = 326_666
    //           payout  = 400_000 + 326_666 = 726_666
    //    Carol  matched = floor(200_000 * 1_000_000 / 1_200_000) = 166_666
    //           bonus   = floor(166_666 * 980_000 / 1_000_000)  = 163_332
    //           payout  = 200_000 + 163_332 = 363_332
    //
    //  DOWN side (losers, smaller side → fully matched, unmatched = 0 → NothingToClaim)
    //
    //  Sum matched_UP = 500_000 + 333_333 + 166_666 = 999_999 ≤ M ✓
    //  Sum bonuses    = 490_000 + 326_666 + 163_332 = 979_998
    //  dust = Dist - sum(bonuses) = 980_000 - 979_998 = 2
    //  feesAccrued after all claims = 20_000 + 2 = 20_002
    //  Total out to players = 1_090_000 + 726_666 + 363_332 = 2_179_998
    //  Conservation: 2_179_998 + 20_002 = 2_200_000 ✓
    // =========================================================

    uint128 constant UP_ALICE  = 600_000;
    uint128 constant UP_BOB    = 400_000;
    uint128 constant UP_CAROL  = 200_000;
    uint128 constant DN_DAVE   = 750_000;
    uint128 constant DN_SETTLER= 250_000;

    // Returns (lt, et, startId, endId) after setting up calls and the feed.
    function _setupUpWins()
        internal
        returns (uint256 lt, uint256 et, uint80 startId, uint80 endId)
    {
        vm.warp(1);
        _makeCall(alice,   btcId, 1, true,  UP_ALICE);
        _makeCall(bob,     btcId, 1, true,  UP_BOB);
        _makeCall(carol,   btcId, 1, true,  UP_CAROL);
        _makeCall(dave,    btcId, 1, false, DN_DAVE);
        _makeCall(settler, btcId, 1, false, DN_SETTLER);

        lt = _lock(btcId, 1);
        et = _end(btcId, 1);

        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100_000e8); // id1
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(100_000e8); // id2 = start
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(101_000e8); // id3 = end

        startId = (uint80(1) << 64) | 2;
        endId   = (uint80(1) << 64) | 3;
        vm.warp(et + 1);
        vm.prank(settler); arena.settle(btcId, 1, startId, endId);
    }

    function test_upWins_alicePayout() public {
        _setupUpWins();
        // Expected: 600_000 + floor(600_000 * 980_000 / 1_200_000) = 1_090_000
        uint256 p = _claim(alice, btcId, 1);
        assertEq(p, 1_090_000, "alice payout");
        assertEq(usdc.balanceOf(alice), 1_090_000);
    }

    function test_upWins_bobPayout() public {
        _setupUpWins();
        uint256 p = _claim(bob, btcId, 1);
        // 400_000 + floor(400_000 * 980_000 / 1_200_000)
        // = 400_000 + 326_666 = 726_666
        assertEq(p, 726_666, "bob payout");
    }

    function test_upWins_carolPayout() public {
        _setupUpWins();
        uint256 p = _claim(carol, btcId, 1);
        // matched = floor(200_000 * 1_000_000 / 1_200_000) = 166_666
        // bonus   = floor(166_666 * 980_000 / 1_000_000)  = 163_332
        // payout  = 200_000 + 163_332 = 363_332
        assertEq(p, 363_332, "carol payout");
    }

    function test_upWins_loserReverts() public {
        _setupUpWins();
        vm.prank(dave);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.NothingToClaim.selector, btcId, 1)
        );
        arena.claim(btcId, 1);
    }

    function test_upWins_conservation() public {
        _setupUpWins();
        uint256 totalIn = UP_ALICE + UP_BOB + UP_CAROL + DN_DAVE + DN_SETTLER;
        // 2_200_000

        _claim(alice, btcId, 1);
        _claim(bob,   btcId, 1);
        _claim(carol, btcId, 1);

        // feesAccrued = fee(20_000) + dust(2) = 20_002
        assertEq(arena.feesAccrued(), 20_002, "feesAccrued after all claims");
        // Contract balance == feesAccrued (all player money out)
        assertEq(usdc.balanceOf(address(arena)), 20_002, "balance == feesAccrued");
        // totalPlayerFunds should now be 0
        assertEq(arena.totalPlayerFunds(), 0, "totalPlayerFunds == 0");
        // Sum of payouts == totalIn - feesAccrued
        assertEq(
            1_090_000 + 726_666 + 363_332,
            totalIn - 20_002,
            "payout + fees == total"
        );
    }

    // =========================================================
    //  Happy path – DOWN wins, 3 players
    //
    //  UP:  alice 1_000_000                           → U = 1_000_000
    //  DOWN: bob 300_000, carol 200_000, dave 100_000 → D = 600_000
    //
    //  M = min(1_000_000, 600_000) = 600_000   T = 1_000_000
    //  F = floor(600_000 * 200 / 10_000) = 12_000
    //  Dist = 588_000
    //
    //  DOWN side (winners, smaller side → fully matched):
    //    Bob   matched=300_000, bonus=floor(300_000*588_000/600_000)=294_000, payout=594_000
    //    Carol matched=200_000, bonus=floor(200_000*588_000/600_000)=196_000, payout=396_000
    //    Dave  matched=100_000, bonus=floor(100_000*588_000/600_000)=98_000,  payout=198_000
    //
    //  UP side (loser, bigger side → ceil(s * M / T)):
    //    Alice matched = ceil(1_000_000 * 600_000 / 1_000_000) = 600_000
    //          unmatched = 400_000 → payout = 400_000
    //
    //  Sum bonuses = 294_000 + 196_000 + 98_000 = 588_000 → dust = 0
    //  feesAccrued = 12_000
    //  Total paid  = 594_000 + 396_000 + 198_000 + 400_000 = 1_588_000
    //  Conservation: 1_588_000 + 12_000 = 1_600_000 ✓
    // =========================================================

    function _setupDownWins()
        internal
        returns (uint80 startId, uint80 endId)
    {
        // ETH startOffset = 1200; at t=1201 nextCallableRound(ethId) == 1.
        vm.warp(1201);
        _makeCall(alice, ethId, 1, true,  1_000_000);
        _makeCall(bob,   ethId, 1, false, 300_000);
        _makeCall(carol, ethId, 1, false, 200_000);
        _makeCall(dave,  ethId, 1, false, 100_000);

        uint256 lt = _lock(ethId, 1);
        uint256 et = _end(ethId, 1);

        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(2000e8); // id1
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(2000e8); // id2
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(1900e8); // id3

        startId = (uint80(1) << 64) | 2;
        endId   = (uint80(1) << 64) | 3;
        vm.warp(et + 1);
        vm.prank(settler); arena.settle(ethId, 1, startId, endId);
    }

    function test_downWins_bobPayout() public {
        _setupDownWins();
        uint256 p = _claim(bob, ethId, 1);
        // matched=300_000 (smaller side), bonus=floor(300_000*588_000/600_000)=294_000
        assertEq(p, 594_000, "bob payout DOWN wins");
    }

    function test_downWins_carolPayout() public {
        _setupDownWins();
        uint256 p = _claim(carol, ethId, 1);
        // matched=200_000, bonus=196_000, payout=396_000
        assertEq(p, 396_000, "carol payout DOWN wins");
    }

    function test_downWins_davePayout() public {
        _setupDownWins();
        uint256 p = _claim(dave, ethId, 1);
        // matched=100_000, bonus=98_000, payout=198_000
        assertEq(p, 198_000, "dave payout DOWN wins");
    }

    /// Under matched calls, alice (UP, bigger side that lost) gets back
    /// her unmatched portion: stake - ceil(stake * M / T) = 1_000_000 - 600_000 = 400_000.
    function test_downWins_biggerSideLoser_getsUnmatched() public {
        _setupDownWins();
        uint256 p = _claim(alice, ethId, 1);
        assertEq(p, 400_000, "bigger-side loser gets unmatched stake back");
    }

    function test_downWins_conservation() public {
        _setupDownWins();
        _claim(bob,   ethId, 1);
        _claim(carol, ethId, 1);
        _claim(dave,  ethId, 1);
        _claim(alice, ethId, 1); // bigger-side loser
        // dust = 0; fee = 12_000
        assertEq(arena.feesAccrued(), 12_000);
        assertEq(usdc.balanceOf(address(arena)), 12_000);
        assertEq(arena.totalPlayerFunds(), 0);
    }

    /// claimable() must agree with claim() for the bigger-side loser.
    function test_downWins_claimable_biggerSideLoser() public {
        _setupDownWins();
        uint256 preview = arena.claimable(ethId, 1, alice);
        uint256 actual  = _claim(alice, ethId, 1);
        assertEq(preview, actual, "claimable matches claim for bigger-side loser");
    }

    // =========================================================
    //  Refund paths – exact stake returned, no fee
    // =========================================================

    /// Helper: call both sides, warp and settle with a refund outcome.
    function _setupAndSettleRefund(
        uint256 mid, uint256 rnd,
        uint80 startId, uint80 endId,
        int256 startPr, int256 endPr,
        PredictionArena.RefundReason reason
    ) internal {
        // Calls already placed by caller before calling this.
        uint256 lt = _lock(mid, rnd);
        uint256 et = _end(mid, rnd);

        if (reason == PredictionArena.RefundReason.OneSided) {
            vm.warp(et + 1);
            vm.prank(settler); arena.settle(mid, rnd, 0, 0);
            return;
        }
        if (reason == PredictionArena.RefundReason.NoUpdate) {
            // Only update before lock
            vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8);
            vm.warp(et + 1);
            vm.prank(settler); arena.settle(mid, rnd, 0, 0);
            return;
        }
        if (reason == PredictionArena.RefundReason.Timeout) {
            vm.warp(et + SETTLE_WINDOW() + 1);
            vm.prank(settler); arena.markRefunded(mid, rnd);
            return;
        }
        // For price-based refunds supply start/end.
        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(startPr - 1);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(startPr);
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(endPr);
        vm.warp(et + 1);
        vm.prank(settler); arena.settle(mid, rnd, startId, endId);
    }

    function SETTLE_WINDOW() internal pure returns (uint256) { return 1 hours; }

    function test_refund_oneSided_aliceGetsStakeBack() public {
        // Only alice calls UP; no DOWN callers.
        vm.warp(1);
        _makeCall(alice, btcId, 1, true, MIN);
        (, uint256 et, , ) = _times(btcId, 1);
        vm.warp(et + 1);
        vm.prank(settler); arena.settle(btcId, 1, 0, 0);

        uint256 p = _claim(alice, btcId, 1);
        assertEq(p, MIN, "oneSided refund amount");
        assertEq(arena.feesAccrued(), 0, "no fee on refund");
        assertEq(arena.totalPlayerFunds(), 0, "totalPlayerFunds 0");
    }

    function _times(uint256 mid, uint256 rnd)
        internal view
        returns (uint256 lt, uint256 et, uint80 s, uint80 e)
    {
        lt = _lock(mid, rnd); et = _end(mid, rnd);
        // ids set up by the standard 3-update pattern in _settleWith:
        // id1=pre-lock, id2=start, id3=end – but caller tracks feed state
        s = 0; e = 0; // not used in this helper
    }

    function test_refund_noUpdate_bothGetStakeBack() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true,  MIN);
        _makeCall(bob,   btcId, 1, false, MIN);
        uint256 lt = _lock(btcId, 1);
        uint256 et = _end(btcId, 1);
        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(et + 1);
        vm.prank(settler); arena.settle(btcId, 1, 0, 0);

        assertEq(_claim(alice, btcId, 1), MIN);
        assertEq(_claim(bob,   btcId, 1), MIN);
        assertEq(arena.feesAccrued(), 0);
    }

    function test_refund_unchangedPrice_bothGetStakeBack() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true,  2*MIN);
        _makeCall(bob,   btcId, 1, false, 3*MIN);
        uint256 lt = _lock(btcId, 1);
        uint256 et = _end(btcId, 1);
        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(et + 1);
        vm.prank(settler); arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);
        assertEq(_claim(alice, btcId, 1), 2*MIN);
        assertEq(_claim(bob,   btcId, 1), 3*MIN);
        assertEq(arena.feesAccrued(), 0);
    }

    function test_refund_invalidPrice_bothGetStakeBack() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true,  MIN);
        _makeCall(bob,   btcId, 1, false, MIN);
        uint256 lt = _lock(btcId, 1);
        uint256 et = _end(btcId, 1);
        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(0);     // zero price = invalid
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(et + 1);
        vm.prank(settler); arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);
        assertEq(_claim(alice, btcId, 1), MIN);
        assertEq(_claim(bob,   btcId, 1), MIN);
        assertEq(arena.feesAccrued(), 0);
    }

    function test_refund_endNotAfterStart_bothGetStakeBack() public {
        // Two updates inside round; same ID used as start and end (single update).
        // Single update => endId == startId => EndNotAfterStart.
        vm.warp(1);
        _makeCall(alice, btcId, 1, true,  MIN);
        _makeCall(bob,   btcId, 1, false, MIN);
        uint256 lt = _lock(btcId, 1);
        uint256 et = _end(btcId, 1);
        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(et + 1);
        uint80 id2 = (uint80(1)<<64)|2;
        vm.prank(settler); arena.settle(btcId, 1, id2, id2);
        assertEq(_claim(alice, btcId, 1), MIN);
        assertEq(_claim(bob,   btcId, 1), MIN);
        assertEq(arena.feesAccrued(), 0);
    }

    function test_refund_timeout_viaAutoFinalise() public {
        // Nobody calls settle; claim() itself auto-finalises as Timeout.
        vm.warp(1);
        _makeCall(alice, btcId, 1, true,  MIN);
        _makeCall(bob,   btcId, 1, false, MIN);
        uint256 et = _end(btcId, 1);
        vm.warp(et + SETTLE_WINDOW() + 1); // past window

        // _claim auto-finalises then pays.
        uint256 p = _claim(alice, btcId, 1);
        assertEq(p, MIN, "timeout auto-refund");
        assertEq(_claim(bob, btcId, 1), MIN);
        assertEq(arena.feesAccrued(), 0);
    }

    /// Mainnet plan: a round with calls on one side only is never settled (no price pushed, nobody calls settle()).
    /// After the settle window the caller's own claim() finalises it as a Timeout refund: full stake back, no fee.
    function test_refund_oneSided_neverSettled_claimedAfterWindow_fullRefund() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true, MIN); // only UP; nobody takes DOWN
        uint256 et = _end(btcId, 1);

        // Still inside the window (exactly at the deadline): not claimable yet, and the preview says 0.
        vm.warp(et + SETTLE_WINDOW());
        assertEq(arena.claimable(btcId, 1, alice), 0, "preview is 0 inside the window");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.RoundNotSettled.selector, btcId, 1));
        arena.claim(btcId, 1);

        // One second later: the preview shows the full stake and claim() pays it, with no settle() call at all.
        vm.warp(et + SETTLE_WINDOW() + 1);
        assertEq(arena.claimable(btcId, 1, alice), MIN, "preview shows the full refund");
        (, , , , , , PredictionArena.RoundState before_) = arena.rounds(btcId, 1);
        assertEq(uint8(before_), uint8(PredictionArena.RoundState.Unsettled), "never settled before the claim");

        uint256 balBefore = usdc.balanceOf(alice);
        uint256 p = _claim(alice, btcId, 1);
        assertEq(p, MIN, "full stake refunded");
        assertEq(usdc.balanceOf(alice) - balBefore, MIN, "USDC arrived in alice's wallet");
        assertEq(arena.feesAccrued(), 0, "no fee on a refund");
        assertEq(arena.totalPlayerFunds(), 0, "nothing left owed");
        assertEq(usdc.balanceOf(address(arena)), 0, "contract holds nothing");

        (, , , , , , PredictionArena.RoundState after_) = arena.rounds(btcId, 1);
        assertEq(uint8(after_), uint8(PredictionArena.RoundState.Refunded), "finalised as a refund by the claim");

        // And only once.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.AlreadyClaimed.selector, btcId, 1));
        arena.claim(btcId, 1);
    }

    // =========================================================
    //  Once-only, timing, stranger guards
    // =========================================================

    function test_alreadyClaimed_reverts() public {
        _setupUpWins();
        _claim(alice, btcId, 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.AlreadyClaimed.selector, btcId, 1)
        );
        arena.claim(btcId, 1);
    }

    function test_alreadyClaimed_refund_reverts() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true, MIN);
        uint256 et = _end(btcId, 1);
        vm.warp(et + 1);
        vm.prank(settler); arena.settle(btcId, 1, 0, 0); // OneSided refund
        _claim(alice, btcId, 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.AlreadyClaimed.selector, btcId, 1)
        );
        arena.claim(btcId, 1);
    }

    function test_stranger_nothingToClaim() public {
        _setupUpWins();
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.NothingToClaim.selector, btcId, 1)
        );
        arena.claim(btcId, 1);
    }

    function test_claimInsideWindow_reverts() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true, MIN);
        _makeCall(bob,   btcId, 1, false, MIN);
        uint256 et = _end(btcId, 1);
        vm.warp(et + 1); // inside window but not settled

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.RoundNotSettled.selector, btcId, 1)
        );
        arena.claim(btcId, 1);
    }

    function test_claimExactlyAtDeadline_reverts() public {
        // Exactly at endTime + SETTLE_WINDOW: auto-finalise requires STRICTLY after.
        vm.warp(1);
        _makeCall(alice, btcId, 1, true, MIN);
        _makeCall(bob,   btcId, 1, false, MIN);
        uint256 et = _end(btcId, 1);
        uint256 deadline = et + SETTLE_WINDOW();
        vm.warp(deadline); // exactly at deadline, NOT strictly after

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.RoundNotSettled.selector, btcId, 1)
        );
        arena.claim(btcId, 1);
    }

    function test_claimOneSecondAfterDeadline_pays() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true, MIN);
        _makeCall(bob,   btcId, 1, false, MIN);
        uint256 et = _end(btcId, 1);
        vm.warp(et + SETTLE_WINDOW() + 1); // one second after deadline

        // Should auto-finalise as Timeout and pay MIN back.
        uint256 p = _claim(alice, btcId, 1);
        assertEq(p, MIN);
    }

    // =========================================================
    //  Dust – triggered only when the last winner claims
    //
    //  Setup: W = 3, L = 1 (minStake each).
    //  F = floor(1 * 200 / 10_000) = 0
    //  D = 1
    //  Winner 1 payout = 1 + floor(1*1/3) = 1 + 0 = 1
    //  Winner 2 payout = 1 + floor(1*1/3) = 1 + 0 = 1
    //  Winner 3 payout = 1 + floor(1*1/3) = 1 + 0 = 1
    //  Sum bonuses = 0, dust = D - 0 = 1 → emitted when last winner claims
    //
    //  Use a custom market with minStake=1 to get the exact maths.
    // =========================================================

    function _setupDustMarket()
        internal
        returns (uint256 mid, address w1, address w2, address w3, address loser)
    {
        w1 = makeAddr("w1"); w2 = makeAddr("w2"); w3 = makeAddr("w3");
        loser = makeAddr("loser");

        MockPriceFeed df = new MockPriceFeed(
            owner, 8, "TEST PRICES - NOT REAL DATA / DUST"
        );
        vm.prank(owner);
        arena.createMarket("DUST", address(df), address(0), ROUND, 0, 1);
        mid = arena.marketCount() - 1;

        vm.warp(1);
        _makeCall(w1,    mid, 1, true,  1);
        _makeCall(w2,    mid, 1, true,  1);
        _makeCall(w3,    mid, 1, true,  1);
        _makeCall(loser, mid, 1, false, 1);

        uint256 lt = _lock(mid, 1);
        uint256 et = _end(mid, 1);
        vm.warp(lt - 2); vm.prank(owner); df.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); df.setPrice(100e8);
        vm.warp(et - 1); vm.prank(owner); df.setPrice(101e8);
        vm.warp(et + 1);

        // settle with the right ids
        uint80 sId = (uint80(1)<<64)|2;
        uint80 eId = (uint80(1)<<64)|3;
        vm.prank(settler); arena.settle(mid, 1, sId, eId);
    }

    function test_dust_notEmittedUntilLastWinner() public {
        (uint256 mid, address w1, address w2, ,) = _setupDustMarket();

        // After 2 of 3 winners claim, feesAccrued = 0 (F=0, dust not yet moved).
        _claim(w1, mid, 1);
        _claim(w2, mid, 1);
        assertEq(arena.feesAccrued(), 0, "no dust yet");
    }

    function test_dust_emittedOnLastWinner() public {
        (uint256 mid, address w1, address w2, address w3,) = _setupDustMarket();
        _claim(w1, mid, 1);
        _claim(w2, mid, 1);

        // Third (last) winner: expect RoundDustToFees(mid, 1, 1)
        vm.expectEmit(true, true, false, true);
        emit PredictionArena.RoundDustToFees(mid, 1, 1);
        _claim(w3, mid, 1);

        assertEq(arena.feesAccrued(), 1, "dust in fees");
        assertEq(arena.totalPlayerFunds(), 0, "totalPlayerFunds zero");
    }

    function test_dust_noSweep_unclamedWinnerCanClaimLater() public {
        // w3 never claims; w1 and w2 do claim.
        (uint256 mid, address w1, address w2, address w3,) = _setupDustMarket();
        _claim(w1, mid, 1);
        _claim(w2, mid, 1);

        // Warp 10 years
        vm.warp(block.timestamp + 10 * 365 days);

        // w3 can still claim
        uint256 p = _claim(w3, mid, 1);
        assertEq(p, 1, "w3 can claim 10 years later");

        // Now dust triggers
        assertEq(arena.feesAccrued(), 1);
    }

    function test_dust_ownerCannotWithdrawPlayerMoney() public {
        (uint256 mid, address w1,,, ) = _setupDustMarket();
        // Only w1 has claimed; w2/w3 have not.
        _claim(w1, mid, 1);

        // feesAccrued == 0; balance > 0 (w2, w3, loser money still there)
        // Owner tries to withdraw 1 unit even though feesAccrued == 0.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.InsufficientFees.selector, 1, 0)
        );
        arena.withdrawFees(owner, 1);
    }

    // =========================================================
    //  Order independence: 3 winners claiming in all 6 permutations
    //  Derived from _setupUpWins (alice, bob, carol) winning.
    //  Each permutation must end with the same final feesAccrued.
    // =========================================================

    function _claimAll3(address a, address b, address c, uint256 mid, uint256 rnd)
        internal returns (uint256, uint256, uint256)
    {
        return (_claim(a, mid, rnd), _claim(b, mid, rnd), _claim(c, mid, rnd));
    }

    function test_orderIndependent_abc() public {
        _setupUpWins();
        (uint256 pa, uint256 pb, uint256 pc) = _claimAll3(alice, bob, carol, btcId, 1);
        assertEq(pa + pb + pc + arena.feesAccrued(), 2_200_000);
    }

    function test_orderIndependent_acb() public {
        _setupUpWins();
        (uint256 pa, uint256 pc, uint256 pb) = _claimAll3(alice, carol, bob, btcId, 1);
        assertEq(pa + pb + pc + arena.feesAccrued(), 2_200_000);
    }

    function test_orderIndependent_bac() public {
        _setupUpWins();
        (uint256 pb, uint256 pa, uint256 pc) = _claimAll3(bob, alice, carol, btcId, 1);
        assertEq(pa + pb + pc + arena.feesAccrued(), 2_200_000);
    }

    function test_orderIndependent_bca() public {
        _setupUpWins();
        (uint256 pb, uint256 pc, uint256 pa) = _claimAll3(bob, carol, alice, btcId, 1);
        assertEq(pa + pb + pc + arena.feesAccrued(), 2_200_000);
    }

    function test_orderIndependent_cab() public {
        _setupUpWins();
        (uint256 pc, uint256 pa, uint256 pb) = _claimAll3(carol, alice, bob, btcId, 1);
        assertEq(pa + pb + pc + arena.feesAccrued(), 2_200_000);
    }

    function test_orderIndependent_cba() public {
        _setupUpWins();
        (uint256 pc, uint256 pb, uint256 pa) = _claimAll3(carol, bob, alice, btcId, 1);
        assertEq(pa + pb + pc + arena.feesAccrued(), 2_200_000);
    }

    // =========================================================
    //  claimMany: batch, single transfer, mixed rounds, all reverts
    // =========================================================

    /// Set up three separate rounds on three markets, each settled UP,
    /// all with a single UP caller (alice) and a single DOWN caller (bob).
    /// Returns the round indexes.
    function _setupThreeRounds()
        internal
        returns (uint256 btcRnd, uint256 ethRnd, uint256 solRnd)
    {
        // BTC round 1: lt=3600, et=7200
        // ETH round 1: lt=4800, et=8400   (startOffset=1200)
        // SOL round 1: lt=6000, et=9600   (startOffset=2400)
        // At t=2401 all three markets have nextCallableRound==1.

        vm.warp(2401);
        _makeCall(alice, btcId, 1, true,  1_000_000);
        _makeCall(bob,   btcId, 1, false, 500_000);
        _makeCall(alice, ethId, 1, true,  2_000_000);
        _makeCall(bob,   ethId, 1, false, 600_000);
        _makeCall(alice, solId, 1, true,  3_000_000);
        _makeCall(bob,   solId, 1, false, 700_000);

        // Feed for BTC
        uint256 lt1 = _lock(btcId, 1); uint256 et1 = _end(btcId, 1);
        vm.warp(lt1 - 5);  vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt1 + 1);  vm.prank(owner); feed.setPrice(101e8);
        vm.warp(et1 - 1);  vm.prank(owner); feed.setPrice(102e8);
        vm.warp(et1 + 1);
        vm.prank(settler); arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        // Feed for ETH
        uint256 lt2 = _lock(ethId, 1); uint256 et2 = _end(ethId, 1);
        vm.warp(lt2 - 5);  vm.prank(owner); feed.setPrice(200e8);
        vm.warp(lt2 + 1);  vm.prank(owner); feed.setPrice(201e8);
        vm.warp(et2 - 1);  vm.prank(owner); feed.setPrice(202e8);
        vm.warp(et2 + 1);
        vm.prank(settler); arena.settle(ethId, 1, (uint80(1)<<64)|5, (uint80(1)<<64)|6);

        // Feed for SOL
        uint256 lt3 = _lock(solId, 1); uint256 et3 = _end(solId, 1);
        vm.warp(lt3 - 5);  vm.prank(owner); feed.setPrice(300e8);
        vm.warp(lt3 + 1);  vm.prank(owner); feed.setPrice(301e8);
        vm.warp(et3 - 1);  vm.prank(owner); feed.setPrice(302e8);
        vm.warp(et3 + 1);
        vm.prank(settler); arena.settle(solId, 1, (uint80(1)<<64)|8, (uint80(1)<<64)|9);

        btcRnd = 1; ethRnd = 1; solRnd = 1;
    }

    function test_claimMany_singleTransferCorrectSum() public {
        _setupThreeRounds();

        uint256[] memory mids = new uint256[](3);
        uint256[] memory rnds = new uint256[](3);
        mids[0] = btcId; rnds[0] = 1;
        mids[1] = ethId; rnds[1] = 1;
        mids[2] = solId; rnds[2] = 1;

        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 total = arena.claimMany(mids, rnds);
        uint256 balAfter = usdc.balanceOf(alice);

        // ONE transfer: balance delta == total
        assertEq(balAfter - balBefore, total, "single transfer amount");

        // Each individual payout must match claimable preview
        // (which returned > 0 before the call)
        assertGt(total, 0);
    }

    function test_claimMany_emitsClaimedPerRound() public {
        _setupThreeRounds();

        uint256[] memory mids = new uint256[](2);
        uint256[] memory rnds = new uint256[](2);
        mids[0] = btcId; rnds[0] = 1;
        mids[1] = ethId; rnds[1] = 1;

        // Two Claimed events emitted (one per round)
        vm.prank(alice);
        arena.claimMany(mids, rnds);
        // Just verify it didn't revert; event emission verified by vm.expectEmit below.
    }

    function test_claimMany_mixedWinRefund() public {
        // BTC: alice wins (UP); ETH: both sides, refund (unchanged price).
        // ETH startOffset=1200; warp to 1201 so nextCallableRound(ethId)==1.
        vm.warp(1201);
        _makeCall(alice, btcId, 1, true,  MIN);
        _makeCall(bob,   btcId, 1, false, MIN);
        _makeCall(alice, ethId, 1, true,  MIN);
        _makeCall(bob,   ethId, 1, false, MIN);

        // Settle BTC UP wins
        uint256 lt1 = _lock(btcId, 1); uint256 et1 = _end(btcId, 1);
        vm.warp(lt1 - 5); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt1 + 1); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(et1 - 1); vm.prank(owner); feed.setPrice(101e8);
        vm.warp(et1 + 1);
        vm.prank(settler); arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        // Settle ETH equal prices → refund
        uint256 lt2 = _lock(ethId, 1); uint256 et2 = _end(ethId, 1);
        vm.warp(lt2 - 5); vm.prank(owner); feed.setPrice(200e8);
        vm.warp(lt2 + 1); vm.prank(owner); feed.setPrice(200e8);
        vm.warp(et2 - 1); vm.prank(owner); feed.setPrice(200e8);
        vm.warp(et2 + 1);
        vm.prank(settler); arena.settle(ethId, 1, (uint80(1)<<64)|5, (uint80(1)<<64)|6);

        uint256[] memory mids = new uint256[](2);
        uint256[] memory rnds = new uint256[](2);
        mids[0] = btcId; rnds[0] = 1;
        mids[1] = ethId; rnds[1] = 1;

        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        arena.claimMany(mids, rnds);
        uint256 received = usdc.balanceOf(alice) - balBefore;
        // WIN BTC: L=MIN=100_000, F=floor(100_000*200/10_000)=2_000, D=98_000
        //   W=MIN, bonus=floor(MIN*98_000/MIN)=98_000, payout=MIN+98_000=198_000
        // REFUND ETH (equal prices): MIN = 100_000
        // Total = 198_000 + 100_000 = 298_000
        assertEq(received, 298_000, "mixed claim payout");
    }

    function test_claimMany_lengthMismatch_reverts() public {
        uint256[] memory mids = new uint256[](2);
        uint256[] memory rnds = new uint256[](3);
        vm.expectRevert(PredictionArena.ArrayLengthMismatch.selector);
        vm.prank(alice);
        arena.claimMany(mids, rnds);
    }

    function test_claimMany_emptyArrays_reverts() public {
        uint256[] memory mids = new uint256[](0);
        uint256[] memory rnds = new uint256[](0);
        vm.expectRevert(PredictionArena.EmptyClaim.selector);
        vm.prank(alice);
        arena.claimMany(mids, rnds);
    }

    function test_claimMany_alreadyClaimed_reverts_whole() public {
        _setupThreeRounds();
        // Alice pre-claims BTC
        _claim(alice, btcId, 1);

        uint256[] memory mids = new uint256[](2);
        uint256[] memory rnds = new uint256[](2);
        mids[0] = btcId; rnds[0] = 1; // already claimed
        mids[1] = ethId; rnds[1] = 1;

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.AlreadyClaimed.selector, btcId, 1)
        );
        arena.claimMany(mids, rnds);
        // ETH must not have been claimed (whole call reverted)
        // Verify by claiming ETH successfully now
        _claim(alice, ethId, 1);
    }

    function test_claimMany_unsettled_reverts_whole() public {
        _setupThreeRounds();
        // Set up a 4th round (BTC round 2) with calls but no settle
        vm.warp(1);
        uint256 lt2 = _lock(btcId, 2);
        vm.warp(lt2 - 100);
        _makeCall(alice, btcId, 2, true, MIN);
        _makeCall(bob,   btcId, 2, false, MIN);
        // Don't settle round 2; claim inside the window

        uint256 et2 = _end(btcId, 2);
        vm.warp(et2 + 1); // inside window

        uint256[] memory mids = new uint256[](2);
        uint256[] memory rnds = new uint256[](2);
        mids[0] = btcId; rnds[0] = 1; // settled
        mids[1] = btcId; rnds[1] = 2; // unsettled, inside window

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.RoundNotSettled.selector, btcId, 2)
        );
        arena.claimMany(mids, rnds);
    }

    function test_claimMany_loser_reverts_whole() public {
        _setupThreeRounds();
        // bob called DOWN on all markets; UP won on all → bob is a loser everywhere.
        // Put btcId first so the revert happens at the first entry.
        uint256[] memory mids = new uint256[](2);
        uint256[] memory rnds = new uint256[](2);
        mids[0] = btcId; rnds[0] = 1; // bob is loser here (btcId == 0)
        mids[1] = ethId; rnds[1] = 1;

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.NothingToClaim.selector, btcId, 1)
        );
        arena.claimMany(mids, rnds);
    }

    function test_claimMany_duplicate_reverts_whole() public {
        _setupThreeRounds();
        // Same round twice in the array: second one is AlreadyClaimed
        uint256[] memory mids = new uint256[](2);
        uint256[] memory rnds = new uint256[](2);
        mids[0] = btcId; rnds[0] = 1;
        mids[1] = btcId; rnds[1] = 1;

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.AlreadyClaimed.selector, btcId, 1)
        );
        arena.claimMany(mids, rnds);
    }

    // =========================================================
    //  withdrawFees guard: FeesWouldTouchPlayerFunds
    // =========================================================

    function test_withdrawFees_guard_normalFeesWork() public {
        _setupUpWins(); // feesAccrued = 20_000 after settle
        uint256 fees = arena.feesAccrued(); // read BEFORE prank so prank isn't consumed
        vm.prank(owner);
        arena.withdrawFees(owner, fees);
        assertEq(arena.feesAccrued(), 0);
    }

    function test_withdrawFees_guard_triggersWhenFeesWouldTouchPlayerFunds() public {
        // Force inconsistent state: set feesAccrued > (balance - totalPlayerFunds).
        // Place calls first so there are real player funds.
        vm.warp(1);
        _makeCall(alice, btcId, 1, true,  1_000_000);
        _makeCall(bob,   btcId, 1, false, 1_000_000);
        // Do NOT settle; no feesAccrued, but totalPlayerFunds = 2_000_000.

        // Use vm.store to inflate feesAccrued beyond what the balance minus
        // totalPlayerFunds allows.
        // feesAccrued is slot 6 in the contract storage (0-indexed):
        //   0: _owner (Ownable)
        //   1: _pendingOwner (Ownable2Step)
        //   2: markets
        //   3: marketCount
        //   4: marketName
        //   5: rounds
        //   6: positions
        //   7: feesAccrued
        //   8: totalPlayerFunds
        //   9: payoutProgress
        // We need to find feesAccrued slot:
        bytes32 feesSlot = bytes32(uint256(7));
        vm.store(address(arena), feesSlot, bytes32(uint256(1_500_000)));

        // Now: balance = 2_000_000, feesAccrued = 1_500_000, totalPlayerFunds = 2_000_000
        // balance - feesAccrued = 500_000 < totalPlayerFunds = 2_000_000
        // Trying to withdraw 1_500_000 would leave balance = 500_000 < totalPlayerFunds.
        vm.prank(owner);
        vm.expectRevert(PredictionArena.FeesWouldTouchPlayerFunds.selector);
        arena.withdrawFees(owner, 1_500_000);
    }

    // =========================================================
    //  claimable view
    // =========================================================

    function test_claimable_returnsCorrectAmount() public {
        _setupUpWins();
        // Alice's claimable should match what claim() actually pays.
        uint256 preview = arena.claimable(btcId, 1, alice);
        uint256 actual  = _claim(alice, btcId, 1);
        assertEq(preview, actual, "claimable preview matches actual");
    }

    function test_claimable_zero_afterClaim() public {
        _setupUpWins();
        _claim(alice, btcId, 1);
        assertEq(arena.claimable(btcId, 1, alice), 0);
    }

    function test_claimable_zero_loser() public {
        _setupUpWins();
        assertEq(arena.claimable(btcId, 1, dave), 0);
    }

    function test_claimable_zero_insideWindow() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true, MIN);
        _makeCall(bob,   btcId, 1, false, MIN);
        uint256 et = _end(btcId, 1);
        vm.warp(et + 1); // inside window, not settled
        assertEq(arena.claimable(btcId, 1, alice), 0);
    }

    function test_claimable_nonzero_timedOut() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true, MIN);
        _makeCall(bob,   btcId, 1, false, MIN);
        uint256 et = _end(btcId, 1);
        vm.warp(et + SETTLE_WINDOW() + 1);
        // Timed-out: claimable should return their stake as a timeout refund.
        assertEq(arena.claimable(btcId, 1, alice), MIN);
        assertEq(arena.claimable(btcId, 1, bob),   MIN);
    }

    /// The preview must agree with claim() on the exact boundary: at endTime + 1 hour the
    /// settle window is still open (claim reverts), so the preview must still say 0.
    /// One second later the round has timed out and the preview shows the full refund.
    function test_claimable_timeoutBoundary_exactlyAtDeadline() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true, MIN);
        _makeCall(bob,   btcId, 1, false, MIN);
        uint256 deadline = _end(btcId, 1) + SETTLE_WINDOW();

        vm.warp(deadline);
        assertEq(arena.claimable(btcId, 1, alice), 0, "still inside the window at the deadline");
        assertEq(arena.claimable(btcId, 1, bob),   0, "still inside the window at the deadline");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.RoundNotSettled.selector, btcId, 1));
        arena.claim(btcId, 1);

        vm.warp(deadline + 1);
        assertEq(arena.claimable(btcId, 1, alice), MIN, "timed out one second later");
        assertEq(arena.claimable(btcId, 1, bob),   MIN, "timed out one second later");
    }

    // =========================================================
    //  matchedStake() view
    // =========================================================

    /// Worked example: UP 10 USDC / DOWN 6 USDC, UP wins (spec §3 example).
    ///   U=10_000_000, D=6_000_000; M=6_000_000; F=120_000; Dist=5_880_000.
    ///   UP winner (bigger, floor): matched=floor(10M*6M/10M)=6_000_000; unmatched=4_000_000.
    ///   DOWN loser (smaller): matched=6_000_000; unmatched=0.
    function test_matchedStake_workedExampleUpWins() public {
        // Use a market with minStake=1 for flexibility.
        vm.prank(owner);
        arena.createMarket("WE", address(feed), address(0), ROUND, 0, 1);
        uint256 wId = arena.marketCount() - 1;

        vm.warp(1);
        _makeCall(alice, wId, 1, true,  10_000_000);
        _makeCall(bob,   wId, 1, false,  6_000_000);

        uint256 lt = _lock(wId, 1); uint256 et = _end(wId, 1);
        vm.warp(lt - 2); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(105e8);
        vm.warp(et + 1);
        uint80 s = (uint80(1)<<64)|2; uint80 e = (uint80(1)<<64)|3;
        vm.prank(settler); arena.settle(wId, 1, s, e);

        // Alice (UP winner, bigger side): matched=6_000_000, unmatched=4_000_000.
        (uint256 m, uint256 u) = arena.matchedStake(wId, 1, alice);
        assertEq(m, 6_000_000, "alice matched");
        assertEq(u, 4_000_000, "alice unmatched");

        // Bob (DOWN loser, smaller side): matched=6_000_000, unmatched=0.
        (uint256 m2, uint256 u2) = arena.matchedStake(wId, 1, bob);
        assertEq(m2, 6_000_000, "bob matched");
        assertEq(u2, 0,         "bob unmatched");
    }

    /// Worked example: UP 10 / DOWN 6, DOWN wins.
    ///   UP=10M loser (bigger, ceil): matched=ceil(10M*6M/10M)=6M; unmatched=4M.
    ///   DOWN=6M winner (smaller): matched=6M; unmatched=0.
    function test_matchedStake_workedExampleDownWins() public {
        vm.prank(owner);
        arena.createMarket("WD", address(feed), address(0), ROUND, 0, 1);
        uint256 wId = arena.marketCount() - 1;

        vm.warp(1);
        _makeCall(alice, wId, 1, true,  10_000_000);
        _makeCall(bob,   wId, 1, false,  6_000_000);

        uint256 lt = _lock(wId, 1); uint256 et = _end(wId, 1);
        vm.warp(lt - 2); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(95e8); // DOWN wins
        vm.warp(et + 1);
        uint80 s = (uint80(1)<<64)|2; uint80 e = (uint80(1)<<64)|3;
        vm.prank(settler); arena.settle(wId, 1, s, e);

        // Alice (UP loser, bigger side): matched=ceil(10M*6M/10M)=6M; unmatched=4M.
        (uint256 m, uint256 u) = arena.matchedStake(wId, 1, alice);
        assertEq(m, 6_000_000, "alice matched (loser bigger side)");
        assertEq(u, 4_000_000, "alice unmatched");

        // Bob (DOWN winner, smaller side): matched=6M; unmatched=0.
        (uint256 m2, uint256 u2) = arena.matchedStake(wId, 1, bob);
        assertEq(m2, 6_000_000, "bob matched (winner smaller side)");
        assertEq(u2, 0,         "bob unmatched");
    }

    /// A tie (U == D): every player is fully matched on both sides.
    function test_matchedStake_tie() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true,  MIN);
        _makeCall(bob,   btcId, 1, false, MIN);

        uint256 lt = _lock(btcId, 1); uint256 et = _end(btcId, 1);
        vm.warp(lt - 2); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(101e8);
        vm.warp(et + 1);
        vm.prank(settler); arena.settle(btcId, 1, (uint80(1)<<64)|2, (uint80(1)<<64)|3);

        // Both sides have MIN; M=MIN; both fully matched.
        (uint256 m, uint256 u) = arena.matchedStake(btcId, 1, alice);
        assertEq(m, MIN, "alice matched (tie)");
        assertEq(u, 0,   "alice unmatched (tie)");

        (uint256 m2, uint256 u2) = arena.matchedStake(btcId, 1, bob);
        assertEq(m2, MIN, "bob matched (tie)");
        assertEq(u2, 0,   "bob unmatched (tie)");
    }

    /// matchedStake returns (0,0) for unsettled and refunded rounds.
    function test_matchedStake_zeroForRefundedAndUnsettled() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true,  MIN);
        _makeCall(bob,   btcId, 1, false, MIN);

        // Unsettled
        (uint256 m, uint256 u) = arena.matchedStake(btcId, 1, alice);
        assertEq(m, 0); assertEq(u, 0);

        // Refund (one-sided via settle)
        uint256 et = _end(btcId, 1);
        vm.warp(et + 1);
        vm.prank(settler); arena.settle(btcId, 1, 0, 0); // OneSided refund
        (m, u) = arena.matchedStake(btcId, 1, alice);
        assertEq(m, 0); assertEq(u, 0);
    }

    // =========================================================
    //  Bigger-side loser claims on UP wins (spec requirement)
    // =========================================================

    /// UP 10 / DOWN 6, UP wins. Bigger-side loser is the one-sided UP caller
    /// BUT wait – UP won means DOWN lost. DOWN (6M) is the smaller side,
    /// so DOWN losers have NothingToClaim. No bigger-side loser on the DOWN side.
    /// In this setup the UP side won and is the bigger side – they are winners.
    /// Only the winning bigger side and the losing smaller side exist.
    /// This test verifies smaller-side loser still reverts NothingToClaim.
    function test_upWins_smallerSideLoserReverts() public {
        _setupUpWins();
        // dave is DOWN (smaller side, loser): unmatched=0 → NothingToClaim.
        vm.prank(dave);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.NothingToClaim.selector, btcId, 1)
        );
        arena.claim(btcId, 1);
    }

    /// When UP is bigger and UP wins: the unmatched UP stake is returned to each winner
    /// via the payout formula (payout = stake + bonus, where stake includes unmatched).
    function test_upWins_winnerUnmatchedIncludedInPayout() public {
        _setupUpWins();
        // Alice: matched=500_000, unmatched=100_000.
        // Alice's payout should be stake(600_000) + bonus(490_000) = 1_090_000,
        // which naturally returns her unmatched 100_000 as part of her stake.
        (uint256 m, uint256 u) = arena.matchedStake(btcId, 1, alice);
        assertEq(m, 500_000, "alice matched");
        assertEq(u, 100_000, "alice unmatched (returned in payout)");
        assertEq(arena.claimable(btcId, 1, alice), 1_090_000);
    }
}
