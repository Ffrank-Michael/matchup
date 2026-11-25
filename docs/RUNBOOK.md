# Matchup runbook (for the operator)

This is the page to open when you need to look after Matchup: who holds which key, what an alert means, check the runner,
restart it, update it, redeploy the site, top up gas, or handle something that looks wrong. It is written for someone who
is not a programmer. Every command is copy-and-paste. The step-by-step server setup is in `docs/MAINNET_AGENTS.md`;
the audit background is in `docs/AUDIT_RATIO_PART1.md` and `docs/AUDIT_RATIO_PART2.md`.

Nothing in this file is secret, and no secret should ever be added to it.

**The three pieces**

| Piece | What it does | Where it runs |
|---|---|---|
| **The runner** | Pushes BTC/ETH/SOL prices to the relay feeds and settles rounds on Arc mainnet. Also makes the four agents' *guide calls* (free, no money, nothing on chain), and watches the contracts for changes of pusher, owner or market (section 2). | The Oracle Cloud VM (Ubuntu, user `ubuntu`), repo in `/home/ubuntu/arc-arena`, service `kairo-runner` |
| **The website** | https://www.playmatchup.xyz. People connect a wallet (or Google) and make calls with their own USDC. | Vercel, built from the GitHub repo (`web/` folder) |
| **The contracts** | The arena (holds the money) and the relay feeds: three USD relays today, plus the ETH vs BTC ratio relay once it is deployed (`docs/RATIO_MAINNET_CHECKLIST.md`). Addresses are in `deployments/arc-mainnet.json`. | Arc mainnet (chain 5042). Their code cannot be changed. |

**Public addresses you will need** (from `deployments/arc-mainnet.json`, safe to share)

| What | Address |
|---|---|
| Runner wallet (the relay "pusher", pays gas) | `0x141043c9f604c8274286Dc0319a2F1c9124CEa3F` |
| Arena (PredictionArena v2) | `0xaebac196c76a2c9338a30aef663e4799ffa0d364` |
| BTC relay feed | `0x15dbb61c92fd8c301a19b769d984491731afab60` |
| ETH relay feed | `0xdbb8d2106f1e45aa5287b666a4c8841bead356c0` |
| SOL relay feed | `0x5f6952050147e922c7aa1264896aa62bafbc5462` |
| Owner (today the deployer wallet, field `owner`) | `0x1AB2ADf11B3B16544C5F76d74c729B4EdCDcb4bC`, until it is moved to a hardware wallet (section 1) |
| Explorer | https://explorer.arc.io (paste any address above into the search box) |

**Good to know before anything else**

- **A dead runner never loses money.** If no prices are pushed or nobody settles, rounds are refunded by the contract and
  people claim their stake back. A dead runner means "no results for a while", never "money lost".
- **The owner key is the one that matters most.** It cannot take money out of the arena directly, but it can hand price
  control to anyone at once (section 1). It never goes on the server.
- **The runner only spends gas.** It never places calls with money. The house agents on mainnet have no wallets; their
  calls are "guide calls" (labelled "Guide call, no money" on the site).
- **What the runner does per round:**
  - no calls at all: nothing (no price push, no settle, no gas);
  - calls on one side only: no price push, but it **settles the round right after it ends**, so the contract refunds it at
    once and the callers can claim straight away;
  - calls on both sides: a start price, an end price and a settle.

  So a quiet log on a quiet day is normal.
- **How prices are taken** (`docs/RULES.md`): BTC and ETH start and end prices are the **median of all Bitfinex trades in a
  window** (60 s for BTC, 90 s for ETH, at least 3 trades or the round refunds). The start window opens 2 s after the lock;
  the end window closes 60 s before the round ends. SOL keeps a **single trade** (see "Known limits"). Every price is
  checked against Chainlink before it is sent, and an end price is **never sent in the last 20 seconds** of a round.
- **Only one runner at a time.** Never run the mainnet runner on your PC while the server runs it.

---

## 1. Keys: who holds what

| Key | Can do | Where it lives |
|---|---|---|
| **Owner** of the arena and of every relay (`MAINNET_DEPLOYER_PRIVATE_KEY` today) | `setPusher` on each relay (hand price control to any address, at once), `createMarket`, `setMarketPaused`, `withdrawFees`, move ownership | **Offline, or on a hardware wallet. Never on the server, never in the server's `.env`, never in a browser wallet used for anything else.** |
| **Runner** (`MAINNET_RUNNER_PRIVATE_KEY`) | push prices to the relays, settle rounds | the server's `.env` only (`chmod 600`), a few USDC for gas |

