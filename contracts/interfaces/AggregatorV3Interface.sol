// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Standard Chainlink AggregatorV3Interface
//  Source: https://github.com/smartcontractkit/chainlink/blob/develop/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol
//
//  On Arc testnet we use a mock that implements this exact
//  interface so the prediction contract does NOT need to know
//  whether the feed is real or fake.
// =============================================================

/// @title  AggregatorV3Interface
/// @notice The five functions every Chainlink price feed exposes.
///         We copy the interface here so we don't need the full
///         Chainlink npm package as a dependency.
interface AggregatorV3Interface {
    // ---------------------------------------------------------
    //  Metadata
    // ---------------------------------------------------------

    /// @notice How many decimal places the price has.
    ///         BTC/USD on mainnet returns 8, meaning $60000 is
    ///         stored as 6_000_000_000_000.
    function decimals() external view returns (uint8);

    /// @notice Human-readable label for the feed, e.g. "BTC / USD".
    function description() external view returns (string memory);

    /// @notice Chainlink aggregator version number (not a price).
    function version() external view returns (uint256);

    // ---------------------------------------------------------
    //  Price reads
    // ---------------------------------------------------------

    /// @notice Fetch any historical round by its round ID.
    /// @param  _roundId   The round ID to look up.
    /// @return roundId    Same as _roundId (echoed back).
    /// @return answer     The price recorded for that round.
    /// @return startedAt  Timestamp when the round started (may be 0).
    /// @return updatedAt  Timestamp when the answer was written on-chain.
    ///                    This is the value the prediction contract uses
    ///                    to place an update inside a time window.
    /// @return answeredInRound  Round in which the answer was computed
    ///                          (relevant for detecting stale feeds).
    function getRoundData(uint80 _roundId)
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    /// @notice Fetch the most recent round.
    ///         Same return layout as getRoundData.
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
