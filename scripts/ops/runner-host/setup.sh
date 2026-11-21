#!/bin/bash
# setup.sh: makes a clean Ubuntu or Debian VPS the factory's self-hosted Actions runner. Run it as root through
# host.sh setup <ip>, which runs survey.sh first and hands this script the repository as owner/name on argv and a fresh
# registration token on stdin, never on argv.
# Every step checks before it acts, so a second run changes nothing.
set -euo pipefail

[[ "${1:-}" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { echo "setup.sh: give the repository as owner/name" >&2; exit 2; }
REPO_URL=https://github.com/$1
LABELS=playground
BUN_VERSION=1.4.4
UV_VERSION=0.13.8
RUNNER_VERSION=2.338.2
HOME_DIR=/home/runner
# sized from the host itself: a runner per 2 cores and 6 GB, so 4 cores and 16 GB run two PRs' gates at once (dispatcher, 18 Oct)
CORES=$(nproc)
RAM_GB=$(awk '/^MemTotal:/ {print int($2 / 1048576)}' /proc/meminfo)
RUNNERS=$((CORES / 2 < RAM_GB / 6 ? CORES / 2 : RAM_GB / 6))
[ "$RUNNERS" -ge 1 ] || RUNNERS=1
SWAP=$([ "$RAM_GB" -ge 8 ] && echo 2G || echo 4G)

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { say "setup.sh: $*" >&2; exit 1; }
# fetch <url> <sha256> <file>: downloads url to file, and stops the script, removing the file, unless its sha256 is the pinned one
fetch() {
  curl -fsSL -o "$3" "$1" || die "could not download $1"
  local sum
  sum=$(sha256sum "$3" | cut -d' ' -f1)
  [ "$sum" = "$2" ] || { rm -f "$3"; die "$1 has sha256 $sum, not the pinned $2"; }
}

[ "$(id -u)" = 0 ] || die "run it as root"
# each download's sha256, from the release's own published sums
case "$(uname -m)" in
  x86_64)
    ARCH=x64 BUN_ASSET=bun-linux-x64 UV_ASSET=uv-x86_64-unknown-linux-gnu
    BUN_SHA256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
    UV_SHA256=5acfd9177cfecf0bf87578f059728215ccc884388988f55f7a65041b57387d91
    RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
    ;;
  aarch64 | arm64)
    ARCH=arm64 BUN_ASSET=bun-linux-aarch64 UV_ASSET=uv-aarch64-unknown-linux-gnu
    BUN_SHA256=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
    UV_SHA256=74f2f5c6024d397481db228db8fc25eed420db192243f88438c118e7e013e585
    RUNNER_SHA256=670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945
    ;;
  *) die "no runner for $(uname -m)" ;;
esac
. /etc/os-release
case "${ID:-}" in ubuntu | debian) ;; *) die "only Ubuntu or Debian, not ${ID:-unknown}" ;; esac
# the token is read before anything changes, so a missing one stops the run with nothing done
TOKEN=""
read -r TOKEN || true
registered=1
for i in $(seq 1 "$RUNNERS"); do [ -f "$HOME_DIR/runner-$i/.runner" ] || registered=0; done
[ -n "$TOKEN" ] || [ "$registered" = 1 ] || die "no registration token on stdin"
say "sizing: $CORES cores and $RAM_GB GB give $RUNNERS runners and $SWAP of swap"

export DEBIAN_FRONTEND=noninteractive
say "packages"
apt-get update -q
apt-get install -yq ca-certificates curl docker.io git golang-go jq tar ufw unattended-upgrades unzip zsh

say "swap"
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  [ -e /swapfile ] || { fallocate -l "$SWAP" /swapfile && chmod 600 /swapfile && mkswap /swapfile; }
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

say "the runner user"
id runner > /dev/null 2>&1 || useradd -m -s /bin/bash runner
# a name, so git has an identity where a test gives it none, as a Mac's account has
usermod -c "playground ci" runner
usermod -aG docker runner
for g in sudo admin wheel; do gpasswd -d runner "$g" > /dev/null 2>&1 || true; done
rm -f /etc/sudoers.d/runner
systemctl enable --now docker

