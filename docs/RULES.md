# Kairo Markets: approved rules (v1)

Project name: **Kairo Markets** (always spelled with a K). The contract is named `PredictionArena`; that name stays.

Approved by the project owner. This file is the source of truth for the contract.
Network: Arc testnet only for now. USDC: `0x3600000000000000000000000000000000000000`, 6 decimals (ERC-20 view only; never use the 18-decimal native view or msg.value).

## A. Markets and timing
1. Three markets: BTC/USD, ETH/USD, SOL/USD. Each market stores: its own price feed (feedA), a second feed slot (feedB, empty/zero for now, reserved for head-to-head markets like SOL vs BTC), round length, start offset, minimum stake.
2. Rounds are 1 hour and run back-to-back. Round `k` of a market locks at `startOffset + k * roundLength` and ends at `lockTime + roundLength` (so the end of round k is the lock of round k+1). Offsets are relative to the unix epoch, which is hour-aligned. **Mainnet option (1 hour):** BTC 0 (:00), ETH 1200 (:20), SOL 2400 (:40). **Testnet deploy (changed): 10-minute rounds** (600 s), BTC 0 (:00), ETH 180 (:03), SOL 360 (:06) of every 10 minutes. Only the deploy settings differ (`node scripts/deploy.mjs --rounds 10min`, the default, or `--rounds 1h`); the contract is unchanged (it accepts any round length of 5 minutes or more).
3. Round length is a per-market setting, so 10 minutes or 24 hours can be added later as new markets.
4. Once a market is created, its feeds, round length, offset and min stake NEVER change. To change anything, create a new market. No setters for these.

## B. Betting
5. A player bets UP or DOWN on the NEXT round to lock only. Betting for round k opens when round k-1 locks and closes at round k's lock time. A bet at `block.timestamp >= lockTime` is refused.
6. USDC only (6-decimal ERC-20 token). Players `approve` first, then bet via `transferFrom`.
7. Minimum stake per market, set at creation (suggested 0.10 USDC = 100000 units).
8. A wallet may add to its stake in a round but only on ONE side per round. Any wallet (EOA or contract) may bet.

## C. Prices
9. The contract only talks to a price feed through Chainlink's standard AggregatorV3Interface (`latestRoundData`, `getRoundData`, `decimals`, `description`, `version`). On mainnet it is a real Chainlink feed; on testnet it is a mock feed with the same interface.
10. START price = the first feed update with `updatedAt >= lockTime`. END price = the last feed update with `updatedAt <= endTime`.
11. Anyone can call settle once `block.timestamp > endTime` (strictly after). The settler passes two round IDs and the contract verifies them itself:
    - start round: `updatedAt >= lockTime` AND the round immediately before it has `updatedAt < lockTime`.
    - end round: `updatedAt <= endTime` AND the round immediately after it has `updatedAt > endTime` (or does not exist yet).
    - So exactly one valid pair exists; a settler cannot cheat; no server is trusted.
12. Because the start price comes from an update after lock, nobody can know it while betting is open.
13. The testnet mock feed is clearly labeled "TEST PRICES - NOT REAL DATA" in its code comments and its `description()`. Only the owner can set its prices.

## D. Full refund, no fee
14. Only one side has bets.
15. The price is unchanged (end price == start price).
16. The end update is the SAME AS or EARLIER than the start update (`endRoundId <= startRoundId`). This is what happens when the feed does not update during the round.
17. There was no update at or after lock before the round ended.
18. A price is zero or negative.
19. Nobody settled within 1 hour after the round ended (`block.timestamp > endTime + 1 hours` and not settled). After that, settling is closed and everyone can claim a refund.
20. Edge case: the start or end update is the first round of a Chainlink "phase" (so the neighbouring update cannot be verified). The round is refunded.

