#!/usr/bin/env bash
# Installs Playground: curl -fsSL <raw URL>/install.sh | bash
# It installs every missing tool it can in one run, each through its project's own installer, and ends with a "Left for you" list of what it could not do, each with the one command that does it.
# It waits only where it cannot act alone (Homebrew's password, Docker Desktop's first open, gh auth login, Claude's sign-in, the Mac's password for portless's proxy service), and only with a terminal; without one each goes on the list.
# Every step checks before it acts, so a second run changes nothing. PLAYGROUND_DIR names the install folder; --check (or PLAYGROUND_INSTALL=0) prints what is missing and changes nothing.
set -euo pipefail

REPO=nrjdalal/playground
DIR="${PLAYGROUND_DIR:-$HOME/playground}"
CHECK=""
[ "${1:-}" = --check ] || [ "${PLAYGROUND_INSTALL:-}" = 0 ] && CHECK=1

# The terminal an in-place step reads from, the brew prefixes, the OS, the plist portless's proxy service runs from and whether its proxy answers: under the test sandbox its own stand-ins alone, so a test never reads the real terminal, runs a real installer or probes the real proxy.
PORTLESS_PLIST=/Library/LaunchDaemons/sh.portless.proxy.plist
PROXY_UP=""
if [ -n "${TEST_SANDBOX_HOME:-}" ]; then
  TTY="${INSTALL_TTY:-}"
  BREW_PREFIXES="${INSTALL_BREW_PREFIXES:-}"
  OS="${INSTALL_OS:-$(uname -s)}"
  PORTLESS_PLIST="${INSTALL_PORTLESS_PLIST:-}"
  # a file whose presence stands for the proxy answering on its port
  PROXY_UP="${INSTALL_PROXY_UP:-$TEST_SANDBOX_HOME/no-proxy}"
elif (: </dev/tty) 2>/dev/null; then
  TTY=/dev/tty
  BREW_PREFIXES="/opt/homebrew /usr/local"
  OS=$(uname -s)
else
  TTY=""
  BREW_PREFIXES="/opt/homebrew /usr/local"
  OS=$(uname -s)
fi
# The terminal by its own device: macOS's kqueue refuses /dev/tty itself, so a Bun program reading it, as claude's sign-in does, stops with "EINVAL: invalid argument, kqueue".
if [ "$TTY" = /dev/tty ]; then
  TTY_NAME=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ') || TTY_NAME=""
  [ -n "$TTY_NAME" ] && [ -c "/dev/$TTY_NAME" ] && TTY="/dev/$TTY_NAME"
fi

# The startup file of the login shell, where a tool's PATH line goes once; another shell gets the lines printed.
case "$(basename "${SHELL:-}")" in
  zsh) RC="$HOME/.zshrc" ;;
  bash) RC="$HOME/.bashrc" ;;
  *) RC="" ;;
esac
PRINTED=()
SHELL_CHANGED=""
# A line for a new terminal: added to the startup file unless a line there already names one of the words after it, else printed with the list.
shell_line() {
  local line="$1" word
  shift
  if [ -n "$RC" ]; then
    for word in "$@"; do grep -qF -- "$word" "$RC" 2>/dev/null && return 0; done
    [ -n "$CHECK" ] && return 0
    printf '%s\n' "$line" >>"$RC"
  else
    PRINTED+=("$line")
  fi
  SHELL_CHANGED=1
}

LEFT=()
left() { LEFT+=("$1"); }
# Whether a tool is on the list already, so doctor's rows add none the first pass named.
listed() {
  local item
  for item in ${LEFT[@]+"${LEFT[@]}"}; do
    case "$item" in "$1: "*) return 0 ;; esac
  done
  return 1
}
has() { command -v "$1" >/dev/null 2>&1; }