**Why the owner key matters this much.** The arena never lets the owner take player money, but the relay owner can make any
address the pusher in one transaction, and the pusher decides the results inside the band (1% on the BTC relay, 1.5% on
ETH and SOL, 2.5% on the coin-vs-coin relays, against a typical 1-hour move of about 0.2% for a ratio). Whoever holds the
owner key can therefore take the matched stakes of every two-sided round from the next round on. Treat it like the key to
the pot.

**What stops it reaching the server** (audit P2-03):
- `node scripts/make-server-env.mjs` on your PC writes the server's `.env` with only the names the runner needs; never
  copy your PC's whole `.env` (`docs/MAINNET_AGENTS.md`, step 6).
- `deploy/setup-runner.sh` is not `READY` while `MAINNET_DEPLOYER_PRIVATE_KEY` is in the server's `.env`.
- A **live** mainnet runner **refuses to start** when its `.env` holds `MAINNET_DEPLOYER_PRIVATE_KEY`
  (`STOP: this .env holds MAINNET_DEPLOYER_PRIVATE_KEY, the mainnet owner key ...`). A dry run on your PC, where the deploy
  scripts need it, only prints a `WARNING`.
- If the owner key was ever on the server, treat it as exposed: delete the line, and move ownership to a new wallet (below).

**Move the owner to a hardware wallet** (do this before the coin-vs-coin markets go live; the contracts use two-step
ownership, so a typo cannot lose them):

1. From the current owner wallet: `transferOwnership(<hardware wallet address>)` on the arena and on each relay feed
   (the three USD relays, and the ratio relay once deployed).
2. From the hardware wallet: `acceptOwnership()` on each of them. Until this step the old owner keeps every power.
3. Check that `owner()` on every contract reads the hardware wallet (on the explorer, or
   `cast call <contract> "owner()(address)" --rpc-url <Arc mainnet RPC>`). Note: `node scripts/deploy.mjs --set mainnet --verify-only`
   still expects the deployer wallet as the owner, so after the move it reports its owner lines as FAIL until that script
   learns the new owner.
4. Remove `MAINNET_DEPLOYER_PRIVATE_KEY` from `.env` on the PC. Later owner actions are signed on the hardware wallet
   (the deploy scripts that need the owner, such as a mainnet `createMarket`, must then send through it instead of a key in `.env`).

Each of these steps sends an alert (section 2): that is expected when you are the one doing it.

`renounceOwnership` is disabled on purpose: a contract without an owner could not pause a market or replace a broken pusher.

---

## 2. Alerts, log lines and what to do

**Phone alerts** come from ntfy.sh. The topic name is `NTFY_TOPIC` in the server's `.env`; subscribe to it in the ntfy app.
Without it, alerts are only in the log: the supervisor then says `alerts OFF: add NTFY_TOPIC to .env` and the runner says
`WARNING: no NTFY_TOPIC in .env`. Add the topic and restart.

**Test the alerts once** after setting the topic (and after any change to it): restart the runner (section 3); you should
get "stopped" and "restarted" on the phone.

| Alert title | From | What it means | What to do |
|---|---|---|---|
| **Matchup MAINNET runner stopped** | `runner/supervise.mjs` | The mainnet runner exited. The supervisor starts it again in 15 s. | Usually nothing. If it keeps coming, read the log (section 3c) for the line just before it. |
| **Matchup MAINNET runner restarted** | `runner/supervise.mjs` | It is running again. | Nothing. |
| **Matchup MAINNET runner crash loop** | `runner/supervise.mjs` | It stopped 5 times in 10 minutes. It now waits 5 minutes between tries. | Read the log now. Most common causes: wallet out of gas, a wrong setting in `.env`, the RPC is down. |
| **Matchup MAINNET runner cannot start** | `runner/run-mainnet.mjs` | The start-up check failed (wrong chain, no arena, the runner is the owner, or not the pusher of a relay); the text says which. | Fix what it names (the `STOP:` table below); the supervisor keeps restarting it until then. |
| **Matchup: relay pusher changed** | `runner/pusherWatch.mjs` (checked every minute) | A `PusherChanged` event on a relay: someone with the owner key changed who may push prices. | **If you did not do it: the owner key is compromised.** At once, from the owner wallet if you still can: `setMarketPaused(id, true)` for every market on that relay, then `setPusher(<runner address>)`. Then move ownership to a new wallet (section 1). If you did it (a planned key change), check that the new address is the one you meant. |
| **Matchup: runner is not the pusher** | `runner/pusherWatch.mjs` | A relay's `pusher()` is another address (also caught if it changed while the runner was down). | The same as above. Until it is fixed, this runner's pushes to that relay are refused and its rounds refund. |
| **Matchup: ownership transfer started** / **owner changed** | `runner/pusherWatch.mjs` | Someone with the owner key proposed a new owner, or a new owner accepted, on the arena or a relay. | **If you did not do it: the owner key is compromised.** A transfer that only *started* can still be stopped: from the owner wallet, `transferOwnership(<your own address>)` replaces the pending one. Then pause the markets and move ownership to a new wallet (section 1). |
| **Matchup: market created** / **market paused** / **market unpaused** | `runner/pusherWatch.mjs` | The owner created, paused or unpaused a market. | If you did not do it, as above. |
| **Matchup: pusher watch cannot read the chain** | `runner/pusherWatch.mjs` | For over 5 minutes the runner could not read these events (repeated at most hourly). | Check the RPC node (`ARC_MAINNET_RPC_URL`, or the default public one). Until it works, a change of pusher or owner would not be noticed. |
| **Matchup runner stopped / restarted / crash loop** (no "MAINNET") | `runner/supervise.mjs` | The same, for the **testnet** runner. | Same steps; testnet money is not real. |

