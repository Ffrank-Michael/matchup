// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Matchup – PredictionArena tests (Steps 3 + 4)
//
//  Covers (step 3):
//   - createMarket: each failing input gets its own test
//   - onlyOwner guards on createMarket, setMarketPaused, withdrawFees
//   - The three production markets (BTC/USD, ETH/USD, SOL/USD)
//     with 1-hour rounds and a 10-minute variant
//   - lockTime / endTime / nextCallableRound at exact boundaries
//   - withdrawFees reverts when feesAccrued == 0 or amount too large
//   - pause toggling
//
//  Covers (step 4 – placeCall):
//   - UP/DOWN calls on each of the three production markets
//   - position and round totals correct; CallPlaced event emitted
//   - top-up same side adds; opposite side reverts WrongSide
//   - timing boundaries (lock-1, at lock, past rounds, future rounds)
//   - paused market reverts; unpause re-enables; existing positions untouched
//   - below minimum, zero, exactly minimum, uint128 overflow, no allowance,
//     insufficient balance, unknown market
//   - markets are independent
//   - fuzz: USDC balance == sum of all round totals after random calls
//   - owner cannot steal players' money via withdrawFees when feesAccrued == 0
//
//  We use a plain address (DUMMY_FEED) as the price feed – no mock
//  feed yet; that comes in step 5.
// =============================================================

import {Test, console} from "forge-std/Test.sol";
import {PredictionArena} from "../PredictionArena.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {MockUSDC} from "./MockUSDC.sol";

