// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Matchup – Step 7: rule-by-rule gap tests
//
//  The rule-to-test map lives in docs/TEST_MAP.md.  This file holds the
//  tests that were missing when that map was first drawn up:
//
//   rule 3 / E2  unclaimed money stays claimable for years
//   rule 4       market settings never change, whatever else happens
//   rule 8       a contract wallet may call and claim
//   rule 24      one blocked (blocklisted) wallet freezes nobody else
//   rule 25      a paused market still settles and pays out
//   E2           unknown market ids revert on settle / markRefunded / claim / claimMany
//   rule 19      timeout: claim-first and markRefunded-first both work
//   E2           claimMany across two different markets
//
//  Worked numbers (all by hand):
//   300_000 UP vs 200_000 DOWN, UP wins:
//     F = floor(200_000 * 200 / 10_000) = 4_000, D = 196_000, W = 300_000
//     UP caller payout = 300_000 + floor(300_000 * 196_000 / 300_000) = 496_000
//   300_000 + 100_000 UP vs 200_000 DOWN, UP wins:
//     W = 400_000, D = 196_000
//     300_000 UP -> 300_000 + 147_000 = 447_000
//     100_000 UP -> 100_000 +  49_000 = 149_000   (no dust: 147_000 + 49_000 = 196_000)
// =============================================================

import {Test}                   from "forge-std/Test.sol";
import {PredictionArena}        from "../PredictionArena.sol";
import {MockPriceFeed}          from "../mocks/MockPriceFeed.sol";
import {AggregatorV3Interface}  from "../interfaces/AggregatorV3Interface.sol";
import {MockUSDC}               from "./MockUSDC.sol";
import {ClaimBase}              from "./Claim.t.sol";

/// A smart-contract wallet (not an EOA) that can call and claim.
contract ContractWallet {
    function makeCall(
        PredictionArena a, MockUSDC u, uint256 mid, uint256 rnd, bool up, uint256 amt
    ) external {
        u.approve(address(a), amt);
        a.placeCall(mid, rnd, up, amt);
    }

    function claim(PredictionArena a, uint256 mid, uint256 rnd) external returns (uint256) {
        return a.claim(mid, rnd);
    }
}

/// Test token that can block addresses, like Arc's USDC blocklist (transfers to or from
/// a blocked address revert).
contract BlocklistUSDC is MockUSDC {
    mapping(address => bool) public blocked;

    function setBlocked(address who, bool isBlocked) external {
        blocked[who] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "BLOCKED");
        super._update(from, to, value);
    }
}

