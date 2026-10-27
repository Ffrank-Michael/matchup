# Arc Microgrants: Built with Arc Studio (rules and plan)

Rules: from the program page and the owner's messages of 2026-10-25. Plan: written by Claude on 2026-10-25, revised the same day after the owner said (a) the website's onchain features must be built through Arc Studio and (b) no more paid Arc Studio usage: everything must fit the free daily limit. **Nothing in section 5 has been started.**

## 1. The program

- **Prize:** eight microgrants of $500 USDC each (pool $4,000 USDC), paid in USDC on Arc. Non-dilutive; the builder keeps all ownership.
- **DEADLINE (owner's date): Monday 2 November 2026, 05:59 Lagos time (WAT, UTC+1) = 04:59 UTC.** The program page itself says "November 1". Treat the owner's time as the hard limit, and plan to submit by **Saturday 31 October evening** (the cut-off is in the middle of a night, so nothing is planned for it). Reviewed as they come in; earlier submissions get earlier answers.
- **Idea:** start in Arc Studio and finish with something live on Arc MAINNET that moves real USDC.

### Required
1. Smart contracts **written and tested in Arc Studio** and **deployed to Arc mainnet**.
2. A **working app built in Arc Studio** that calls those contracts, live at a public link.
3. At least **one Arc mainnet transaction** moving USDC through the contract and the app.

### The form needs
Arc Studio project URL (`https://studio.arc.io/app/<id>`), contract address(es), one example transaction hash with an `explorer.arc.io` link, the live app link, a **public repo**, a **video** showing the Arc Studio build AND a mainnet transaction, a short description (what it does, how Arc Studio was used), and a public builder profile (GitHub / X / Farcaster).

### Not eligible
Projects built outside Arc Studio, testnet-only builds, design mockups, slide decks, work already funded by a Circle or Arc program. Submissions are not audited; use small amounts.

### Scoring
| Weight | Criterion |
|---|---|
| 30% | Real USDC moving on Arc mainnet, shown with addresses and transaction hashes |
| 25% | Use of Arc Studio across contracts, testing and app |
| 25% | A working product |
| 20% | Potential to go further |

Other rules: worldwide (sanctions screening); one submission per project; the project must be deployed to mainnet at the time of submitting; pseudonymous is fine until payout; a wallet that can receive USDC on Arc is needed. Links: studio.arc.io, docs.arc.io, explorer.arc.io, developers.circle.com.

## 2. Decisions already made (owner)

1. **Who builds what:**
   | Part | Built where |
   |---|---|
   | Smart contract `PredictionArena` | Arc Studio (already done, session `arc-arena`) |
   | Full contract test run, once, before mainnet | Arc Studio (recorded there) |
   | All other tests, invariants, deliberate-break checks | GitHub Actions only, never Arc Studio |
   | App SCREENS and design (phone first, per `docs/WEBSITE.md`) | Claude, locally |
   | App ONCHAIN features: connect wallet, make a call, claim winnings, read rounds from the contract | **Arc Studio**, using our screens as files |
   | Runner, house agents, deploy/settle scripts, price log | Claude, locally |
   The submission description says honestly which part was built where (draft in section 7).
2. **Mainnet:** Chainlink BTC, ETH and SOL feeds on Arc mainnet, **1-hour rounds** (BTC :00, ETH :20, SOL :40). Testnet stays at 10-minute rounds with mock feeds.
3. **Tiny limits on mainnet:** at most 1 USDC per call (see decision D2 for how this is enforced).
4. **Repo:** private now; becomes public before submitting, after a full secret check (section 6).
5. **After the submission:** x402 paid data feed and Google sign-in.
6. **No paid Arc Studio usage.** Everything goes through the free daily limit.

## 3. Facts found on 2026-10-25 that shape the plan

- **Arc Studio's limit:** `arc-studio usage` still says 100% of the daily limit, no increase. The usage window is 24 hours (86,400,000 ms). We do not know when it frees up, nor what one turn costs. **We measure:** run `arc-studio usage --json` (free, sends nothing) before and after every Arc Studio turn and write the cost in section 8. Until measured, assume ONE turn per day.
- **No public link from Arc Studio.** Its guide says the live preview renders only inside the Arc Studio workspace (`webUrl`), not at a standalone link. So: we pull the Arc Studio-built code to the repo (`arc-studio pull`) and host it on **Vercel**. (The program page says Arc Studio can also connect to GitHub and push; that is a web-app feature the owner would click, and the CLI cannot do it. We commit the pulled code ourselves, and say so.)
- **Arc Studio's app sandbox is a Vite + Foundry app** (web code under `src/`). Our site is **Next.js 16** (Tailwind v4, shadcn). Plan: Arc Studio writes the onchain code as plain React + wagmi + viem modules with pinned versions (wagmi 3.7.7, viem 2.57.2, react-query 5.104.1 to match `web/`), working from our screens as reference files; we copy those modules into `web/`. Free check on day 1: `arc-studio ls --session arc-arena` shows what the sandbox contains before we spend a turn.
- **Limits of what we can send:** `--file` takes up to 100 files, 1 MB each; the prompt is capped at 10,000 characters. Arc Studio cannot see our private repo (clone only works for public repos), and cannot write to our disk.
- **The contract has no on-chain maximum stake**, only a minimum (set per market at creation) and the owner's per-market pause. So "1 USDC max" is not enforceable on chain without a contract change.
- **Chainlink on Arc mainnet is NOT confirmed.** Arc's contract-address page does not list Chainlink feeds. Leads: a Chainlink changelog entry says BTC/USD and ETH/USD were "added" on Arc (network and date unclear) and an Arc blog says Chainlink Data Feeds are on Arc testnet. SOL/USD on mainnet is unconfirmed. Addresses, heartbeat and deviation must be confirmed from data.chain.link (open it in a browser, pick Arc) and checked on chain with a read-only call (`description()`, `latestRoundData()`), which costs no Arc Studio turns.
- **Deploying to mainnet through Arc Studio is not confirmed.** Its guide says "Arc testnet by default" and mentions no mainnet. Day 1 question; fallback in D4.
- Contract tests today: 239 forge tests (49 + 8 + 77 + 9 + 75 + 21 across 6 files), 41 of 41 deliberate breaks caught, all on GitHub CI. Earlier steps already ran in the Arc Studio sandbox (77, then 152 tests).

## 4. Decisions needed from the owner

| # | Question | Recommendation |
|---|---|---|
| D1 | Rehearse on TESTNET first with our own deploy script (free, no Arc Studio turn)? Your earlier rule was "deploy through Arc Studio, script only with your OK". | **Yes**: it lets us test the runner, the site and the full call/settle/claim cycle for free before spending turns. Needs your OK. |
| D2 | How to enforce "1 USDC max per call"? (a) Site and runner enforce it; the contract can still be called directly with more; the owner can pause a market. (b) Change the contract: add a per-market maximum stake. Costs one more Arc Studio turn, new tests on GitHub, and re-running the full test in Arc Studio. | **(a)** to protect the schedule; say so openly in the description and the app. Choose (b) only if you want a real on-chain limit and accept about 2 extra days. |
| D3 | If Chainlink has no SOL/USD on Arc mainnet: ship mainnet with BTC and ETH only? | **Yes.** Testnet keeps all three. |
| D4 | If Arc Studio cannot deploy to mainnet: deploy with our own script (same contract source, verified on explorer.arc.io)? | **Yes**, and the description says so. |
| D5 | The connect-wallet button was already written locally on 2026-10-25 (before this rule). Replace it with Arc Studio's version and say the first draft was local? | **Yes**: send it as a reference file, use Arc Studio's output, keep the history honest. |
| D6 | Mainnet funding (you do it, from your own wallet; no keys in chat). | About **2 USDC** for the deployer wallet (gas; deploy is about 0.14 USDC at 25 gwei, to be re-measured) and about **3 USDC** for the wallet you test with. |
| D7 | License for the public repo (MIT, or none)? | MIT. Your call. |

## 5. Arc Studio turn ledger (the bottleneck)

Each turn: ONE complete prompt (under 10,000 characters), files attached, "quick preset", no audit asked for unless listed. Check `arc-studio usage --json` before and after. Never retry exit code 4. `usage` and `ls` are free.

| Turn | What goes to Arc Studio | Result we pull | Priority |
|---|---|---|---|
| **T1** Record the tests | `contracts/` (contract, mocks, interfaces, the 6 test files) + `foundry.toml`/remappings. Prompt: "run the full forge test suite, change nothing, show the raw summary". | The raw test summary (screenshot and text for the video) | Must |
| **T2** Onchain A | Our screens (`web/components/kairo/*`, `web3-bento.tsx`), `docs/WEBSITE.md`, `web/lib/*`, the ABI, addresses via env. Prompt: wagmi/viem modules: connect wallet (Arc testnet AND Arc mainnet by an env setting), read markets, rounds, pots and the wallet's positions, with pinned versions. | `src/onchain/*` (hooks, ABI file, chain config) | Must |
| **T3** Onchain B | Same files + T2 output. Prompt: "make a call" (approve USDC if needed, then place the call), claim / claim all, transaction status, errors in plain words, the 1 USDC cap (D2a). | More `src/onchain/*` and the wired components | Must |
| **T4** Mainnet deploy | Contract source + the confirmed Chainlink feed addresses (written into the prompt by us, NOT trusted from Arc Studio) + owner address. Prompt: deploy `PredictionArena` to Arc mainnet and verify the source. | Address and tx from `arc-studio deployments` (copied, then checked by us on explorer.arc.io) | Must (or D4 fallback) |
| **T5, T6** Reserve | Bug fixes found while testing with a real wallet. One small prompt each. | Fixes | Spare |

If a turn costs far less than a day's limit, two turns can share a day. If one turn costs a whole day, the order above stands and T5/T6 are what we give up first.

## 6. Day-by-day plan (Lagos dates; the reset time is unknown, so every morning starts with `arc-studio usage --json`)

| Day | Arc Studio (free limit) | Claude, locally (free) | GitHub CI | You |
|---|---|---|---|---|
| **Sun 25 Oct** (today) | None. Limit is at 100%. | Plan only. Nothing built. | – | Answer D1 to D7. |
| **Mon 26 Oct** | If the limit has reset: **T1** (record the full test run). Otherwise wait. Free: `arc-studio ls --session arc-arena` to see the sandbox stack. | Build the **phone screens** from `docs/WEBSITE.md` (three small market cards in one row, selected market, Who's calling with the four agents, the lime Your call panel, Live calls, Your calls), all "not live yet". Confirm Chainlink feeds on Arc mainnet (read-only on-chain calls). | Keep green | Open data.chain.link, find BTC, ETH, SOL feeds on Arc, send me the addresses (public addresses, not secrets). Fund the wallets (D6) once the plan is agreed. |
| **Tue 27 Oct** | **T2** (onchain A). | Finish screens and laptop layout. Add a testnet/mainnet setting to the site. If D1 = yes: deploy the **testnet** rehearsal with our script (`--rounds 10min`), run the runner live. Write the T3/T4 prompts. | Runner tests if changed | Test the screens in phone view. OK for the testnet deploy. |
| **Wed 28 Oct** | **T3** (onchain B). | Copy T2 into `web/`, fix types, build, test connect + read against the testnet contract. **Checkpoint:** if fewer than 2 turns have gone through by tonight, we cut scope (see below). | Build `web/` in CI | Test connect wallet on your phone. |
| **Thu 29 Oct** | **T4** (mainnet deploy). If Arc Studio cannot do mainnet: our script (D4). | Copy T3 into `web/`. Create the three 1-hour markets on mainnet (no mock feeds; real Chainlink), min stake 0.10 USDC. Verify source on explorer.arc.io. First tiny real call from the site (a wallet of yours). Start the settle loop (settles after each round ends; mainnet needs no price pushes). | – | Make the first real call on mainnet (1 USDC or less). |
| **Fri 30 Oct** | **T5 / T6** only if something is broken. | Deploy `web/` to **Vercel** (public link). Test on a real phone on mainnet. Complete one full cycle: call, lock, end, settle, claim (a 1-hour round takes about 2 hours, so start in the morning). Make a few more real calls so the mainnet history has several transactions. Secret check, then make the repo public. | – | Test on your phone. Approve the repo going public. |
| **Sat 31 Oct** | None (spare). | Write the README and submission description; video script and checklist; update this file with all addresses and hashes. | – | Record the video (Arc Studio build + the mainnet transaction). **Submit by evening.** |
| **Sun 1 Nov** | Spare. | Buffer for anything that failed. | – | Emergency fixes only. |
| **Mon 2 Nov** | – | – | – | Deadline 05:59 Lagos. Nothing planned. |

### What we give up, in this order, if turns run short
1. House agents on mainnet (they need Circle LIVE wallets). 2. Laptop layout polish, candles, glow, ring. 3. WalletConnect. 4. SOL on mainnet. **Never cut:** contract on mainnet, one working call from the site, a mainnet transaction, the public repo, the video, the Arc Studio test record.

### Biggest risks
1. **The limit does not reset soon, or one turn eats a whole day.** Then fewer than four turns fit. Fallback: merge T2 + T3 into one prompt, drop T5/T6, and deploy mainnet with our script (D4). If by Wed night fewer than 2 turns have succeeded, we talk about scope before spending more.
2. **"App built in Arc Studio" is judged on what Arc Studio really built.** Keep a clean record: every prompt and every result saved in `docs/arc-studio-log.md`, show the Arc Studio work in the video, and state the split honestly.
3. **Chainlink feeds on Arc mainnet** might be missing, slow or stale. 1-hour rounds suit slow feeds; a refund still moves USDC. SOL may have to be dropped (D3).
4. **Pulled code may not fit Next.js** (Vite sandbox). Mitigation: plain React modules with pinned versions, tested in CI before the next turn.
5. **Real money, unaudited.** Tiny limits, owner pause, clear "experiment" labels, and the owner checks the legal side for themselves. This plan gives no legal advice.

### Secret check before the repo goes public
Search the whole git history, not just the current files, for: the `.env` file ever being committed; `PRIVATE_KEY`, any 64-hex-character strings, API keys (`TEST_API_KEY:`, `CIRCLE_API_KEY`, entity secret), the Circle recovery file; anything under `data/`. Review `deployments/*.json` (only public addresses and wallet ids should be there). If anything is found, rotate that secret first; deleting it from history alone is not enough. I report the result before anything is made public.

## 7. Submission description (draft, honest split)

Kairo Markets lets people call the next 1-hour move of BTC, ETH and SOL, UP or DOWN, in USDC on Arc. Winners split the losing side's pot (2% of winnings; no fee if you lose or are refunded); one-sided or unusable rounds are refunded. Prices come from Chainlink feeds. **Built where:** the smart contract was written and tested in Arc Studio, and one full test run was recorded there before the mainnet deploy. Further tests (239 in total, plus 41 deliberate-break checks that the tests all catch) run on GitHub Actions. The app's screens and design were built locally with Claude Code. The app's onchain features (connect wallet, make a call, claim, read rounds) were built in Arc Studio from those screens. The price runner, the house agents and the deploy scripts were built locally. The first draft of the connect-wallet button was written locally and replaced by Arc Studio's version.

## 8. Facts to keep for the form (fill in as they happen)
- Arc Studio project URL: `https://studio.arc.io/app/a8e053bb-4ebd-4ed7-bde8-7be48ef04a5b` (from our saved session notes; confirm it opens).
- Builder profile: GitHub `Ffrank-Michael`. Repo: `kairo-markets` (private until the secret check passes).
- Arc Studio turn costs measured: _none yet_.
- Testnet addresses: _not deployed_. Mainnet addresses: _not deployed_.
- Example mainnet transaction and explorer.arc.io link: _none yet_.
- Live app link: https://www.kairomarkets.xyz (also https://kairomarkets.vercel.app). Video link: _none yet_.

## Decisions made 2026-10-26 (owner)

- D1 Rehearse on testnet with our own deploy script first (no Arc Studio turn used).
- D2 The 1 USDC maximum per call is enforced in the site and the runner only; no contract change.
- D3 Ship mainnet with all three markets if SOL has a feed. Checked: it does (see below).
- D4 If Arc Studio cannot deploy to mainnet, deploy with our own script and confirm the deployed bytecode matches the Arc Studio code exactly.
- D5 Replace the locally written connect-wallet code with Arc Studio's version (sent as a reference file; the description says so honestly).
- D6 The owner funds the mainnet wallets when we reach mainnet (about 2 USDC deployer, about 3 USDC test wallet).
- D7 Licence: MIT (LICENSE file added when the repo goes public).

## Chainlink on Arc mainnet, checked on chain 2026-10-26 (read-only)

Source list: https://reference-data-directory.vercel.app/feeds-arc-mainnet.json. All three answer `description()`, `decimals()` (8), `latestRoundData()` and `getRoundData(id)`; a made-up round id reverts, as the contract expects. Prices matched Bitfinex within the feeds' deviation thresholds.

| Market | Proxy (use this) | Secondary proxy (not used) | Deviation | Heartbeat |
|---|---|---|---|---|
| BTC/USD | 0xa109B535C70C8Be9995be64Bb6751AcDB27e03De | 0x7777547914e03BCbB04Ae034942765a0dbb26aE3 | 0.1% | 24 h |
| ETH/USD | 0x50FCDD99D6762D1C170DC6A9111db944AEE6D364 | 0x2c7Dc3567b3490f53A8d32625d766834dd023F60 | 0.5% | 24 h |
| SOL/USD | 0x2d04D354f5fDaE3De723df475745B0a9B4edf90C | 0xaD902511CbF378977149687D6aFB7D93A390D06e | 0.5% | 24 h |

The main proxies are on phase 1; the secondary proxies on phase 2. We do not know from the list alone what the secondary proxy is for.

Honest limit: these feeds update only when the price moves past the deviation threshold, or after 24 hours. See "Time frames" below for the measured update history and what it means for round lengths. (An earlier note here, "BTC will settle most hours", came from only the last six updates and was wrong; the longer measurement below replaces it.)

## Time frames (owner's request 2026-10-26; plan only, nothing deployed)

The contract already allows any round length from 5 minutes (`MIN_ROUND_LENGTH`; the offset must be less than the round length). So a coin can have several markets, one per time frame; each market is its own `createMarket` call (name like "BTC/USD 1h"). Markets of the same coin share one price feed.

### How often a round would refund on Chainlink (measured, read-only, Arc mainnet, 2026-10-26)
A round settles with a result only if the feed updates **at least twice inside the round** (start price = first update at or after lock, end price = last update at or before the end; one update means start = end, none means no start price, and both refund with no fee). I took the real update times from the three main proxies and replayed every round on the clock grid. Data: BTC 1,500 updates over 23 days (2 Oct to 25 Oct), ETH 400 updates over 26 days, SOL 400 updates over 16 days. The measuring script was read-only and is not committed.

| Round length | BTC refunds | ETH refunds | SOL refunds |
|---|---|---|---|
| 5 min | 96% | 100% | 100% |
| 15 min | 84% | 98% | 97% |
| 30 min | 71% | 95% | 92% |
| 1 hour | 59% | 86% | 78% |
| 2 hours | 48% | 68% | 52% |
| 4 hours | 37% | 44% | 23% |
| 12 hours | 11% | 12% | 3% |
| 24 hours | 9% | 0% | 0% |

Update rate: BTC about 64 updates a day (median gap 6 minutes, 90% of gaps under 38 minutes, longest 24 hours), ETH about 15 a day (median gap 43 minutes), SOL about 25 a day (median gap 30 minutes). It swings a lot with how much the market moves: the most recent 3 days of BTC alone gave 65% refunds at 15 minutes and 9% at 1 hour. Quiet weekends are worse. This is history, not a promise.

### The mainnet set you asked for, with the real numbers
| Market | Rounds a day | Would refund | Settled with a result a day |
|---|---|---|---|
| BTC 15 min | 96 | 84% | about 15 |
| BTC 1 hour | 24 | 59% | about 10 |
| ETH 1 hour | 24 | 86% | about 3 |
| SOL 1 hour | 24 | 78% | about 5 |

With Chainlink as the source, **most** 15-minute rounds and most ETH and SOL 1-hour rounds would refund, and BTC 1 hour would refund more than half the time. Refunds are safe (no fee, the money comes back), but a product where most calls are refunded is a weak demo. ETH and SOL need longer rounds, as you said; BTC does too, which is more than I told you earlier.

### Recommended mainnet set (superseded on 2026-10-26 by "Mainnet plan v2" at the end of this file; kept for the record)
- **Option A (recommended): BTC 1h, BTC 4h, ETH 4h, SOL 4h.** Refunds 59%, 37%, 44%, 23%. About 42 rounds a day, about 22 of them settle with a result. Honest copy on the site: "Refunded if the price feed does not update during a round."
- Option B: your set (BTC 15m, BTC 1h, ETH 1h, SOL 1h). Same code, more refunds (see the table). Fine if you accept that.
- Option C: 12-hour rounds (BTC 11%, ETH 12%, SOL 3% refunds) are reliable, but only 2 rounds a day per coin is too slow for a demo.
- Option D (a bigger decision, not a default): for short rounds on mainnet, point the market at a price feed pushed by our runner (as on testnet) instead of Chainlink. Every round would settle, but it is not Chainlink and the owner would control the price, which changes the trust story and the "Chainlink on mainnet" requirement. I do not recommend it.

### Daily settling cost on mainnet
Gas price measured on the mainnet RPC today: 20.0 gwei (gas is paid in USDC). Settle gas is about 158,000 as measured on the mock feed (docs/RULES.md H3); the Chainlink version reads a few more rounds, so I also show 200,000 as the careful figure. Cost per settle: 0.0032 USDC (158k) to 0.0040 USDC (200k). Settling is needed only for rounds that had at least one call. Chainlink pays for its own price updates, so mainnet has no price-push cost.

| Set | Settles a day (worst case: every round had calls) | USDC a day |
|---|---|---|
| Your set (15m, 1h, 1h, 1h) | 168 | 0.53 to 0.67 |
| Option A (1h, 4h, 4h, 4h) | 42 | 0.13 to 0.17 |

Users pay their own gas to call and to claim. Realistically the cost is much lower, because only rounds with a call are settled.

### Testnet: 5, 10 and 30 minute markets for BTC, ETH and SOL (9 markets)
The test feeds are ours, so every round gets a start and an end price and settles (the refunds above are a Chainlink effect, not a testnet one). Stagger the three coins inside each time frame so the runner is not busy all at once: 5m offsets BTC 0, ETH 100, SOL 200; 10m offsets 0, 180, 360 (as now); 30m offsets 0, 600, 1200. One `MockPriceFeed` per coin, shared by that coin's three markets. Price pushes are then needed twice per 5 minutes per coin (start price at lock + 90 s, end price at end - 30 s, which also serves the longer markets of the same coin): about 72 pushes an hour at about 0.0023 USDC each (25 gwei), so about 0.16 USDC an hour for the deployer. Settles add about 0.004 USDC each for rounds that have calls. Testnet USDC is free from the faucet; the 24.8 USDC deployer balance lasts about 4 days at this rate.

### House agents on mainnet (suggestion)
- Only the **BTC 1h** market (the most settled rounds of the set), all four agents, stake 0.10 to 0.25 USDC. Gas per agent a day: 24 bets at about 0.0025 plus up to 24 claims at about 0.0016, so about 0.10 USDC; four agents about 0.4 USDC a day, plus the stake floating in open rounds.
- If gas or time is tight: only Trend Follower and Contrarian on BTC 1h (Contrarian needs a crowd to go against; the other agent and you provide it).
- No agents on the 4h markets at first (6 rounds a day each is too little to see, with the same refund risk).
- Mainnet agents need new mainnet Circle wallets. Registering the mainnet Circle entity secret and funding those wallets is done by you, not by me (Circle rule). If that does not fit the schedule it is on the cut list: the testnet agents keep running, and the mainnet demo is your own real call.
- Testnet agents: keep them on the 10-minute markets for all three coins (as now), plus Trend Follower and Coin Flipper on BTC 5m, so the 9-market site shows activity without paying settle gas on all nine.

### Deploy script plan (nothing deployed yet)
1. **One market list.** A new `scripts/markets.mjs` holds the named sets (`testnet`: the 9 markets above; `mainnet`: the set chosen in D8) with name, coin, round length and offset. The deploy script, the runner tests and the site's time frame buttons all read from it (through the deployment file), so they cannot disagree.
2. **Flag change.** `--rounds 10min|1h` is replaced by `--set testnet|mainnet`. Dry run stays the default; `--send` sends. Mainnet additionally requires `--network mainnet` and a typed confirmation, and prints the funds it will spend first.
3. **Feeds.** Testnet: deploy 3 `MockPriceFeed`s (as now) and reuse each across that coin's markets. Mainnet: deploy no feeds and use the Chainlink proxies in the table above. Before `createMarket` the script reads each feed on chain and stops unless `description()` matches (for example "BTC / USD"), `decimals()` is 8, and `latestRoundData()` is recent (under 24 hours) and above zero.
4. **Markets.** One `createMarket(name, feed, address(0), roundLength, offset, minStake)` per market, named like "BTC/USD 4h". After sending, read every market back and compare every field (round length, offset, min stake, not paused), as the script does now.
5. **Deployment file.** Records each market: id, name, coin, round length, offset, feed address. The site builds the time frame buttons from it and shows only the time frames that exist for that coin.
6. **Runner changes needed before the testnet rehearsal (D1):** read the market list from the chain (already done: it reads round length and offset per market); skip price pushes that would repeat on a shared feed at the same moment; make `lookback` depend on the round length so it covers the one-hour settle window (12 rounds for 5 minutes, 2 for 30 minutes); keep the mainnet runner free of price pushes (settle and agents only).
7. **Bytecode (D4).** On mainnet the deployed bytecode is compared with the Arc Studio source before and after sending, the same check as for testnet.
8. **Tests.** The contract is unchanged, so the 239 forge tests still apply. New tests for the market list and the feed check in the deploy script run on GitHub only. Nothing goes to Arc Studio for this.

### Site plan
A row of time frame buttons on each market card (for example 5m, 15m, 1h), built from the deployment file, showing only the ones that exist on the network the site points at. Selecting one switches the countdown and the call panel to that market. On mainnet the card also shows each market's measured refund history once the contract has any (never a made-up number). Not built yet; it waits on D8.

## Mainnet plan v2: guarded relay, 15-minute rounds, pay only when people play (owner's choice 2026-10-26; plan only, nothing built or deployed)

This replaces the "Recommended mainnet set (Option A)" above and settles D8. The owner wants BTC, ETH and SOL on mainnet with 15-minute rounds on a budget of about 10 USDC. Chainlink alone cannot do that (84% to 98% of 15-minute rounds would refund), so the price comes from our runner (Bitfinex last trade, as on testnet) through a relay contract that only accepts a price close to Chainlink's. That is "option D" from above, with a guard.

### 1. The Chainlink-guarded relay feed
- **New contract `GuardedRelayFeed`** (same `AggregatorV3Interface` as the testnet `MockPriceFeed`, so `PredictionArena` is unchanged). One per coin, shared by nothing else.
- `setPrice(answer)` can only be called by the **pusher** (the runner's wallet). It reverts unless: the answer is above zero; Chainlink's proxy for that coin (the table above) has an answer above zero that is no more than 26 hours old; and the answer is within the band of Chainlink's latest answer. The timestamp is always `block.timestamp` (no way to backdate), round ids follow Chainlink's phase scheme starting at phase 1, as in the mock.
- The guard address and the band are **fixed at deploy** (immutable), so even the owner cannot loosen the guard later. The owner can only replace the pusher (two-step ownership, renounce disabled), which is the key-rotation path if the runner key leaks.
- `description()` says what it is: "Kairo relay BTC / USD: Bitfinex last trade, checked against Chainlink within 1.0%". The site must say the same.
- **Band, from data.** I compared the Bitfinex price with the Chainlink answer in force for 10,000 minutes (6.9 days) per coin, worst point inside each minute:

| Coin | Median gap | 99% of minutes within | Worst minute | Minutes over 0.5% | over 1% | over 1.5% |
|---|---|---|---|---|---|---|
| BTC | 0.15% | 0.34% | 0.80% | 0.09% | 0.00% | 0.00% |
| ETH | 0.21% | 0.66% | 1.52% | 6.69% | 0.09% | 0.01% |
| SOL | 0.21% | 0.65% | 1.41% | 6.62% | 0.06% | 0.00% |

  Proposed bands: **BTC 1.0%, ETH 1.5%, SOL 1.5%**. A push outside the band reverts; that round then has no new update and refunds (safe, no fee). In the sample that would have blocked well under 0.1% of minutes. This is one week of history, not a promise: a very fast market could block pushes for a few minutes, and those rounds refund.
- **What the guard does and does not do (say this on the site and in the description).** It stops a wrong or hacked price far from the real market. It does **not** make the price trustless: the pusher key can still choose any price inside the band, and a 1.0% to 1.5% band is wider than a typical 15-minute move (about 0.3%). So the mainnet trust statement is: "prices are pushed by Kairo from Bitfinex and must stay within 1.0% to 1.5% of Chainlink's on-chain price". That is a real change from rule "owner cannot touch prices"; docs/RULES.md must be updated when this is approved.
- **Build path.** It is a new contract, so it goes through Arc Studio like the others: use the T5 reserve turn to have Arc Studio write it and run its tests. The extra tests (band edges, stale guard, pusher only, round ids, phase, arena settling against it) and the deliberate-break checks run on GitHub, not in Arc Studio. This uses one of the reserve turns and Arc Studio is still at 100% today, so it competes with T1 (the full test run); see the ledger.

### 2. Pay only when people play: does the contract allow it? Yes. Checked in `PredictionArena.sol`
- **Empty round:** nothing is stored and nothing needs to happen. `claim` on it reverts "nothing to claim". No cost.
- **One-sided round that nobody settles:** `claim()` and `claimMany()` call `_claimOne`, which, for an unsettled round after `end + SETTLE_WINDOW` (1 hour), finalises it as a **Timeout refund** and pays back the full stake with **no fee** (`claim`, lines 1154-1163). `markRefunded()` does the same for anyone. `claimable()` already previews it as a refund. So no settle transaction is needed. Existing tests cover the timeout refund (`test_refund_timeout_viaAutoFinalise`, `test_markRefunded_worksAfterWindow`, `test_claimable_timeoutBoundary_exactlyAtDeadline`) and a settled one-sided refund (`test_refund_oneSided_*`), but **not** the exact combination "one-sided, never settled, claimed after the window". I will add that test (GitHub only) before mainnet.
- **What the user feels:** a one-sided call is refunded no earlier than 1 hour after the round ends, so up to about 1 hour 15 minutes after it locked. The site must show "Refund available at hh:mm" and a Refund button. The first person to claim pays slightly more gas (they finalise the round).
- **Two-sided round and the runner stops or dies:** if the start price was pushed but no end price, then "last update at or before the end" is the start update itself, so start equals end and the round refunds. If nothing is settled, it times out as a refund after 1 hour. Either way nobody loses money to a runner failure.
- **Prices pushed only for two-sided rounds.** Bets close at lock, so the totals are final at lock. The runner reads the round once, and only if both sides have money does it push the start price (lock + 90 s, quote at least 30 s after lock, the existing fairness rule H2), push the end price (end - 30 s) and settle after the end. No mid-round push on mainnet. Rounds run back to back, so each played round costs exactly two pushes even when the next round is played too.

### 3. House agents on mainnet
- **Contrarian:** in each market, about 45 seconds before lock, if anyone other than itself has called, it bets the opposite side of the heavier side with stake = the opposing total, at least 0.10 and at most 0.25 USDC. That makes the round two-sided.
- **Be clear about what that means for users.** Parimutuel payouts: a user who stakes 1.00 UP against a Contrarian 0.25 DOWN wins at most 0.245 (0.25 less the 2% fee) and loses 1.00 if wrong. That is a poor bet for the user at 50/50, and the pool shown on the site says so. A larger Contrarian stake is fairer to users but puts more of the house bankroll at risk, so the stake cap is a dial: 0.25 now. (The site shows the "estimated payout" before confirming, and the 1 USDC cap per call from D2 stays.)
- **The house is a gambler, not only a cost.** With stake s on a round, the Contrarian wins or loses about s per round at roughly even chances (minus 2% of what it loses). Over 30 rounds a day with s = 0.25 the daily swing is about 1.4 USDC either way (0.25 x the square root of 30), with 2.5 USDC of bankroll. It can run dry in a bad stretch. With 0.10 stakes the swing is about 0.55 USDC. Rule: the Contrarian stops for the day if its balance falls under 0.5 USDC.
- **Trend Follower, Chart Reader, Coin Flipper:** a light schedule, 6 calls a day each (about one per 4 hours, rotating BTC, ETH, SOL, started at different minutes so they rarely meet), stake 0.10 USDC. Their only job is to keep the page alive. Each of their rounds then gets a Contrarian join, so it is played.
- **Wallets.** Circle mainnet developer-controlled wallets need a mainnet Circle account, a mainnet entity secret and recovery file registered by you (Circle rule; I may not do it) and funding of four wallets. A cheaper option for four tiny wallets: a script generates four ordinary wallet keys straight into `.env` (never printed, never in chat) and you send each some USDC. Recommended for the deadline; the keys are hot keys on your PC holding a few dollars each.

### 4. Safety: deployer floor of 2 USDC
- Before every transaction the runner reads the deployer's USDC balance. If it is **below 2.00 USDC** the runner sends nothing more, writes "STOPPED: deployer balance X USDC is below the 2.00 floor", sends the alert and exits. All sending stops, including the agents', so no new round starts that cannot be finished. Rounds in flight end as refunds (section 2). Restart is manual after you top up.
- **Alert channel (you choose):** ntfy.sh (a free phone push; the runner posts one plain line with the balance, no secrets, to a topic name you put in `.env`), a Telegram bot (needs a bot token you put in `.env`), or email. I recommend ntfy.sh. It sends a message to an outside service, so I will only enable it after you pick a topic.
- Also stop and alert if: a push is rejected by the guard three times in a row, the Bitfinex quote is unavailable for more than 5 minutes, or the chain RPC fails for more than 5 minutes.
- **Runner uptime:** the runner is a program on your PC. It must be running for pushes, settles and the Contrarian. A sleeping PC means no start or end prices, so those rounds refund (safe, but the demo looks idle). A small always-on host would fix it; not planned.

### 5. Numbers (mainnet gas price measured today: 20.0 gwei; gas is paid in USDC)
Gas per transaction is from the testnet runs (docs/RULES.md H3); the relay push is the mock's 90,000 plus about 15,000 for the guard's read of Chainlink; settle has a careful upper figure of 200,000.

| Transaction | Gas | USDC |
|---|---|---|
| Price push (relay) | about 105,000 | 0.0021 |
| Settle | 158,000 to 200,000 | 0.0032 to 0.0040 |
| Bet (agent call) | 127,000 | 0.0025 |
| Claim (agent) | 81,000 | 0.0016 |

- **One-time deploy:** the dry run on the real script estimates PredictionArena at 2.58M gas and a feed at 0.57M (the relay adds a little, call it 0.65M each), plus three `createMarket` calls (the script guesses 400k each; real cost is probably nearer 200k). Total about 5.1M to 5.7M gas, so **about 0.10 to 0.12 USDC**, and 0.14 USDC if gas doubles to 25 gwei plus the guess (the script's own figure at 25 gwei is 0.137). Add about 0.01 for the later ownership transfer. **Say 0.15 USDC all in.**
- **Cost per played round (house side): 0.0074 to 0.0082 USDC.** Two pushes (0.0042) plus one settle (0.0032 to 0.0040). Users pay their own bet and claim gas. Empty and one-sided rounds cost the house 0.
- **Cost per agent call: 0.0025 USDC to bet, plus 0.0016 USDC to claim** when it wins or is refunded (the first claim after a timeout refund costs a bit more because it finalises the round).
- **Daily estimate for 30 played rounds** (assume 12 started by real users and 18 by the three light agents; every one has a Contrarian join):

| Item | Count | USDC a day |
|---|---|---|
| Price pushes (deployer) | 60 | 0.126 |
| Settles (deployer) | 30 | 0.095 to 0.120 |
| Contrarian bets | 30 | 0.076 |
| Contrarian claims (it wins or is refunded about half the time) | 15 | 0.024 |
| Light agents' bets | 18 | 0.046 |
| Light agents' claims (about half) | 9 | 0.015 |
| **Total gas** | | **about 0.38 to 0.41** (0.013 per played round) |
| Of which the deployer wallet | | 0.22 to 0.25 |

  Stakes are on top of gas: the house money that moves is up to 0.25 per Contrarian join and 0.10 per light-agent call, and it comes back or goes to users as the rounds resolve.
- **Budget on about 10 USDC** (replaces the D6 figures of 2 and 3 USDC):

| Wallet | USDC | Why |
|---|---|---|
| Deployer / runner | 4.00 | 0.15 deploy, 2.00 safety floor, about 1.85 to run on, which is 7 to 8 days at 0.22 to 0.25 a day |
| Contrarian | 2.50 | stakes up to 0.25 per join, plus gas |
| Three light agents | 2.10 (0.70 each) | stake 0.10 per call plus gas, about 0.03 a day each |
| Your test wallet | 1.00 | your own calls and claims |
| **Total** | **9.60** | about 0.4 left as slack |

  The grant needs at least one mainnet transaction moving USDC and an example transaction on the explorer; this plan gives many. From Thursday 29 Oct to Monday 2 Nov is 5 days: about 2 USDC of gas, so the budget covers it with room for the house's stake swings.

### 6. What changes in the build plan (still nothing built)
- **Contracts:** `GuardedRelayFeed` (new, via Arc Studio T5) and its tests; one new arena test (one-sided unsettled round claimed after the window). `PredictionArena` is unchanged.
- **Deploy script:** `--set mainnet` deploys 3 relay feeds (pusher = the runner wallet, guard = the Chainlink proxy, band 1.0%/1.5%/1.5%) and 3 markets of 900 s with offsets 0, 300, 600 (BTC, ETH, SOL staggered by 5 minutes). Before sending, it reads each Chainlink proxy on chain (description, decimals 8, answer above zero and recent) and the bytecode comparison (D4) runs as planned.
- **Runner:** a mainnet mode: lazy pushes and settles only for two-sided rounds, no mid-round pushes, the balance floor and alerts, Contrarian rule above, light schedule for the others. It reuses the existing start/end price timing rules and tests, plus new tests (lazy mode, floor stop, alert called once).
- **Site:** time frame buttons are not needed on mainnet (one 15-minute market per coin); they stay for testnet's 5/10/30 markets. New text: the price-source line above, "Refund available at hh:mm" for one-sided rounds, and the Contrarian's join visible in Live calls like any other call.
- **Docs:** RULES.md gets the mainnet price-source and owner-power change; the submission description says the relay and guard honestly.
- **Open points for you:** (a) alert channel; (b) agent wallets by script or Circle mainnet; (c) Contrarian stake cap 0.25 or other; (d) accept the trust statement in section 1; (e) the T5 turn for the relay contract while Arc Studio shows 100% used.

## Changes and answers, 2026-10-26 (later)

- **Beta limit raised from 1 to 10 USDC per call (supersedes D2's "1 USDC").** Enforced on the site (amount field, message "Beta limit: 10 USDC per call") and in the runner (`maxStake` in `runner/config.mjs`, 10 USDC). It is still not enforced by the contract, which only has the 0.10 USDC minimum per market, so anyone calling the contract directly can stake more; the owner can pause a market. Say this openly in the description. The contract minimum stays 0.10 USDC for all mainnet markets.
- **Amounts on the site:** default $1; quick buttons $1, $5, $10; a field to type your own amount with the note "Minimum 0.10 USDC"; a small "Beta" label on the Your call panel. (The earlier $0.25, $0.50, $1 buttons were for the 1 USDC cap.)
- **Answers to the mainnet plan v2 questions:** (1) alerts go through ntfy.sh with a long random topic name that the owner puts in `.env`; (2) mainnet house agents use four new keys written into `.env` by a script that never prints them, while testnet keeps Circle wallets, and the description says so honestly; (3) the Contrarian matches the user's stake up to 0.50 USDC and stops for the day below 0.50 USDC, and the site always shows the real estimated payout (this replaces the 0.25 cap in section 3 of plan v2); (4) the owner accepts the trust statement and the extra Arc Studio turn (T5) for the relay contract.
- **Worth knowing about the Contrarian match:** with a 10 USDC beta limit and a 0.50 USDC match, a user who stakes 10 against the Contrarian's 0.50 would win at most 0.49 and lose 10 if wrong. The estimated payout on the site must show this before the user confirms. A smaller default stake ($1) keeps the typical call closer to an even match.
- **Not done yet (asked, waiting):** the band table (0.3% to 1.5%) for Bitfinex, Coinbase and Kraken; the missing arena test (one-sided, never settled, claimed after the window, full refund) run on GitHub; "Refund available at hh:mm" on the site; Slither on GitHub; the security review request added to the T1 turn.

## Mainnet plan v3 (owner's decisions 2026-10-26; plan and site copy only, runner and contracts not changed yet)

**Target:** mainnet is the goal; testnet is a short rehearsal of the same thing. This replaces the 15-minute rounds of plan v2 and the 9-market testnet set.
- **Markets (mainnet and the testnet rehearsal): BTC, ETH, SOL at 5 minutes and at 10 minutes = 6 markets,** each pair on one guarded relay feed per coin, prices pushed only for rounds with calls on both sides (everything else in plan v2 stays: contract refunds one-sided rounds by timeout, 2 USDC deployer floor, ntfy alert, Contrarian rule, four script-made agent keys). Offsets: 5 min BTC 0 / ETH 100 / SOL 200 s; 10 min BTC 0 / ETH 200 / SOL 400 s. The 30-minute testnet markets are dropped.
- **Cost:** per played round it is still 2 pushes + 1 settle (about 0.0074 to 0.0082 USDC); only the number of played rounds matters, so the daily estimate for 30 played rounds (0.38 to 0.41 USDC) is unchanged. A 5-minute round has twice as many chances to be played, so a busy day costs more; the daily deployer floor alert covers it.
- **Band decided (owner, 2026-10-26): BTC 1.0%, ETH 1.5%, SOL 1.5%.** The Coinbase/Kraken comparison table was skipped.
- **Site:** the faucet link is shown only when `NEXT_PUBLIC_NETWORK` is not `mainnet` (`web/lib/network.ts`). The call panel now reads "Next round: UP or DOWN?" with a countdown to when the round starts. A "How it works" page is linked from the top bar. These are built.

### Start price: how close to the lock can it be, and still be fair? (re-checked with Bitfinex live trades)
- **Why 90 seconds existed:** CoinGecko lagged the real market by up to 89 s, so a start price pushed soon after lock could be an old price that a bettor watching a live exchange already knew. With the price now taken from Bitfinex's own last trade, that lag is gone.
- **The fair rule:** the start price must be a trade that happens **after** calling closes. Then nobody can know it when they call, however short the wait. Time margins only have to cover clock differences and the push delay.
- **Measured now (10 samples per coin, a quiet hour):** age of Bitfinex's last trade when asked: BTC median 8.7 s (max 13), ETH 7.4 s (max 15), SOL 13.3 s (max 29). One request takes about 0.5 s. So "the quote was made after lock" is not enough, because the last trade can be 10 to 30 seconds older than the quote and could be from before the lock.
- **New rule (H5, replaces the 90 s delay and the 30 s quote margin):** start price = the first Bitfinex trade whose own time is at least 2 s after the lock, pushed as soon as it is seen. Expect about 5 to 15 s after the lock for BTC and ETH, up to about 30 to 45 s for SOL on a quiet hour. If no such trade has arrived by 15% of the round (45 s on 5-minute rounds) it keeps trying until 25%, then gives up and the round refunds. The end price is the last trade, pushed 15 s before the end (was 30 s). No mid-round push.
- **What had to change before the rehearsal (BUILT 2026-10-26, see RULES.md H5):** `runner/exchangePrices.mjs` must filter on the trade's time (it only filters on the quote time today); `runner/plan.mjs` and `runner/config.mjs` replace `startDelay` 90 and `startQuoteMargin` 30 and the tests that pin them (`runner.test.mjs` lines 43 to 45, 182 to 216); the loop must tick every 3 to 5 s around each lock and end (it ticks every 10 s now); the Bitfinex limit of one request per 5 s per coin stays. `docs/RULES.md` H2 and the "about 2 minutes" wording are superseded by H5 below.

### Sign in (plan; Google comes right after the onchain features work, so not before Thu 29 Oct)
- **WalletConnect for wallet apps:** needs a free Reown (WalletConnect) project id that you create; added to the wagmi config with the onchain features (T2). Until then the "open in your wallet app" links stay.
- **Google sign-in with Circle user-controlled wallets:** the same Google account brings back the same wallet and balance. You create the Circle app id and a Google sign-in client in their consoles (I may not); the Circle API key stays on the server (Vercel environment, never in the page). The user sets a PIN for the wallet, and each call or withdrawal asks for it. **To verify before starting:** that Circle's user-controlled wallets support Arc mainnet (the Circle skill I have confirms Arc only for developer-controlled wallets). Contract calls for these users go through Circle's challenge flow (approve USDC, then the call), a second path next to the wagmi one, so this is a real piece of work. **Decide on Thu 29 Oct:** if the onchain features are not done and tested by then, Google sign-in moves to after the submission (the description says wallet connect only).
- **Google users get two buttons:** **Deposit** (their address, a QR code, the line "Send USDC on the Arc network to this address") and **Withdraw** (send USDC to any address; shows the amount, the address in full and a confirm step). **Connected wallets** see a note instead: "Your money stays in your own wallet. Kairo only holds it while a round is open; claim sends it back."
- **"Get USDC on Arc" section** (a page linked from the top bar and from empty-balance messages): how to get USDC onto Arc mainnet, for someone new. Content to be checked against docs.arc.io and Circle's bridge pages when written (no unverified claims): bring USDC from another chain with Circle's bridge (CCTP, Arc domain 26), or withdraw USDC to your Arc address from an exchange that supports it; "Arc network, chain id 5042, gas is paid in USDC". The faucet is shown on testnet only.

## Order of work set 2026-10-26
1. Check Arc Studio usage; if reset, T1 (full test suite plus a security review). 2. GitHub: the one-sided-never-settled refund test, and Slither. 3. "Refund available at hh:mm" on the site. 4. Runner on the H5 start-price rule, with tests. Accepted: the four accuracy changes on the How it works page.

## Results: Arc Studio turn T1 and Slither (2026-10-26)
- **T1 (Arc Studio, default preset, no files changed):** all 7 suites, **239 tests passed, 0 failed, 0 skipped** (includes 4 invariants, 256 runs of depth 30). Arc Studio usage after the turn: 30% of the 30-day window (was 29%). The same suite, plus the new one-sided-never-settled refund test (`Claim.t.sol`), passes on GitHub too (Tests workflow).
- **Arc Studio security review: no high findings.** Its list and my reading of each (the contract is final and tested, so none changed it):
  - M-1 "settle() can be front-run": **not a problem.** The contract checks the round ids against the rules (first update at or after lock, last update at or before end), so only one outcome is valid and a front-runner can only do what the honest caller does. Anyone being allowed to settle is by design (rule on who settles).
  - M-2 "no staleness check": **by design.** A round whose feed has no update inside the window refunds (rule: no update); the relay's guard (plan v2) covers a stale price source.
  - L-1 transfer-before-accounting order in `placeBet`: **by design**, in the comment on that line (`totalPlayerFunds` never leads the balance); USDC is a fixed address.
  - L-2 `uint128` cast of the bonus total: unreachable (it would need more than 3 x 10^32 USDC). Could use `SafeCast` in a later version.
  - L-3 `markRefunded` has no `nonReentrant`: moves no USDC, harmless; consistency only.
  - L-4 "no zero-owner check": **wrong.** OpenZeppelin's `Ownable(_owner)` itself reverts with `OwnableInvalidOwner(0)`.
  - I-1 to I-4: logging of empty rounds, no market cap, who pays for settle (the runner), `W > 0` precondition: noted, no change.
- **Slither 0.10.4 (GitHub Actions, workflow "Slither", OpenZeppelin/tests/mocks excluded): 16 results, none high.** 2 medium `unused-return` (the two oracle read helpers ignore the round id and the answered-in-round values on purpose), 6 low `timestamp` (the contract is built on time, by design), 8 informational (7 `costly-loop`, 1 naming of the immutable `USDC`). Nothing to fix before mainnet.
- Still to do about the contract before mainnet: nothing from these two reviews. The relay contract (`GuardedRelayFeed`) will get its own tests, Slither run and Arc Studio review.

## Result: Arc Studio turn T5, GuardedRelayFeed (2026-10-26)
- **Written and tested in Arc Studio** (two turns, usage 30% to 31%): `contracts/GuardedRelayFeed.sol` and `contracts/test/GuardedRelayFeed.t.sol` (54 tests, including a full round against the real `PredictionArena`). Constructor `(owner, pusher, guard feed, bandBps 1..1000, description starting "Kairo relay ")`; guard, band and decimals immutable; `setPrice` pusher only; reverts on answer <= 0, guard unreadable, guard answer <= 0 or above uint128, guard older than 26 hours (or in the future), or a push outside the band (edge allowed); owner can only replace the pusher; two-step ownership, renounce disabled; round ids `(1 << 64) | n`, timestamps `block.timestamp`.
- **Second turn:** my reading of the first version found that a guard answer above `type(uint256).max / bandBps` skipped the band check, so a broken guard feed would have switched the guard off. Arc Studio's own review called it "info"; I judged it a real flaw, and the second turn removed it (guard answers above uint128 now revert) and added 3 tests.
- **GitHub:** Tests workflow 294 passed, 0 failed (239 + the refund test + 54 relay tests). Slither on the relay: 1 medium `unused-return` (the guard read ignores round id and the other fields on purpose), 1 low `timestamp` (by design), 1 informational naming. Nothing to fix.
- **Arc Studio's security review of the relay:** no high. M-1 the pusher key can push any price inside the band (the stated trust model; the owner can replace the key at once); L-1 no push rate limit (not needed, each push costs the pusher gas); L-2 decimals are read once at deploy (redeploy if Chainlink ever changes them); L-3 the 26-hour guard age is wide (kept: it is about one Chainlink heartbeat plus slack; can be shortened before deploy); I-1 fixed in the second turn.
- Still before mainnet: deliberate-break checks for the relay (GitHub), deploy script for the relay feeds.

## Relay deliberate breaks and the deploy script (2026-10-26)
- **Deliberate breaks for `GuardedRelayFeed` (GitHub, workflow "Deliberate-break check", ids R01 to R31): 30 caught, 1 survived, 0 invalid.** The one that survived, R04 ("a guard answer with `updatedAt` 0 is accepted"), is an equivalent break: with `updatedAt` 0 the guard looks about 56 years old, so the age check rejects the push anyway (only the error name differs). Nothing to fix. `ci/mutate.js` now takes a `file` field per break; the 41 arena breaks are unchanged.
- **Deploy script (`scripts/deploy.mjs`, lists in `scripts/markets.mjs`), nothing sent yet.** `--set rehearsal` (Arc testnet) or `--set mainnet`; dry run is the default. Both sets are the same six markets: `BTC/USD 5m`, `ETH/USD 5m`, `SOL/USD 5m` (offsets 0, 100, 200 s) and `BTC/USD 10m`, `ETH/USD 10m`, `SOL/USD 10m` (offsets 0, 100, 200 s, changed from 0, 200, 400 on 26 Oct so a coin's two markets share lock and end times), minimum stake 0.10 USDC, one `GuardedRelayFeed` per coin shared by that coin's two markets (band 1.0% BTC, 1.5% ETH and SOL, owner and pusher = the deployer wallet unless `--pusher` is given).
  - **Mainnet:** the guards are Chainlink's three proxies. Before anything else the script reads them on chain and stops unless each says the right name ("BTC / USD"), has 8 decimals, an answer above zero and is under 26 hours old. Sending needs `MAINNET_DEPLOYER_PRIVATE_KEY` in `.env` (a new wallet, not the testnet one), at least 2 USDC in it, and the flag `--i-understand-this-spends-real-usdc`. Today's dry run read all three proxies fine (BTC about 80,130 USD, 0 h old; ETH 2,315, 0.4 h; SOL 100.7, 0.2 h) and estimated about 0.18 USDC at 25 gwei.
  - **Testnet rehearsal:** Chainlink has no feeds we rely on there, so each coin gets a test stand-in (a `MockPriceFeed` labelled "TEST PRICES - NOT REAL DATA / Chainlink stand-in") that receives a first Bitfinex price at deploy; the relay description says "TESTNET REHEARSAL" and does not claim Chainlink. Estimated cost about 0.23 USDC. The rehearsal proves the relay, the six markets, the shared feeds and the H5 runner, not Chainlink itself.
  - **After sending** it reads everything back: owner, pusher, guard, band, 26 h limit, decimals, description, all six markets, and compares the deployed code with the code compiled from the repo (arena, relays, stand-ins). `scripts/verify-source.mjs --set rehearsal|mainnet` publishes the source on the explorer.
  - 11 new tests (`node --test scripts/markets.test.mjs`, also in the Tests workflow): the market lists, offsets, bands, descriptions, Chainlink addresses, and the guard check (exactly 26 hours old passes, one second more fails).
- **Runner changes the six markets needed (built, 78 runner tests pass):** the planner pushes to the feed the market actually uses (read from the chain); BTC 5m and BTC 10m share one relay, so a price due for both is pushed once; prices are asked per coin, so "BTC/USD 5m" and "BTC/USD 10m" share the Bitfinex cache and the one-request-per-5-seconds limit; in the rehearsal the executor also pushes the same price to the coin's stand-in first, so the relay's guard never goes stale. **Still to build for mainnet:** lazy mode (push and settle only rounds with calls on both sides), the 2 USDC floor with the ntfy alert, the Contrarian rule, the four agent keys, and a runner mode that reads `arc-mainnet.json`.

## Results: Arc Studio turns T2 and T3, the time-frame switch, and the site reading the rehearsal contracts (26 Oct)

- **T2 (reads, wallet) and T3 (make a call, claim, plain-words errors)** ran in the Arc Studio session `arc-arena`; the files are `src/onchain/*` there (57 unit tests passed in the sandbox: schedule, claimable amounts, error messages). Usage after both turns: 64% of the daily limit (T2 about 6%, T3 about 26%).
- **What had to change when copying into `web/`:** the sandbox has wagmi 2.x, the site 3.7.7 (`useAccount` is `useConnection` there, the switch-chain hook returns a mutation); the env file reads `process.env.NEXT_PUBLIC_*`; the arena address comes from the deployment file instead of a typed-in address. Arc Studio's `useMakeCall` stopped after the checks and left sending to its demo page, so `web/onchain/useMakeCall.ts` runs the whole flow (checks, approve 10 USDC if needed, simulate, send, wait for receipt). Its claim hooks invalidated queries while rendering; `useClaim.ts` does it once after the receipt. New files written on our side: `useAllRounds.ts` (all markets in one multicall), `useLiveCalls.ts` (BetPlaced events; the public RPC refuses log ranges above about 5,000 blocks, so it looks back 4,000), `payout.ts` (estimate, 4 tests). The Arc Studio app keeps its own copy of the T2/T3 version.
- **Beta limit:** 10 USDC per wallet in each round (existing calls on the round plus the new one), enforced on the site only.
- **Time-frame switch:** two buttons (5m, 10m) above the coin cards; the market list comes from `web/lib/deployment.generated.json`, a public-facts copy of `deployments/arc-testnet.json` made by `scripts/sync-web-deployment.mjs` (runs before `npm run dev` and `npm run build`; a test fails if the copy is stale).
- **End price margin:** now 60 s before the end (was 15 s). A push takes about 13 s on the testnet (two transactions); in the rehearsal 22 end prices landed 36 to 55 s before the end. Cause of the earlier late push: ETH 5m and SOL 10m ended at the same second, so the second push started after the end. A coin now has one offset for both time frames (BTC 0, ETH 100, SOL 200).
- **Rehearsal arena (redeployed 26 Oct, new offsets):** `0xec52762e8f91b2380d39cf2d03101412a8a3530c`; relays BTC `0xbedb9f42fec4640fe77372f169e7a5be96fd3910`, ETH `0x0078011b069e45b60ad547d71b638a149b027f22`, SOL `0x5e036746221c450b6adc8c9c40bf12b8ebe86563`. The first rehearsal arena (`0x030de34b…`) is retired.

### 26 Oct (later): twelve markets and a call panel with a time-frame row
- **30-minute and 1-hour markets added** for BTC, ETH and SOL (same offsets 0 / 100 / 200 s, so one price push still serves all four time frames of a coin). Both the rehearsal and the mainnet list are now **twelve markets** (mainnet: 12 `createMarket` calls). The six new markets were created on the existing rehearsal arena (ids 6 to 11, names `BTC/USD 30m` ... `SOL/USD 1h`) with `deploy.mjs --set rehearsal --send`, which skips every step already done; the read-back checks passed for all twelve.
- **Site:** the market cards at the top choose the coin; the call panel has one time-frame row (5 min, 10 min, 30 min, 1 hour), the big amount box, the total in the round with UP and DOWN underneath, and a spending-limit line ("Spending limit: $X left · Change") that opens the editor with Remove. Checked with Playwright screenshots at 390x844 and 1440x900.
- **Fee:** `FEE_BPS = 200` is a constant in the contract. It is not adjustable.

### 26 Oct (evening): proof on every round, receipts, minimum call 0.50
- **Minimum call 0.50 USDC** for every new market (`MIN_STAKE` in `scripts/markets.mjs`, mainnet and rehearsal). The twelve rehearsal markets already deployed keep 0.10 (it is fixed when a market is created); the deploy script's read-back now compares each market with the minimum it was created with. The site reads each market's minimum from the contract.
- **Refund reasons in plain words**, from the contract's `RoundSettled` event: "No one on the other side", "Price didn't change", "No price received in time". Example found on the chain: BTC 5m 12:15-12:20 (Lagos time) was refunded with reason EndNotAfterStart because no price was pushed between 11:04:18 and 11:20:22 UTC (the price runner was stopped while the six new markets were created).
- **Start and end price on every round**, each with a "Verify" link to the transaction on the price relay that recorded it, plus the on-chain time and the Bitfinex trade time. History comes from the chain through the public RPC (2 hours, in fixed 4,000-block pieces); a receipt for an older round uses the block explorer's log API, which is limited to about 10 requests per 10 minutes, so it is only a fallback.
- **Call receipt** (opens from Your calls, Live calls and after a call): market, time frame, side, amount, start and end price with Verify, result with reason, amount paid out, fee, time, call and claim transactions.
- **Agent leaderboard** now shows real numbers (win rate and profit over the last hour, last five results, current call) from the agents' own wallets on the chain; "No results yet" otherwise.
