# Runbook: mainnet keys, alerts, restarts

The step-by-step server setup is in `docs/MAINNET_AGENTS.md`. This page is the short list of what must stay true on mainnet and
what to do when an alert arrives. Background: `docs/AUDIT_RATIO_PART1.md` (R-01, R-02).

## 1. Keys: who holds what

| Key | Can do | Where it lives |
|---|---|---|
| **Owner** of the arena and of every relay (today the deployer wallet, `deployments/arc-mainnet.json` → `owner`) | `setPusher` on each relay (hand price control to any address, at once), `createMarket`, `setMarketPaused`, `withdrawFees`, move ownership | **Offline, or on a hardware wallet. Never on the server, never in the server's `.env`, never in a browser wallet used for anything else.** |
| Runner (`MAINNET_RUNNER_PRIVATE_KEY`) | push prices to the relays, settle rounds | the server's `.env` only (`chmod 600`), a few USDC for gas |

**Why the owner key matters this much.** The arena never lets the owner take player money, but the relay owner can make any
address the pusher in one transaction, and the pusher decides the results inside the band (2.5% on the coin-vs-coin
relays, against a typical 1-hour move of about 0.2%). Whoever holds the owner key can therefore take the matched stakes of
every two-sided round from the next round on. Treat it like the key to the pot.

**Move the owner to a hardware wallet** (do this before the coin-vs-coin markets go live; the contracts use two-step ownership,
so a typo cannot lose them):

1. From the current owner wallet: `transferOwnership(<hardware wallet address>)` on the arena and on each relay feed
   (the three USD relays, and the two ratio relays once deployed).
2. From the hardware wallet: `acceptOwnership()` on each of them. Until this step the old owner keeps every power.
3. Check that `owner()` on every contract reads the hardware wallet (on the explorer, or
   `cast call <contract> "owner()(address)" --rpc-url <Arc mainnet RPC>`). Note: `node scripts/deploy.mjs --set mainnet --verify-only`
   still expects the deployer wallet as the owner, so after the move it reports its owner lines as FAIL until that script
   learns the new owner.
4. Remove `MAINNET_DEPLOYER_PRIVATE_KEY` from `.env` on the PC. Later owner actions are signed on the hardware wallet
   (the deploy scripts that need the owner, such as a mainnet `createMarket`, must then send through it instead of a key in `.env`).

`renounceOwnership` is disabled on purpose: a contract without an owner could not pause a market or replace a broken pusher.

## 2. Alerts and what to do

All alerts go to the ntfy topic in `NTFY_TOPIC` (`.env` on the server). Without it, they are only in the log.

| Alert | From | Meaning | Do this |
|---|---|---|---|
| `Matchup MAINNET runner stopped` / `restarted` / `crash loop` | `runner/supervise.mjs` | the runner process ended | read the log (section 3); a crash loop waits 5 minutes between tries |
| **`Matchup: relay pusher changed`** | `runner/pusherWatch.mjs` (the runner, checked every minute) | a `PusherChanged` event on a relay: someone with the owner key changed who may push prices | **If you did not do it: the owner key is compromised.** At once, from the owner wallet if you still can: `setMarketPaused(id, true)` for every market on that relay, then `setPusher(<runner address>)`. Then move ownership to a new wallet (section 1). If you did it (a planned key change), check that the new address is the one you meant. |
| `Matchup: runner is not the pusher` | `runner/pusherWatch.mjs` | a relay's `pusher()` is another address (also caught if it changed while the runner was down) | the same as above; until it is fixed, this runner's pushes to that relay are refused and its rounds refund |
| **`Matchup: ownership transfer started`** / **`owner changed`** | `runner/pusherWatch.mjs` | someone with the owner key proposed a new owner, or a new owner accepted, on the arena or a relay | **If you did not do it: the owner key is compromised.** A transfer that only *started* can still be stopped: from the owner wallet, `transferOwnership(<your own address>)` replaces the pending one. Then pause the markets and move ownership to a new wallet (section 1). |
| `Matchup: market created` / `market paused` / `market unpaused` | `runner/pusherWatch.mjs` | the owner created, paused or unpaused a market | if you did not do it, as above |
| `Matchup: pusher watch cannot read the chain` | `runner/pusherWatch.mjs` | for over 5 minutes the runner could not read these events (repeated at most hourly) | check the RPC node (`ARC_MAINNET_RPC_URL`); until it works, a change of pusher or owner would not be noticed |
| `Matchup MAINNET runner cannot start` | `runner/run-mainnet.mjs` | the start-up check failed (wrong chain, no arena, the runner is the owner, or not the pusher of a relay); the text says which | fix what it names; the supervisor keeps restarting it until then |

A pause only stops new calls. Calls already placed still settle (with whatever the pusher posts) or refund. So act on a
pusher alert before the next lock, not after the round.

## 3. Restart the runner

On the server (see `docs/MAINNET_AGENTS.md` for the full list):