// =============================================================
//  Tests that reuse the standard three-market setup
// =============================================================
contract RulesTest is ClaimBase {

    function setUp() public {
        _baseSetUp();
    }

    /// Feeds prices for BTC round 1 (lock 3600, end 7200): a pre-lock update, the start
    /// update just after lock, the end update just before the end.  Leaves time at end + 1.
    function _resolveBtc1(int256 p1, int256 p2) internal returns (uint80 sId, uint80 eId) {
        uint256 lt = _lock(btcId, 1);
        uint256 et = _end(btcId, 1);
        vm.warp(lt - 5); vm.prank(owner); feed.setPrice(p1);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(p1);
        (sId, , , , ) = feed.latestRoundData();
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(p2);
        (eId, , , , ) = feed.latestRoundData();
        vm.warp(et + 1);
    }

    /// alice 300_000 UP vs dave 200_000 DOWN on BTC round 1, UP wins, settled.
    function _settledUpWin() internal {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true,  300_000);
        _makeCall(dave,  btcId, 1, false, 200_000);
        (uint80 s, uint80 e) = _resolveBtc1(100e8, 101e8);
        vm.prank(settler);
        arena.settle(btcId, 1, s, e);
    }

    function _marketHash(uint256 mid) internal view returns (bytes32) {
        (AggregatorV3Interface fa, AggregatorV3Interface fb, uint32 rl, uint32 off, uint128 ms, ) =
            arena.markets(mid);
        return keccak256(abi.encode(address(fa), address(fb), rl, off, ms, arena.marketName(mid)));
    }

    // ---------------- rule 8: contract wallets ----------------

    function test_rule8_contractWalletCanCallAndClaim() public {
        ContractWallet cw = new ContractWallet();
        vm.warp(1);
        usdc.mint(address(cw), 300_000);
        cw.makeCall(arena, usdc, btcId, 1, true, 300_000);
        _makeCall(dave, btcId, 1, false, 200_000);
        (uint80 s, uint80 e) = _resolveBtc1(100e8, 101e8);
        vm.prank(settler);
        arena.settle(btcId, 1, s, e);

        assertEq(cw.claim(arena, btcId, 1), 496_000, "contract wallet payout");
        assertEq(usdc.balanceOf(address(cw)), 496_000, "paid to the contract wallet");
    }

    // ---------------- rule 25: pause ----------------

    function test_rule25_pausedMarketStillSettlesAndPays() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true,  300_000);
        _makeCall(dave,  btcId, 1, false, 200_000);
        vm.prank(owner);
        arena.setMarketPaused(btcId, true);

        (uint80 s, uint80 e) = _resolveBtc1(100e8, 101e8);
        vm.prank(settler);
        arena.settle(btcId, 1, s, e);

        assertEq(_claim(alice, btcId, 1), 496_000, "paused market still pays the winner");
        assertEq(arena.feesAccrued(), 4_000, "fee booked as normal");
    }

    // ---------------- rule 4: settings never change ----------------

    function test_rule4_marketSettingsNeverChange() public {
        bytes32 b0 = _marketHash(btcId);
        bytes32 e0 = _marketHash(ethId);
        bytes32 s0 = _marketHash(solId);

        _settledUpWin();
        _claim(alice, btcId, 1);

        vm.startPrank(owner);
        arena.setMarketPaused(btcId, true);
        arena.setMarketPaused(btcId, false);
        arena.withdrawFees(owner, 4_000);
        arena.transferOwnership(bob);
        vm.stopPrank();
        vm.prank(bob);
        arena.acceptOwnership();
        vm.prank(bob);
        arena.createMarket("EXTRA/USD", address(feed), address(0), ROUND, 0, MIN);

        assertEq(_marketHash(btcId), b0, "BTC settings unchanged");
        assertEq(_marketHash(ethId), e0, "ETH settings unchanged");
        assertEq(_marketHash(solId), s0, "SOL settings unchanged");
    }

    // ---------------- rule 3 / E2: no expiry ----------------

    function test_rule3_winningsStillClaimableTenYearsLater() public {
        _settledUpWin();
        vm.warp(block.timestamp + 3650 days);
        assertEq(arena.claimable(btcId, 1, alice), 496_000, "preview still shows the payout");
        assertEq(_claim(alice, btcId, 1), 496_000, "still pays after ten years");
    }

    // ---------------- unknown market ids ----------------

    function test_unknownMarket_settleMarkRefundedClaimAndClaimManyRevert() public {
        bytes memory err = abi.encodeWithSelector(PredictionArena.MarketNotFound.selector, 99);

        vm.expectRevert(err);
        arena.settle(99, 1, 0, 0);

        vm.expectRevert(err);
        arena.markRefunded(99, 1);

        vm.prank(alice);
        vm.expectRevert(err);
        arena.claim(99, 1);

        uint256[] memory mids = new uint256[](1);
        uint256[] memory rnds = new uint256[](1);
        mids[0] = 99;
        rnds[0] = 1;
        vm.prank(alice);
        vm.expectRevert(err);
        arena.claimMany(mids, rnds);
    }

    // ---------------- rule 19: both timeout orders ----------------

    function test_rule19_claimFirstThenMarkRefundedReverts() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true,  MIN);
        _makeCall(bob,   btcId, 1, false, MIN);
        vm.warp(_end(btcId, 1) + 1 hours + 1);

        assertEq(_claim(alice, btcId, 1), MIN, "claim auto-finalises and refunds");

        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.RoundAlreadySettled.selector, btcId, 1)
        );
        arena.markRefunded(btcId, 1);

        assertEq(_claim(bob, btcId, 1), MIN, "the other side is refunded too");
        assertEq(arena.feesAccrued(), 0, "no fee on a timeout refund");
        assertEq(usdc.balanceOf(address(arena)), 0, "nothing left in the contract");
    }

    function test_rule19_markRefundedFirstThenBothClaim() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true,  MIN);
        _makeCall(bob,   btcId, 1, false, MIN);
        vm.warp(_end(btcId, 1) + 1 hours + 1);

        arena.markRefunded(btcId, 1);

        assertEq(_claim(alice, btcId, 1), MIN, "alice refunded");
        assertEq(_claim(bob,   btcId, 1), MIN, "bob refunded");
        assertEq(usdc.balanceOf(address(arena)), 0, "nothing left in the contract");
    }

    // ---------------- claimMany across two markets ----------------

    /// BTC round 1 (lock 3600, end 7200) and SOL round 1 (lock 6000, end 9600), both UP wins.
    /// Feed ids: 1 = 3595 (100), 2 = 3601 (100), 3 = 7199 (101), 4 = 9599 (102).
    ///   BTC: start id 2, end id 3.   SOL: start id 3 (first update >= 6000), end id 4.
    function test_claimMany_acrossTwoMarkets() public {
        vm.warp(1);
        _makeCall(alice, btcId, 1, true,  300_000);
        _makeCall(dave,  btcId, 1, false, 200_000);
        // SOL round 0 locked at 2400, so from then on round 1 is the next one to call on.
        vm.warp(2500);
        _makeCall(alice, solId, 1, true,  300_000);
        _makeCall(dave,  solId, 1, false, 200_000);

        vm.warp(3595); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(3601); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(7199); vm.prank(owner); feed.setPrice(101e8);
        uint80 id2 = (uint80(1) << 64) | 2;
        uint80 id3 = (uint80(1) << 64) | 3;
        uint80 id4 = (uint80(1) << 64) | 4;

        vm.warp(7201);
        vm.prank(settler);
        arena.settle(btcId, 1, id2, id3);

        vm.warp(9599); vm.prank(owner); feed.setPrice(102e8);
        vm.warp(9601);
        vm.prank(settler);
        arena.settle(solId, 1, id3, id4);

        uint256[] memory mids = new uint256[](2);
        uint256[] memory rnds = new uint256[](2);
        mids[0] = btcId; rnds[0] = 1;
        mids[1] = solId; rnds[1] = 1;
        vm.prank(alice);
        uint256 total = arena.claimMany(mids, rnds);

        assertEq(total, 992_000, "two payouts of 496_000");
        assertEq(usdc.balanceOf(alice), 992_000, "paid in one transfer");
        assertEq(arena.feesAccrued(), 8_000, "one 4_000 fee per market");
    }
}

