# Audit: ratio branch, part 3 (RatioGuard version 2 and the mainnet deploy script), second reviewer

Status: COMPLETE. 12 findings: 0 critical, 0 high, 0 medium, 2 low, 10 info.

- No finding lets anyone take money.
- No finding makes the guard return a wrong ratio, or makes `settle` fail.
- The two low findings are in the mainnet deploy script, not in the contract.
- RatioGuard v2 does not need to change before mainnet.

Date: 27 Nov 2026. Branch `audit` at `01d266a`. Read only: no code or config was changed. This report is the only file
written in the repo.

**About this file.** An earlier draft of this report from a previous session was here, not committed. Its copy is kept
outside the repo, in the session scratchpad, as `AUDIT_RATIO_PART3.previous.md`. This version was written from scratch by a
second reviewer. Each finding in the old draft was checked again. Those that held up are kept below and marked "(confirmed
from the earlier draft)". Five findings are new: F-3, F-4, F-9 and parts of F-2 and F-12.

## Scope

- `contracts/RatioGuard.sol` (version 2, last changed in `1c5a0e4`)
- `contracts/test/RatioGuard.t.sol`, `RatioMarket.t.sol`, `RatioSolBtc.t.sol`, `RatioTrust.t.sol`
- `scripts/deploy-ratio-mainnet.mjs`, plus the parts of `scripts/markets.mjs`, `scripts/compile.mjs`, `scripts/lib.mjs`
  and `scripts/deploy-ratio-mainnet.test.mjs` that it uses
- `GuardedRelayFeed.sol` and `PredictionArena.sol`, only where they read the guard or the relay, or where the script calls
  them (`createMarket`, `markets`)
- Compared with `docs/AUDIT_RATIO_PART1.md` (R-04, R-06, R-09)

## Method

- Read every line of the contract, the four test files and the deploy script.
- `forge test --match-path "contracts/test/Ratio*"`: **82 passed, 0 failed**.
- `node --test scripts/deploy-ratio-mainnet.test.mjs`: **16 passed, 0 failed**.
- `ci/mutations.json`: the 18 RatioGuard mutations `G01` to `G18` are there.
- **Read-only checks on Arc mainnet** (public RPC `rpc.mainnet.arc.io`, block 33,346,491; nothing signed or sent; `.env`
  not read). The scripts are in the session scratchpad, not in the repo.
  - Chainlink ETH/USD `0x50FC…D364`: `"ETH / USD"`, 8 decimals, `version` 6, phase 1, last update 737 s old.
  - Chainlink BTC/USD `0xa109…03De`: `"BTC / USD"`, 8 decimals, `version` 6, phase 1, last update 166 s old.
  - The live ETH and BTC USD relays (`0xdbb8…56c0`, `0x15db…ab60`) have exactly these two proxies as `guard()`. Both
    relays have the pusher `0x1410…EA3F`, the same as `deployments/arc-mainnet.json`.
  - **Simulated deploy.** The RatioGuard constructor was run with `eth_call` and the exact arguments the script builds
    (`ratioGuardArgs('ethbtc', …, 'mainnet')` = `90000, 90000, "ETH / USD", "BTC / USD", …`). It **succeeds**.
  - **Simulated answer.** `latestRoundData()` was run on the resulting code through a state override. It answered
    `28102851625097314`. Chainlink ETH × 10^18 / Chainlink BTC worked out off chain is exactly the same.
  - **Swapped order.** The same constructor with BTC on top **reverts**.
  - The secondary proxies (`0x2c7D…3F60`, `0x7777…6aE3`) and the raw aggregators behind the proxies (`0xDBD4…4eC7`,
    `0x733F…4362`) also say `"ETH / USD"` / `"BTC / USD"`, with 8 decimals and the same answer. This matters for F-2.
  - Gas price: 25 gwei.

Severity scale (the same as part 1):

- **Critical:** anyone can steal or lock funds.
- **High:** funds can be taken under a realistic trust failure.
- **Medium:** wrong results, or funds at risk under narrower conditions.
- **Low:** limited harm (refunds, dust, denial of service), or a deploy mistake that can only be undone by pausing.
- **Info:** no direct harm (hardening, documentation, test gaps).

