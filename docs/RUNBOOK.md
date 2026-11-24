# Runbook: mainnet keys, alerts, restarts

The step-by-step server setup is in `docs/MAINNET_AGENTS.md`. This page is the short list of what must stay true on mainnet and
what to do when an alert arrives. Background: `docs/AUDIT_RATIO_PART1.md` (R-01, R-02).

## 1. Keys: who holds what

| Key | Can do | Where it lives |
|---|---|---|
| **Owner** of the arena and of every relay (today the deployer wallet, `deployments/arc-mainnet.json` → `owner`) | `setPusher` on each relay (hand price control to any address, at once), `createMarket`, `setMarketPaused`, `withdrawFees`, move ownership | **Offline, or on a hardware wallet. Never on the server, never in the server's `.env`, never in a browser wallet used for anything else.** |
| Runner (`MAINNET_RUNNER_PRIVATE_KEY`) | push prices to the relays, settle rounds | the server's `.env` only (`chmod 600`), a few USDC for gas |

**Why the owner key matters this much.** The arena never lets the owner take player money, but the relay owner can make any
address the pusher in one transaction, and the pusher decides the results inside the band (2.5% on the coin-vs-coin
relays, against a typical 1-hour move of about 0.2%). Whoever holds the owner key can therefore take the matched stakes of
every two-sided round from the next round on. Treat it like the key to the pot.

**Move the owner to a hardware wallet** (do this before the coin-vs-coin markets go live; the contracts use two-step ownership,
so a typo cannot lose them):

1. From the current owner wallet: `transferOwnership(<hardware wallet address>)` on the arena and on each relay feed
   (the three USD relays, and the two ratio relays once deployed).
2. From the hardware wallet: `acceptOwnership()` on each of them. Until this step the old owner keeps every power.
3. Check that `owner()` on every contract reads the hardware wallet (on the explorer, or
   `cast call <contract> "owner()(address)" --rpc-url <Arc mainnet RPC>`). Note: `node scripts/deploy.mjs --set mainnet --verify-only`
   still expects the deployer wallet as the owner, so after the move it reports its owner lines as FAIL until that script
   learns the new owner.
4. Remove `MAINNET_DEPLOYER_PRIVATE_KEY` from `.env` on the PC. Later owner actions are signed on the hardware wallet
   (the deploy scripts that need the owner, such as a mainnet `createMarket`, must then send through it instead of a key in `.env`).

`renounceOwnership` is disabled on purpose: a contract without an owner could not pause a market or replace a broken pusher.

## 2. Alerts and what to do

All alerts go to the ntfy topic in `NTFY_TOPIC` (`.env` on the server). Without it, they are only in the log.

| Alert | From | Meaning | Do this |
|---|---|---|---|
| `Matchup MAINNET runner stopped` / `restarted` / `crash loop` | `runner/supervise.mjs` | the runner process ended | read the log (section 3); a crash loop waits 5 minutes between tries |
| **`Matchup: relay pusher changed`** | `runner/pusherWatch.mjs` (the runner, checked every minute) | a `PusherChanged` event on a relay: someone with the owner key changed who may push prices | **If you did not do it: the owner key is compromised.** At once, from the owner wallet if you still can: `setMarketPaused(id, true)` for every market on that relay, then `setPusher(<runner address>)`. Then move ownership to a new wallet (section 1). If you did it (a planned key change), check that the new address is the one you meant. |
| `Matchup: runner is not the pusher` | `runner/pusherWatch.mjs` | a relay's `pusher()` is another address (also caught if it changed while the runner was down) | the same as above; until it is fixed, this runner's pushes to that relay are refused and its rounds refund |

A pause only stops new calls. Calls already placed still settle (with whatever the pusher posts) or refund. So act on a
pusher alert before the next lock, not after the round.

## 3. Restart the runner

On the server (see `docs/MAINNET_AGENTS.md` for the full list):

```
sudo systemctl restart kairo-runner
journalctl -u kairo-runner -n 50 --no-pager
```

Look for `checked: Arc mainnet, <n> markets, <m> relay feeds, the runner is the pusher of each`. If the runner is not the
pusher of a relay it stops at start with a plain message (it never pushes to a relay it does not control). A line
`WARNING: no NTFY_TOPIC in .env` means pusher alerts only go to the log: add the topic and restart.

After updating the code: `git pull`, `npm ci --no-audit --no-fund`, then the restart above.
