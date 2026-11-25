# Audit: ratio branch, part 2 (runner, scripts, site)

Status: COMPLETE. 15 findings: 0 critical, 0 high, 6 medium, 9 low.

Branch `audit`. Read only: no file changed except this report. No key or secret value was printed or copied here.

Scope: the runner (two-coin ratio prices, the start price rule, pushing, settling, retries, alerts including the new
PusherChanged alert, the price log, the mainnet guard that only allows pushes and settles), the deploy scripts and the
mainnet checklist, the Upstash and guide code, and how the website reads and shows ratio markets.

Severity scale (same as part 1): Critical (anyone can steal or lock funds), High (funds can be taken under a realistic
failure), Medium (wrong results, a leak, or money at risk under narrower conditions), Low (limited harm, refunds, noise),
Info (no direct harm).

## Summary

| # | Severity | Title |
|---|---|---|
| P2-01 | Medium | One Bitfinex trade, at a moment anyone can predict, sets each start and end price |
| P2-02 | Medium | An end price sent just before the end can land after it: the round refunds and the next round starts from a price seen before its lock |
| P2-03 | Medium | The server setup copies the whole PC `.env`, owner key included, and relies on one manual `sed` to remove it |
| P2-04 | Medium | The site says the end price is the price "when the round ends"; it is the last trade about 60 seconds before |
| P2-05 | Medium | While a round runs, the site shows its own Bitfinex start price, not the one the runner put on chain |
| P2-15 | Medium | One failed RPC read leaves a gap in the runner's remembered price history that is never filled: decided rounds can time out as refunds |
| P2-06 | Low | The pusher alert goes quiet when the chain cannot be read, and does not watch ownership changes |
| P2-07 | Low | The mainnet checklist has no step for the owner key or for the alerts |
| P2-08 | Low | Mainnet guide calls are scored from the testnet price log, or with a different end rule than the chain |
| P2-09 | Low | After one real move of more than 20%, the runner refuses that coin's prices until it is restarted |
| P2-10 | Low | Ratios are shown with 5 significant digits: a decided round can show the same start and end |
| P2-11 | Low | The site's public start-price route makes a Bitfinex request for any lock time a visitor sends |
| P2-12 | Low | Anyone can make the runner pay a settle for every one-sided round they create |
| P2-13 | Low | "Every push is public and can be checked against Bitfinex": the two trades behind a ratio are not published |
| P2-14 | Low | The start rule uses the chain's clock for the lock and Bitfinex's clock for the trade, and never compares them |

## Findings

### P2-01. Medium: one Bitfinex trade, at a moment anyone can predict, sets each start and end price

**Where:** `runner/exchangePrices.mjs` (`ask`, `usdQuote`, `ratioQuote`), `runner/config.mjs` (`startAfter: 2`, `endMargin: 60`),
`runner/plan.mjs` (`priceDue`).

**What happens:** the start price of each coin is the **first single trade** on Bitfinex at least 2 seconds after the lock,
and the end price is the **last single trade** when the runner asks, about 60 seconds before the end (the runner looks every
3 seconds in that window). For a coin-vs-coin market both coins are read this way and divided. Anyone who has read the
code knows these moments to within a few seconds. A player can therefore:

- at lock + 2 s, place one small trade on Bitfinex (at the bid or the ask) so that **their** trade is the first one and
  sets the start price; or
- about 60 s before the end, place one larger market order on the thinner leg (SOL/USD on Bitfinex) so that the last
  trade prints a little away from the real price, then trade back.

A typical 1-hour ratio move is about 0.2% (`docs/RATIO_MAINNET_CHECKLIST.md`), so a nudge of a few hundredths of a
percent can decide close rounds. The relay's 2.5% band and the 20% jump check do not notice a move this small.

**Exploit sketch:** a player calls "SOL wins" with a large stake. At end − 60 s they buy SOL/USD on Bitfinex with a market
order big enough to print a trade 0.1% above the book, the runner reads that trade as SOL's end price, and they sell back
a few seconds later. Their cost is the spread and slippage on Bitfinex; their gain is the other side's matched stake.

