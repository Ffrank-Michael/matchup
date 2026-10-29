# Kairo Markets

Kairo Markets is an UP/DOWN prediction market on [Arc](https://docs.arc.io). In each round, players put a small amount of USDC on whether a price (BTC/USD, ETH/USD or SOL/USD) goes **UP** or **DOWN**. When the round ends, the price feed decides the result. Everyone on the losing side's money is shared among the winners in proportion to their stakes. The fee is 2% of winnings (it is taken from the losing side's money before it is shared out). If you lose or get refunded, you pay no fee.

Players can be real users, the project's own AI agents, or anyone else's agents. Any wallet can call.

**Live site: https://www.kairomarkets.xyz** (also at https://kairomarkets.vercel.app)

> **Status: under construction. Arc testnet only. Not audited. Do not use real money.**

## How it works (short version)

- **Start price fairness:** the start price is only pushed from a Bitfinex quote made at least 30 seconds after the lock, so it is never a stale pre-lock price (see docs/RULES.md, H2).
- **Rounds** run back to back. On **testnet** they are **10 minutes** long: BTC rounds lock at :00, ETH at :03, SOL at :06 of every 10 minutes. A 1-hour setting (BTC :00, ETH :20, SOL :40) is kept for mainnet later. The contract is the same either way; the length is just a setting chosen when the markets are created.
- **Calling** is open until a round's lock time. Calls after lock are refused.
- **Prices** come from an on-chain price feed that follows Chainlink's standard interface. The settler passes in the two feed round IDs and the contract checks the timestamps itself, so no server is trusted. On testnet the feed is a clearly labeled **test feed with test prices**. The runner fills it with the real current BTC, ETH and SOL prices from the free Bitfinex API (the last trade; about 3 prices per round per market: start, middle, end; the website shows the live price from the same Bitfinex markets, so what people see is what decides the round), so testnet rounds look like the real market. They are still test prices: the testnet feed is not a real Chainlink feed and its description says "TEST PRICES - NOT REAL DATA". Prices come from [Bitfinex](https://www.bitfinex.com).
- **Refunds** (no fee) happen if only one side has calls, the price is unchanged, the feed did not update during the round, or nobody settles within 1 hour.
- **The owner can only withdraw collected fees.** There is no function to withdraw the pot, and ownership can never be renounced.

The full, approved rules are in [`docs/RULES.md`](docs/RULES.md). That file is the source of truth.

## Project layout

| Path | What it is |
|---|---|
| `contracts/PredictionArena.sol` | The main contract |
| `contracts/interfaces/AggregatorV3Interface.sol` | Chainlink's standard price-feed interface |
| `contracts/test/` | Foundry tests |
| `contracts/script/` | Deployment helpers (used in the deploy step) |
| `docs/RULES.md` | The approved rules |

## Build plan

1. Rules approved
2. Contract skeleton: done
3. Ownership safety: two-step transfer, renounce disabled
4. Calling
5. Mock test feed, price checks and settle
6. Payouts, refunds and claims
7. Full tests against every rule
8. Deploy to Arc testnet with Arc Studio
9. Small test run
10. Later (planned, not built): four house agents on Circle developer-controlled wallets, a paid x402 data feed (other agents pay a little USDC to read round history and agent track records), a round runner, and the website. See `docs/RULES.md` section H.

## Secrets

Private keys go in a `.env` file only (copy `.env.example` to `.env` and fill it in). `.env` is listed in `.gitignore` so it never reaches GitHub. Never paste a private key into code, chat or a commit.