A pause only stops new calls. Calls already placed still settle (with whatever the pusher posts) or refund. So act on a
pusher or owner alert before the next lock, not after the round.

The watch remembers the last block it read in `data/pusher-watch-mainnet.json`, so a restart goes on from there and does
not alert old events again.

The supervisor itself is restarted by systemd if it dies. There is **no** alert if the whole VM is down (then nothing can
send one), and none yet for a low runner balance or a refused price jump (see "Known limits"): that is why section 3 is
worth doing every day or two.

**Lines in the log** (`journalctl -u kairo-runner`)

| Line starts with | Meaning | Worry? |
|---|---|---|
| `*** LIVE MODE on Arc MAINNET` | The live mainnet runner started. | No |
| `--- DRY RUN on Arc mainnet` | A dry run started: it sends **nothing**. If you meant to be live, see section 3. | Only if you meant live |
| `checked: Arc mainnet, <n> markets, <m> relay feeds, the runner is the pusher of each` | The start-up checks passed. Today 12 markets and 3 feeds; 13 and 4 once ETH vs BTC is deployed. | No |
| `DONE:` | A price push or a settle went through. A `tx` line follows with its hash. An end price also says `end price landed <n> s before the round ends`. | Only if it says `LESS THAN 30 s` often |
| `WOULD:` / `WOULD FAIL:` | Dry run: what it would have sent, or what would have failed. | No |
| `WAITING:` | A price is not ready yet: the BTC/ETH price window is not over, no SOL trade since the lock yet, or the chain's clock runs a little behind Bitfinex's so the start must be later (P2-14). It tries again by itself. | Only if the same round waits for minutes |
| `FAILED:` | A push or settle failed. It tries again by itself (5 s for a price, 15 s up to 4 min for a settle). | Once: no. The same round again and again: yes, read the reason on the next line |
| `... only <n> BTC/USD trades on Bitfinex from ... (at least 3 needed): no price, so the round refunds` | Too few trades in the price window. Not tried again for that round. | No, unless it happens on most rounds |
| `end price not sent: only <n> s left before the round ends (the limit is 20 s)` | The end price was ready too late. Sending it could land after the end and refund the round, so it was not sent (P2-02). That round refunds. | Rare: no. Often: the RPC or Bitfinex is slow |
| `start price not sent: the chain's clock is <n> s behind Bitfinex's (more than 30 s)` | The Arc node's clock or Bitfinex's is badly off. No start prices until it is fixed. | **Yes:** check the RPC node |
| `price not sent: ... away from Chainlink` | Bitfinex and Chainlink disagree by more than the relay allows, so the price was not sent (no gas spent). | Rare and short: no. For long: Bitfinex or Chainlink has a problem; affected rounds refund |
| `price not sent: Chainlink's last update is too old` | Chainlink has not updated for over 26 hours. No prices can be pushed for that coin. | Yes, but nothing to fix on our side; rounds refund |
| `... moved from ... to ... (over 20%): not trusting it` | A price more than 20% from the last one was refused. | **Yes, if the move is real:** restart the runner (see "Known limits", P2-09) |
| `ALERT:` | A copy of a phone alert (table above). | As the alert |
| `pusher watch problem:` | One pass of the watch could not read the chain. | Only if it repeats (then you also get the "cannot read the chain" alert) |
| `tick error:` | One pass went wrong (often the RPC or Bitfinex did not answer). The next pass tries again. | Only if it repeats for many minutes |
| `slow pass: ... s` | A pass took more than 4 seconds. | Only if it is constant |
| `GUIDE ...` / `GUIDE problem` | The free guide calls (Gemini). These never stop prices or settles. | No for money. A `429` means a model hit its free daily limit; it comes back by itself |
| `WARNING: this .env holds the mainnet owner key` | A dry run on your PC with the owner key in `.env`. Fine on the PC, never on the server. | Yes, if you see it on the server |
| `STOPPING: the runner wallet holds ... below the 0.10 ...` | Out of gas. It stops until topped up. | **Yes:** top up (section 6) |
| `STOP: ...` | A start-up check failed and it will not run. The message says what to fix. | **Yes:** see below |

