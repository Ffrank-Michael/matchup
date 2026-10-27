# DoraHacks submission text (draft)

Plain words, no hype. Fill the [brackets] before pasting. Keep every claim true on the day you submit.

## Title
Kairo Markets

## One line
Call the next move of BTC, ETH or SOL: UP or DOWN. Small USDC calls on Arc.

## Description

Kairo Markets is a small prediction game on Arc. Every few minutes a new round opens for BTC, ETH and SOL. You pick UP or DOWN and put in at least $0.50 in USDC. When the round ends, the price decides who wins.

Only matched money plays. Your money plays against the other side. If one side has more, the extra comes back to you, win or lose. Winners double the money that played, minus a 2% fee. If you lose, you only lose the part that played. If a round is one-sided, the price did not move, or the price feed failed, everyone gets their full stake back with no fee. Claims never expire.

Four house agents make calls with their own wallets: Trend Follower, Contrarian, Chart Reader and Coin Flipper. Three are AI agents (one small Gemini call every 5 minutes per coin gives each of them a call and one sentence of reasoning for every time frame that is opening, shown on the site as an AI note, not checked and not advice). Coin Flipper picks at random, so you can see whether AI beats a coin flip. You can watch their record and tap "Back this agent" to copy its side on your own call.

The owner can only withdraw fees and pause one market. The owner cannot touch the money in a round and cannot change the fee.

**Where it runs:** [FILL IN: Arc mainnet contract address and link]. Live app: https://www.kairomarkets.xyz. Example mainnet transaction: [FILL IN].

**Prices:** [FILL IN once decided. Say plainly where the mainnet price comes from and what limits it, for example "pushed from Bitfinex by our runner and checked against Chainlink within X%", or "Chainlink feeds".]

## How Arc Studio was used

[CONFIRM and keep only what is true.]
- The smart contract was written and tested in Arc Studio. Project: https://studio.arc.io/app/a8e053bb-4ebd-4ed7-bde8-7be48ef04a5b
- [FILL IN: what Arc Studio built for the website's wallet, call and claim parts.]
- Extra tests (311 at the last run) and deliberate-break checks that the tests catch run on GitHub Actions.
- The website design, the price runner and the agents were built locally with Claude Code.

## Honest limits
- Beta. Not audited. Small amounts only (the site limits a call to 10 USDC).
- [FILL IN: mainnet price-feed trust, and that a stopped runner means rounds refund.]

## Links
- Repo: https://github.com/Ffrank-Michael/kairo-markets [make public first]
- Live app: https://www.kairomarkets.xyz
- Video: [FILL IN]
- Builder profile: https://github.com/Ffrank-Michael
