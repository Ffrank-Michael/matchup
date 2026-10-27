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

**Status, said plainly.** Today this runs the **testnet** runner (`runner/supervise.mjs` starts `runner/run.mjs --live`, which refuses any network but Arc testnet). The mainnet runner and mainnet house agents are not built yet; see "Mainnet" at the end.

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

What the code already enforces: on mainnet the runner signs only with `RUNNER_PRIVATE_KEY`, its own wallet, never the deployer key (`scripts/runnerKey.mjs`), and the deploy script sets that wallet's address as the relay pusher. So on the server:

- `.env` gets `RUNNER_PRIVATE_KEY` (a new wallet with a little USDC for gas) and, if the RPC needs it, `ARC_MAINNET_RPC_URL`.
- `MAINNET_DEPLOYER_PRIVATE_KEY` never goes on the server (step 7 removes it).
- The same service, the same commands.

What does **not** exist yet: a runner mode for mainnet (`runner/run.mjs` is testnet only) and the mainnet house agents (four new keys, written into `.env` by a script that never prints them; see `docs/SUBMISSION.md`). When they are built, this file gets a section with their exact steps. Until then the service on the server is the testnet runner.
