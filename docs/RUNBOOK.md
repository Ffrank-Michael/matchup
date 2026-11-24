# Matchup runbook (for the operator)

This is the page to open when you need to look after Matchup: check the runner, restart it, update it, redeploy the site,
read an alert, top up gas, or handle something that looks wrong. It is written for someone who is not a programmer.
Every command is copy-and-paste. Nothing in this file is secret, and no secret should ever be added to it.

**The three pieces**

| Piece | What it does | Where it runs |
|---|---|---|
| **The runner** | Pushes BTC/ETH/SOL prices to the relay feeds and settles rounds on Arc mainnet. Also makes the four agents' *guide calls* (free, no money, nothing on chain). | The Oracle Cloud VM (Ubuntu, user `ubuntu`), repo in `/home/ubuntu/arc-arena`, service `kairo-runner` |
| **The website** | https://www.playmatchup.xyz. People connect a wallet (or Google) and make calls with their own USDC. | Vercel, built from the GitHub repo (`web/` folder) |
| **The contracts** | The arena (holds the money) and three relay feeds. Addresses are in `deployments/arc-mainnet.json`. | Arc mainnet (chain 5042). Nobody can change them. |

**Public addresses you will need** (from `deployments/arc-mainnet.json`, safe to share)

| What | Address |
|---|---|
| Runner wallet (the relay "pusher", pays gas) | `0x141043c9f604c8274286Dc0319a2F1c9124CEa3F` |
| Arena (PredictionArena v2) | `0xaebac196c76a2c9338a30aef663e4799ffa0d364` |
| BTC relay feed | `0x15dbb61c92fd8c301a19b769d984491731afab60` |
| ETH relay feed | `0xdbb8d2106f1e45aa5287b666a4c8841bead356c0` |
| SOL relay feed | `0x5f6952050147e922c7aa1264896aa62bafbc5462` |
| Explorer | https://explorer.arc.io (paste any address above into the search box) |

**Good to know before anything else**

- **The money is safe even if the runner dies.** If no prices are pushed or nobody settles, rounds are refunded by the
  contract and people claim their stake back. A dead runner means "no results for a while", never "money lost".
- **The runner only spends gas.** It never places calls with money. The house agents on mainnet have no wallets; their
  calls are "guide calls" (labelled "Guide call, no money" on the site).
- **The runner only works on rounds with real players.** A round with nobody in it gets no price push and no settle, so a
  quiet log on a quiet day is normal.
- **Only one runner at a time.** Never run the mainnet runner on your PC while the server runs it.

---

## 1. Log in to the server

