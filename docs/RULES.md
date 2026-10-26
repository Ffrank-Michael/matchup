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
- **Where the testnet prices come from:** the round runner pushes the REAL current BTC/ETH/SOL USD prices (the last trade on Bitfinex, free public API, see H4). **Two pushes per round per market (rule H5):** a start price (the first trade after the lock, usually within seconds) and an end price (the last trade, 15 seconds before the end). Nothing in the middle. The website shows the live price from the same Bitfinex markets (websocket), not from the chain, so what people see is what decides the round. They are still TEST PRICES: the contract and the feed description say so. If the price API fails, the runner pushes nothing (it never invents a price), and the contract refunds any round without a usable update.
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
- **Round runner (code written, tested on a pretend chain, NOT yet run against the real contract):** in `runner/`. `plan.mjs` decides what to do each tick, `simulate.mjs` replays hours of pretend time, `chain.mjs` reads the chain, `wallets.mjs` sends transactions (agents through Circle, test prices and settles from the deployer wallet), `run.mjs` is the command line (dry run by default; `--live` sends real testnet transactions). A script that pushes test prices to the mock feeds and settles rounds on schedule (testnet only; mainnet will use real Chainlink feeds). It also runs the house agents (approved order within each round): the trend follower, streak hunter and coin flipper bet EARLY in the round; the contrarian bets LAST, about 2 minutes before lock, so there is a crowd to bet against. **Testnet timing (10-minute rounds):** early agents bet 1 minute after a round opens, the contrarian about 2 minutes before lock, and about 3 prices are pushed per round (start price about 90 seconds after lock, one in the middle, an end price 30 seconds before the end). **Real prices:** `exchangePrices.mjs` fetches the real BTC/ETH/SOL last-trade prices from Bitfinex (free public API, see H4; at most one call per market every 5 seconds, only when about to push; a failed call means no push, never a made-up number). The random walk in `priceWalk.mjs` is used only by the pretend-chain simulation. An agent that finds nothing to act on skips the round. The runner also enforces one side per wallet per round (an agent that already bet UP in a round never bets DOWN in it).
- **Website:** leaderboard, rounds, and explorer links. Users connect their own wallets; the site never holds keys. Planned pieces (NOT built yet):
  - **Live price chart per market** with a **countdown to lock**. The live price comes straight from Bitfinex (the site does not read it from the chain, so it updates smoothly between the few on-chain pushes), and it is the SAME price source the runner uses for the start, middle and end prices (H4). Every place that shows a market's price shows the same number. Credit Bitfinex in the footer.
  - **Once the start price is recorded (usually within seconds of the lock), a flat line on the chart at the start price**, so people can see whether UP or DOWN is currently winning. Between lock and then, the chart shows the live price with a note "start price being recorded".
  - **Next to the UP and DOWN buttons:** "UP wins if the end price is higher than the start price. The start price is the first live trade after calling closes, so nobody can know it in advance." Also the fee wording: "2% of winnings. If you lose or get refunded, you pay no fee."
  - **Every round shows its start and end price, the time each was recorded, the source, and a link to the Arc explorer transaction that posted it.** The chain stores the price and the block time of each push; the source and the exchange's own quote time are NOT on chain, so the runner saves a small public log of every push. **Built:** `runner/priceLog.mjs` writes one JSON line per live push to `data/price-log.jsonl` (market, round, kind start/mid/end, price, source Bitfinex, the time the price was asked for (Bitfinex's clock), the time of the trade, block time recorded, tx hash, block number, feed address, explorer link, label "TEST PRICES - NOT REAL DATA"). Nothing secret is in it. The file is not committed; before the site goes live it has to be published somewhere the site can read (decided later). The site combines that log with the on-chain data. Labelled "TEST PRICES" on testnet.
  - The start price is the first Bitfinex trade at least 2 seconds after the lock (see H5; usually 5 to 15 s after the lock, longer on a quiet market). The flat line appears as soon as it is recorded, and the site says "start price recorded at hh:mm:ss" once it exists. The site must NOT describe the start price as "the price at lock".
- **Ownership:** on testnet the deployer wallet is the owner. Later it is handed to the owner's personal wallet with the two-step transfer (`transferOwnership`, then `acceptOwnership` from the new wallet).

## H2. Price timing and fairness (testnet, decided)
- **(History: this section was written for CoinGecko, which lagged. The source is now Bitfinex, see H4; the timings below stay as approved.)**
- **The risk:** CoinGecko's free prices lagged the market. If the START price were pushed seconds after lock from a quote made before the lock, someone watching a live exchange just before lock would already know which way the round is leaning.
- **Measured (2026-10-25, 36 samples over 20 minutes, calm market):** CoinGecko refreshes its prices about once a minute (41 to 71 seconds between refreshes). When asked, a quote was 13 to 89 seconds old (median 51, 90% within 75, 95% within 83). Its price differed from Bitstamp's at the same moment by 0.03% to 0.05% on average (0.14% at most). A faster market or a different hour may look different, so the rules below do not depend on these numbers staying true.
- **Rule for the START price (replaced by H5, now built):** the runner asks Bitfinex for the oldest trade at or after lock + 2 s, every few seconds (never more than once per 5 seconds per market), and pushes it as soon as it exists. So a start price is always a trade from after betting closed.
- **END price:** no extra delay needed. Betting on a round is closed at its lock, so nobody can use a late or slightly stale end price to bet on that round. The end price is pushed 30 seconds before the end, from a quote no older than 3 minutes (otherwise nothing is pushed and the last earlier price is used).
- **If Bitfinex is down or too slow:** no price is invented. A round with no usable update is refunded (rule 14 and D2).