# Homebrew's shellenv, run here so every later step finds brew, and its line for a new terminal.
brew_env() {
  local prefix before
  for prefix in $BREW_PREFIXES; do
    if [ -x "$prefix/bin/brew" ]; then
      before="$PATH"
      eval "$("$prefix/bin/brew" shellenv)"
      after_path "$before"
      has_on_login_path "$prefix/bin" || shell_line "eval \"\$($prefix/bin/brew shellenv)\"" "brew shellenv"
      return 0
    fi
  done
  return 1
}
# shellenv puts Homebrew's folders first; the PATH before it stays first, so a tool the user put ahead of Homebrew's still runs, and each folder it added follows.
after_path() {
  local before="$1" dir added="" IFS=:
  for dir in $PATH; do
    case ":$before:$added:" in *":$dir:"*) ;; *) added="$added:$dir" ;; esac
  done
  PATH="$before$added"
  PATH="${PATH#:}"
}
ORIGINAL_PATH="$PATH"
has_on_login_path() { case ":$ORIGINAL_PATH:" in *":$1:"*) return 0 ;; esac; return 1; }
# A folder an installer puts tools in: on PATH for this run, and on a new terminal's unless it is there already or the startup file names it or a word given (bun's own installer writes BUN_INSTALL).
on_path() {
  local dir="$1"
  shift
  [ -d "$dir" ] || return 0
  case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac
  has_on_login_path "$dir" || shell_line "export PATH=\"$dir:\$PATH\"" "${dir#"$HOME"/}" "$@"
}

HOMEBREW='/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
# Homebrew from its own installer, which asks for the Mac's password itself, so only with a terminal.
ensure_brew() {
  has brew && return 0
  [ -z "${BREW_FAILED:-}" ] || return 1
  if [ -n "$TTY" ]; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" <"$TTY" && brew_env && return 0
    left "Homebrew: its installer stopped; run $HOMEBREW"
  else
    left "Homebrew: run $HOMEBREW in a terminal, since it asks for your Mac's password"
  fi
  BREW_FAILED=1
  return 1
}

# One tool by its doctor name, each from its project's own installer; 0 once the tool is there.
install_tool() {
  case "$1" in
    bun)
      has bun && return 0
      curl -fsSL https://bun.sh/install | bash && on_path "$HOME/.bun/bin" BUN_INSTALL && has bun
      ;;
    claude)
      has claude && return 0
      curl -fsSL https://claude.ai/install.sh | bash && on_path "$HOME/.local/bin" && has claude
      ;;
    claude-codex)
      has claude-codex && return 0
      curl -fsSL https://raw.githubusercontent.com/fcakyon/claude-code-with-codex/main/scripts/install.sh | bash && on_path "$HOME/.local/bin" && has claude-codex
      ;;
    docker)
      has docker && return 0
      ensure_brew && brew install --cask docker </dev/null || return 1
      has docker && return 0
      if [ -n "$TTY" ]; then
        open -a Docker || true
        left "Docker Desktop: finish its first start in the window that opened, which puts docker on PATH"
      else
        left "Docker Desktop: open it once (open -a Docker) and finish its first start"
      fi
      return 0
      ;;
    gh | git | node | uv)
      has "$1" && return 0
      ensure_brew && brew install "$1" </dev/null && has "$1"
      ;;
    python3)
      has python3 && return 0
      ensure_brew && brew install python </dev/null && has python3
      ;;
    *) return 1 ;;
  esac
}

# Each tool given as name<TAB>fix, in order: in --check, or off a Mac, its fix goes on the list; else it is installed, and on a failure its fix goes on the list and the run carries on.
install_all() {
  local name fix
  while IFS=$'\t' read -r name fix <&3; do
    [ -n "$name" ] || continue
    ! listed "$name" || continue
    if [ -n "$CHECK" ] || [ "$OS" != Darwin ]; then
      case "$fix" in brew\ *) [ "$OS" != Darwin ] || has brew || [ -n "${BREW_NOTED:-}" ] || { left "Homebrew: $HOMEBREW"; BREW_NOTED=1; } ;; esac
      left "$name: $fix"
    elif ! install_tool "$name"; then
      left "$name: $fix"
    fi
  done
}

# The list of what is left, and the line a new terminal needs.
finish() {
  if [ "${#PRINTED[@]}" -gt 0 ]; then
    left "your shell: add these lines to its startup file: ${PRINTED[*]}"
  fi
  if [ "${#LEFT[@]}" -eq 0 ]; then
    echo "Playground is ready."
  else
    echo "Left for you:"
    printf '  - %s\n' "${LEFT[@]}"
  fi
  if [ -n "$SHELL_CHANGED" ]; then
    if [ -n "$RC" ]; then echo "Then open a new terminal, or run: source $RC"; else echo "Then open a new terminal."; fi
  fi
}

