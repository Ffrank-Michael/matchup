// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Matchup – RatioGuard tests
//
//  Covers: the ratio is right (ETH/BTC, SOL/BTC, mixed decimals,
//  rounding down, fuzz), decimals, the older update time, refusing
//  a zero or negative answer, a stale / zero / future Chainlink
//  time, a reverting feed, the uint128 caps (input and ratio),
//  ratio rounding to zero, constructor checks, no history, and the
//  unchanged GuardedRelayFeed using a RatioGuard as its guard.
// =============================================================

import {Test}                  from "forge-std/Test.sol";
import {RatioGuard}            from "../RatioGuard.sol";
import {GuardedRelayFeed}      from "../GuardedRelayFeed.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

// ================================================================
//  Helper: a Chainlink-shaped feed whose every field the test sets
//  (answer, updatedAt, decimals, and whether it reverts).
// ================================================================
contract RatioTestFeed is AggregatorV3Interface {
    uint8   public dec;
    int256  public ans;
    uint256 public at;
    bool    public broken;

    constructor(uint8 dec_) { dec = dec_; }

    function set(int256 ans_, uint256 at_) external { ans = ans_; at = at_; }
    function setBroken(bool b) external { broken = b; }

    function decimals() external view override returns (uint8) { return dec; }
    function description() external pure override returns (string memory) { return "ratio test feed"; }
    function version() external pure override returns (uint256) { return 1; }
    function getRoundData(uint80) external pure override returns (uint80, int256, uint256, uint256, uint80) {
        revert("no data");
    }
    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed down");
        return (uint80((1 << 64) | 7), ans, at, at, uint80((1 << 64) | 7));
    }
}

