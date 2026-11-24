# Coin vs coin on mainnet: checklist (NOT run)

This is the list of steps to put **ETH vs BTC** and **SOL vs BTC** (1-hour rounds) on the **existing mainnet arena**
(`0xaebac196c76a2c9338a30aef663e4799ffa0d364`, `deployments/arc-mainnet.json`) without changing the arena or the relay contract.
Nothing here has been done on mainnet. Each box is one small step; stop at the first one that fails.

What gets deployed, per pair (the same as the testnet rehearsal, `scripts/deploy-ratio.mjs`):

| Piece | Contract | Settings |
|---|---|---|
| Guard | `RatioGuard` (new) | top = Chainlink ETH/USD or SOL/USD proxy, bottom = Chainlink BTC/USD proxy (addresses in `scripts/markets.mjs`, `CHAINLINK_MAINNET`), 18 decimals |
| Relay | `GuardedRelayFeed` (unchanged) | owner = the mainnet owner wallet, pusher = the runner wallet (`0x1410…EA3F`), guard = the RatioGuard, band **250 bps (2.5%)**, description from `ratioRelayDescription(key, 'mainnet')` |
| Market | `createMarket` on the unchanged arena | `"ETH/BTC 1h"` offset 50 s, `"SOL/BTC 1h"` offset 150 s, 3600 s rounds, min stake 0.50 USDC, feedB = none. They become market ids 12 and 13 |

## Before (decisions and reviews)

- [ ] **Trust is accepted and said plainly.** A 2.5% band against a typical 1-hour ratio move of about 0.2% (median, measured
      17–24 Nov 2026) means the runner can choose the result of almost any round. The call panel and How it works say so
      (`RatioNotice` in `web/components/kairo/your-call.tsx`, "Coin vs coin" in `web/app/how-it-works/page.tsx`). Owner decision: go ahead or not.
- [ ] **Review of `contracts/RatioGuard.sol`** (Arc Studio audit or a second reviewer). It is small, has no owner and no
      storage beyond immutables, but every push depends on it.
- [ ] **Mutation check** on RatioGuard (the 5 deliberate breaks run on 24 Nov were all caught; add them to `ci/mutations.json`
      so CI repeats them).
- [ ] **Measure the Bitfinex-vs-Chainlink ratio gap for a week** (PLAN_V3 R1). If it ever gets near 2.5%, pushes would be refused and
      rounds refund. Chainlink ETH and SOL on Arc update on a deviation threshold, so the guard ratio can lag by roughly the two
      thresholds added up.
- [ ] **Testnet first, end to end.** The 24 Nov rehearsal deployed and verified the contracts on the testnet, but the testnet arena
      there is the older v1 contract (`placeBet`, `nextBettableRound`), which the current runner and site cannot drive. A full round
      (two calls, start and end push by the runner, settle, claim) needs a fresh v2 testnet arena first. Do that round before mainnet.
- [ ] **Code on the server is the `ratio` branch** (merged), so the mainnet runner knows the 18-decimal pairs. An older runner
      would refuse to quote "ETH/BTC" (no price source) and push nothing, which is safe but makes every round refund.

## Write the mainnet script (not written yet)

`scripts/deploy-ratio.mjs` refuses mainnet on purpose. A mainnet version must, like `scripts/deploy.mjs --set mainnet`:

- [ ] be a **dry run unless** `--i-understand-this-spends-real-usdc` is given, and print the cost estimate first;
- [ ] use `MAINNET_DEPLOYER_PRIVATE_KEY` (the arena owner) on your PC only, never on the server;
- [ ] take the pusher from `MAINNET_RUNNER_PRIVATE_KEY`'s **address** (`scripts/runnerKey.mjs`), and refuse if it is the owner;
- [ ] read each Chainlink proxy first (`judgeGuard`: description, 8 decimals, answer > 0, not older than 26 h) and stop on any problem;
- [ ] after deploying each RatioGuard, read `latestRoundData()` and compare it with Chainlink top / bottom worked out off chain;
- [ ] check the arena's `marketCount` is 12 before creating markets, so the new ids are 12 and 13;
- [ ] save to `deployments/arc-mainnet.json` under `ratio` and append the two markets with `kind: "ratio"` (the same shape as the
      testnet file), so `scripts/sync-web-deployment.mjs` and `scripts/deploy.mjs --verify-only` keep working;
- [ ] verify everything on chain afterwards (owner, pusher, guard, band, decimals, description, code matches the repo, market settings),
      like the testnet `verify()`;
- [ ] **not** push a first ratio by itself: on mainnet the runner pushes only for rounds with calls on both sides.

## Deploy day

- [ ] `node runner/run-mainnet.mjs --once` (dry run) still passes its checks with the 14 markets: it must say the runner is the
      pusher of **5** relay feeds.
- [ ] Fund the deployer wallet (about the cost the dry run prints; 2 RatioGuards + 2 relays + 2 createMarket is well under 1 USDC
      at today's gas).
- [ ] Run the mainnet script with the flag. Keep the transaction links.
- [ ] `node scripts/deploy.mjs --set mainnet --verify-only` and the new script's verify: all OK.
- [ ] Restart the runner on the server (`docs/RUNBOOK.md`, section 3) and watch the log for the `checked: ... 14 markets, 5 relay feeds` line.
- [ ] Site: `NEXT_PUBLIC_NETWORK=mainnet npm run build` in `web/` passes, then push to the production branch. The "Coin vs coin"
      row appears by itself once the deployment file has the two markets.

## First rounds

- [ ] Make a small call on each side of one ETH/BTC round (two wallets), watch the start push (each coin's first trade at least 2 s
      after the lock), the end push, the settle and the claim. Compare the pushed ratio with Bitfinex's trade history.
- [ ] Check `data/price-log-mainnet.jsonl`: the ratio entries carry `decimals: 18`, `ratio` and both `legs`.
- [ ] If anything looks wrong: `setMarketPaused(12, true)` / `(13, true)` from the owner wallet stops new calls (existing calls still
      settle or refund). Nothing else can be changed: the market's feed, length and offset are fixed for ever.