# The bun every step after the clone runs: the first on PATH, until ensure_bun names one at least the checkout's own.
BUN=bun
# Whether version $1 is $2 or newer, by its first three numbers.
at_least() {
  local have want i IFS=.-
  read -r -a have <<<"$1"
  read -r -a want <<<"$2"
  for i in 0 1 2; do
    [ "${have[i]:-0}" -eq "${want[i]:-0}" ] 2>/dev/null && continue
    [ "${have[i]:-0}" -gt "${want[i]:-0}" ] 2>/dev/null
    return
  done
}
# A bun at least package.json's packageManager names, since bun.lock's format follows it and an older bun cannot install it: else bun's installer puts that version in ~/.bun, which goes first on PATH, so a step's own `bun` and `#!/usr/bin/env bun` find it too. --check only names it.
ensure_bun() {
  local want have path fix ahead
  want=$(sed -n 's/^ *"packageManager": *"bun@\([^"]*\)".*/\1/p' "$DIR/package.json" 2>/dev/null)
  [ -n "$want" ] || return 0
  path=$(command -v bun) || return 1
  have=$("$path" --version 2>/dev/null || true)
  at_least "$have" "$want" && BUN="$path" && return 0
  fix="curl -fsSL https://bun.sh/install | bash -s bun-v$want"
  if [ -z "$CHECK" ] && curl -fsSL https://bun.sh/install | bash -s "bun-v$want"; then
    on_path "$HOME/.bun/bin" BUN_INSTALL
    PATH="$HOME/.bun/bin:$PATH"
    path="$HOME/.bun/bin/bun"
    if at_least "$("$path" --version 2>/dev/null || true)" "$want"; then
      BUN="$path"
      # A login PATH that names ~/.bun/bin behind another bun keeps that bun first in a new terminal, so a line last in the startup file puts this one ahead of it.
      ahead=$(PATH="$ORIGINAL_PATH" command -v bun || true)
      if [ -n "$ahead" ] && [ "$ahead" != "$path" ] && has_on_login_path "$HOME/.bun/bin"; then
        shell_line "export PATH=\"$HOME/.bun/bin:\$PATH\" # Playground: bun $want ahead of $ahead" "# Playground: bun"
      fi
      return 0
    fi
  fi
  left "bun: $path is ${have:-of no version}, older than $want, which Playground's lockfile needs; run $fix"
  return 1
}

DOCTOR="$DIR/packages/scripts/src/playground/doctor.ts"
# The rest of the doctor's own list, as name<TAB>fix in the order the tools are installed in: only the tools install_tool installs, since the gh login waits for a gh this run may install, and herdr is herdr_pin's.
rest_of_doctor() {
  "$BUN" --no-env-file "$DOCTOR" --tools --json | "$BUN" --no-env-file -e '
    const order = ["git", "node", "gh", "python3", "uv", "bun", "claude", "claude-codex", "docker"]
    const left = JSON.parse(await Bun.stdin.text()).filter((c) => c.status !== "ok" && order.includes(c.name))
    for (const c of left.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)))
      console.log(`${c.name}\t${c.detail.replace(/^.*?fix: /, "").replace(/ \([^)]*\)$/, "")}`)
  ' || true
}

# GitHub's sign-in, after the installs, so a gh this run installed gets it too; it opens the browser, so only with a terminal, and never in --check.
gh_sign_in() {
  has gh && gh auth status -h github.com >/dev/null 2>&1 </dev/null && return 0
  if [ -z "$CHECK" ] && [ -n "$TTY" ] && has gh && gh auth login <"$TTY"; then return 0; fi
  left "GitHub sign-in: gh auth login, then playground ext init (until then your extensions stay on this machine)"
}

# The herdr build the factory pins, through its own installer in the checkout (--check reads it alone); a failure goes on the list with the installer's own reason.
herdr_pin() {
  local err
  err=$(mktemp)
  "$BUN" --no-env-file "$DIR/packages/scripts/src/playground/herdr-pin.ts" "$@" 2>"$err" </dev/null ||
    left "herdr: $(tail -n 1 "$err" | grep . || echo "its pinned install stopped; run bun $DIR/packages/scripts/src/playground/herdr-pin.ts")"
  rm -f "$err"
}