**`STOP:` messages and the fix**

| Message | Fix |
|---|---|
| `No .env file` | The settings file is missing on the server. Make it again on your PC with `node scripts/make-server-env.mjs` and copy it over (`docs/MAINNET_AGENTS.md`, step 6). |
| `this .env holds MAINNET_DEPLOYER_PRIVATE_KEY, the mainnet owner key` | The owner key is on the server. Delete that line now, restart, and treat the owner key as exposed: move ownership (section 1). |
| `MAINNET_RUNNER_PRIVATE_KEY is missing` / `is not 0x + 64 hex characters` | The runner key line in `.env` is missing or damaged. Fix it with `nano /home/ubuntu/arc-arena/.env` (no quotes, no spaces). |
| `MAINNET_ARENA_ADDRESS is missing` / `is not an address` | Put the arena address (table at the top) in `.env`. |
| `cannot reach the RPC` / wrong chain | The Arc RPC is down or `ARC_MAINNET_RPC_URL` points at the wrong network. Remove that line to use the default. |
| `the runner (...) is not the pusher of feed ...` | Either the runner key in `.env` is not the wallet the relays accept (put the right key back; do **not** change the relays), or someone changed the relay's pusher (you would also have had a "pusher changed" alert: follow it). |
| `the runner wallet is also the arena owner` | `.env` holds the owner key as the runner key. Replace it with the runner key at once, and treat the owner key as exposed (section 1). |
| `--live is the testnet runner's flag` | Someone started the mainnet runner with the testnet flag. Use the long flag (section 3). |

---

## 3. Check and restart the runner