**Fix:**
1. Do not use a single trade. Use the volume-weighted average (or the median) of all Bitfinex trades in a short window,
   for example lock + 2 s to lock + 32 s for the start and end − 90 s to end − 60 s for the end. In
   `exchangePrices.mjs`, ask `trades/<symbol>/hist?start=<ms>&end=<ms>&limit=1000&sort=1` and average the prices weighted by
   `abs(amount)`; refuse (push nothing) if fewer than, say, 3 trades are in the window.
2. Better still, also take the same window from a second exchange and push only when the two agree within a small tolerance.
3. Write the window and the trade count into the price log so anyone can re-check the number.
4. Say on How it works that the price is an average over a window, not one trade.

### P2-02. Medium: an end price sent just before the end can land after it

**Where:** `runner/plan.mjs` `priceDue` (an end push is due while `now < endR`), `runner/mainnet.mjs` `execute` (the quote, then
`send`, with no time check in between), `runner/run-mainnet.mjs` (a failed push is tried again after 5 seconds).

**What happens:** the planner decides "end price due" from the last block time it read. The executor then asks Bitfinex
(for a ratio: two requests one after the other, each allowed 8 seconds), and only then sends the transaction. If the first
try fails (Bitfinex slow, a rate limit, the RPC slow), the retry 5 seconds later is still allowed as long as the snapshot
time is before the end. Nothing re-checks the clock right before sending, so a push decided at end − 3 s can be mined after
the end. Then:

- that round has no end price inside it, so it refunds (`EndNotAfterStart`), with no fee and no winner;
- the late push becomes the **start price of the next round** (the contract takes the first update at or after the lock),
  although it is a trade from **before** that round locked, when calls were still open. The runner sees "start already
  there" and does not push a proper one. This breaks the rule in `docs/RULES.md` H5 that the start must be a trade after
  calling closes.

The executor already prints `LESS THAN 30 s: too close` after landing, but by then it is too late.

**Fix:**
1. In `makeMainnetExecutor` (and the testnet executor in `runner/wallets.mjs`), just before `send(...)` for an end price,
   re-check the time: `if (a.endsAt && nowSec() > a.endsAt - 20) throw new Error('too close to the end: end price not sent')`.
   Use the latest block time if the PC clock can drift.
2. In `priceDue`, stop offering the end push 20 s before the end: `now < endR - 20` instead of `now < endR`.
3. For the start: also refuse a start push whose trade is from before `lockR + startAfter` (already the case), and in
   `priceDue` treat an update that landed in the first seconds after the lock but carries a price observed before it as
   "no proper start". The simplest safe form is (1) and (2): a late end push then never happens.
4. The price log also files such a push as the `end` of round k (`makePriceLogEntry` uses `action.round`) although the chain
   uses it as the start of round k+1. After (1) and (2) this cannot happen; until then, log `landedAfterEnd: true` when
   the block time is past `a.endsAt`.

### P2-03. Medium: the server setup copies the whole PC `.env`, owner key included

**Where:** `docs/MAINNET_AGENTS.md` steps 6 and 7, `deploy/setup-runner.sh` step 6.

**What happens:** step 6 copies the PC's whole `.env` to the server with `scp`. Your PC `.env` holds the names
`MAINNET_DEPLOYER_PRIVATE_KEY` (the mainnet **owner** key, which can hand price control to anyone, part 1 R-02),
`DEPLOYER_PRIVATE_KEY` (the testnet owner), `MAINNET_RUNNER_PRIVATE_KEY`, `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`,
`GEMINI_API_KEY`, `UPSTASH_REDIS_REST_TOKEN` and `NTFY_TOPIC`. Only step 7's `sed` line takes the owner key out again,
and only if it is typed and matches. Problems:

- if step 7 is skipped, or run on a later re-copy of `.env` (for example after "Change a setting" or a server rebuild),
  the owner key stays on an internet-facing machine for good;
- `sed -i` removes the line from the file but not from the disk blocks, editor backups, or any copy made before it ran;
- for a moment after `scp` the file has the default permissions until `chmod 600` runs;
- `deploy/setup-runner.sh` checks that names are **present**, but never checks that the owner key is **absent**, so it
  prints `READY` with the owner key still in the file;