## H3. Cost of running the testnet (estimate; measured gas from the CI run, 25 gwei, gas paid in USDC)
| What | Gas (measured) | USDC each | Per hour |
|---|---|---|---|
| Price push (deployer wallet) | about 90,000 | about 0.0023 | 54 pushes: about 0.12 |
| Settle (deployer wallet) | about 158,000 | about 0.0040 | 18 settles: about 0.07 |
| Bet (agent wallet) | about 127,000 | about 0.0032 | up to 18 per agent: about 0.06 |
| Claim (agent wallet) | about 81,000 | about 0.0020 | |
Deployer wallet total: about 0.19 USDC an hour (about 4.6 a day), so the roughly 24.8 USDC left after the deploy lasts about 5 days. Each of the other three agents also needs a little gas (about 0.08 USDC an hour per agent, plus the money they stake). Gas figures come from Foundry on Arc's tooling and the gas price from the deploy dry run; the real cost is measured after the deploy.

## Build plan (one small step at a time)
3. Contract skeleton (markets, rounds, positions, owner/fees, time math) - done.
3b. Ownership safety (two-step transfer, renounce disabled) and rename to Kairo Markets - done.
4. Betting (`placeBet`) - done.
5. Test feed + settle - done.
6. Payouts: `claim`, `claimMany`, dust, money-accounting invariant, mutation check (see E2) - done, signed off.
7. Tests against every rule above - done (see `docs/TEST_MAP.md`).
8. Deploy to Arc testnet with Arc Studio.
9. Small test run.

## H4. Price source: Bitfinex (decided 2026-10-25)
- **One source for everything.** The website and the runner both use the last trade on Bitfinex's BTC/USD, ETH/USD and SOL/USD markets. The site shows it live; the runner pushes it as the start, middle and end price. So the number people watch is the number that decides the round, and every place on the site shows the same number (the site has one shared feed, `web/lib/price-feed.ts`, and everything reads from it).
- **How the site gets it:** Bitfinex's public websocket `wss://api-pub.bitfinex.com/ws/2`, channel `candles`, keys `trade:1m:tBTCUSD`, `tETHUSD`, `tSOLUSD`. It first sends the last 240 one-minute candles (4 hours), then a message on every trade. Price = close of the newest candle = last trade. The same feed gives the last-hour line and the 1-minute candles. It runs in the visitor's browser, so it works from Vercel without any server; Bitfinex's REST API does not allow browser calls (no CORS), which is why the site uses the websocket.
- **How the runner gets it:** `runner/exchangePrices.mjs`, REST `GET https://api-pub.bitfinex.com/v2/trades/tBTCUSD/hist?limit=1` (newest trade: price and time). The quote time is Bitfinex's own clock (HTTP Date header); the runner refuses to push if this PC's clock is more than 2 minutes off, or if a market has had no trade for 15 minutes.
- **Limits (Bitfinex docs):** public websocket: 20 new connections a minute per IP and 25 channels per connection (the site uses 1 connection with 3 channels, and reconnects with a 3 s to 30 s back-off). Public REST: between 10 and 90 requests a minute per IP depending on the endpoint, and a 60 second block if exceeded (the runner asks at most once every 5 seconds per market, only when it is about to push, about 3 times per round per market). Use is under Bitfinex's API Terms of Service. Free, no key.
- **Honest limit:** the price is the last trade, so it changes only when somebody trades. On a busy market that is several times a second; in a quiet hour it can be every few seconds (measured on a quiet Sunday evening: BTC about 1 trade every 6 s, ETH about 1 every 8 s, SOL about 1 every 30 s). Nothing is invented in between.
- **Tested from the owner's PC (2026-10-25):** Bitfinex and Bitstamp connect; Coinbase, Kraken, Binance (global and .vision), OKX, Bybit, Gemini, Bitget and Crypto.com did not. Bitstamp works too but has fewer trades (BTC 3 in 40 s, ETH none). CoinGecko is no longer used anywhere.

## H5. Start and end price timing (decided 2026-10-26; supersedes H2's delays; built in the runner 2026-10-26)
- **Start price** = the first Bitfinex trade whose own time is at least 2 s after the lock, pushed as soon as it is seen (usually 5 to 15 s after the lock; up to 30 to 45 s for SOL when quiet). If none has arrived by 25% of the round, no start price is recorded and the round refunds. Because the trade happens after calling closes, nobody can know it when they call.
- **End price** = the last trade, pushed 15 s before the end. No mid-round push (testnet or mainnet).
- **How it is built:** `runner/exchangePrices.mjs` `quote(market, { firstTradeAfter })` asks Bitfinex for `limit=1&sort=1&start=<ms>` (the oldest trade at or after that moment) and stamps the price with that trade's own time; `runner/plan.mjs` `priceDue()` says 'start' from lock + 2 s until 25% of the round, and 'end' from 15 s before the end; `tickDelay()` makes the runner look every 3 s (instead of 10 s) while a price is due. Tests: `runner/runner.test.mjs`, `runner/exchangePrices.test.mjs`, `runner/priceLog.test.mjs`.
- Reason: H2's 90 s delay and 30 s quote margin were for CoinGecko's lag (up to 89 s). With Bitfinex's own last trade that lag is gone; the last trade can still be 10 to 30 s old when asked (measured), so the rule filters on the trade's time, not the quote's.