contract RatioGuardTest is Test {

    RatioTestFeed btc;
    RatioTestFeed eth;
    RatioTestFeed sol;
    RatioGuard    ethBtc;
    RatioGuard    solBtc;

    address owner  = address(0xA11CE);
    address pusher = address(0xB0B);

    uint256 constant T0 = 1_800_000_000; // a fixed "now" for every test

    function setUp() public {
        vm.warp(T0);
        btc = new RatioTestFeed(8);
        eth = new RatioTestFeed(8);
        sol = new RatioTestFeed(8);
        // Chainlink-like 8-decimal prices
        btc.set(100_000e8, T0);   // BTC $100,000
        eth.set(3_000e8,   T0);   // ETH $3,000
        sol.set(150e8,     T0);   // SOL $150
        ethBtc = new RatioGuard(eth, btc, "Matchup ratio guard ETH / BTC");
        solBtc = new RatioGuard(sol, btc, "Matchup ratio guard SOL / BTC");
    }

    function _answer(RatioGuard g) internal view returns (int256 a) {
        (, a, , , ) = g.latestRoundData();
    }

    // =========================================================
    //  The ratio is right
    // =========================================================

    function test_ethBtc_exactRatio() public view {
        // 3,000 / 100,000 = 0.03 -> 0.03 * 1e18
        assertEq(_answer(ethBtc), 3e16);
    }

    function test_solBtc_exactRatio() public view {
        // 150 / 100,000 = 0.0015 -> 0.0015 * 1e18
        assertEq(_answer(solBtc), 15e14);
    }

    function test_realisticPrices_matchHandMaths() public {
        // ETH $3,312.87654321, BTC $97,654.12345678 (8 decimals each)
        eth.set(331_287_654_321, T0);
        btc.set(9_765_412_345_678, T0);
        // ratio = 331287654321 * 1e18 / 9765412345678, rounded down
        //       = 0.033924594537743416... -> 33924594537743416 (worked out separately with BigInt)
        assertEq(_answer(ethBtc), 33_924_594_537_743_416);
        // and the same number written as the formula
        assertEq(uint256(_answer(ethBtc)), uint256(331_287_654_321) * 1e18 / 9_765_412_345_678);
    }

    function test_roundsDown() public {
        // 1 / 3 at 18 decimals = 0.333... -> 333333333333333333 (never rounds up)
        eth.set(1e8, T0);
        btc.set(3e8, T0);
        assertEq(_answer(ethBtc), 333_333_333_333_333_333);
    }

    function test_mixedDecimals_sameRatio() public {
        // ETH on 18 decimals, BTC on 8: still 0.03
        RatioTestFeed eth18 = new RatioTestFeed(18);
        eth18.set(3_000e18, T0);
        RatioGuard g = new RatioGuard(eth18, btc, "mixed");
        assertEq(_answer(g), 3e16);

        // and the other way round: ETH on 8, BTC on 18
        RatioTestFeed btc18 = new RatioTestFeed(18);
        btc18.set(100_000e18, T0);
        RatioGuard g2 = new RatioGuard(eth, btc18, "mixed 2");
        assertEq(_answer(g2), 3e16);
    }

    function test_zeroDecimalFeeds() public {
        RatioTestFeed a = new RatioTestFeed(0);
        RatioTestFeed b = new RatioTestFeed(0);
        a.set(3, T0);
        b.set(100, T0);
        RatioGuard g = new RatioGuard(a, b, "zero decimals");
        assertEq(_answer(g), 3e16);
    }

    function test_followsTheLatestChainlinkAnswers() public {
        assertEq(_answer(ethBtc), 3e16);
        eth.set(3_300e8, T0);          // ETH +10%
        assertEq(_answer(ethBtc), 33e15);
        btc.set(110_000e8, T0);        // BTC +10% too: back to 0.03
        assertEq(_answer(ethBtc), 3e16);
    }

    /// Any two realistic 8-decimal prices give exactly a * 1e18 / b.
    function testFuzz_ratioFormula(uint256 a, uint256 b) public {
        a = bound(a, 1, 1e20);          // up to $1 trillion with 8 decimals
        b = bound(b, 1, 1e20);
        vm.assume(a * 1e18 / b > 0);    // ratio not below 1e-18
        eth.set(int256(a), T0);
        btc.set(int256(b), T0);
        assertEq(uint256(_answer(ethBtc)), a * 1e18 / b);
    }

    // =========================================================
    //  Decimals and metadata
    // =========================================================

    function test_decimals_is18() public view {
        assertEq(ethBtc.decimals(), 18);
        assertEq(solBtc.decimals(), 18);
        assertEq(ethBtc.RATIO_DECIMALS(), 18);
    }

    function test_decimals_readFromFeedsAtDeploy() public view {
        assertEq(ethBtc.numeratorDecimals(), 8);
        assertEq(ethBtc.denominatorDecimals(), 8);
        assertEq(address(ethBtc.numerator()), address(eth));
        assertEq(address(ethBtc.denominator()), address(btc));
    }

    function test_decimals_18Accepted_19Refused() public {
        RatioTestFeed d18 = new RatioTestFeed(18);
        new RatioGuard(d18, btc, "ok");
        new RatioGuard(btc, d18, "ok");

        RatioTestFeed d19 = new RatioTestFeed(19);
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.TooManyDecimals.selector, address(d19), uint8(19)));
        new RatioGuard(d19, btc, "too many");
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.TooManyDecimals.selector, address(d19), uint8(19)));
        new RatioGuard(btc, d19, "too many");
    }

    function test_descriptionAndVersion() public view {
        assertEq(ethBtc.description(), "Matchup ratio guard ETH / BTC");
        assertEq(ethBtc.version(), 1);
    }

    function test_getRoundData_alwaysReverts() public {
        vm.expectRevert(RatioGuard.NoHistory.selector);
        ethBtc.getRoundData(0);
        vm.expectRevert(RatioGuard.NoHistory.selector);
        ethBtc.getRoundData(uint80((1 << 64) | 1));
    }

    // =========================================================
    //  Update time: the older of the two
    // =========================================================

    function test_updatedAt_isOlderOfTwo_numeratorOlder() public {
        eth.set(3_000e8, T0 - 500);
        btc.set(100_000e8, T0 - 20);
        (uint80 id, , uint256 startedAt, uint256 updatedAt, uint80 answeredIn) = ethBtc.latestRoundData();
        assertEq(updatedAt, T0 - 500);
        assertEq(startedAt, T0 - 500);
        assertEq(id, 0);
        assertEq(answeredIn, 0);
    }

    function test_updatedAt_isOlderOfTwo_denominatorOlder() public {
        eth.set(3_000e8, T0 - 20);
        btc.set(100_000e8, T0 - 900);
        (, , , uint256 updatedAt, ) = ethBtc.latestRoundData();
        assertEq(updatedAt, T0 - 900);
    }

    function test_updatedAt_equalTimes() public {
        eth.set(3_000e8, T0 - 60);
        btc.set(100_000e8, T0 - 60);
        (, , , uint256 updatedAt, ) = ethBtc.latestRoundData();
        assertEq(updatedAt, T0 - 60);
    }

    // =========================================================
    //  Refusing a zero or negative answer
    // =========================================================

    function test_negativeNumerator_refused() public {
        eth.set(-1, T0);
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.NonPositiveAnswer.selector, address(eth), int256(-1)));
        ethBtc.latestRoundData();
    }

    function test_negativeDenominator_refused() public {
        btc.set(-100_000e8, T0);
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.NonPositiveAnswer.selector, address(btc), int256(-100_000e8)));
        ethBtc.latestRoundData();
    }

    function test_zeroNumerator_refused() public {
        eth.set(0, T0);
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.NonPositiveAnswer.selector, address(eth), int256(0)));
        ethBtc.latestRoundData();
    }

    function test_zeroDenominator_refused() public {
        // also proves there is no division by zero
        btc.set(0, T0);
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.NonPositiveAnswer.selector, address(btc), int256(0)));
        ethBtc.latestRoundData();
    }

    function test_minInt_refused() public {
        eth.set(type(int256).min, T0);
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.NonPositiveAnswer.selector, address(eth), type(int256).min));
        ethBtc.latestRoundData();
    }

    function test_reverts_whenFeedReverts() public {
        btc.setBroken(true);
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.FeedUnavailable.selector, address(btc)));
        ethBtc.latestRoundData();
        btc.setBroken(false);
        eth.setBroken(true);
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.FeedUnavailable.selector, address(eth)));
        ethBtc.latestRoundData();
    }

    // =========================================================
    //  Bad times (stale is decided by the relay, see below)
    // =========================================================

    function test_zeroUpdatedAt_refused() public {
        eth.set(3_000e8, 0);
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.BadUpdatedAt.selector, address(eth), uint256(0)));
        ethBtc.latestRoundData();
    }

    function test_futureUpdatedAt_refused() public {
        btc.set(100_000e8, T0 + 1);
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.BadUpdatedAt.selector, address(btc), T0 + 1));
        ethBtc.latestRoundData();
    }

    function test_veryOldTime_isPassedOn_notHidden() public {
        // The guard itself still answers, with the OLD time, so the relay can refuse it.
        btc.set(100_000e8, T0 - 30 days);
        (, int256 a, , uint256 updatedAt, ) = ethBtc.latestRoundData();
        assertEq(a, 3e16);
        assertEq(updatedAt, T0 - 30 days);
    }

    // =========================================================
    //  The uint128 caps
    // =========================================================

    function test_inputAtUint128Max_accepted() public {
        // numerator at the cap, 18 decimals; denominator 1 with 18 decimals: ratio = uint128.max exactly
        RatioTestFeed a = new RatioTestFeed(18);
        RatioTestFeed b = new RatioTestFeed(18);
        a.set(int256(uint256(type(uint128).max)), T0);
        b.set(1e18, T0);
        RatioGuard g = new RatioGuard(a, b, "at the cap");
        assertEq(uint256(_answer(g)), uint256(type(uint128).max));
    }

    function test_inputAboveUint128Max_refused() public {
        int256 tooBig = int256(uint256(type(uint128).max) + 1);
        eth.set(tooBig, T0);
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.AnswerTooLarge.selector, address(eth), tooBig));
        ethBtc.latestRoundData();

        eth.set(3_000e8, T0);
        btc.set(tooBig, T0);
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.AnswerTooLarge.selector, address(btc), tooBig));
        ethBtc.latestRoundData();
    }

    function test_maxInt256Input_refused_noOverflow() public {
        eth.set(type(int256).max, T0);
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.AnswerTooLarge.selector, address(eth), type(int256).max));
        ethBtc.latestRoundData();
    }

    function test_ratioJustAboveUint128Max_refused() public {
        // ratio = (uint128.max + 1) at 18 decimals: one above the cap
        RatioTestFeed a = new RatioTestFeed(18);
        RatioTestFeed b = new RatioTestFeed(18);
        a.set(int256(uint256(type(uint128).max)), T0);
        // the denominator a hair below 1.0 brings the ratio just over the cap
        b.set(1e18 - 1, T0);
        RatioGuard g = new RatioGuard(a, b, "over the cap");
        uint256 expected = uint256(type(uint128).max) * 1e36 / ((1e18 - 1) * 1e18);
        assertGt(expected, uint256(type(uint128).max));
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.RatioTooLarge.selector, expected));
        g.latestRoundData();
    }

    function test_worstCaseInputs_neverOverflow() public {
        // Largest accepted inputs with the largest accepted decimals: the maths must not panic.
        RatioTestFeed a = new RatioTestFeed(0);
        RatioTestFeed b = new RatioTestFeed(18);
        a.set(int256(uint256(type(uint128).max)), T0);
        b.set(1, T0);
        RatioGuard g = new RatioGuard(a, b, "worst case");
        uint256 expected = uint256(type(uint128).max) * 1e36; // / (1 * 1)
        vm.expectRevert(abi.encodeWithSelector(RatioGuard.RatioTooLarge.selector, expected));
        g.latestRoundData();

        // and the other extreme: largest denominator, smallest numerator
        RatioTestFeed c = new RatioTestFeed(18);
        RatioTestFeed d = new RatioTestFeed(0);
        c.set(1, T0);
        d.set(int256(uint256(type(uint128).max)), T0);
        RatioGuard g2 = new RatioGuard(c, d, "worst case 2");
        vm.expectRevert(RatioGuard.RatioZero.selector);
        g2.latestRoundData();
    }

    function test_ratioRoundsToZero_refused() public {
        // 1 unit of an 18-decimal coin over $100,000: below 1e-18
        RatioTestFeed tiny = new RatioTestFeed(18);
        tiny.set(1, T0);
        RatioGuard g = new RatioGuard(tiny, btc, "tiny");
        vm.expectRevert(RatioGuard.RatioZero.selector);
        g.latestRoundData();
    }

    // =========================================================
    //  Constructor checks
    // =========================================================

    function test_constructor_zeroFeed_refused() public {
        vm.expectRevert(RatioGuard.BadFeeds.selector);
        new RatioGuard(AggregatorV3Interface(address(0)), btc, "x");
        vm.expectRevert(RatioGuard.BadFeeds.selector);
        new RatioGuard(eth, AggregatorV3Interface(address(0)), "x");
    }

    function test_constructor_sameFeedTwice_refused() public {
        vm.expectRevert(RatioGuard.BadFeeds.selector);
        new RatioGuard(btc, btc, "x");
    }

    function test_constructor_emptyDescription_refused() public {
        vm.expectRevert(RatioGuard.EmptyDescription.selector);
        new RatioGuard(eth, btc, "");
    }

    // =========================================================
    //  With the unchanged GuardedRelayFeed
    // =========================================================

    function _relay(RatioGuard g, uint16 bandBps) internal returns (GuardedRelayFeed) {
        return new GuardedRelayFeed(owner, pusher, g, bandBps, "Matchup relay ETH / BTC");
    }

    function test_relay_takes18DecimalsFromGuard() public {
        GuardedRelayFeed r = _relay(ethBtc, 250);
        assertEq(r.decimals(), 18);
    }

    function test_relay_acceptsRatioInsideBand() public {
        GuardedRelayFeed r = _relay(ethBtc, 250);       // 2.5%
        vm.prank(pusher);
        r.setPrice(3.07e16);                             // 0.0307: +2.33%, inside
        (, int256 a, , , ) = r.latestRoundData();
        assertEq(a, 3.07e16);
        vm.prank(pusher);
        r.setPrice(3.075e16);                            // exactly +2.5%: inside (edge)
    }

    function test_relay_refusesRatioOutsideBand() public {
        GuardedRelayFeed r = _relay(ethBtc, 250);
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.OutsideBand.selector, int256(3.075e16 + 1), int256(3e16), uint16(250)));
        r.setPrice(3.075e16 + 1);                        // one unit over +2.5%
    }

    function test_relay_refusesWhenChainlinkNegative() public {
        GuardedRelayFeed r = _relay(ethBtc, 250);
        btc.set(-1, T0);
        vm.prank(pusher);
        vm.expectRevert(GuardedRelayFeed.GuardUnavailable.selector);
        r.setPrice(3e16);
    }

    function test_relay_refusesWhenOneChainlinkFeedStale() public {
        GuardedRelayFeed r = _relay(ethBtc, 250);
        uint256 maxAge = r.MAX_GUARD_AGE();              // 26 hours
        // ETH fresh, BTC exactly 26 h old: still accepted
        btc.set(100_000e8, T0 - maxAge);
        vm.prank(pusher);
        r.setPrice(3e16);
        // BTC one second older: refused, although ETH is fresh
        btc.set(100_000e8, T0 - maxAge - 1);
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.GuardStale.selector, T0 - maxAge - 1, maxAge));
        r.setPrice(3e16);
    }

    function test_relay_refusesWhenNumeratorStale() public {
        GuardedRelayFeed r = _relay(solBtc, 250);
        uint256 maxAge = r.MAX_GUARD_AGE();
        sol.set(150e8, T0 - maxAge - 1);
        vm.prank(pusher);
        vm.expectRevert(abi.encodeWithSelector(GuardedRelayFeed.GuardStale.selector, T0 - maxAge - 1, maxAge));
        r.setPrice(15e14);
    }

    function test_relay_refusesWhenChainlinkDown() public {
        GuardedRelayFeed r = _relay(ethBtc, 250);
        eth.setBroken(true);
        vm.prank(pusher);
        vm.expectRevert(GuardedRelayFeed.GuardUnavailable.selector);
        r.setPrice(3e16);
    }
}
