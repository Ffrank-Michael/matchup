# Kairo Markets

Call the next move of BTC, ETH or SOL: **UP** or **DOWN**. Put in a few dollars of USDC. When the round ends, the price decides. It runs on [Arc](https://docs.arc.io), where USDC is also the gas token, so one balance does everything.

> **Beta. Not audited. Use small amounts.** [FILL IN before submitting: which network the live site points at, and the mainnet contract address.]

- Live app: [FILL IN: Vercel link]
- Contract on Arc mainnet: [FILL IN: address + explorer.arc.io link]
- Example mainnet transaction: [FILL IN: hash + explorer.arc.io link]
- Arc Studio project: https://studio.arc.io/app/a8e053bb-4ebd-4ed7-bde8-7be48ef04a5b
- Video: [FILL IN]

## How a round works

1. Rounds run back to back. You can only call the **next** round, before it locks.
2. You pick one side (UP or DOWN) and an amount. The minimum is $0.50. One side per wallet per round.
3. When the round locks, the start price is fixed: the first price update at or after the lock. The end price is the last update at or before the end.
4. Higher than the start: UP wins. Lower: DOWN wins.
5. You claim your money from the site. Claims never expire.

## Only matched money plays

Your money plays against the other side. If one side has more, the extra comes back. Winners double the money that played, minus 2%.

Example: $10 on UP and $6 on DOWN. Only $6 on each side is matched. The extra $4 on UP is returned to the UP callers (pro rata) whether they win or lose. If UP wins, each matched dollar wins 98 cents. If DOWN wins, the matched UP money is lost, nothing more.

The fee is 2% of the matched money, taken from winnings only. If you lose or get a refund you pay no fee.

## Refunds (no fee)

You get your full stake back if: only one side has money, the price did not change, the price feed gave no usable update, or nobody settled the round within an hour. [CONFIRM the exact list against docs/RULES.md before publishing.]

## The agents

Four house agents make calls with their own wallets, so you can watch how different ideas do, and **back** one: tap "Back this agent" and your call copies its side.

| Agent | Idea |
|---|---|
| Trend Follower | Goes with the recent direction. |
| Contrarian | Takes the side with less money, so rounds have two sides. |
| Chart Reader | Reads 1-minute candles. Never skips: when the signals disagree it follows the last candle. |
| Coin Flipper | Picks at random. A baseline to compare the others against. |

## What the owner can and cannot do

- Can: withdraw collected fees, pause one market, replace the owner (two steps).
- Cannot: touch the money in a round, change the fee (it is fixed at 2%), or give up ownership by accident. [CONFIRM mainnet price-feed trust statement once decided: see docs/SUBMISSION.md, "Mainnet plan v2".]

## Layout

| Path | What it is |
|---|---|
| `contracts/PredictionArena.sol` | The contract (the code name of Kairo Markets' contract) |
| `contracts/test/` | Foundry tests |
| `web/` | The website (Next.js) |
| `runner/` | The round runner: pushes prices, settles rounds, runs the agents |
| `agents/` | The four agents' decision rules |
| `scripts/` | Deploy and check scripts |
| `docs/RULES.md` | The approved rules (source of truth) |
| `docs/MATCHED_CALLS.md` | The matched-calls payout rule, with worked numbers |

## Run it yourself

```bash
# the site (testnet by default)
cd web && npm install && npm run dev

# tests that need no chain
node --test runner/*.test.mjs scripts/*.test.mjs agents/*.test.mjs
```

Contract tests run with Foundry (`forge test`) and run on GitHub Actions for every push. Secrets go in `.env` only (copy `.env.example`); `.env` is never committed.

## How it was built

[CONFIRM each line before submitting. Be exact about what Arc Studio did.]

- The smart contract was written and tested in Arc Studio, then deployed to Arc mainnet.
- More tests (311 at the last run) and deliberate-break checks run on GitHub Actions.
- The website, the runner and the agents were built with Claude Code.
- The website's onchain parts (wallet, call, claim) were [built in Arc Studio / written locally: FILL IN].

## License

MIT. [Add LICENSE file when the repo goes public.]
