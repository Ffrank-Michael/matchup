// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  TEST ONLY – MockUSDC
//
//  A minimal ERC-20 with 6 decimals, used ONLY in tests.
//  It is NOT deployed to any live network.
//  It mimics Arc USDC (6 decimals) so calling tests can run
//  without a real token.
// =============================================================

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  MockUSDC
/// @notice TEST ONLY – minimal 6-decimal ERC-20 for Foundry tests.
///         Anyone can call mint() to give themselves tokens.
///         Do not use in production.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin", "USDC") {}

    /// @notice Returns 6, matching real Arc USDC.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint `amount` tokens to `to`. No access control –
    ///         tests call this freely to fund player wallets.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