**Log in to the server** from PowerShell on your PC (`<KEY>` is your SSH key file, `<SERVER_IP>` the VM's public IP):

```
ssh -i <KEY> ubuntu@<SERVER_IP>
```

All the commands in sections 3 and 4 are typed **on the server** unless it says "on your PC".

### Is it healthy? Run these four checks. All four should look right.

**a. Is the service running?**
```
systemctl status kairo-runner --no-pager
```
Good: `Active: active (running)`. Bad: `failed`, `inactive` or `activating (auto-restart)` (see "Restart" below).

**b. Which runner is it?** (testnet or mainnet, dry run or live)
```
systemctl cat kairo-runner | grep ExecStart
```
- `... supervise.mjs --journal` → the **testnet** runner (this is what the file in the repo says).
- `... supervise.mjs --journal --mainnet` → the mainnet runner as a **dry run** (sends nothing).
- `... supervise.mjs --journal --mainnet --i-understand-this-spends-real-usdc` → the **live mainnet** runner. This is the
  one that pushes real prices and settles real rounds.

If there are two `ExecStart` lines, the last one wins (the first, empty one is how an override clears the old value).

**c. What has it been doing?**
```
journalctl -u kairo-runner --since "1 hour ago" --no-pager | tail -40
```
Good signs: the first line after a start says `*** LIVE MODE on Arc MAINNET ...`, then
`checked: Arc mainnet, 12 markets, 3 relay feeds, the runner is the pusher of each`, then `DONE:` lines when people play,
and one `GUIDE Gemini requests: ...` line an hour. No `WARNING: no NTFY_TOPIC`. Section 2 says what each line means.

**d. Does the runner wallet have gas?** (works on the server and on your PC; it reads a public address only)
```
node -e "fetch('https://rpc.mainnet.arc.io',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBalance',params:['0x141043c9f604c8274286Dc0319a2F1c9124CEa3F','latest']})}).then(r=>r.json()).then(j=>console.log((Number(BigInt(j.result))/1e18).toFixed(4),'USDC'))"
```
It prints something like `2.9372 USDC`. Keep it **above 1 USDC** (section 6). Below **0.10 USDC** the runner stops itself.

**Also worth a look now and then**

| Check | Command | Good |
|---|---|---|
| The owner key is not on the server | `grep -c MAINNET_DEPLOYER_PRIVATE_KEY /home/ubuntu/arc-arena/.env` | `0` |
| `.env` is private | `ls -l /home/ubuntu/arc-arena/.env` | `-rw-------` owned by `ubuntu` |
| Memory | `free -h` | some swap in use is normal |
| Disk | `df -h /` | under 80% used |
| Price log is growing | `tail -3 /home/ubuntu/arc-arena/data/price-log-mainnet.jsonl` | recent times (only when people played on both sides) |
| Last push on chain | open the BTC relay on the explorer, tab "Transactions" | matches the last round people played |

### Restart

```
sudo systemctl restart kairo-runner
systemctl status kairo-runner --no-pager
journalctl -u kairo-runner -f
```
`-f` follows the log live. Press **Ctrl+C** to leave it (the runner keeps running). Look for the `checked: ...` line. If
the runner is not the pusher of a relay, or the owner key is in its `.env`, it stops at start with a plain `STOP:` message
(section 2); it never pushes to a relay it does not control.

| I want to | Command |
|---|---|
| Stop it | `sudo systemctl stop kairo-runner` |
| Start it | `sudo systemctl start kairo-runner` |
| See the last 50 lines | `journalctl -u kairo-runner -n 50 --no-pager` |
| It says `failed` and will not start | Fix the cause first (read the last 50 lines), then `sudo systemctl reset-failed kairo-runner` and start it |
| Reboot the whole VM | `sudo reboot`, wait a minute, log in, `systemctl is-active kairo-runner` must say `active` |

**Switching the service to the live mainnet runner** (only when you have decided to go live; it spends real USDC on gas):
```
sudo systemctl edit kairo-runner
```
In the editor that opens, between the comment lines, put exactly:
```
[Service]
ExecStart=
ExecStart=/usr/local/bin/node runner/supervise.mjs --journal --mainnet --i-understand-this-spends-real-usdc
```
Save (Ctrl+O, Enter, Ctrl+X), then `sudo systemctl restart kairo-runner`. To go back to the testnet runner:
`sudo systemctl revert kairo-runner` and restart. The override lives outside the repo, so `git pull` never undoes it.

**Try a mainnet dry run by hand** (sends nothing, safe at any time, even while the service runs):
```
cd /home/ubuntu/arc-arena
node runner/run-mainnet.mjs --once
```
It should print `--- DRY RUN on Arc mainnet: nothing will be sent ---` and `WOULD:` lines (or nothing to do).

---

## 4. Update the runner from GitHub

When new runner code has been pushed to GitHub:
```
cd /home/ubuntu/arc-arena
git status --short
git pull
npm ci --no-audit --no-fund
sudo systemctl restart kairo-runner
journalctl -u kairo-runner -f
```
- `git status --short` should print **nothing**. If it lists files, someone changed code on the server; stop and ask
  before pulling (`.env` and `data/` are ignored by git and never show up here).
- `git pull` updates the branch the server is on (`git branch --show-current` shows which). It should be the branch the
  production site is built from (section 5).
- `npm ci` is slow on the 1 GB VM (a few minutes). It is only needed when `package-lock.json` changed, but it is always safe.
- Watch the log for a minute after the restart: you want the `checked: Arc mainnet ...` line and no `STOP:`.
- If the update needs a new setting in `.env`, make the file again on your PC with `node scripts/make-server-env.mjs`
  (never copy the PC's whole `.env`).

**Going back if an update breaks it:** `git log --oneline -5` shows the last commits. `git checkout <the previous id>`
then `sudo systemctl restart kairo-runner` puts the old code back. Tell whoever made the change, and return to the
branch later with `git switch <branch>` and `git pull`.

---

## 5. Redeploy the website

The site is built by **Vercel** from the GitHub repo. The project's **Root Directory** is `web`. The build
(`npm run build`) first copies the contract addresses from `deployments/` into the site (`npm run sync-markets`).

**Normal way: push to GitHub.** A push to the branch set as Vercel's production branch (Vercel → the project →
Settings → Git → Production Branch) builds and publishes the site by itself in a few minutes. A push to any other branch
makes a *preview* link only, not the real site.

**Before pushing site changes** (on your PC, in the `web` folder) run a real build, because some errors only show there:
```
cd C:\Users\Frank\Desktop\arc-arena\web
$env:NEXT_PUBLIC_NETWORK = 'mainnet'; npm run build
```
It must end without `Error`. (A warning "Failed to fetch usage" on `/_not-found` is harmless.)

**Redeploy without new code** (for example after changing a Vercel setting): Vercel → the project → Deployments → the
newest **Production** deployment → the `...` menu → **Redeploy**. Settings changes only take effect after a redeploy.

**Going back to an older site** if a deploy broke it: Vercel → Deployments → pick the last good Production deployment →
`...` → **Promote to Production** (or "Instant Rollback"). That takes seconds and does not touch the contracts.

**Check after every deploy:** open https://www.playmatchup.xyz on your phone and on a laptop. The markets load, the live
price moves, and "Connect wallet" opens.

---

## 6. The runner wallet's gas (USDC)

On Arc, **gas is paid in USDC**. The runner wallet's USDC is its gas money. There is one balance; the explorer may show it
two ways (6 or 18 decimals), but it is the same money.

**How much it uses** (measured, about 25 gwei): a price push about 0.0023 USDC, a settle about 0.004 USDC. A round with
players on both sides costs about 0.01 USDC in all (two pushes and a settle; a push serves every market of its coin). A
round with calls on one side only costs one settle (about 0.004 USDC). A round with nobody in it costs nothing. A busy day
with someone playing every 5-minute round of one coin is about 3 USDC; most days are far less. Someone can also make the
runner pay for settles on purpose with tiny one-sided calls (see "Known limits", P2-12), so watch the balance.

**Check it:** command 3d above, or paste the runner address into https://explorer.arc.io.

**Top it up** (from your own wallet, on your phone or PC):
1. Open your wallet and pick the **Arc mainnet** network.
2. Send USDC to the runner address `0x141043c9f604c8274286Dc0319a2F1c9124CEa3F`. Copy the address from
   `deployments/arc-mainnet.json` (field `pusher`) or from this page; check the first and last 4 characters after pasting.
3. Send a small amount first (for example 1 USDC) and check that it arrived (command 3d), then send the rest.
4. Keep **2–5 USDC** in it. Do not keep much more: it is a hot wallet on a server.

**Only on Arc mainnet.** USDC sent on another network (Ethereum, Base, and so on) to this address does not arrive on Arc.

If it ran out and the runner stopped (alert "stopped" with a `STOPPING: ... below the 0.10` line in the log), top it up;
the supervisor restarts the runner by itself within 15 seconds to 5 minutes. To restart at once:
`sudo systemctl restart kairo-runner`.

---

## 7. Where each secret lives (names only)

Values never go in chat, in git, in this file, or in a screenshot. `.env` files are ignored by git.

**On the server: `/home/ubuntu/arc-arena/.env`** (made on your PC with `node scripts/make-server-env.mjs`, which writes
`.env.server` with only the names below; copy that to the server as `.env` and delete it from the PC. It must be
`-rw-------` owned by `ubuntu`)

| Name | Secret? | What it is |
|---|---|---|
| `MAINNET_RUNNER_PRIVATE_KEY` | **Yes** | The runner wallet's key. Controls its gas money and can push prices inside the band. |
| `MAINNET_ARENA_ADDRESS` | No | The arena address. |
| `ARC_MAINNET_RPC_URL` | Maybe (paid RPCs put a key in the URL) | Optional; the default is the public Arc RPC. |
| `GEMINI_API_KEY` | **Yes** | Google AI key for the guide calls. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | **Yes** (the token) | Where the runner saves the guide calls for the site (write token). |
| `NTFY_TOPIC` | Semi (anyone who knows it can read the alerts) | The phone-alert topic. Pick a long, unguessable name. |
| `DEPLOYER_PRIVATE_KEY`, `RUNNER_PRIVATE_KEY`, `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | **Yes** | Testnet runner and testnet agent wallets only (test money). |

Also on the server: `~/.ssh/kairo_deploy` (the read-only GitHub deploy key; it can download the repo and nothing else).

**Never on the server: `MAINNET_DEPLOYER_PRIVATE_KEY`** (the owner key, section 1). A live runner refuses to start next to
it and the setup script is not `READY` with it. If you ever find it on the server, delete that line, restart the runner,
and move ownership to a new wallet (section 1).

**On your PC: `C:\Users\Frank\Desktop\arc-arena\.env`**: everything above, plus `FINAL_OWNER_ADDRESS` (an address, not
secret) and, **only until the owner is moved to a hardware wallet**, `MAINNET_DEPLOYER_PRIVATE_KEY`. After the move, delete
that line (section 1, step 4); the owner then lives only on the hardware wallet and its recovery words, kept offline.
**`web\.env.local`**: the site's settings for local testing (same names as on Vercel, below).

**On Vercel** (project → Settings → Environment Variables)

| Name | Secret? | What it is |
|---|---|---|
| `CIRCLE_API_KEY` | **Yes** | Circle key for Google sign-in wallets. Server only; must **not** start with `NEXT_PUBLIC_`. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL`, `KV_REST_API_TOKEN`) | **Yes** (the token) | Reads the guide calls. Give Vercel the **read-only** token. |
| `NEXT_PUBLIC_NETWORK` | No | `mainnet` for the real site. |
| `NEXT_PUBLIC_CIRCLE_APP_ID`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | No (public by design; anyone can see them in the page) | Sign-in and wallet-connect ids. |

