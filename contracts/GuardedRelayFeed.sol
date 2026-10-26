// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Kairo Markets – GuardedRelayFeed
//
//  A Chainlink AggregatorV3Interface implementation for Arc mainnet.
//  A trusted pusher submits high-frequency prices (e.g. from Bitfinex)
//  and the contract rejects any price that deviates more than `bandBps`
//  basis points from the live Chainlink "guard" feed.
//
//  One GuardedRelayFeed is deployed per coin (BTC, ETH, SOL).
//
//  TRUST MODEL (NatSpec repeated in the contract below):
//  "The pusher can choose any price inside the band around Chainlink's
//   latest answer.  The guard stops a wrong or hacked price far from
//   the market; it does not make the price trustless."
//
//  Design points:
//  - guard and bandBps are immutable: nobody, including the owner,
//    can loosen the guard after deployment.
//  - Timestamps are always block.timestamp; no function accepts one.
//  - Round IDs: (1 << 64) | roundInPhase, fixed at phase 1.
//  - setPusher() is the only owner action besides two-step transfer.
//  - renounceOwnership() is permanently disabled.
// =============================================================

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AggregatorV3Interface}  from "./interfaces/AggregatorV3Interface.sol";

/// @title  GuardedRelayFeed
/// @notice A Chainlink-compatible price feed for Kairo Markets on Arc mainnet.
///         A trusted pusher supplies high-frequency prices (e.g. Bitfinex);
///         every submission is validated against a live Chainlink guard feed.
///
/// @dev    The pusher can choose any price inside the band around Chainlink's
///         latest answer.  The guard stops a wrong or hacked price far from
///         the market; it does not make the price trustless.
contract GuardedRelayFeed is AggregatorV3Interface, Ownable2Step {

    // =========================================================
    //  Constants
    // =========================================================

    /// @notice Maximum age of the guard feed's latest answer before
    ///         setPrice() rejects it as stale.  26 hours covers
    ///         weekends and brief Chainlink outages without being
    ///         so wide that a stale price slips through unnoticed.
    uint256 public constant MAX_GUARD_AGE = 26 hours;

    // =========================================================
    //  Immutables  (set once in the constructor, never changed)
    // =========================================================

    /// @notice Chainlink guard feed.  Every pusher submission is
    ///         cross-checked against this feed's latest answer.
    ///         Immutable so nobody can replace the guard later.
    AggregatorV3Interface public immutable guard;

    /// @notice Maximum deviation from the guard answer, in basis
    ///         points (1 bp = 0.01 %).  Immutable: the guard can
    ///         never be loosened after deployment.
    uint16 public immutable bandBps;

    /// @notice Decimal places for all prices returned by this feed.
    ///         Copied from guard.decimals() at deploy time.
    uint8 public immutable override decimals;

    // =========================================================
    //  Mutable state
    // =========================================================

    /// @notice Address allowed to call setPrice().
    ///         Changed by the owner via setPusher().
    address public pusher;

    /// @notice Human-readable feed label, e.g. "Kairo relay BTC/USD".
    ///         Set once in the constructor; never changed.
    string private _description;

    // ---- Round storage (phase fixed at 1) -------------------

    struct RoundData {
        int256  answer;
        uint256 startedAt;   // = updatedAt = block.timestamp at push
        uint256 updatedAt;
    }

    // roundId => data; only valid roundIds are written
    mapping(uint80 => RoundData) private _rounds;

    // Latest round id (0 = no data yet)
    uint80 private _latestRoundId;

    // How many pushes have been made (round-in-phase counter)
    uint80 private _roundInPhase;

    // =========================================================
    //  Custom errors
    // =========================================================

    /// @notice Caller is not the designated pusher.
    error NotPusher(address caller, address expectedPusher);

    /// @notice setPrice() called with answer <= 0.
    error NonPositiveAnswer(int256 answer);

    /// @notice Guard feed's latestRoundData() reverted.
    ///         Cannot validate the price; push is blocked.
    error GuardUnavailable();

    /// @notice Guard feed returned answer <= 0 or updatedAt == 0.
    error GuardAnswerInvalid(int256 guardAnswer, uint256 updatedAt);

    /// @notice Guard feed's last update is older than MAX_GUARD_AGE.
    error GuardStale(uint256 updatedAt, uint256 maxAge);

    /// @notice Pushed answer is outside the allowed band.
    /// @param answer      The price the pusher tried to submit.
    /// @param guardAnswer The current Chainlink reference price.
    /// @param bandBps_    The maximum deviation in basis points.
    error OutsideBand(int256 answer, int256 guardAnswer, uint16 bandBps_);

    /// @notice setPusher() called with address(0).
    error ZeroPusher();

    /// @notice renounceOwnership() is permanently disabled.
    ///         Losing ownership would make setPusher() inaccessible.
    error RenounceOwnershipDisabled();

    // =========================================================
    //  Events
    // =========================================================

    /// @notice Emitted on every successful setPrice() call.
    /// @param roundId      The new Chainlink-style round ID.
    /// @param answer       The price that was stored.
    /// @param guardAnswer  The Chainlink guard price at push time.
    /// @param updatedAt    block.timestamp of the push.
    event PriceRelayed(
        uint80  indexed roundId,
        int256          answer,
        int256          guardAnswer,
        uint256         updatedAt
    );

    /// @notice Emitted when the owner changes the pusher address.
    /// @param oldPusher  Previous pusher (may be address(0) if first set).
    /// @param newPusher  New pusher.
    event PusherChanged(address indexed oldPusher, address indexed newPusher);

    // =========================================================
    //  Constructor
    // =========================================================

    /// @notice Deploy a GuardedRelayFeed.
    ///
    /// @param owner_        Initial owner (two-step Ownable2Step).
    ///                      Must not be address(0) (OZ enforces this).
    /// @param pusher_       Address allowed to push prices.
    ///                      Must not be address(0).
    /// @param guard_        Chainlink feed used as the sanity reference.
    ///                      Must not be address(0) and must report
    ///                      nonzero decimals.
    /// @param bandBps_      Maximum deviation from the guard in basis
    ///                      points.  Must be 1..1000 (0.01 %..10 %).
    ///                      Immutable after deployment.
    /// @param description_  Human-readable label.
    ///                      Must start with "Kairo relay " and be non-empty.
    constructor(
        address               owner_,
        address               pusher_,
        AggregatorV3Interface guard_,
        uint16                bandBps_,
        string memory         description_
    ) Ownable(owner_) {
        // ── Validate pusher ──────────────────────────────────
        if (pusher_ == address(0)) revert ZeroPusher();

        // ── Validate guard ────────────────────────────────────
        if (address(guard_) == address(0)) revert GuardUnavailable();

        // ── Validate bandBps ──────────────────────────────────
        // 0 would mean no price is ever accepted (division by zero risk);
        // > 1000 is 10 % which is too wide to be a meaningful safety guard.
        require(bandBps_ > 0 && bandBps_ <= 1000,
            "bandBps must be 1..1000");

        // ── Validate description ──────────────────────────────
        bytes memory db = bytes(description_);
        require(db.length > 0, "empty description");
        require(_startsWith(description_, "Kairo relay "),
            "description must start with 'Kairo relay '");

        // ── Read decimals from guard (must be nonzero) ─────────
        uint8 dec = guard_.decimals();
        require(dec > 0, "guard decimals must be nonzero");

        // ── Store ──────────────────────────────────────────────
        pusher       = pusher_;
        guard        = guard_;
        bandBps      = bandBps_;
        decimals     = dec;       // immutable
        _description = description_;

        emit PusherChanged(address(0), pusher_);
    }

    // =========================================================
    //  Pusher function: setPrice
    // =========================================================

    /// @notice Push a new price.
    ///         Only the designated pusher can call this.
    ///
    ///         Validation order (each has its own error):
    ///           1. caller == pusher           NotPusher
    ///           2. answer > 0                 NonPositiveAnswer
    ///           3. guard call succeeds        GuardUnavailable
    ///           4. guardAnswer > 0 and
    ///              updatedAt != 0             GuardAnswerInvalid
    ///           5. updatedAt <= block.timestamp
    ///              AND block.timestamp - updatedAt <= MAX_GUARD_AGE
    ///                                        GuardStale
    ///           6. |answer - guardAnswer| * 10_000 <= guardAnswer * bandBps
    ///                                        OutsideBand
    ///
    ///         On success: stores the round, emits PriceRelayed.
    ///
    /// @param answer  The new price (must be positive, in the same
    ///                decimal scale as the guard feed).
    function setPrice(int256 answer) external {
        // ── 1. Only the pusher ───────────────────────────────
        if (msg.sender != pusher) revert NotPusher(msg.sender, pusher);

        // ── 2. Positive answer ───────────────────────────────
        if (answer <= 0) revert NonPositiveAnswer(answer);

        // ── 3. Read guard feed (may revert) ──────────────────
        int256  guardAnswer;
        uint256 guardUpdatedAt;
        {
            // try/catch so a reverting guard gives a clear error,
            // not a confusing bubbled-up revert from an unknown contract.
            bool ok;
            (ok, guardAnswer, guardUpdatedAt) = _readGuard();
            if (!ok) revert GuardUnavailable();
        }

        // ── 4. Guard answer must be positive, timestamped, and within
        //      a realistic price range.
        //
        //      The uint128 cap (≈ 3.4 × 10^38) is far above any real price
        //      in any decimal scale.  It guarantees uGuard * bandBps
        //      (≤ 3.4e38 * 1000 ≈ 3.4e41) stays below uint256.max (≈ 1.16e77),
        //      so the band multiplication below can NEVER overflow and the
        //      overflow-skip branch is not needed.
        //      A guard answer this large signals a broken or malicious feed,
        //      so we reject it explicitly rather than silently disabling the guard.
        if (guardAnswer <= 0 || guardUpdatedAt == 0) {
            revert GuardAnswerInvalid(guardAnswer, guardUpdatedAt);
        }
        if (uint256(guardAnswer) > type(uint128).max) {
            // Guard answer is unrealistically large — treat as invalid.
            revert GuardAnswerInvalid(guardAnswer, guardUpdatedAt);
        }

        // ── 5. Guard must not be stale ────────────────────────
        // Also reject a future updatedAt (clock skew or malicious feed).
        // "exactly MAX_GUARD_AGE old" is accepted (<=); one second more is not.
        if (guardUpdatedAt > block.timestamp ||
            block.timestamp - guardUpdatedAt > MAX_GUARD_AGE) {
            revert GuardStale(guardUpdatedAt, MAX_GUARD_AGE);
        }

        // ── 6. Band check ─────────────────────────────────────
        // Condition: |answer - guardAnswer| <= guardAnswer * bandBps / 10_000
        //
        // answer > 0 and guardAnswer > 0 (checked above), so casts are safe.
        // guardAnswer <= uint128.max (checked above), so:
        //   uGuard * bandBps <= uint128.max * 1000 ≈ 3.4e41
        // which is well below uint256.max ≈ 1.16e77 — no overflow possible.
        uint256 uAnswer = uint256(answer);
        uint256 uGuard  = uint256(guardAnswer);
        uint256 diff    = uAnswer > uGuard ? uAnswer - uGuard : uGuard - uAnswer;
        uint256 allowed = uGuard * uint256(bandBps) / 10_000;
        if (diff > allowed) revert OutsideBand(answer, guardAnswer, bandBps);

        // ── Store round ───────────────────────────────────────
        _roundInPhase += 1;
        // Phase is fixed at 1; roundInPhase increments every push.
        uint80 newId = (uint80(1) << 64) | _roundInPhase;
        uint256 ts   = block.timestamp;
        _rounds[newId] = RoundData({
            answer:    answer,
            startedAt: ts,
            updatedAt: ts
        });
        _latestRoundId = newId;

        emit PriceRelayed(newId, answer, guardAnswer, ts);
    }

    // =========================================================
    //  Owner function: setPusher
    // =========================================================

    /// @notice Change the address that is allowed to call setPrice().
    ///         Only the owner can do this.
    ///         This is the ONLY action the owner can take that affects
    ///         price data; the guard and band are immutable.
    ///
    /// @param newPusher  New pusher address. Must not be address(0).
    function setPusher(address newPusher) external onlyOwner {
        if (newPusher == address(0)) revert ZeroPusher();
        address old = pusher;
        pusher = newPusher;
        emit PusherChanged(old, newPusher);
    }

    // =========================================================
    //  Ownership safety
    // =========================================================

    /// @notice Permanently disabled.
    ///         Losing ownership would make setPusher() inaccessible,
    ///         locking the feed into a pusher that may go offline.
    function renounceOwnership() public pure override {
        revert RenounceOwnershipDisabled();
    }

    // =========================================================
    //  AggregatorV3Interface – metadata
    // =========================================================

    /// @inheritdoc AggregatorV3Interface
    // decimals() is immutable public; the compiler generates the getter.

    /// @inheritdoc AggregatorV3Interface
    function description() external view override returns (string memory) {
        return _description;
    }

    /// @inheritdoc AggregatorV3Interface
    function version() external pure override returns (uint256) {
        return 1;
    }

    // =========================================================
    //  AggregatorV3Interface – price reads
    // =========================================================

    /// @inheritdoc AggregatorV3Interface
    /// @dev Reverts with "No data present" for unknown round IDs,
    ///      matching Chainlink's behaviour.
    function getRoundData(uint80 _roundId)
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
        RoundData storage d = _rounds[_roundId];
        require(d.updatedAt != 0, "No data present");
        roundId         = _roundId;
        answer          = d.answer;
        startedAt       = d.startedAt;
        updatedAt       = d.updatedAt;
        answeredInRound = _roundId;
    }

    /// @inheritdoc AggregatorV3Interface
    /// @dev Reverts with "No data present" if no price has been pushed yet.
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
        require(_latestRoundId != 0, "No data present");
        RoundData storage d = _rounds[_latestRoundId];
        roundId         = _latestRoundId;
        answer          = d.answer;
        startedAt       = d.startedAt;
        updatedAt       = d.updatedAt;
        answeredInRound = _latestRoundId;
    }

    // =========================================================
    //  Internal helpers
    // =========================================================

    /// @dev Call guard.latestRoundData() with try/catch.
    ///      Returns (true, answer, updatedAt) on success, (false, 0, 0) on revert.
    function _readGuard()
        internal
        view
        returns (bool ok, int256 ans, uint256 upAt)
    {
        try guard.latestRoundData() returns (
            uint80, int256 a, uint256, uint256 at, uint80
        ) {
            return (true, a, at);
        } catch {
            return (false, 0, 0);
        }
    }

    /// @dev Returns true if `str` starts with `prefix`.
    function _startsWith(string memory str, string memory prefix)
        internal
        pure
        returns (bool)
    {
        bytes memory s = bytes(str);
        bytes memory p = bytes(prefix);
        if (s.length < p.length) return false;
        for (uint256 i = 0; i < p.length; i++) {
            if (s[i] != p[i]) return false;
        }
        return true;
    }
}