# Claude's sign-in opens the browser, so only with a terminal, and never in --check.
claude_sign_in() {
  has claude || return 0
  claude auth status --json 2>/dev/null </dev/null | grep -q '"loggedIn": *true' && return 0
  if [ -z "$CHECK" ] && [ -n "$TTY" ] && claude auth login <"$TTY"; then return 0; fi
  left "Claude sign-in: claude auth login"
}

# playground ext init itself, its words shown; when it stops, its last line is the reason on the list.
ext_init_run() {
  local err
  err=$(mktemp)
  "$HOME/.bun/bin/playground" ext init "$@" </dev/null 2>"$err" && { cat "$err" >&2; rm -f "$err"; return 0; }
  cat "$err" >&2
  left "your extensions' repo: playground ext init stopped ($(grep . "$err" | tail -n 1)); run it again once that is fixed"
  rm -f "$err"
}

# ext init makes a GitHub repo only on a yes, asked on the terminal, since under curl's pipe stdin is this script; with no terminal the repo goes on the list.
ext_init() {
  has gh && gh auth status -h github.com >/dev/null 2>&1 </dev/null || return 0
  local login repo answer
  login=$(gh api user --jq .login 2>/dev/null </dev/null || true)
  repo="$login/playground-$login"
  if [ -z "$login" ] || gh repo view "$repo" >/dev/null 2>&1 </dev/null; then
    ext_init_run
  elif [ -n "$TTY" ]; then
    printf 'Make %s on GitHub, private, to back up your settings? [y/N] ' "$repo"
    read -r answer <"$TTY" || answer=
    case "$answer" in
      [yY] | [yY][eE][sS]) ext_init_run --yes ;;
      *) left "$repo is not made: run playground ext init when you want your settings backed up" ;;
    esac
  else
    left "$repo is not made, since there is no terminal to ask on: run playground ext init in a terminal to make it"
  fi
}

# Whether something answers on a loopback port ($1); a test names a file that stands for the answer
proxy_answers() {
  if [ -n "$PROXY_UP" ]; then
    [ -f "$PROXY_UP" ]
  else
    (: </dev/tcp/127.0.0.1/"$1") 2>/dev/null
  fi
}

# Whether a stack starts on portless's proxy, by the stack's own rule (proxyDown in api/hono/src/lib/dev/proxy.ts): the port portless saved, else PORTLESS_PORT, else 443; a saved 1355 is ready while it answers and otherwise reads as 443, any other port of 1024 or above needs no sudo, and a lower one is ready once something answers on it.
proxy_ready() {
  [ "${PORTLESS:-}" = 0 ] && return 0
  local saved="${PORTLESS_STATE_DIR:-$HOME/.portless}/proxy.port" port="${PORTLESS_PORT:-443}"
  [ -f "$saved" ] && port=$(tr -d '[:space:]' <"$saved")
  if [ "$port" = 1355 ]; then
    proxy_answers 1355 && return 0
    port=443
  fi
  [ "$port" -ge 1024 ] 2>/dev/null && return 0
  proxy_answers "$port"
}

# portless's proxy serves the Dashboard at https://playground.localhost: a root service on port 443 that starts with the Mac and, as it installs, adds its own certificate to the Mac's trusted list. Installing it takes the Mac's password, so only with a terminal and never in --check; 0 once the proxy is ready, so a service whose start failed is installed again.
PROXY_LEFT="the Dashboard's local address: run bash $DIR/install.sh again in a terminal, which sets it up with your Mac's password"
proxy_service() {
  [ "$OS" = Darwin ] || return 0
  proxy_ready && return 0
  if [ -z "$CHECK" ] && [ -n "$TTY" ]; then
    echo "The Dashboard opens at https://playground.localhost, served by portless's proxy: a service on port 443 that starts with your Mac and adds its own certificate to your Mac's trusted list, so the browser shows no warning."
    echo "Setting it up needs your Mac's password, so sudo asks for it once now."
    # sudo's own PATH lacks Homebrew's node, which portless's command runs on
    sudo env "PATH=$PATH" "$DIR/node_modules/.bin/portless" service install <"$TTY" && return 0
  fi
  left "$PROXY_LEFT"
  return 1
}