Anything starting with `NEXT_PUBLIC_` is sent to every visitor's browser. Never put a secret in a `NEXT_PUBLIC_` name.

**Other accounts with their own logins** (protect them with a strong password and two-factor sign-in): GitHub, Vercel,
Oracle Cloud, Circle console, Google AI Studio, Google Cloud (sign-in client), Upstash, WalletConnect (Reown), your domain
registrar.

---

## 8. If something looks wrong

Stay calm: **the arena never lets anyone take players' money directly**, not the owner and not the runner. The worst a
broken runner does is make rounds refund. The real danger is someone else holding the owner key or the runner key, who
could then decide close results (section 1); act fast on those.

**First steps, always**
1. Note the time and what you saw (a screenshot is fine, but nothing with a key or `.env` in it).
2. Do the health checks (section 3: service, which runner, log, gas).
3. Look at the arena and the relay feeds on https://explorer.arc.io: are there transactions you do not recognise?

**Common situations**

| What you see | What it probably is | What to do |
|---|---|---|
| Site shows no result for a round that ended | The runner is down, out of gas, or there was no usable Bitfinex/Chainlink price | Section 3. A round with calls on one side is settled (refunded) within a minute or two of its end. A round with calls on both sides settles within a minute or two if it has both prices; if nobody settles it within 1 hour, it becomes a refund and players claim their stake |
| Many rounds refund "no update" | No price pushes: runner down, out of gas, Chainlink stale, too few trades in the window, or a refused jump | Section 3 and the `price not sent` / `not trusting it` / `only ... trades` lines in section 2 |
| A pushed price looks far from the real price | Possible bug or misuse of the runner key | Compare with Bitfinex history and `data/price-log-mainnet.jsonl` (for BTC and ETH it is the median of the window, not one trade). If it is wrong: **stop the runner** (`sudo systemctl stop kairo-runner`) and follow "Runner key leaked" below |
| A pusher, owner or market alert you did not cause | The owner key is in someone else's hands | Section 2: pause the markets, take the pusher back, move ownership |
| Site is down or blank | Vercel build or setting | Vercel → Deployments: if the newest one failed, the old one is still live; if the live one is broken, roll back (section 5) |
| Site works but the agents' notes and guide calls are missing | Upstash setting or the runner's guide calls | Check the `GUIDE` lines in the log and the Upstash names on Vercel. No money is involved |
| Google sign-in fails | Circle key or ids on Vercel | Check the Vercel function logs for `[circle] ... failed` lines; check `CIRCLE_API_KEY` is the full live key |
| Runner wallet balance drops fast | Many one-sided rounds to settle (P2-12), or something else sending from it | Look at the runner address on the explorer. Settles of real rounds: top up and keep watching. Transactions that are not ours: stop the runner and treat the key as leaked |

