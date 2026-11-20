#!/bin/bash
# ci.sh <rev>: runs local CI's steps for a commit or tree of the current checkout on the runner host, so the suite takes no slot on the
# caller's machine (dispatcher, 18 Oct). It uploads suite.sh and a `git archive` of
# <rev>'s tree, never a token or a key, starts the run in a systemd user unit of its own and reads its lines every 20s, so a dropped ssh never
# ends the run. Prints suite.sh's lines and exits as it does (0 green, 1 a step failed), or 255 when the box cannot be reached, so the
# caller runs the suite on its own machine through run-slot instead. The host is RUNNER_HOST, else the address in
# the data folder's ops/runner-host/ip, reached as this user with no root, its state under its own ~/$BOX_CI_DIR. A re-run of a Linux-only
# test (below) runs in the current checkout, so <rev> is its HEAD.
# The other modes: ci.sh web <rev> builds the web image there, ci.sh exec <dir> -- <command...> runs one command, and ci.sh cancel <run>
# stops a run by the id ci.sh printed on stderr as it started (all below).
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
case ${PLAYGROUND_DATA_DIR:-/} in /*) ;; *) echo "ci.sh: PLAYGROUND_DATA_DIR is relative ($PLAYGROUND_DATA_DIR), so each process would read it from its own folder: set it to an absolute path" >&2; exit 1 ;; esac
HOST_DIR=${PLAYGROUND_DATA_DIR:-$HOME/.playground}/ops/runner-host
# the box's Playground clone, whose record CLI record() runs: RUNNER_HOST_CLONE, else where this main checkout sits under this home, the place peer-sync keeps each peer's clone (cloneOf); none when it is no plain path
main=$(git -C "$(dirname "$(readlink -f "$HERE/suite.sh")")" rev-parse --path-format=absolute --git-common-dir 2> /dev/null) && main=$(dirname "$main")
CLONE=${RUNNER_HOST_CLONE:-}
[ -n "$CLONE" ] || case ${main:-} in "$HOME"/?*) CLONE="~/${main#"$HOME"/}" ;; esac
[[ "$CLONE" =~ ^(~/|/)[A-Za-z0-9._/-]+$ && ! "$CLONE" =~ (^|/)\.\.?(/|$) ]] || CLONE=
KEY=${RUNNER_HOST_KEY:-$(cat "$HOST_DIR/key" 2> /dev/null)}
KEY=${KEY:-$HOME/.ssh/playground_runner}
IP=${RUNNER_HOST:-$(cat "$HOST_DIR/ip" 2> /dev/null)}
POLL=${RUNNER_HOST_POLL:-20}
PROGRESS=${RUNNER_HOST_PROGRESS:-300}
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "ci.sh: no runner host address" >&2; exit 255; }
# every ssh of every ci.sh rides one connection this user keeps a minute past its last use, since a fresh handshake a poll from dozens of
# runs went past the box's MaxStartups; the socket's name stays short, since ssh refuses a path past 86 bytes (104 less its
# temporary suffix), so a $HOME up to 37 characters fits
mkdir -p -m 700 "$HOME/.ssh"
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15
  -o ControlMaster=auto -o ControlPersist=60 -o "ControlPath=$HOME/.ssh/pg-%C" "$(id -un)@$IP")
# the room a run leaves the box's model server, defined here alone and passed to suite.sh's take() as the run's need: 15 GiB of MemAvailable past the run's peak, a suite's 4.5 GiB (measured on the old runner box, 24 Oct) or an exec's 2 GiB (estimated)
FLOOR_KB=$((15 * 1024 * 1024))
# the box's run folder, under its user's home and outside its data folder ~/.playground, so a test sandbox that hides the data folder still reaches the run's tree; suite.sh runs from the copy ci.sh puts there
# record() puts it in the box's machine record, and record.test.ts holds it to the check's watched places
BOX_CI_DIR=.cache/playground-ci
SUITE_PEAK_KB=$((4608 * 1024))
EXEC_PEAK_KB=$((2 * 1024 * 1024))
# reach <peak KiB>: the box's home, where its state folder sits, and whether its free memory keeps the floor past the run's peak; 255 sends the run back to the caller's machine
reach() {
  local got kb
  got=$("${SSH[@]}" 'printf "%s\n" "$HOME"; sed -n "s/^MemAvailable: *\([0-9]*\) kB$/\1/p" /proc/meminfo' < /dev/null) || exit 255
  BOXHOME=$(printf '%s\n' "$got" | sed -n 1p)
  kb=$(printf '%s\n' "$got" | sed -n 2p)
  [[ "$BOXHOME" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "$kb" =~ ^[0-9]+$ ]] || { echo "ci.sh: the box's home or free memory did not read" >&2; exit 255; }
  [ "$kb" -ge $((FLOOR_KB + $1)) ] || { echo "ci.sh: the box has $((kb / 1024)) MiB free, under the model server's 15 GiB floor and the run's peak, so it runs here" >&2; exit 255; }
  CI=$BOXHOME/$BOX_CI_DIR
}
new_run() { RUN=${1:0:12}-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 6); }
# what a run puts on the box, the run folder and the image suite.sh starts each run's Postgres from, goes into the box's machine record through its clone's record CLI, the remote words peerRecordArgv's add runs (packages/scripts/src/machine-record/record.ts); a path it holds already writes nothing, and a record that fails is one line and leaves the run alone, since the next daily check names the path
record() {
  [ -n "$CLONE" ] &&
    printf '[{"by":"ci.sh","kind":"folder","path":"%s","undo":"remove %s and what it holds","why":"ci.sh runs heavy runs here"},{"by":"ci.sh","kind":"image","path":"docker image postgres:alpine","undo":"docker image rm postgres:alpine","why":"suite.sh starts each run'"'"'s Postgres from it"}]' "$CI" "$CI" |
    "${SSH[@]}" "cd $CLONE && PATH=\"\$HOME/.bun/bin:\$PATH\" exec bun --no-env-file packages/scripts/src/machine-record/cli.ts add --stdin" > /dev/null 2>&1 ||
    echo "ci.sh: $CI and docker image postgres:alpine are not in the box's machine record${CLONE:+ (its clone $CLONE)}; its next check names them" >&2
}
upload() {
  # a new copy replaces the old by a rename, since bash reads a running script as it goes
  "${SSH[@]}" "install -d -m 0700 $CI && t=\$(mktemp $CI/.suite.XXXXXX) && cat > \"\$t\" && chmod 700 \"\$t\" && mv \"\$t\" $CI/suite.sh" < "$HERE/suite.sh" || exit 255
  record
  git -C "$1" archive "$2" | "${SSH[@]}" "cat > $CI/$RUN.tar" || exit 255
}
# start <mode> <peak KiB>: starts the run's unit with its heartbeat, which every poll touches (suite.sh's watch_beat), and says on stderr how to stop it; a TERM,
# INT or HUP here stops it too (go.py voids a run with TERM, TaskStop sends one first), so no orphan holds a place in the box's queue
#
start() {
  "${SSH[@]}" "touch $CI/$RUN.beat && systemd-run --user --quiet --collect --unit=ci-$RUN --property='ExecStopPost=/bin/bash $CI/suite.sh $RUN stop' bash -c 'bash $CI/suite.sh $RUN $1 $((FLOOR_KB + $2)) > $CI/$RUN.out 2>&1; c=\$?; [ -z \"\$(tail -c 1 $CI/$RUN.out)\" ] || echo >> $CI/$RUN.out; echo \"exit \$c\" >> $CI/$RUN.out'" < /dev/null || exit 255
  trap '"${SSH[@]}" "systemctl --user stop ci-$RUN" < /dev/null > /dev/null 2>&1; exit 143' TERM INT HUP
  echo "ci.sh: ci-$RUN started on the box; ci.sh cancel $RUN stops it" >&2
}
# waits for the unit to end, reading only the run's last line and the unit's state while it runs, then takes the code from its last
# line, `exit <code>` (a command can print that line itself mid-run); prints the code, or 1 and why when the unit ended with none
# (stopped, killed for memory, a reboot). Every PROGRESS seconds it says on stderr where the run stands, its place in the box's queue or
# its last line, since a silent run reads the same as a stuck one
finish() {
  local seen=$SECONDS next=$PROGRESS got last state place where
  while :; do
    sleep "$POLL"
    # the unit's state first, so a last line read after it is the unit's own once the unit has ended; touch -c, so a poll after the
    # unit's stop leaves no heartbeat behind
    if ! got=$("${SSH[@]}" "touch -c $CI/$RUN.beat; echo \"unit \$(systemctl --user is-active ci-$RUN 2> /dev/null) \$(ls $CI/queue 2> /dev/null | sed -n '/-$RUN\$/=')\"; tail -n 1 $CI/$RUN.out 2> /dev/null; echo" < /dev/null); then
      # the run goes on without us; 10 minutes after the last read, by the clock, so the run's heartbeat outlasts the wait, the caller
      # falls back to its own machine
      [ $((SECONDS - seen)) -lt 600 ] || { echo "ci.sh: the box stopped answering while $RUN ran" >&2; return 255; }
      continue
    fi
    seen=$SECONDS
    read -r state place <<< "$(printf '%s\n' "$got" | sed -n '1s/^unit //p')"
    last=$(printf '%s\n' "$got" | sed -n 2p)
    case $state in
      inactive | failed)
        [[ "$last" =~ ^exit\ ([0-9]+)$ ]] && { echo "${BASH_REMATCH[1]}"; return 0; }
        echo "1 the run's unit ci-$RUN is $state on the box with no exit line, so it was stopped, killed or lost to a reboot"
        return 0
        ;;
    esac
    [ "$SECONDS" -ge "$next" ] || continue
    next=$((SECONDS + PROGRESS))
    where=${state:-unknown}
    [ "$where" = active ] && where=running
    # a ticket's line in the queue, oldest first, so the runs ahead are one less
    [[ "$place" =~ ^[0-9]+$ ]] && where="queued, $((place - 1)) ahead"
    echo "ci.sh: ci-$RUN $where, $((SECONDS / 60)) min in${last:+, last line: $last}" >&2
  done
}
# prints a one-command run's output and exits with its code, the whole output when the unit died, since its last line is then the
# command's, not an exit line
output() {
  local code why
  read -r code why <<< "$1"
  if [ -n "$why" ]; then
    "${SSH[@]}" "cat $CI/$RUN.out" < /dev/null
    echo "ci.sh: $why" >&2
  else
    "${SSH[@]}" "sed '\$d' $CI/$RUN.out" < /dev/null
  fi
  exit "$code"
}

# ci.sh cancel <run>: stops a run of yours, by the id ci.sh printed as it started it, queued or running, and prints the unit's state after
if [ "${1:-}" = cancel ]; then
  [ $# -eq 2 ] && [[ "$2" =~ ^[0-9a-f]{12}-[0-9a-z]{6}$ ]] || { echo "usage: ci.sh cancel <run>, the id ci.sh printed as it started" >&2; exit 2; }
  state=$("${SSH[@]}" "systemctl --user stop ci-$2 2> /dev/null; systemctl --user is-active ci-$2 2> /dev/null" < /dev/null)
  [ $? = 255 ] && exit 255
  echo "ci.sh: ci-$2 ${state:-inactive}"
  exit 0
fi

# ci.sh web <rev>: builds the web image of <rev>'s tree on the box, since on a Mac its peak takes the Docker VM's out-of-memory killer to
# the live dashboard's Postgres, with the docker-test skill's smoke .env and its single-libc check, then removes the image. Prints the
# build's output and exits with its code, or 255 when the box cannot take it; nothing falls back to the caller's machine, so commit what it should build
if [ "${1:-}" = web ]; then
  [ $# -eq 2 ] || { echo "usage: ci.sh web <rev>" >&2; exit 2; }
  TREE=$(git rev-parse --verify --quiet "$2^{tree}") || { echo "ci.sh: $2 is not a commit or tree here" >&2; exit 2; }
  new_run "$TREE"
  reach "$SUITE_PEAK_KB"
  upload . "$TREE"
  start web "$SUITE_PEAK_KB"
  POLL=${RUNNER_HOST_POLL:-10}
  res=$(finish) || exit 255
  output "$res"
fi

# ci.sh exec <dir> -- <command...>: run-slot.sh's way to run one test, type check, lint or build of a checkout on the box
# (dispatcher, 18 Oct). It sends <dir>'s working tree as it stands, runs <command> there with every path under the checkout moved to the
# box's copy, prints its output and exits with its code, or 255 with nothing run when the tree cannot be written or the box cannot take
# it, so run-slot.sh runs it on this machine instead.
if [ "${1:-}" = exec ]; then
  [ $# -ge 4 ] && [ "$3" = -- ] || { echo "usage: ci.sh exec <dir> -- <command...>" >&2; exit 2; }
  ROOT=$(git -C "$2" rev-parse --show-toplevel 2> /dev/null) || exit 255
  ROOT=$(cd -P "$ROOT" && pwd -P)
  CWD=$(cd -P "$2" && pwd -P)
  shift 3
  # the working tree as it stands, written through a scratch index, so the checkout's own index and the shared stash list stay as they are;
  # a third of the box's runs fell back to the caller's machine on uncommitted changes (optimizer, 19 Oct). Tracked edits go; an untracked file goes only
  # as source under a source folder, since .gitignore does not name every key (id_ed25519, credentials.json, .netrc), and
  # any other untracked file keeps the run here
  while IFS= read -r -d '' u; do
    [[ "$u" =~ ^(api|packages|scripts|skills|tests|web)/[A-Za-z0-9._/@()+-]+\.(css|md|mdx|mjs|sh|sql|ts|tsx)$ ]] ||
      { echo "ci.sh: $ROOT has an untracked file the box does not take ($u), so it runs here" >&2; exit 255; }
  done < <(git -C "$ROOT" ls-files -z --others --exclude-standard)
  IDX=$(mktemp) || exit 255
  cp "$(git -C "$ROOT" rev-parse --path-format=absolute --git-path index)" "$IDX" 2> /dev/null || rm -f "$IDX"
  TREE=$(GIT_INDEX_FILE=$IDX git -C "$ROOT" add -A 2> /dev/null && GIT_INDEX_FILE=$IDX git -C "$ROOT" write-tree)
  rc=$?
  rm -f "$IDX"
  [ "$rc" = 0 ] && [ -n "$TREE" ] || { echo "ci.sh: $ROOT's working tree could not be written as a tree, so it runs here" >&2; exit 255; }
  new_run "$TREE"
  # a whole-suite exec, any --cwd aside, needs the suite's peak, read from the same words suite.sh's TAKE reads
  words=()
  skip=0
  for w in "$@"; do
    if [ "$skip" = 1 ]; then skip=0
    elif [ "$w" = --cwd ]; then skip=1
    elif [[ "$w" != --cwd=* ]]; then words+=("$w"); fi
  done
  peak=$EXEC_PEAK_KB
  case "${words[*]}" in "bun run test" | "bun run test:file") peak=$SUITE_PEAK_KB ;; esac
  reach "$peak"
  # under .claude/worktrees/, as a local worktree is, since some tests read their own checkout's path (dashboardSource's rule 4)
  BOXDIR=$CI/.claude/worktrees/$RUN
  args=()
  # the checkout, or a path under it, at a word's start or after its = or -C (--cwd=<it>), never a sibling that starts with the same
  # text nor a path that holds it further in
  for a in "$@"; do
    case $a in
      "$ROOT" | "$ROOT"/*) a=$BOXDIR${a#"$ROOT"} ;;
      -C"$ROOT" | -C"$ROOT"/*) a=-C$BOXDIR${a#-C"$ROOT"} ;;
      *="$ROOT" | *="$ROOT"/*) pre=${a%%="$ROOT"*} && a=$pre=$BOXDIR${a#"$pre=$ROOT"} ;;
    esac
    args+=("$a")
  done
  upload "$ROOT" "$TREE"
  { printf '%s\n' "${CWD#"$ROOT"}"; printf '%s\0' "${args[@]}"; } | "${SSH[@]}" "cat > $CI/$RUN.cmd" || exit 255
  start exec "$peak"
  POLL=${RUNNER_HOST_POLL:-5}
  res=$(finish) || exit 255
  output "$res"
fi

[ $# -eq 1 ] || { sed -n '2,/^[^#]/{/^#/p;}' "$0" >&2; exit 2; }
TREE=$(git rev-parse --verify --quiet "$1^{tree}") || { echo "ci.sh: $1 is not a commit or tree here" >&2; exit 2; }
new_run "$TREE"
reach "$SUITE_PEAK_KB"
upload . "$TREE"
# the tree the box gets has no history, so the audit's base goes beside the tree: <rev>'s merge base with canary, or canary itself for a tree
BASE=$(git merge-base "$1" origin/canary 2> /dev/null || git rev-parse --verify --quiet origin/canary)
[ -z "$BASE" ] || git show "$BASE:bun.lock" | "${SSH[@]}" "cat > $CI/$RUN.base" || exit 255
start suite "$SUITE_PEAK_KB"
res=$(finish) || exit 255
trap - TERM INT HUP
read -r code why <<< "$res"
out=$("${SSH[@]}" "cat $CI/$RUN.out" < /dev/null) || exit 255
lines=$(printf '%s\n' "$out" | grep -v '^exit [0-9]*$')
[ -z "$why" ] || lines=$(printf '%s\n%s\n' "$lines" "fail run: $why")

# dispatcher, 18 Oct: when every failure is a test RUNNER_HOST_LINUX_ONLY names, one a line, those test files run again here,
# and the run is green only when they pass; the test line names the split. Both tests it once named are fixed.
# The backoff reader's race is fixed, so ci.sh's own list is empty.
LINUX_ONLY=${RUNNER_HOST_LINUX_ONLY:-}
names=$(printf '%s\n' "$lines" | sed -n 's/^failed test //p')
files=$(printf '%s\n' "$lines" | sed -n 's/^files test //p')
others=$(printf '%s\n' "$lines" | grep '^fail ' | grep -v '^fail test ')
# a file that throws as it loads prints no (fail) line, so the run's own count of failures and errors must match the names
read -r fails errors <<< "$(printf '%s\n' "$lines" | sed -n 's/^tally test //p')"
rerun=no
if [ "$code" = 1 ] && [ -n "$LINUX_ONLY" ] && [ -n "$names" ] && [ "${errors:-}" = 0 ] && [ "${fails:-}" = "$(printf '%s\n' "$names" | wc -l | tr -d ' ')" ] && [ -n "$files" ] && [ -z "$others" ] && [ -z "$(printf '%s\n' "$names" | grep -vxF "$LINUX_ONLY")" ]; then
  # the re-run proves the box's tree only when this checkout holds that tree and nothing else
  if [ -n "$(git status --porcelain 2> /dev/null)" ]; then
    rerun="this checkout has changes not committed"
  elif [ "$(git rev-parse HEAD^{tree} 2> /dev/null)" != "$TREE" ]; then
    rerun="this checkout's HEAD is not the tree the runner host ran ($TREE)"
  else
    rerun=yes
  fi
fi
if [ "$rerun" != no ] && [ "$rerun" != yes ]; then
  lines=$(printf '%s\n%s\n' "$lines" "re-run skipped: $rerun, so the Linux-only failures stand")
elif [ "$rerun" = yes ]; then
  # shellcheck disable=SC2086
  here=$(bun run test:file $files 2>&1)
  rc=$?
  said=$(printf '%s\n' "$here" | grep -E '^ *[0-9]+ (pass|fail)$' | sed 's/^ *//' | paste -sd ',' - | sed 's/,/, /g')
  if [ "$rc" = 0 ]; then
    secs=$(printf '%s\n' "$lines" | sed -n 's/^fail test \([0-9]*\)s:.*/\1/p')
    lines=$(printf '%s\n' "$lines" | sed "s|^fail test .*|ok test ${secs}s: the suite ran on the runner host, and $(printf '%s\n' "$names" | paste -sd ';' - | sed -e 's/|/ /g' -e 's/[&\\]/\\&/g'), which fail on Linux alone, passed here ($files: $said)|")
    code=0
  else
    lines=$(printf '%s\n%s\n' "$lines" "re-run here of the Linux-only files ($files): ${said:-exit $rc}")
  fi
fi
printf '%s\n' "$lines"
exit "$code"