## D2. Settle details (step 5)
- **Window:** `settle` works only when `endTime < block.timestamp <= endTime + 1 hour`. Before that it reverts (too early); after that it reverts (window closed). After the window, anyone may call `markRefunded` (works only when `block.timestamp > endTime + 1 hour` and the round is still unsettled) and the round becomes a full refund.
- `settle(marketId, roundIndex, startRoundId, endRoundId)` can be called once per round. A one-sided round (rule 14) becomes a refund without looking at the IDs.
- **Start ID check:** the update must exist, `updatedAt >= lockTime`, and the update just before it must exist and have `updatedAt < lockTime`. Wrong ID => revert (`InvalidStartRound`).
- **End ID check:** the update must exist, `updatedAt <= endTime`, and the update just after it must have `updatedAt > endTime`, OR it is the feed's latest update. Wrong ID => revert (`InvalidEndRound`).
- **`startRoundId = 0` means "there is no update at or after lock yet".** It is accepted only if the feed's latest update is older than `lockTime` (or the feed has no updates); then the round is refunded at once (rule 17). If an update at/after lock exists, the call reverts.
- **Phases (rule 20):** a Chainlink round ID is `(phaseId << 64) | roundInPhase`. The very first update of phase 1 has no predecessor and is valid. The first update of a later phase (cannot verify its predecessor), or an end update whose successor is missing but which is not the latest (a phase change), makes the round a refund (`PhaseEdge`). Refund is the safe outcome; nobody loses money.
- **Outcome order:** (a) one side only => refund; (b) `endRoundId <= startRoundId` => refund; (c) either price `<= 0` => refund; (d) prices equal => refund; (e) else higher end price => UP wins, lower => DOWN wins.
- The 2% fee (losing side only, rounded down) is added to `feesAccrued` at settle time for UP/DOWN outcomes only. Refunds book no fee. (Rule 23's leftover dust is handled in step 6.)
- A settle emits `RoundSettled` with the state, both round IDs, both prices and the refund reason.

## D3. Test price feed (step 5)
- `MockPriceFeed` lives in `contracts/mocks/` (it WILL be deployed to testnet). It implements AggregatorV3Interface. Its `description()` starts with "TEST PRICES - NOT REAL DATA".
- **Where the testnet prices come from:** the round runner pushes the REAL current BTC/ETH/SOL USD prices (CoinGecko free keyless API, one request for all three, about 1 push a minute per market). They are still TEST PRICES: the contract and the feed description say so. If the price API fails, the runner pushes nothing (it never invents a price), and the contract refunds any round without a usable update.
- Only the owner can call `setPrice(int256)`. The owner chooses the price value ONLY; `updatedAt` and `startedAt` are always `block.timestamp`. There is no function that takes a timestamp, so it can never be set or backdated.
- Round IDs follow Chainlink: `(phaseId << 64) | roundInPhase`, starting at phase 1, round 1, and rising by 1 per update. Timestamps never go down.
- `getRoundData` for an ID that does not exist reverts ("No data present"), like Chainlink. `latestRoundData` reverts if there is no update yet.
- The owner may set any int256 price (including 0 or negative) so refund cases can be tested. `startNewPhase()` (owner only) simulates a Chainlink feed upgrade (next update gets ID `(phase+1) << 64 | 1`).

## E. Payouts
21. Winners get their full stake back plus a share of the losing side's total, in proportion to their stake on the winning side.
22. Fee = 2% of winnings. If you lose or get refunded, you pay no fee. Technically: 2% of the LOSING side's total (fixed constant `FEE_BPS = 200`), taken out before the winners share it. Never taken from anyone's own stake or from refunds.
23. Rounding is always down. Leftover dust goes to the fee balance so no USDC is stuck.
24. Pull-based: each player claims their own payout or refund. The contract never pushes money out to a list of players. (Arc blocklists some addresses; one blocked wallet must not freeze anyone else.)

## E2. Claim details (step 6)
- **Who/what:** `claim(marketId, roundIndex)` pays `msg.sender` ONLY (nobody can claim for someone else, nobody can redirect a payout). Pull-based, one USDC transfer per call.
- **Payout formula:** let W = winning side's total, L = losing side's total, F = floor(L * 200 / 10000) (booked to fees at settle), D = L - F. A winner who staked `s` on the winning side receives `s + floor(s * D / W)`. A refunded round pays back EXACTLY the player's stake (`up + down`), no fee.
- **Losers get nothing:** a player with no stake on the winning side (or no position) gets `NothingToClaim` (revert).
- **Once only:** after a successful claim the position is marked claimed; a second claim reverts `AlreadyClaimed`.
- **Not yet settled:** inside the settle window (or before) an unsettled round reverts `RoundNotSettled`. Once `block.timestamp > endTime + SETTLE_WINDOW` and the round is still unsettled, `claim` itself finalises the round as a Timeout refund (same as `markRefunded`) and then pays the refund, so nobody needs to call `markRefunded` first.
- **Dust (rule 23):** per round the contract tracks the total winning stake already claimed and the total bonus already paid. When the LAST winning stake is claimed (claimed stake == W), the leftover `D - bonusPaid` is added to `feesAccrued` (event `RoundDustToFees`, only if > 0). Until then it stays in the contract.
- **No expiry, no sweep (rule 3):** unclaimed winnings and refunds stay claimable forever. No function lets the owner (or anyone else) move unclaimed player money. USDC can leave the contract in exactly two places: a player's own `claim`/`claimMany`, and the owner's `withdrawFees`.
- **`claimMany(uint256[] marketIds, uint256[] roundIndexes)`:** claims several rounds for `msg.sender` in one transaction. Arrays must have equal length (`ArrayLengthMismatch`). STRICT and all-or-nothing: if any entry would fail (not settled, already claimed, nothing to claim) the whole call reverts. It makes ONE USDC transfer of the summed payouts at the end. Empty arrays revert.
- **`claimable(marketId, roundIndex, player)`** is a view returning what `claim` would pay right now (0 if settled-loser, already claimed, no position, or round not yet claimable; a timed-out unsettled round counts as a refund).
- **Money accounting:** `totalPlayerFunds` = all USDC the contract owes players or may still owe them: +amount on every bet, -F at settle (moves to fees), -payout on every claim, -dust when dust moves to fees. INVARIANT at all times: `USDC.balanceOf(contract) >= totalPlayerFunds + feesAccrued`. `withdrawFees` additionally reverts (`FeesWouldTouchPlayerFunds`) unless the balance AFTER the withdrawal is still >= `totalPlayerFunds` (defence in depth: the owner can never dip into players' money even if accounting had a bug).

## F. Owner powers and limits
25. The owner CAN: create markets, pause a market (no new bets; existing bets and settlement unaffected), withdraw collected fees only.
26. The owner CANNOT: withdraw the pot, change a market's feed/length/offset/min stake, change a round's result, cancel a round. No function exists for any of these.
27. The contract holds all money. Only settled results, refunds and fee withdrawals move USDC out. The ONLY owner-reachable USDC transfer out is `withdrawFees`, capped at `feesAccrued`.

25a. Ownership is TWO-STEP: the owner nominates a new owner with `transferOwnership`, and nothing changes until the nominee calls `acceptOwnership`. Until then the old owner keeps all powers.
25b. `renounceOwnership` is DISABLED (it always reverts), so ownership can never be given up by accident and leave fees stuck and markets uncreatable.

## G. Built for later
28. Head-to-head markets (feedB set) compare each price's percentage move. Not built yet.
29. Pyth can be added later as a second price-source type (it needs a signed price passed in at settle time). Adding it must not require changing the pot/payout code.

## Decisions made on the owner's behalf (approved)
- Bet on the next round only, not rounds further ahead.
- One side per wallet per round.
- Minimum stake 0.10 USDC.
- Market settings locked once created.

## H. Plan after deploy (NOT built yet; do not build until the owner says so)
- **House agents:** four agents, named **Agent 1 · Trend Follower, Agent 2 · Contrarian, Agent 3 · Streak Hunter, Agent 4 · Coin Flipper** that place their own bets so every market has activity. The decision logic is written and tested in `agents/` (pure logic, no wallets or blockchain calls): each agent gets recent prices and the bets already in the round and returns BET (UP or DOWN, a stake, a one-line reason with real numbers) or SKIP. Each agent uses a **Circle developer-controlled wallet**, so we hold no raw agent private keys. The `.env` file holds only the Circle API key and entity secret (see `.env.example`), never in git.
- **Paid data feed (x402):** a small web service where other agents pay a small amount of USDC per request to read **round history** and **agent track records**. It uses Circle's **x402** tools on Arc (HTTP 402 "payment required", paid with USDC through Circle's Gateway nanopayments). Free to read on-chain; the paid feed is the convenient, already-indexed version.
- **Round runner (code written, tested on a pretend chain, NOT yet run against the real contract):** in `runner/`. `plan.mjs` decides what to do each tick, `simulate.mjs` replays hours of pretend time, `chain.mjs` reads the chain, `wallets.mjs` sends transactions (agents through Circle, test prices and settles from the deployer wallet), `run.mjs` is the command line (dry run by default; `--live` sends real testnet transactions). A script that pushes test prices to the mock feeds and settles rounds on schedule (testnet only; mainnet will use real Chainlink feeds). It also runs the house agents (approved order within each round): the trend follower, streak hunter and coin flipper bet EARLY in the round; the contrarian bets LAST, about 2 minutes before lock, so there is a crowd to bet against. **Testnet timing (10-minute rounds):** early agents bet 1 minute after a round opens, the contrarian about 2 minutes before lock, and a price is pushed about every minute (a start price just after lock, one a minute in between, an end price 30 seconds before the end). **Real prices:** `realPrices.mjs` fetches the real BTC/ETH/SOL prices from CoinGecko (free keyless API, about 10 to 30 calls a minute allowed, shared per IP; the runner makes about one a minute; a failed call means no push, never a made-up number). The random walk in `priceWalk.mjs` is used only by the pretend-chain simulation. An agent that finds nothing to act on skips the round. The runner also enforces one side per wallet per round (an agent that already bet UP in a round never bets DOWN in it).
- **Website:** leaderboard, rounds, and explorer links. Users connect their own wallets; the site never holds keys.
- **Ownership:** on testnet the deployer wallet is the owner. Later it is handed to the owner's personal wallet with the two-step transfer (`transferOwnership`, then `acceptOwnership` from the new wallet).

## Build plan (one small step at a time)
3. Contract skeleton (markets, rounds, positions, owner/fees, time math) - done.
3b. Ownership safety (two-step transfer, renounce disabled) and rename to Kairo Markets - done.
4. Betting (`placeBet`) - done.
5. Test feed + settle - done.
6. Payouts: `claim`, `claimMany`, dust, money-accounting invariant, mutation check (see E2) - done, signed off.
7. Tests against every rule above - done (see `docs/TEST_MAP.md`).
8. Deploy to Arc testnet with Arc Studio.
9. Small test run.
