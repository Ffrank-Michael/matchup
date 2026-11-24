// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  RatioGuard
//
//  A read-only "guard" for a coin-vs-coin relay (for example
//  ETH / BTC or SOL / BTC).  It reads two Chainlink USD feeds and
//  answers with their ratio, so an unchanged GuardedRelayFeed can
//  check the pusher's ratio against Chainlink:
//
//      ratio = numerator / denominator     (e.g. ETH/USD / BTC/USD)
//
//  It is NOT a price feed for the arena.  It has no history:
//  getRoundData() always reverts.  If it were ever set as a market's
//  feedA by mistake, no round of that market could settle UP or
//  DOWN: every round would end as a refund (OneSided, NoUpdate or
//  Timeout).  No result, but no money lost.
//
//  What latestRoundData() returns:
//    answer     the ratio with 18 decimals, rounded down
//    updatedAt  the OLDER of the two Chainlink update times, so the
//               relay's 26-hour staleness check applies to whichever
//               feed is more out of date
//    roundId, answeredInRound  always 0 (there are no rounds)
//    startedAt  same as updatedAt
//
//  It refuses (reverts) when:
//    - either Chainlink feed reverts (latestRoundData or decimals)
//    - either feed's decimals differ from the ones read at deploy
//    - either answer is 0 or less
//    - either updatedAt is 0 or in the future
//    - either updatedAt is older than that feed's own maxAge
//      (set at deploy: the feed's heartbeat plus a margin; tighter
//      than the relay's 26 hours)
//    - either answer is above uint128.max (a broken feed)
//    - the ratio rounds down to 0, or is above uint128.max
//  GuardedRelayFeed calls latestRoundData() inside try/catch, so any
//  of these makes setPrice() revert with GuardUnavailable: nothing is
//  pushed and the round refunds.
//
//  At deploy it also checks that each feed's description() is the
//  one the deployer expects (e.g. "ETH / USD" on top, "BTC / USD"
//  underneath), so the two feeds cannot be swapped by mistake.
//
//  No owner, no setters, nothing stored except the two feed
//  addresses, their decimals, their age limits and the description.
// =============================================================

