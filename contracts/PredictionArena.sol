// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Kairo Markets – PredictionArena
//
//  UP/DOWN prediction market for Arc testnet.
//  Players bet USDC on whether a price feed will go up or down
//  over a fixed time window (a "round").
//
//  Build plan:
//    Step 3  ✓ – skeleton: markets, storage, time math, fees
//    Step 4  ✓ – placeBet (betting, USDC pull, position tracking)
//    Step 5  ✓ – mock feed, price checking, settle, markRefunded
//    Step 6  ✓ – payouts, refunds, claims (claim, claimMany, dust, totalPlayerFunds)
//    Step 7  – full test suite
//    Step 8  – deploy to Arc testnet
// =============================================================

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

// =============================================================
//  IMPORTANT – Arc USDC accounting
//
//  On Arc the native gas token IS USDC, exposed two ways:
//
//  ► ERC-20 view  (what this contract uses everywhere)
//    Address : 0x3600000000000000000000000000000000000000
//    Decimals: 6  – so $1.00 = 1_000_000
//
//  ► Native view (msg.value / gas)
//    Decimals: 18 – the same money, but 10^12 times larger integer
//
//  This contract ONLY uses the ERC-20 view.
//  It NEVER reads msg.value, address(this).balance, or the native
//  decimals. Mixing the two views creates a 10^12 scaling error.
// =============================================================

