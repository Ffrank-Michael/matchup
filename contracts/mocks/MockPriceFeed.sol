// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ================================================================
//  ████████╗███████╗███████╗████████╗     ██████╗ ███╗   ██╗██╗  ██╗   ██╗
//  ╚══██╔══╝██╔════╝██╔════╝╚══██╔══╝    ██╔═══██╗████╗  ██║██║  ╚██╗ ██╔╝
//     ██║   █████╗  ███████╗   ██║       ██║   ██║██╔██╗ ██║██║   ╚████╔╝
//     ██║   ██╔══╝  ╚════██║   ██║       ██║   ██║██║╚██╗██║██║    ╚██╔╝
//     ██║   ███████╗███████║   ██║       ╚██████╔╝██║ ╚████║███████╗██║
//     ╚═╝   ╚══════╝╚══════╝   ╚═╝        ╚═════╝ ╚═╝  ╚═══╝╚══════╝╚═╝
//
//  MockPriceFeed – TEST PRICES - NOT REAL DATA
//
//  THIS CONTRACT IS FOR TESTING ONLY.
//  It will be deployed to Arc TESTNET so settlement tests work without
//  a real Chainlink feed.  It MUST NEVER be used on mainnet as a real
//  price source.
//
//  Key design points:
//  - description() ALWAYS starts with "TEST PRICES - NOT REAL DATA"
//  - Only the owner can call setPrice() or startNewPhase()
//  - The owner passes a price VALUE only; timestamps are ALWAYS
//    block.timestamp.  There is no function that accepts a timestamp,
//    so prices can never be backdated.
//  - Round IDs follow Chainlink's scheme: (phaseId << 64) | roundInPhase
//    starting at phase 1 / round 1, incrementing by 1 per update.
//  - Timestamps only go up; IDs only go up.
// ================================================================

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @title  MockPriceFeed
/// @notice TEST PRICES - NOT REAL DATA.
///         A minimal Chainlink AggregatorV3Interface implementation
///         for Matchup Arc testnet integration tests.
///         Deploy this on testnet only; never use as a real price source.
contract MockPriceFeed is AggregatorV3Interface, Ownable {

    // ----------------------------------------------------------------
    //  Stored data for each update
    // ----------------------------------------------------------------

    struct RoundData {
        int256  answer;
        uint256 startedAt;  // block.timestamp when the update was written
        uint256 updatedAt;  // same as startedAt (set together)
    }

    // roundId => data; only valid roundIds are written
    mapping(uint80 => RoundData) private _rounds;

    // The latest round ID that has been written (0 = nothing yet)
    uint80 private _latestRoundId;

    // Feed metadata set at construction
    uint8   private _decimals;
    string  private _description;
    // version is fixed at 1 for simplicity
    uint256 private constant _VERSION = 1;

    // Current Chainlink phase (starts at 1; bumped by startNewPhase())
    // Phase is stored as uint80 so that (phase << 64) fits in uint80.
    uint80 private _phase;

    // How many updates have been made in the current phase
    uint80 private _roundInPhase;

    // ----------------------------------------------------------------
    //  Constructor
    // ----------------------------------------------------------------

    /// @notice Deploy the mock feed.
    ///         description_ MUST start with "TEST PRICES - NOT REAL DATA";
    ///         the constructor enforces this so it cannot be deployed
    ///         without the warning.
    /// @param owner_        Address that will own this contract (can set prices).
    /// @param decimals_     Decimal places for prices (e.g. 8 for BTC/USD).
    /// @param description_  Human-readable name. Must start with
    ///                      "TEST PRICES - NOT REAL DATA".
    constructor(
        address owner_,
        uint8   decimals_,
        string  memory description_
    ) Ownable(owner_) {
        // Enforce the warning prefix so nobody accidentally deploys this
        // without knowing it is fake data.
        require(
            _startsWith(description_, "TEST PRICES - NOT REAL DATA"),
            "description must start with TEST PRICES - NOT REAL DATA"
        );
        _decimals    = decimals_;
        _description = description_;
        _phase       = 1;   // start at phase 1
        _roundInPhase = 0;  // no updates yet; first setPrice() makes round 1
    }

    // ----------------------------------------------------------------
    //  Owner functions
    // ----------------------------------------------------------------

    /// @notice Record a new price update.  The timestamp is ALWAYS
    ///         block.timestamp; no timestamp parameter exists.
    ///         Any int256 price is accepted (including 0 and negative)
    ///         so refund edge-cases can be tested.
    /// @param answer  The new price value.
    function setPrice(int256 answer) external onlyOwner {
        // Increment round-in-phase before writing so the first call
        // produces roundInPhase == 1.
        _roundInPhase += 1;

        // Chainlink round ID: (phaseId << 64) | roundInPhase
        // Both fields fit in uint80: phase < 2^16 and roundInPhase < 2^64.
        uint80 newId = (_phase << 64) | _roundInPhase;

        // Timestamps are always block.timestamp; the owner cannot supply one.
        uint256 ts = block.timestamp;
        _rounds[newId] = RoundData({
            answer:    answer,
            startedAt: ts,
            updatedAt: ts
        });
        _latestRoundId = newId;
    }

    /// @notice Bump the phase ID (simulates a Chainlink feed upgrade).
    ///         The next call to setPrice() will produce ID
    ///         ((phase+1) << 64) | 1.
    ///         Only the owner can do this (matches real Chainlink behaviour).
    function startNewPhase() external onlyOwner {
        _phase        += 1;
        _roundInPhase  = 0; // next setPrice() will set this to 1
    }

    // ----------------------------------------------------------------
    //  AggregatorV3Interface – metadata
    // ----------------------------------------------------------------

    /// @inheritdoc AggregatorV3Interface
    function decimals() external view override returns (uint8) {
        return _decimals;
    }

    /// @inheritdoc AggregatorV3Interface
    function description() external view override returns (string memory) {
        return _description;
    }

    /// @inheritdoc AggregatorV3Interface
    function version() external pure override returns (uint256) {
        return _VERSION;
    }

    // ----------------------------------------------------------------
    //  AggregatorV3Interface – price reads
    // ----------------------------------------------------------------

    /// @inheritdoc AggregatorV3Interface
    /// @dev Reverts with "No data present" if the round ID was never written,
    ///      matching Chainlink's own behaviour.
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
        // updatedAt == 0 means this slot was never written.
        require(d.updatedAt != 0, "No data present");

        roundId         = _roundId;
        answer          = d.answer;
        startedAt       = d.startedAt;
        updatedAt       = d.updatedAt;
        answeredInRound = _roundId; // simple: always the same round
    }

    /// @inheritdoc AggregatorV3Interface
    /// @dev Reverts with "No data present" if no update has been made yet.
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

    // ----------------------------------------------------------------
    //  Internal helpers
    // ----------------------------------------------------------------

    /// @dev Returns true if `str` starts with `prefix`.
    ///      Used only in the constructor to validate the description.
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
