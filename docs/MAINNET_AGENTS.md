# Running the Kairo runner on a server (Oracle Cloud free VM)

The runner pushes prices, settles rounds and plays the house agents. It must run all day, so it lives on a small server, not on your PC.

**The server:** Oracle Cloud Always Free VM, Ubuntu 24.04, user `ubuntu`, x86_64, 1 GB RAM. No inbound ports are needed: the runner only makes outbound requests (Arc RPC, Bitfinex, Gemini, Circle, Upstash, ntfy). Your SSH login is the only way in.

**What is where**

| What | Where |
|---|---|
| Repo | `/home/ubuntu/arc-arena` (branch `matched-calls` until it is merged into `main`) |
| Settings and keys | `/home/ubuntu/arc-arena/.env`, owner `ubuntu`, `chmod 600`. Never in git, never in chat |
| Service | `kairo-runner` (systemd), enabled on boot. File in the repo: `deploy/kairo-runner.service` |
| Logs | `journalctl -u kairo-runner` |
| Runner data (price log, AI log, agent notes) | `/home/ubuntu/arc-arena/data/` |
| Setup script | `deploy/setup-runner.sh`. Safe to run again |

**What the setup does:** 2 GB swap (the first start compiles the contracts in memory and 1 GB is not enough), Node 22 LTS (from nodejs.org, checked against its SHA-256 list), `npm ci`, a journal that survives reboots (max 200 MB), checks on `.env` that print names only, and the service. Nothing in these files is secret.

**Status, said plainly.** Today this runs the **testnet** runner (`runner/supervise.mjs` starts `runner/run.mjs --live`, which refuses any network but Arc testnet). The mainnet runner is built but not deployed or started (see "Mainnet" at the end); the mainnet house agents are not built yet.

**Only one runner at a time.** Two runners would push prices and place bets twice. Stop the one on your PC before you start the server's.

## One-time setup, in order

Each step is small. Run them one at a time and stop if one fails. Replace `<SERVER_IP>` with the VM's public IP and `<KEY>` with your SSH key file.

**Before you start, on your PC:** the code on GitHub must be current. Ask Claude to push, then continue.

**1. Log in** (PowerShell on your PC)
```
ssh -i <KEY> ubuntu@<SERVER_IP>
```

**2. Update the list of packages and install git** (on the server)
```
sudo apt-get update
sudo apt-get install -y git
```

**3. Make a read-only key so the server can download the private repo** (on the server)
```
ssh-keygen -t ed25519 -C "kairo-runner deploy key" -f ~/.ssh/kairo_deploy -N ""
cat ~/.ssh/kairo_deploy.pub
```
Copy the one line that `cat` prints (it is the public half, safe to copy). On GitHub: the repo `Ffrank-Michael/kairo-markets` → Settings → Deploy keys → Add deploy key. Title `oracle runner`, paste the line, leave "Allow write access" **unticked**, Add key.

**4. Tell ssh to use that key for GitHub** (on the server)
```
printf 'Host github.com\n  IdentityFile ~/.ssh/kairo_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
chmod 600 ~/.ssh/config
ssh -T git@github.com
```
The last command asks "Are you sure you want to continue connecting?". Compare the fingerprint it shows with GitHub's published one (search "GitHub SSH key fingerprints"), then type `yes`. You should see "Hi Ffrank-Michael/kairo-markets! You've successfully authenticated".

**5. Download the repo** (on the server)
```
git clone --branch matched-calls git@github.com:Ffrank-Michael/kairo-markets.git /home/ubuntu/arc-arena
```

**6. Copy your settings file from your PC** (PowerShell on your PC, not on the server)
```
scp -i <KEY> C:\Users\Frank\Desktop\arc-arena\.env ubuntu@<SERVER_IP>:/home/ubuntu/arc-arena/.env
```
The file travels over SSH and never touches chat.

**7. Lock it down and keep the deployer key off the server** (on the server)
```
chmod 600 /home/ubuntu/arc-arena/.env
sed -i '/^[[:space:]]*MAINNET_DEPLOYER_PRIVATE_KEY[[:space:]]*=/d' /home/ubuntu/arc-arena/.env
ls -l /home/ubuntu/arc-arena/.env
```
The listing must start with `-rw-------` and say `ubuntu ubuntu`. The `sed` line removes the mainnet deployer key if your file has one: the runner never reads it, so it should not sit on a server.

**8. Run the setup script** (on the server; a few minutes, the `npm ci` part is slow on 1 GB)
```
cd /home/ubuntu/arc-arena
sudo bash deploy/setup-runner.sh
```
It ends with `READY` when `.env` is complete. If it prints a WARNING about a missing name, fix `.env` and run the script again.

**9. Dry run: reads the chain, sends nothing** (on the server; the first run compiles the contracts and may take a minute)
```
cd /home/ubuntu/arc-arena
node runner/run.mjs --once
```
You should see "DRY RUN: nothing will be sent" and lines starting with `WOULD`. Check `free -h` afterwards if you like: swap in use is normal here.

**10. Stop the runner on your PC, then start the service** (on the server)
```
sudo systemctl start kairo-runner
sudo systemctl status kairo-runner --no-pager
journalctl -u kairo-runner -f
```
`-f` follows the log live; press Ctrl+C to leave it (the service keeps running). In the first minutes you should see `runner started`, price pushes, and `AI BTC/USD 5m: 3 decisions`.

**11. Prove it survives a reboot** (on the server)
```
sudo reboot
```
Wait a minute, log in again, then:
```
systemctl is-active kairo-runner
journalctl -u kairo-runner -n 20 --no-pager
```
It must say `active`.