**Pause a market** (stops new calls only; existing calls, settling and claims carry on). Only the owner can do it, from
the owner wallet (the hardware wallet once moved), on the explorer: the arena address → Contract → Write →
`setMarketPaused` with the market id and `true` (`false` opens it again). Market ids are in `deployments/arc-mainnet.json`
(0 = BTC/USD 5m, 1 = ETH/USD 5m, ...). Do this if a market itself is the problem (for example its price source is broken
for days), or at once on an alert you did not cause.

**Runner key leaked (or the server was lost or shared)**
1. Stop the runner: `sudo systemctl stop kairo-runner`.
2. On your PC, make a new runner wallet, and from the **owner** wallet call `setPusher(new address)` on each relay feed
   (the three USD relays, and the ratio relay once deployed; explorer → relay address → Contract → Write). Ask for help
   with this step; it is the only fix and it cuts off the old key at once. Each call sends a "pusher changed" alert: that
   one is you.
3. Move any USDC left in the old runner wallet to the new one (if you still can).
4. Make the server's `.env` again with the new key (`node scripts/make-server-env.mjs`), start the runner, and check the
   `checked: ... the runner is the pusher of each` line.
5. Also replace the Gemini key, the Upstash token and the Circle keys, and remove the GitHub deploy key, if the server
   itself was exposed.

What a leaked runner key can do: spend the runner's gas money, and push prices **inside the band around Chainlink**
(1% BTC, 1.5% ETH and SOL, 2.5% coin-vs-coin), which can decide close rounds. It **cannot** take money out of the arena or
change any rule.