- the server only needs the runner's own names (`RUNNER_ENV_NAMES` in `runner/mainnet.mjs`, plus the testnet runner's),
  so every other secret on it is extra exposure with no use.

**Fix:**
1. Replace step 6 with a small script on the PC, for example `scripts/make-server-env.mjs`, that writes a new file
   (`.env.server`) with **only** the names the server needs and refuses to write `MAINNET_DEPLOYER_PRIVATE_KEY` at all.
   Copy that file: `scp -i <KEY> .env.server ubuntu@<SERVER_IP>:/home/ubuntu/arc-arena/.env`. (`.env.server` is already
   ignored by git through the `.env.*` rule in `.gitignore`.) Delete it from the PC after the copy.
2. Before copying, create the target with safe permissions:
   `ssh ... "umask 077 && touch /home/ubuntu/arc-arena/.env"`.
3. In `deploy/setup-runner.sh`, fail (not warn) when `MAINNET_DEPLOYER_PRIVATE_KEY` is present:
   `if has MAINNET_DEPLOYER_PRIVATE_KEY; then warn "the mainnet owner key must not be on the server"; env_ok=0; fi`.
4. In `runner/run-mainnet.mjs`, at start, stop if the raw `.env` contains the name `MAINNET_DEPLOYER_PRIVATE_KEY`
   (check the name only, never read the value).
5. If the owner key ever was on the server: treat it as exposed and move ownership to a new wallet (`docs/RUNBOOK.md`,
   section 1). You can check without showing the value: `grep -c MAINNET_DEPLOYER_PRIVATE_KEY /home/ubuntu/arc-arena/.env`
   must print `0`.

### P2-04. Medium: the site says the end price is the price "when the round ends"

**Where:** `web/app/how-it-works/page.tsx` ("When the round ends, the price at that moment is the end price." and, for
coin vs coin, "the end ratio uses each coin's last trade before the end"), the live "winning" display
(`web/lib/winning.ts` through `price-chart.tsx`), `runner/config.mjs` `endMargin: 60`.

**What happens:** the runner pushes the end price when it first looks inside the last 60 seconds, so the end price is the
last trade **about 60 seconds before the end** (anywhere from 60 s to a few seconds before, depending on timing). Nothing
in the last minute counts. The site keeps showing the live price and who is "winning" until the very end, so in the last
minute a player can watch their side "win" on screen and then lose, or the other way round. On 5-minute markets that is a
fifth of the round; on the 1-hour ratio markets it is the last minute. This is the rule that decides the money, and the
page states a different one.

**Fix:**
1. Say what really happens, on How it works and next to the countdown: "The end price is the last trade about one
   minute before the round ends. The last minute does not count."
2. On the chart, once the end price is on chain (the relay has an update after `end − 60`), freeze the "winning" display
   on that price and label it "End price is in".
3. Or change the runner instead, so the text becomes true: push the end price as close to the end as is safe (see
   P2-02 for the cut-off) and keep `endMargin` small (for example 20 s), and say "the last trade about 20 seconds before
   the end".

### P2-05. Medium: while a round runs, the site shows its own Bitfinex start price, not the chain's

**Where:** `web/lib/use-start-price.ts`, `web/app/api/start-price/route.ts`, `web/components/kairo/kairo-home.tsx` (comment:
"The contract records a round's start price when it settles it; while the round runs the site finds the same trade the
runner uses").

**What happens:** the start price that decides the round is the first relay update at or after the lock, and it is on
chain seconds after the lock. The site does not read it. Until the round is settled, it asks Bitfinex itself for "the
same trade the runner uses" and draws that as the start line and uses it for "winning". The two can differ:

- the runner (or a hacked runner, part 1 R-01) pushed a different number inside the 2.5% band;
- the start on chain is a late end price from the round before (P2-02);
- the runner's start trade was not the site's (different rounding, a retry, a trade at exactly lock + 2 s).

In every case the site shows a start and a "winning" side the contract will not use, and it hides a wrong push until the
round is settled, exactly when a player would most want to see it. For the ratio markets, whose whole trust model is "every
push is public and can be checked", this is the check that matters.

**Fix:**
1. Read the start from the chain: the relay's first update with `updatedAt >= lock`. Today the site reads only the arena
   (`web/onchain/*`), never the relay feed, so this is a new read: `latestRoundData()` on the market's `feed` (already in
   `deployment.generated.json`), then `getRoundData(id - 1)` back to the lock, the same rule as `runner/settleIds.mjs`.
   Show that as the start price as soon as it exists.