# Everything runs from here, so a curl | bash run is read whole before any step can read stdin.
main() {
  brew_env || true
  [ -d "$HOME/.bun/bin" ] && on_path "$HOME/.bun/bin" BUN_INSTALL
  [ -d "$HOME/.local/bin" ] && on_path "$HOME/.local/bin"

  # git, node and bun come first, since the clone needs git, doctor's own list runs on bun, and the build and the Dashboard run on node; doctor checks node's version.
  FIRST=$'git\tbrew install git\nnode\tbrew install node\nbun\tcurl -fsSL https://bun.sh/install | bash'
  install_all 3< <(printf '%s\n' "$FIRST" | while IFS=$'\t' read -r name fix; do has "$name" || printf '%s\t%s\n' "$name" "$fix"; done)

  if [ -n "$CHECK" ]; then
    if has bun && [ -f "$DOCTOR" ]; then
      ensure_bun || true
      install_all 3< <(rest_of_doctor)
      gh_sign_in
      herdr_pin --check
      claude_sign_in
      proxy_service || true
    else
      left "the rest of the check: it runs once Playground is cloned into $DIR"
    fi
    finish
    [ "${#LEFT[@]}" -eq 0 ]
    exit
  fi

  if ! has git || ! has bun || ! has node; then
    echo "Playground needs git, bun and node before it can clone; nothing else was changed."
    finish
    exit 1
  fi

  local startup="${RC:-your shell startup file}" service=""
  [ "$OS" = Darwin ] && service=$'\n'"  $PORTLESS_PLIST  portless's proxy service, installed with sudo, and its certificate in the System keychain"
  cat <<EOF
Playground installs into $DIR. Outside it, it writes only in:
  $HOME/.bun/bin             the playground command
  $HOME/.playground          the data folder: your extensions, the brief templates, the ops scripts and the skill sets
  Claude Code's user settings  the home skill set, installed with claude plugin install
  $startup  a PATH line for each tool it installs off your PATH, once$service
Every ops job starts off but the Dashboard's own and the usage read, so nothing goes into $HOME/Library/LaunchAgents.
EOF

  # A clone goes through the gh login when there is one, else git clones it over https. Either clones main, the shipped branch, whatever the repo's default is.
  # A checkout left on another branch, such as one cloned while canary was the default, moves to main first, when it holds no uncommitted changes.
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch -q origin main
    branch=$(git -C "$DIR" branch --show-current)
    if [ "$branch" != main ]; then
      if ! git -C "$DIR" diff --quiet HEAD; then
        echo "Playground in $DIR is on ${branch:-a detached HEAD} with uncommitted changes; commit or stash them, then run this again."
        finish
        exit 1
      fi
      echo "Playground in $DIR was on ${branch:-a detached HEAD}, so it moves to main at origin/main."
      git -C "$DIR" checkout -q -B main origin/main
    fi
    git -C "$DIR" merge -q --ff-only origin/main
  elif has gh && gh auth status -h github.com >/dev/null 2>&1; then
    gh repo clone "$REPO" "$DIR" -- -q -b main
  else
    git clone -q -b main "https://github.com/$REPO.git" "$DIR"
  fi

  if ! ensure_bun; then
    echo "Playground needs a newer bun before it can install, so it stops here."
    finish
    exit 1
  fi
  install_all 3< <(rest_of_doctor)
  gh_sign_in
  herdr_pin
  claude_sign_in

  # The build and the links need claude besides git, bun and node; any other tool still missing leaves the start to you.
  if ! has claude; then
    echo "Playground needs claude before it can link its skills, so it stops here."
    finish
    exit 1
  fi
  (cd "$DIR" && "$BUN" install --frozen-lockfile)
  env NODE_ENV=production SKIP_ENV_VALIDATION=true "$DIR/node_modules/.bin/turbo" run build --filter='./packages/*' --cwd "$DIR"
  bash "$DIR/scripts/link-skills.sh"
  on_path "$HOME/.bun/bin" BUN_INSTALL
  # With gh signed in, your extensions get their private repo and your login's folder; without it they stay on this machine, and doctor says sync is off.
  ext_init
  local proxy=0
  proxy_service || proxy=1
  finish
  if [ "$proxy" -ne 0 ]; then
    echo "The Dashboard's local address is not set up, so playground does not start yet: run bash $DIR/install.sh again in a terminal to set it up and start it."
    exit 1
  fi
  if "$BUN" --no-env-file "$DOCTOR" --tools >/dev/null; then
    exec "$HOME/.bun/bin/playground"
  fi
  echo "Then run: playground"
  exit 1
}

main "$@"