// =============================================================
//  Rule 24: a blocked wallet must not freeze anyone else
// =============================================================
contract BlocklistTest is Test {

    BlocklistUSDC   usdc;
    PredictionArena arena;
    MockPriceFeed   feed;

    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");
    address dave  = makeAddr("dave");

    function _makeCall(address who, bool up, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(arena), amt);
        arena.placeCall(0, 1, up, amt);
        vm.stopPrank();
    }

    function test_rule24_blockedWalletFreezesNobodyElse() public {
        usdc  = new BlocklistUSDC();
        feed  = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / BTC/USD");
        arena = new PredictionArena(address(usdc), owner);
        vm.prank(owner);
        arena.createMarket("BTC/USD", address(feed), address(0), 3600, 0, 100_000);

        // BTC round 1: lock 3600, end 7200.  alice 300_000 + bob 100_000 UP vs dave 200_000 DOWN.
        vm.warp(1);
        _makeCall(alice, true,  300_000);
        _makeCall(bob,   true,  100_000);
        _makeCall(dave,  false, 200_000);

        vm.warp(3595); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(3601); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(7199); vm.prank(owner); feed.setPrice(101e8);
        vm.warp(7201);
        arena.settle(0, 1, (uint80(1) << 64) | 2, (uint80(1) << 64) | 3);

        // alice gets blocked.  Her own claim fails ...
        usdc.setBlocked(alice, true);
        vm.prank(alice);
        vm.expectRevert();
        arena.claim(0, 1);

        // ... but bob is paid in full, the owner can still take the fee, and alice's money is
        // untouched and still accounted for.
        vm.prank(bob);
        assertEq(arena.claim(0, 1), 149_000, "bob unaffected");
        vm.prank(owner);
        arena.withdrawFees(owner, 4_000);
        assertEq(usdc.balanceOf(address(arena)), 447_000, "alice's payout is still held");
        assertEq(arena.totalPlayerFunds(), 447_000, "and still owed to her");

        // once she is unblocked she can claim as normal.
        usdc.setBlocked(alice, false);
        vm.prank(alice);
        assertEq(arena.claim(0, 1), 447_000, "alice paid after unblock");
        assertEq(usdc.balanceOf(address(arena)), 0, "contract empty at the end");
    }
}
