#!/usr/bin/env bash
# Kairo Markets: sets up the round runner on an Oracle Cloud free VM.
#   Ubuntu 24.04, user "ubuntu", x86_64, 1 GB RAM, no inbound ports (only outbound internet and your SSH login).
#   Repo in /home/ubuntu/arc-arena, settings in /home/ubuntu/arc-arena/.env (chmod 600).
#
# Run it from the repo, once, as root through sudo (it can be run again any time; every step checks first):
#   cd /home/ubuntu/arc-arena && sudo bash deploy/setup-runner.sh
#
# It does, in order: 2 GB swap, Node 22 LTS, the project's npm packages, journal that survives a reboot,
# checks on .env (names only, it never prints a value), and the systemd service (enabled on boot, NOT started).
# There are no secrets in this file. The keys live only in .env.
set -euo pipefail

APP_USER=ubuntu
APP_DIR=/home/ubuntu/arc-arena
NODE_MAJOR=22
SWAP_FILE=/swapfile
SWAP_GB=2

say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ok: %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*"; }
die()  { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }

# ---- 0. Checks before anything changes ----
[ "$(id -u)" -eq 0 ] || die "run it with sudo:  sudo bash deploy/setup-runner.sh"
[ "$(uname -m)" = "x86_64" ] || die "this script is for x86_64; this machine is $(uname -m)."
id "$APP_USER" >/dev/null 2>&1 || die "there is no user '$APP_USER' on this machine."
[ -f "$APP_DIR/package.json" ] && [ -d "$APP_DIR/runner" ] || die "the repo is not in $APP_DIR (clone it there first)."
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] && [ "${VERSION_ID:-}" = "24.04" ] || warn "made for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}; carrying on."

# ---- 1. Swap: 1 GB of RAM is not enough for the first start (the contracts are compiled in memory) ----
say "1/6  Swap (${SWAP_GB} GB)"
have_kb=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
if [ "$have_kb" -ge $((SWAP_GB * 1024 * 1024 - 65536)) ]; then
  ok "swap is already ${have_kb} kB, nothing to do"
else
  if [ -f "$SWAP_FILE" ]; then swapoff "$SWAP_FILE" 2>/dev/null || true; rm -f "$SWAP_FILE"; fi
  fallocate -l "${SWAP_GB}G" "$SWAP_FILE" || dd if=/dev/zero of="$SWAP_FILE" bs=1M count=$((SWAP_GB * 1024)) status=none
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE" >/dev/null
  swapon "$SWAP_FILE"
  grep -qs "^$SWAP_FILE " /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
  ok "created $SWAP_FILE (${SWAP_GB} GB) and added it to /etc/fstab, so it comes back after a reboot"
fi
# Use swap only when RAM is nearly full.
printf 'vm.swappiness=20\n' > /etc/sysctl.d/99-kairo.conf
sysctl -q --system >/dev/null || true

# ---- 2. Small tools ----
say "2/6  Tools (curl, xz, git)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl xz-utils git >/dev/null
ok "installed"

# ---- 3. Node 22 LTS, from nodejs.org, checked against its published SHA-256 list ----
say "3/6  Node ${NODE_MAJOR} LTS"
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" = "$NODE_MAJOR" ]; then
  ok "already installed: node $(node -v)"
else
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  line=$(grep -E ' node-v[0-9.]+-linux-x64\.tar\.xz$' "$tmp/SHASUMS256.txt" | head -n1)
  [ -n "$line" ] || die "could not find the Linux x64 download in the Node ${NODE_MAJOR} list."
  file=${line##* }
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && echo "$line" | sha256sum -c - >/dev/null) || die "the Node download does not match its SHA-256. Nothing was installed."
  tar -xJf "$tmp/$file" -C /usr/local --strip-components=1 --no-same-owner
  ok "installed $file; node $(node -v), npm $(npm -v)"
fi

# ---- 4. The project's packages (as the ubuntu user, from package-lock.json) ----
say "4/6  npm packages (a few minutes on a small machine)"
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund --loglevel=error"
sudo -u "$APP_USER" -H mkdir -p "$APP_DIR/data"
ok "npm ci finished; $APP_DIR/data exists"

# ---- 5. The journal (logs) survives a reboot and stays small ----
say "5/6  Logs (journalctl)"
mkdir -p /var/log/journal /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/kairo.conf
systemctl restart systemd-journald
ok "persistent journal, at most 200 MB"

# ---- 6. .env checks and the service ----
say "6/6  Settings file and service"
ENV_FILE="$APP_DIR/.env"
env_ok=1
if [ ! -f "$ENV_FILE" ]; then
  warn "$ENV_FILE does not exist yet. Copy it from your PC (see docs/MAINNET_AGENTS.md, step 8), then run this script again."
  env_ok=0
else
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok ".env is owned by $APP_USER with permissions $(stat -c %a "$ENV_FILE")"
  has() { grep -Eq "^[[:space:]]*$1[[:space:]]*=[[:space:]]*[^[:space:]]" "$ENV_FILE"; }   # name only; the value is never printed
  for name in CIRCLE_API_KEY CIRCLE_ENTITY_SECRET; do
    if has "$name"; then ok "$name is set"; else warn "$name is missing in .env"; env_ok=0; fi
  done
  if has DEPLOYER_PRIVATE_KEY || has RUNNER_PRIVATE_KEY; then ok "a runner key is set"; else warn "neither DEPLOYER_PRIVATE_KEY nor RUNNER_PRIVATE_KEY is set in .env"; env_ok=0; fi
  for name in GEMINI_API_KEY UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN NTFY_TOPIC; do
    if has "$name"; then ok "$name is set"; else warn "$name is not set (the runner still works; see docs/MAINNET_AGENTS.md)"; fi
  done
fi

install -m 644 "$APP_DIR/deploy/kairo-runner.service" /etc/systemd/system/kairo-runner.service
systemctl daemon-reload
systemctl enable kairo-runner >/dev/null 2>&1
ok "service kairo-runner installed and enabled on boot (not started yet)"

echo
if [ "$env_ok" -eq 1 ]; then
  echo "READY. Next: a dry run (sends nothing), then start the service. See docs/MAINNET_AGENTS.md, steps 9 and 10."
else
  echo "Installed, but .env is not complete. Fix the warnings above, then run this script again."
fi
