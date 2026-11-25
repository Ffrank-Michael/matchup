# Coin vs coin on mainnet: checklist (NOT run)

This is the list of steps to put **ETH vs BTC** (1-hour rounds) on the **existing mainnet arena**
(`0xaebac196c76a2c9338a30aef663e4799ffa0d364`, `deployments/arc-mainnet.json`) without changing the arena or the relay contract.
Nothing here has been done on mainnet. Each box is one small step; stop at the first one that fails.

**Only ETH vs BTC goes live.** SOL vs BTC waits until SOL has a better price source (see "Later: SOL vs BTC" at the end):
Bitfinex SOL/USD is too thin for an average, so a SOL price is a single trade, and with a 2.5% band one trade could decide a
SOL vs BTC round (`docs/RUNBOOK.md`, "Known limits"). The testnet rehearsal (`scripts/deploy-ratio.mjs`) still has both pairs;
that is fine on the testnet.

What gets deployed (the same pieces as the testnet rehearsal, ETH vs BTC only):

| Piece | Contract | Settings |
|---|---|---|
| Guard | `RatioGuard` (new, version 2 after the audit) | top = Chainlink ETH/USD proxy, bottom = Chainlink BTC/USD proxy (addresses in `scripts/markets.mjs`, `CHAINLINK_MAINNET`), 18 decimals; each leg at most 25 h old (`RATIO_LEG_MAX_AGE_SECONDS`), expected leg labels `"ETH / USD"` over `"BTC / USD"` (`ratioGuardArgs('ethbtc', ...)`), so swapped feeds are refused at deploy |
| Relay | `GuardedRelayFeed` (unchanged) | owner = the mainnet owner wallet, pusher = the runner wallet (`0x1410…EA3F`), guard = the RatioGuard, band **250 bps (2.5%)**, description from `ratioRelayDescription(key, 'mainnet')` |
| Market | `createMarket` on the unchanged arena | `"ETH/BTC 1h"`, offset 50 s, 3600 s rounds, min stake 0.50 USDC, feedB = none. It becomes market id 12 |

## Before (decisions and reviews)

- [ ] **Trust is accepted and said plainly.** A 2.5% band against a typical 1-hour ratio move of about 0.2% (median, measured
      17–24 Nov 2026) means the runner can choose the result of almost any round. The call panel and How it works say so
      (`RatioNotice` in `web/components/kairo/your-call.tsx`, "Coin vs coin" in `web/app/how-it-works/page.tsx`). Owner decision: go ahead or not.
- [ ] **Review of `contracts/RatioGuard.sol`** (Arc Studio audit or a second reviewer). It is small, has no owner and no
      storage beyond immutables, but every push depends on it. Part 1 is in `docs/AUDIT_RATIO_PART1.md`; the guard was changed
      after it (version 2: per-leg age limit, decimals checked on every read, expected leg labels), so a review must cover version 2.
- [ ] **The testnet guards of 24 Nov are version 1.** `node scripts/deploy-ratio.mjs --verify-only` now reports their code and
      age limits as FAIL. Redeploy them (with the fresh v2 testnet arena below) before the end-to-end testnet round.
- [ ] **Mutation check** on RatioGuard (the 5 deliberate breaks run on 24 Nov were all caught; add them to `ci/mutations.json`
      so CI repeats them).
- [ ] **Measure the Bitfinex-vs-Chainlink ratio gap for a week** (PLAN_V3 R1). If it ever gets near 2.5%, pushes would be refused and
      rounds refund. Chainlink ETH and BTC on Arc update on a deviation threshold (0.5% and 0.1%), so the guard ratio can lag by roughly the two
      thresholds added up.
- [ ] **Testnet first, end to end.** The 24 Nov rehearsal deployed and verified the contracts on the testnet, but the testnet arena
      there is the older v1 contract (`placeBet`, `nextBettableRound`), which the current runner and site cannot drive. A full round
      (two calls, start and end push by the runner, settle, claim) needs a fresh v2 testnet arena first. Do that round before mainnet.
- [ ] **The owner is a hardware wallet (or an offline key).** The arena and every relay, the new ETH vs BTC relay included,
      have been moved with the two-step transfer (`docs/RUNBOOK.md`, section 1), and `owner()` on each one reads the hardware
      wallet. The owner can hand price control to anyone at once (audit part 1, R-02), so this comes before real money.
- [ ] **The owner key is not on the server.** On the server, `grep -c MAINNET_DEPLOYER_PRIVATE_KEY /home/ubuntu/arc-arena/.env`
      prints `0`; the file was made with `node scripts/make-server-env.mjs` (`docs/MAINNET_AGENTS.md`, step 6), and
      `sudo bash deploy/setup-runner.sh` ends with `READY`.