2. Keep the Bitfinex lookup only as a cross-check, and when the two differ by more than a rounding unit, show both with a
   plain warning: "The runner's start price differs from Bitfinex's first trade after the lock."
3. Until a start is on chain, show "Start price not on chain yet" instead of a "winning" side.

### P2-15. Medium: one failed RPC read leaves a gap in the remembered price history that is never filled

(Numbered after P2-14 because it was found last; listed with the Medium findings.)

**Where:** `runner/chain.mjs` `feedUpdates` (the walk back with `getRoundData(id - 1)` and `catch { break; }`), then
`runner/settleIds.mjs` `findSettleIds` and `runner/plan.mjs` step 1.

**What happens:** each pass walks a relay's updates backwards from the newest until it reaches the ones it already
remembers. If one `getRoundData` read fails half-way (a timeout or a rate limit on the public RPC, which the code itself
says happens), the walk stops, and the **partial** list is saved as the remembered history. On the next pass the walk
stops as soon as it reaches the newest remembered update, so the missing older updates are **never read again** while the
runner runs.

If the missing part holds a round's start price, `findSettleIds` picks the first update it knows after the lock (for
example the end price) as the start. The contract checks the update before it, finds it is also after the lock, and
refuses (`InvalidStartRound`). The runner retries the same wrong ids with growing waits for the whole hour, and the round
ends as a **Timeout refund** although it had a valid start and end and a winner. No gas is lost (viem's estimate fails
first), but the winners lose their win. One short RPC error at the wrong moment is enough.

**Fix:**
1. In `feedUpdates`, when a `getRoundData` read fails before the walk has joined the remembered list or reached
   `oldestNeeded`, do not save anything: `throw` (the whole pass is retried a few seconds later), or keep the old cache
   unchanged and return it plus a flag `incomplete: true`.
2. Do not plan settles for a market whose feed history is marked incomplete.
3. When a settle fails with `InvalidStartRound` or `InvalidEndRound`, clear that feed's cache (`delete feedCache[feed]`) so the
   next pass reads its history again from scratch.
4. Add a test in `runner/runner.test.mjs` with a fake `getRoundData` that fails once in the middle of a walk.

### P2-06. Low: the pusher alert goes quiet when the chain cannot be read, and does not watch ownership

**Where:** `runner/pusherWatch.mjs` (added on this branch), `runner/run-mainnet.mjs`.

**What happens:**
- When `getLogs` fails (the RPC is down, or it refuses a 2,000-block range), the watch writes one log line a minute and
  **sends no alert**. If the RPC always refuses the range, the watch is stuck on the same block for ever and nobody is
  told; the `pusher()` check still runs, so a pusher that is changed and changed back between two checks would be missed.
- It watches `PusherChanged` only. Someone with the owner key can also start moving ownership of the arena or a relay
  (`OwnershipTransferStarted`, then `OwnershipTransferred`), pause markets, or create a market with a feed of their own.
  None of these alert. A transfer of a relay's ownership is the step that comes right before a pusher change that cannot be
  undone.
- After a pusher change, a restart of the runner stops at its start-up check ("the runner is not the pusher"), so the
  supervisor goes into a crash loop and its alert says only "stopped (exit 1)"; the reason is only in the journal.
- `seen` is kept in memory, so every restart within the 2,000-block look-back alerts the same event again (noise, not harm).

**Fix:**
1. Alert (once, then once an hour) when `getLogs` has failed for more than 5 minutes: "pusher watch cannot read the chain".
   On a range error, halve `MAX_LOG_RANGE` and try again instead of repeating the same request.
2. Watch `OwnershipTransferStarted` and `OwnershipTransferred` on the arena and every relay, and `MarketCreated` and
   `MarketPausedChanged` on the arena, with the same alert path.
