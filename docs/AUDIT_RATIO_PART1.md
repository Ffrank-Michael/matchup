# Audit: ratio branch, part 1

Status: COMPLETE (part 1). 11 findings: 0 critical, 1 high (by design), 1 medium, 5 low, 4 info.

Date: 24 Nov 2026. Branch `ratio` at `90807ac` (working tree as checked out). Read only: no code was changed, no
branch switched, nothing committed.

Scope:

- `contracts/RatioGuard.sol` (new on this branch)
- `contracts/GuardedRelayFeed.sol` (unchanged by the ratio work)
- `contracts/PredictionArena.sol` (unchanged by the ratio work)
- their tests under `contracts/test/` (`RatioGuard.t.sol`, `RatioMarket.t.sol` and the existing suites)

How a coin-vs-coin market works: `RatioGuard` divides Chainlink ETH/USD (or SOL/USD) by Chainlink BTC/USD (18 decimals).
A `GuardedRelayFeed` with that guard and a 250 bps band takes the runner's ratio pushes. The arena market `"ETH/BTC 1h"`
uses that relay as `feedA`. UP means the ratio ended higher, i.e. ETH's % move beat BTC's.

Method: line-by-line read of the three contracts and the ratio tests, the full Foundry suite run (361 passed, 0 failed,
Foundry 1.9.0, solc 0.8.28), and proof-of-concept tests (`docs/audit-poc/AuditPoC.t.sol`, see the end of this report). Every
exploit below was run as a passing PoC unless it says otherwise.

Severity scale: Critical (anyone can steal or lock funds), High (funds can be taken under a realistic trust failure),
Medium (wrong results or funds at risk under narrower conditions), Low (limited harm, refunds, dust, DoS),
Info (no direct harm: documentation, hardening, test gaps).

## Summary

| # | Severity | Title |
|---|---|---|
| R-01 | High (by design, acknowledged) | The pusher decides almost every ratio round: 2.5% band against a ~0.2% hourly move |
| R-02 | Medium | The relay owner can hand price control to any address instantly, mid-round |
| R-03 | Low | The pusher can turn any round it would lose into a refund (a free option) |
| R-04 | Low | A Chainlink leg up to 26 hours old still centres the band; RatioGuard has no freshness rule of its own |
| R-05 | Low | A push has no observation time or deadline: a late transaction prices the wrong round |
| R-06 | Low | RatioGuard caches the Chainlink decimals: a decimals change gives a silently wrong ratio |
| R-07 | Low (known, pre-existing) | Loser rounding dust can stay counted as player funds forever; a code comment understates it |
| R-08 | Info | RatioGuard's header is wrong about a market created on the guard by mistake |
| R-09 | Info | RatioGuard's constructor cannot catch swapped or duplicate-but-different-address feeds |
| R-10 | Info | The arena skips the predecessor check for round id 1 in phase 0 |
| R-11 | Info | Test gaps in the ratio tests |

## Fixes on the `audit` branch

Made after this report, without changing `GuardedRelayFeed` or `PredictionArena`:

