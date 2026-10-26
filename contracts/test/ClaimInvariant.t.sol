// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================
//  Kairo Markets – Stateful invariant test (Step 6 v3, v1.1 Matched Calls)
//
//  KEY FIX (v3): the handler now records every feed update it
//  pushes (real id + timestamp), so settleRound and fullCycle
//  can find S*/E* by scanning the recorded list — not by
//  guessing integer IDs 1..200 which don't exist in MockPriceFeed
//  (real ids are (phase<<64)|roundInPhase ≈ 1.8e19).
//
//  Three markets (BTC/ETH/SOL), three independent feeds.
//  Handler has FULL ghost bookkeeping independent of the
//  contract's counters using v1.1 matched calls formula.
//
//  Invariants asserted after EVERY handler call:
//
//   INV-1 (solvency):
//     usdc.balance(arena) >= ghostOwedToPlayers() + arena.feesAccrued()
//
//   INV-2 (exact balance):
//     usdc.balance(arena) == ghostOwedToPlayers() + ghostUnassignedDust()
//                          + arena.feesAccrued()
//
//   INV-3 (totalPlayerFunds tracks liabilities + unassigned dust):
//     arena.totalPlayerFunds() == ghostOwedToPlayers() + ghostUnassignedDust()
//
//   INV-4 (conservation):
//     total deposited == balance + total claimed + total fees withdrawn
// =============================================================

import {Test}            from "forge-std/Test.sol";
import {Vm}              from "forge-std/Vm.sol";
import {PredictionArena} from "../PredictionArena.sol";
import {MockPriceFeed}   from "../mocks/MockPriceFeed.sol";
import {MockUSDC}        from "./MockUSDC.sol";