## Summary

| # | Severity | Where | Title |
|---|---|---|---|
| F-1 | Low | deploy script | A guard or relay taken from the deployment file on a re-run is not checked before the market is created (confirmed from the earlier draft) |
| F-2 | Low | deploy script | The Chainlink addresses come from `scripts/markets.mjs` alone. The label check cannot tell the main proxy from a secondary proxy or a raw aggregator (confirmed and extended) |
| F-3 | Info | deploy script | `getAddress(x.toLowerCase())` throws away the checksum that would catch a mistyped Chainlink address (new) |
| F-4 | Info | deploy script | The dry run hides a RatioGuard constructor revert: a failed gas estimate silently becomes a size guess (new) |
| F-5 | Info | deploy script | `verify()` does not check the guard's stored leg decimals (confirmed) |
| F-6 | Info | deploy script | A pending ownership handover on the arena is only a warning (confirmed) |
| F-7 | Info | deploy script | No gas price ceiling on the real run (confirmed) |
| F-8 | Info | deploy script | A crash between "transaction mined" and "saved to the file" needs a manual repair (confirmed) |
| F-9 | Info | deploy script | The script compiles and deploys whatever is in the working tree; nothing ties it to a reviewed commit (new) |
| F-10 | Info | RatioGuard | A leg that returns malformed data reverts with a decode error, not `FeedUnavailable` (confirmed) |
| F-11 | Info | RatioGuard | R-04 is fixed as far as code can fix it; what is left needs monitoring (confirmed) |
| F-12 | Info | tests | The send path and `verify()` of the script have no test; the integration tests' labels prove nothing; there is no fork test (extended) |

## The three part 1 fixes, checked

### R-04: an age limit for each leg. Correct; it cannot refuse a healthy feed.

`_read` (lines 271-298) checks `updatedAt == 0 || updatedAt > block.timestamp` first, then
`block.timestamp - updatedAt > maxAge`.

- **No underflow.** The future check runs first, so the subtraction can never underflow.
- **Boundary.** Exactly `maxAge` old is accepted; one second more is refused. This is the same rule as the relay. It is
  pinned by `test_feedExactlyMaxAgeOld_accepted_oneSecondMore_refused`, and mutations `G05` and `G06` are caught.
- **The right limit for each leg.** `numeratorMaxAge` goes with the numerator, `denominatorMaxAge` with the denominator
  (line 252-253). It is pinned by `test_eachFeedHasItsOwnAgeLimit` (different limits for the two legs) and mutation `G07`.