| # | What changed | Status |
|---|---|---|
| R-04 | `RatioGuard` v2 has an age limit per leg (`numeratorMaxAge`, `denominatorMaxAge`, 1 s to 26 h, `StaleFeed` error). The deploy config sets 25 h for both legs (Chainlink's 24 h heartbeat on Arc plus 1 h). | Partly fixed. The mechanism is there, but with a 24 h heartbeat the limit can only be 1 h tighter than the relay's 26 h; a healthy deviation-based feed that is 24 h old has not moved past its threshold, so a much tighter limit would refuse good feeds. |
| R-06 | `RatioGuard` v2 reads each leg's `decimals()` on every read and reverts `DecimalsChanged` if it differs from deploy time (`FeedUnavailable` if it reverts). | Fixed. |
| R-07 | Not changed in code: the comment is in `PredictionArena.sol`, which is deployed on mainnet with verified source; a comment edit would make the repo differ from the verified source. The correct bound is recorded in R-07 below. | Documented only. |
| R-08 | `RatioGuard` header reworded: no round on such a market can settle UP or DOWN; every round ends as a refund. | Fixed. |
| R-09 | `RatioGuard` v2's constructor takes the expected `description()` of each leg (e.g. `"ETH / USD"`, `"BTC / USD"`) and reverts `WrongFeed` if a feed says something else, and `BadLabels` if the two labels are empty or equal. This refuses swapped feeds, a wrong feed, and two addresses of the same feed. It is checked only at deploy, so a later description change on Chainlink's side cannot break a deployed guard. | Fixed (as far as a contract can: the deployer still supplies the labels, from `ratioGuardArgs` in `scripts/markets.mjs`). |

`version()` of the new guard is 2. The testnet guards deployed on 24 Nov are version 1 and must be redeployed.

## Findings

### R-01. High (by design, acknowledged): the pusher decides almost every ratio round

**Where:** `GuardedRelayFeed.setPrice` (band check, lines 276-287), used with `bandBps = 250` for the ratio relays;
`PredictionArena.settle` takes the first push at or after the lock and the last push at or before the end.

**What:** the relay accepts any ratio within 2.5% of the Chainlink ratio. The repo's own measurement
(`docs/RATIO_MAINNET_CHECKLIST.md`) puts the median 1-hour ETH/BTC move at about 0.2%, so the band is more than 10 times the
typical move. The pusher sees every call before it pushes the start (calls close at the lock, the start is pushed after
it) and can keep pushing until the last second of the round, so it can pick the result of nearly every round. Nothing in
the contracts stops the pusher wallet, or a wallet it colludes with, from playing (`placeCall` has no check against the
pusher; the relay does not know about the arena). This is wider than the USD relays (1.0% BTC, 1.5% ETH and SOL per
`docs/SECURITY_REVIEW.md`) and on a slower-moving quantity, so the ratio markets are the most exposed markets in the system.

**Exploit (PoC `test_F1_pusherPicksOutcome_againstChainlink`, passes):**

1. Alice calls "ETH beats BTC" with 100 USDC; Bob, who works with the pusher, calls "BTC beats ETH" with 100 USDC.
2. After the lock, Chainlink ratio = 0.0300. The pusher pushes the start at 0.03072 (+2.4%): accepted.
3. Chainlink ETH rises 0.2% (ETH really did beat BTC). The pusher pushes the end at 2.4% *below* the new Chainlink ratio: accepted.
4. Anyone settles: `SettledDown`. Bob claims 198 USDC; Alice loses her matched 100 USDC.

A hacked runner key (it lives on a server, `runner/run-mainnet.mjs`) does the same thing against every two-sided ratio round
for as long as the owner has not rotated it. Maximum loss: the matched stake of the losing side of every round in that time,
minus the 2% fee.

**Fix (any one of these, strongest first):**

- Settle ratio markets from data the pusher cannot choose: a signed pull oracle (Chainlink Data Streams or Pyth on Arc) whose
  report is verified on chain with its own publish time, or both Chainlink USD feeds read directly at settle time.
- If a pusher stays: make the band much smaller than the typical round move (for a 1-hour ratio, tens of bps, not 250),
  and accept more refunds when Chainlink lags. A band is only a safety net if it is narrower than what it is protecting.
- Separate duties: a pusher key that cannot be a player (an allow/deny check is not possible in the unchanged arena, so this
  is operational: publish the pusher address, monitor it and its funding sources for calls).
- Keep the trust notice on the call panel (already planned, `RatioNotice`) and keep the ratio markets' minimum and exposure small.

**Status:** acknowledged in `docs/RATIO_MAINNET_CHECKLIST.md` ("the runner can choose the result of almost any round") and
pending an owner decision. Listed here because it is the largest risk in scope.

### R-02. Medium: the relay owner can hand price control to any address instantly, mid-round

**Where:** `GuardedRelayFeed.setPusher` (line 314).

**What:** `setPusher` takes effect in the same transaction, with no delay and no limit on when it may be called. A round's
start and end are whatever the pusher posts while the round runs, so whoever holds the relay owner key effectively holds
R-01's power too: a compromised owner key does not need the runner key. The owner of the two new ratio relays is the same
mainnet owner wallet that owns the arena (checklist, "Relay" row), so one key controls fees, markets, pausing and, through
the pusher, every result. The arena itself is well protected from the owner (it cannot take player funds), but results
are not.

**Exploit (PoC `test_F6_ownerSwapsPusherMidRound`, passes):** after the start push of a round, the owner (or a thief with the
owner key) calls `setPusher(attacker)`; 30 minutes later the attacker pushes an end ratio 2.5% above Chainlink and it is
accepted. Combined with a call placed before the lock, this takes the other side's matched stake, as in R-01.

**Fix:** a timelock on `setPusher` (for example: `proposePusher` then `acceptPusher` after at least two round lengths, with an
event, so the site and watchers see the change coming and players can stop calling); keep the relay owner on a hardware
wallet or multisig separate from the arena owner; monitor `PusherChanged`. Because the relay is meant to stay unchanged,
the cheapest option is operational: a multisig owner and an alert on `PusherChanged`.

### R-03. Low: the pusher can turn any round it would lose into a refund

**Where:** `PredictionArena.settle` refund branches `EndNotAfterStart` (line 1027), `UnchangedPrice` (line 1043) and
`NoUpdate` (line 955); nothing in the relay obliges the pusher to push.

**What:** a round has a result only if the pusher posts a start and a later, different end. By posting only one price, the
same price twice, or nothing, the pusher refunds the round. A pusher that plays (or colludes) therefore holds a free option:
let the round settle when its side is ahead, refund it when it is behind. Players lose no stake, but they lose every win the
pusher chooses to cancel, and the pusher's side never loses.

On a ratio market this is easy to spot: with 18 decimals, two honest pushes are practically never equal (in
`RatioMarket.t.sol` an unchanged ratio needs both coins to move by exactly the same %), so an `UnchangedPrice` or
`EndNotAfterStart` refund on a two-sided ratio round is a strong sign of a missing or repeated push.

**Exploit (PoCs `test_F3_pusherForcesRefund_byWithholdingEnd` and `test_F3_pusherForcesRefund_bySameValue`, both pass):**
the pusher posts the start; ETH rallies (Chainlink +1%), which would make the pusher's DOWN side lose; it posts the start
value again (or nothing). `settle` gives `Refunded` both times.

**Fix:** operational, since the arena is unchanged: alert on every refund of a two-sided round whose reason is
`EndNotAfterStart`, `UnchangedPrice` or `NoUpdate`, and publish the count. In a future arena, let anyone settle from an
independent source when the pusher is silent (for example the Chainlink ratio at the end time), instead of refunding.

### R-04. Low: a Chainlink leg up to 26 hours old still centres the band

**Where:** `RatioGuard.latestRoundData` (returns the older `updatedAt`, line 198) and `GuardedRelayFeed.MAX_GUARD_AGE = 26 hours`
(line 49, applied at line 271).

**What:** `RatioGuard` correctly passes on the older of the two update times, so the relay's staleness rule covers both legs
(tested in `test_relay_refusesWhenOneChainlinkFeedStale`). But that rule is 26 hours, chosen for USD feeds and weekends.
For a 1-hour ratio round, a leg that has not updated for most of a day is not a usable reference: the band is then
centred on an old ratio, which has two effects:

- honest pushes of the live ratio fall outside the band once the market has moved more than 2.5% (or less, if the live
  move and the lag add up), so pushes are refused and rounds refund (availability, no loss);
- a dishonest pusher can post a ratio up to 2.5% away from a day-old value, i.e. further from the real market than the
  band suggests. The outcome is binary, so this adds little to R-01, but it does let a settled price sit far from reality.

The checklist also notes the guard ratio can lag by roughly the two legs' deviation thresholds added up, which eats into
the band from the honest side.

**Exploit (PoC `test_F4_staleGuardStillCentresBand`, passes):** no Chainlink update for 25 hours; pushes at +2.5% and
-2.5% of the 25-hour-old ratio are both accepted.

**Fix:** `RatioGuard` is new and has no owner, so it can carry its own rule without touching the relay: an immutable
`maxAge` per leg (for example the leg's Chainlink heartbeat plus a margin), checked in `_read`, reverting with
`StaleFeed(feed, updatedAt)`. The relay then reports `GuardUnavailable` and the round refunds, which is the intended
safe failure.

### R-05. Low: a push has no observation time or deadline, so a late transaction prices the wrong round

**Where:** `GuardedRelayFeed.setPrice(int256 answer)` (line 232) stamps every push with `block.timestamp`;
`PredictionArena.settle` picks rounds purely by that stamp.

**What:** stamping with the block time is the right choice against a pusher that lies about time, but the contract cannot
tell when a price was *observed*. If the runner reads Bitfinex just before the end of round k and the transaction is
mined just after (congestion, a resend, an RPC retry), that price becomes the **start of round k+1** and is no longer the
end of round k. The same can happen with a start push that lands much later than planned (the start is then the price at
the observation time, not at the push time). Ordering between the pusher's own transactions is safe (one key, nonces), and
replay is not possible, but the time a value belongs to is not checked.

On 1-hour ratio rounds the effect is small, a few seconds of drift, but it is a correctness gap and it gives a dishonest
pusher deniability ("the transaction was just slow").

**Exploit (PoC `test_F5_latePushBecomesNextRoundStart`, passes):** round 1's last push is at end − 30 s; the runner observes a
new price at end − 2 s, the transaction lands at end + 3 s, and `settle(round 2)` uses that value as round 2's start.

**Fix:** in a future relay version, `setPrice(int256 answer, uint256 observedAt)` with
`observedAt <= block.timestamp && block.timestamp - observedAt <= MAX_PUSH_DELAY` (a few seconds), or a `deadline`
parameter that reverts if the push is late. With the unchanged relay: the runner should not send a push it did not
manage to get mined inside its intended window (watch the mined block time, and do not resend an end push after the end).

### R-06. Low: RatioGuard caches the Chainlink decimals at deploy time

**Where:** `RatioGuard` constructor (lines 135-143) stores `numeratorDecimals` / `denominatorDecimals`; `_ratio` (line 233)
uses the cached values for ever.

**What:** a Chainlink proxy answers `decimals()` from its current aggregator. Decimals are not expected to change, but if a
proxy is ever pointed at an aggregator with different decimals, the guard keeps dividing with the old scale and returns a
ratio off by a power of ten **without any error**. The relay's band would then refuse every honest push
(`OutsideBand`) and every ratio round would refund until a new guard, relay and market were deployed (the market's feed
is fixed). No funds are at risk, only availability, and the failure is confusing because the guard itself looks healthy.

**Exploit (PoC `test_R06_decimalsChange_ratioOff_pushesRefused`, passes):** the top feed switches from 8 to 18 decimals
with the same $3,000 price; the guard now answers 3e26 instead of 3e16, and the honest push of 0.03 is refused.

**Fix:** in `_read`, also read `feed.decimals()` and revert with a clear error (`DecimalsChanged(feed, cached, now)`) if it
differs from the cached value. That is one extra cheap call per push and turns a silent scale error into an explicit,
diagnosable refusal.

### R-07. Low (known, pre-existing): loser rounding dust can stay counted as player funds

**Where:** `PredictionArena._claimOne` (line 1324) reverts `NothingToClaim` before `_trackLoserDust` runs; the dust sweep in
`_trackLoserDust` (line 1286) needs every bigger-side loser to have claimed.

**What:** already reported as finding 4 in `docs/SECURITY_REVIEW.md` (at most a few micro-USDC per round, no player shorted).
It applies to ratio markets unchanged. One addition: the comment at line 1123 says the ceil overshoot is "at most 1"; it
is at most (number of bigger-side losers − 1) units, since each loser's ceil can add up to one unit. The maths is still
solvent (the overshoot is taken from losers, never from winners), only the comment is wrong.

**Fix:** as in the earlier review (count a zero-unmatched loser in the tracker without paying, or let anyone trigger the
sweep after the round), and correct the comment.

### R-08. Info: RatioGuard's header is wrong about a market created on the guard by mistake

**Where:** `RatioGuard.sol` lines 15-17: "If it were ever set as a market's feedA by mistake, every settle() would revert".

**What:** not every settle reverts. A one-sided round still refunds as `OneSided`, and `settle(m, k, 0, 0)` succeeds as a
`NoUpdate` refund whenever both Chainlink legs last updated before the lock (`_tryLatest` accepts the guard's answer with
`roundId = 0`). With any real round id the call reverts, so the round can never settle UP or DOWN. The money outcome the
comment promises (always a refund, never a loss) is right; the wording is not.

**Evidence (PoC `test_R08_marketOnGuard_settleZeroRefunds`, passes).**

**Fix:** reword to "every round on such a market ends as a refund (NoUpdate, OneSided or Timeout); none can settle UP or
DOWN".

### R-09. Info: the RatioGuard constructor cannot catch swapped or same-feed-different-address inputs

**Where:** `RatioGuard` constructor, `BadFeeds` check (lines 130-132).

**What:** the check refuses zero addresses and the same address twice. It cannot tell that the two feeds are in the wrong
order (BTC/ETH instead of ETH/BTC: UP would then mean "BTC beats ETH", the opposite of the market name), or that two
different addresses are the same Chainlink feed (a proxy and its aggregator: ratio 1.0 for ever, so the runner's real
ratio is refused and every round refunds). A wrong order is the dangerous one: the runner computes ETH/BTC off chain,
so its pushes would be about 1/0.03 away from the guard and refused (refunds, safe); but if the runner were configured the
same wrong way, the market would settle with UP and DOWN swapped against what the site shows.

**Fix:** keep the deploy-time checks the checklist already asks for (read `description()` of both legs, compare the
guard's answer with the ratio worked out off chain, and check that UP matches the site's label). Optionally, store the
expected leg descriptions and refuse deployment if `numerator_.description()` / `denominator_.description()` do not match.

### R-10. Info: the arena skips the predecessor check for round id 1 in phase 0

**Where:** `PredictionArena.settle`, lines 984-997.

**What:** when `startRoundId & type(uint64).max == 1` and the phase is 0 or 1, the start is accepted without checking that
an earlier update was before the lock. That is correct for phase 1 (the feed's very first update) but phase 0 is not a
real Chainlink phase. With `GuardedRelayFeed` it cannot be abused: the relay only ever writes ids `(1 << 64) | n`, so
`getRoundData(1)` reverts and the start is refused (`InvalidStartRound`). It would only matter for a market on a feed that
uses small plain ids (a raw aggregator, a different mock).

**Fix:** accept the "no predecessor" case only when `startPhase == 1`; revert for phase 0.

### R-11. Info: test gaps in the ratio tests

The existing tests are good on RatioGuard's own maths and refusals (41 tests) and on the happy path of a ratio market (12).
What they do not cover:

- **Pusher discretion.** Every `RatioMarket` round pushes exactly the guard's own ratio (`_runRound` uses `_ratioNow()`),
  so no test shows a push away from Chainlink deciding a result. A test like `test_F1_pusherPicksOutcome_againstChainlink`
  would document R-01 and fail loudly if the band were ever tightened by mistake or on purpose.
- **Withheld and repeated pushes** on a ratio market (R-03): `EndNotAfterStart` and `UnchangedPrice` from one push or two
  equal pushes.
- **SOL/BTC end to end.** Only ETH/BTC runs through the arena; SOL/BTC (ratio ~0.0015, one decimal order smaller) is only
  tested in RatioGuard alone.
- **Mixed-decimals fuzz.** `testFuzz_ratioFormula` fuzzes the prices with both legs at 8 decimals only; the mixed cases are
  two fixed examples. A fuzz over `(a, b, dn, dd)` with the formula `a * 10^(18+dd) / (b * 10^dn)` would pin `_ratio`.
- **Timeout refund on a ratio market** (no settle within the hour) and **`claimMany` across a ratio and a USD market**.
- **Same-second pushes** at the lock and at the end (`test_OK_samesecondPushes_uniqueIds` in the PoC file covers this).
- **Late pushes across the round boundary** (R-05).
- **Decimals change after deploy** (R-06).

The 5 deliberate mutations on RatioGuard mentioned in the checklist are not yet in `ci/mutations.json`, so CI does not
repeat them.

## Checked and found fine

Nobody other than the trusted roles can steal player funds, lock them, or steer a result. Specifically:

**Theft and locked funds (PredictionArena)**

- USDC leaves only through `claim` / `claimMany` (to `msg.sender`, after `claimed = true` and `totalPlayerFunds -= payout`)
  and `withdrawFees` (capped by `feesAccrued`, and also by `balance - totalPlayerFunds`). No sweep, no arbitrary token
  transfer, no `msg.value` or native balance use. The owner cannot reach player money.
- Reentrancy: every state-changing function that moves USDC is `nonReentrant` and writes state first. `markRefunded` makes
  no external call. The feed calls are `view` and so run as `STATICCALL`; a feed cannot re-enter.
- Funds cannot be locked: any unsettled round becomes a full refund one hour after it ends, and `claim` does that by
  itself, so no helper or owner action is needed. Pausing only blocks new calls.
- Payout solvency: winners get at most `M + Dist`, bigger-side losers get `T - Σceil(matched) <= T - M`, the fee is `F`,
  total `<= T + M`. Winner bonuses are floored, so `bonusPaid <= Dist`, and `Dist - bonusPaid` cannot underflow. The
  `uint128(bonus)` cast is safe because `bonus <= Dist <= uint128.max`. The suite's invariant and fuzz tests and the earlier
  brute-force check agree.
- Double claims are blocked by `claimed`; a smaller-side loser and a non-player get `NothingToClaim`; `claimMany` is
  all-or-nothing with one transfer.

**Settlement and the start price (PredictionArena + GuardedRelayFeed)**

- The start (first push at or after the lock) and the end (last push at or before the end) are verified against the
  neighbouring ids, and the relay's ids are contiguous in phase 1, so for any push history there is exactly one accepted
  `(start, end)` pair. Several pushes in the same second are handled: only the first at the lock and the last at the end
  are accepted (PoC `test_OK_samesecondPushes_uniqueIds`).
- `settle` requires `block.timestamp > endTime`, so no push accepted later can be at or before the end; the end is final
  when anyone settles. Calls require `block.timestamp < lockTime` and pushes for the start are at `>= lockTime`, so no call
  can be placed after the start price exists.
- `startRoundId = 0` is accepted only if the feed's latest update is before the lock. A ratio relay with any push reverts
  that path once a push at or after the lock exists.
- **Gas griefing of the try/catch reads cannot force a refund.** A caller who sends just enough gas to make the feed read
  run out of gas (so `_tryLatest` returns "missing") is left with 1/64 of it, far too little for the `SSTORE`s of a refund.
  PoC `test_OK_gasGriefing_cannotForceNoUpdateOrPhaseEdge` tried about 2,550 gas limits from 3,000 to 250,000 for both the
  `NoUpdate` and the `PhaseEdge` path: 860 settles succeeded, all as the correct `SettledUp`; no limit produced a refund.
- `settle` and `markRefunded` cannot both apply at the same moment (`<= deadline` vs `> deadline`), and a round cannot be
  finalised twice (`RoundAlreadySettled`).
- One-sided rounds refund before any price is read, with no fee. Unchanged prices, a non-positive price, an end not after
  the start and a phase edge all refund with no fee.
- `lockTime` / `endTime` use checked maths, so a huge `roundIndex` reverts instead of wrapping.

**GuardedRelayFeed**

- Only the pusher can push; the answer must be positive; the guard read is in try/catch, and a malformed return from the
  guard also reverts the push (no stale or default value is ever stored).
- The band maths cannot overflow (`guard <= uint128.max`, `bandBps <= 1000`); the absolute difference is computed
  without signed overflow; the allowed range rounds down, so it errs on the strict side by at most one unit.
- Future or zero guard times are refused; the 26-hour edge is inclusive and tested.
- `guard`, `bandBps` and `decimals` are immutable; `renounceOwnership` is disabled; ownership moves in two steps.
- The round-id counter cannot reach the phase bits in practice (2^64 pushes).

**RatioGuard**

- Formula: `a * 10^(18+dd) / (b * 10^dn)` is the right ratio for any pair of decimals up to 18, rounded down, and matches
  the runner's `ratio18` for the 8/8 case. Order is exact: the ratio ends higher if and only if
  `ethEnd/ethStart > btcEnd/btcStart`, so UP really means "ETH's % move beat BTC's".
- Overflow: with `a, b <= uint128.max` and decimals `<= 18`, the numerator is below 3.5e74 and the denominator below 3.5e56,
  both under `uint256.max`; the denominator is never 0 because `b > 0` is checked first. `int256(ratio)` is safe because the
  ratio is capped at `uint128.max`.
- Precision at 18 decimals is ample: SOL/BTC ~1.5e15 units, ETH/BTC ~3e16; the round-down error is ~1e-16 relative.
- Every bad input reverts (reverting leg, answer `<= 0`, answer above `uint128.max`, zero or future time, ratio 0 or too
  large), and the relay turns any revert into `GuardUnavailable`: nothing is pushed and the round refunds. A malformed
  return from a Chainlink leg makes the guard's decode revert, which the relay also catches.
- The older of the two update times is passed on, so one stale leg is enough to stop pushes.
- No owner, no setters, no storage except immutables and the description; `getRoundData` always reverts, so the guard
  cannot accidentally become a settlement source.
- No L2 sequencer-uptime check is needed: Arc is not a rollup with a sequencer feed.

**Decimals, rounding, ordering**

- The arena never reads `decimals()`; it only compares two answers from the same feed, so 18-decimal ratios and 8-decimal
  USD prices need no conversion and cannot be mixed up inside the contract.
- The pusher's own transactions are ordered by its nonce and cannot be replayed; `setPrice` takes no timestamp.

## Not covered

The runner, the website and the deployment scripts were read only where needed to judge a finding (whether the runner
clamps to the band: it does not, it skips a price outside the band; whether the mainnet runner wallet places calls: it does
not). Chainlink's feeds on Arc and Arc's USDC token were assumed to behave as documented. No formal verification. The
mainnet deployment of the ratio markets does not exist yet, so on-chain settings were not checked.

## Proof-of-concept tests

`docs/audit-poc/AuditPoC.t.sol` (11 tests, all pass against the code audited here; the existing suite of 361 tests also
passes). The file is kept outside `contracts/test` on purpose, so normal CI and the mutation runs do not pick it up. Run it
from the repo root with:

    FOUNDRY_TEST=docs/audit-poc forge test --match-contract AuditPoC -vv