3. When the start-up check fails because a relay's pusher is not the runner, send the alert from `run-mainnet.mjs` before
   exiting (the alert function is already there), so the phone says why.
4. Keep the last alerted block in a small file under `data/` so restarts do not repeat old alerts.

### P2-07. Low: the mainnet checklist has no step for the owner key or for the alerts

**Where:** `docs/RATIO_MAINNET_CHECKLIST.md`.

**What happens:** the checklist covers contracts, prices and the first rounds, but it never asks to (a) move the owner of
the arena and the relays to a hardware wallet or offline key (`docs/RUNBOOK.md`, section 1), (b) check that the owner key
is not on the server (P2-03), or (c) check that `NTFY_TOPIC` is set on the server and that an alert really arrives. Each of
these is what limits the damage of part 1's R-01 and R-02, and none of them blocks going live today.

**Fix:** add three boxes under "Before": "Owner of the arena and every relay is a hardware wallet (`owner()` checked on each)";
"`grep -c MAINNET_DEPLOYER_PRIVATE_KEY /home/ubuntu/arc-arena/.env` prints 0 on the server"; "A test ntfy message reaches the
phone (`node -e` call to `notify` from `runner/supervise.mjs`), and the runner log does not show `WARNING: no NTFY_TOPIC`".

### P2-08. Low: mainnet guide calls are scored from the testnet price log, or with a different end rule

**Where:** `runner/guide.mjs` (`createGuide`, default `chainPriceLog = () => readPriceLog()`; `priceAt`), `runner/run-mainnet.mjs`
(creates the guide without passing `chainPriceLog`), `runner/priceLog.mjs` (`PRICE_LOG_FILE` is `data/price-log.jsonl`, the
**testnet** log; the mainnet executor writes `data/price-log-mainnet.jsonl`).

**What happens:** the guide scores each round from "the runner's price log" when it can, but on mainnet it reads the
testnet log. On the server, where the testnet runner writes that file, testnet and mainnet use the same market ids,
lengths and offsets, so mainnet rounds are scored with testnet pushes (the same Bitfinex rule, so usually, not always, the
same numbers). Where the log has no entry, the guide asks Bitfinex for the **last trade at or before the end**, while the
chain's end price is the last trade about 60 s before the end (P2-04). So the site can show an agent's guide call as "won"
on a round whose real result, on the same page, went the other way. No money moves on guide calls, but the agents' win
rates shown to players are built from these scores.

**Fix:** in `run-mainnet.mjs` pass `chainPriceLog: () => readPriceLog(MAINNET_PRICE_LOG_FILE)` to `createGuide`. Better: score
from the chain itself (the arena's `RoundSettled` event or the relay's start and end updates) when the round had pushes, and
in `priceAt` for `kind === 'end'` use the same moment as the runner (`end - endMargin`) when there were none.

### P2-09. Low: after one real move of more than 20%, the runner refuses that coin until restarted

**Where:** `runner/exchangePrices.mjs` `jumpCheck`.

**What happens:** a price that moved more than 20% from the last one handed out is refused, and the refused price does not
replace the remembered one. If the market really moved that far (SOL has done this in a day), every later quote is
compared with the old price and refused too, so that coin's markets **and** the coin-vs-coin market that uses it get no
prices and refund, until someone restarts the runner. The log says "not trusting it" every few seconds; no alert is sent.
The same check runs on the ratio itself, so a big move of one leg blocks the ratio as well.

**Fix:** keep the check, but compare with a recent reference instead of the last price handed out: for example accept a
new price when it is within 20% of Chainlink's latest answer (the runner already reads it in `checkedQuote` on mainnet), or
when three quotes in a row a minute apart agree with each other. Send an ntfy alert the first time a price is refused.

### P2-10. Low: ratios are shown with 5 significant digits

**Where:** `web/lib/ratio.ts` `formatRatio` (`toPrecision(5)`), used by `formatPrice` in the round card, round history and
live calls.

**What happens:** ETH/BTC near 0.0339 is shown as `0.033925`, so any two ratios that differ by less than about 0.0015% look the
same. With 18 decimals on chain, a round whose ratio moved only that much still has a winner. The round history then reads
"0.033925 → 0.033925, ETH wins", which looks like a mistake, or like a refund that did not happen.

