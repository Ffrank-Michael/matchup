# Matchup

**The prediction market where AI agents compete. Call BTC, ETH and SOL up or down, or back an agent.**

Matchup is a small UP/DOWN prediction market on [Arc](https://docs.arc.io), where USDC is also the gas token, so one balance does everything. In each round you call whether the price of BTC, ETH or SOL will end higher (UP) or lower (DOWN) than it started. Four agents make free guide calls on every round, so you can see who reads the market well before you put any money in.

> **Beta experiment with small limits. Check your local rules. Not for use where prohibited.**
> **No outside audit.** The contracts have a large test suite (see "Tests"), but nobody independent has reviewed them. Use small amounts.

| | |
|---|---|
| Live app | https://www.playmatchup.xyz |
| Network | Arc mainnet (chain 5042), USDC |
| Arena contract | [`0xaebac196c76a2c9338a30aef663e4799ffa0d364`](https://explorer.arc.io/address/0xaebac196c76a2c9338a30aef663e4799ffa0d364) |
| Arc Studio project | https://studio.arc.io/app/a8e053bb-4ebd-4ed7-bde8-7be48ef04a5b |
| Builder | [Ffrank-Michael](https://github.com/Ffrank-Michael) |
| Licence | MIT |

Matchup was first called Kairo Markets. Some internal names (the `kairo-runner` server service, a `web/components/kairo` folder) keep that old name.

## How a round works

1. Rounds run back to back, in four lengths: 5 minutes, 10 minutes, 30 minutes and 1 hour, for each of BTC, ETH and SOL (12 markets).
2. You call the **next** round, before it locks. Pick UP or DOWN and an amount. The minimum is 0.50 USDC. Calls after the lock are refused.
3. When the round locks, the start price is fixed: the first price update at or after the lock. The end price is the last update at or before the end.
4. Higher than the start: UP wins. Lower: DOWN wins.
5. You claim from the site. Claims never expire.

### Only matched money plays

Your money plays against the opposite side. The **matched pool** is the smaller of the UP total and the DOWN total. If one side has more, the extra stays out of the game and comes back to its callers, whether they win or lose.

Example: 10 USDC on UP and 6 on DOWN. Only 6 on each side is matched, so 4 USDC of the UP money is returned either way. If UP wins, the UP side shares the 6 USDC matched from the DOWN side, minus the fee. If DOWN wins, the matched UP money is lost and nothing more.

The fee is **2% of the matched pool**, taken from the winnings only. A loser or a refunded caller pays no fee. The exact integer maths and the worked numbers are in [`docs/MATCHED_CALLS.md`](docs/MATCHED_CALLS.md).

### Refunds (no fee)

You get your full stake back if:

- only one side has money (the round is settled as a refund right away, no price needed),
- the end price equals the start price,
- the price feed gave no usable update for the round,
- nobody settled the round within 1 hour (anyone can then trigger the refund, and `claim` itself finishes it).

## The agents

Four house agents call every round with **no money**. They are guide calls: free, kept off-chain, and scored later from the real start and end prices, so their track record is public. The site shows each agent's last 5 results and a win rate once it has 3 scored calls. "Back this agent" copies its side into your own call.

| Agent | What it is |
|---|---|
| Trend Follower | A Gemini model that goes **with** the net move of a lookback window (twice the round length). |
| Contrarian | A Gemini model that goes **against** the net move of the same window. |
| Chart Reader | A Gemini model that reads candle shapes and levels (highs, lows, wicks, short against long average) and judges each time frame separately. |
| Coin Flipper | A random benchmark. Can the AI agents beat a coin? |

How the AI agents run on the mainnet runner:

- Each AI agent sends **one** Gemini request every 10 minutes that covers every open round and one extra 5 minute round. The requests are staggered by a few seconds, on the free tier, with a hard cap per day.
- The net move for Trend Follower and Contrarian is computed in code, so both get the same number, and an answer that breaks the agent's rule is dropped.
- The reason shown on each call is the model's own sentence. It is not checked and not advice.
- If the model does not answer in time, the agent skips that cycle and the site says "Couldn't decide this round".
- An agent never sees another player's call.

The agents on the testnet version of the runner can also stake real testnet USDC. On mainnet they only make guide calls.

## What the owner can and cannot do

- **Can:** create markets, pause a market, withdraw the collected fees, hand ownership to another address in two steps.
- **Cannot:** touch the money in a round, change the 2% fee (it is a constant), withdraw anything but collected fees, or give up ownership by accident (renouncing is disabled).
- Players claim their own payouts. The contract never pushes money out to a list of players.

## Trust model, said plainly

Matchup is **not trustless** on prices.

- Each coin has a price relay contract (`GuardedRelayFeed`). One wallet, the runner, pushes the latest Bitfinex trade price into it. The relay stamps each price with the block time, so nothing can be back-dated, and `settle` can be called by anyone: it only accepts the first update at or after the lock as the start price and the last update at or before the end as the end price.
- The relay **rejects any price that is more than 1.0% (BTC) or 1.5% (ETH, SOL) away from Chainlink's latest price on Arc.**
- **Inside that band the runner chooses the price.** A 5 or 10 minute round usually moves much less than 1%, so a dishonest or hacked runner could decide the result of short rounds. The runner cannot take stakes in any other way: it cannot reach the pot, and claims are paid by the contract only. Treat the runner's operator as trusted for results.
- The runner is one server with a wallet that holds only a few USDC for gas. If it stops, rounds that cannot be settled are refunded after an hour. The owner can replace the runner wallet (`setPusher`).
- The relay owner and the arena owner are the deployer wallet, which is a different wallet from the runner. The owner can create markets with any price feed, so the market list is also a trust point.
- A short internal review is in [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md). It is not an audit.

## Contracts on Arc mainnet

These are read from [`deployments/arc-mainnet.json`](deployments/arc-mainnet.json).

| Contract | Address |
|---|---|
| PredictionArena | [`0xaebac196c76a2c9338a30aef663e4799ffa0d364`](https://explorer.arc.io/address/0xaebac196c76a2c9338a30aef663e4799ffa0d364) |
| BTC/USD relay | [`0x15dbb61c92fd8c301a19b769d984491731afab60`](https://explorer.arc.io/address/0x15dbb61c92fd8c301a19b769d984491731afab60) |
| ETH/USD relay | [`0xdbb8d2106f1e45aa5287b666a4c8841bead356c0`](https://explorer.arc.io/address/0xdbb8d2106f1e45aa5287b666a4c8841bead356c0) |
| SOL/USD relay | [`0x5f6952050147e922c7aa1264896aa62bafbc5462`](https://explorer.arc.io/address/0x5f6952050147e922c7aa1264896aa62bafbc5462) |
| Chainlink BTC/USD, ETH/USD, SOL/USD (guards) | `0xa109B535...03De`, `0x50FCDD99...D364`, `0x2d04D354...f90C` |
| Runner (price pusher) | `0x141043c9f604c8274286Dc0319a2F1c9124CEa3F` |
| Owner / deployer | `0x1AB2ADf11B3B16544C5F76d74c729B4EdCDcb4bC` |

Contract history: an earlier version (v1, arena `0x2dea2ea4cffd8a201d54d3ab1567f28c2ed49758`) ran on mainnet first. Its record is kept in [`deployments/arc-mainnet-v1.json`](deployments/arc-mainnet-v1.json). Version 2 renamed the call functions and events (for example `placeBet` became `placeCall`) and is the one the app uses. The deploy script checks the deployed code against this repo, the owner, the fee, the relay settings and all 12 markets after every deploy.

## How it was built

- The **smart contracts** (`PredictionArena`, `GuardedRelayFeed`) were written and tested in **Arc Studio**: 301 tests passed there, including the rename from the old bet wording to call wording. They were then deployed to Arc mainnet.
- The same contracts are in `contracts/` with a Foundry test suite that runs on GitHub Actions for every push, together with deliberate-break (mutation) checks and more than 300 JavaScript tests for the runner, agents, scripts and website.
- The **website, the runner and the agents** were built with Claude Code.
- The AI agents use Gemini on the free tier.

## Layout

| Path | What it is |
|---|---|
| `contracts/PredictionArena.sol` | The arena: markets, calls, settle, claims |
| `contracts/GuardedRelayFeed.sol` | The price relay checked against Chainlink |
| `contracts/test/` | Foundry tests |
| `web/` | The website (Next.js) |
| `runner/` | The round runner: pushes prices, settles rounds, runs the guide calls |
| `agents/` | The agents' rules and the Gemini client |
| `scripts/` | Deploy and check scripts |
| `deployments/` | Public deployment records (addresses and transactions only) |
| `docs/MATCHED_CALLS.md` | The payout rule with worked numbers (current) |
| `docs/RULES.md` | The original v1 rules. Where it differs on payouts and fees, `MATCHED_CALLS.md` wins. |

## Run it yourself

```bash
npm ci

# tests that need no chain
npm run test:agents && npm run test:runner && npm run test:scripts

# the website
cd web && npm install && npm run dev
```

Settings go in a `.env` file only. Copy `.env.example` and fill it in; the file lists every setting name. `.env` is in `.gitignore` and is never committed. The mainnet deploy and runner send nothing unless started with `--i-understand-this-spends-real-usdc`. The server steps are in [`docs/MAINNET_AGENTS.md`](docs/MAINNET_AGENTS.md).

## Tests

- Arc Studio: 301 contract tests passed.
- Repo CI: the Foundry suite, mutation checks, and the JavaScript suites listed above.

## Next

- Circle user-controlled wallets with Google sign-in, so players need no wallet extension.
- A narrower price band, more than one price source, or settling straight from Chainlink, so results do not depend on one runner.
- Cheaper markets and smaller minimum calls.
- Agents with real stakes on the other side of a round.
- ERC-8004 agent identity and an x402 paid feed of round history and agent track records.
- Matchup inside Tella, with calls made from WhatsApp.

## Licence

MIT. See [`LICENSE`](LICENSE).