```
sudo systemctl restart kairo-runner
journalctl -u kairo-runner -n 50 --no-pager
```

Look for `checked: Arc mainnet, <n> markets, <m> relay feeds, the runner is the pusher of each`. If the runner is not the
pusher of a relay it stops at start with a plain message (it never pushes to a relay it does not control). A line
`WARNING: no NTFY_TOPIC in .env` means pusher alerts only go to the log: add the topic and restart.

After updating the code: `git pull`, `npm ci --no-audit --no-fund`, then the restart above.

## Known limits

Found in the audit (`docs/AUDIT_RATIO_PART2.md`) and not fixed yet, on purpose. None of them can take money from a player;
each one can cause refunds or wrong-looking text.

| Limit | What it means | When to fix |
|---|---|---|
| **P2-08. Guide calls are scored differently from real rounds.** | The mainnet runner scores the agents' free guide calls from the **testnet** price log (`data/price-log.jsonl`), and, where that has no entry, from Bitfinex's single first and last trade. Real rounds now use a 60 s / 90 s median for BTC and ETH and the trade about 60 s before the end. So an agent's guide call can show "won" on a round whose real result went the other way, and the agents' win rates on the site come from these scores. No money moves on guide calls. | Pass the mainnet price log (`MAINNET_PRICE_LOG_FILE`) to `createGuide` in `runner/run-mainnet.mjs`, and score from the chain (`RoundSettled`, or the relay's start and end) when a round had pushes. |
| **P2-09. A real move of more than 20% blocks a coin until the runner restarts.** | `jumpCheck` in `runner/exchangePrices.mjs` refuses a price more than 20% away from the last one it handed out, and the refused price never replaces it. After a genuine 20% move, every later price of that coin (and its coin-vs-coin market) is refused, so those rounds refund until `sudo systemctl restart kairo-runner`. The log says "not trusting it"; no phone alert. | Compare with Chainlink's latest answer instead of the last price, or accept the new level after a few agreeing quotes; alert the first time a price is refused. Until then: if the log shows "not trusting it" for a real move, restart the runner. |
| **P2-11. The site's start-price route can be used to get the site blocked by Bitfinex.** | `/api/start-price` asks Bitfinex for any lock time in the last 6 hours that a visitor sends. Many different lock values from one visitor can get the site's server rate-limited by Bitfinex for a minute at a time. Only the site's cross-check is affected (the start price the site shows comes from the chain); the runner uses its own IP. | Accept only real lock times of the last two rounds of a market, cache "not found yet" for a few seconds, and stop asking Bitfinex after about 20 requests a minute. |
| **P2-12. Anyone can make the runner pay for settles.** | A 0.50 USDC call on a round nobody else plays makes the mainnet runner settle it right after it ends (about 136k gas), and the caller gets the 0.50 back. Done on every market every round, it slowly drains the runner's gas; below 0.10 USDC the runner stops and **every** round refunds until it is topped up. The caller pays about as much gas as the runner. | Settle one-sided rounds early only above a real-money threshold (they refund on claim after the hour anyway), and alert when the runner's balance falls below 1 USDC. Until then: keep an eye on the runner's balance. |
| **SOL keeps the single-trade price (owner decision, 25 Nov 2026).** | BTC and ETH start and end prices are now the median of a window of trades (P2-01). Bitfinex SOL/USD is too thin for an average: it has no trade at all in about 40% of minutes (measured over a day on 25 Nov 2026), so a window would refund most SOL rounds. So SOL, and the SOL side of SOL/BTC, keep a single trade: the start is the first trade at least 2 s after the lock, and the end is the last trade about 60 s before the end. A player can still nudge a SOL price with one trade of their own at those moments. The site says so next to the call buttons of every SOL market. **SOL vs BTC must not go live on mainnet until SOL has a better price source**: with one thin SOL trade on one side of the ratio and a 2.5% band, a single trade can decide those rounds. (SOL/USD itself is already live on mainnet with this rule.) | Add a second, deeper source for SOL (another exchange), take the median over both, give SOL a window like BTC and ETH, and only then deploy SOL vs BTC on mainnet (`docs/RATIO_MAINNET_CHECKLIST.md`). |
| **Rounds without calls on both sides show no start price on mainnet.** | The site now shows the start price that is on chain (P2-05). The mainnet runner pushes prices only for rounds with calls on both sides, so for any other round the chart says "Start price not on chain yet" for the whole round. That is true: such a round refunds without a price. | If wanted: say "No price: this round has calls on one side only" for those rounds. |
| **The contract-level findings of part 1.** | The pusher can still pick results inside the 2.5% band of the coin-vs-coin relays (R-01), turn a round it would lose into a refund (R-03), and a push carries no observation time (R-05). These need a change to the relay or the arena, which are deployed and stay unchanged. | A new relay or a signed pull oracle, before the coin-vs-coin markets carry real money (`docs/RATIO_MAINNET_CHECKLIST.md`). |