import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title  RatioGuard
/// @notice The ratio of two Chainlink USD feeds, with 18 decimals, in
///         the Chainlink interface. Used only as the guard of a
///         coin-vs-coin GuardedRelayFeed.
/// @dev    Only decimals() and latestRoundData() carry data;
///         getRoundData() always reverts (no history).
contract RatioGuard is AggregatorV3Interface {

    // =========================================================
    //  Constants
    // =========================================================

    /// @notice Every answer has 18 decimals (ETH/BTC is about 0.03,
    ///         which 8 decimals would make too coarse).
    uint8 public constant RATIO_DECIMALS = 18;

    /// @notice Largest decimals accepted from a Chainlink feed.
    ///         Keeps 10 ** (18 + decimals) within 10 ** 36, so the
    ///         maths below can never overflow (see _ratio).
    uint8 public constant MAX_FEED_DECIMALS = 18;

    /// @notice Largest per-feed age limit accepted at deploy. The same
    ///         as GuardedRelayFeed.MAX_GUARD_AGE: a looser limit here
    ///         would never matter, because the relay refuses anyway.
    uint32 public constant MAX_FEED_AGE = 26 hours;

    // =========================================================
    //  Immutables
    // =========================================================

    /// @notice The coin on top, e.g. Chainlink ETH / USD.
    AggregatorV3Interface public immutable numerator;

    /// @notice The coin underneath, e.g. Chainlink BTC / USD.
    AggregatorV3Interface public immutable denominator;

    /// @notice numerator.decimals(), read at deploy time and checked again on every read.
    uint8 public immutable numeratorDecimals;

    /// @notice denominator.decimals(), read at deploy time and checked again on every read.
    uint8 public immutable denominatorDecimals;

    /// @notice Oldest numerator answer accepted, in seconds (its heartbeat plus a margin).
    uint32 public immutable numeratorMaxAge;

    /// @notice Oldest denominator answer accepted, in seconds (its heartbeat plus a margin).
    uint32 public immutable denominatorMaxAge;

    /// @dev Human-readable label, e.g.
    ///      "Matchup ratio guard ETH / BTC (Chainlink ETH/USD / BTC/USD)".
    string private _description;

    // =========================================================
    //  Errors
    // =========================================================

    /// @notice A feed address is zero, or both feeds are the same.
    error BadFeeds();

    /// @notice A feed reports more than MAX_FEED_DECIMALS decimals.
    error TooManyDecimals(address feed, uint8 decimals);

    /// @notice The description is empty.
    error EmptyDescription();

    /// @notice A per-feed age limit is 0 or above MAX_FEED_AGE.
    error BadMaxAge(address feed, uint256 maxAge);

    /// @notice An expected feed label is empty, or both labels are the same.
    error BadLabels();

    /// @notice A feed's description() is not the label the deployer expects
    ///         (wrong feed, or the two feeds swapped).
    error WrongFeed(address feed, string expected, string actual);

    /// @notice A Chainlink feed's latestRoundData() or decimals() reverted.
    error FeedUnavailable(address feed);

    /// @notice A feed's decimals() no longer match the ones read at deploy.
    error DecimalsChanged(address feed, uint8 atDeploy, uint8 now_);

    /// @notice A Chainlink answer is 0 or less.
    error NonPositiveAnswer(address feed, int256 answer);

    /// @notice A Chainlink answer is above uint128.max (a broken feed).
    error AnswerTooLarge(address feed, int256 answer);

    /// @notice A Chainlink updatedAt is 0 or later than now.
    error BadUpdatedAt(address feed, uint256 updatedAt);

    /// @notice A Chainlink answer is older than that feed's maxAge.
    error StaleFeed(address feed, uint256 updatedAt, uint256 maxAge);

    /// @notice The ratio rounds down to 0 at 18 decimals.
    error RatioZero();

    /// @notice The ratio is above uint128.max.
    error RatioTooLarge(uint256 ratio);

    /// @notice getRoundData() is not supported: this guard has no history.
    error NoHistory();

    // =========================================================
    //  Constructor
    // =========================================================

    /// @param numerator_          Chainlink feed of the coin on top (e.g. ETH/USD).
    /// @param denominator_        Chainlink feed of the coin underneath (e.g. BTC/USD).
    /// @param numeratorMaxAge_    Oldest numerator answer accepted, seconds, 1..MAX_FEED_AGE.
    /// @param denominatorMaxAge_  Oldest denominator answer accepted, seconds, 1..MAX_FEED_AGE.
    /// @param numeratorLabel_     The numerator's expected description(), e.g. "ETH / USD".
    /// @param denominatorLabel_   The denominator's expected description(), e.g. "BTC / USD".
    /// @param description_        Label of this guard, not empty.
    constructor(
        AggregatorV3Interface numerator_,
        AggregatorV3Interface denominator_,
        uint32 numeratorMaxAge_,
        uint32 denominatorMaxAge_,
        string memory numeratorLabel_,
        string memory denominatorLabel_,
        string memory description_
    ) {
        if (address(numerator_) == address(0) ||
            address(denominator_) == address(0) ||
            address(numerator_) == address(denominator_)) revert BadFeeds();
        if (bytes(description_).length == 0) revert EmptyDescription();
        if (numeratorMaxAge_ == 0 || numeratorMaxAge_ > MAX_FEED_AGE) {
            revert BadMaxAge(address(numerator_), numeratorMaxAge_);
        }
        if (denominatorMaxAge_ == 0 || denominatorMaxAge_ > MAX_FEED_AGE) {
            revert BadMaxAge(address(denominator_), denominatorMaxAge_);
        }

        // The feeds must be the ones the deployer means, in that order.
        // Two different labels also stop two addresses of the same feed
        // (e.g. a proxy and its aggregator), which would give a ratio of 1.
        if (bytes(numeratorLabel_).length == 0 ||
            bytes(denominatorLabel_).length == 0 ||
            keccak256(bytes(numeratorLabel_)) == keccak256(bytes(denominatorLabel_))) revert BadLabels();
        _checkLabel(numerator_, numeratorLabel_);
        _checkLabel(denominator_, denominatorLabel_);

        uint8 dn = numerator_.decimals();
        uint8 dd = denominator_.decimals();
        if (dn > MAX_FEED_DECIMALS) revert TooManyDecimals(address(numerator_), dn);
        if (dd > MAX_FEED_DECIMALS) revert TooManyDecimals(address(denominator_), dd);

        numerator           = numerator_;
        denominator         = denominator_;
        numeratorDecimals   = dn;
        denominatorDecimals = dd;
        numeratorMaxAge     = numeratorMaxAge_;
        denominatorMaxAge   = denominatorMaxAge_;
        _description        = description_;
    }

    // =========================================================
    //  AggregatorV3Interface
    // =========================================================

    /// @inheritdoc AggregatorV3Interface
    function decimals() external pure override returns (uint8) {
        return RATIO_DECIMALS;
    }

    /// @inheritdoc AggregatorV3Interface
    function description() external view override returns (string memory) {
        return _description;
    }

    /// @inheritdoc AggregatorV3Interface
    function version() external pure override returns (uint256) {
        return 2;
    }

    /// @notice Always reverts: this guard has no history.
    function getRoundData(uint80)
        external
        pure
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        revert NoHistory();
    }

    /// @notice The current ratio (18 decimals) and the older of the two
    ///         Chainlink update times. Reverts instead of returning a
    ///         number it cannot vouch for (see the list at the top).
    function latestRoundData()
        external
        view
        override
        returns (
            uint80  roundId,
            int256  answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80  answeredInRound
        )
    {
        (uint256 a, uint256 atA) = _read(numerator, numeratorDecimals, numeratorMaxAge);
        (uint256 b, uint256 atB) = _read(denominator, denominatorDecimals, denominatorMaxAge);

        uint256 ratio = _ratio(a, b);
        if (ratio == 0) revert RatioZero();
        if (ratio > type(uint128).max) revert RatioTooLarge(ratio);

        updatedAt       = atA < atB ? atA : atB; // the older one
        startedAt       = updatedAt;
        answer          = int256(ratio);         // safe: ratio <= uint128.max
        roundId         = 0;
        answeredInRound = 0;
    }

    // =========================================================
    //  Internal
    // =========================================================

    /// @dev One Chainlink feed's latest answer and time, checked.
    function _read(AggregatorV3Interface feed, uint8 decimalsAtDeploy, uint256 maxAge)
        internal
        view
        returns (uint256 answer, uint256 updatedAt)
    {
        // The scale must still be the one the ratio maths was set up for:
        // a proxy pointed at an aggregator with other decimals would
        // otherwise give a ratio off by a power of ten, with no error.
        try feed.decimals() returns (uint8 d) {
            if (d != decimalsAtDeploy) revert DecimalsChanged(address(feed), decimalsAtDeploy, d);
        } catch {
            revert FeedUnavailable(address(feed));
        }

        int256 ans;
        try feed.latestRoundData() returns (uint80, int256 a, uint256, uint256 at, uint80) {
            ans = a;
            updatedAt = at;
        } catch {
            revert FeedUnavailable(address(feed));
        }
        if (ans <= 0) revert NonPositiveAnswer(address(feed), ans);
        if (uint256(ans) > type(uint128).max) revert AnswerTooLarge(address(feed), ans);
        if (updatedAt == 0 || updatedAt > block.timestamp) revert BadUpdatedAt(address(feed), updatedAt);
        // "exactly maxAge old" is accepted; one second more is not (the relay's own rule, per feed).
        if (block.timestamp - updatedAt > maxAge) revert StaleFeed(address(feed), updatedAt, maxAge);
        answer = uint256(ans);
    }

    /// @dev ratio = (a / 10^dn) / (b / 10^dd) * 10^18
    ///            = a * 10^(18 + dd) / (b * 10^dn), rounded down.
    ///      No overflow: a, b <= uint128.max (< 3.5e38) and dn, dd <= 18,
    ///      so a * 10^(18 + dd) < 3.5e38 * 1e36 = 3.5e74 and
    ///      b * 10^dn < 3.5e56, both far below uint256.max (about 1.16e77).
    function _ratio(uint256 a, uint256 b) internal view returns (uint256) {
        uint256 top    = a * (10 ** (uint256(RATIO_DECIMALS) + denominatorDecimals));
        uint256 bottom = b * (10 ** uint256(numeratorDecimals));
        return top / bottom;
    }

    /// @dev Deploy-time check: feed.description() must equal `expected`.
    function _checkLabel(AggregatorV3Interface feed, string memory expected) private view {
        string memory actual = feed.description();
        if (keccak256(bytes(actual)) != keccak256(bytes(expected))) {
            revert WrongFeed(address(feed), expected, actual);
        }
    }
}