// =============================================================
//  Handler
// =============================================================
contract ClaimInvariantHandler is Test {

    // ── Arena + tokens ────────────────────────────────────────
    PredictionArena public arena;
    MockUSDC        public usdc;
    address         public owner;

    // ── Three markets with their own feeds ───────────────────
    // BTC: offset 0,    ETH: offset 1200,  SOL: offset 2400
    // All have roundLength 3600.
    uint256[3] public mids;
    MockPriceFeed[3] public feeds;

    // ── Players ───────────────────────────────────────────────
    uint256 constant N_PLAYERS = 4;
    address[4] public players;

    // ── Feed update records (the key fix) ────────────────────
    // Every time we call feed.setPrice() we record the resulting
    // id and timestamp. This lets settleRound brute-force correct
    // S*/E* without scanning non-existent integer IDs.
    struct FeedUpdate {
        uint80  id;
        uint256 updatedAt;
        int256  price;
    }
    // Per market, list of updates in push order (chronological).
    FeedUpdate[][3] internal feedUpdates;

    // ── Ghost bookkeeping ─────────────────────────────────────
    struct RoundKey { uint256 mid; uint256 rnd; }
    RoundKey[] public touchedRounds;
    mapping(uint256 => mapping(uint256 => bool)) public isTouched;

    struct GhostPos { bool hasBet; bool up; }
    mapping(uint256 => mapping(uint256 => mapping(address => GhostPos))) public ghostPos;

    // Conservation ghost vars.
    uint256 public ghostTotalDeposited;
    uint256 public ghostTotalClaimed;
    uint256 public ghostTotalFeesWithdrawn;

    uint256 constant MAX_ROUND = 20;

    // ── Coverage counters ─────────────────────────────────────
    uint256 public betsPlaced;
    uint256 public settledUp;
    uint256 public settledDown;
    // How many times each RefundReason showed up in a RoundSettled event.
    // Index = the enum value: 0 None (a real win), 1 OneSided, 2 NoUpdate,
    // 3 EndNotAfterStart, 4 UnchangedPrice, 5 InvalidPrice, 6 PhaseEdge, 7 Timeout.
    uint256[8] public reasonSeen;
    uint256 public refundCycles;
    uint256 public winnerClaims;
    uint256 public refundClaims;
    uint256 public claimManyOk;
    uint256 public expectedRevertsObserved;
    uint256 public dustEventsSeen;
    uint256 public feeWithdrawals;
    uint256 public overWithdrawReverts;
    uint256 public fullCyclesRun;

    // Snapshot of feesAccrued before each withdrawFees so we can assert
    // the cumulative owner receives <= cumulative fees that existed.
    uint256 public cumulativeFeesAcquired; // fees the handler ever "released"

    // ── Constructor ───────────────────────────────────────────
    constructor(
        PredictionArena _arena,
        MockUSDC        _usdc,
        MockPriceFeed   _feedBtc,
        MockPriceFeed   _feedEth,
        MockPriceFeed   _feedSol,
        address         _owner,
        uint256[3] memory _mids
    ) {
        arena  = _arena;
        usdc   = _usdc;
        owner  = _owner;
        feeds[0] = _feedBtc;
        feeds[1] = _feedEth;
        feeds[2] = _feedSol;
        mids[0]  = _mids[0];
        mids[1]  = _mids[1];
        mids[2]  = _mids[2];
        players[0] = makeAddr("inv_p0");
        players[1] = makeAddr("inv_p1");
        players[2] = makeAddr("inv_p2");
        players[3] = makeAddr("inv_p3");
    }

    // ── Internal helpers ──────────────────────────────────────

    function _fund(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.prank(who);
        usdc.approve(address(arena), amt);
    }

    function _touch(uint256 mid, uint256 rnd) internal {
        if (!isTouched[mid][rnd]) {
            isTouched[mid][rnd] = true;
            touchedRounds.push(RoundKey(mid, rnd));
        }
    }

    /// Push a price to a market feed AND record the resulting ID + timestamp.
    /// This is the only place feeds are written; all other code reads feedUpdates.
    function _pushPrice(uint8 mi, int256 price) internal {
        vm.prank(owner);
        feeds[mi].setPrice(price);
        // Read back the real id and timestamp (authoritative from the feed).
        try feeds[mi].latestRoundData() returns (
            uint80 rid, int256, uint256, uint256 upAt, uint80
        ) {
            feedUpdates[mi].push(FeedUpdate(rid, upAt, price));
        } catch {}
    }

    /// Compute fee = floor(M * FEE_BPS / BPS) where M = min(U, D).
    /// Written independently of contract code.
    function _fee(uint256 U, uint256 D) internal pure returns (uint256) {
        uint256 M = U < D ? U : D;
        return M * 200 / 10_000;
    }

    /// Compute matched stake for one player (ghost version of _matchedFor / contract logic).
    /// Smaller side: fully matched. Bigger side: pro rata, rounded DOWN when the bigger side won
    /// and rounded UP when it lost (so the sum of matched is never above / below M).
    /// Written with its own ceiling division, not by calling the contract.
    function _ghostMatched(
        uint256 s, uint256 M, uint256 T, bool onBigger, bool biggerSideWon
    ) internal pure returns (uint256 matched) {
        if (!onBigger) return s; // smaller side: fully matched
        if (biggerSideWon) return s * M / T; // floor
        return (s * M + T - 1) / T; // ceil
    }

    /// Find S* and E* for a round from the recorded update list.
    /// S* = first update with updatedAt >= lt whose predecessor has updatedAt < lt
    ///      (or is absent). Returns 0 if none.
    /// E* = last update with updatedAt <= et. Returns 0 if none.
    function _findSE(
        uint8 mi, uint256 lt, uint256 et
    ) internal view returns (uint80 S, uint80 E) {
        FeedUpdate[] storage ups = feedUpdates[mi];
        uint256 n = ups.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 at = ups[i].updatedAt;
            if (at >= lt && S == 0) {
                // predecessor check: if i==0 there's no predecessor (ok); else prev must be < lt
                bool predOk = (i == 0) || (ups[i-1].updatedAt < lt);
                if (predOk) S = ups[i].id;
            }
            if (at <= et) E = ups[i].id;
        }
    }

    /// Claim for each player whose seed bit is set.
    function _claimSubset(uint256 mid, uint256 rnd, uint256 seed) internal {
        for (uint256 p = 0; p < 4; p++) {
            if ((seed >> p) % 2 == 0) continue;
            _claimOne(mid, rnd, players[p]);
        }
    }

    /// Claim for one player and update ghost counters + dust counter.
    function _claimOne(uint256 mid, uint256 rnd, address who) internal {
        if (arena.claimable(mid, rnd, who) == 0) return;
        uint256 balBefore = usdc.balanceOf(who);
        vm.recordLogs();
        vm.prank(who);
        try arena.claim(mid, rnd) returns (uint256 payout) {
            ghostTotalClaimed += payout;
            assertEq(usdc.balanceOf(who) - balBefore, payout, "claimOne: delta mismatch");
            (, , , , , , PredictionArena.RoundState st) = arena.rounds(mid, rnd);
            if (st == PredictionArena.RoundState.Refunded) refundClaims++;
            else winnerClaims++;
            _consumeLogs();
        } catch {}
    }

    /// Read (and clear) the recorded logs. Counts RoundDustToFees events and
    /// tallies the refund reason of every RoundSettled event, so the tests can
    /// PROVE the handler really reached each payout / refund path.
    /// Call vm.recordLogs() right before the call you want to inspect.
    function _consumeLogs() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 dustSig    = keccak256("RoundDustToFees(uint256,uint256,uint256)");
        bytes32 settledSig = keccak256(
            "RoundSettled(uint256,uint256,uint8,uint80,uint80,int256,int256,uint8)");
        for (uint256 l = 0; l < logs.length; l++) {
            if (logs[l].topics.length == 0) continue;
            if (logs[l].topics[0] == dustSig) {
                dustEventsSeen++;
            } else if (logs[l].topics[0] == settledSig) {
                // data = (state, startRoundId, endRoundId, startPrice, endPrice, reason)
                (, , , , , uint8 reason) =
                    abi.decode(logs[l].data, (uint8, uint80, uint80, int256, int256, uint8));
                if (reason < 8) reasonSeen[reason]++;
            }
        }
    }

    // ── Ghost liability functions ──────────────────────────────

    function _owedRefunded(uint256 mid, uint256 rnd) internal view returns (uint256 owed) {
        for (uint256 p = 0; p < N_PLAYERS; p++) {
            address who = players[p];
            if (!ghostPos[mid][rnd][who].hasBet) continue;
            (uint128 pUp, uint128 pDown, bool claimed) = arena.positions(mid, rnd, who);
            if (!claimed) owed += uint256(pUp) + uint256(pDown);
        }
    }

    /// Winner's expected payout from matched calls formula.
    function _winnerPayout(uint256 wStake, uint256 M, uint256 T, bool onBigger) internal pure returns (uint256) {
        uint256 F    = M * 200 / 10_000;
        uint256 Dist = M - F;
        uint256 matched = _ghostMatched(wStake, M, T, onBigger, true);
        return wStake + (M == 0 ? 0 : matched * Dist / M);
    }

    /// Loser's expected payout (unmatched portion) from matched calls formula.
    function _loserPayout(uint256 lStake, uint256 M, uint256 T, bool loserOnBigger) internal pure returns (uint256) {
        uint256 lMatched = _ghostMatched(lStake, M, T, loserOnBigger, false);
        return lStake - lMatched;
    }

    function _owedOneSettled(
        uint128 pUp, uint128 pDown,
        bool upWon,
        uint256 U, uint256 D
    ) internal pure returns (uint256) {
        uint256 M = U < D ? U : D;
        uint256 T = U > D ? U : D;
        uint256 winStake = upWon ? uint256(pUp) : uint256(pDown);
        if (winStake != 0) {
            return _winnerPayout(winStake, M, T, upWon ? (U > D) : (D > U));
        }
        uint256 loseStake = upWon ? uint256(pDown) : uint256(pUp);
        if (loseStake == 0) return 0;
        return _loserPayout(loseStake, M, T, upWon ? (D > U) : (U > D));
    }

    function _owedSettled(
        uint256 mid, uint256 rnd, bool upWon, uint256 U, uint256 D
    ) internal view returns (uint256 owed) {
        for (uint256 p = 0; p < N_PLAYERS; p++) {
            address who = players[p];
            if (!ghostPos[mid][rnd][who].hasBet) continue;
            (uint128 pUp, uint128 pDown, bool claimed) = arena.positions(mid, rnd, who);
            if (claimed) continue;
            owed += _owedOneSettled(pUp, pDown, upWon, U, D);
        }
    }

    function ghostOwedToPlayers() public view returns (uint256 owed) {
        for (uint256 i = 0; i < touchedRounds.length; i++) {
            uint256 mid = touchedRounds[i].mid;
            uint256 rnd = touchedRounds[i].rnd;
            (uint128 upT, uint128 dnT, , , , ,
             PredictionArena.RoundState state) = arena.rounds(mid, rnd);

            if (state == PredictionArena.RoundState.Unsettled) {
                owed += uint256(upT) + uint256(dnT);
                continue;
            }
            if (state == PredictionArena.RoundState.Refunded) {
                owed += _owedRefunded(mid, rnd);
                continue;
            }
            bool upWon = (state == PredictionArena.RoundState.SettledUp);
            owed += _owedSettled(mid, rnd, upWon, uint256(upT), uint256(dnT));
        }
    }

    /// Compute ghost unassigned dust for one settled round:
    /// dust = Dist - sum(floor(matched_i * Dist / M)) for ALL winners (claimed or not),
    /// but only if at least one winner hasn't claimed yet (once all claim, dust is in feesAccrued).
    struct DustCtx { uint256 M; uint256 T; bool upWon; bool biggerWon; }

    function _dustParams(
        uint256 mid, uint256 rnd, bool upWon, uint256 U, uint256 D
    ) internal view returns (uint256 totalBonuses, bool anyWinnerUnclaimed) {
        DustCtx memory ctx;
        ctx.M = U < D ? U : D;
        ctx.T = U > D ? U : D;
        ctx.upWon = upWon;
        ctx.biggerWon = upWon ? (U > D) : (D > U);
        return _dustParamsLoop(mid, rnd, ctx);
    }

    function _dustParamsLoop(
        uint256 mid, uint256 rnd, DustCtx memory ctx
    ) internal view returns (uint256 totalBonuses, bool anyWinnerUnclaimed) {
        uint256 M    = ctx.M;
        uint256 Dist = M - M * 200 / 10_000;
        for (uint256 p = 0; p < N_PLAYERS; p++) {
            if (!ghostPos[mid][rnd][players[p]].hasBet) continue;
            (uint128 pU, uint128 pD, bool clmd) = arena.positions(mid, rnd, players[p]);
            uint256 ws = ctx.upWon ? uint256(pU) : uint256(pD);
            if (ws == 0) continue;
            totalBonuses += M == 0 ? 0 : _ghostMatched(ws, M, ctx.T, ctx.biggerWon, true) * Dist / M;
            if (!clmd) anyWinnerUnclaimed = true;
        }
    }

    function ghostUnassignedDust() public view returns (uint256 dust) {
        for (uint256 i = 0; i < touchedRounds.length; i++) {
            dust += _roundDust(touchedRounds[i].mid, touchedRounds[i].rnd);
        }
    }

    function _roundDust(uint256 mid, uint256 rnd) internal view returns (uint256 dust) {
        (uint128 upT, uint128 dnT, , , , ,
         PredictionArena.RoundState state) = arena.rounds(mid, rnd);
        if (state == PredictionArena.RoundState.Unsettled ||
            state == PredictionArena.RoundState.Refunded) return 0;

        bool upWon = (state == PredictionArena.RoundState.SettledUp);
        uint256 U  = uint256(upT);
        uint256 D  = uint256(dnT);
        uint256 M  = U < D ? U : D;

        (uint256 tb, bool anyWinU) = _dustParams(mid, rnd, upWon, U, D);
        if (anyWinU) dust += M - M * 200 / 10_000 - tb; // Dist - tb

        bool loserOnBigger = upWon ? (D > U) : (U > D);
        if (loserOnBigger) {
            dust += _loserSideDust(mid, rnd, upWon, M, U > D ? U : D);
        }
    }

    /// Loser-side dust: sum(ceil(loserStake * M / T)) - M for unclaimed losers on the bigger side.
    /// Only applies when the loser side is the bigger side.
    function _loserSideDust(
        uint256 mid, uint256 rnd, bool upWon,
        uint256 M, uint256 T
    ) internal view returns (uint256) {
        uint256 sumLoserMatched;
        bool anyLoserUnclaimed;
        for (uint256 p = 0; p < N_PLAYERS; p++) {
            if (!ghostPos[mid][rnd][players[p]].hasBet) continue;
            (uint128 pU, uint128 pD, bool clmd) = arena.positions(mid, rnd, players[p]);
            uint256 loseStake = upWon ? uint256(pD) : uint256(pU);
            if (loseStake == 0) continue;
            sumLoserMatched += (loseStake * M + T - 1) / T; // ceil
            if (!clmd) anyLoserUnclaimed = true;
        }
        if (!anyLoserUnclaimed) return 0;
        return sumLoserMatched - M;
    }

    // ── Handler actions ───────────────────────────────────────

    // ─── FREE-FORM BET ────────────────────────────────────────

    /// Place a bet for a random player on a random market.
    function bet(
        uint8   marketIdx,
        uint8   playerIdx,
        bool    up,
        uint128 amount
    ) external {
        marketIdx = uint8(bound(marketIdx, 0, 2));
        playerIdx = uint8(bound(playerIdx, 0, 3));
        uint256 mid = mids[marketIdx];
        address who = players[playerIdx];
        uint256 amt = bound(uint256(amount), 100_000, 5_000_000);

        uint256 rnd = arena.nextBettableRound(mid);
        if (rnd == 0 || rnd > MAX_ROUND) return;

        (uint128 pUp, uint128 pDown, bool clmd) = arena.positions(mid, rnd, who);
        if (clmd) return;
        if (up  && pDown != 0) return;
        if (!up && pUp   != 0) return;

        _fund(who, amt);
        vm.prank(who);
        try arena.placeBet(mid, rnd, up, amt) {
            betsPlaced++;
            ghostTotalDeposited += amt;
            _touch(mid, rnd);
            ghostPos[mid][rnd][who] = GhostPos(true, up);
        } catch { /* excess/invalid bet; no state change */ }
    }

    // ─── FULL CYCLE (the guided action that hits SettledUp/Down) ──────────

    /// Places UP + DOWN bets from multiple players on market `mi`, then:
    ///   warps past lock, pushes start price, pushes end price (higher or lower
    ///   based on `seed`), warps past end, settles with correct ids, and lets
    ///   a random subset claim.
    ///
    /// Bet sizes are prime-ish to ensure rounding dust occurs.
    function fullCycle(uint8 marketIdx, uint256 seed) external {
        marketIdx = uint8(bound(marketIdx, 0, 2));
        uint8   mi  = marketIdx;
        uint256 mid = mids[mi];

        uint256 rnd = arena.nextBettableRound(mid);
        if (rnd == 0 || rnd > MAX_ROUND) return;

        // Must be before lock to place bets.
        if (block.timestamp >= arena.lockTime(mid, rnd)) return;

        // Bet amounts: prime-ish to ensure rounding dust.
        // UP: p0=100_003, p1=200_011  DOWN: p2=130_007, p3=170_003
        uint256[4] memory amts = [uint256(100_003), 200_011, 130_007, 170_003];
        bool[4]    memory ups  = [true, true, false, false];
        for (uint256 p = 0; p < 4; p++) {
            address who = players[p];
            (uint128 pUp, uint128 pDown, bool clmd) = arena.positions(mid, rnd, who);
            if (clmd || pUp != 0 || pDown != 0) continue;
            _fund(who, amts[p]);
            vm.prank(who);
            try arena.placeBet(mid, rnd, ups[p], amts[p]) {
                betsPlaced++;
                ghostTotalDeposited += amts[p];
                _touch(mid, rnd);
                ghostPos[mid][rnd][who] = GhostPos(true, ups[p]);
            } catch {}
        }

        _fullCycleSettle(mi, rnd, seed);
    }

    /// Extracted to avoid stack-too-deep in fullCycle.
    function _fullCycleSettle(uint8 mi, uint256 rnd, uint256 seed) internal {
        uint256 mid = mids[mi];
        uint256 lt  = arena.lockTime(mid, rnd);
        uint256 et  = arena.endTime(mid, rnd);

        if (block.timestamp < lt) vm.warp(lt + 1);
        _pushPrice(mi, 50_000e8); // start price

        uint256 midTime = lt + (et - lt) / 2;
        if (block.timestamp < midTime) vm.warp(midTime);

        bool upWins = (seed % 2 == 0);
        _pushPrice(mi, upWins ? int256(51_000e8) : int256(49_000e8)); // end price

        if (block.timestamp <= et) vm.warp(et + 1);

        (uint80 S, uint80 E) = _findSE(mi, lt, et);
        if (S == 0 || E == 0) return;

        (, , , , , , PredictionArena.RoundState stBefore) = arena.rounds(mid, rnd);
        if (stBefore != PredictionArena.RoundState.Unsettled) return;

        vm.recordLogs();
        try arena.settle(mid, rnd, S, E) {
            (, , , , , , PredictionArena.RoundState stAfter) = arena.rounds(mid, rnd);
            if (stAfter == PredictionArena.RoundState.SettledUp)   settledUp++;
            if (stAfter == PredictionArena.RoundState.SettledDown) settledDown++;
            fullCyclesRun++;
            _consumeLogs();
        } catch { return; }

        _claimSubset(mid, rnd, seed);
    }

    // ─── REFUND CYCLE (guided: every refund path, then everyone claims) ──────

    /// Runs one whole round that ENDS IN A REFUND, then lets every player claim.
    /// seed % 6 picks the reason:
    ///   0 Timeout           nobody settles; the claim itself finalises the refund
    ///   1 OneSided          only UP players bet
    ///   2 UnchangedPrice    start price == end price
    ///   3 NoUpdate          the feed is silent for the whole round
    ///   4 InvalidPrice      the start price is zero
    ///   5 EndNotAfterStart  only ONE feed update lands inside the round
    /// Bet sizes are the same prime-ish numbers as fullCycle.
    function refundCycle(uint8 marketIdx, uint256 seed) external {
        marketIdx = uint8(bound(marketIdx, 0, 2));
        uint8   mi  = marketIdx;
        uint256 mid = mids[mi];

        uint256 rnd = arena.nextBettableRound(mid);
        if (rnd == 0 || rnd > MAX_ROUND) return;
        if (block.timestamp >= arena.lockTime(mid, rnd)) return;

        uint256 kind = seed % 6;
        _placeCycleBets(mid, rnd, kind == 1);
        _runRefundKind(mi, mid, rnd, kind);
        refundCycles++;

        // Everybody tries to claim (losers and strangers are skipped by _claimOne).
        for (uint256 p = 0; p < 4; p++) _claimOne(mid, rnd, players[p]);
    }

    /// Two UP players and two DOWN players bet (or only the two UP players).
    function _placeCycleBets(uint256 mid, uint256 rnd, bool oneSided) internal {
        uint256[4] memory amts = [uint256(100_003), 200_011, 130_007, 170_003];
        bool[4]    memory ups  = [true, true, false, false];
        for (uint256 p = 0; p < 4; p++) {
            if (oneSided && !ups[p]) continue;
            address who = players[p];
            (uint128 pUp, uint128 pDown, bool clmd) = arena.positions(mid, rnd, who);
            if (clmd || pUp != 0 || pDown != 0) continue;
            _fund(who, amts[p]);
            vm.prank(who);
            try arena.placeBet(mid, rnd, ups[p], amts[p]) {
                betsPlaced++;
                ghostTotalDeposited += amts[p];
                _touch(mid, rnd);
                ghostPos[mid][rnd][who] = GhostPos(true, ups[p]);
            } catch {}
        }
    }

    /// Move time and the feed so the round ends with the wanted refund reason.
    function _runRefundKind(uint8 mi, uint256 mid, uint256 rnd, uint256 kind) internal {
        uint256 lt = arena.lockTime(mid, rnd);
        uint256 et = arena.endTime(mid, rnd);

        if (kind == 0) {
            // Timeout: settle window (1 hour) closes with nobody settling.
            vm.warp(et + 1 hours + 1);
            return;
        }
        if (kind == 1 || kind == 3) {
            // OneSided (ids ignored) / NoUpdate (startRoundId = 0): no price needed.
            vm.warp(et + 1);
            _settleAndTally(mid, rnd, 0, 0);
            return;
        }

        // Kinds 2, 4, 5 put prices inside the round.
        vm.warp(lt + 1);
        if (kind == 2) {
            _pushPrice(mi, 50_000e8);
            vm.warp(lt + (et - lt) / 2);
            _pushPrice(mi, 50_000e8);              // same price again
        } else if (kind == 4) {
            _pushPrice(mi, 0);                     // zero start price
            vm.warp(lt + (et - lt) / 2);
            _pushPrice(mi, 50_000e8);
        } else {
            _pushPrice(mi, 50_000e8);              // the only update in the round
        }
        vm.warp(et + 1);
        (uint80 S, uint80 E) = _findSE(mi, lt, et);
        if (S == 0 || E == 0) return;
        _settleAndTally(mid, rnd, S, E);
    }

    function _settleAndTally(uint256 mid, uint256 rnd, uint80 S, uint80 E) internal {
        vm.recordLogs();
        try arena.settle(mid, rnd, S, E) {
            _consumeLogs();
        } catch {}
    }

    // ─── FREE-FORM WARP ───────────────────────────────────────

    /// Warp forward by 1-7200 seconds (can cross round boundaries + windows).
    function warpForward(uint32 delta) external {
        vm.warp(block.timestamp + bound(delta, 1, 7200));
    }

    // ─── FREE-FORM PRICE PUSH ─────────────────────────────────

    /// Push a random price (sometimes zero or negative for refund coverage).
    function pushPrice(uint8 marketIdx, int128 price) external {
        marketIdx = uint8(bound(marketIdx, 0, 2));
        _pushPrice(uint8(marketIdx), int256(price));
    }

    // ─── SETTLE ───────────────────────────────────────────────

    /// Settle any eligible round using the correct IDs found by scanning
    /// the recorded update list. Also attempts wrong IDs for revert coverage.
    function settleRound(uint8 marketIdx, uint256 roundIdx, bool attemptWrong) external {
        marketIdx = uint8(bound(marketIdx, 0, 2));
        roundIdx  = bound(roundIdx, 1, MAX_ROUND);
        uint256 mi  = marketIdx;
        uint256 mid = mids[mi];

        uint256 et = arena.endTime(mid, roundIdx);
        if (block.timestamp <= et) return;
        if (block.timestamp > et + 1 hours) return;

        (, , , , , , PredictionArena.RoundState state) = arena.rounds(mid, roundIdx);
        if (state != PredictionArena.RoundState.Unsettled) return;

        uint256 lt = arena.lockTime(mid, roundIdx);

        // Optionally try a wrong start ID first (must revert, change nothing).
        if (attemptWrong && feedUpdates[mi].length > 0) {
            uint80 wrongId = feedUpdates[mi][0].id + 999_999;
            uint256 balBefore = usdc.balanceOf(address(arena));
            try arena.settle(mid, roundIdx, wrongId, wrongId) {
                // should have reverted — note it but let invariants catch it
            } catch {
                expectedRevertsObserved++;
                assertEq(usdc.balanceOf(address(arena)), balBefore,
                    "wrong-id settle changed balance");
            }
        }

        // Find correct S*/E*.
        (uint80 S, uint80 E) = _findSE(uint8(mi), lt, et);

        if (S == 0) {
            // No update at/after lock: settle with (0, 0) → NoUpdate refund.
            vm.recordLogs();
            try arena.settle(mid, roundIdx, 0, 0) {
                _touch(mid, roundIdx);
                (, , , , , , PredictionArena.RoundState st) = arena.rounds(mid, roundIdx);
                if (st == PredictionArena.RoundState.SettledUp)   settledUp++;
                if (st == PredictionArena.RoundState.SettledDown) settledDown++;
                _consumeLogs();
            } catch {}
        } else if (E == 0) {
            // S exists but E doesn't (no update at or before et): nothing to do.
        } else {
            vm.recordLogs();
            try arena.settle(mid, roundIdx, S, E) {
                _touch(mid, roundIdx);
                (, , , , , , PredictionArena.RoundState st) = arena.rounds(mid, roundIdx);
                if (st == PredictionArena.RoundState.SettledUp)   settledUp++;
                if (st == PredictionArena.RoundState.SettledDown) settledDown++;
                _consumeLogs();
            } catch {}
        }
    }

    // ─── MARK REFUNDED ────────────────────────────────────────

    function markRefundedRound(uint8 marketIdx, uint256 roundIdx) external {
        marketIdx = uint8(bound(marketIdx, 0, 2));
        roundIdx  = bound(roundIdx, 1, MAX_ROUND);
        uint256 mid = mids[marketIdx];

        (, , , , , , PredictionArena.RoundState state) = arena.rounds(mid, roundIdx);
        if (state != PredictionArena.RoundState.Unsettled) return;
        if (block.timestamp <= arena.endTime(mid, roundIdx) + 1 hours) return;
        try arena.markRefunded(mid, roundIdx) { _touch(mid, roundIdx); } catch {}
    }

    // ─── CLAIM ────────────────────────────────────────────────

    function claimForPlayer(
        uint8 playerIdx, uint8 marketIdx, uint256 roundIdx
    ) external {
        playerIdx = uint8(bound(playerIdx, 0, 3));
        marketIdx = uint8(bound(marketIdx, 0, 2));
        roundIdx  = bound(roundIdx, 1, MAX_ROUND);
        address who = players[playerIdx];
        uint256 mid = mids[marketIdx];

        if (arena.claimable(mid, roundIdx, who) == 0) return;

        uint256 balBefore = usdc.balanceOf(who);

        vm.recordLogs();
        vm.prank(who);
        try arena.claim(mid, roundIdx) returns (uint256 p) {
            ghostTotalClaimed += p;
            assertEq(usdc.balanceOf(who) - balBefore, p, "claim: delta mismatch");

            (, , , , , , PredictionArena.RoundState st) = arena.rounds(mid, roundIdx);
            if (st == PredictionArena.RoundState.Refunded) refundClaims++;
            else winnerClaims++;
            _consumeLogs();
        } catch {}
    }

    function claimManyForPlayer(
        uint8   playerIdx,
        uint8   m0, uint256 r0,
        uint8   m1, uint256 r1
    ) external {
        playerIdx = uint8(bound(playerIdx, 0, 3));
        address who = players[playerIdx];

        uint256[2] memory _m = [mids[bound(m0,0,2)], mids[bound(m1,0,2)]];
        uint256[2] memory _r = [bound(r0,1,MAX_ROUND), bound(r1,1,MAX_ROUND)];

        uint256[] memory callMids = new uint256[](2);
        uint256[] memory callRnds = new uint256[](2);
        uint256 cnt;
        for (uint256 i = 0; i < 2; i++) {
            if (arena.claimable(_m[i], _r[i], who) == 0) continue;
            bool dup;
            for (uint256 j = 0; j < cnt; j++) {
                if (callMids[j] == _m[i] && callRnds[j] == _r[i]) { dup = true; break; }
            }
            if (dup) continue;
            callMids[cnt] = _m[i];
            callRnds[cnt] = _r[i];
            cnt++;
        }
        if (cnt == 0) return;
        assembly { mstore(callMids, cnt) mstore(callRnds, cnt) }

        uint256 balBefore = usdc.balanceOf(who);
        vm.recordLogs();
        vm.prank(who);
        try arena.claimMany(callMids, callRnds) returns (uint256 total) {
            claimManyOk++;
            ghostTotalClaimed += total;
            assertEq(usdc.balanceOf(who) - balBefore, total, "claimMany: delta mismatch");
            _consumeLogs();
        } catch {}
    }

    // ─── FEE WITHDRAWAL ───────────────────────────────────────

    function ownerWithdrawFees(uint256 amount) external {
        uint256 fa = arena.feesAccrued();
        if (fa == 0) return;
        amount = bound(amount, 1, fa);
        cumulativeFeesAcquired += fa; // upper bound for what owner was ever allowed
        uint256 balBefore = usdc.balanceOf(owner);
        vm.prank(owner);
        try arena.withdrawFees(owner, amount) {
            feeWithdrawals++;
            ghostTotalFeesWithdrawn += amount;
            assertEq(usdc.balanceOf(owner) - balBefore, amount, "withdrawFees: delta");
        } catch {}
    }

    function attemptOverWithdraw() external {
        uint256 fa = arena.feesAccrued();
        uint256 balBefore = usdc.balanceOf(address(arena));
        vm.prank(owner);
        try arena.withdrawFees(owner, fa + 1) {
            assertTrue(false, "over-withdrawal should have reverted");
        } catch {
            overWithdrawReverts++;
            assertEq(usdc.balanceOf(address(arena)), balBefore,
                "over-withdrawal changed balance");
        }
    }
}