**Owner key leaked**: this is the serious one. It can make any address the pusher at once and so decide the results of
every two-sided round from then on, and it can withdraw fees (not players' stakes directly). Pause every market, set the
pusher back to the runner on each relay, and move ownership with the two-step transfer (`transferOwnership` to a new safe
wallet, then `acceptOwnership` from it) as fast as possible (sections 1 and 2). Get help.

**When to ask for help:** anything involving the owner wallet, any transaction on the explorer you do not recognise, any
alert you did not cause, and any `STOP:` you cannot fix with the table in section 2.

---

## Known limits

Found in the audit (`docs/AUDIT_RATIO_PART2.md`) and not fixed yet, on purpose. None of them can take money from a player;
each one can cause refunds or wrong-looking text.

| Limit | What it means | When to fix |
|---|---|---|
| **P2-08. Guide calls are scored differently from real rounds.** | The mainnet runner scores the agents' free guide calls from the **testnet** price log (`data/price-log.jsonl`), and, where that has no entry, from Bitfinex's single first and last trade. Real rounds now use a 60 s / 90 s median for BTC and ETH and the trade about 60 s before the end. So an agent's guide call can show "won" on a round whose real result went the other way, and the agents' win rates on the site come from these scores. No money moves on guide calls. | Pass the mainnet price log (`MAINNET_PRICE_LOG_FILE`) to `createGuide` in `runner/run-mainnet.mjs`, and score from the chain (`RoundSettled`, or the relay's start and end) when a round had pushes. |
| **P2-09. A real move of more than 20% blocks a coin until the runner restarts.** | `jumpCheck` in `runner/exchangePrices.mjs` refuses a price more than 20% away from the last one it handed out, and the refused price never replaces it. After a genuine 20% move, every later price of that coin (and its coin-vs-coin market) is refused, so those rounds refund until `sudo systemctl restart kairo-runner`. The log says "not trusting it"; no phone alert. | Compare with Chainlink's latest answer instead of the last price, or accept the new level after a few agreeing quotes; alert the first time a price is refused. Until then: if the log shows "not trusting it" for a real move, restart the runner. |
| **P2-11. The site's start-price route can be used to get the site blocked by Bitfinex.** | `/api/start-price` asks Bitfinex for any lock time in the last 6 hours that a visitor sends. Many different lock values from one visitor can get the site's server rate-limited by Bitfinex for a minute at a time. Only the site's cross-check is affected (the start price the site shows comes from the chain); the runner uses its own IP. | Accept only real lock times of the last two rounds of a market, cache "not found yet" for a few seconds, and stop asking Bitfinex after about 20 requests a minute. |
| **P2-12. Anyone can make the runner pay for settles.** | A 0.50 USDC call on a round nobody else plays makes the mainnet runner settle it right after it ends (about 136k gas), and the caller gets the 0.50 back. Done on every market every round, it slowly drains the runner's gas; below 0.10 USDC the runner stops and **every** round refunds until it is topped up. The caller pays about as much gas as the runner. | Settle one-sided rounds early only above a real-money threshold (they refund on claim after the hour anyway), and alert when the runner's balance falls below 1 USDC. Until then: keep an eye on the runner's balance (section 3d). |
| **SOL keeps the single-trade price (owner decision, 25 Nov 2026).** | BTC and ETH start and end prices are now the median of a window of trades (P2-01). Bitfinex SOL/USD is too thin for an average: it has no trade at all in about 40% of minutes (measured over a day on 25 Nov 2026), so a window would refund most SOL rounds. So SOL, and the SOL side of SOL/BTC, keep a single trade: the start is the first trade at least 2 s after the lock, and the end is the last trade about 60 s before the end. A player can still nudge a SOL price with one trade of their own at those moments. The site says so next to the call buttons of every SOL market. **SOL vs BTC must not go live on mainnet until SOL has a better price source**: with one thin SOL trade on one side of the ratio and a 2.5% band, a single trade can decide those rounds. (SOL/USD itself is already live on mainnet with this rule.) | Add a second, deeper source for SOL (another exchange), take the median over both, give SOL a window like BTC and ETH, and only then deploy SOL vs BTC on mainnet (`docs/RATIO_MAINNET_CHECKLIST.md`). |
| **Rounds without calls on both sides show no start price on mainnet.** | The site now shows the start price that is on chain (P2-05). The mainnet runner pushes prices only for rounds with calls on both sides, so for any other round the chart says "Start price not on chain yet" for the whole round. That is true: such a round refunds without a price. | If wanted: say "No price: this round has calls on one side only" for those rounds. |
| **The contract-level findings of part 1.** | The pusher can still pick results inside the band (R-01: 2.5% on the coin-vs-coin relays), turn a round it would lose into a refund (R-03), and a push carries no observation time (R-05). These need a change to the relay or the arena, which are deployed and stay unchanged. | A new relay or a signed pull oracle, before the coin-vs-coin markets carry real money (`docs/RATIO_MAINNET_CHECKLIST.md`). |