From PowerShell on your PC (`<KEY>` is your SSH key file, `<SERVER_IP>` the VM's public IP):

```
ssh -i <KEY> ubuntu@<SERVER_IP>
```

All the commands below in sections 2–5 are typed **on the server** unless it says "on your PC".

---

## 2. Is the runner healthy?

Run these four checks. All four should look right.

**a. Is the service running?**
```
systemctl status kairo-runner --no-pager
```
Good: `Active: active (running)`. Bad: `failed`, `inactive` or `activating (auto-restart)` (see section 3).

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
and one `GUIDE Gemini requests: ...` line an hour. See section 7 for what each kind of line means.

**d. Does the runner wallet have gas?** (works on the server and on your PC; it reads a public address only)
```
node -e "fetch('https://rpc.mainnet.arc.io',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBalance',params:['0x141043c9f604c8274286Dc0319a2F1c9124CEa3F','latest']})}).then(r=>r.json()).then(j=>console.log((Number(BigInt(j.result))/1e18).toFixed(4),'USDC'))"
```
It prints something like `2.9372 USDC`. Keep it **above 1 USDC** (section 6). Below **0.10 USDC** the runner stops itself.

**Also worth a look now and then**

| Check | Command | Good |
|---|---|---|
| Memory | `free -h` | some swap in use is normal |
| Disk | `df -h /` | under 80% used |
| Price log is growing | `tail -3 /home/ubuntu/arc-arena/data/price-log-mainnet.jsonl` | recent times (only when people played) |
| Last push on chain | open the BTC relay on the explorer, tab "Transactions" | matches the last round people played |

---

## 3. Restart the runner

```
sudo systemctl restart kairo-runner
systemctl status kairo-runner --no-pager
journalctl -u kairo-runner -f
```
`-f` follows the log live. Press **Ctrl+C** to leave it (the runner keeps running).

| I want to | Command |
|---|---|
| Stop it | `sudo systemctl stop kairo-runner` |
| Start it | `sudo systemctl start kairo-runner` |
| It says `failed` and will not start | Fix the cause first (read `journalctl -u kairo-runner -n 50 --no-pager`), then `sudo systemctl reset-failed kairo-runner` and start it |
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
- `git pull` updates the branch the server is on (`git branch --show-current` shows which: it should be the branch the
  site runs from, `matched-calls` until it is merged into `main`).
- `npm ci` is slow on the 1 GB VM (a few minutes). It is only needed when `package-lock.json` changed, but it is always safe.
- Watch the log for a minute after the restart: you want the `checked: Arc mainnet ...` line and no `STOP:`.

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
players costs about 0.01 USDC in all (two pushes and a settle). A round with nobody in it costs nothing. A busy day with
someone playing every 5-minute round of one coin is about 3 USDC; most days are far less.

**Check it:** command 2d above, or paste the runner address into https://explorer.arc.io.

**Top it up** (from your own wallet, on your phone or PC):
1. Open your wallet and pick the **Arc mainnet** network.
2. Send USDC to the runner address `0x141043c9f604c8274286Dc0319a2F1c9124CEa3F`. Copy the address from
   `deployments/arc-mainnet.json` (field `pusher`) or from this page; check the first and last 4 characters after pasting.
3. Send a small amount first (for example 1 USDC) and check that it arrived (command 2d), then send the rest.
4. Keep **2–5 USDC** in it. Do not keep much more: it is a hot wallet on a server.

**Only on Arc mainnet.** USDC sent on another network (Ethereum, Base, and so on) to this address does not arrive on Arc.

If it ran out and the runner stopped (alert "stopped" with a balance message in the log), top it up; the supervisor
restarts the runner by itself within 15 seconds to 5 minutes. To restart at once: `sudo systemctl restart kairo-runner`.

---

## 7. What each alert and log line means

**Phone alerts** come from ntfy.sh (the topic name is `NTFY_TOPIC` in the server's `.env`; subscribe to it in the ntfy
app). If you get no alerts at all, the topic is not set: the log then says `alerts OFF: add NTFY_TOPIC to .env`.

| Alert title | What it means | What to do |
|---|---|---|
| **Matchup MAINNET runner stopped** | The mainnet runner exited. The supervisor starts it again in 15 s. | Usually nothing. If it keeps coming, read the log (section 2c) for the line just before it. |
| **Matchup MAINNET runner restarted** | It is running again. | Nothing. |
| **Matchup MAINNET runner crash loop** | It stopped 5 times in 10 minutes. It now waits 5 minutes between tries. | Read the log now. Most common causes: wallet out of gas, a wrong setting in `.env`, the RPC is down. |
| **Matchup runner stopped / restarted / crash loop** (no "MAINNET") | The same, for the **testnet** runner. | Same steps; testnet money is not real. |

The supervisor itself is restarted by systemd if it dies. There is **no** alert if the whole VM is down (then nothing can
send one): that is why section 2 is worth doing every day or two.

**Lines in the log** (`journalctl -u kairo-runner`)

| Line starts with | Meaning | Worry? |
|---|---|---|
| `*** LIVE MODE on Arc MAINNET` | The live mainnet runner started. | No |
| `--- DRY RUN on Arc mainnet` | A dry run started: it sends **nothing**. If you meant to be live, see section 3. | Only if you meant live |
| `checked: Arc mainnet, 12 markets, 3 relay feeds ...` | The start-up checks passed. | No |
| `DONE:` | A price push or a settle went through. A `tx` line follows with its hash. | No |
| `WOULD:` | Dry run: what it would have sent. | No |
| `WAITING:` | A start price is waiting for the first Bitfinex trade after the lock. Normal for a few seconds. | Only if the same round waits for minutes |
| `FAILED:` | A push or settle failed. It tries again by itself (5 s for a price, 15 s up to 4 min for a settle). | Once: no. The same round again and again: yes, read the reason on the next line |
| `price not sent: ... away from Chainlink` | Bitfinex and Chainlink disagree by more than the relay allows, so the price was not sent (no gas spent). | Rare and short: no. For long: Bitfinex or Chainlink has a problem; affected rounds refund |
| `price not sent: Chainlink's last update is too old` | Chainlink has not updated for over 26 hours. No prices can be pushed for that coin. | Yes, but nothing to fix on our side; rounds refund |
| `tick error:` | One pass went wrong (often the RPC or Bitfinex did not answer). The next pass tries again. | Only if it repeats for many minutes |
| `slow pass: ... s` | A pass took more than 4 seconds. | Only if it is constant |
| `GUIDE ...` / `GUIDE problem` | The free guide calls (Gemini). These never stop prices or settles. | No for money. A `429` means a model hit its free daily limit; it comes back by itself |
| `STOPPING: the runner wallet holds ... below the 0.10 ...` | Out of gas. It stops until topped up. | **Yes:** top up (section 6) |
| `STOP: ...` | A start-up check failed and it will not run. The message says what to fix. | **Yes:** see below |

**`STOP:` messages and the fix**

| Message | Fix |
|---|---|
| `No .env file` | The settings file is missing on the server. Copy it again from your PC (section 8). |
| `MAINNET_RUNNER_PRIVATE_KEY is missing` / `is not 0x + 64 hex characters` | The runner key line in `.env` is missing or damaged. Fix it with `nano /home/ubuntu/arc-arena/.env` (no quotes, no spaces). |
| `MAINNET_ARENA_ADDRESS is missing` / `is not an address` | Put the arena address (table at the top) in `.env`. |
| `cannot reach the RPC` / wrong chain | The Arc RPC is down or `ARC_MAINNET_RPC_URL` points at the wrong network. Remove that line to use the default. |
| `the runner is not the pusher of feed ...` | The runner key in `.env` is not the wallet the relays accept. You have the wrong key in `.env`. Do **not** change the relays; put the right key back. |
| `the runner wallet is also the arena owner` | `.env` holds the owner/deployer key as the runner key. Replace it with the runner key at once, and remove the owner key from the server. |
| `--live is the testnet runner's flag` | Someone started the mainnet runner with the testnet flag. Use the long flag (section 3). |

---

## 8. Where each secret lives (names only)

Values never go in chat, in git, in this file, or in a screenshot. `.env` files are ignored by git.

**On the server: `/home/ubuntu/arc-arena/.env`** (must be `-rw-------` owned by `ubuntu`: check with `ls -l /home/ubuntu/arc-arena/.env`)

| Name | Secret? | What it is |
|---|---|---|
| `MAINNET_RUNNER_PRIVATE_KEY` | **Yes** | The runner wallet's key. Controls its gas money. |
| `MAINNET_ARENA_ADDRESS` | No | The arena address. |
| `ARC_MAINNET_RPC_URL` | Maybe (paid RPCs put a key in the URL) | Optional; the default is the public Arc RPC. |
| `GEMINI_API_KEY` | **Yes** | Google AI key for the guide calls. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | **Yes** (the token) | Where the runner saves the guide calls for the site (write token). |
| `NTFY_TOPIC` | Semi (anyone who knows it can read the alerts) | The phone-alert topic. |
| `DEPLOYER_PRIVATE_KEY`, `RUNNER_PRIVATE_KEY`, `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | **Yes** | Testnet runner and testnet agent wallets only (test money). |

Also on the server: `~/.ssh/kairo_deploy` (the read-only GitHub deploy key; it can download the repo and nothing else).

**Never on the server: `MAINNET_DEPLOYER_PRIVATE_KEY`.** It owns the contracts (create markets, pause, withdraw fees,
change the relay pusher). It lives only in `.env` on your PC and in your private backup. If you ever find it on the server,
delete that line (`nano`, then restart the runner).

**On your PC: `C:\Users\Frank\Desktop\arc-arena\.env`**: everything above plus `MAINNET_DEPLOYER_PRIVATE_KEY` and
`FINAL_OWNER_ADDRESS` (an address, not secret). **`web\.env.local`**: the site's settings for local testing (same names as on
Vercel, below).

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

## 9. If something looks wrong

Stay calm: **the contracts protect the money by themselves.** The owner (you) cannot take players' money, and nor can the
runner. The worst a broken runner does is make rounds refund.

**First steps, always**
1. Note the time and what you saw (a screenshot is fine, but nothing with a key or `.env` in it).
2. Do section 2 (service, which runner, log, gas).
3. Look at the arena and the relay feeds on https://explorer.arc.io: are there transactions you do not recognise?

**Common situations**

| What you see | What it probably is | What to do |
|---|---|---|
| Site shows no result for a round that ended | The runner is down, out of gas, or there was no Bitfinex/Chainlink price | Section 2. If the runner is fine and the round had players on both sides, it settles within a minute or two; if nobody settles within 1 hour, it becomes a refund and players claim their stake |
| Many rounds refund "no update" | No price pushes: runner down, out of gas, or Chainlink stale | Section 2 and the `price not sent` lines in section 7 |
| A pushed price looks far from the real price | Possible bug or misuse of the runner key | Compare with Bitfinex history and `data/price-log-mainnet.jsonl`. If it is wrong: **stop the runner** (`sudo systemctl stop kairo-runner`) and follow "Runner key leaked" below |
| Site is down or blank | Vercel build or setting | Vercel → Deployments: if the newest one failed, the old one is still live; if the live one is broken, roll back (section 5) |
| Site works but the agents' notes and guide calls are missing | Upstash setting or the runner's guide calls | Check the `GUIDE` lines in the log and the Upstash names on Vercel. No money is involved |
| Google sign-in fails | Circle key or ids on Vercel | Check the Vercel function logs for `[circle] ... failed` lines; check `CIRCLE_API_KEY` is the full live key |
| Runner wallet balance drops fast with no players | Something is sending transactions from it | Stop the runner, look at the runner address on the explorer. If the transactions are not ours, treat the key as leaked |

**Pause a market** (stops new calls only; existing calls, settling and claims carry on). Only the owner can do it, from
the owner wallet, on the explorer: the arena address → Contract → Write → `setMarketPaused` with the market id and `true`
(`false` opens it again). Market ids are in `deployments/arc-mainnet.json` (0 = BTC/USD 5m, 1 = ETH/USD 5m, ...). Do this only if a market itself is the problem (for example its price source is broken for days).

**Runner key leaked (or the server was lost or shared)**
1. Stop the runner: `sudo systemctl stop kairo-runner`.
2. On your PC, make a new runner wallet, and from the **owner** wallet call `setPusher(new address)` on each of the three
   relay feeds (explorer → relay address → Contract → Write). Ask for help with this step; it is the only fix and it
   cuts off the old key at once.
3. Move any USDC left in the old runner wallet to the new one (if you still can).
4. Put the new key in the server's `.env`, start the runner, and check the `checked: ... the runner is the pusher of each` line.
5. Also replace the Gemini key, the Upstash token and the Circle keys, and remove the GitHub deploy key, if the server itself was exposed.

What a leaked runner key can do: spend the runner's gas money, and push prices **inside the band around Chainlink**
(1% BTC, 1.5% ETH and SOL), which can decide close rounds. It **cannot** take money out of the arena or change any rule.

**Owner key leaked**: this is the serious one (it can change the relay pusher and withdraw fees, though not players'
money). Use the two-step ownership transfer (`transferOwnership` to a new safe wallet, then `acceptOwnership` from it)
as fast as possible, and get help.

**When to ask for help:** anything involving the owner wallet, any transaction on the explorer you do not recognise, and
any `STOP:` you cannot fix with the table in section 7.