**Fix:** in `formatRatio`, when showing a start and an end together, add digits until they differ (up to 10 significant
digits), or always show 7 significant digits for a ratio. Add the move in percent next to it ("+0.0012%") so the result
is visible at a glance.

### P2-11. Low: the public start-price route asks Bitfinex for any lock time a visitor sends

**Where:** `web/app/api/start-price/route.ts`.

**What happens:** the route accepts any whole-number `lock` in the last 6 hours, and answers only from a cache of found
trades. Each new lock value costs one Bitfinex request (two for a coin-vs-coin pair), and "nothing found yet" is not
cached. Bitfinex allows 10 to 90 such requests a minute per IP and then blocks the IP for 60 s. A visitor (or a script)
sending many lock values gets the site's server blocked, and then the start line and "winning" display stop working for
everyone. The runner uses its own IP, so pushes are not affected.

**Fix:** accept `lock` only if it is a real lock time of a market of that coin (`(lock - offset) % roundLength === 0` for
one of its markets in `deployment.generated.json`) and one of the last two rounds; cache "not found yet" answers for 3 s;
and return `429` when the route itself has asked Bitfinex more than, say, 20 times in the last minute.

### P2-12. Low: anyone can make the runner pay a settle for every one-sided round

**Where:** `runner/plan.mjs` step 1 with `cfg.matchedOnly` (a one-sided round with real money is settled right after it ends).

**What happens:** a call of the minimum stake (0.50 USDC, which comes back) on a round nobody else plays makes the runner
send one settle (about 136k gas). Doing it on every market every round costs the caller a call and a claim each time, about
what it costs the runner, so it is a slow, even trade, not a theft. But the runner holds only a few USDC; once it is below
0.10 USDC it stops, and from then on **every** round refunds until someone tops it up.

**Fix:** a one-sided round does not need a settle at all (after the 1-hour window `claim` refunds it by itself), so settle
one-sided rounds early only when their real money is above a threshold (for example 5 USDC), and otherwise leave them to the
timeout refund. Also alert (ntfy) when the runner's balance falls below a warning level (for example 1 USDC), not only when it
stops at 0.10.

### P2-13. Low: "every push is public and can be checked against Bitfinex"