- **The relay's rule still applies.** The older of the two update times is passed on to the relay (`G02`).
- **The constructor** refuses 0 and anything above 26 h (`MAX_FEED_AGE`, equal to the relay's `MAX_GUARD_AGE`). Both are
  tested, the numerator by mutation `G12`.
- **The deploy value.** The script passes 90,000 s (25 h) for both legs, checked in the simulated constructor call.
  `docs/SUBMISSION.md` records a 24 h heartbeat for both feeds, and a longest measured BTC gap of 24 h. So a healthy feed is
  at most about 24 h old, and 25 h leaves an hour of margin.

A healthy feed is refused only if Chainlink misses its own heartbeat by more than an hour. The push then fails and the round
refunds. That is the intended safe failure. What is left over is F-11.

### R-06: decimals checked on every read. Correct; it cannot produce a wrong ratio.

- `try feed.decimals() returns (uint8 d)`. If `d` differs from the value stored at deploy, it reverts `DecimalsChanged`.
  That revert is in the success block of the `try`, so the `catch` does not swallow it. If `decimals()` itself reverts, it
  reverts `FeedUnavailable`.
- The check runs before the answer is read, so `_ratio` only ever sees answers in the scale its stored decimals describe.
  A changed scale can never reach the maths (`G08`, `test_decimalsChangedAfterDeploy_refused`,
  `test_relay_refusesWhenDecimalsChanged`).
- **It cannot refuse a healthy feed.** A Chainlink proxy answers `decimals()` from its current aggregator: 8 today, on
  chain. The check fails only if Chainlink really changes the scale, and then refusing is right.
- **Cost.** About two more cold calls per leg per push (proxy, then aggregator). The runner sets no fixed gas limit, so
  viem's estimate includes them.
- **Lasting effect.** The guard is immutable. If Chainlink ever moved a feed to other decimals, this guard would refuse for
  good, and the pair would need a new guard, relay and market. That is the right trade-off (a loud stop instead of a ratio
  off by a power of ten). The checklist should name it as a known redeploy trigger.

### R-09: expected labels checked at deploy. Correct for its purpose; it cannot reject the real feeds.

- **Order of the checks.** Empty or equal labels are refused first (`BadLabels`). Then each leg's `description()` must equal
  its label (`WrongFeed`).
- **Swapped feeds:** refused. This was also shown on mainnet: the simulated constructor with BTC on top reverts.
- **Two addresses of the same feed:** refused. They return the same description, but the two labels must differ.
- **A wrong coin:** refused (`test_constructor_wrongBottomFeed_refused`).
- **Only at deploy.** A later description change at Chainlink cannot break a deployed guard. That is right.
- **It accepts the real feeds.** The labels the script passes are byte-for-byte what the mainnet proxies return (the
  simulated constructor succeeds).

The limit, made concrete on chain: the check proves only that a contract **says** `"ETH / USD"`. Three Chainlink contracts
on Arc say exactly that, with the same answer: the main proxy, the secondary proxy and the raw aggregator. The label
therefore cannot catch the wrong one of the three. See F-2.

## What else was looked for, and found fine

- **Ratio maths and rounding.** `_ratio = a·10^(18+dd) / (b·10^dn)`. That is `(a/10^dn) / (b/10^dd)` with 18 decimals,
  rounded down once.
  - With both legs at 8 decimals it is exactly `a·10^18/b`. That is the runner's `ratio18` (`runner/pairs.mjs`) and the
    script's `expectedRatio`. The mainnet simulation matched to the last digit.
  - Rounding down loses less than 1 unit in about 2.8·10^16, which is nothing against a 250 bps band.
  - `testFuzz_ratioFormula_anyDecimals` covers every combination of 0 to 18 decimals.
- **Overflow.**
  - Answers are capped at `uint128.max` (about 3.4·10^38) and decimals at 18.
  - So the top is at most 3.4·10^74 and the bottom at most 3.4·10^56. Both are below `uint256.max` (about 1.16·10^77).
  - The ratio is capped at `uint128.max` before the `int256` cast.
  - The relay's band maths (`uGuard * 250`) cannot overflow with that cap.
- **Division by zero.** `b > 0` is checked in `_read` before `_ratio` runs, and `10^dn ≥ 1`.
- **A stale or mismatched feed.**
  - A zero or future time is refused, and each leg is held to 25 h.
  - A wrong, swapped or doubled feed is refused at deploy (except the case in F-2).
- **Answer or decimals changing after deploy.**
  - A new answer is simply read again on each push.
  - An answer of 0 or below, or above `uint128.max`, is refused.
  - A decimals change is refused (R-06).
- **Order of the two feeds.** ETH is on top and BTC underneath everywhere:
  - the guard (by label),
  - the script (`top = CHAINLINK_MAINNET.eth`),
  - `RATIO_PAIRS.ethbtc` (`top: 'eth'`, checked by `ethBtcMarket()`),
  - the market name `"ETH/BTC 1h"`,
  - the runner (`RATIO_PAIRS['ETH/BTC'].top = 'ETH/USD'`).

  UP means "ETH's % move beat BTC's" (`testFuzz_outcomeFollowsPercentMoves`). Mutation `G01` (the ratio upside down) is
  caught.
- **Can anything here make `settle` fail?** No.
  - `PredictionArena` reads only the relay (`_tryGetRound` / `_tryLatest`, both inside `try`), never the guard.
  - The relay reads the guard only in `setPrice`, inside `try` (`_readGuard`).
  - So a guard failure only means "this push is refused". The round then refunds (`NoUpdate`, `EndNotAfterStart` or
    `Timeout`).
  - `settle`, `claim` and `markRefunded` cannot be blocked by the guard, and no money can be locked.
- **The guard as the relay's guard.** The relay copies `decimals() = 18` from the guard, and the runner pushes 18-decimal
  ratios. The relay's 26 h rule sees the older leg time.
- **The script's market and relay settings**, compared with the contracts:
  - The `createMarket` arguments `[name, feed, 0x0, 3600, 50, 500000]` match
    `createMarket(name, feedA, feedB, roundLength, startOffset, minStake)`.
  - The indices `verify()` reads from `markets(id)` (0 to 5) match the `Market` struct order
    `feedA, feedB, roundLength, startOffset, minStake, paused`.
  - Offset 50 s collides with no existing market (all of them are at 0, 100 or 200 mod 300).
  - The relay description starts with `"Matchup relay "`, as the relay requires.
  - The band is 250 bps (100 + 150), inside 1..1000.
  - The relay owner is read from the arena on chain. The pusher is checked against the runner key and the BTC relay on
    chain.
- **The script's flags.** The rules hold:
  - `--send` alone is refused;
  - `--verify-only` never sends, even with the long flag;
  - `--pair solbtc` is refused under any spelling;
  - anything that looks like a key is refused;
  - the server checkout is refused.

## Findings

### F-1. Low: a guard or relay taken from the deployment file on a re-run is not checked before the market is created

**Where:** `scripts/deploy-ratio-mainnet.mjs` `run()`, lines 194-195 and 246-277.

**What:** if `st.ratio.guards.ethbtc` or `st.ratio.feeds.ethbtc` already exists, the script skips that deploy and uses the
saved address.

- **The relay:** a saved relay is not checked at all before `createMarket` (line 273).
- **The guard:** a saved guard is checked only by "its answer equals Chainlink ETH/BTC" (lines 253-261). That catches a
  wrong or swapped guard, but not:
  - a wrong age limit;
  - an older RatioGuard version (v1 gives the same answer);
  - a contract with other code.
- **The full check comes too late.** `verify()` runs only after the market exists. A missing function such as
  `numeratorMaxAge` then makes it throw instead of reporting FAIL.
- **The dry run** only prints "already deployed at …".
- **An inconsistent file goes unnoticed.** For example, the market is listed but no guard: the script would then deploy a
  new guard and relay that nothing uses.

Creating the market is the one step that cannot be undone: the market's feed is fixed for ever. A file left by a half
finished run or edited by hand can therefore give market 12 the wrong relay (wrong pusher, band or guard).

**Harm:** none to players' money. The market must be paused for good (`setMarketPaused(12, true)`) and a new one created.

**Fix:**

1. Move lines 303-320 of `verify()` into two functions:
   - `checkGuard(io, G)` returns a list of failure strings;
   - `checkRelay(io, R, G, owner, pusher)` returns a list of failure strings.

   Wrap each `read` in `try`, so that a missing function counts as a failure, not a crash. `verify()` then calls them.
2. In `run()`, right after line 196 (`const relayArgs = …`), so it runs in both the dry run and the real run:

```js
if (have && (!doneGuard || !doneRelay)) stop('the file lists market ETH/BTC 1h but no RatioGuard or relay for it. Repair deployments/arc-mainnet.json first.');
if (doneRelay && !doneGuard) stop('the file has an ETH/BTC relay but no RatioGuard. Repair deployments/arc-mainnet.json first.');
if (doneGuard) {
  const bad = await checkGuard(io, getAddress(doneGuard.address));
  if (bad.length) stop('the saved RatioGuard is not what this script deploys:\n  ' + bad.join('\n  '));
}
if (doneRelay) {
  const bad = await checkRelay(io, getAddress(doneRelay.address), getAddress(doneGuard.address), arenaOwner, pusher);
  if (bad.length) stop('the saved relay is not what this script deploys:\n  ' + bad.join('\n  '));
}
```

3. Right before line 273 (`createMarket`), run `checkRelay` once more on `st.ratio.feeds[PAIR].address` and stop on any
   failure. It is cheap and covers a relay deployed in this same run.
4. Add tests:
   - a fake state with a saved relay whose `pusher()` is wrong, in send mode: `sender.write` is never called;
   - a fake state with market 12 listed but no guard: the run stops.

### F-2. Low: the Chainlink addresses come from `scripts/markets.mjs` alone, and the label check cannot catch a near miss

**Where:** `run()` lines 138-139 (`top`, `bottom` from `CHAINLINK_MAINNET`), and `verify()` lines 303-304, which compare
the guard with the same constants.

**What:** every check of a leg reads the address it is given:

- the script's leg check (label, 8 decimals, fresh);
- the RatioGuard's own label check;
- the after-deploy ratio match;
- `verify()`.

So if `CHAINLINK_MAINNET.eth` or `.btc` is wrong, every check still passes. On chain there are three realistic wrong
values that pass all of them today, because each says the right label, has 8 decimals and gives the same answer:

- **The raw aggregator** (`0xDBD4…4eC7` for ETH, `0x733F…4362` for BTC), for example copied from the explorer. When
  Chainlink next upgrades the feed, the proxy moves to a new aggregator and the old one stops updating. Within 25 h the
  guard refuses every push, and every round of the market refunds until a new guard, relay and market are deployed.
- **The secondary proxy** (`0x2c7D…3F60`, `0x7777…6aE3`, phase 2). Its role is unknown (`docs/SUBMISSION.md`), and it
  could follow a different update or upgrade schedule from the proxy the USD relays use.
- **A contract someone else controls** (a bad merge or a malicious edit). It could steer the band centre: a wider choice
  for a dishonest pusher, or refunds. This is the R-01 trust failure, and nobody would notice it.

**The independent reference.** The live ETH and BTC USD relays already use the main proxies as `guard()`. This was checked
on chain for this review, and they currently match `CHAINLINK_MAINNET`. They have run real rounds, so they are a reference
already on chain. The script reads only the BTC relay, and only its pusher.

**Harm:** no direct theft. At worst a dead market or a centre that someone else controls.

**Fix:** in `run()`, right after line 185, before anything is planned or sent:

```js
const relayOf = (c) => getAddress(st.feeds[c].address);
const [ethRelayGuard, btcRelayGuard, ethRelayPusher] = await Promise.all([
  read(relayOf('eth'), art.relay.abi, 'guard'), read(relayOf('btc'), art.relay.abi, 'guard'), read(relayOf('eth'), art.relay.abi, 'pusher'),
]);
if (getAddress(ethRelayGuard) !== top || getAddress(btcRelayGuard) !== bottom) stop(`CHAINLINK_MAINNET in scripts/markets.mjs (${top}, ${bottom}) is not what the live ETH and BTC relays use (${ethRelayGuard}, ${btcRelayGuard}). Nothing was sent.`);
if (getAddress(st.guards.eth.address) !== top || getAddress(st.guards.btc.address) !== bottom) stop('the Chainlink addresses in deployments/arc-mainnet.json differ from scripts/markets.mjs.');
if (getAddress(ethRelayPusher) !== filePusher) stop(`the ETH relay's pusher on chain is ${ethRelayPusher}, not ${filePusher}.`);
```

Also apply the first two checks in `verify()`, so that `--verify-only` re-proves them. In the test, add `feeds.eth` and
`guards` to `fakeState()`, add the `guard` and `pusher` reads to the fake chain, and add one test where the ETH relay's
guard differs and the run stops before planning.

### F-3. Info: `.toLowerCase()` throws away the address checksum

**Where:** `run()` lines 138-139, `verify()` lines 303-304, and the test lines 93-94:
`getAddress(CHAINLINK_MAINNET.eth.toLowerCase())`.

**What:** the constants in `markets.mjs` are written with mixed-case EIP-55 checksums, and all three are valid (checked
with viem's strict `isAddress`). `getAddress` on a mixed-case string throws if one character is mistyped. Lowercasing first
switches that check off, so a typo would go through. With F-2 fixed, the typo would be caught anyway. Without it, the
checksum is the only protection against a mistyped constant.

**Fix:**

1. Use `getAddress(CHAINLINK_MAINNET.eth)` and `getAddress(CHAINLINK_MAINNET.btc)`, without `.toLowerCase()`, at all six
   places.
2. In `ethBtcMarket()` line 74, replace the regex with `isAddress(CHAINLINK_MAINNET[c] || '', { strict: true })`, imported
   from viem. That way a checksum error becomes a listed problem instead of an exception.

### F-4. Info: the dry run hides a RatioGuard constructor revert

**Where:** `main()` line 372 (`estimateDeploy` returns `null` on **any** error) and `run()` lines 222-224 (`?? guessDeploy`).

**What:** if the constructor would revert on mainnet (`WrongFeed`, `BadMaxAge`, `TooManyDecimals`, a stale leg at deploy
time, or a code change), the gas estimate fails. The dry run then prints a gas figure worked out from the code size and says
nothing about the failure. The real run would send the deploy, which then reverts on chain and costs gas. That is safe, but
the dry run exists to catch exactly this. For the review, the constructor was simulated on mainnet with `eth_call`, as
described under Method. That works on the public RPC, so the script can do the same.

**Fix:**

1. Move `const from = io.deployer ?? arenaOwner;` (line 221) up before step 3.
2. Add `simulateDeploy: (ct, args, from) => pub.call({ account: from, data: encodeDeployData({ abi: ct.abi, bytecode: ct.bytecode, args }) })`
   to `io.chain`. It throws with the revert reason.
3. In `run()`, when `!doneGuard`:

```js
let runtime;
try { runtime = (await chain.simulateDeploy(art.ratioGuard, gArgs, from)).data; }
catch (e) { stop(`the RatioGuard constructor would revert on mainnet (${short(e)}). Nothing was sent.`); }
```

4. Optional, and worth it: add `callCode(code, abi, fn)`, an `eth_call` to a placeholder address with
   `stateOverride: [{ address, code }]`. Call `latestRoundData` on `runtime` and compare it with
   `expectedRatio(legs.eth.answer, legs.btc.answer)`, reading once more if a leg updated. The dry run then proves the guard
   gives Chainlink ETH/BTC before anything is spent. Today that check exists only after the guard is deployed (line 261).
5. If the estimate for the guard is `null` while the simulation passed, still stop rather than guess.

### F-5. Info: `verify()` does not check the guard's stored leg decimals (confirmed)

**Where:** `verify()`. `sameCode` blanks the immutables, so `numeratorDecimals` and `denominatorDecimals` are not covered
by the code comparison, and nothing else reads them. They are read from the feeds at deploy and the feeds have 8 decimals
today, but a later `--verify-only` does not prove it.

**Fix:** after line 308:

```js
const decs = await Promise.all([read(G, art.ratioGuard.abi, 'numeratorDecimals'), read(G, art.ratioGuard.abi, 'denominatorDecimals')]);
check(decs.every((d) => Number(d) === FEED_DECIMALS), `guard: both legs have ${FEED_DECIMALS} decimals`);
```

### F-6. Info: a pending ownership handover is only a warning (confirmed)

**Where:** `run()` line 174.

**What:** if the handover is accepted during the real run:

- either `createMarket` reverts with `OwnableUnauthorizedAccount` (gas only);
- or the new relay ends up owned by the old owner, so it does not follow the arena to the new owner and needs a separate
  handover.

**Fix:** replace line 174 with
`if (pending !== zeroAddress) { if (mode.send) stop(\`an ownership handover to ${pending} is pending on the arena; finish or cancel it first.\`); log('  WARNING: …'); }`.

### F-7. Info: no gas price ceiling on the real run (confirmed)

**Where:** `sender.deploy` and `sender.write` (lines 385-396) use viem's default fees.

**What:** today the price is 25 gwei. A spike between the dry run and the real run is paid without asking. The loss is
bounded by the owner wallet's balance, so the harm is small.

**Fix:** add `export const MAX_GAS_PRICE_WEI = 100n * 10n ** 9n; // 4x the 25 gwei seen in Nov 2026`. Before step 5 in
`run()`, add
`if (mode.send && gasPrice > MAX_GAS_PRICE_WEI) stop(\`gas price ${formatUnits(gasPrice, 9)} gwei is above ${formatUnits(MAX_GAS_PRICE_WEI, 9)}; try later.\`);`.
Also pass `maxFeePerGas: MAX_GAS_PRICE_WEI` in `deployContract` and `writeContract`.

### F-8. Info: a crash between "transaction mined" and "saved to the file" needs a manual repair (confirmed)

**Where:** lines 247-249, 264-266 and 273-275. The state is saved only after `waitForTransactionReceipt` returns.

**What:** if the process dies or the RPC call fails after the transaction is sent but before it is saved:

- **A deploy:** the re-run deploys a second guard or relay. That costs gas only.
- **`createMarket`:** the re-run stops safely, because the arena then has 13 markets and the file lists 12. The file must
  then be repaired by hand.

**Fix:**

1. In `sender.deploy` and `sender.write`, return the hash as soon as it is known, through a callback
   (`onHash(hash)`).
2. In `run()`, save `st.ratio.pending = { step, hash }` from that callback, and delete it after the result is saved.
3. On start, if `st.ratio.pending` is set, stop and print the transaction link with the line to add to the file.

Alternatively, document that repair in `docs/RATIO_MAINNET_CHECKLIST.md`.

### F-9. Info: the script deploys whatever is in the working tree (new)

**Where:** `main()` line 358 (`art: compile()`), and `scripts/compile.mjs`, which reads `contracts/*.sol` from disk.

**What:** nothing checks that `contracts/RatioGuard.sol`, `contracts/GuardedRelayFeed.sol`, `scripts/markets.mjs` or the
script itself match a reviewed, committed version. An uncommitted edit would be deployed, and `verify()` would still pass,
because it compares the chain with the same local compile.

**Harm:** none by itself. It is a gap in the chain from "reviewed" to "deployed". The relay matters most here: its source
is meant to stay byte-identical to the verified mainnet relays.

**Fix:** in `main()`, before `run()` when `mode.send`:

```js
import { execFileSync } from 'node:child_process';
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'contracts', 'scripts/markets.mjs', 'scripts/deploy-ratio-mainnet.mjs', 'scripts/compile.mjs'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (dirty) fail('contracts/ or the deploy scripts have uncommitted changes. Commit (and review) them first:\n' + dirty);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
```

Print `commit` in the plan and save it in `st.ratio.guards[PAIR]` and `st.ratio.feeds[PAIR]`. Optionally, also stop if
`normalise(art.relay.deployedBytecode, …)` differs from the code of the live BTC relay. Both use the same unchanged
contract, so this proves the relay source has not drifted.

### F-10. Info: a leg that returns malformed data reverts with a decode error, not `FeedUnavailable` (confirmed)

**Where:** `RatioGuard._read`, lines 279 and 286.

**What:** Solidity's `catch` does not catch a failure to decode the returned data. Examples:

- too few bytes;
- a `decimals()` value above 255;
- a call to an address with no code.

The guard then reverts with an empty error instead of `FeedUnavailable`. The effect is the same: the relay's
`try guard.latestRoundData()` catches any revert, the push fails with `GuardUnavailable`, and the round refunds. No wrong
ratio is possible.

**Fix:** no code change. Optionally, at the next planned redeploy (so the source keeps matching what is deployed):

- extend the header line "either Chainlink feed reverts" with "or returns data that cannot be decoded";
- correct the `_description` doc comment (line 101). It shows a format the script does not use. The real one is
  `"Matchup ratio guard ETH / BTC: Chainlink ETH/USD divided by Chainlink BTC/USD"`.

### F-11. Info: R-04 is fixed as far as code can fix it; what is left needs monitoring (confirmed)

**What:** with a 24 h heartbeat, a limit for each leg can be at most about an hour tighter than the relay's 26 h without
refusing healthy feeds.

- **Normal operation:** this matters little. A leg that has not updated for most of a day has also not moved past its
  deviation threshold (0.5 % ETH, 0.1 % BTC), so the band centre stays within about 0.6 % of the true ratio.
- **A Chainlink outage** (a frozen leg while the market moves): honest pushes start to be refused (refunds), and a dishonest
  pusher has up to 25 h of drift plus 2.5 % to work with.

**Fix (operational, no contract change):** in `runner/pusherWatch.mjs`, or the runner's regular checks, read both legs'
`latestRoundData().updatedAt` for each ratio relay. Alert (ntfy and log) when either leg is older than 24 h 10 min, which
means a missed heartbeat. Treat that alert like a `PusherChanged` alert: pause market 12 until the feed is back.

### F-12. Info: test gaps (extended)

The 82 ratio tests are thorough on the maths, every refusal and the v2 checks. What is missing:

1. **The script's real run has no test.** All 16 script tests are dry runs, or send runs that stop before the first
   transaction. Nothing covers:
   - the order of the steps;
   - the arguments of `sender.deploy` for the relay (`relayArgs`);
   - the arguments of `createMarket`;
   - the after-deploy ratio match;
   - the state saved to the file;
   - `verify()`.

   For this review the argument order was checked by hand against the contracts and is correct, but nothing would catch
   a regression. Add a fake `sender` that records every call, a fake chain that answers the new contracts' reads, and one
   end-to-end send test. Assert:
   - the exact `gArgs`;
   - `relayArgs = [owner, pusher, guard, 250, ratioRelayDescription('ethbtc','mainnet')]`;
   - `createMarket` = `['ETH/BTC 1h', relay, 0x0, 3600, 50, 500000n]`;
   - three saves;
   - `verify()` returns true.

   Add one `verify()` test in which each check fails in turn.
2. **The labels in the integration tests prove nothing.** `RatioMarket.t.sol`, `RatioSolBtc.t.sol` and `RatioTrust.t.sol`
   build the guard with `ethUsd.description()` and `btcUsd.description()` as the expected labels, so these suites can never
   fail the label check. That is fine for their purpose, because the label tests live in `RatioGuard.t.sol`. Use the
   literal stand-in labels (`standInDescription`) so the suites would notice a label mix-up.
3. **There is no fork test against the real Arc proxies.** All Foundry tests use mocks. For this review, the equivalent
   was done read-only with `eth_call` (constructor accepted, answer exact, swapped order refused). Make it repeatable: add
   `contracts/test/fork/RatioGuardFork.t.sol`, run with `forge test --fork-url $ARC_MAINNET_RPC_URL` and kept out of
   normal CI. It should:
   - deploy with `90000, 90000, "ETH / USD", "BTC / USD"`;
   - check `answer == eth * 1e18 / btc`;
   - check that the swapped order reverts `WrongFeed`;
   - check that the main proxy gives the same answer as the address in `deployments/arc-mainnet.json` `guards`.
4. **There is no malformed-return test** (F-10). Add a mock whose `latestRoundData` returns 64 bytes. Assert that the guard
   reverts and that the relay's `setPrice` reverts `GuardUnavailable`.
5. **Three mutations are missing.** There is no mutation for:
   - `_checkLabel(denominator_, …)` (only the numerator call is mutated, in `G10`);
   - the `denominatorMaxAge_` bound;
   - the `dd > MAX_FEED_DECIMALS` bound.

   The existing tests would catch all three (`test_constructor_wrongBottomFeed_refused`,
   `test_constructor_maxAge_zeroOrAbove26h_refused`, `test_decimals_18Accepted_19Refused`), so this is about completeness
   only. Add them as `G19` to `G21`.

## Before the real run

1. Fix F-1 and F-2 in `scripts/deploy-ratio-mainnet.mjs`, with their tests. F-3, F-4 and F-9 are small and belong in the
   same change; F-5 to F-8 are optional. This review did not make any change.
2. Add the end-to-end send test (F-12, item 1). The script has never been exercised past its first transaction.
3. Run the dry run again, and read it as `docs/RATIO_MAINNET_CHECKLIST.md` says. With F-4 fixed, the dry run itself proves
   that the constructor accepts the real feeds and that the guard's answer is Chainlink ETH/BTC.
4. Add to the checklist the known redeploy triggers: Chainlink changes a leg's decimals (R-06), or a leg misses its
   heartbeat for good (F-11).

Nothing in RatioGuard version 2 needs to change before mainnet.

## Not covered

- Chainlink's own trust: the proxy owner can point the proxy at any aggregator. That is accepted by design, as in part 1.
- The runner's pushing logic for market 12. It was only checked for orientation and maths (`runner/pairs.mjs`).
- The testnet script `scripts/deploy-ratio.mjs`.
- An RPC that lies to the script. The script trusts `ARC_MAINNET_RPC_URL` for every read.
