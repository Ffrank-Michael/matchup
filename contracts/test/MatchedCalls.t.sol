// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Kairo Markets – Matched calls (v1.1 payout rules), docs/MATCHED_CALLS.md
//
//  Every expected number below is worked out by hand from the spec, never copied from the
//  contract's output. M = min(UP, DOWN), T = the bigger side's total, F = floor(M * 200 / 10_000),
//  Dist = M - F. Smaller side: fully matched. Bigger side: matched = floor(s*M/T) when the bigger
//  side WON, ceil(s*M/T) when it LOST. Winner = s + floor(matched*Dist/M). Loser = s - matched.
//
//  The rounding tests use stakes where floor and ceil give DIFFERENT payouts, so swapping the two
//  roundings (or using floor for both) fails them.
// =============================================================

import {PredictionArena} from "../PredictionArena.sol";
import {ClaimBase}       from "./Claim.t.sol";

contract MatchedCallsTest is ClaimBase {

    uint256 mid;

    function setUp() public {
        _baseSetUp();
        vm.prank(owner);
        arena.createMarket("MATCH", address(feed), address(0), ROUND, 0, 1);
        mid = arena.marketCount() - 1;
    }

    // ── helpers ──────────────────────────────────────────────

    function _who(string memory tag, uint256 i) internal returns (address) {
        return makeAddr(string(abi.encodePacked(tag, vm.toString(i))));
    }

    /// Everyone calls round 1 of the market, then the round settles UP (upWins) or DOWN.
    function _play(uint256[] memory ups, uint256[] memory downs, bool upWins)
        internal returns (address[] memory upP, address[] memory dnP)
    {
        vm.warp(1);
        upP = new address[](ups.length);
        dnP = new address[](downs.length);
        for (uint256 i = 0; i < ups.length; i++)   { upP[i] = _who("up", i);   _bet(upP[i], mid, 1, true,  ups[i]); }
        for (uint256 i = 0; i < downs.length; i++) { dnP[i] = _who("dn", i);   _bet(dnP[i], mid, 1, false, downs[i]); }
        uint256 lt = _lock(mid, 1);
        uint256 et = _end(mid, 1);
        vm.warp(lt - 2); vm.prank(owner); feed.setPrice(100e8);
        vm.warp(lt + 1); vm.prank(owner); feed.setPrice(100e8);                 // start
        vm.warp(et - 1); vm.prank(owner); feed.setPrice(upWins ? int256(105e8) : int256(95e8)); // end
        vm.warp(et + 1);
        vm.prank(settler); arena.settle(mid, 1, (uint80(1) << 64) | 2, (uint80(1) << 64) | 3);
    }

    function _arr(uint256 a) internal pure returns (uint256[] memory r) { r = new uint256[](1); r[0] = a; }
    function _arr(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3); r[0] = a; r[1] = b; r[2] = c;
    }

    /// claimable() must equal what claim() then pays.
    function _claimChecked(address who) internal returns (uint256 paid) {
        uint256 view_ = arena.claimable(mid, 1, who);
        paid = _claim(who, mid, 1);
        assertEq(paid, view_, "claimable() == claim()");
    }

    function _expectNothing(address who) internal {
        assertEq(arena.claimable(mid, 1, who), 0, "claimable is 0");
        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(PredictionArena.NothingToClaim.selector, mid, 1));
        arena.claim(mid, 1);
    }

    // =========================================================
    //  Worked example from the spec: UP 10, DOWN 6 (USDC micro-units)
    //  M = 6_000_000, F = 120_000, Dist = 5_880_000
    // =========================================================

    function test_workedExample_upWins() public {
        (address[] memory u, address[] memory d) = _play(_arr(10_000_000), _arr(6_000_000), true);
        // UP caller: matched 6_000_000 (floor(10M*6M/10M)), 4_000_000 unmatched comes back.
        // payout = 10_000_000 + floor(6_000_000 * 5_880_000 / 6_000_000) = 15_880_000
        assertEq(_claimChecked(u[0]), 15_880_000, "UP winner gets 15.88");
        _expectNothing(d[0]); // DOWN lost its whole (fully matched) stake
        assertEq(arena.feesAccrued(), 120_000, "fee is 2% of the matched 6, not of anything else");
        assertEq(arena.totalPlayerFunds(), 0);
        assertEq(usdc.balanceOf(address(arena)), 120_000);
    }

    function test_workedExample_downWins() public {
        (address[] memory u, address[] memory d) = _play(_arr(10_000_000), _arr(6_000_000), false);
        // DOWN caller (smaller side, winner): 6_000_000 + 5_880_000 = 11_880_000
        assertEq(_claimChecked(d[0]), 11_880_000, "DOWN winner gets 11.88");
        // UP caller (bigger side, lost): matched ceil(10M*6M/10M) = 6_000_000, so 4_000_000 comes back.
        assertEq(_claimChecked(u[0]), 4_000_000, "the unmatched 4 comes back even though the call lost");
        assertEq(arena.feesAccrued(), 120_000);
        assertEq(arena.totalPlayerFunds(), 0);
        assertEq(usdc.balanceOf(address(arena)), 120_000, "11.88 + 4 + 0.12 = 16");
    }

    // =========================================================
    //  Tie: both sides fully matched, fee is 2% of the matched pool
    // =========================================================

    function test_tie_upWins() public {
        (address[] memory u, address[] memory d) = _play(_arr(5_000_000), _arr(5_000_000), true);
        // M = 5_000_000, F = 100_000, Dist = 4_900_000 -> 5_000_000 + 4_900_000
        assertEq(_claimChecked(u[0]), 9_900_000);
        _expectNothing(d[0]);
        assertEq(arena.feesAccrued(), 100_000);
        assertEq(usdc.balanceOf(address(arena)), 100_000);
    }

    function test_tie_downWins_loserGetsNothing() public {
        (address[] memory u, address[] memory d) = _play(_arr(5_000_000), _arr(5_000_000), false);
        assertEq(_claimChecked(d[0]), 9_900_000);
        _expectNothing(u[0]); // on a tie nobody is "bigger": the loser was matched in full
    }

    // =========================================================
    //  Many callers, bigger side LOST: matched rounds UP.
    //  UP (bigger, loses): a=400_010, b=300_010, c=300_010   T = 1_000_030
    //  DOWN (smaller, wins): dave 1_000_000                  M = 1_000_000, F = 20_000, Dist = 980_000
    //    a: 400_010*1_000_000/1_000_030 = 399_998.00003 -> ceil 399_999, unmatched 11   (floor would give 12)
    //    b: 300_010*1_000_000/1_000_030 = 300_000.99997 -> ceil 300_001, unmatched  9   (floor would give 10)
    //    c: same as b
    //    sum(matched) = 1_000_001 >= M, surplus 1
    //  dave = 1_000_000 + 980_000 = 1_980_000
    // =========================================================

    function test_biggerSideLost_roundsUp_andSurplusGoesToFees() public {
        (address[] memory u, address[] memory d) = _play(_arr(400_010, 300_010, 300_010), _arr(1_000_000), false);
        assertEq(_claimChecked(d[0]), 1_980_000, "smaller-side winner");
        assertEq(_claimChecked(u[0]), 11, "a: unmatched with the matched part rounded UP");
        assertEq(_claimChecked(u[1]), 9,  "b");
        assertEq(arena.totalPlayerFunds(), 9 + 1, "c still owed 9, and the surplus 1 is not swept until the last loser claims");
        assertEq(_claimChecked(u[2]), 9,  "c");
        // everyone has claimed: fees = fee 20_000 + surplus 1; nothing is left owed
        assertEq(arena.feesAccrued(), 20_001, "fee + rounding surplus");
        assertEq(arena.totalPlayerFunds(), 0);
        assertEq(usdc.balanceOf(address(arena)), 20_001);
        // money in = money out + fees: 2_000_030 = 1_980_000 + 29 + 20_001
        uint256 totalIn = 400_010 + 300_010 + 300_010 + 1_000_000;
        assertEq(totalIn, 1_980_000 + 11 + 9 + 9 + 20_001);
    }

    // =========================================================
    //  Many callers, bigger side WON: matched rounds DOWN.
    //  Same stakes, UP wins.
    //    a: floor 399_998, bonus floor(399_998*980_000/1_000_000) = 391_998, payout 792_008
    //    b: floor 300_000, bonus 294_000,                                     payout 594_010
    //    c: same as b
    //    sum(bonus) = 979_998, winner dust = 980_000 - 979_998 = 2
    //  (rounding UP would pay a 792_009: this test fails if the roundings are swapped)
    // =========================================================

    function test_biggerSideWon_roundsDown_andDustGoesToFees() public {
        (address[] memory u, address[] memory d) = _play(_arr(400_010, 300_010, 300_010), _arr(1_000_000), true);
        assertEq(_claimChecked(u[0]), 792_008, "a");
        assertEq(_claimChecked(u[1]), 594_010, "b");
        assertEq(arena.feesAccrued(), 20_000, "dust is only swept after the LAST winner has claimed");
        assertEq(_claimChecked(u[2]), 594_010, "c");
        _expectNothing(d[0]);
        assertEq(arena.feesAccrued(), 20_002, "fee 20_000 + winner dust 2");
        assertEq(arena.totalPlayerFunds(), 0);
        assertEq(usdc.balanceOf(address(arena)), 20_002);
    }

    // =========================================================
    //  A bigger-side caller whose whole stake rounds up to matched has nothing to claim
    // =========================================================

    function test_biggerSideLoser_withNothingUnmatched_reverts() public {
        // UP 3 and 2 (T = 5, bigger side, loses), DOWN 4 (M = 4, F = 0, Dist = 4).
        // ceil(3*4/5) = ceil(2.4) = 3 -> unmatched 0;  ceil(2*4/5) = ceil(1.6) = 2 -> unmatched 0.
        uint256[] memory ups = new uint256[](2);
        ups[0] = 3; ups[1] = 2;
        (address[] memory u, address[] memory d) = _play(ups, _arr(4), false);
        assertEq(_claimChecked(d[0]), 8, "winner: 4 + 4");
        _expectNothing(u[0]);
        _expectNothing(u[1]);
        // Known edge, pinned here so a change is noticed: no loser can claim, so the rounding
        // surplus (sum of rounded-up matched 5 - M 4 = 1) is never swept to fees. It stays in the
        // contract and stays counted as owed, so the balance still covers everything.
        assertEq(arena.feesAccrued(), 0);
        assertEq(arena.totalPlayerFunds(), 1);
        assertEq(usdc.balanceOf(address(arena)), 1);
    }

    // =========================================================
    //  A winner's unmatched money is always part of the payout, and matchedStake() agrees with it
    // =========================================================

    function test_matchedStake_agreesWithPayouts() public {
        (address[] memory u, address[] memory d) = _play(_arr(400_010, 300_010, 300_010), _arr(1_000_000), false);
        (uint256 m0, uint256 un0) = arena.matchedStake(mid, 1, u[0]);
        assertEq(m0, 399_999);  assertEq(un0, 11);
        (uint256 m1, uint256 un1) = arena.matchedStake(mid, 1, u[1]);
        assertEq(m1, 300_001);  assertEq(un1, 9);
        (uint256 md, uint256 und) = arena.matchedStake(mid, 1, d[0]);
        assertEq(md, 1_000_000); assertEq(und, 0);
    }

    /// Same stakes, UP (the bigger side) wins: matched rounds DOWN.
    ///   a: floor(400_010*1_000_000/1_000_030) = 399_998, unmatched 12;  b/c: floor = 300_000, unmatched 10
    ///   smaller-side DOWN loser: fully matched.
    function test_matchedStake_biggerSideWinner_roundsDown() public {
        (address[] memory u, address[] memory d) = _play(_arr(400_010, 300_010, 300_010), _arr(1_000_000), true);
        (uint256 m0, uint256 un0) = arena.matchedStake(mid, 1, u[0]);
        assertEq(m0, 399_998);  assertEq(un0, 12);
        (uint256 m1, uint256 un1) = arena.matchedStake(mid, 1, u[1]);
        assertEq(m1, 300_000);  assertEq(un1, 10);
        (uint256 md, uint256 und) = arena.matchedStake(mid, 1, d[0]);
        assertEq(md, 1_000_000); assertEq(und, 0);
    }

    // =========================================================
    //  Fuzz: with ANY stakes and either winner, no money appears or vanishes, the contract never
    //  owes more than it holds, and every payout equals an independent model of the spec.
    // =========================================================

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) { return (a + b - 1) / b; }

    /// Everything the independent model needs, in one place (keeps the stack small).
    struct Spec { uint256 M; uint256 T; uint256 dist; bool upBigger; bool dnBigger; bool biggerWon; bool upWins; }

    function _model(uint256 s, Spec memory c, bool onBigger, bool winner) internal pure returns (uint256) {
        uint256 matched = !onBigger ? s : (c.biggerWon ? s * c.M / c.T : _ceilDiv(s * c.M, c.T));
        return winner ? s + matched * c.dist / c.M : s - matched;
    }

    function _spec(uint256 U, uint256 D, bool upWins) internal pure returns (Spec memory c) {
        c.M = U < D ? U : D;
        c.T = U > D ? U : D;
        c.dist = c.M - c.M * 200 / 10_000;
        c.upBigger = U > D;
        c.dnBigger = D > U;
        c.upWins = upWins;
        c.biggerWon = upWins ? c.upBigger : c.dnBigger; // a tie has no bigger side: every caller is fully matched
    }

    function testFuzz_conservation_and_model(uint64[4] memory upS, uint64[3] memory dnS, bool upWins) public {
        uint256[] memory ups = new uint256[](4);
        uint256[] memory downs = new uint256[](3);
        uint256 U; uint256 D;
        for (uint256 i = 0; i < 4; i++) { ups[i]   = bound(upS[i], 1, 5_000_000_000); U += ups[i]; }
        for (uint256 i = 0; i < 3; i++) { downs[i] = bound(dnS[i], 1, 5_000_000_000); D += downs[i]; }
        (address[] memory u, address[] memory d) = _play(ups, downs, upWins);
        Spec memory c = _spec(U, D, upWins);

        uint256 paid;
        for (uint256 i = 0; i < 4; i++) paid += _settleOne(u[i], ups[i], c, c.upBigger, upWins);
        for (uint256 i = 0; i < 3; i++) paid += _settleOne(d[i], downs[i], c, c.dnBigger, !upWins);

        uint256 bal = usdc.balanceOf(address(arena));
        assertEq(paid + bal, U + D, "money in = money out + what the contract still holds");
        assertGe(bal, arena.totalPlayerFunds() + arena.feesAccrued(), "never owes more than it holds");
        assertGe(arena.feesAccrued(), c.M * 200 / 10_000, "at least the 2% fee on the matched pool");
    }

    function _settleOne(address who, uint256 s, Spec memory c, bool onBigger, bool isWinner)
        internal returns (uint256 got)
    {
        uint256 expected = _model(s, c, onBigger, isWinner);
        assertEq(arena.claimable(mid, 1, who), expected, "claimable matches the model");
        if (expected == 0) {
            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(PredictionArena.NothingToClaim.selector, mid, 1));
            arena.claim(mid, 1);
            return 0;
        }
        got = _claim(who, mid, 1);
        assertEq(got, expected, "claim matches the model");
        assertGe(usdc.balanceOf(address(arena)), arena.totalPlayerFunds() + arena.feesAccrued(), "balance covers what is owed");
    }
}