**Where:** `RatioNotice` in `web/components/kairo/your-call.tsx`; `web/components/kairo/price-proof.tsx` ("the runner's price log
has both").

**What happens:** the chain holds only the ratio. Which ETH trade and which BTC trade it came from is only in the runner's
price log, which stays on the server (`data/price-log-mainnet.jsonl`) and is not published anywhere the site or a player can
read. So a player cannot really check a ratio push against Bitfinex; they can only check that some pair of trades could
give that number.

**Fix:** publish the mainnet price log (for example write each entry to the same Upstash store the guide uses, and show the
two legs, their trade times and Bitfinex trade ids in the round card). Until then, say "can be checked by the runner's
operator", or drop the sentence.

### P2-14. Low: the start rule compares the chain's clock with Bitfinex's clock without checking them

**Where:** `runner/plan.mjs` (`firstTradeAfter: lockTime + startAfter`, lock in chain time), `runner/exchangePrices.mjs` (trade
time in Bitfinex time; only the PC clock is compared with Bitfinex, `maxClockSkewSec = 120`).

**What happens:** calls close when the **block time** reaches the lock. The start price is the first Bitfinex trade at least
2 s after the lock in **Bitfinex time**. If the chain's block time runs more than 2 s behind real time, calls are still open
in real time when the start trade happens, so a fast player could see the start trade and then call. The 2 s margin is the
only protection, and nothing checks that the two clocks agree to within it. The PC clock check (120 s) is far too loose to
cover it.

**Fix:** in the executor, before a start push, compare the latest block time with Bitfinex's `Date` header; refuse to push
(and alert) when they differ by more than 1 s, or set `firstTradeAfter = lock + startAfter + max(0, realTime - blockTime)`.


## Checked and found fine

**The mainnet transaction guard**
- `makeMainnetExecutor` accepts only `pushPrice` and `settle` and throws on anything else; with `runnerOnly` the planner makes
  no calls, approvals or claims. The runner wallet cannot move USDC except as gas.
- Without `--i-understand-this-spends-real-usdc` the wallet client is never created, so a dry run cannot send. The testnet
  flag `--live` is refused.
- Before the first pass it checks the chain id (5042), that the arena has code, that the runner is not the arena owner,
  and that it is the pusher of every relay; any problem stops it.
- It reads only the names in `RUNNER_ENV_NAMES` from `.env`, so it never holds the owner key (tested).
- A live runner stops below 0.10 USDC, and the supervisor alerts.
- A transaction that would revert is not sent: viem estimates gas first, so failed settles and pushes cost nothing.

**Prices**
- Bitfinex answers are checked: HTTP errors, error arrays, empty lists, non-numbers, a trade more than 15 minutes old, and
  a PC clock more than 2 minutes off all make the runner push **nothing**. No price is ever made up; the round refunds.
- The start uses each coin's first trade at or after lock + 2 s, and a trade from before that is refused. The runner keeps
  trying for the first quarter of the round (15 minutes on 1-hour rounds), then gives up and the round refunds. (Fixed after this audit: on BTC and ETH 5m rounds the window closes too close to, or after, that quarter, so the runner now asks until 30 s after the window can be read; `docs/RULES.md` H6.)
- The ratio is the same integer maths in the runner (`ratio18`), the contract (`RatioGuard._ratio`) and the site (`ratioOf`):
  both prices as 8-decimal integers, 18 decimals, rounded down.
- On mainnet every price is compared off chain with the relay's own rule (band and guard age) before it is sent; with
  RatioGuard v2 a stale or changed Chainlink leg makes the guard read fail, and then nothing is sent.
- The rate limit of 5 s per Bitfinex market is kept, also after failures, so the runner does not get its IP blocked.

**Settling and retries**
- `findSettleIds` uses the contract's own rules (first update at or after the lock, last at or before the end); one-sided
  rounds are settled with ids 0 (no price needed). P2-15 is the one case where its input can be wrong.
- Settles are retried after 15 s, doubling to at most 4 minutes, only inside the 1-hour window; pushes after 5 s.
- Push and settle actions run first in each pass, before anything else.

**Secrets**
- No key or token is printed by the runner, the deploy scripts or the wallet script: they print addresses only. The
  Gemini key goes in a request header, not the URL; the Upstash token is replaced by `***` in error lines; ntfy messages
  carry only addresses, block numbers and transaction hashes.
- `scripts/create-mainnet-wallets.mjs` refuses to run if `.env` is not ignored by git, never overwrites a key, and its
  temporary file is covered by `.env.*` in `.gitignore`.
- No `.env` or key file is tracked or has ever been committed (checked in all branches' history).
- The price log and the guide files contain prices, times and transaction hashes only.

**Alerts**
- The supervisor's `notify` never throws and times out after 8 s, so a broken alert cannot stop the runner; a crash loop
  waits 5 minutes between tries and says so.
- The pusher watch reads logs in bounded chunks, never skips a chunk that failed, alerts each event once per run, and also
  compares `pusher()` with the runner (P2-06 lists what it does not cover).

**Scripts and checklist**
- `scripts/deploy-ratio.mjs` refuses mainnet, is a dry run unless `--send`, checks the owner and the market count before each
  step, and its verify now checks the RatioGuard v2 age limits and code.
- The checklist keeps mainnet behind an owner decision on the trust model and a separate, not-yet-written mainnet script.

**Site**
- Ratio prices are read with 18 decimals everywhere they come from the chain (`chainPrice`, `feedDecimals`, the start price
  in `kairo-home.tsx`).
- The guide-calls route sends only checked fields, trims text to 200 characters, strips control characters, and caches
  answers for 20 s, so visitors cannot run up Upstash use.
- The ratio notice states the trust model plainly (2.5% band, typical hour far smaller, trust in the runner).

## Not covered

The server itself (I cannot see it: what its `.env` holds now, its firewall, its systemd file), the Vercel project
settings, the Google sign-in and Circle wallet code, and the agents' decision rules. No code was run against mainnet.