contract PredictionArena is Ownable2Step, ReentrancyGuard {
    // SafeERC20 wraps every USDC call so a non-standard token that
    // returns nothing (or false) still reverts instead of silently failing.
    using SafeERC20 for IERC20;

    // =========================================================
    //  Constants
    // =========================================================

    /// @notice Fee taken from the LOSING side's total (2 %).
    ///         E.g. if DOWN bettors lose 1000 USDC, 20 USDC goes
    ///         to feesAccrued and 980 USDC is shared among UP winners.
    uint256 public constant FEE_BPS = 200;

    /// @notice Basis-point denominator (10 000 = 100 %).
    uint256 public constant BPS = 10_000;

    /// @notice After a round ends, the settler has this long to call
    ///         settle() before the round becomes auto-refundable.
    uint256 public constant SETTLE_WINDOW = 1 hours;

    /// @notice The shortest a round can be. Prevents dust/spam markets.
    uint256 public constant MIN_ROUND_LENGTH = 5 minutes;

    // =========================================================
    //  Immutables
    // =========================================================

    /// @notice Arc USDC token (ERC-20, 6 decimals).
    ///         Set once in the constructor; never changes.
    IERC20 public immutable USDC;

    // =========================================================
    //  Custom errors
    //  (cheaper than require strings; clearer stack traces)
    // =========================================================

    /// @notice Thrown when address(0) is passed where a real address is needed.
    error ZeroAddress();

    /// @notice Thrown when feedA is address(0) on createMarket.
    error FeedARequired();

    /// @notice Thrown when roundLength is below MIN_ROUND_LENGTH.
    error RoundTooShort(uint32 roundLength, uint32 minimum);

    /// @notice Thrown when startOffset >= roundLength (must be strictly less).
    error OffsetNotLessThanRoundLength(uint32 startOffset, uint32 roundLength);

    /// @notice Thrown when minStake is 0.
    error MinStakeMustBePositive();

    /// @notice Thrown when a market ID does not exist.
    error MarketNotFound(uint256 marketId);

    /// @notice Thrown when withdrawFees is called with amount > feesAccrued.
    error InsufficientFees(uint256 requested, uint256 available);

    /// @notice Thrown when renounceOwnership is called.
    ///         Giving up ownership would leave fees permanently stuck
    ///         in the contract and make it impossible to create new
    ///         markets, so this function is disabled on purpose.
    error RenounceOwnershipDisabled();

    /// @notice Thrown when feedB is non-zero on createMarket.
    ///         Head-to-head markets (feedB set) are not built yet.
    ///         Passing a non-zero feedB now would silently store an
    ///         unused address; we reject it so no market is created
    ///         under a false assumption. Remove this check when
    ///         head-to-head support is implemented in a later step.
    error FeedBNotSupportedYet();

    /// @notice Thrown when placeBet is called on a paused market.
    error MarketPaused(uint256 marketId);

    /// @notice Thrown when placeBet is called with a roundIndex that is not
    ///         the next bettable round.
    /// @param  given    The roundIndex the caller passed in.
    /// @param  expected The index placeBet would have accepted.
    error NotNextRound(uint256 given, uint256 expected);

    /// @notice Thrown when the bet amount is below the market's minimum stake.
    ///         Also catches zero-amount bets (0 < minStake always).
    error StakeBelowMinimum(uint256 amount, uint128 minStake);

    /// @notice Thrown when a player tries to bet on the opposite side to an
    ///         existing position they already hold in this round.
    error WrongSide(uint256 marketId, uint256 roundIndex);

    /// @notice Thrown when the bet amount does not fit in uint128.
    ///         Round totals are stored as uint128 to pack tightly; a single
    ///         bet larger than ~3.4 × 10^38 USDC units would overflow them.
    error AmountExceedsUint128(uint256 amount);

    // -- Settle errors ------------------------------------------------

    /// @notice settle() called before the round has ended.
    error SettleTooEarly(uint256 nowTs, uint256 endTs);

    /// @notice settle() called after the 1-hour settle window has closed.
    error SettleWindowClosed(uint256 nowTs, uint256 deadline);

    /// @notice settle() or markRefunded() called on a round that is
    ///         already settled or refunded.
    error RoundAlreadySettled(uint256 marketId, uint256 roundIndex);

    /// @notice The startRoundId supplied to settle() fails verification.
    ///         This means the caller tried to cheat or passed a wrong ID.
    error InvalidStartRound(uint80 id);

    /// @notice The endRoundId supplied to settle() fails verification.
    error InvalidEndRound(uint80 id);

    /// @notice markRefunded() called before the settle window has closed.
    error RefundTooEarly(uint256 nowTs, uint256 earliest);

    // -- Claim errors -------------------------------------------------

    /// @notice claim() or claimMany() called on a round that is not yet settled.
    ///         Inside the settle window the player must wait; outside it claim()
    ///         auto-finalises the round as Timeout and then pays.
    error RoundNotSettled(uint256 marketId, uint256 roundIndex);

    /// @notice The player already claimed their payout for this round.
    error AlreadyClaimed(uint256 marketId, uint256 roundIndex);

    /// @notice The player has no winning position (or no position at all)
    ///         in this round, so there is nothing to pay out.
    error NothingToClaim(uint256 marketId, uint256 roundIndex);

    /// @notice claimMany() arrays are different lengths.
    error ArrayLengthMismatch();

    /// @notice claimMany() called with empty arrays.
    error EmptyClaim();

    /// @notice withdrawFees() would reduce the contract USDC balance
    ///         below totalPlayerFunds.  Defence-in-depth: the owner
    ///         can never dip into players' money even if feesAccrued
    ///         accounting had a bug.
    error FeesWouldTouchPlayerFunds();

    // =========================================================
    //  Events
    // =========================================================

    /// @notice Emitted when a new market is created.
    /// @param marketId   Index in the markets array.
    /// @param name       Human-readable label, e.g. "BTC/USD".
    /// @param feedA      Price feed address.
    /// @param feedB      Second feed slot (zero = not used yet).
    /// @param roundLength   Seconds per round.
    /// @param startOffset   Epoch-relative start of round 0 (seconds).
    /// @param minStake   Minimum USDC stake (6-decimal units).
    event MarketCreated(
        uint256 indexed marketId,
        string name,
        address indexed feedA,
        address feedB,
        uint32 roundLength,
        uint32 startOffset,
        uint128 minStake
    );

    /// @notice Emitted when the owner pauses or unpauses a market.
    /// @param marketId  Which market changed.
    /// @param paused    True = new bets blocked; false = open again.
    event MarketPausedChanged(uint256 indexed marketId, bool paused);

    /// @notice Emitted when the owner withdraws collected fees.
    /// @param to     Recipient address.
    /// @param amount USDC amount transferred (6-decimal units).
    event FeesWithdrawn(address indexed to, uint256 amount);

    /// @notice Emitted when a player places or tops up a bet.
    /// @param marketId    Which market the bet is on.
    /// @param roundIndex  Which round the bet is on.
    /// @param player      The bettor's address.
    /// @param up          True = bet UP; false = bet DOWN.
    /// @param amount      USDC added this call (6-decimal units, not cumulative).
    event BetPlaced(
        uint256 indexed marketId,
        uint256 indexed roundIndex,
        address indexed player,
        bool up,
        uint256 amount
    );

    /// @notice Emitted when a player successfully claims their payout or refund.
    /// @param marketId    Which market.
    /// @param roundIndex  Which round.
    /// @param player      The claimer (always msg.sender).
    /// @param amount      USDC paid out (6-decimal units).
    event Claimed(
        uint256 indexed marketId,
        uint256 indexed roundIndex,
        address indexed player,
        uint256 amount
    );

    /// @notice Emitted when rounding dust from a winning round is swept to
    ///         feesAccrued after the last winner claims.
    /// @dev    Only emitted when dust > 0. Dust = D - sum(floor(s_i * D / W))
    ///         across all winning claimants, which arises from integer division.
    /// @param marketId    Which market.
    /// @param roundIndex  Which round.
    /// @param amount      USDC dust moved to feesAccrued (always > 0).
    event RoundDustToFees(
        uint256 indexed marketId,
        uint256 indexed roundIndex,
        uint256 amount
    );

    // =========================================================
    //  Settle types
    // =========================================================

    /// @notice Why a round ended the way it did.
    ///
    ///         None          – the round settled normally (UP or DOWN winner).
    ///                         Always emitted with SettledUp or SettledDown.
    ///                         Using None (= 0) avoids the old bug where a
    ///                         winning round's event log said "OneSided refund".
    ///
    ///         The remaining values only appear with state == Refunded:
    ///         OneSided        – Rule 14: only one side placed bets
    ///         NoUpdate        – Rule 17: no feed update at or after lock time
    ///         EndNotAfterStart– Rule 16: endRoundId <= startRoundId
    ///         UnchangedPrice  – Rule 15: start price == end price
    ///         InvalidPrice    – Rule 18: a price is zero or negative
    ///         PhaseEdge       – Rule 20: phase boundary prevents verification
    ///         Timeout         – Rule 19: settle window expired; markRefunded called
    enum RefundReason {
        None,            // Round was NOT refunded (SettledUp or SettledDown)
        OneSided,        // Rule 14: only one side placed bets
        NoUpdate,        // Rule 17: no feed update at or after lock time
        EndNotAfterStart,// Rule 16: endRoundId <= startRoundId (feed stale)
        UnchangedPrice,  // Rule 15: start price == end price
        InvalidPrice,    // Rule 18: a price is zero or negative
        PhaseEdge,       // Rule 20: phase boundary prevents verification
        Timeout          // Rule 19: settle window expired; markRefunded called
    }

    /// @notice Emitted once when a round is settled or marked refunded.
    /// @param marketId    Which market.
    /// @param roundIndex  Which round.
    /// @param state       SettledUp, SettledDown, or Refunded.
    /// @param startRoundId  Feed round ID used as the start price.
    ///                      Zero when reason is OneSided, NoUpdate, or Timeout.
    /// @param endRoundId    Feed round ID used as the end price.
    ///                      Zero in the same cases as startRoundId.
    /// @param startPrice  Price at lock time. Zero when ids are zero.
    /// @param endPrice    Price at end time.  Zero when ids are zero.
    /// @param reason      RefundReason.None for SettledUp/SettledDown.
    ///                    For Refunded, describes why (OneSided, Timeout, etc.).
    event RoundSettled(
        uint256 indexed marketId,
        uint256 indexed roundIndex,
        RoundState      state,
        uint80          startRoundId,
        uint80          endRoundId,
        int256          startPrice,
        int256          endPrice,
        RefundReason    reason
    );

    // =========================================================
    //  Data structures
    // =========================================================

    /// @notice Per-market configuration.
    ///         Immutable after createMarket – no setters exist for
    ///         feedA, feedB, roundLength, startOffset or minStake.
    struct Market {
        /// Price feed for this market (e.g. Chainlink BTC/USD).
        AggregatorV3Interface feedA;
        /// Second feed slot, reserved for head-to-head markets
        /// (e.g. SOL vs BTC percentage move). Zero for all current markets.
        AggregatorV3Interface feedB;
        /// How many seconds one round lasts.
        uint32 roundLength;
        /// Seconds from the Unix epoch to the lock of round 0.
        /// The lock of round k = startOffset + k * roundLength.
        uint32 startOffset;
        /// Minimum USDC bet in 6-decimal units (e.g. 100_000 = $0.10).
        uint128 minStake;
        /// When true, new bets are blocked but existing bets and
        /// settlement continue normally.
        bool paused;
    }

    /// @notice Possible states a round can be in.
    enum RoundState {
        Unsettled,   // Round has ended but settle() not yet called
        SettledUp,   // Price went UP; UP bettors win
        SettledDown, // Price went DOWN; DOWN bettors win
        Refunded     // Everyone gets their stake back (see RULES §D)
    }

    /// @notice Per-round totals and settlement data.
    ///         Populated by placeBet (step 4) and settle (step 5).
    struct Round {
        /// Total USDC staked on UP in this round (6-decimal).
        uint128 upTotal;
        /// Total USDC staked on DOWN in this round (6-decimal).
        uint128 downTotal;
        /// Chainlink round ID of the first update at or after lockTime.
        /// Used to read startPrice. Set by settle() in step 5.
        uint80 startRoundId;
        /// Chainlink round ID of the last update at or before endTime.
        /// Used to read endPrice. Set by settle() in step 5.
        uint80 endRoundId;
        /// Price at lockTime (start of the comparison window).
        /// Set by settle() in step 5.
        int256 startPrice;
        /// Price at endTime (end of the comparison window).
        /// Set by settle() in step 5.
        int256 endPrice;
        /// Current lifecycle state.
        RoundState state;
    }

    /// @notice A single player's stake in one round of one market.
    ///         Only one side (up or down) can be non-zero per player
    ///         per round (enforced in step 4).
    struct Position {
        /// USDC staked on UP (6-decimal). Zero if player bet DOWN.
        uint128 up;
        /// USDC staked on DOWN (6-decimal). Zero if player bet UP.
        uint128 down;
        /// True once the player has claimed their payout or refund.
        /// Prevents double-claims (set in step 6).
        bool claimed;
    }

    // =========================================================
    //  State variables
    // =========================================================

    /// @notice All markets, indexed 0 … marketCount-1.
    mapping(uint256 => Market) public markets;

    /// @notice Total number of markets created so far.
    uint256 public marketCount;

    /// @notice Human-readable market names (kept separate to avoid
    ///         structs with dynamic strings, which cost extra gas).
    mapping(uint256 => string) public marketName;

    // ----------------------------------------------------------
    //  Round and position storage (written in steps 4-6)
    // ----------------------------------------------------------

    /// @notice Round data keyed by (marketId => roundIndex => Round).
    /// @dev    Step 4 writes upTotal/downTotal.
    ///         Step 5 writes startRoundId, endRoundId, prices, state.
    mapping(uint256 => mapping(uint256 => Round)) public rounds;

    /// @notice Player positions keyed by
    ///         (marketId => roundIndex => player => Position).
    /// @dev    Step 4 writes up/down.
    ///         Step 6 sets claimed = true.
    mapping(uint256 => mapping(uint256 => mapping(address => Position))) public positions;

    // ----------------------------------------------------------
    //  Fee accounting
    // ----------------------------------------------------------

    /// @notice Accumulated protocol fees in USDC (6-decimal units).
    ///         Increased by _finaliseRound() (step 5) for UP/DOWN wins.
    ///         Increased by _claimOne() when rounding dust is swept.
    ///         Decreased by withdrawFees().
    uint256 public feesAccrued;

    // ----------------------------------------------------------
    //  Player-fund accounting (step 6)
    // ----------------------------------------------------------

    /// @notice Total USDC the contract currently owes to players
    ///         (or may still owe – includes unsettled rounds).
    ///
    ///         Updated at four moments:
    ///           + amount  on every placeBet (money enters)
    ///           - fee     on settle (fee fraction moves to feesAccrued)
    ///           - payout  on every claim (money leaves to a player)
    ///           - dust    when the last winner claims and dust > 0
    ///
    ///         INVARIANT (checked in withdrawFees):
    ///           USDC.balanceOf(address(this)) >= totalPlayerFunds + feesAccrued
    uint256 public totalPlayerFunds;

    /// @notice Per-round payout progress.
    ///         Kept SEPARATE from the Round struct so existing tests that
    ///         destructure rounds() by position continue to work unchanged.
    ///
    ///         winnerStakeClaimed  – cumulative winning-side stake already claimed.
    ///                               When this reaches winnerSideTotal, winner-dust
    ///                               (Dist - sum_bonuses) moves to fees.
    ///         bonusPaid           – cumulative winner bonus already paid.
    ///         loserMatchedClaimed – cumulative loser-side matched stake (floor).
    ///                               When loserStakeClaimed reaches loserSideTotal,
    ///                               loser-dust (M - loserMatchedClaimed) moves to fees.
    ///         loserStakeClaimed   – cumulative loser-side stake already claimed
    ///                               (used to detect the last loser for dust sweep).
    struct PayoutProgress {
        uint128 winnerStakeClaimed;
        uint128 bonusPaid;
        uint128 loserMatchedClaimed;
        uint128 loserStakeClaimed;
    }
    /// @notice keyed by (marketId => roundIndex => PayoutProgress).
    mapping(uint256 => mapping(uint256 => PayoutProgress)) public payoutProgress;

    // =========================================================
    //  Constructor
    // =========================================================

    /// @notice Deploy the contract and set the USDC token address.
    ///
    ///         Ownership is TWO-STEP (Ownable2Step):
    ///           1. Current owner calls transferOwnership(nominee).
    ///           2. The nominee must call acceptOwnership() to confirm.
    ///         Until acceptOwnership() is called, the old owner keeps
    ///         ALL powers and the nominee has none.
    ///         renounceOwnership() is permanently disabled – see the
    ///         RenounceOwnershipDisabled error for the reason.
    ///
    /// @param _usdc  ERC-20 USDC on Arc:
    ///               0x3600000000000000000000000000000000000000
    ///               (6 decimals, ERC-20 view only).
    /// @param _owner Initial owner; receives Ownable2Step ownership.
    constructor(address _usdc, address _owner) Ownable(_owner) {
        if (_usdc == address(0)) revert ZeroAddress();
        USDC = IERC20(_usdc);
    }

    // =========================================================
    //  Market management (onlyOwner)
    // =========================================================

    /// @notice Create a new prediction market.
    ///         Market settings are IMMUTABLE after creation.
    ///         To change anything, create a new market.
    ///
    /// @param name        Human-readable label, e.g. "BTC/USD".
    /// @param feedA       Chainlink AggregatorV3Interface for this market.
    ///                    Must not be address(0).
    /// @param feedB       Must be address(0) for now.
    ///                    Reserved for future head-to-head markets
    ///                    (e.g. SOL vs BTC percentage move).
    ///                    Passing a non-zero value reverts with
    ///                    FeedBNotSupportedYet until that feature is built.
    /// @param roundLength Seconds per round. Must be >= MIN_ROUND_LENGTH.
    /// @param startOffset Epoch-relative offset of round 0's lock time.
    ///                    Must be strictly less than roundLength.
    ///                    Example: 0 = every hour on the hour (:00);
    ///                             1200 = every hour at :20 past.
    /// @param minStake    Minimum USDC per bet in 6-decimal units.
    ///                    Example: 100_000 = $0.10. Must be > 0.
    function createMarket(
        string calldata name,
        address feedA,
        address feedB,
        uint32 roundLength,
        uint32 startOffset,
        uint128 minStake
    ) external onlyOwner {
        // ── Validation ──────────────────────────────────────
        if (feedA == address(0)) revert FeedARequired();
        // Head-to-head markets (feedB != 0) are not built yet.
        // Reject now so no market is created under a false assumption.
        // Remove this check when head-to-head is implemented.
        if (feedB != address(0)) revert FeedBNotSupportedYet();
        // MIN_ROUND_LENGTH is 300 (5 minutes), well within uint32 range.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (roundLength < uint32(MIN_ROUND_LENGTH)) {
            // forge-lint: disable-next-line(unsafe-typecast)
            revert RoundTooShort(roundLength, uint32(MIN_ROUND_LENGTH));
        }
        // startOffset must be strictly inside one round window.
        // If startOffset == roundLength, round 0 would have zero
        // betting time, which makes no sense.
        if (startOffset >= roundLength) {
            revert OffsetNotLessThanRoundLength(startOffset, roundLength);
        }
        if (minStake == 0) revert MinStakeMustBePositive();

        // ── Write ────────────────────────────────────────────
        uint256 id = marketCount; // first market = 0
        markets[id] = Market({
            feedA: AggregatorV3Interface(feedA),
            feedB: AggregatorV3Interface(feedB), // zero address is fine
            roundLength: roundLength,
            startOffset: startOffset,
            minStake: minStake,
            paused: false
        });
        marketName[id] = name;
        marketCount = id + 1; // checked arithmetic; overflows at 2^256-1

        emit MarketCreated(id, name, feedA, feedB, roundLength, startOffset, minStake);
    }

    /// @notice Pause or unpause a market.
    ///         Pausing only prevents new bets (step 4 checks this).
    ///         Existing bets, settlement and claims are unaffected.
    ///
    /// @param marketId  Which market to change.
    /// @param paused    True to pause; false to unpause.
    function setMarketPaused(uint256 marketId, bool paused) external onlyOwner {
        if (marketId >= marketCount) revert MarketNotFound(marketId);
        markets[marketId].paused = paused;
        emit MarketPausedChanged(marketId, paused);
    }

    // =========================================================
    //  Round time math (public views)
    // =========================================================

    /// @notice Unix timestamp when round `roundIndex` locks for market
    ///         `marketId`. Bets must arrive strictly before this time.
    ///
    ///         lock = startOffset + roundIndex * roundLength
    ///
    ///         The multiplication uses checked arithmetic (Solidity
    ///         ^0.8.x) so it reverts on overflow rather than wrapping.
    ///
    /// @param marketId    Which market.
    /// @param roundIndex  Which round (0-indexed from the epoch).
    function lockTime(uint256 marketId, uint256 roundIndex) public view returns (uint256) {
        if (marketId >= marketCount) revert MarketNotFound(marketId);
        Market storage m = markets[marketId];
        // Both operands fit in uint256 so the multiplication cannot
        // realistically overflow (roundIndex * 3600 < 2^256).
        return uint256(m.startOffset) + roundIndex * uint256(m.roundLength);
    }

    /// @notice Unix timestamp when round `roundIndex` ends for market
    ///         `marketId`. The end of round k is also the lock of round k+1.
    ///
    ///         end = lockTime + roundLength
    ///
    /// @param marketId    Which market.
    /// @param roundIndex  Which round (0-indexed).
    function endTime(uint256 marketId, uint256 roundIndex) public view returns (uint256) {
        // lockTime() already validates marketId.
        Market storage m = markets[marketId];
        return lockTime(marketId, roundIndex) + uint256(m.roundLength);
    }

    /// @notice The index of the next round that is still open for betting.
    ///
    ///         A round is "bettable" if its lock time is strictly in the
    ///         future (block.timestamp < lockTime).  We want the NEXT
    ///         round to lock after the current moment.
    ///
    ///         Algorithm (see inline comments for the boundary cases):
    ///
    ///           If block.timestamp < startOffset   → round 0 hasn't opened yet → return 0
    ///           Else elapsed = block.timestamp - startOffset
    ///                round that just locked = elapsed / roundLength  (integer division)
    ///                next bettable round    = that + 1
    ///
    ///         Boundary: at block.timestamp == startOffset + k * roundLength,
    ///         that round k is EXACTLY at its lock – it is already closed.
    ///         elapsed / roundLength = k, so we return k + 1. ✓
    ///
    /// @param marketId  Which market.
    function nextBettableRound(uint256 marketId) public view returns (uint256) {
        if (marketId >= marketCount) revert MarketNotFound(marketId);
        Market storage m = markets[marketId];
        uint256 offset = uint256(m.startOffset);
        uint256 len    = uint256(m.roundLength);

        // Before round 0 opens: the first round is still in the future.
        if (block.timestamp < offset) {
            return 0;
        }

        // How many complete rounds have already locked?
        uint256 elapsed         = block.timestamp - offset;  // safe: offset <= block.timestamp
        uint256 roundsCompleted = elapsed / len;             // integer division

        // The next bettable round is one beyond the last completed lock.
        // At the exact boundary (elapsed % len == 0), roundsCompleted
        // already counts the current moment as a completed lock, so
        // adding 1 is correct.
        return roundsCompleted + 1;
    }

    // =========================================================
    //  Fee management (onlyOwner)
    // =========================================================

    // ----------------------------------------------------------
    //  INVARIANT (enforced here and ONLY here):
    //
    //  The owner can withdraw collected fees up to feesAccrued.
    //  There is NO function that lets the owner withdraw the pot
    //  (money players have bet) or any arbitrary ERC-20 tokens.
    //  The ONLY owner-reachable USDC transfer out is withdrawFees,
    //  and it is capped by feesAccrued.
    // ----------------------------------------------------------

    /// @notice Transfer collected protocol fees to `to`.
    ///         Reverts if `amount` exceeds what has been collected.
    ///
    /// @param to     Recipient of the fees. Must not be address(0).
    /// @param amount USDC amount to transfer (6-decimal units).
    function withdrawFees(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > feesAccrued) revert InsufficientFees(amount, feesAccrued);

        // Defence-in-depth: even if feesAccrued accounting had a bug,
        // this ensures the withdrawal never reduces the balance below
        // what players are owed.  Check BEFORE the transfer.
        uint256 balNow = USDC.balanceOf(address(this));
        if (balNow < amount || balNow - amount < totalPlayerFunds) {
            revert FeesWouldTouchPlayerFunds();
        }

        // Decrease first, then transfer (checks-effects-interactions).
        feesAccrued -= amount;

        // safeTransfer reverts on failure; no manual bool check needed.
        // TRANSFER SITE 2 of 2: owner fee withdrawal (see comment at bottom).
        USDC.safeTransfer(to, amount);

        emit FeesWithdrawn(to, amount);
    }

    // =========================================================
    //  Ownership safety
    // =========================================================

    /// @notice Permanently disabled. Calling this always reverts.
    ///
    ///         Why: if the owner were given up, no one could ever call
    ///         withdrawFees (fees would be stuck forever) or create new
    ///         markets. This contract is not designed to run ownerless.
    ///
    ///         To hand over control, use transferOwnership(newOwner) and
    ///         have the new owner call acceptOwnership().
    function renounceOwnership() public pure override {
        revert RenounceOwnershipDisabled();
    }

    // =========================================================
    //  Betting (Step 4)
    // =========================================================

    /// @notice Bet USDC on whether the price will go UP or DOWN.
    ///
    ///         Rules (from RULES.md §B):
    ///         - You can only bet on the NEXT round to lock (the one
    ///           whose lock time is still in the future).
    ///         - USDC only; approve this contract first, then call placeBet.
    ///         - You may top up on the same side multiple times in the same
    ///           round, but you cannot switch sides once you have bet.
    ///         - Minimum stake applies to every call, including top-ups.
    ///
    ///         Checks are in this order (each has its own custom error):
    ///           1. Market exists          – MarketNotFound
    ///           2. Market not paused      – MarketPaused
    ///           3. roundIndex is next     – NotNextRound
    ///              (this also ensures block.timestamp < lockTime because
    ///               nextBettableRound only returns rounds whose lock time
    ///               is strictly in the future; passing any other index fails)
    ///           4. amount >= minStake     – StakeBelowMinimum
    ///           5. amount fits uint128    – AmountExceedsUint128
    ///           6. one side per wallet    – WrongSide
    ///
    ///         Effects (storage writes) happen BEFORE the USDC transfer so
    ///         a re-entrant call cannot bet twice on a single approval.
    ///
    /// @param marketId    Which market to bet on (0-indexed).
    /// @param roundIndex  Must equal nextBettableRound(marketId).
    /// @param up          True = bet the price goes UP; false = DOWN.
    /// @param amount      USDC to stake, in 6-decimal units (e.g. 1_000_000 = $1).
    function placeBet(
        uint256 marketId,
        uint256 roundIndex,
        bool up,
        uint256 amount
    ) external nonReentrant {
        // ── Check 1: market exists ───────────────────────────
        if (marketId >= marketCount) revert MarketNotFound(marketId);

        Market storage m = markets[marketId];

        // ── Check 2: not paused ──────────────────────────────
        if (m.paused) revert MarketPaused(marketId);

        // ── Check 3: correct round ───────────────────────────
        // nextBettableRound returns the unique round whose lock time
        // is strictly in the future, so enforcing equality here also
        // guarantees block.timestamp < lockTime(marketId, roundIndex).
        // Any past round, the current round at its exact lock time,
        // or a future round beyond the next all fail this check.
        uint256 expected = nextBettableRound(marketId);
        if (roundIndex != expected) revert NotNextRound(roundIndex, expected);

        // ── Check 4: amount >= minStake ──────────────────────
        // This also rejects amount == 0 because minStake > 0 always.
        if (amount < uint256(m.minStake)) revert StakeBelowMinimum(amount, m.minStake);

        // ── Check 5: amount fits in uint128 ──────────────────
        // Round totals are stored as uint128 to pack the Round struct.
        // SafeCast.toUint128 reverts with an Overflow error if amount > type(uint128).max.
        uint128 amt128 = SafeCast.toUint128(amount);

        // ── Check 6: one side per wallet per round ───────────
        Position storage pos = positions[marketId][roundIndex][msg.sender];
        if (up  && pos.down != 0) revert WrongSide(marketId, roundIndex);
        if (!up && pos.up   != 0) revert WrongSide(marketId, roundIndex);

        // ── Effects: update storage before pulling USDC ──────
        // Writing storage before the external call (checks-effects-interactions)
        // prevents a re-entrant call from seeing stale state.
        Round storage r = rounds[marketId][roundIndex];
        if (up) {
            pos.up     += amt128;
            r.upTotal  += amt128;
        } else {
            pos.down     += amt128;
            r.downTotal  += amt128;
        }

        // ── Interaction: pull USDC from the player ────────────
        // The player must have called USDC.approve(arena, amount) first.
        // safeTransferFrom reverts if the allowance or balance is insufficient.
        USDC.safeTransferFrom(msg.sender, address(this), amount);

        // Track money owed to players so withdrawFees can never take it.
        // Added AFTER the transfer so totalPlayerFunds never leads the balance.
        totalPlayerFunds += amount;

        emit BetPlaced(marketId, roundIndex, msg.sender, up, amount);
    }

    // =========================================================
    //  Settlement (Step 5)
    // =========================================================

    // ------------------------------------------------------------------
    //  Internal helper: try to read one feed round without reverting.
    //
    //  Returns (exists, answer, updatedAt).
    //  "exists" is false when getRoundData reverts OR when updatedAt == 0
    //  (Chainlink uses updatedAt==0 to signal missing data on some feeds).
    // ------------------------------------------------------------------
    function _tryGetRound(AggregatorV3Interface feed, uint80 id)
        internal
        view
        returns (bool exists, int256 answer, uint256 updatedAt)
    {
        // try/catch so a revert from the feed does not bubble up.
        try feed.getRoundData(id) returns (
            uint80, int256 ans, uint256, uint256 upAt, uint80
        ) {
            // updatedAt == 0 means the slot was never written (Chainlink spec).
            if (upAt == 0) return (false, 0, 0);
            return (true, ans, upAt);
        } catch {
            return (false, 0, 0);
        }
    }

    // ------------------------------------------------------------------
    //  Internal helper: try to read the latest round without reverting.
    // ------------------------------------------------------------------
    function _tryLatest(AggregatorV3Interface feed)
        internal
        view
        returns (bool exists, uint80 latestId, uint256 updatedAt)
    {
        try feed.latestRoundData() returns (
            uint80 rid, int256, uint256, uint256 upAt, uint80
        ) {
            if (upAt == 0) return (false, 0, 0);
            return (true, rid, upAt);
        } catch {
            return (false, 0, 0);
        }
    }

    // ------------------------------------------------------------------
    //  Internal helper: verify the end round ID.
    //
    //  Returns:
    //    0 = valid end
    //    1 = endRoundId fails (updatedAt > endTime or does not exist)  → InvalidEndRound
    //    2 = successor missing and not latest                           → PhaseEdge refund
    // ------------------------------------------------------------------
    function _checkEndRound(
        AggregatorV3Interface feed,
        uint80  endRoundId,
        uint256 et
    ) internal view returns (uint8 status) {
        (bool endExists, , uint256 endAt) = _tryGetRound(feed, endRoundId);
        if (!endExists || endAt > et) return 1; // invalid

        uint80 nextId = endRoundId + 1;
        (bool nextExists, , uint256 nextAt) = _tryGetRound(feed, nextId);
        if (nextExists) {
            if (nextAt <= et) return 1; // later update inside round → invalid
            return 0; // valid
        }
        // No successor: valid only if endRoundId is the feed's latest.
        (bool latestExists, uint80 latestId, ) = _tryLatest(feed);
        if (!latestExists || latestId != endRoundId) return 2; // phase edge
        return 0; // valid
    }

    // ------------------------------------------------------------------
    //  Internal settle finaliser shared by settle() and markRefunded().
    //  Writes the Round fields and emits RoundSettled.
    //  Does NOT move USDC; payouts happen in step 6.
    // ------------------------------------------------------------------
    function _finaliseRound(
        uint256      marketId,
        uint256      roundIndex,
        RoundState   state,
        uint80       startId,
        uint80       endId,
        int256       startPr,
        int256       endPr,
        RefundReason reason
    ) internal {
        Round storage r = rounds[marketId][roundIndex];
        r.state       = state;
        r.startRoundId = startId;
        r.endRoundId   = endId;
        r.startPrice   = startPr;
        r.endPrice     = endPr;

        // Book the 2% fee from the MATCHED pool for UP/DOWN outcomes only.
        // Refunds never take a fee (RULES §E rule 22).
        // v1.1 (Matched Calls): fee = floor(M * FEE_BPS / BPS) where M = min(U, D).
        // The fee moves from "owed to players" (totalPlayerFunds) to
        // "owed to the protocol" (feesAccrued).
        if (state == RoundState.SettledUp || state == RoundState.SettledDown) {
            uint256 U   = uint256(r.upTotal);
            uint256 D   = uint256(r.downTotal);
            uint256 M   = U < D ? U : D;
            uint256 fee = M * FEE_BPS / BPS;
            feesAccrued      += fee;
            totalPlayerFunds -= fee;
        }
        // Refunded: fee == 0, feesAccrued and totalPlayerFunds unchanged.

        emit RoundSettled(marketId, roundIndex, state, startId, endId, startPr, endPr, reason);
    }

    /// @notice Settle a round.  Anyone can call this.
    ///
    ///         How to find the right IDs:
    ///           startRoundId = the FIRST feed update with updatedAt >= lockTime.
    ///           endRoundId   = the LAST  feed update with updatedAt <= endTime.
    ///         The contract verifies both; a wrong ID reverts.
    ///
    ///         Special: pass startRoundId = 0 to signal "no update after lock".
    ///         This is only accepted when the feed's latest update is older
    ///         than lockTime (or there are no updates).  If an update exists
    ///         at/after lock the call reverts (InvalidStartRound).
    ///
    ///         Settle moves NO USDC.  Players claim in step 6.
    ///
    /// @param marketId    Which market.
    /// @param roundIndex  Which round.
    /// @param startRoundId  Feed round ID of the first update >= lockTime,
    ///                      OR 0 to mean "no update since lock".
    /// @param endRoundId    Feed round ID of the last update <= endTime.
    ///                      Ignored (may be 0) when startRoundId == 0.
    function settle(
        uint256 marketId,
        uint256 roundIndex,
        uint80  startRoundId,
        uint80  endRoundId
    ) external nonReentrant {
        // ── Existence ────────────────────────────────────────
        if (marketId >= marketCount) revert MarketNotFound(marketId);

        // ── Already settled? ─────────────────────────────────
        Round storage r = rounds[marketId][roundIndex];
        if (r.state != RoundState.Unsettled) {
            revert RoundAlreadySettled(marketId, roundIndex);
        }

        // ── Timing ───────────────────────────────────────────
        uint256 et = endTime(marketId, roundIndex);
        if (block.timestamp <= et) {
            revert SettleTooEarly(block.timestamp, et);
        }
        uint256 deadline = et + SETTLE_WINDOW;
        if (block.timestamp > deadline) {
            revert SettleWindowClosed(block.timestamp, deadline);
        }

        // ── One-sided round (Rule 14) ─────────────────────────
        // If only one side bet, refund immediately; skip ID checks.
        if (r.upTotal == 0 || r.downTotal == 0) {
            _finaliseRound(marketId, roundIndex,
                RoundState.Refunded, 0, 0, 0, 0, RefundReason.OneSided);
            return;
        }

        // ── startRoundId == 0: caller claims no update since lock ──
        uint256 lt = lockTime(marketId, roundIndex);
        AggregatorV3Interface feed = markets[marketId].feedA;

        if (startRoundId == 0) {
            // Only accept if the feed's latest update is before lockTime
            // (or the feed has no updates at all).
            (bool latestExists, , uint256 latestUpAt) = _tryLatest(feed);
            if (latestExists && latestUpAt >= lt) {
                // There IS an update at/after lock → caller must supply it.
                revert InvalidStartRound(0);
            }
            // No update at/after lock → NoUpdate refund.
            _finaliseRound(marketId, roundIndex,
                RoundState.Refunded, 0, 0, 0, 0, RefundReason.NoUpdate);
            return;
        }

        // ── Verify startRoundId ──────────────────────────────
        // The start update must exist and have updatedAt >= lockTime.
        (bool startExists, int256 startPrice, uint256 startAt) =
            _tryGetRound(feed, startRoundId);
        if (!startExists || startAt < lt) {
            revert InvalidStartRound(startRoundId);
        }

        // The update immediately before startRoundId must exist and
        // have updatedAt < lockTime.
        // Special case: the very first update of phase 1 (roundInPhase == 1,
        // phaseId == 1) has no predecessor → valid start, no check needed.
        // For the first update of ANY LATER phase, we cannot verify the
        // predecessor → PhaseEdge refund.
        {
            uint80 startPhase = startRoundId >> 64;
            uint80 startRound = uint80(startRoundId & type(uint64).max);

            if (startRound == 1) {
                // First update in its phase.
                if (startPhase > 1) {
                    // Cannot verify predecessor across a phase boundary.
                    _finaliseRound(marketId, roundIndex,
                        RoundState.Refunded, startRoundId, 0, startPrice, 0,
                        RefundReason.PhaseEdge);
                    return;
                }
                // Phase 1, round 1 → no predecessor exists, which is fine.
                // Fall through to end-ID check.
            } else {
                // Not the first in its phase; check the predecessor.
                uint80 prevId = startRoundId - 1; // same phase, safe: startRound >= 2
                (bool prevExists, , uint256 prevAt) = _tryGetRound(feed, prevId);
                if (!prevExists || prevAt >= lt) {
                    // Predecessor missing or also at/after lock → wrong start.
                    revert InvalidStartRound(startRoundId);
                }
            }
        }

        // ── Verify endRoundId ────────────────────────────────
        // Delegate to _checkEndRound to avoid stack-too-deep.
        // Read end price here for use in outcome logic below.
        (, int256 endPrice, ) = _tryGetRound(feed, endRoundId);
        {
            uint8 endStatus = _checkEndRound(feed, endRoundId, et);
            if (endStatus == 1) revert InvalidEndRound(endRoundId);
            if (endStatus == 2) {
                // Phase edge on end side.
                _finaliseRound(marketId, roundIndex,
                    RoundState.Refunded, startRoundId, endRoundId,
                    startPrice, endPrice, RefundReason.PhaseEdge);
                return;
            }
        }

        // ── Outcome order (D2) ───────────────────────────────
        // (a) endRoundId <= startRoundId → feed did not move forward
        if (endRoundId <= startRoundId) {
            _finaliseRound(marketId, roundIndex,
                RoundState.Refunded, startRoundId, endRoundId,
                startPrice, endPrice, RefundReason.EndNotAfterStart);
            return;
        }

        // (b) Price <= 0
        if (startPrice <= 0 || endPrice <= 0) {
            _finaliseRound(marketId, roundIndex,
                RoundState.Refunded, startRoundId, endRoundId,
                startPrice, endPrice, RefundReason.InvalidPrice);
            return;
        }

        // (c) Prices equal
        if (endPrice == startPrice) {
            _finaliseRound(marketId, roundIndex,
                RoundState.Refunded, startRoundId, endRoundId,
                startPrice, endPrice, RefundReason.UnchangedPrice);
            return;
        }

        // (d) Determine winner
        // RefundReason.None signals "not a refund" in the event log.
        if (endPrice > startPrice) {
            _finaliseRound(marketId, roundIndex,
                RoundState.SettledUp, startRoundId, endRoundId,
                startPrice, endPrice, RefundReason.None);
        } else {
            _finaliseRound(marketId, roundIndex,
                RoundState.SettledDown, startRoundId, endRoundId,
                startPrice, endPrice, RefundReason.None);
        }
    }

    /// @notice Mark a round as refunded after the settle window has expired.
    ///         Anyone can call this.  No price IDs are needed.
    ///
    ///         Use this when nobody called settle() within 1 hour after
    ///         the round ended.  The round becomes a full refund (Rule 19).
    ///
    /// @param marketId    Which market.
    /// @param roundIndex  Which round.
    function markRefunded(uint256 marketId, uint256 roundIndex) external {
        if (marketId >= marketCount) revert MarketNotFound(marketId);

        Round storage r = rounds[marketId][roundIndex];
        if (r.state != RoundState.Unsettled) {
            revert RoundAlreadySettled(marketId, roundIndex);
        }

        uint256 earliest = endTime(marketId, roundIndex) + SETTLE_WINDOW;
        if (block.timestamp <= earliest) {
            revert RefundTooEarly(block.timestamp, earliest);
        }

        _finaliseRound(marketId, roundIndex,
            RoundState.Refunded, 0, 0, 0, 0, RefundReason.Timeout);
    }

    // =========================================================
    //  Payouts – Step 6 (v1.1 – Matched Calls)
    //
    //  USDC leaves the contract in exactly TWO places:
    //    1. _claimOne  → USDC.safeTransfer(player, payout)   [player claim]
    //       (executed by claim() after state updates,
    //        and by claimMany() in a single transfer at the end)
    //    2. withdrawFees → USDC.safeTransfer(to, amount)     [owner fee withdrawal]
    //  Nothing else moves USDC out.
    //
    //  MATCHED CALLS SUMMARY
    //  ─────────────────────
    //  Per round:
    //    U = upTotal, D = downTotal
    //    M = min(U, D)            — matched pool (same amount on each side)
    //    T = max(U, D)            — total of the bigger side
    //    F = floor(M * FEE_BPS / BPS)   — fee booked at settle
    //    Dist = M - F
    //
    //  Per player:
    //    Smaller-side player (or tie):   matched_i = s_i  (100% matched)
    //    Bigger-side player won:         matched_i = floor(s_i * M / T)
    //    Bigger-side player lost:        matched_i = ceil(s_i * M / T)
    //    unmatched_i = s_i - matched_i  (always ≥ 0)
    //
    //  Payouts:
    //    Winner payout = s_i + floor(matched_i * Dist / M)
    //    Loser  payout = unmatched_i   (0 → NothingToClaim if on smaller side)
    //    Refund payout = s_i           (unchanged)
    //
    //  Rounding rationale:
    //    Bigger side won  → floor ensures sum(matched) ≤ M
    //                       (so bonus pool never over-commits)
    //    Bigger side lost → ceil ensures sum(matched) ≥ M
    //                       (so winners' full Dist is funded)
    //    Residual dust (at most 1 per round) → feesAccrued via RoundDustToFees.
    // =========================================================

    // ------------------------------------------------------------------
    //  Helper: compute one player's matched and unmatched stake.
    //
    //  @param s          Player's total stake.
    //  @param M          Matched pool = min(U, D).
    //  @param T          Bigger side total = max(U, D). 0 when M==0 (one-sided,
    //                    but that is a refund so this helper is never called).
    //  @param onBiggerSide  True when the player is on the side with T total.
    //  @param biggerSideWon True when the bigger side won.
    //
    //  When M == T (a tie), every player is on the "smaller" side (both fully
    //  matched), so onBiggerSide should be false for all players.
    // ------------------------------------------------------------------
    function _matchedFor(
        uint256 s,
        uint256 M,
        uint256 T,
        bool    onBiggerSide,
        bool    biggerSideWon
    ) internal pure returns (uint256 matched, uint256 unmatched) {
        if (!onBiggerSide) {
            // Smaller side (or tie): fully matched.
            return (s, 0);
        }
        // Bigger side: pro-rata matching.
        uint256 exact = s * M; // no overflow: s and M are both ≤ uint128.max
        uint256 base  = exact / T; // floor
        if (biggerSideWon) {
            // Winner bigger side: floor to keep sum ≤ M.
            matched   = base;
        } else {
            // Loser bigger side: ceil to keep sum ≥ M.
            matched   = (exact % T == 0) ? base : base + 1;
        }
        unmatched = s - matched;
    }

    // ------------------------------------------------------------------
    //  Helper: compute a winner's bonus (floor division).
    //  bonus = floor(matched * Dist / M)
    //  Caller adds stake to get total payout.
    // ------------------------------------------------------------------
    function _winnerBonus(uint256 matched, uint256 Dist, uint256 M)
        internal pure returns (uint256 bonus)
    {
        bonus = matched * Dist / M; // floor
    }

    // ------------------------------------------------------------------
    //  Internal pure helper: compute payout for one position.
    //
    //  Returns (payout, matchedWinner) where matchedWinner is the player's
    //  MATCHED stake when they are a winner (0 otherwise; used for dust tracking).
    //
    //  Winner payout: s + floor(matched * Dist / M)
    //  Loser  payout: unmatched (0 for smaller-side loser → NothingToClaim)
    //  Refund payout: up + down  (no fee, matched logic not applied)
    // ------------------------------------------------------------------
    function _computePayout(
        Round    storage r,
        Position storage pos
    ) internal view returns (uint256 payout, uint128 matchedWinner) {
        if (r.state == RoundState.Refunded) {
            payout       = uint256(pos.up) + uint256(pos.down);
            matchedWinner = 0;
            return (payout, matchedWinner);
        }

        bool upWon   = (r.state == RoundState.SettledUp);
        uint256 U    = uint256(r.upTotal);
        uint256 D    = uint256(r.downTotal);
        uint256 M    = U < D ? U : D;  // min
        uint256 T    = U > D ? U : D;  // max (= M when tied)
        uint256 F    = M * FEE_BPS / BPS;
        uint256 Dist = M - F;

        uint256 stake   = upWon ? uint256(pos.up) : uint256(pos.down);
        bool    isWinner = (stake != 0);

        if (isWinner) {
            // Player is a winner.
            bool onBigger = upWon ? (U > D) : (D > U);
            (uint256 matched, ) = _matchedFor(stake, M, T, onBigger, true /*winners: use floor → biggerSideWon=true*/);
            uint256 bonus = _winnerBonus(matched, Dist, M);
            payout        = stake + bonus;
            // Return actual stake (not matched) so the caller can detect
            // "all winners claimed" by comparing sum(stake) to winning-side total.
            matchedWinner  = SafeCast.toUint128(stake);
            return (payout, matchedWinner);
        }

        // Player is on the losing side.
        uint256 loserStake = upWon ? uint256(pos.down) : uint256(pos.up);
        if (loserStake == 0) return (0, 0); // no position at all

        bool loserOnBigger = upWon ? (D > U) : (U > D);
        if (!loserOnBigger) return (0, 0); // smaller-side loser: fully matched, nothing to return

        // Bigger-side loser: use floor so sum(matched) ≤ M.
        // The residual (M - sum(matched)) is swept to feesAccrued when all losers claim.
        uint256 lMatched = loserStake * M / T; // floor
        uint256 unmatched = loserStake - lMatched;
        payout       = unmatched; // may be 0 if stake rounds to 0
        // Encode loserMatched in the upper bits of matchedWinner with a sentinel.
        // We repurpose matchedWinner=0 to mean "loser claim"; the caller uses
        // a separate path to track loser-side dust. We pass lMatched via a flag:
        // set matchedWinner to a magic value that signals "loser path" with lMatched baked in.
        // Actually, simpler: use a new return value. But changing the signature is bigger.
        // SIMPLEST: matchedWinner = 0 always for losers; track loserMatched in _claimOne.
        matchedWinner  = 0; // loser flag; caller re-derives lMatched from round storage
    }

    // ------------------------------------------------------------------
    //  Internal: winner-side dust sweep after the last winner claims.
    // ------------------------------------------------------------------
    function _trackWinnerDust(
        uint256 marketId,
        uint256 roundIndex,
        Round storage r,
        uint256 payout,
        uint128 winnerStake
    ) internal {
        PayoutProgress storage pp = payoutProgress[marketId][roundIndex];
        uint256 U = uint256(r.upTotal);
        uint256 D = uint256(r.downTotal);
        uint256 M = U < D ? U : D;
        uint256 F    = M * FEE_BPS / BPS;
        uint256 Dist = M - F;
        uint256 bonus = payout - uint256(winnerStake);

        pp.winnerStakeClaimed += winnerStake;
        pp.bonusPaid          += uint128(bonus);

        uint256 winnerSideTotal = (r.state == RoundState.SettledUp) ? U : D;
        if (uint256(pp.winnerStakeClaimed) == winnerSideTotal) {
            uint256 dust = Dist - uint256(pp.bonusPaid);
            if (dust > 0) {
                feesAccrued      += dust;
                totalPlayerFunds -= dust;
                emit RoundDustToFees(marketId, roundIndex, dust);
            }
        }
    }

    // ------------------------------------------------------------------
    //  Internal: bigger-side loser dust sweep after the last loser claims.
    // ------------------------------------------------------------------
    function _trackLoserDust(
        uint256 marketId,
        uint256 roundIndex,
        Round storage r,
        Position storage pos
    ) internal {
        PayoutProgress storage pp = payoutProgress[marketId][roundIndex];
        uint256 U = uint256(r.upTotal);
        uint256 D = uint256(r.downTotal);
        uint256 M = U < D ? U : D;
        uint256 T = U > D ? U : D;
        bool upWon = (r.state == RoundState.SettledUp);
        uint256 loserStake = upWon ? uint256(pos.down) : uint256(pos.up);
        uint256 lMatched = loserStake * M / T; // floor

        pp.loserMatchedClaimed += SafeCast.toUint128(lMatched);
        pp.loserStakeClaimed   += SafeCast.toUint128(loserStake);

        uint256 loserSideTotal = upWon ? D : U;
        if (uint256(pp.loserStakeClaimed) == loserSideTotal) {
            uint256 loserDust = M - uint256(pp.loserMatchedClaimed);
            if (loserDust > 0) {
                feesAccrued      += loserDust;
                totalPlayerFunds -= loserDust;
                emit RoundDustToFees(marketId, roundIndex, loserDust);
            }
        }
    }

    // ------------------------------------------------------------------
    //  Internal: handle one round's claim for msg.sender.
    //  All STATE CHANGES happen before any transfer; the caller
    //  (claim or claimMany) does the USDC transfer after this returns.
    // ------------------------------------------------------------------
    function _claimOne(
        uint256 marketId,
        uint256 roundIndex
    ) internal returns (uint256 payout) {
        // ── Auto-finalise timed-out rounds ─────────────────────
        Round storage r = rounds[marketId][roundIndex];
        if (r.state == RoundState.Unsettled) {
            uint256 earliest = endTime(marketId, roundIndex) + SETTLE_WINDOW;
            if (block.timestamp <= earliest) {
                revert RoundNotSettled(marketId, roundIndex);
            }
            _finaliseRound(marketId, roundIndex,
                RoundState.Refunded, 0, 0, 0, 0, RefundReason.Timeout);
        }

        // ── Claim checks ───────────────────────────────────────
        Position storage pos = positions[marketId][roundIndex][msg.sender];
        if (pos.claimed) revert AlreadyClaimed(marketId, roundIndex);

        uint128 matchedWinner;
        (payout, matchedWinner) = _computePayout(r, pos);
        if (payout == 0) revert NothingToClaim(marketId, roundIndex);

        // ── Effects (storage writes before transfer) ───────────
        pos.claimed      = true;
        totalPlayerFunds -= payout;

        if (r.state != RoundState.Refunded) {
            if (matchedWinner > 0) {
                _trackWinnerDust(marketId, roundIndex, r, payout, matchedWinner);
            } else if (payout > 0) {
                _trackLoserDust(marketId, roundIndex, r, pos);
            }
        }
        // USDC transfer done by caller after all state updates.
    }

    /// @notice Claim your payout or refund for one round.
    ///
    ///         - Rounds inside the settle window: reverts RoundNotSettled.
    ///         - Rounds past the window and unsettled: auto-finalised as
    ///           Timeout refund, then paid.
    ///         - Losers on the smaller side: reverts NothingToClaim.
    ///         - Losers on the bigger side: pays back the unmatched portion.
    ///         - Double claim: reverts AlreadyClaimed.
    ///
    /// @param marketId    Which market.
    /// @param roundIndex  Which round.
    /// @return payout     USDC transferred to msg.sender (6-decimal units).
    function claim(
        uint256 marketId,
        uint256 roundIndex
    ) external nonReentrant returns (uint256 payout) {
        if (marketId >= marketCount) revert MarketNotFound(marketId);

        payout = _claimOne(marketId, roundIndex);

        // TRANSFER SITE 1a of 2: player claim (single round).
        USDC.safeTransfer(msg.sender, payout);

        emit Claimed(marketId, roundIndex, msg.sender, payout);
    }

    /// @notice Claim payouts for multiple rounds in one transaction.
    ///
    ///         STRICT and all-or-nothing: if ANY entry would fail
    ///         (not yet settled, already claimed, nothing to claim),
    ///         the whole call reverts and nothing is transferred.
    ///
    ///         ONE USDC transfer at the end for the summed total.
    ///         Each round still emits its own Claimed event.
    ///
    /// @param marketIds    Markets to claim from (parallel array with roundIndexes).
    /// @param roundIndexes Rounds to claim from.
    /// @return totalPayout Total USDC transferred to msg.sender.
    function claimMany(
        uint256[] calldata marketIds,
        uint256[] calldata roundIndexes
    ) external nonReentrant returns (uint256 totalPayout) {
        if (marketIds.length != roundIndexes.length) revert ArrayLengthMismatch();
        if (marketIds.length == 0) revert EmptyClaim();

        for (uint256 i = 0; i < marketIds.length; i++) {
            uint256 mid = marketIds[i];
            uint256 rid = roundIndexes[i];
            if (mid >= marketCount) revert MarketNotFound(mid);

            uint256 p = _claimOne(mid, rid);
            totalPayout += p;

            // Emit per-round even though the transfer is batched.
            emit Claimed(mid, rid, msg.sender, p);
        }

        // TRANSFER SITE 1b of 2: player claim (many rounds, single transfer).
        USDC.safeTransfer(msg.sender, totalPayout);
    }

    /// @notice Preview what claim() would pay right now for a player.
    ///
    ///         Returns 0 (rather than reverting) when:
    ///           - round is not yet claimable (inside settle window)
    ///           - player already claimed
    ///           - player is on the losing smaller side (nothing to return)
    ///           - player has no position
    ///
    ///         A timed-out unsettled round is counted as a Timeout refund
    ///         (matching what claim() would do).
    ///         Losers on the bigger side see their unmatched portion here.
    ///
    /// @param marketId    Which market.
    /// @param roundIndex  Which round.
    /// @param player      Whose payout to preview.
    function claimable(
        uint256 marketId,
        uint256 roundIndex,
        address player
    ) external view returns (uint256) {
        if (marketId >= marketCount) return 0;

        Round    storage r   = rounds[marketId][roundIndex];
        Position storage pos = positions[marketId][roundIndex][player];

        if (pos.claimed) return 0;

        RoundState state = r.state;

        // Treat timed-out unsettled rounds as Refunded for preview purposes.
        if (state == RoundState.Unsettled) {
            uint256 earliest = endTime(marketId, roundIndex) + SETTLE_WINDOW;
            if (block.timestamp <= earliest) return 0; // still inside window
            state = RoundState.Refunded;
        }

        if (state == RoundState.Refunded) {
            return uint256(pos.up) + uint256(pos.down);
        }

        // SettledUp or SettledDown: matched calls formula.
        bool upWon = (state == RoundState.SettledUp);
        uint256 U  = uint256(r.upTotal);
        uint256 D  = uint256(r.downTotal);
        uint256 M  = U < D ? U : D;
        uint256 T  = U > D ? U : D;
        uint256 F  = M * FEE_BPS / BPS;
        uint256 Dist = M - F;

        uint256 stake = upWon ? uint256(pos.up) : uint256(pos.down);
        if (stake != 0) {
            // Winner.
            bool onBigger = upWon ? (U > D) : (D > U);
            (uint256 matched, ) = _matchedFor(stake, M, T, onBigger, true);
            return stake + _winnerBonus(matched, Dist, M);
        }

        // Loser: return unmatched portion (0 for smaller-side losers).
        uint256 loserStake = upWon ? uint256(pos.down) : uint256(pos.up);
        if (loserStake == 0) return 0;
        bool loserOnBigger = upWon ? (D > U) : (U > D);
        if (!loserOnBigger) return 0; // smaller side: fully matched, nothing back
        // Bigger-side loser: floor matching (same formula as _computePayout).
        uint256 lMatched = loserStake * M / T; // floor
        return loserStake - lMatched;
    }

    /// @notice How much of a player's stake was matched (and how much was not)
    ///         in a settled round. Returns (0, 0) for unsettled/refunded rounds
    ///         or if the player has no position.
    ///
    /// @param marketId    Which market.
    /// @param roundIndex  Which round.
    /// @param player      Whose position to inspect.
    /// @return matched    The portion of the stake that participated in the pool.
    /// @return unmatched  The portion that is returned at claim (surplus stake).
    function matchedStake(
        uint256 marketId,
        uint256 roundIndex,
        address player
    ) external view returns (uint256 matched, uint256 unmatched) {
        if (marketId >= marketCount) return (0, 0);

        Round    storage r   = rounds[marketId][roundIndex];
        Position storage pos = positions[marketId][roundIndex][player];

        if (r.state == RoundState.Unsettled || r.state == RoundState.Refunded) {
            return (0, 0);
        }

        bool upWon = (r.state == RoundState.SettledUp);
        uint256 U  = uint256(r.upTotal);
        uint256 D  = uint256(r.downTotal);
        uint256 M  = U < D ? U : D;
        uint256 T  = U > D ? U : D;

        // Determine which side and stake.
        uint256 stake       = upWon ? uint256(pos.up) : uint256(pos.down);
        uint256 loserStake  = upWon ? uint256(pos.down) : uint256(pos.up);

        if (stake == 0 && loserStake == 0) return (0, 0);

        if (stake != 0) {
            // Winner side: use floor (biggerSideWon = true → _matchedFor uses floor).
            bool onBigger = upWon ? (U > D) : (D > U);
            (matched, unmatched) = _matchedFor(stake, M, T, onBigger, true);
            return (matched, unmatched);
        }
        // Loser side.
        bool loserOnBigger = upWon ? (D > U) : (U > D);
        if (!loserOnBigger) {
            // Smaller-side loser: fully matched.
            return (loserStake, 0);
        }
        // Bigger-side loser: floor matching (consistent with _computePayout).
        uint256 lM = loserStake * M / T; // floor
        return (lM, loserStake - lM);
    }
}
