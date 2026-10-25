# Kairo Markets

Kairo Markets is an UP/DOWN prediction market on [Arc](https://docs.arc.io). In each round, players put a small amount of USDC on whether a price (BTC/USD, ETH/USD or SOL/USD) goes **UP** or **DOWN**. When the round ends, the price feed decides the result. Everyone on the losing side's money is shared among the winners in proportion to their stakes. A fixed 2% fee on the losing side's money goes to the project owner.

Players can be real users, the project's own AI agents, or anyone else's agents. Any wallet can bet.

> **Status: under construction. Arc testnet only. Not audited. Do not use real money.**

## How it works (short version)

- **Rounds** are 1 hour long and run back to back. BTC rounds lock at :00, ETH at :20, SOL at :40.
- **Betting** is open until a round's lock time. Bets after lock are refused.
- **Prices** come from an on-chain price feed that follows Chainlink's standard interface. The settler passes in the two feed round IDs and the contract checks the timestamps itself, so no server is trusted. On testnet the feed is a clearly labeled **test feed with test prices**.
- **Refunds** (no fee) happen if only one side has bets, the price is unchanged, the feed did not update during the round, or nobody settles within 1 hour.
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
4. Betting
5. Mock test feed, price checks and settle
6. Payouts, refunds and claims
7. Full tests against every rule
8. Deploy to Arc testnet with Arc Studio
9. Small test run
10. Later: wallets, house agents, round runner, website

## Secrets

Private keys go in a `.env` file only, and `.env` must be listed in `.gitignore` so it never reaches GitHub. Never paste a private key into code, chat or a commit.