## Every day

| I want to | Command (on the server) |
|---|---|
| See if it runs | `systemctl status kairo-runner --no-pager` |
| Watch the log live | `journalctl -u kairo-runner -f` |
| Last 100 lines | `journalctl -u kairo-runner -n 100 --no-pager` |
| Last hour only | `journalctl -u kairo-runner --since "1 hour ago" --no-pager` |
| Only problems | `journalctl -u kairo-runner -p warning --no-pager` (the runner prints plain lines, so also try `... \| grep -i failed`) |
| Stop / start / restart | `sudo systemctl stop kairo-runner`, `... start ...`, `... restart ...` |
| Memory and swap | `free -h` |
| Disk space | `df -h /` |

**Update the code** (after something new is pushed):
```
cd /home/ubuntu/arc-arena
git pull
npm ci --no-audit --no-fund
sudo systemctl restart kairo-runner
```
(`npm ci` only matters when `package-lock.json` changed; it is safe either way.)

**Change a setting:** edit `/home/ubuntu/arc-arena/.env` (`nano`), keep it `chmod 600`, then `sudo systemctl restart kairo-runner`. Values go in without quotes.

**If the service will not start:** `systemctl status kairo-runner --no-pager` and `journalctl -u kairo-runner -n 50 --no-pager` say why. After 5 failed starts in 10 minutes systemd stops trying; fix the cause, then `sudo systemctl reset-failed kairo-runner` and start it again.

## Safety

- **Secrets live only in `.env`** (on your PC and on the server). No file in the repo has one, including `deploy/`.
- **No inbound ports.** Leave the Oracle network rules at SSH (port 22) only; the runner needs nothing else. Log in with your SSH key, never a password.
- **The deploy key is read-only.** It can download the repo and nothing else.
- **If the server is ever lost or shared:** treat every key in its `.env` as leaked: replace the runner key and the Gemini, Circle and Upstash keys, and remove the deploy key on GitHub.
- **Idle machines:** Oracle's Always Free terms say a VM that sits very idle for a long time can be reclaimed. A runner uses little CPU. Check Oracle's current policy; the ntfy alert (`NTFY_TOPIC`) and a look at `systemctl status` every day or two will tell you if it vanished.
- **The VM is a single point of failure.** If it is down, no prices are pushed and rounds refund. That is the contract working as designed, not a loss of funds.

## Mainnet

### The mainnet runner (`runner/run-mainnet.mjs`): built, never run against mainnet yet

It pushes prices and settles rounds on Arc mainnet (chain 5042) and nothing else. It does **not** place bets: the mainnet house agents are not built yet.

**What it reads from `.env`** (these names only; every other line is ignored, so it never holds another key):

| Name | What |
|---|---|
| `MAINNET_RUNNER_PRIVATE_KEY` | the runner's own wallet, with a little USDC for gas. Never the deployer, the owner, or a wallet people play with |
| `MAINNET_ARENA_ADDRESS` | the mainnet PredictionArena contract |
| `ARC_MAINNET_RPC_URL` | optional, if the default RPC is not enough |

**How it stays safe**

- **Dry run is the default.** Without `--i-understand-this-spends-real-usdc` it only logs `WOULD:` lines, and the wallet client is not even created. `--live` (the testnet flag) is refused.
- **Before it starts** it checks that the RPC is chain 5042, that a contract exists at the arena address, that the runner is not the arena owner, and that the runner is the `pusher` of every relay feed. Any problem stops it with a plain message.
- **No gas on rounds without two sides.** A round with no calls, or calls on one side only, gets no price push and no settle. (Those rounds refund anyway; callers claim the refund once the 1-hour settle window has passed, because nobody settles them.) A price push serves every market of its coin, so it is skipped only when no market of that coin has a two-sided round running.
- **Price checks as on testnet.** Bitfinex's last trade, 20% jump check, stale-market check and clock check, as before. On top of that, each price is compared with Chainlink off chain using the relay's own rule (same band, Chainlink not older than 26 hours), and a price outside it is not sent, so it never costs a failed transaction. The relay checks again on chain.
- **Low balance.** A live runner stops when its wallet holds less than 0.10 USDC. The supervisor then alerts you (below).
- Every pushed price is written to `data/price-log-mainnet.jsonl`, not to the testnet log.

**How to run it** (from the repo folder)

```
node runner/run-mainnet.mjs --once                                       # dry run, one look
node runner/run-mainnet.mjs                                              # dry run, keeps looking
node runner/run-mainnet.mjs --i-understand-this-spends-real-usdc         # LIVE: spends real USDC
```

**Supervised, with the same ntfy alerts as the testnet runner:**

```
node runner/supervise.mjs --mainnet                                      # supervises a dry-run runner
node runner/supervise.mjs --mainnet --i-understand-this-spends-real-usdc # supervises a live runner
```

The log goes to `data/runner-mainnet.log`; alert titles say "MAINNET". The `kairo-runner` service file still starts the testnet runner; change its `ExecStart` only when you decide to go live.

**Known mismatch to settle before the deploy:** `scripts/deploy.mjs` still sets the relay pusher from `RUNNER_PRIVATE_KEY`, while the mainnet runner reads `MAINNET_RUNNER_PRIVATE_KEY`. They must be the same wallet, or the runner's pushes are refused (the startup check catches this and stops).

### Still to build

The mainnet house agents (four new keys, written into `.env` by a script that never prints them; see `docs/SUBMISSION.md`). `MAINNET_DEPLOYER_PRIVATE_KEY` never goes on the server (step 7 removes it). When the agents exist, this file gets their exact steps.