contract PredictionArenaTest is Test {
    // =========================================================
    //  Helpers / fixtures
    // =========================================================

    PredictionArena arena;
    MockUSDC        usdc;

    address owner   = makeAddr("owner");
    address alice   = makeAddr("alice");
    address bob     = makeAddr("bob");

    /// @dev A non-zero address we pretend is a price feed.
    ///      No mock needed until step 5.
    address constant DUMMY_FEED = address(0xFEED);

    /// @dev Minimum stake used for most markets: $0.10 in 6-decimal units.
    uint128 constant MIN_STAKE = 100_000; // $0.10

    /// @dev A convenient larger amount: $1.00.
    uint256 constant ONE_USDC = 1_000_000;

    // 1-hour market offsets (seconds past the unix epoch within each hour)
    uint32 constant OFFSET_BTC = 0;      // :00
    uint32 constant OFFSET_ETH = 1200;   // :20
    uint32 constant OFFSET_SOL = 2400;   // :40

    uint32 constant ROUND_HOUR   = 3600;
    uint32 constant ROUND_10_MIN = 600;

    // 10-minute market offsets
    uint32 constant OFFSET_10_0   = 0;
    uint32 constant OFFSET_10_180 = 180;
    uint32 constant OFFSET_10_360 = 360;

    function setUp() public {
        // Deploy MockUSDC (6-decimal ERC-20, test-only).
        usdc = new MockUSDC();

        // Deploy arena with the mock token and set owner.
        vm.prank(owner);
        arena = new PredictionArena(address(usdc), owner);
    }

    // =========================================================
    //  Calling helpers
    // =========================================================

    /// @dev Give `player` `amount` MockUSDC and approve the arena.
    function _fund(address player, uint256 amount) internal {
        usdc.mint(player, amount);
        vm.prank(player);
        usdc.approve(address(arena), amount);
    }

    /// @dev Create the three production markets and warp into round 1
    ///      (t = 1 so BTC offset=0 is already past, BTC next callable = 1).
    function _setupProductionMarkets() internal returns (uint256 btc, uint256 eth, uint256 sol) {
        btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        eth = _createMarket("ETH/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_ETH, MIN_STAKE);
        sol = _createMarket("SOL/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_SOL, MIN_STAKE);
        // t=1: BTC next=1, ETH next=0 (before offset 1200), SOL next=0 (before 2400)
        // Use t=3599 to be just before BTC round-1 lock; all three markets have a
        // callable round: BTC=1, ETH=1 (offset 1200 not reached → next=0 still before
        // offset). Use a dedicated warp per test instead for precision.
    }

    // =========================================================
    //  Helpers
    // =========================================================

    /// @dev Create one market as owner. Returns the new market ID (0-indexed).
    function _createMarket(
        string memory name,
        address feedA,
        uint32 roundLength,
        uint32 startOffset,
        uint128 minStake
    ) internal returns (uint256 id) {
        id = arena.marketCount();
        vm.prank(owner);
        arena.createMarket(name, feedA, address(0), roundLength, startOffset, minStake);
    }

    // =========================================================
    //  createMarket – validation failures
    // =========================================================

    function test_createMarket_revertIfFeedAZero() public {
        vm.prank(owner);
        vm.expectRevert(PredictionArena.FeedARequired.selector);
        arena.createMarket("BTC/USD", address(0), address(0), ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
    }

    function test_createMarket_revertIfRoundTooShort() public {
        // 4 minutes (240 s) is below the 5-minute minimum.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.RoundTooShort.selector,
                240,
                uint32(5 minutes)
            )
        );
        arena.createMarket("BTC/USD", DUMMY_FEED, address(0), 240, 0, MIN_STAKE);
    }

    function test_createMarket_revertIfOffsetEqualsRoundLength() public {
        // startOffset must be STRICTLY less than roundLength.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.OffsetNotLessThanRoundLength.selector,
                uint32(ROUND_HOUR),
                uint32(ROUND_HOUR)
            )
        );
        arena.createMarket("BTC/USD", DUMMY_FEED, address(0), ROUND_HOUR, ROUND_HOUR, MIN_STAKE);
    }

    function test_createMarket_revertIfOffsetGreaterThanRoundLength() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.OffsetNotLessThanRoundLength.selector,
                uint32(ROUND_HOUR + 1),
                uint32(ROUND_HOUR)
            )
        );
        arena.createMarket("BTC/USD", DUMMY_FEED, address(0), ROUND_HOUR, ROUND_HOUR + 1, MIN_STAKE);
    }

    function test_createMarket_revertIfMinStakeZero() public {
        vm.prank(owner);
        vm.expectRevert(PredictionArena.MinStakeMustBePositive.selector);
        arena.createMarket("BTC/USD", DUMMY_FEED, address(0), ROUND_HOUR, OFFSET_BTC, 0);
    }

    function test_createMarket_revertIfFeedBNonZero() public {
        // feedB must be address(0) until head-to-head markets are built.
        // Passing any non-zero address reverts with FeedBNotSupportedYet.
        address someFeed = address(0xB);
        vm.prank(owner);
        vm.expectRevert(PredictionArena.FeedBNotSupportedYet.selector);
        arena.createMarket("SOL/BTC", DUMMY_FEED, someFeed, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
    }

    // =========================================================
    //  createMarket – success & storage
    // =========================================================

    function test_createMarket_succeeds() public {
        uint256 id = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        assertEq(id, 0);
        assertEq(arena.marketCount(), 1);
        assertEq(arena.marketName(0), "BTC/USD");

        (
            address feedA,
            ,
            uint32 roundLength,
            uint32 startOffset,
            uint128 minStake,
            bool paused
        ) = _unpackMarket(0);

        assertEq(feedA,       DUMMY_FEED);
        assertEq(roundLength, ROUND_HOUR);
        assertEq(startOffset, OFFSET_BTC);
        assertEq(minStake,    MIN_STAKE);
        assertFalse(paused);
    }

    function test_createMarket_emitsEvent() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit PredictionArena.MarketCreated(
            0,
            "BTC/USD",
            DUMMY_FEED,
            address(0),
            ROUND_HOUR,
            OFFSET_BTC,
            MIN_STAKE
        );
        arena.createMarket("BTC/USD", DUMMY_FEED, address(0), ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
    }

    // =========================================================
    //  onlyOwner guards
    // =========================================================

    function test_createMarket_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        arena.createMarket("BTC/USD", DUMMY_FEED, address(0), ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
    }

    function test_setMarketPaused_onlyOwner() public {
        _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.prank(alice);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        arena.setMarketPaused(0, true);
    }

    function test_withdrawFees_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        arena.withdrawFees(alice, 1);
    }

    // =========================================================
    //  Ownership safety – renounceOwnership disabled
    // =========================================================

    function test_renounceOwnership_revertsForOwner() public {
        // The owner calling renounceOwnership must revert with
        // RenounceOwnershipDisabled, not silently succeed.
        vm.prank(owner);
        vm.expectRevert(PredictionArena.RenounceOwnershipDisabled.selector);
        arena.renounceOwnership();
    }

    function test_renounceOwnership_revertsForStranger() public {
        // A stranger also cannot renounce (any revert is acceptable).
        vm.prank(alice);
        vm.expectRevert();
        arena.renounceOwnership();
    }

    // =========================================================
    //  Ownership safety – two-step transfer
    // =========================================================

    function test_transferOwnership_doesNotChangeOwnerImmediately() public {
        // After transferOwnership the owner() is still the old owner.
        // Only pendingOwner() reflects the nominee.
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        arena.transferOwnership(newOwner);

        assertEq(arena.owner(),        owner);    // unchanged
        assertEq(arena.pendingOwner(), newOwner); // nominee recorded
    }

    function test_transferOwnership_oldOwnerKeepsPowers() public {
        // While a transfer is pending, the old owner can still createMarket.
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        arena.transferOwnership(newOwner);

        // Old owner creates a market – should not revert.
        vm.prank(owner);
        arena.createMarket("BTC/USD", DUMMY_FEED, address(0), ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        assertEq(arena.marketCount(), 1);
    }

    function test_acceptOwnership_strangerCannotAccept() public {
        // Only the nominated address can call acceptOwnership.
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        arena.transferOwnership(newOwner);

        vm.prank(alice); // not the nominee
        vm.expectRevert(); // OwnableUnauthorizedAccount
        arena.acceptOwnership();
    }

    function test_acceptOwnership_oldOwnerCannotAccept() public {
        // The old owner cannot accept on behalf of the nominee.
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        arena.transferOwnership(newOwner);

        vm.prank(owner); // old owner trying to accept
        vm.expectRevert();
        arena.acceptOwnership();
    }

    function test_acceptOwnership_nomineeBecomesOwner() public {
        // After the nominee calls acceptOwnership, owner() switches.
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        arena.transferOwnership(newOwner);

        vm.prank(newOwner);
        arena.acceptOwnership();

        assertEq(arena.owner(),        newOwner);
        assertEq(arena.pendingOwner(), address(0)); // cleared
    }

    function test_acceptOwnership_newOwnerCanCreateMarket() public {
        // After accept the new owner has full powers.
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        arena.transferOwnership(newOwner);
        vm.prank(newOwner);
        arena.acceptOwnership();

        vm.prank(newOwner);
        arena.createMarket("BTC/USD", DUMMY_FEED, address(0), ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        assertEq(arena.marketCount(), 1);
    }

    function test_acceptOwnership_oldOwnerLosesPowers() public {
        // After accept the old owner can no longer call onlyOwner functions.
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        arena.transferOwnership(newOwner);
        vm.prank(newOwner);
        arena.acceptOwnership();

        vm.prank(owner); // old owner – no longer authorised
        vm.expectRevert(); // OwnableUnauthorizedAccount
        arena.createMarket("BTC/USD", DUMMY_FEED, address(0), ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
    }

    function test_transferOwnership_replacePendingNominee() public {
        // Calling transferOwnership a second time replaces the old nominee.
        // The original nominee can no longer accept.
        address nomineeA = makeAddr("nomineeA");
        address nomineeB = makeAddr("nomineeB");

        vm.prank(owner);
        arena.transferOwnership(nomineeA);
        assertEq(arena.pendingOwner(), nomineeA);

        // Replace with nomineeB.
        vm.prank(owner);
        arena.transferOwnership(nomineeB);
        assertEq(arena.pendingOwner(), nomineeB);

        // nomineeA can no longer accept.
        vm.prank(nomineeA);
        vm.expectRevert();
        arena.acceptOwnership();

        // nomineeB can accept.
        vm.prank(nomineeB);
        arena.acceptOwnership();
        assertEq(arena.owner(), nomineeB);
    }

    // =========================================================
    //  Production markets (1-hour, three staggered offsets)
    // =========================================================

    function _createProductionMarkets() internal returns (uint256 btc, uint256 eth, uint256 sol) {
        btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        eth = _createMarket("ETH/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_ETH, MIN_STAKE);
        sol = _createMarket("SOL/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_SOL, MIN_STAKE);
    }

    function test_productionMarkets_namesAndCount() public {
        _createProductionMarkets();
        assertEq(arena.marketCount(), 3);
        assertEq(arena.marketName(0), "BTC/USD");
        assertEq(arena.marketName(1), "ETH/USD");
        assertEq(arena.marketName(2), "SOL/USD");
    }

    function test_productionMarkets_offsets() public {
        _createProductionMarkets();
        (, , , uint32 off0, , ) = _unpackMarket(0);
        (, , , uint32 off1, , ) = _unpackMarket(1);
        (, , , uint32 off2, , ) = _unpackMarket(2);
        assertEq(off0, OFFSET_BTC);
        assertEq(off1, OFFSET_ETH);
        assertEq(off2, OFFSET_SOL);
    }

    // =========================================================
    //  10-minute market
    // =========================================================

    function _create10MinMarkets() internal returns (uint256 a, uint256 b, uint256 c) {
        a = _createMarket("BTC/USD 10m", DUMMY_FEED, ROUND_10_MIN, OFFSET_10_0,   MIN_STAKE);
        b = _createMarket("ETH/USD 10m", DUMMY_FEED, ROUND_10_MIN, OFFSET_10_180, MIN_STAKE);
        c = _createMarket("SOL/USD 10m", DUMMY_FEED, ROUND_10_MIN, OFFSET_10_360, MIN_STAKE);
    }

    function test_10minMarkets_roundLength() public {
        _create10MinMarkets();
        (, , uint32 len, , , ) = _unpackMarket(0);
        assertEq(len, ROUND_10_MIN);
    }

    function test_10minMarkets_offsets() public {
        _create10MinMarkets();
        (, , , uint32 off0, , ) = _unpackMarket(0);
        (, , , uint32 off1, , ) = _unpackMarket(1);
        (, , , uint32 off2, , ) = _unpackMarket(2);
        assertEq(off0, OFFSET_10_0);
        assertEq(off1, OFFSET_10_180);
        assertEq(off2, OFFSET_10_360);
    }

    // =========================================================
    //  lockTime / endTime – exact values
    // =========================================================

    function test_lockTime_round0_btc() public {
        (uint256 id, , ) = _createProductionMarkets();
        // Round 0 lock = startOffset + 0 * roundLength = OFFSET_BTC = 0
        assertEq(arena.lockTime(id, 0), uint256(OFFSET_BTC));
    }

    function test_lockTime_round1_eth() public {
        (, uint256 eth, ) = _createProductionMarkets();
        // Round 1 lock = 1200 + 1 * 3600 = 4800
        assertEq(arena.lockTime(eth, 1), 1200 + 3600);
    }

    function test_endTime_round0_btc() public {
        (uint256 id, , ) = _createProductionMarkets();
        // End of round 0 = lock(0) + roundLength = 0 + 3600 = 3600
        assertEq(arena.endTime(id, 0), uint256(ROUND_HOUR));
    }

    function test_endTime_equalsLockTimeOfNextRound() public {
        (uint256 id, , ) = _createProductionMarkets();
        // By design: endTime(k) == lockTime(k+1)
        for (uint256 k = 0; k < 5; k++) {
            assertEq(arena.endTime(id, k), arena.lockTime(id, k + 1));
        }
    }

    function test_lockTime_revertBadMarket() public {
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.MarketNotFound.selector, 99)
        );
        arena.lockTime(99, 0);
    }

    function test_endTime_revertBadMarket() public {
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.MarketNotFound.selector, 99)
        );
        arena.endTime(99, 0);
    }

    // =========================================================
    //  nextCallableRound – boundary cases
    // =========================================================

    //  BTC market: offset = 0, roundLength = 3600
    //  lock of round k = 0 + k * 3600 = k * 3600

    function test_nextCallableRound_beforeFirstOffset() public {
        // For a market with offset = 2400 (SOL), if the clock is at t=1000
        // (before 2400), round 0 hasn't opened yet → expect 0.
        (, , uint256 sol) = _createProductionMarkets();
        vm.warp(1000); // before OFFSET_SOL=2400
        assertEq(arena.nextCallableRound(sol), 0);
    }

    function test_nextCallableRound_justBeforeLock0_btc() public {
        // BTC offset=0, so lock(0)=0. We're at t=3599, just before lock(1)=3600.
        // Elapsed = 3599, elapsed/3600 = 0 → next = 1.
        (uint256 btc, , ) = _createProductionMarkets();
        vm.warp(3599);
        assertEq(arena.nextCallableRound(btc), 1);
    }

    function test_nextCallableRound_exactlyAtLock1_btc() public {
        // At t=3600 (== lock(1)), round 1 is closed. Next callable = 2.
        // Elapsed = 3600, elapsed/3600 = 1 → next = 2.
        (uint256 btc, , ) = _createProductionMarkets();
        vm.warp(3600);
        assertEq(arena.nextCallableRound(btc), 2);
    }

    function test_nextCallableRound_justAfterLock1_btc() public {
        // At t=3601, round 1 already locked. Next callable = 2.
        // Elapsed = 3601, elapsed/3600 = 1 → next = 2.
        (uint256 btc, , ) = _createProductionMarkets();
        vm.warp(3601);
        assertEq(arena.nextCallableRound(btc), 2);
    }

    function test_nextCallableRound_atExactOffset_eth() public {
        // ETH offset=1200. At t=1200 (exactly at offset):
        // elapsed = 0, 0/3600 = 0 → next = 1.
        (, uint256 eth, ) = _createProductionMarkets();
        vm.warp(1200);
        assertEq(arena.nextCallableRound(eth), 1);
    }

    function test_nextCallableRound_manyRoundsAhead() public {
        // 100 rounds into a 1-hour market (BTC, offset=0):
        // t = 100 * 3600 = 360000, elapsed/3600 = 100, next = 101.
        (uint256 btc, , ) = _createProductionMarkets();
        vm.warp(100 * 3600);
        assertEq(arena.nextCallableRound(btc), 101);
    }

    function test_nextCallableRound_midRound() public {
        // BTC at t=5000 (between lock(1)=3600 and lock(2)=7200):
        // elapsed=5000, 5000/3600=1, next=2.
        (uint256 btc, , ) = _createProductionMarkets();
        vm.warp(5000);
        assertEq(arena.nextCallableRound(btc), 2);
    }

    function test_nextCallableRound_justBeforeLock_eth() public {
        // ETH offset=1200. lock(3) = 1200 + 3*3600 = 12000.
        // At t=11999: elapsed=11999-1200=10799, 10799/3600=2, next=3. ✓
        (, uint256 eth, ) = _createProductionMarkets();
        vm.warp(11999);
        assertEq(arena.nextCallableRound(eth), 3);
    }

    function test_nextCallableRound_exactlyAtLock_eth() public {
        // lock(3) = 1200 + 3*3600 = 12000.
        // At t=12000: elapsed=10800, 10800/3600=3, next=4.
        (, uint256 eth, ) = _createProductionMarkets();
        vm.warp(12000);
        assertEq(arena.nextCallableRound(eth), 4);
    }

    function test_nextCallableRound_revertBadMarket() public {
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.MarketNotFound.selector, 42)
        );
        arena.nextCallableRound(42);
    }

    // =========================================================
    //  setMarketPaused
    // =========================================================

    function test_setMarketPaused_togglesState() public {
        _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);

        // Pause
        vm.prank(owner);
        arena.setMarketPaused(0, true);
        (, , , , , bool paused1) = _unpackMarket(0);
        assertTrue(paused1);

        // Unpause
        vm.prank(owner);
        arena.setMarketPaused(0, false);
        (, , , , , bool paused2) = _unpackMarket(0);
        assertFalse(paused2);
    }

    function test_setMarketPaused_emitsEvent() public {
        _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);

        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit PredictionArena.MarketPausedChanged(0, true);
        arena.setMarketPaused(0, true);
    }

    function test_setMarketPaused_revertBadMarket() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.MarketNotFound.selector, 7)
        );
        arena.setMarketPaused(7, true);
    }

    // =========================================================
    //  withdrawFees – reverts
    // =========================================================

    function test_withdrawFees_revertIfFeesAccruedZero() public {
        // feesAccrued starts at 0; any positive amount should revert.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.InsufficientFees.selector,
                1,
                uint256(0)
            )
        );
        arena.withdrawFees(owner, 1);
    }

    function test_withdrawFees_revertIfAmountTooLarge() public {
        // We cannot actually increment feesAccrued without step 5 (settle),
        // so we check that the revert logic is correct when feesAccrued > 0
        // by using a vm.store cheat to set feesAccrued to 50.
        //
        // Storage layout (verified with `forge inspect PredictionArena storage-layout`):
        //   slot 0: _owner             (Ownable)
        //   slot 1: _pendingOwner      (Ownable2Step)
        //   NOTE: OZ v5 ReentrancyGuard uses a transient slot – no storage slot.
        //   slot 2: markets mapping
        //   slot 3: marketCount
        //   slot 4: marketName mapping
        //   slot 5: rounds mapping
        //   slot 6: positions mapping
        //   slot 7: feesAccrued
        vm.store(address(arena), bytes32(uint256(7)), bytes32(uint256(50)));
        assertEq(arena.feesAccrued(), 50);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.InsufficientFees.selector,
                51,
                uint256(50)
            )
        );
        arena.withdrawFees(owner, 51);
    }

    function test_withdrawFees_revertIfToIsZeroAddress() public {
        // Even with zero fees, zero address revert should fire first
        // (but order depends on the function; here ZeroAddress comes first).
        vm.prank(owner);
        vm.expectRevert(PredictionArena.ZeroAddress.selector);
        arena.withdrawFees(address(0), 0);
    }

    // =========================================================
    //  USDC immutable
    // =========================================================

    function test_usdcAddress() public view {
        // The arena was deployed with the MockUSDC address in tests.
        assertEq(address(arena.USDC()), address(usdc));
    }

    // =========================================================
    //  Constants
    // =========================================================

    function test_constants() public view {
        assertEq(arena.FEE_BPS(),        200);
        assertEq(arena.BPS(),            10_000);
        assertEq(arena.SETTLE_WINDOW(),  1 hours);
        assertEq(arena.MIN_ROUND_LENGTH(), 5 minutes);
    }

    // =========================================================
    //  Constructor – revert on zero USDC address
    // =========================================================

    function test_constructor_revertIfUsdcZero() public {
        vm.expectRevert(PredictionArena.ZeroAddress.selector);
        new PredictionArena(address(0), owner);
    }

    // =========================================================
    //  Internal helper – unpack Market struct from public mapping
    //  (Solidity returns structs with value fields via tuple)
    // =========================================================

    function _unpackMarket(uint256 id)
        internal
        view
        returns (
            address feedA,
            address feedB,
            uint32  roundLength,
            uint32  startOffset,
            uint128 minStake,
            bool    paused
        )
    {
        (
            AggregatorV3Interface fa,
            AggregatorV3Interface fb,
            uint32 rl,
            uint32 so,
            uint128 ms,
            bool p
        ) = arena.markets(id);
        feedA       = address(fa);
        feedB       = address(fb);
        roundLength = rl;
        startOffset = so;
        minStake    = ms;
        paused      = p;
    }

    // =========================================================
    //  STEP 4 – placeCall: basic UP and DOWN calls
    // =========================================================

    // BTC market: offset=0, roundLength=3600.
    // At t=1 (just after epoch): nextCallableRound = 1.
    // lock(1) = 0 + 1*3600 = 3600, so t=1 < 3600. ✓

    function test_placeCall_upOnBtc() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1); // t=1, nextCallableRound(btc)=1

        _fund(alice, ONE_USDC);
        vm.prank(alice);
        arena.placeCall(btc, 1, true, ONE_USDC);

        // Position recorded
        (uint128 up, uint128 down, bool claimed) = arena.positions(btc, 1, alice);
        assertEq(up,    ONE_USDC);
        assertEq(down,  0);
        assertFalse(claimed);

        // Round total updated
        (uint128 upTotal, uint128 downTotal, , , , , ) = arena.rounds(btc, 1);
        assertEq(upTotal,   ONE_USDC);
        assertEq(downTotal, 0);

        // Contract received the USDC
        assertEq(usdc.balanceOf(address(arena)), ONE_USDC);
    }

    function test_placeCall_downOnBtc() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);

        _fund(alice, ONE_USDC);
        vm.prank(alice);
        arena.placeCall(btc, 1, false, ONE_USDC);

        (uint128 up, uint128 down, ) = arena.positions(btc, 1, alice);
        assertEq(up,   0);
        assertEq(down, ONE_USDC);

        (, uint128 downTotal, , , , , ) = arena.rounds(btc, 1);
        assertEq(downTotal, ONE_USDC);
    }

    // ETH market: offset=1200. At t=1201: elapsed=1, next=1. lock(1)=4800.
    function test_placeCall_upOnEth() public {
        uint256 eth = _createMarket("ETH/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_ETH, MIN_STAKE);
        vm.warp(1201); // just past offset, next=1

        _fund(alice, ONE_USDC);
        vm.prank(alice);
        arena.placeCall(eth, 1, true, ONE_USDC);

        (uint128 up, , ) = arena.positions(eth, 1, alice);
        assertEq(up, ONE_USDC);
        assertEq(usdc.balanceOf(address(arena)), ONE_USDC);
    }

    // SOL market: offset=2400. At t=2401: elapsed=1, next=1. lock(1)=6000.
    function test_placeCall_downOnSol() public {
        uint256 sol = _createMarket("SOL/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_SOL, MIN_STAKE);
        vm.warp(2401);

        _fund(alice, ONE_USDC);
        vm.prank(alice);
        arena.placeCall(sol, 1, false, ONE_USDC);

        (, uint128 down, ) = arena.positions(sol, 1, alice);
        assertEq(down, ONE_USDC);
    }

    // =========================================================
    //  CallPlaced event
    // =========================================================

    function test_placeCall_emitsCallPlaced() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);
        _fund(alice, ONE_USDC);

        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit PredictionArena.CallPlaced(btc, 1, alice, true, ONE_USDC);
        arena.placeCall(btc, 1, true, ONE_USDC);
    }

    // =========================================================
    //  Top-up and WrongSide
    // =========================================================

    function test_placeCall_topUpSameSideAdds() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);

        _fund(alice, ONE_USDC * 3);
        vm.prank(alice);
        arena.placeCall(btc, 1, true, ONE_USDC);
        vm.prank(alice);
        arena.placeCall(btc, 1, true, ONE_USDC * 2);

        (uint128 up, , ) = arena.positions(btc, 1, alice);
        assertEq(up, ONE_USDC * 3);
        (uint128 upTotal, , , , , , ) = arena.rounds(btc, 1);
        assertEq(upTotal, ONE_USDC * 3);
        assertEq(usdc.balanceOf(address(arena)), ONE_USDC * 3);
    }

    function test_placeCall_oppositeSideRevertsWrongSide() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);

        _fund(alice, ONE_USDC * 2);
        vm.prank(alice);
        arena.placeCall(btc, 1, true, ONE_USDC); // call UP

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.WrongSide.selector, btc, 1)
        );
        arena.placeCall(btc, 1, false, ONE_USDC); // try DOWN → revert
    }

    function test_placeCall_twoPlayersOppositesSidesOk() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);

        _fund(alice, ONE_USDC);
        _fund(bob,   ONE_USDC);

        vm.prank(alice);
        arena.placeCall(btc, 1, true,  ONE_USDC);
        vm.prank(bob);
        arena.placeCall(btc, 1, false, ONE_USDC);

        (uint128 aUp, , )  = arena.positions(btc, 1, alice);
        (, uint128 bDown, ) = arena.positions(btc, 1, bob);
        assertEq(aUp,   ONE_USDC);
        assertEq(bDown, ONE_USDC);

        (uint128 upTotal, uint128 downTotal, , , , , ) = arena.rounds(btc, 1);
        assertEq(upTotal,   ONE_USDC);
        assertEq(downTotal, ONE_USDC);
        assertEq(usdc.balanceOf(address(arena)), ONE_USDC * 2);
    }

    // =========================================================
    //  Timing boundary tests
    // =========================================================

    function test_placeCall_allowedAtLockMinus1() public {
        // At t = lock(1) - 1 = 3599, round 1 is still open.
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(3599);

        _fund(alice, ONE_USDC);
        vm.prank(alice);
        arena.placeCall(btc, 1, true, ONE_USDC); // should succeed
        assertEq(usdc.balanceOf(address(arena)), ONE_USDC);
    }

    function test_placeCall_atLockTimeRevertsNotNextRound() public {
        // At t = lock(1) = 3600, nextCallableRound = 2, so roundIndex=1 reverts.
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(3600);
        _fund(alice, ONE_USDC);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.NotNextRound.selector, 1, 2)
        );
        arena.placeCall(btc, 1, true, ONE_USDC);
    }

    function test_placeCall_pastRoundRevertsNotNextRound() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(5000); // nextBettable = 2
        _fund(alice, ONE_USDC);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.NotNextRound.selector, 1, 2)
        );
        arena.placeCall(btc, 1, true, ONE_USDC); // round 1 already locked
    }

    function test_placeCall_nextPlusOneRevertsNotNextRound() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1); // nextBettable = 1
        _fund(alice, ONE_USDC);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.NotNextRound.selector, 2, 1)
        );
        arena.placeCall(btc, 2, true, ONE_USDC); // one too far ahead
    }

    function test_placeCall_farFutureRoundRevertsNotNextRound() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1); // nextBettable = 1
        _fund(alice, ONE_USDC);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.NotNextRound.selector, 999, 1)
        );
        arena.placeCall(btc, 999, true, ONE_USDC);
    }

    function test_placeCall_beforeOffsetRound0Bettable() public {
        // SOL offset=2400. At t=100 (before offset), nextCallableRound=0.
        uint256 sol = _createMarket("SOL/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_SOL, MIN_STAKE);
        vm.warp(100);
        _fund(alice, ONE_USDC);

        // round 0 is callable (lock(0)=2400 > 100)
        vm.prank(alice);
        arena.placeCall(sol, 0, true, ONE_USDC);
        assertEq(usdc.balanceOf(address(arena)), ONE_USDC);
    }

    // =========================================================
    //  Paused market
    // =========================================================

    function test_placeCall_pausedMarketReverts() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);
        vm.prank(owner);
        arena.setMarketPaused(btc, true);

        _fund(alice, ONE_USDC);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.MarketPaused.selector, btc)
        );
        arena.placeCall(btc, 1, true, ONE_USDC);
    }

    function test_placeCall_unpauseAllowsCalls() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);
        vm.prank(owner);
        arena.setMarketPaused(btc, true);
        vm.prank(owner);
        arena.setMarketPaused(btc, false); // re-enable

        _fund(alice, ONE_USDC);
        vm.prank(alice);
        arena.placeCall(btc, 1, true, ONE_USDC); // should succeed
        assertEq(usdc.balanceOf(address(arena)), ONE_USDC);
    }

    function test_placeCall_pauseDoesNotAffectExistingPosition() public {
        // A call placed before pause is still recorded correctly.
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);

        _fund(alice, ONE_USDC);
        vm.prank(alice);
        arena.placeCall(btc, 1, true, ONE_USDC); // call before pause

        vm.prank(owner);
        arena.setMarketPaused(btc, true); // pause after

        (uint128 up, , ) = arena.positions(btc, 1, alice);
        assertEq(up, ONE_USDC); // position unchanged
        assertEq(usdc.balanceOf(address(arena)), ONE_USDC);
    }

    // =========================================================
    //  Amount validation
    // =========================================================

    function test_placeCall_belowMinimumReverts() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);
        _fund(alice, MIN_STAKE - 1);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.StakeBelowMinimum.selector,
                MIN_STAKE - 1,
                MIN_STAKE
            )
        );
        arena.placeCall(btc, 1, true, MIN_STAKE - 1);
    }

    function test_placeCall_zeroAmountReverts() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.StakeBelowMinimum.selector,
                0,
                MIN_STAKE
            )
        );
        arena.placeCall(btc, 1, true, 0);
    }

    function test_placeCall_exactlyMinimumSucceeds() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);
        _fund(alice, MIN_STAKE);

        vm.prank(alice);
        arena.placeCall(btc, 1, true, uint256(MIN_STAKE));
        (uint128 up, , ) = arena.positions(btc, 1, alice);
        assertEq(up, MIN_STAKE);
    }

    function test_placeCall_uint128OverflowReverts() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);

        // type(uint128).max + 1 overflows a uint128.
        uint256 tooBig = uint256(type(uint128).max) + 1;
        usdc.mint(alice, tooBig);
        vm.prank(alice);
        usdc.approve(address(arena), tooBig);

        vm.prank(alice);
        // SafeCast reverts with its own Overflow error; we just check any revert.
        vm.expectRevert();
        arena.placeCall(btc, 1, true, tooBig);
    }

    // =========================================================
    //  ERC-20 errors (no allowance, insufficient balance)
    // =========================================================

    function test_placeCall_noAllowanceReverts() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);
        usdc.mint(alice, ONE_USDC); // has balance but NO approval

        vm.prank(alice);
        vm.expectRevert(); // ERC20InsufficientAllowance
        arena.placeCall(btc, 1, true, ONE_USDC);
    }

    function test_placeCall_insufficientBalanceReverts() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);
        // alice has 0 balance but approves a big allowance
        vm.prank(alice);
        usdc.approve(address(arena), ONE_USDC);

        vm.prank(alice);
        vm.expectRevert(); // ERC20InsufficientBalance
        arena.placeCall(btc, 1, true, ONE_USDC);
    }

    // =========================================================
    //  Unknown market
    // =========================================================

    function test_placeCall_unknownMarketReverts() public {
        vm.warp(1);
        _fund(alice, ONE_USDC);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PredictionArena.MarketNotFound.selector, 99)
        );
        arena.placeCall(99, 1, true, ONE_USDC);
    }

    // =========================================================
    //  Markets are independent
    // =========================================================

    function test_placeCall_marketsAreIndependent() public {
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        uint256 eth = _createMarket("ETH/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_ETH, MIN_STAKE);

        vm.warp(1201); // past ETH offset; BTC next=1, ETH next=1

        _fund(alice, ONE_USDC);
        vm.prank(alice);
        arena.placeCall(btc, 1, true, ONE_USDC);

        // ETH round 1 totals must still be zero
        (uint128 upTotal, uint128 downTotal, , , , , ) = arena.rounds(eth, 1);
        assertEq(upTotal,   0);
        assertEq(downTotal, 0);

        // BTC round 1 total is correct
        (uint128 btcUp, , , , , , ) = arena.rounds(btc, 1);
        assertEq(btcUp, ONE_USDC);
    }

    // =========================================================
    //  Owner cannot steal players' money via withdrawFees
    // =========================================================

    function test_withdrawFees_cannotDrainPlayerMoney() public {
        // Place a call so the contract holds USDC.
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1);
        _fund(alice, ONE_USDC);
        vm.prank(alice);
        arena.placeCall(btc, 1, true, ONE_USDC);

        // Contract holds ONE_USDC but feesAccrued == 0.
        assertEq(usdc.balanceOf(address(arena)), ONE_USDC);
        assertEq(arena.feesAccrued(), 0);

        // Owner trying to withdraw anything must revert.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                PredictionArena.InsufficientFees.selector,
                ONE_USDC,
                uint256(0)
            )
        );
        arena.withdrawFees(owner, ONE_USDC);

        // USDC still in the contract.
        assertEq(usdc.balanceOf(address(arena)), ONE_USDC);
    }

    // =========================================================
    //  Fuzz: USDC balance == sum of round totals
    // =========================================================

    /// @dev Fuzz test with a few players making random valid calls.
    ///      Invariant: contract's USDC balance == sum of (upTotal + downTotal)
    ///      for all rounds touched.
    function testFuzz_balanceEqualsRoundTotals(
        uint64 seed1, uint64 seed2, uint64 seed3, uint64 seed4
    ) public {
        // Use a BTC market only (offset=0, simplest timing).
        uint256 btc = _createMarket("BTC/USD", DUMMY_FEED, ROUND_HOUR, OFFSET_BTC, MIN_STAKE);
        vm.warp(1); // round 1 is callable

        // Derive call amounts from fuzz seeds; clamp to [minStake, 10 USDC].
        uint256 minS = uint256(MIN_STAKE);
        uint256 maxS = 10 * ONE_USDC;
        uint256 a1 = minS + (uint256(seed1) % (maxS - minS + 1));
        uint256 a2 = minS + (uint256(seed2) % (maxS - minS + 1));
        uint256 a3 = minS + (uint256(seed3) % (maxS - minS + 1));
        uint256 a4 = minS + (uint256(seed4) % (maxS - minS + 1));

        // alice calls UP, bob calls DOWN; both can top up on the same side.
        _fund(alice, a1 + a3);
        _fund(bob,   a2 + a4);

        vm.prank(alice); arena.placeCall(btc, 1, true,  a1);
        vm.prank(bob);   arena.placeCall(btc, 1, false, a2);
        vm.prank(alice); arena.placeCall(btc, 1, true,  a3); // top-up same side
        vm.prank(bob);   arena.placeCall(btc, 1, false, a4); // top-up same side

        (uint128 upTotal, uint128 downTotal, , , , , ) = arena.rounds(btc, 1);
        uint256 expectedBalance = uint256(upTotal) + uint256(downTotal);

        assertEq(usdc.balanceOf(address(arena)), expectedBalance);
        assertEq(expectedBalance, a1 + a2 + a3 + a4);
    }
}
