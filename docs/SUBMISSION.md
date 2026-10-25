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
- Live app link (Vercel): _none yet_. Video link: _none yet_.