// =============================================================
//  Invariant test harness
// =============================================================
contract ClaimInvariantTest is Test {

    PredictionArena       arena;
    MockUSDC              usdc;
    MockPriceFeed         feedBtc;
    MockPriceFeed         feedEth;
    MockPriceFeed         feedSol;
    ClaimInvariantHandler handler;
    address               owner = makeAddr("inv_owner");

    uint256 constant MIN = 100_000;

    function setUp() public {
        // Start at t=1 so BTC offset 0 round 0 starts immediately.
        vm.warp(1);

        vm.startPrank(owner);
        usdc    = new MockUSDC();
        feedBtc = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / BTC");
        feedEth = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / ETH");
        feedSol = new MockPriceFeed(owner, 8, "TEST PRICES - NOT REAL DATA / SOL");
        arena   = new PredictionArena(address(usdc), owner);

        uint256[3] memory _mids;
        _mids[0] = arena.marketCount();
        arena.createMarket("BTC/USD", address(feedBtc), address(0), 3600, 0,    uint128(MIN));
        _mids[1] = arena.marketCount();
        arena.createMarket("ETH/USD", address(feedEth), address(0), 3600, 1200, uint128(MIN));
        _mids[2] = arena.marketCount();
        arena.createMarket("SOL/USD", address(feedSol), address(0), 3600, 2400, uint128(MIN));
        vm.stopPrank();

        handler = new ClaimInvariantHandler(
            arena, usdc, feedBtc, feedEth, feedSol, owner, _mids
        );

        targetContract(address(handler));
    }

    // ── Invariant 1: solvency ──────────────────────────────────────────

    function invariant_solvency() public view {
        uint256 bal  = usdc.balanceOf(address(arena));
        uint256 owed = handler.ghostOwedToPlayers();
        uint256 fa   = arena.feesAccrued();
        assertTrue(bal >= owed + fa,
            "INV-1: insolvent (balance < ghostOwed + feesAccrued)");
    }

    // ── Invariant 2: exact balance ─────────────────────────────────────

    function invariant_exactBalance() public view {
        uint256 bal  = usdc.balanceOf(address(arena));
        uint256 owed = handler.ghostOwedToPlayers();
        uint256 dust = handler.ghostUnassignedDust();
        uint256 fa   = arena.feesAccrued();
        assertEq(bal, owed + dust + fa,
            "INV-2: balance != ghostOwed + ghostDust + feesAccrued");
    }

    // ── Invariant 3: totalPlayerFunds matches ghost ────────────────────

    function invariant_totalPlayerFundsMatchesGhost() public view {
        uint256 tpf  = arena.totalPlayerFunds();
        uint256 owed = handler.ghostOwedToPlayers();
        uint256 dust = handler.ghostUnassignedDust();
        assertEq(tpf, owed + dust,
            "INV-3: totalPlayerFunds != ghostOwed + ghostDust");
    }

    // ── Invariant 4: conservation ──────────────────────────────────────

    function invariant_conservation() public view {
        uint256 deposited = handler.ghostTotalDeposited();
        uint256 bal       = usdc.balanceOf(address(arena));
        uint256 claimed   = handler.ghostTotalClaimed();
        uint256 withdrawn = handler.ghostTotalFeesWithdrawn();
        assertEq(deposited, bal + claimed + withdrawn,
            "INV-4: conservation violated");
    }

    // =========================================================
    //  Handler coverage proofs
    //
    //  An invariant campaign only means something if its handler really reaches
    //  the money paths (a handler that silently does nothing would make every
    //  invariant pass for the wrong reason - this already happened once). These
    //  ordinary tests drive the handler by hand and check, against numbers worked
    //  out BY HAND (not computed by the contract), that wins, the exact fee, dust,
    //  every refund reason and batch claims all happen, and that all four
    //  invariants hold after every single step.
    // =========================================================

    function _checkAll() internal view {
        invariant_solvency();
        invariant_exactBalance();
        invariant_totalPlayerFundsMatchesGhost();
        invariant_conservation();
    }

    /// BTC round 1: UP bettors p0 100_003 and p1 200_011, DOWN bettors p2 130_007
    /// and p3 170_003.  seed 14 => UP wins (seed%2==0); p1,p2,p3 try to claim (p0 skipped).
    ///
    ///   U=300_014, D=300_010; M=300_010; T=300_014
    ///   F=floor(300_010*200/10_000)=6_000; Dist=294_010
    ///   UP bigger side (won, floor):
    ///     p1 matched=floor(200_011*300_010/300_014)=200_008; bonus=floor(200_008*294_010/300_010)=196_007; payout=396_018
    ///     p0 matched=floor(100_003*300_010/300_014)=100_001; bonus=floor(100_001*294_010/300_010)=98_001;  payout=198_002
    ///   DOWN smaller side (lost, fully matched, unmatched=0): NothingToClaim (p2,p3)
    ///
    ///   Sum bonuses = 196_007+98_001 = 294_008; dust = Dist-sum = 2.
    ///   dust swept when p0 claims (last winner): feesAccrued = 6_000+2 = 6_002.
    ///
    ///   NOTE: p0's payout = stake + bonus = 100_003 + 98_001 = 198_004 (stake 100_003, bonus 98_001)
    ///   Wait: matched=100_001, bonus=floor(100_001*294_010/300_010).
    ///   100_001*294_010=29_401_294_010; /300_010 floor = 98_001 (rem 14_000). payout=198_002? No:
    ///   stake=100_003, matched=100_001, bonus=floor(100_001*294_010/300_010)=98_001, payout=100_003+98_001=198_004. ✓
    function test_handlerCoverage_upWin_exactNumbers() public {
        handler.fullCycle(0, 14);
        _checkAll();
        assertEq(handler.settledUp(), 1, "one UP win settled");
        assertEq(arena.feesAccrued(), 6_000, "fee booked at settle");
        // p1 (UP winner) got paid; p2,p3 (DOWN smaller side losers) get nothing.
        assertEq(usdc.balanceOf(handler.players(1)), 396_018, "p1 payout");
        assertEq(usdc.balanceOf(handler.players(2)), 0, "smaller-side loser p2 gets nothing");
        assertEq(usdc.balanceOf(handler.players(3)), 0, "smaller-side loser p3 gets nothing");
        assertEq(arena.feesAccrued(), 6_000, "no dust yet: p0 has not claimed");

        handler.claimForPlayer(0, 0, 1);
        _checkAll();
        assertEq(usdc.balanceOf(handler.players(0)), 198_004, "p0 payout (stake 100_003 + bonus 98_001)");
        assertEq(arena.feesAccrued(), 6_002, "dust (2) moved to fees when last winner (p0) claims");
        assertGe(handler.dustEventsSeen(), 1, "dust event seen");
        assertEq(handler.reasonSeen(0), 1, "the win was logged with reason None");
        assertEq(arena.totalPlayerFunds(), 0, "everything owed has been paid");
        assertEq(usdc.balanceOf(address(arena)), 6_002, "only fees remain in the contract");
    }

    /// ETH round 1 (needs t >= 1200 so round 1 is the next one): same bets, DOWN wins.
    ///   U=300_014, D=300_010; M=300_010; T=300_014
    ///   F=6_000; Dist=294_010
    ///   DOWN smaller side (won, fully matched):
    ///     p2 matched=130_007; bonus=floor(130_007*294_010/300_010)=127_406; payout=257_413
    ///     p3 matched=170_003; bonus=floor(170_003*294_010/300_010)=166_603; payout=336_606
    ///   UP bigger side (lost, rounded UP):
    ///     p0 ceil(100_003*300_010/300_014)=ceil(100_001.67)=100_002; unmatched=1; payout=1
    ///     p1 ceil(200_011*300_010/300_014)=ceil(200_008.33)=200_009; unmatched=2; payout=2
    ///   Winner dust=1 (after p2+p3 both claim); loserDust=1 (100_002+200_009-300_010=1).
    ///   feesAccrued = 6_000+1+1 = 6_002.
    ///   All four players claim (seed 15=0b1111).
    function test_handlerCoverage_downWin_exactNumbers() public {
        vm.warp(1300);
        handler.fullCycle(1, 15);
        _checkAll();
        assertEq(handler.settledDown(), 1, "one DOWN win settled");
        assertEq(usdc.balanceOf(handler.players(2)), 257_413, "p2 payout");
        assertEq(usdc.balanceOf(handler.players(3)), 336_606, "p3 payout");
        // p0 and p1 are bigger-side losers; unmatched = stake - ceil(stake*M/T).
        assertEq(usdc.balanceOf(handler.players(0)), 1, "p0 (bigger-side loser): unmatched=100_003-100_002=1");
        assertEq(usdc.balanceOf(handler.players(1)), 2, "p1 (bigger-side loser): unmatched=200_011-200_009=2");
        // feesAccrued = fee(6_000) + winner-dust(1) + loser-dust(1) = 6_002.
        assertEq(arena.feesAccrued(), 6_002, "fee 6_000 + winner dust 1 + loser dust 1");
        assertEq(arena.totalPlayerFunds(), 0, "everything owed has been paid");
        assertEq(usdc.balanceOf(address(arena)), 6_002, "only fees remain in the contract");
    }

    /// One refund round for each of the six refund reasons on BTC, then everyone claims.
    /// Refunds take no fee, so the contract must end up completely empty.
    function test_handlerCoverage_everyRefundReason() public {
        for (uint256 k = 0; k < 6; k++) {
            handler.refundCycle(0, k);
            _checkAll();
        }
        assertEq(handler.refundCycles(), 6, "six refund rounds ran");
        assertGe(handler.reasonSeen(1), 1, "OneSided refund seen");
        assertGe(handler.reasonSeen(2), 1, "NoUpdate refund seen");
        assertGe(handler.reasonSeen(3), 1, "EndNotAfterStart refund seen");
        assertGe(handler.reasonSeen(4), 1, "UnchangedPrice refund seen");
        assertGe(handler.reasonSeen(5), 1, "InvalidPrice refund seen");
        assertGe(handler.reasonSeen(7), 1, "Timeout refund seen");
        assertGe(handler.refundClaims(), 6, "refund claims happened");
        assertEq(handler.winnerClaims(), 0, "no winner claims in refund rounds");
        assertEq(arena.feesAccrued(), 0, "refunds take no fee");
        assertEq(arena.totalPlayerFunds(), 0, "all refunds paid");
        assertEq(usdc.balanceOf(address(arena)), 0, "contract is empty");
    }

    /// Two UP-win rounds leave p0 with two unclaimed wins; p0 claims both in ONE transaction.
    /// seed=14 → UP wins; p1,p2,p3 try to claim after each cycle (p0 doesn't).
    /// After each cycle p1 (winner) claims; DOWN players (smaller side) get nothing.
    /// p0 claimMany across both rounds triggers dust-sweep for each: feesAccrued = 2*6_002.
    function test_handlerCoverage_claimMany() public {
        handler.fullCycle(0, 14);   // BTC round 1
        handler.fullCycle(0, 14);   // BTC round 3 (time has moved on)
        assertEq(handler.settledUp(), 2, "two UP wins settled");
        handler.claimManyForPlayer(0, 0, 1, 0, 3);
        _checkAll();
        assertEq(handler.claimManyOk(), 1, "one claimMany call succeeded");
        assertEq(usdc.balanceOf(handler.players(0)), 2 * 198_004, "p0 got both payouts");
        assertEq(arena.feesAccrued(), 2 * 6_002, "fee 6_000 + dust 2 = 6_002 per round, two rounds");
        assertEq(arena.totalPlayerFunds(), 0, "everything owed has been paid");
    }
}
