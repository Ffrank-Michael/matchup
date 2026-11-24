// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Matchup – what the pusher can and cannot do on a ratio market
//
//  These tests pin down the TRUST MODEL of a coin-vs-coin market
//  (docs/AUDIT_RATIO_PART1.md, R-01 and R-03), on the unchanged
//  PredictionArena and GuardedRelayFeed:
//    - inside the 2.5% band the pusher alone decides the result,
//      even when Chainlink did not move, or moved the other way;
//    - outside the band it can do nothing;
//    - by withholding a push, or pushing the same ratio twice, it
//      can turn any round into a full refund (no fee), and then
//      nobody can settle that round as a win;
//    - the contracts do not stop the pusher wallet from playing.
//  If the band is ever narrowed or the arena changed, these tests
//  are the ones that should change with it.
// =============================================================

import {Test}             from "forge-std/Test.sol";
import {PredictionArena}  from "../PredictionArena.sol";
import {GuardedRelayFeed} from "../GuardedRelayFeed.sol";
import {RatioGuard}       from "../RatioGuard.sol";
import {MockPriceFeed}    from "../mocks/MockPriceFeed.sol";
import {MockUSDC}         from "./MockUSDC.sol";

contract RatioTrustTest is Test {

    PredictionArena  arena;
    MockUSDC         usdc;
    MockPriceFeed    ethUsd;
    MockPriceFeed    btcUsd;
    RatioGuard       guard;
    GuardedRelayFeed relay;
    uint256          mid;

    address owner  = makeAddr("owner");
    address pusher = makeAddr("pusher");
    address alice  = makeAddr("alice");
    address bob    = makeAddr("bob");

    uint32  constant ROUND  = 3600;
    uint32  constant OFFSET = 50;
    uint128 constant MIN    = 500_000;
    uint16  constant BAND   = 250;               // 2.5%
    uint32  constant AGE    = 25 hours;
    uint80  constant P1     = uint80(1) << 64;
    int256  constant G0     = 3e16;              // the Chainlink ratio at the start: 3,000 / 100,000

    uint256 lt;
    uint256 et;

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
        lt = arena.lockTime(mid, 1);
        et = arena.endTime(mid, 1);
        // Alice: ETH beats BTC; Bob: BTC beats ETH; 10 USDC each
        vm.warp(lt - 100);
        _call(alice, true, 10_000_000);
        _call(bob, false, 10_000_000);
    }

    // ── helpers ──────────────────────────────────────────────

    function _call(address who, bool ethWins, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.prank(who);
        usdc.approve(address(arena), amt);
        vm.prank(who);
        arena.placeCall(mid, 1, ethWins, amt);
    }

    function _push(int256 ratio) internal {
        vm.prank(pusher);
        relay.setPrice(ratio);
    }

    function _chainlink(int256 eth, int256 btc) internal {
        vm.startPrank(owner);
        ethUsd.setPrice(eth);
        btcUsd.setPrice(btc);
        vm.stopPrank();
    }

    function _guardNow() internal view returns (int256 r) {
        (, r, , , ) = guard.latestRoundData();
    }

    function _state() internal view returns (PredictionArena.RoundState st) {
        (, , , , , , st) = arena.rounds(mid, 1);
    }

    function _bps(int256 x, int256 bps) internal pure returns (int256) {
        return x * (10_000 + bps) / 10_000;
    }

    // =========================================================
    //  R-01: inside the band the pusher decides
    // =========================================================

    /// Chainlink does not move at all during the round. The pusher can make it an UP round or a DOWN round.
    function test_pusherDecides_whenChainlinkIsFlat() public {
        uint256 snap = vm.snapshotState();

        vm.warp(lt + 2);  _push(G0);
        vm.warp(et - 30); _push(_bps(G0, 240));  // +2.4%: inside the band
        vm.warp(et + 1);
        arena.settle(mid, 1, P1 | 1, P1 | 2);
        assertEq(uint256(_state()), uint256(PredictionArena.RoundState.SettledUp), "pusher chose UP");

        vm.revertToState(snap);
        vm.warp(lt + 2);  _push(G0);
        vm.warp(et - 30); _push(_bps(G0, -240)); // -2.4%: inside the band
        vm.warp(et + 1);
        arena.settle(mid, 1, P1 | 1, P1 | 2);
        assertEq(uint256(_state()), uint256(PredictionArena.RoundState.SettledDown), "same Chainlink, pusher chose DOWN");
        assertEq(_guardNow(), G0, "Chainlink never moved");
    }

    /// Chainlink says ETH beat BTC (+0.2%, about the median 1-hour ratio move). The pusher settles it as BTC wins,
    /// and Bob takes Alice's matched stake.
    function test_pusherDecides_againstChainlink() public {
        vm.warp(lt + 2);
        _push(_bps(G0, 240));                     // start 2.4% above Chainlink
        vm.warp(et - 30);
        _chainlink(3_006e8, 100_000e8);           // ETH +0.2% on Chainlink
        int256 g1 = _guardNow();
        assertGt(g1, G0, "Chainlink: ETH beat BTC");
        _push(_bps(g1, -240));                    // end 2.4% below Chainlink
        vm.warp(et + 1);
        arena.settle(mid, 1, P1 | 1, P1 | 2);
        assertEq(uint256(_state()), uint256(PredictionArena.RoundState.SettledDown), "settled against Chainlink");

        // M = 10, F = 0.20, Dist = 9.80: Bob gets 19.80, Alice nothing
        vm.prank(bob);
        arena.claim(mid, 1);
        assertEq(usdc.balanceOf(bob), 19_800_000);
        assertEq(arena.claimable(mid, 1, alice), 0);
    }

    /// What does stop the pusher: one unit past 2.5% from Chainlink is refused, at the start and at the end.
    function test_pusherCannotLeaveTheBand() public {
        int256 maxUp   = G0 + G0 * int256(uint256(BAND)) / 10_000;
        int256 maxDown = G0 - G0 * int256(uint256(BAND)) / 10_000;
        vm.warp(lt + 2);
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.OutsideBand.selector, maxUp + 1, G0, BAND));
        relay.setPrice(maxUp + 1);
        _push(maxUp);
        vm.warp(et - 30);
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.OutsideBand.selector, maxDown - 1, G0, BAND));
        relay.setPrice(maxDown - 1);
        _push(maxDown);
    }

    /// Nothing in the contracts stops the pusher's own wallet from placing a call.
    function test_pusherWalletCanPlay() public {
        // round 2 is open during round 1
        vm.warp(lt + 10);
        usdc.mint(pusher, 1_000_000);
        vm.prank(pusher);
        usdc.approve(address(arena), 1_000_000);
        vm.prank(pusher);
        arena.placeCall(mid, 2, true, 1_000_000);
        (uint128 up, , ) = arena.positions(mid, 2, pusher);
        assertEq(up, 1_000_000);
    }

    /// The relay owner can hand the pusher role to another address in the middle of a round, at once (R-02).
    function test_ownerCanSwapPusherMidRound() public {
        address other = makeAddr("other");
        vm.warp(lt + 2);
        _push(G0);
        vm.expectEmit(true, true, false, false, address(relay));
        emit GuardedRelayFeed.PusherChanged(pusher, other);
        vm.prank(owner);
        relay.setPusher(other);
        vm.warp(et - 30);
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.NotPusher.selector, pusher, other));
        relay.setPrice(G0);
        vm.prank(other);
        relay.setPrice(_bps(G0, 240));
        vm.warp(et + 1);
        arena.settle(mid, 1, P1 | 1, P1 | 2);
        assertEq(uint256(_state()), uint256(PredictionArena.RoundState.SettledUp), "the new pusher decided");
    }

    // =========================================================
    //  R-03: withheld and repeated pushes refund the round
    // =========================================================

    function _expectRefund(uint80 s, uint80 e, int256 sp, int256 ep, PredictionArena.RefundReason why) internal {
        vm.expectEmit(true, true, false, true, address(arena));
        emit PredictionArena.RoundSettled(mid, 1, PredictionArena.RoundState.Refunded, s, e, sp, ep, why);
    }

    function _bothGetEverythingBack() internal {
        vm.prank(alice);
        arena.claim(mid, 1);
        vm.prank(bob);
        arena.claim(mid, 1);
        assertEq(usdc.balanceOf(alice), 10_000_000);
        assertEq(usdc.balanceOf(bob), 10_000_000);
        assertEq(arena.feesAccrued(), 0, "a refund takes no fee");
        assertEq(arena.totalPlayerFunds(), 0);
    }

    /// No push at all after the lock (the last one was before it): NoUpdate refund.
    function test_withheldStart_refundsAsNoUpdate() public {
        vm.warp(lt - 30);
        _push(G0);                                // before the lock: decides nothing
        vm.warp(et - 30);
        _chainlink(3_090e8, 100_000e8);           // ETH +3% on Chainlink: Alice clearly won
        vm.warp(et + 1);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, P1 | 1));
        arena.settle(mid, 1, P1 | 1, P1 | 1);     // the pre-lock push cannot be used as the start
        _expectRefund(0, 0, 0, 0, PredictionArena.RefundReason.NoUpdate);
        arena.settle(mid, 1, 0, 0);
        _bothGetEverythingBack();
    }

    /// Only the start is pushed: EndNotAfterStart refund, and no other id pair settles it as a win.
    function test_withheldEnd_refundsAsEndNotAfterStart() public {
        vm.warp(lt + 2);
        _push(G0);
        vm.warp(et - 30);
        _chainlink(3_090e8, 100_000e8);           // ETH +3% on Chainlink
        vm.warp(et + 1);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.InvalidEndRound.selector, P1 | 2));
        arena.settle(mid, 1, P1 | 1, P1 | 2);     // no such push
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, uint80(0)));
        arena.settle(mid, 1, 0, 0);               // there IS an update after the lock
        _expectRefund(P1 | 1, P1 | 1, G0, G0, PredictionArena.RefundReason.EndNotAfterStart);
        arena.settle(mid, 1, P1 | 1, P1 | 1);
        _bothGetEverythingBack();
    }

    /// The end is withheld and the pusher pushes again only AFTER the round: still a refund, the late push is not the end.
    function test_endPushedTooLate_stillRefunds() public {
        vm.warp(lt + 2);
        _push(G0);
        vm.warp(et + 5);
        _push(_bps(G0, 100));                     // after the end: belongs to the next round
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.InvalidEndRound.selector, P1 | 2));
        arena.settle(mid, 1, P1 | 1, P1 | 2);
        _expectRefund(P1 | 1, P1 | 1, G0, G0, PredictionArena.RefundReason.EndNotAfterStart);
        arena.settle(mid, 1, P1 | 1, P1 | 1);
        _bothGetEverythingBack();
    }

    /// The same ratio pushed twice, while Chainlink moved 1%: UnchangedPrice refund.
    function test_repeatedPush_refundsAsUnchangedPrice() public {
        vm.warp(lt + 2);
        _push(G0);
        vm.warp(et - 30);
        _chainlink(3_030e8, 100_000e8);           // ETH +1% on Chainlink
        _push(G0);                                // the same ratio again: still within 2.5% of the new Chainlink ratio
        vm.warp(et + 1);
        _expectRefund(P1 | 1, P1 | 2, G0, G0, PredictionArena.RefundReason.UnchangedPrice);
        arena.settle(mid, 1, P1 | 1, P1 | 2);
        _bothGetEverythingBack();
    }

    /// Several pushes during the round, the last one equal to the start: only the LAST push before the end counts.
    function test_repeatedPush_lastOneCounts() public {
        vm.warp(lt + 2);
        _push(G0);
        vm.warp(lt + 600);
        _push(_bps(G0, 200));                     // a winning-looking middle push for Alice ...
        vm.warp(et - 30);
        _push(G0);                                // ... and then back to the start value
        vm.warp(et + 1);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.InvalidEndRound.selector, P1 | 2));
        arena.settle(mid, 1, P1 | 1, P1 | 2);     // the middle push cannot be used as the end
        _expectRefund(P1 | 1, P1 | 3, G0, G0, PredictionArena.RefundReason.UnchangedPrice);
        arena.settle(mid, 1, P1 | 1, P1 | 3);
        _bothGetEverythingBack();
    }

    /// The pusher stays silent: nobody settles within the hour, and the round refunds as Timeout on the first claim.
    function test_silentPusher_timeoutRefund() public {
        vm.warp(et + 1 hours + 1);
        vm.expectRevert();
        arena.settle(mid, 1, 0, 0);               // the settle window is closed
        vm.prank(alice);
        arena.claim(mid, 1);                      // finalises the round as a Timeout refund, then pays
        vm.prank(bob);
        arena.claim(mid, 1);
        assertEq(usdc.balanceOf(alice), 10_000_000);
        assertEq(usdc.balanceOf(bob), 10_000_000);
        assertEq(uint256(_state()), uint256(PredictionArena.RoundState.Refunded));
    }
}