- [ ] **Alerts reach the phone.** `NTFY_TOPIC` is set on the server, the runner log does not show
      `WARNING: no NTFY_TOPIC`, and a test message arrives: on the server,
      `cd /home/ubuntu/arc-arena && node -e "import('./runner/supervise.mjs').then(async (m) => console.log(await m.notify(process.env.T, 'Matchup test', 'test alert')))"`
      with `T=<your topic>` in front prints `true` and the phone buzzes.
- [ ] **Code on the server is the `ratio` branch** (merged), so the mainnet runner knows the 18-decimal pair. An older runner
      would refuse to quote "ETH/BTC" (no price source) and push nothing, which is safe but makes every round refund.

## Write the mainnet script (not written yet)

`scripts/deploy-ratio.mjs` refuses mainnet on purpose. A mainnet version must, like `scripts/deploy.mjs --set mainnet`:

- [ ] be a **dry run unless** `--i-understand-this-spends-real-usdc` is given, and print the cost estimate first;
- [ ] use `MAINNET_DEPLOYER_PRIVATE_KEY` (the arena owner) on your PC only, never on the server;
- [ ] take the pusher from `MAINNET_RUNNER_PRIVATE_KEY`'s **address** (`scripts/runnerKey.mjs`), and refuse if it is the owner;
- [ ] deploy **ETH vs BTC only** (the `ethbtc` entry of `RATIO_MARKETS` in `scripts/markets.mjs`), and refuse any other pair on
      mainnet, SOL vs BTC included, until "Later: SOL vs BTC" is done;
- [ ] read the two Chainlink proxies first (ETH/USD and BTC/USD; `judgeGuard`: description, 8 decimals, answer > 0, not older
      than 26 h) and stop on any problem;
- [ ] after deploying the RatioGuard, read `latestRoundData()` and compare it with Chainlink ETH / BTC worked out off chain;
- [ ] check the arena's `marketCount` is 12 before creating the market, so the new id is 12;
- [ ] save to `deployments/arc-mainnet.json` under `ratio` and append the market with `kind: "ratio"` (the same shape as the
      testnet file), so `scripts/sync-web-deployment.mjs` and `scripts/deploy.mjs --verify-only` keep working;
- [ ] verify everything on chain afterwards (owner, pusher, guard, band, decimals, description, code matches the repo, market settings),
      like the testnet `verify()`;
- [ ] **not** push a first ratio by itself: on mainnet the runner pushes only for rounds with calls on both sides.

## Deploy day

- [ ] `node runner/run-mainnet.mjs --once` (dry run) still passes its checks with the 13 markets: it must say the runner is the
      pusher of **4** relay feeds.
- [ ] Fund the deployer wallet (about the cost the dry run prints; 1 RatioGuard + 1 relay + 1 createMarket is well under 1 USDC
      at today's gas).
- [ ] Run the mainnet script with the flag. Keep the transaction links.
- [ ] `node scripts/deploy.mjs --set mainnet --verify-only` and the new script's verify: all OK.
- [ ] Restart the runner on the server (`docs/RUNBOOK.md`, section 3) and watch the log for the `checked: ... 13 markets, 4 relay feeds` line.
- [ ] Site: `NEXT_PUBLIC_NETWORK=mainnet npm run build` in `web/` passes, then push to the production branch. The "Coin vs coin"
      row appears by itself once the deployment file has the market, with ETH vs BTC only.

## First rounds

- [ ] Make a small call on each side of one ETH/BTC round (two wallets), watch the start push (each coin's median over its window from
      2 s after the lock: ETH 90 s, BTC 60 s, so about 1.5 minutes after the lock), the end push, the settle and the claim. Compare the pushed ratio with Bitfinex's trade history.
- [ ] Check `data/price-log-mainnet.jsonl`: the ratio entries carry `decimals: 18`, `ratio` and both `legs`, each with
      `method: "median"`, `trades` and its window.
- [ ] If anything looks wrong: `setMarketPaused(12, true)` from the owner wallet stops new calls (existing calls still settle or
      refund). Nothing else can be changed: the market's feed, length and offset are fixed for ever.

## Later: SOL vs BTC (waits for a better SOL price source)

Not part of this launch. Bitfinex SOL/USD is too thin for an average (no trade at all in about 40% of minutes, measured
25 Nov 2026), so a SOL price is a single trade, and with a 2.5% band one trade could decide a SOL vs BTC round
(`docs/RUNBOOK.md`, "Known limits").

- [ ] Add a second, deeper source for SOL (another exchange), take the median over both, and give SOL a window like BTC and ETH
      (`WINDOWS` in `runner/exchangePrices.mjs` and `web/lib/price-rule.ts`); then remove SOL from `THIN_MARKET_KEYS` so the
      site's thin-market notice goes away.
- [ ] Measure how often that window has too few trades over at least a week, as was done for BTC and ETH.
- [ ] Only then: the same steps as above for `"SOL/BTC 1h"` (offset 150 s, the next free market id), with expected leg labels
      `"SOL / USD"` over `"BTC / USD"`.
