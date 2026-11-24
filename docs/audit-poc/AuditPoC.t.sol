// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Proof-of-concept tests for docs/AUDIT_RATIO_PART1.md
//
//  Kept OUT of contracts/test on purpose, so normal CI and the
//  mutation runs do not pick them up. Each test name starts with the
//  finding it belongs to (F1 = R-01, F3 = R-03, F4 = R-04, F5 = R-05,
//  F6 = R-02, R06, R08) or with OK_ for a check that came out fine.
//
//  Run them from the repo root:
//      FOUNDRY_TEST=docs/audit-poc forge test --match-contract AuditPoC -vv
// =============================================================

import {Test}             from "forge-std/Test.sol";
import {PredictionArena}  from "../../contracts/PredictionArena.sol";
import {GuardedRelayFeed} from "../../contracts/GuardedRelayFeed.sol";
import {RatioGuard}       from "../../contracts/RatioGuard.sol";
import {MockPriceFeed}    from "../../contracts/mocks/MockPriceFeed.sol";
import {MockUSDC}         from "../../contracts/test/MockUSDC.sol";
import {AggregatorV3Interface} from "../../contracts/interfaces/AggregatorV3Interface.sol";

contract AuditPoC is Test {
    PredictionArena  arena;
    MockUSDC         usdc;
    MockPriceFeed    ethUsd;
    MockPriceFeed    btcUsd;
    RatioGuard       guard;
    GuardedRelayFeed relay;
    uint256          mid;

    address owner    = makeAddr("owner");
    address pusher   = makeAddr("pusher");
    address attacker = makeAddr("attacker");
    address alice    = makeAddr("alice");
    address bob      = makeAddr("bob");

    uint32  constant ROUND = 3600;
    uint32  constant OFFSET = 50;
    uint128 constant MIN = 500_000;
    uint16  constant BAND = 250;
    uint80  constant P1 = uint80(1) << 64;

    function setUp() public {
        vm.warp(10);
        vm.startPrank(owner);
        usdc   = new MockUSDC();
        ethUsd = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / Chainlink stand-in ETH/USD");
        btcUsd = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / Chainlink stand-in BTC/USD");
        ethUsd.setPrice(3_000e8);
        btcUsd.setPrice(100_000e8);
        guard = new RatioGuard(ethUsd, btcUsd, "Matchup ratio guard ETH / BTC");
        relay = new GuardedRelayFeed(owner, pusher, guard, BAND, "Matchup relay ETH / BTC");
        arena = new PredictionArena(address(usdc), owner);
        mid = arena.marketCount();
        arena.createMarket("ETH/BTC 1h", address(relay), address(0), ROUND, OFFSET, MIN);
        vm.stopPrank();
    }

    function _call(address who, uint256 r, bool up, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.prank(who); usdc.approve(address(arena), amt);
        vm.prank(who); arena.placeCall(mid, r, up, amt);
    }
    function _push(address who, int256 v) internal { vm.prank(who); relay.setPrice(v); }
    function _guardNow() internal view returns (int256 r) { (, r, , , ) = guard.latestRoundData(); }
    function _state(uint256 r) internal view returns (PredictionArena.RoundState st, int256 sp, int256 ep) {
        (, , , , sp, ep, st) = arena.rounds(mid, r);
    }
    function _chainlink(int256 e, int256 b) internal {
        vm.startPrank(owner); ethUsd.setPrice(e); btcUsd.setPrice(b); vm.stopPrank();
    }

    // F1: Chainlink says ETH beat BTC (+0.2%), the pusher settles BTC wins, every push accepted.
    function test_F1_pusherPicksOutcome_againstChainlink() public {
        uint256 lt = arena.lockTime(mid, 1);
        uint256 et = arena.endTime(mid, 1);
        vm.warp(lt - 100);
        _call(alice, 1, true, 100_000_000);   // alice: ETH beats BTC, 100 USDC
        _call(bob,   1, false, 100_000_000);  // bob (pusher's friend): BTC beats ETH

        vm.warp(lt + 2);
        int256 g0 = _guardNow();              // 0.03
        _push(pusher, g0 * 10_240 / 10_000);  // start: +2.4% above Chainlink, accepted
        vm.warp(et - 10);
        _chainlink(3_006e8, 100_000e8);       // ETH +0.2% on Chainlink: ETH really won
        int256 g1 = _guardNow();
        assertGt(g1, g0);
        _push(pusher, g1 * 9_760 / 10_000);   // end: -2.4% below Chainlink, accepted
        vm.warp(et + 1);
        arena.settle(mid, 1, P1 | 1, P1 | 2);
        (PredictionArena.RoundState st, , ) = _state(1);
        assertEq(uint256(st), uint256(PredictionArena.RoundState.SettledDown), "pusher flipped the result");
        vm.prank(bob); arena.claim(mid, 1);
        assertEq(usdc.balanceOf(bob), 198_000_000, "bob takes alice's matched stake minus fee");
    }

    // F1b: the pusher (or anyone it colludes with) can also play: nothing stops the pusher wallet calling.
    function test_F1b_pusherCanPlay() public {
        vm.warp(arena.lockTime(mid, 1) - 100);
        _call(pusher, 1, true, 1_000_000);
        (uint128 up, , ) = arena.positions(mid, 1, pusher);
        assertEq(up, 1_000_000);
    }

    // F3: the pusher turns a losing round into a refund (free option), two ways.
    function test_F3_pusherForcesRefund_byWithholdingEnd() public {
        uint256 lt = arena.lockTime(mid, 1);
        uint256 et = arena.endTime(mid, 1);
        vm.warp(lt - 100);
        _call(alice, 1, true, 10_000_000);
        _call(bob,   1, false, 10_000_000);
        vm.warp(lt + 2);
        _push(pusher, _guardNow());
        // ETH rallies; the pusher's side (DOWN) would lose, so it pushes nothing more.
        vm.warp(et + 1);
        arena.settle(mid, 1, P1 | 1, P1 | 1);
        (PredictionArena.RoundState st, , ) = _state(1);
        assertEq(uint256(st), uint256(PredictionArena.RoundState.Refunded));
    }

    function test_F3_pusherForcesRefund_bySameValue() public {
        uint256 lt = arena.lockTime(mid, 1);
        uint256 et = arena.endTime(mid, 1);
        vm.warp(lt - 100);
        _call(alice, 1, true, 10_000_000);
        _call(bob,   1, false, 10_000_000);
        vm.warp(lt + 2);
        _push(pusher, 3e16);
        vm.warp(et - 5);
        _chainlink(3_030e8, 100_000e8); // ETH +1%
        _push(pusher, 3e16);            // same ratio again, still inside the band
        vm.warp(et + 1);
        arena.settle(mid, 1, P1 | 1, P1 | 2);
        (PredictionArena.RoundState st, , ) = _state(1);
        assertEq(uint256(st), uint256(PredictionArena.RoundState.Refunded), "UnchangedPrice refund");
    }

    // F4: a Chainlink leg frozen for 25 h still centres the band: pushes far from the live market are accepted.
    function test_F4_staleGuardStillCentresBand() public {
        uint256 t = block.timestamp;
        vm.warp(t + 25 hours);           // no Chainlink update for 25 h (real ratio may have moved 5%+)
        _push(pusher, 3e16 * 10_250 / 10_000);   // accepted: band around a 25-hour-old ratio
        _push(pusher, 3e16 * 9_750 / 10_000);    // accepted too
    }

    // F5: a push signed for the end of round 1 that lands one block late becomes the start of round 2.
    function test_F5_latePushBecomesNextRoundStart() public {
        uint256 lt1 = arena.lockTime(mid, 1);
        uint256 et1 = arena.endTime(mid, 1);
        vm.warp(lt1 - 100);
        _call(alice, 1, true, 1_000_000);
        _call(bob,   1, false, 1_000_000);
        vm.warp(et1 - 100);
        _call(alice, 2, true, 1_000_000);
        _call(bob,   2, false, 1_000_000);
        vm.warp(lt1 + 2);
        _push(pusher, 3e16);                   // round 1 start
        vm.warp(et1 - 30);
        _push(pusher, 3.01e16);                // round 1 end (real)
        // runner observes the price at et1 - 2 and sends; the tx is mined at et1 + 3
        int256 observedAtEnd = 3.02e16;
        vm.warp(et1 + 3);
        _push(pusher, observedAtEnd);
        vm.warp(et1 + 1 + ROUND);
        arena.settle(mid, 2, P1 | 3, P1 | 3);
        (, int256 sp, ) = _state(2);
        assertEq(sp, observedAtEnd, "round 2 start is a price observed before round 2 locked");
    }

    // F6: the owner can swap the pusher in the middle of a round with no delay.
    function test_F6_ownerSwapsPusherMidRound() public {
        uint256 lt = arena.lockTime(mid, 1);
        vm.warp(lt + 2);
        _push(pusher, 3e16);
        vm.prank(owner); relay.setPusher(attacker);
        vm.warp(lt + 1800);
        _push(attacker, 3e16 * 10_250 / 10_000);
    }

    // Checked fine: no gas limit makes settle() refund a round that has a valid start/end
    // (63/64 rule: the 1/64 left after an out-of-gas feed call cannot pay for the refund's SSTOREs).
    function test_OK_gasGriefing_cannotForceNoUpdateOrPhaseEdge() public {
        uint256 lt = arena.lockTime(mid, 1);
        uint256 et = arena.endTime(mid, 1);
        vm.warp(lt - 100);
        _call(alice, 1, true, 1_000_000);
        _call(bob,   1, false, 1_000_000);
        vm.warp(lt + 2);  _push(pusher, 3e16);
        vm.warp(et - 2);  _push(pusher, 3.01e16);  // end is the latest round: no successor
        vm.warp(et + 1);
        uint256 okCount; uint256 zeroOk; for (uint256 g = 3_000; g < 250_000; g += 97) {
            uint256 snap = vm.snapshotState();
            (bool ok0, ) = address(arena).call{gas: g}(abi.encodeCall(arena.settle, (mid, 1, 0, 0)));
            if (ok0) { zeroOk++; (PredictionArena.RoundState s0, , ) = _state(1); assertTrue(s0 == PredictionArena.RoundState.Unsettled, "NoUpdate forced"); }
            vm.revertToState(snap);
            (bool ok1, ) = address(arena).call{gas: g}(abi.encodeCall(arena.settle, (mid, 1, P1 | 1, P1 | 2)));
            if (ok1) { okCount++; (PredictionArena.RoundState s1, , ) = _state(1); assertEq(uint256(s1), uint256(PredictionArena.RoundState.SettledUp), "PhaseEdge forced"); }
            vm.revertToState(snap);
        }
        emit log_named_uint("ok settles", okCount);
        emit log_named_uint("ok zero-id settles (must be 0)", zeroOk);
        assertGt(okCount, 0);
        assertEq(zeroOk, 0);
    }

    // R-06: a Chainlink proxy whose decimals change after the RatioGuard was deployed (cached decimals).
    function test_R06_decimalsChange_ratioOff_pushesRefused() public {
        DecFeed e = new DecFeed(8, 3_000e8);
        DecFeed b = new DecFeed(8, 100_000e8);
        RatioGuard g = new RatioGuard(e, b, "dec test");
        GuardedRelayFeed r = new GuardedRelayFeed(owner, pusher, g, BAND, "Matchup relay dec test");
        vm.prank(pusher); r.setPrice(3e16);
        e.set(18, 3_000e18);          // proxy repointed to an 18-decimal aggregator, same $3,000
        (, int256 a, , , ) = g.latestRoundData();
        assertEq(a, 3e26, "ratio now 1e10 too large, no error from the guard");
        vm.prank(pusher);
        vm.expectRevert();            // OutsideBand: honest 0.03 is refused, rounds refund
        r.setPrice(3e16);
    }

    // R-08: a market created on the RatioGuard by mistake: settle(…, 0, 0) succeeds as a NoUpdate refund
    // (the header says every settle() would revert). Same money outcome: refund.
    function test_R08_marketOnGuard_settleZeroRefunds() public {
        vm.prank(owner);
        arena.createMarket("oops", address(guard), address(0), ROUND, OFFSET, MIN);
        uint256 m2 = arena.marketCount() - 1;
        uint256 lt = arena.lockTime(m2, 1);
        vm.warp(lt - 100);
        usdc.mint(alice, 1_000_000); vm.prank(alice); usdc.approve(address(arena), 1_000_000);
        vm.prank(alice); arena.placeCall(m2, 1, true, 1_000_000);
        usdc.mint(bob, 1_000_000); vm.prank(bob); usdc.approve(address(arena), 1_000_000);
        vm.prank(bob); arena.placeCall(m2, 1, false, 1_000_000);
        vm.warp(arena.endTime(m2, 1) + 1);   // Chainlink last updated at t=10, before the lock
        arena.settle(m2, 1, 0, 0);
        (, , , , , , PredictionArena.RoundState st) = arena.rounds(m2, 1);
        assertEq(uint256(st), uint256(PredictionArena.RoundState.Refunded));
    }

    // Checked fine: the start/end ids are unique even with several pushes in one second.
    function test_OK_samesecondPushes_uniqueIds() public {
        uint256 lt = arena.lockTime(mid, 1);
        uint256 et = arena.endTime(mid, 1);
        vm.warp(lt - 100);
        _call(alice, 1, true, 1_000_000);
        _call(bob,   1, false, 1_000_000);
        vm.warp(lt);  _push(pusher, 3e16); _push(pusher, 3.01e16); // ids 1, 2 both at lt
        vm.warp(et);  _push(pusher, 2.99e16); _push(pusher, 3.02e16); // ids 3, 4 both at et
        vm.warp(et + 1);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.InvalidStartRound.selector, P1 | 2));
        arena.settle(mid, 1, P1 | 2, P1 | 4);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.InvalidEndRound.selector, P1 | 3));
        arena.settle(mid, 1, P1 | 1, P1 | 3);
        arena.settle(mid, 1, P1 | 1, P1 | 4);
        (PredictionArena.RoundState st, , ) = _state(1);
        assertEq(uint256(st), uint256(PredictionArena.RoundState.SettledUp));
    }
}

/// A Chainlink-shaped feed whose decimals can change (R-06).
contract DecFeed is AggregatorV3Interface {
    uint8 public dec; int256 public ans;
    constructor(uint8 d, int256 a) { dec = d; ans = a; }
    function set(uint8 d, int256 a) external { dec = d; ans = a; }
    function decimals() external view override returns (uint8) { return dec; }
    function description() external pure override returns (string memory) { return "dec"; }
    function version() external pure override returns (uint256) { return 1; }
    function getRoundData(uint80) external pure override returns (uint80, int256, uint256, uint256, uint80) { revert(); }
    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (uint80((1 << 64) | 1), ans, block.timestamp, block.timestamp, uint80((1 << 64) | 1));
    }
}