# every download lands here, as root, and only a checked one is unpacked, its files alone, so the exit removes files and the empty folder
TMP=$(mktemp -d)
trap 'rm -f "$TMP"/*; rmdir "$TMP"' EXIT
su - runner -c 'mkdir -p ~/.bun/bin ~/.local/bin'

say "bun $BUN_VERSION"
if [ "$(su - runner -c '~/.bun/bin/bun --version' 2>/dev/null)" != "$BUN_VERSION" ]; then
  fetch "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$BUN_ASSET.zip" "$BUN_SHA256" "$TMP/bun.zip"
  unzip -joq "$TMP/bun.zip" "$BUN_ASSET/bun" -d "$TMP"
  install -o runner -g runner -m 755 "$TMP/bun" "$HOME_DIR/.bun/bin/bun"
  su - runner -c 'ln -sfn bun ~/.bun/bin/bunx'
fi
# node is bun, as `bun run` makes it for a script, so a tool whose shebang asks for node (turbo) runs outside a script too
su - runner -c 'ln -sfn ~/.bun/bin/bun ~/.local/bin/node'
# uv runs test:skills' Python steps under 3.13, as local CI does on the Mac
say "uv $UV_VERSION"
if [ "$(su - runner -c '~/.local/bin/uv --version' 2>/dev/null | cut -d' ' -f2)" != "$UV_VERSION" ]; then
  fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$UV_ASSET.tar.gz" "$UV_SHA256" "$TMP/uv.tar.gz"
  tar -xzf "$TMP/uv.tar.gz" -C "$TMP" --strip-components=1 "$UV_ASSET/uv" "$UV_ASSET/uvx"
  for t in uv uvx; do install -o runner -g runner -m 755 "$TMP/$t" "$HOME_DIR/.local/bin/$t"; done
fi

say "the actions runners $RUNNER_VERSION"
RUNNER_TAR=$TMP/actions-runner.tar.gz
for i in $(seq 1 "$RUNNERS"); do
  DIR=$HOME_DIR/runner-$i
  if [ ! -x "$DIR/config.sh" ]; then
    [ -f "$RUNNER_TAR" ] ||
      fetch "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-$ARCH-$RUNNER_VERSION.tar.gz" "$RUNNER_SHA256" "$RUNNER_TAR"
    mkdir -p "$DIR"
    tar -xzf "$RUNNER_TAR" -C "$DIR"
    chown -R runner: "$DIR"
    "$DIR/bin/installdependencies.sh"
  fi
  if [ ! -f "$DIR/.runner" ]; then
    # the token goes through a 0600 file the runner user reads into the config's environment, so no process lists it
    (umask 077 && printf '%s' "$TOKEN" > "$HOME_DIR/.runner-token")
    chown runner: "$HOME_DIR/.runner-token"
    su - runner -c "cd $DIR && ACTIONS_RUNNER_INPUT_TOKEN=\$(cat ~/.runner-token) ./config.sh --unattended --url $REPO_URL --labels $LABELS --name \$(hostname)-runner-$i --replace" ||
      { rm -f "$HOME_DIR/.runner-token"; die "runner-$i did not register"; }
    rm -f "$HOME_DIR/.runner-token"
  fi
  # svc.sh install writes the unit's name into .service, so the file says whether it is installed
  [ -f "$DIR/.service" ] || (cd "$DIR" && ./svc.sh install runner)
  systemctl enable --now "$(cat "$DIR/.service")"
done

say "ssh: keys alone"
[ -s /root/.ssh/authorized_keys ] || die "root has no authorized key, so key-only ssh would lock everyone out"
cat > /etc/ssh/sshd_config.d/10-playground.conf << 'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
systemctl reload ssh 2> /dev/null || systemctl reload sshd

say "firewall: ssh alone"
ufw default deny incoming > /dev/null
ufw default allow outgoing > /dev/null
ufw allow OpenSSH > /dev/null
ufw --force enable > /dev/null

say "unattended upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades

for i in $(seq 1 "$RUNNERS"); do say "runner-$i: $(systemctl is-active "$(cat "$HOME_DIR/runner-$i/.service")")"; done
# what suite.sh's steps need, as this VPS's runner user sees it: tools.sh names each one missing and exits 1
bash "$(dirname "$0")/tools.sh" || die "a tool the suite needs is missing"

