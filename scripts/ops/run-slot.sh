#!/bin/bash
# run-slot.sh <who> [--model-bound] [--after <pid>] -- <command> [args...]: run one heavy run (a suite, a type check, Checks, a build) holding one of the machine's run slots.
# A --model-bound run (one that mostly waits on a model, such as a parity replay) takes run-slot-model-<n> instead, at most slots.modelBound at once (model_cap, below), counted apart from the CPU slots and their queue.
# It takes ops/run-slot, run-slot-2, run-slot-3 or run-slot-4 by mkdir, as the load rules (lanes_open) open them and its size's load units fit, waiting and
# retrying while none does; writes "<who> <its own pid> <iso> <units> <size>" to the slot's .holder file beside it
# (a quick lane writes "<who> <pid> <iso>", the clone lane adding its two checkouts, clone_ends); runs the command as its
# child, in a new session and process group; and gives the slot back (rmdir) however it ends: success, failure or a signal. A holder whose
# pid has died is reclaimed; a slot whose holder line has no pid, or has no holder line, is held until it is 2 hours old, or while its age reads back empty. It prints the slot
# it took to stderr and exits with the command's code.
set -u
case ${PLAYGROUND_DATA_DIR:-/} in /*) ;; *) echo "run-slot.sh: PLAYGROUND_DATA_DIR is relative ($PLAYGROUND_DATA_DIR), so each process would read it from its own folder: set it to an absolute path" >&2; exit 1 ;; esac
OPS=${RUN_SLOT_OPS:-${PLAYGROUND_DATA_DIR:-$HOME/.playground}/ops}
# this copy's path and arguments, so a waiter can run a newer copy in its place (reread, below)
SELF=$0
ARGS=("$@")
# LANES is capacity()'s one lanes verdict for a count (lanes_now), and HELD5 its one load5 verdict (load5_held), so a value from the caller's env would steer every slot check outside a count
unset LANES HELD5
# a waiter that runs a newer copy hands it its first ask's time, so the runs log has one ask and the whole wait; the command never sees it
REREAD=""
case "${RUN_SLOT_ASKED:-}" in
  ''|*[!0-9]*) ASKED=$(date +%s) ;;
  *) ASKED=$RUN_SLOT_ASKED; REREAD=1 ;;
esac
unset RUN_SLOT_ASKED
# the clone ticket's sort key, second.nanoseconds from one clock read (issues 1619, 1688: seconds alone tied and the name's glob fell to the pid, which does not track ask order); a reread hands it on, so the ticket keeps its name
ASK_STAMP=""
case ${RUN_SLOT_ASK_STAMP:-} in
  *[!0-9.]*) ;;
  *[0-9].[0-9]*) ASK_STAMP=$RUN_SLOT_ASK_STAMP; REREAD=1 ;;
esac
unset RUN_SLOT_ASK_STAMP
# the command reads run-slot's own stdin through fd 3, since bash gives a script's background job /dev/null (a heredoc ran as an empty
# program and exited 0); a closed stdin gives it /dev/null, as before
{ exec 3<&0; } 2>/dev/null || exec 3</dev/null
# a file's mtime, and its stamp (inode and mtime, through a symlink), in GNU stat's form (the runner host's Linux) or BSD's (the Mac)
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
stamp() { stat -L -c '%i %Y' "$1" 2>/dev/null || stat -L -f '%i %m' "$1" 2>/dev/null; }
STAMP=$(stamp "$SELF")
# A hand-set runner-host/slot-off kept the runner box idle for two days, so each ops switch carries "<who> <iso set> <iso expiry> <reason>"
# (run-slot.sh set, below) and drops itself past its expiry; a file with no such line counts as set at its mtime with the default 4 hours, and as off while that mtime reads back empty
SWITCHES="run-slot.3-off run-slot.4-off run-slot.battery run-slot.clone-off run-slot.focus run-slot.idle-min run-slot.load1-max run-slot.load5-cap run-slot.single runner-host/off runner-host/slot-off"
# whether switch $1 (a path under ops) is on; one past its expiry is moved to <name>.expired-<ts> and logged in run-slot.runs.log
switch_on() {
  local f="$OPS/$1" line ends now m
  [ -e "$f" ] || return 1
  line=$(head -n 1 "$f" 2>/dev/null)
  switch_ends "$1"
  ends=$ENDS
  now=$(date -u +%FT%TZ)
  if [ -n "$ends" ]; then
    [[ "$now" < "$ends" ]] && return 0
  else
    m=$(mtime "$f" || date +%s)
    # an mtime that reads back empty counts as the file gone, rather than as a shell error (4 Nov: the same read in stale printed "syntax error: operand expected")
    case "$m" in '' | *[!0-9]*) return 1 ;; esac
    [ $(( $(date +%s) - m )) -lt 14400 ] && return 0
  fi
  mv "$f" "$f.expired-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null && echo "$now expire ${WHO:-run-slot} $$ $1 $line" >> "$OPS/run-slot.runs.log"
  return 1
}
# the expiry a switch line carries, read with builtins into ENDS, so switch_on and due_at parse one line with no process (issue 1378's fork bound)
switch_ends() {
  local line= re='^[^ ]+ [0-9-]{10}T[0-9:]{8}Z [0-9-]{10}T[0-9:]{8}Z '
  ENDS=
  read -r line 2>/dev/null < "$OPS/$1"
  [[ "$line" =~ $re ]] || return 0
  line=${line#* }
  line=${line#* }
  ENDS=${line%% *}
  return 0
}
# whether pid $1 runs: kill -0 reaches it, or the kernel refuses the signal (another user's process, or one outside Claude Code's sandbox, which also refuses the setuid ps) rather than finding no such process
alive() {
  local err
  # a signal that goes through costs no process; only a refused one is read again for why
  kill -0 "$1" 2>/dev/null && return 0
  err=$(LC_ALL=C kill -0 "$1" 2>&1) || case "$err" in *"not permitted"*) true ;; *) false ;; esac
}
# whether focus for session $1 spares session $2's runs, neither holding nor preempting them: its own, its own reviewer's and tester's (by name or by the roster row's worker), and ops' upkeep (ops-tick's beats, the dashboard), which keep running (dispatcher, 5 Nov)
focus_spares() {
  case "$2" in "$1" | ops-dashboard | ops-tick) return 0 ;; esac
  case "$2" in "${1%-worker}-reviewer" | "${1%-worker}-tester") return 0 ;; *-reviewer | *-tester | reviewer-* | tester-*) ;; *) return 1 ;; esac
  # a checker with an id of its own is the focused session's when its roster row names it as the worker, the key spawn.sh writes and size_of reads
  python3 -I - "$2" "$1" <<'PY'
import json, os, sys

data = os.path.abspath(os.environ.get("PLAYGROUND_DATA_DIR") or os.path.expanduser("~/.playground"))
try:
    with open(os.path.join(data, "roster.json")) as f:
        agents = json.load(f).get("agents") or []
except (OSError, ValueError, AttributeError):
    agents = []
row = next((a for a in agents if isinstance(a, dict) and a.get("name") == sys.argv[1]), {})
sys.exit(0 if row.get("worker") == sys.argv[2] else 1)
PY
}
# whether slot directory $1, whose holder line is $2, is stale: its pid has died, or a line with no pid (or no line, read by the directory's
# own mtime) has aged 2 hours; a run killed between free()'s rm of its holder and its rmdir leaves a directory with no line
stale() {
  local pid m
  pid=$(printf '%s' "$2" | cut -d' ' -f2)
  if printf '%s' "$pid" | grep -Eq '^[0-9]+$'; then
    ! alive "$pid"
  else
    m=$(mtime "$1.holder" || mtime "$1" || date +%s)
    # an mtime that reads back empty counts as young, rather than as a shell error (4 Nov: "<epoch> -  : syntax error: operand expected")
    case "$m" in '' | *[!0-9]*) return 1 ;; esac
    [ $(( $(date +%s) - m )) -ge 7200 ]
  fi
}
# a setting's value as JSON, as the settings reader in this script's checkout prints it, its default on a machine with no extensions; a reader that cannot answer says why on stderr
setting() {
  "$BUN" "$(checkout_root)/packages/scripts/src/playground/setting.ts" "$1" </dev/null
}
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
# the checkout this script sits in, past the state folder's link to it
checkout_root() { python3 -I -c 'import os, sys; print(os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[1])))))' "$SELF"; }
# The item size a session's runs and starts count, and its load units (load is split by item so a big plan never
# blocks small ones; small:medium:big weigh 1:2:3): RUN_SLOT_SIZE, else small for commit-<worktree>, a pre-commit step that runs in
# seconds and as its branch's big item waited 815s behind smaller runs, else the roster entry's size (a checker falls back to its worker's, and
# ops-checks-<n> reads the worker on factory.repo's PR n), else the plan.json item for issue <n> (its id PG-<n>, or its spec that issue's URL) that its
# branch PG-<n>-..., in either case (the roster's, else the checkout's) names, else medium
size_of() {
  local repo=""
  case "$1" in ops-checks-*) repo=$(setting factory.repo | tr -d '"') ;; esac
  python3 -I - "$1" "$(git symbolic-ref --short HEAD 2>/dev/null)" "$repo" <<'PY'
import json, os, re, sys

who, branch, repo = sys.argv[1], sys.argv[2], sys.argv[3].lower()
UNITS = {"small": 1, "medium": 2, "big": 3}

def done(size):
    print(size, UNITS[size])
    sys.exit(0)

if os.environ.get("RUN_SLOT_SIZE") in UNITS:
    done(os.environ["RUN_SLOT_SIZE"])
if who.startswith("commit-"):
    done("small")
# The data folder roster.ts reads, as dataDir() resolves it: PLAYGROUND_DATA_DIR, else .playground in the home folder.
data = os.path.abspath(os.environ.get("PLAYGROUND_DATA_DIR") or os.path.expanduser("~/.playground"))

def load(name):
    try:
        with open(os.path.join(data, name)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None

roster = load("roster.json")
agents = [a for a in ((roster.get("agents") or []) if isinstance(roster, dict) else []) if isinstance(a, dict) and isinstance(a.get("name"), str)]
by = {a["name"]: a for a in agents}
entry = by.get(who)
checks = re.fullmatch(r"ops-checks-(\d+)", who)
if checks:
    entry = next((a for a in agents if repo and str(a.get("pr", "")).lower().endswith(f"github.com/{repo}/pull/{checks.group(1)}") and not (a.get("kind") in ("reviewer", "tester") or re.fullmatch(r"(?:reviewer|tester)-.+|[23456789bcdfghjkmnpqrstvwxyz]{6}-(?:reviewer|tester)", a["name"]))), None)
chain = [e for e in (entry, by.get((entry or {}).get("worker"))) if e]
for e in chain:
    if e.get("size") in UNITS:
        done(e["size"])
branch = next((e["branch"] for e in chain if isinstance(e.get("branch"), str)), branch)

def find(node, n):
    if isinstance(node, dict):
        if (node.get("id") == f"PG-{n}" or str(node.get("spec", "")).endswith(f"/issues/{n}")) and node.get("size") in UNITS:
            return node["size"]
        node = list(node.values())
    if isinstance(node, list):
        for v in node:
            found = find(v, n)
            if found:
                return found
    return None

issue = re.match(r"pg-(\d+)-", branch, re.I)
if issue:
    found = find(load("bundles/plan.json"), issue.group(1))
    if found:
        done(found)
done("medium")
PY
}
# run-slot.sh box-off: print, one word a line, each precondition of the runner-box route (below) that fails, for ops-sweep's box-route-off finding, since a run otherwise falls back to this Mac without a word; nothing when the route can fire
if [ "${1:-}" = box-off ]; then
  [ -x "$OPS/runner-host/ci.sh" ] || echo no-ci-sh
  [ -e "${RUNNER_HOST_KEY:-$HOME/.ssh/playground_runner}" ] || echo no-ssh-key
  switch_on runner-host/off && echo runner-host-off
  switch_on runner-host/slot-off && echo slot-off
  exit 0
fi
# run-slot.sh clear-stale: remove each slot's leftover holder (and its directory) whose pid is dead, or whose directory is already gone,
# and each slot directory with no holder line that is 2 hours old.
# Sessions call this instead of a bare rm under ~/.claude, which raises Claude Code's delete prompt even in bypass mode (dispatcher, 12 Oct).
if [ "${1:-}" = clear-stale ]; then
  for s in run-slot run-slot-2 run-slot-3 run-slot-4 run-slot-commit run-slot-clone run-slot-quick $(ls "$OPS" 2>/dev/null | sed -n 's/^\(run-slot-model-[0-9]*\)\(\.holder\)\{0,1\}$/\1/p' | sort -u); do
    h="$OPS/$s.holder"
    if [ ! -e "$h" ]; then
      [ -d "$OPS/$s" ] && stale "$OPS/$s" "" && rmdir "$OPS/$s" 2>/dev/null && echo "$s: cleared a slot directory with no holder line"
      continue
    fi
    pid=$(cut -d' ' -f2 "$h" 2>/dev/null)
    if printf '%s' "$pid" | grep -Eq '^[0-9]+$' && alive "$pid"; then
      [ -d "$OPS/$s" ] && { echo "$s: held by $(cut -d' ' -f1 "$h") (pid $pid, alive); left alone"; continue; }
    fi
    line=$(cat "$h" 2>/dev/null)
    [ -d "$OPS/$s" ] && rmdir "$OPS/$s" 2>/dev/null
    rm -f "$h" && echo "$s: cleared a stale holder ($line)"
  done
  exit 0
fi
# run-slot.sh preempt: while run-slot.focus stands, TERM the process group of each <slot>.child that focus does not spare, only while it is still its holder's child leading its own group, so an urgent ticket's fix goes first (scripts/ops/README.md)
if [ "${1:-}" = preempt ]; then
  [ $# -eq 1 ] || { echo "usage: run-slot.sh preempt" >&2; exit 2; }
  h=
  switch_on run-slot.focus && read -r h _ 2>/dev/null < "$OPS/run-slot.focus"
  [ -n "$h" ] || { echo "run-slot.sh: no focus stands (run-slot.focus), so preempt stops nothing" >&2; exit 2; }
  for s in run-slot run-slot-2 run-slot-3 run-slot-4 run-slot-commit run-slot-clone run-slot-quick $(ls "$OPS" 2>/dev/null | sed -n 's/^\(run-slot-model-[0-9]*\)\.holder$/\1/p' | sort -u); do
    [ -f "$OPS/$s.holder" ] && read -r who pid _ < "$OPS/$s.holder" || continue
    child=$(cat "$OPS/$s.child" 2>/dev/null)
    printf '%s' "$pid$child" | grep -Eq '^[0-9]+$' || continue
    focus_spares "$h" "$who" && continue
    [ "$(ps -o ppid=,pgid= -p "$child" 2>/dev/null | awk '{print $1, $2}')" = "$pid $child" ] || { echo "$s: $who's run has no child of its holder leading its own group; left alone"; continue; }
    echo "$child" > "$OPS/$s.preempted"
    kill -TERM -- "-$child" 2>/dev/null && echo "$(date -u +%FT%TZ) preempt $who $pid child=$child slot=$s focus=$h" >> "$OPS/run-slot.runs.log" && echo "$s: preempted $who's run (pid $child) for $h's focus"
  done
  exit 0
fi
# run-slot.sh size <who>: print the size and units size_of reads for that session (spawn.sh's load gate counts a start by it)
if [ "${1:-}" = size ]; then
  [ $# -eq 2 ] || { echo "usage: run-slot.sh size <who>" >&2; exit 2; }
  size_of "$2"
  exit
fi
# run-slot.sh set <who> <switch> [<value>] --reason "<why>" [--for <n>m|<n>h]: turn on switch 3-off, 4-off, clone-off, focus, idle-min, load1-max, load5-cap, single,
# or the runner host's off or slot-off, for 4 hours unless --for says; a value (idle-min's bar, load1-max's stop, load5-cap's cap) goes on the line below. A set with no reason is refused
if [ "${1:-}" = set ]; then
  usage='usage: run-slot.sh set <who> <switch> [<value>] --reason "<why>" [--for <n>m|<n>h]'
  [ $# -ge 3 ] || { echo "$usage" >&2; exit 2; }
  who=$2 name=$3 value="" reason="" span=4h
  shift 3
  while [ $# -gt 0 ]; do
    case "$1" in
      --reason) reason=${2:-}; shift; shift ;;
      --for) span=${2:-}; shift; shift ;;
      *) [ -z "$value" ] || { echo "$usage" >&2; exit 2; }; value=$1; shift ;;
    esac
  done
  case "$who" in *[!A-Za-z0-9._#-]*|"") echo "run-slot.sh: <who> is a session name (letters, digits, . _ - #)" >&2; exit 2 ;; esac
  case "$name" in
    off|slot-off) path=runner-host/$name ;;
    3-off|4-off|clone-off|focus|idle-min|load1-max|load5-cap|single) path=run-slot.$name ;;
    *) echo "run-slot.sh: no switch $name (3-off, 4-off, clone-off, focus, idle-min, load1-max, load5-cap, single, off, slot-off)" >&2; exit 2 ;;
  esac
  [ -n "$reason" ] || { echo "run-slot.sh: a set takes --reason \"<why>\", so whoever finds the switch on knows why it stands" >&2; exit 2; }
  case "$span" in [0-9]*m) unit=60 ;; [0-9]*h) unit=3600 ;; *) unit= ;; esac
  n=${span%[mh]}
  case "$n" in ""|*[!0-9]*|0*) unit= ;; esac
  [ -n "$unit" ] || { echo "run-slot.sh: --for takes a count of minutes or hours above 0, such as 30m or 4h" >&2; exit 2; }
  # focus stands 180 minutes at most (dispatcher, 5 Nov: run-slot.focus is approved on that cap)
  [ "$name" != focus ] || [ $((n * unit)) -le 10800 ] || { echo "run-slot.sh: focus stands 180 minutes at most" >&2; exit 2; }
  iso() { date -u -d "@$1" +%FT%TZ 2>/dev/null || date -u -r "$1" +%FT%TZ; }
  at=$(date +%s)
  ends=$(iso $((at + n * unit)))
  mkdir -p "$(dirname "$OPS/$path")"
  { echo "$who $(iso "$at") $ends $(printf '%s' "$reason" | tr '\n' ' ')"; [ -z "$value" ] || echo "$value"; } > "$OPS/$path.set-$$" && mv "$OPS/$path.set-$$" "$OPS/$path" || exit 1
  # a load throttle set now holds for lifted's full 5 minutes under the cap
  case "$name" in 3-off|4-off|single) rm -f "$OPS/run-slot.under" ;; esac
  echo "run-slot.sh: $path is on until $ends"
  exit 0
fi
# every read subcommand below sets CAN_TAKE, so quick_kind never sends its bare true down the quick lane (run-slot-can-take.test.ts runs each)
# run-slot.sh can-take <slot> <who>: exit 0 when that slot is free, its off-switches, load rules, the battery's and focus's holds and burst_held open it, and unit_fits passes (the
# session's units and reserve, or a queue ticket's own when <who> names one, as ops-unstick asks for the head), else 1, so a script that takes its
# slot itself reads them as every run here does (localci and the merge train still take theirs by their own mkdir for now); it reads no queue order and no other waiter, only the ticket it is given, and run-slot.priority only through may_reserve's reserve
CAN_TAKE=
# run-slot.sh head: prints the queue's head, the ticket first_waiter names (<ns>-<pid>-<who>), or nothing, so ops-unstick watches the waiter the queue serves next rather than the oldest
HEAD_ONLY=
if [ "${1:-}" = head ]; then
  [ $# -eq 1 ] || { echo "usage: run-slot.sh head" >&2; exit 2; }
  HEAD_ONLY=1 CAN_TAKE=run-slot
  set -- ops-unstick -- true
fi
# run-slot.sh slots: prints how many of run-slot to run-slot-4 are held or open now by the load rules and off-switches, the heavy-job cap ops-unstick reads
SLOTS_ONLY=
if [ "${1:-}" = slots ]; then
  [ $# -eq 1 ] || { echo "usage: run-slot.sh slots" >&2; exit 2; }
  SLOTS_ONLY=1 CAN_TAKE=run-slot
  set -- ops-unstick -- true
fi
# run-slot.sh room: prints "<lanes> <held> <free> <waiters>": the lanes slots counts, how many a run holds, how many the queue's next run can take now (the open, unheld ones while unit_fits passes for first_waiter's ticket, or a medium with no waiter; none while waiters wait and none can start, and none while the battery's or focus's hold stands), and the live tickets in the queue, which spawn.sh's slots gate reads
# run-slot.sh kind -- <command>: print the lane run-slot picks for that command (refuse for a run it refuses, docker for a docker build, else quick_kind's clone, commit, quick, or nothing for the queue) and exit, with no ask line, ticket or holder and nothing run, so a lane question reads run-slot's own pick
KIND_ONLY=
if [ "${1:-}" = kind ]; then
  [ $# -ge 3 ] && [ "$2" = -- ] || { echo "usage: run-slot.sh kind -- <command> [args...]" >&2; exit 2; }
  KIND_ONLY=1
  set -- run-slot-kind "${@:2}"
fi
ROOM_ONLY=
if [ "${1:-}" = room ]; then
  [ $# -eq 1 ] || { echo "usage: run-slot.sh room" >&2; exit 2; }
  ROOM_ONLY=1 CAN_TAKE=run-slot
  set -- ops-unstick -- true
fi
CAN_TICKET=
if [ "${1:-}" = can-take ]; then
  [ $# -eq 3 ] || { echo "usage: run-slot.sh can-take <slot> <who>" >&2; exit 2; }
  case "$2" in run-slot|run-slot-2|run-slot-3|run-slot-4) CAN_TAKE=$2 ;; *) echo "run-slot.sh: no slot $2" >&2; exit 2 ;; esac
  w=$3
  # a ticket-shaped name whose file is gone (its waiter just started) is no one's run to answer for, so it cannot take the slot (review round 1)
  if [[ "$3" =~ ^[0-9]+-[0-9]+-. ]]; then [ -f "$OPS/run-slot.waiters/$3" ] || exit 1; CAN_TICKET=$3; w=${3#*-*-}; fi
  set -- "$w" -- true
fi
MODEL_BOUND=
AFTER=
while [ -z "$CAN_TAKE" ]; do
  case "${2:-}" in
    --model-bound) MODEL_BOUND=1; set -- "$1" "${@:3}" ;;
    --after)
      case "${3:-}" in 0*|1) echo "run-slot.sh: --after $3 names no run (a pid of 0 or 1 is never a run's, and kill -0 0 always succeeds), so this run never waits: give the pid on the first run's ask line" >&2; exit 2 ;; esac
      case "${3:-}" in ''|*[!0-9]*) echo "run-slot.sh: --after takes the pid on the first run's ask line in run-slot.runs.log (ask <who> <pid>)" >&2; exit 2 ;; esac
      AFTER=$3; set -- "$1" "${@:4}" ;;
    *) break ;;
  esac
done
if [ $# -lt 3 ] || [ "$2" != "--" ]; then
  echo "usage: run-slot.sh <who> [--model-bound] [--after <pid>] -- <command> [args...]" >&2
  exit 2
fi
WHO=$1
shift 2
case "$WHO" in *[!A-Za-z0-9._#-]*|"") echo "run-slot.sh: <who> is a session name (letters, digits, . _ - #)" >&2; exit 2 ;; esac
# every run drops each expired switch, so the readers that only look for the file (the merge train, Checks, the leads' sweep) find it gone too
[ -n "$KIND_ONLY" ] || for s in $SWITCHES; do switch_on "$s"; done
# a dev stack never ends, so it would hold a slot for hours (dispatcher, 19 Oct: a tester's `bun run dev` held run-slot.single with 7 waiters)
for a in "$@"; do
  case "$a" in dev|dev:*) [ -z "$KIND_ONLY" ] || { echo refuse; exit 0; }; echo "run-slot.sh: a dev stack runs as a background task under the load gate, not through run-slot" >&2; exit 2 ;; esac
done
# dispatcher, 18 Oct: a command that never exits holds its slot until it is stopped (keen-ledger's dev stack held one from 21:13Z to 21:58Z)
if printf ' %s' "$@" | grep -qE ' (bun|npm|pnpm|yarn) run dev( |$)| next dev( |$)| ingest .*--follow| --watch(=| |$)'; then
  [ -z "$KIND_ONLY" ] || { echo refuse; exit 0; }
  echo "run-slot.sh: $* never exits, so it would hold a slot until stopped (slots): start a fixture stack outside run-slot, only while you take shots" >&2
  exit 2
fi
# zsh does not word-split an unquoted variable, so `run-slot.sh <who> -- pytest $FILES` passed 18 paths as one argument and ran none; REREAD skips it, so a waiter running a newer copy warns once
if [ -z "$REREAD" ]; then
  for a in "$@"; do
    case "$a" in
      *[[:space:]]*)
        read -r -d '' -a words <<< "$a"
        if [ ${#words[@]} -ge 2 ]; then
          for w in "${words[@]}"; do
            [ -e "$w" ] || continue 2
          done
          echo "run-slot.sh: '$a' is one argument holding only existing paths, which zsh did not word-split: pass them as separate words (\${=VAR} in zsh, or xargs)" >&2
        fi
        ;;
    esac
  done
fi
# --after <pid>: a run that needs <who>'s run <pid> to land first waits here, with no ask line, ticket or slot, until that run's end line: rc=0 asks, any other rc exits with it, and a pid gone with no end line exits 2 (4 Nov: a run that polled for another inside its slot held run-slot-2 for 1575 s while that run sat behind it in the queue)
# the last state of <who>'s run $1 in run-slot.runs.log: pending (asked, no end yet), ended <rc>, or none
after_state() {
  tail -n 20000 "$OPS/run-slot.runs.log" 2>/dev/null | W=$WHO P=$1 awk '
    $3 == ENVIRON["W"] && $4 == ENVIRON["P"] { if ($2 == "ask") s = "pending"; else if ($2 == "end") s = "ended " substr($5, 4) }
    END { print (s == "" ? "none" : s) }'
}
if [ -n "$AFTER" ] && [ -z "$REREAD" ]; then
  told=
  while :; do
    gone=
    alive "$AFTER" || gone=1
    st=$(after_state "$AFTER")
    case "$st" in
      "ended 0") break ;;
      ended\ *) echo "run-slot.sh: $WHO's run $AFTER ended rc=${st#ended }, so this run never asks" >&2; exit "${st#ended }" ;;
    esac
    if [ -n "$gone" ]; then
      echo "run-slot.sh: $WHO's run $AFTER has ended with no end line in run-slot.runs.log (a runner-host run, or one stopped hard), so this run never asks: read that run's result, then run this one again" >&2
      exit 2
    fi
    [ -n "$told" ] || { echo "run-slot.sh: waiting for $WHO's run $AFTER to end before this one asks (--after)" >&2; told=1; }
    sleep "${RUN_SLOT_POLL:-5}"
  done
  ASKED=$(date +%s)
fi
# bun run pr:merge or pr:train, as the whole command, runs at once outside the queue once any --after wait ends, since a merge carries its own gates and its type steps take their own slots (5 Nov: three wrapped merges in an hour each waited behind the heavy queue, and each inner type step queued again)
# the same words behind leading env and VAR=x words, bun's --cwd <dir>, --cwd=<dir>, --silent and --no-env-file flags and a bun run --silent pass too, exec'd whole so the merge's env rides along (7 Nov: env NODE_ENV=production SKIP_ENV_VALIDATION=true bun run pr:merge 1418 asked at 14:35:13Z and again at 15:13:13Z with no start line either time, so it waited at least the 38 minutes between the asks), and so does the direct bun [--no-env-file] packages/scripts/src/pr-merge/{cli,train-cli}.ts call, the step bun run pr:merge and pr:train expand to; no caller wraps it in run-slot, since the train and merge-on-ready merge through pr:merge's own modules
# every other form keeps its place in the queue as any run does: the inline bash -c chain holding the merge that day queued 6 s (7 Nov, 05:39:56Z), and a chain script keeps the pin run-slot-merge-now.test.ts holds; matching inside shell text would be a bypass treadmill
merge_pass() {
  local i=1 n=$# w
  while [ $i -le $n ]; do
    w=${!i}
    case "$w" in
      env | [A-Za-z_]*=*) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  [ "${!i:-}" = bun ] || return 1
  i=$((i + 1))
  while [ $i -le $n ]; do
    case "${!i}" in
      --cwd) i=$((i + 2)) ;;
      --cwd=* | --no-env-file | --silent) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  # the direct cli call, the step bun run pr:merge and pr:train expand to, names its file in place of run
  case "${!i:-}" in
    pr:merge | pr:train) MERGE_NAME=${!i}; return 0 ;;
    *pr-merge/cli.ts) MERGE_NAME=pr:merge; return 0 ;;
    *pr-merge/train-cli.ts) MERGE_NAME=pr:train; return 0 ;;
  esac
  [ "${!i:-}" = run ] || return 1
  i=$((i + 1))
  while [ $i -le $n ]; do
    case "${!i}" in
      --silent) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  case "${!i:-}" in
    pr:merge | pr:train) MERGE_NAME=${!i}; return 0 ;;
  esac
  return 1
}
if [ -z "$KIND_ONLY" ] && merge_pass "$@"; then
  echo "run-slot.sh: bun run $MERGE_NAME runs at once, outside the queue: a merge carries its own gates, and its type steps take their own slots (packages/scripts/src/pr-merge/README.md)" >&2
  exec "$@" 3<&-
fi
# dispatcher, 18 Oct: a test, type check (from the checkout's root), lint or format check runs on the runner host, taking no slot here. ci.sh exec
# sends the working tree, tracked edits and untracked source alike, and gives back the command's output and exit code; anything else (a browser,
# verify, an install, a dev stack) waits for a slot here, and so does a run the box cannot take (ci.sh exits 255, as on an untracked file it does not take).
# The box has no /private/tmp, so a run that sets TMPDIR to a Mac path takes RUN_SLOT_HERE=1.
# runner-host/off and runner-host/slot-off turn it off; every box run is a line in runner-host/runs.log.
box_dir() {
  local prev="" a
  for a in "$@"; do
    case "$a" in --cwd=*) echo "${a#--cwd=}"; return ;; esac
    case "$prev" in --cwd|-C) echo "$a"; return ;; esac
    prev=$a
  done
  pwd
}
box_fits() {
  local a first="" line=" $* "
  # RUN_SLOT_HERE=1, in run-slot's environment or as an env word of the command, keeps the run on this Mac (builder, 19 Oct: a Mac rerun of a red seen only on the box)
  [ -n "${RUN_SLOT_HERE:-}" ] && return 1
  for a in "$@"; do case "$a" in RUN_SLOT_HERE=?*) return 1 ;; esac; done
  for a in "$@"; do
    case "$a" in env|*=*) continue ;; esac
    first=$a
    break
  done
  case "$first" in bun|bunx) ;; *) return 1 ;; esac
  # a build's output is this Mac's dist, so a build stays here (worker-firm-keel, 19 Oct)
  printf '%s' "$line" | grep -qE ' (test|run test|test:file|check-types|run check-types|lint|run lint|test:skills|run test:skills|format:check|run format:check)( |$)' || return 1
  if printf '%s' "$line" | grep -qE ' (check-types|run check-types)( |$)'; then
    local d p
    d=$(box_dir "$@")
    # a type check goes only from a checkout's root: one from a subfolder (--cwd=<wt>/web/next) reads the other workspaces' dist, which the box lacks (worker-firm-keel, 19 Oct: 332 false errors)
    [ -e "$d/.git" ] || return 1
    # a type check here also builds this checkout's packages/*/dist, which a later run on the Mac imports, so it stays here while one is missing (round 2); this checks that a dist exists, not that it is fresh
    for p in "$d"/packages/*/package.json; do
      grep -q '"build"' "$p" 2>/dev/null && [ ! -d "$(dirname "$p")/dist" ] && return 1
    done
  fi
  # a word that needs this Mac (a browser, a stack, docker, an install) keeps the run here; a path is judged only as an e2e test (a review's finding)
  for a in "$@"; do
    case "$a" in
      */*) case "$a" in *.e2e.*) return 1 ;; esac ;;
      *verify*|*e2e*|*install*|*shadcn*|*playwright*|agent-browser|--watch|dev|dev:*|*docker*) return 1 ;;
    esac
  done
}
# runner-host/slot-off keeps run-slot's runs here and leaves the box to Checks (ops, 20 Oct: 19 one-file runs queued ahead of 3 gate suites on its 2 slots)
if [ -z "$KIND_ONLY" ] && [ -z "$CAN_TAKE" ] && [ -z "$MODEL_BOUND" ] && [ -x "$OPS/runner-host/ci.sh" ] && ! switch_on runner-host/off && ! switch_on runner-host/slot-off && box_fits "$@"; then
  BOXDIR=$(box_dir "$@")
  # the box runs BOXDIR's checkout, so a path in another one would run in the wrong tree there and go red as "Script not found" (9jhtsd, 24 Oct)
  checkout_of() {
    local d=$1
    while [ ! -d "$d" ] && [ "$d" != / ]; do d=$(dirname "$d"); done
    d=$(cd "$d" 2>/dev/null && pwd -P) || return
    while [ "$d" != / ] && [ ! -e "$d/.git" ]; do d=$(dirname "$d"); done
    [ "$d" != / ] && echo "$d"
  }
  here=$(checkout_of "$BOXDIR")
  for a in "$@"; do
    case "$a" in /*) there=$(checkout_of "$a") ;; *) continue ;; esac
    if [ -n "$there" ] && [ "$there" != "$here" ]; then
      echo "run-slot.sh: $a is in the checkout $there, but the runner host runs ${here:-$BOXDIR}'s: run from inside $there, or pass --cwd $there" >&2
      exit 2
    fi
  done
  echo "run-slot.sh: $WHO runs this on the runner host, with no slot here" >&2
  echo "$(date -u +%FT%TZ) start $WHO $BOXDIR $*" >> "$OPS/runner-host/runs.log"
  bash "$OPS/runner-host/ci.sh" exec "$BOXDIR" -- "$@"
  rc=$?
  echo "$(date -u +%FT%TZ) end $WHO rc=$rc" >> "$OPS/runner-host/runs.log"
  [ "$rc" -ne 255 ] && exit "$rc"
  echo "run-slot.sh: the runner host could not take it, so it waits for a slot here" >&2
fi
# A `sh -c`, `bash -c`, `zsh -c`, `dash -c` or `ksh -c` chain's steps, or a `bash <script file>`'s, behind any CHAIN_WRAPPERS words, which come out as a step of their own, one a line, each step's words joined by \x1f, as shlex splits the script at each run of &, |, ;, <, > and parentheses (5 Nov: a script that only commits waited in the general queue); see scripts/ops/README.md's commit lane for the comment, \ and newline reads, the cd and env-word steps, the -e, -u, -x, -v and -o pipefail options read past after -c, and the quoted ?, *, [, {, # and ~ each held as \x02 to \x07, and nothing for any other command, a docker or podman one included (exit 0), or for a chain it cannot read (exit 1: an option word it does not read, an option word before a file, a file it cannot read, a script holding a raw \x02 to \x07 byte, one shlex cannot split or one over 64 KB, or a first word it cannot place before a shell word), its steps with exit 3 for a chain with a program word, in any step, written as an unquoted glob or brace that can expand to docker or podman, and its steps with exit 1 for a chain with a step that eval or a $ word runs, past VAR=x words or behind a wrapper, a step holding a chain shell word anywhere (a nested chain, a script file or a shell fed its script on stdin), a program word, or the program word behind a wrapper (every later word past an option its list lacks), written as an unquoted brace or a glob that can expand to a shell or a wrapper, or with a command substitution beside docker, podman or a portless compose
# the wrappers chain_steps reads past to the program they run, A to Z, each as <name>|<flags>|<options that take a value>, and the ones that take one count or duration before it: scripts/hooks/shell.ts's WRAPPERS and COUNTED, with the env and xargs options its parse reads by hand, which a test holds equal
CHAIN_WRAPPER_OPTIONS="builtin||
busybox||
caffeinate|-d -i -m -s -u|-t -w
command|-p -V -v|
doas|-L -n -s|-a -C -u
env|-0 -i -v --debug --ignore-environment --null|-C -P -S -u --chdir --unset
exec|-c -l|-a
nice||-n --adjustment
nocorrect||
noglob||
nohup||
pkexec|--disable-internal-agent --help --keep-cwd --version|--user
repeat||
stdbuf||-e -i -o --error --input --output
sudo|-A -B -b -E -e -H -i -K -k -l -N -n -P -S -s -V -v --askpass --background --bell --edit --help --list --login --non-interactive --preserve-env --preserve-groups --remove-timestamp --reset-timestamp --set-home --shell --stdin --validate --version|-C -D -g -h -p -R -r -T -t -U -u --chdir --chroot --close-from --command-timeout --group --host --other-user --prompt --role --type --user
time|-a -h -l -p -q -V -v --append --portability --quiet --verbose|-f -o --format --output
timeout|-f -p -v --foreground --preserve-status --verbose|-k -s --kill-after --signal
xargs|-0 -i -o -p -r -t -x --exit --interactive --no-run-if-empty --null --open-tty --replace --show-limits --verbose|-a -d -E -I -J -L -n -P -R -S -s --arg-file --delimiter --max-args --max-chars --max-lines --max-procs --process-slot-var
"
CHAIN_COUNTED="repeat timeout"
CHAIN_WRAPPERS=
while IFS='|' read -r CHAIN_NAME _; do [ -n "$CHAIN_NAME" ] && CHAIN_WRAPPERS+="$CHAIN_NAME "; done <<< "$CHAIN_WRAPPER_OPTIONS"
CHAIN_SHELLS="sh bash zsh dash ksh"
# where a wrapper's option word leaves its value, as shell.ts's optionValue reads it: own when it takes none or carries it, next when the next word is its value, end for --, and nothing for an option the wrapper's list lacks
wrapper_option() {
  local w=$2 flags values k c n
  [ "$w" = -- ] && { echo end; return; }
  while IFS='|' read -r n flags values; do [ "$n" = "$1" ] && break; done <<< "$CHAIN_WRAPPER_OPTIONS"
  flags=" $flags " values=" $values "
  if [ "${w#--}" != "$w" ]; then
    n=${w%%=*}
    case "$values" in *" $n "*) if [ "$n" = "$w" ]; then echo next; else echo own; fi; return ;; esac
    case "$flags" in *" $n "*) echo own ;; esac
    return
  fi
  # nice's own -<number> is its adjustment
  if [ "$1" = nice ] && [[ "$w" =~ ^-[0-9]+$ ]]; then echo own; return; fi
  for ((k = 1; k < ${#w}; k++)); do
    c=-${w:k:1}
    case "$values" in *" $c "*) if [ "$k" -eq $((${#w} - 1)) ]; then echo next; else echo own; fi; return ;; esac
    case "$flags" in *" $c "*) ;; *) return ;; esac
  done
  echo own
}
chain_steps() {
  local a b first="" script="" next="" file="" opt="" lead="" oval="" wrapped="" unplaced="" value="" ended="" count=""
  for a in "$@"; do
    if [ -n "$next" ]; then
      if [ -n "$oval" ]; then [ "$a" = pipefail ] || return 1; oval=""; continue; fi
      case "$a" in -o | +o) oval=1; continue ;; - | + | [-+]*[!euxv]*) return 1 ;; [-+]*) continue ;; esac
      script=$a; break
    fi
    [ -n "$file" ] && break
    # an unplaced first word runs a program this cannot read, so a shell word after it runs a script this cannot read too (its -c script, a script file or stdin), whatever follows it
    if [ -n "$unplaced" ]; then
      case " $CHAIN_SHELLS " in *" $(basename -- "$a" | tr '[:upper:]' '[:lower:]') "*) return 1 ;; esac
      continue
    fi
    if [ -z "$first" ]; then
      # a wrapper's options, their values, its count and VAR=x words sit before its program, and come out as a step of their own, as env words do; a wrapper option's value is never its program
      if [ -n "$value" ]; then value=""; lead+=$a$'\x1f'; continue; fi
      if [ -n "$wrapped" ] && [ -z "$ended" ] && [ "${a#-}" != "$a" ] && [ "$a" != - ]; then
        # env's split string holds its program inside one word
        if [ "$wrapped" = env ]; then case "$a" in -S* | -[0iv]*S* | --split-string | --split-string=*) return 1 ;; esac; fi
        case "$(wrapper_option "$wrapped" "$a")" in
          own) ;;
          next) value=1 ;;
          end) ended=1 ;;
          # an option the wrapper's list lacks may take the next word, so the program after it is one this cannot place
          *) unplaced=1; continue ;;
        esac
        lead+=$a$'\x1f'; continue
      fi
      if [[ "$a" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then lead+=$a$'\x1f'; continue; fi
      if [ -n "$count" ]; then count=""; lead+=$a$'\x1f'; continue; fi
      # in lower case, since macOS's default disk runs a program named in any case
      b=$(basename -- "$a" | tr '[:upper:]' '[:lower:]')
      case " $CHAIN_SHELLS " in *" $b "*) first=$b; continue ;; esac
      # docker and podman are judged by docker_reader on their own argv, so a container's shell is no chain of this machine's
      case "$b" in docker|podman) return 0 ;; esac
      if [[ " $CHAIN_WRAPPERS " == *" $b "* ]]; then
        wrapped=$b ended=""
        case " $CHAIN_COUNTED " in *" $b "*) count=1 ;; esac
        lead+=$a$'\x1f'; continue
      fi
      unplaced=1; continue
    fi
    case "$a" in -c | -[!-]*c) next=1 ;; -*) opt=1 ;; *) [ -z "$opt" ] || return 1; file=$a ;; esac
  done
  [ -n "$first" ] || return 0
  if [ -n "$file" ]; then plain "$file" && [ -f "$file" ] && [ -r "$file" ] || return 1; fi
  [ -n "$script$file" ] || return 1
  python3 -I - "${file:+-f}${script:+-c}" "$file$script" "${lead%$'\x1f'}" "$CHAIN_WRAPPERS" "$CHAIN_SHELLS" "$CHAIN_WRAPPER_OPTIONS" "$CHAIN_COUNTED" <<'PY'
import fnmatch, os, re, shlex, sys

try:
    text = sys.argv[2]
    if sys.argv[1] == "-f":
        with open(text, encoding="utf-8") as f:
            text = f.read(65537)
        if len(text) > 65536:
            sys.exit(1)
    lines, buf, quoted = [], None, ""

    # cut each line at its trailing comment (an unquoted word-start #), carrying the quote state across lines
    def scan(line, quoted, prev):
        esc = False
        for i, c in enumerate(line):
            if esc:
                esc = False
            elif c == "\\" and quoted != "'":
                esc = True
            elif c == quoted:
                quoted = ""
            elif not quoted and c in "'\"":
                quoted = c
            elif not quoted and c == "#" and (
                line[i - 1] in " \t;&|()" if i else (not prev or prev in " \t;&|()")
            ):
                return line[:i], quoted
        return line, quoted

    for line in text.split("\n"):
        # prev is the character the join puts before this line's first, since bash joins x\ and #b into x#b, whose # starts no word
        line, quoted = scan(line, quoted, buf[-1] if buf else "")
        if buf is None and not quoted and line.strip() == "":
            continue
        buf = line if buf is None else buf + line
        if (len(buf) - len(buf.rstrip("\\"))) % 2:
            buf = buf[:-1]
            continue
        lines.append(buf)
        buf = None
    text = "\n".join(lines + ([buf] if buf is not None else []))
    raw = text
    # each ?, *, [, {, # or ~ inside quotes or after a backslash becomes \x02 to \x07, which sh leaves as written, so plain() tells a quoted message's from one sh expands
    held, out, quote, esc = "?*[{#~", [], "", False
    if any(chr(n) in text for n in range(2, 8)):
        sys.exit(1)
    for c in text:
        lit = quote or esc
        if esc:
            esc = False
        elif c == "\\" and quote != "'":
            esc = True
        elif c == quote:
            quote = ""
        elif not quote and c in "'\"":
            quote = c
        out.append(chr(2 + held.index(c)) if lit and c in held else c)
    text = "".join(out)
    lex = shlex.shlex(text.replace("\n", "\n;"), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = ""
    steps, seps = [[]], [""]
    for tok in lex:
        if tok and not tok.strip("&|;<>()"):
            steps.append([])
            seps.append(tok)
        else:
            steps[-1].append(tok)
except (OSError, ValueError):
    sys.exit(1)
seps.append("")
if sys.argv[3]:
    print(sys.argv[3])
for i, step in enumerate(steps):
    if step[:1] == ["cd"]:
        step += [s for s in (seps[i], seps[i + 1]) if s not in ("", "&&", ";")]
        # a cd after && or || may not have run when a later step that any other separator than && joins runs
        later = [s for s in seps[i + 1 :] if s not in ("", "&&")]
        if seps[i] in ("&&", "||") and later:
            step += [seps[i], later[0]]
    if step:
        print("\x1f".join(step))
# a step that eval or a $ word runs, past VAR=x or behind a wrapper word, a step holding a chain shell word (a nested chain, a script file or a script on stdin), or a command substitution in a chain whose script or lead words name docker, podman or a portless compose (shlex splits a backquote's inner script at ;, so a name split across its steps is read over the whole chain), names its program only when the shell runs it, so the chain prints its steps but reads as one it cannot read
wrappers = set(sys.argv[4].split())
shells = set(sys.argv[5].split())


options = {n: (set(f.split()), set(v.split())) for n, f, v in (l.split("|") for l in sys.argv[6].splitlines() if l)}
counted = set(sys.argv[7].split())


# the words a step runs as its program, past VAR=x and, as wrapper_option reads them, each wrapper's options, their values and its count; past an option a wrapper's list lacks, every later word, failing closed
def programs(step, i):
    words = []
    while i < len(step):
        w = step[i]
        words.append(w)
        name = os.path.basename(w).lower()
        if name not in wrappers:
            return words
        flags, values = options.get(name, (set(), set()))
        i += 1
        while i < len(step) and re.match(r"[A-Za-z_][A-Za-z0-9_]*=", step[i]):
            i += 1
        while i < len(step) and ((step[i].startswith("-") and step[i] != "-") or re.match(r"[A-Za-z_][A-Za-z0-9_]*=", step[i])):
            o = step[i]
            i += 1
            if not o.startswith("-"):
                continue
            if o == "--":
                break
            key = o.split("=")[0] if o.startswith("--") else None
            if key is not None:
                if key in values and key == o:
                    i += 1
                elif key not in values and key not in flags:
                    return words + step[i:]
            elif name == "nice" and o[1:].isdigit():
                pass
            else:
                for k, c in enumerate(o[1:], 1):
                    if "-" + c in values:
                        i += k == len(o) - 1
                        break
                    if "-" + c not in flags:
                        return words + step[i:]
        while i < len(step) and re.match(r"[A-Za-z_][A-Za-z0-9_]*=", step[i]):
            i += 1
        if name in counted:
            i += 1
    return words


# a word's brace expansions, as bash makes them from a comma list or a one-letter or number range, innermost first, up to 4096 words; a brace it cannot expand stays as written
def braces(w):
    m = re.search(r"\{([^{}]*)\}", w)
    r = m and re.fullmatch(r"(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.-?\d+)?", m.group(1))
    if m and "," in m.group(1):
        parts = m.group(1).split(",")
    elif r and r[1].isalpha() == r[2].isalpha():
        a, b = (ord(r[1]), ord(r[2])) if r[1].isalpha() else (int(r[1]), int(r[2]))
        parts = (chr(n) if r[1].isalpha() else str(n) for n in range(a, b + (1 if b >= a else -1), 1 if b >= a else -1))
    else:
        return [w]
    out = []
    for p in parts:
        if len(out) >= 4096:
            break
        out += braces(w[: m.start()] + p + w[m.end() :])
    return out


# a word an unquoted glob or brace can expand to one of names with, by basename; a bracket holding [:, [= or [. (a class fnmatch does not read) can expand to any, failing closed
def can_be(w, names):
    for e in braces(w):
        p = os.path.basename(e).replace("[^", "[!")
        if re.search(r"\[[^\]]*\[[:=.]", p) or any(fnmatch.fnmatchcase(n, p) for n in names):
            return True
    return False


reserved = {"!", "{", "coproc", "do", "elif", "else", "function", "if", "then", "until", "while"}
unread = any("$(" in w or "`" in w for step in steps for w in step) and re.search(r"\b(docker|podman)\b|\bportless\b.*\bcompose\b", text + "\x1f" + sys.argv[3], re.I)
# a command substitution's script ($( ) or a backquote, outside single quotes and $'…', where a backslash escapes a quote), split at blanks, quotes and ; | & ( ) < > with backslashes dropped: a glob or brace in it that can expand to docker, podman or a chain shell reads as one it cannot read, wherever it sits (a case word or pattern, or a word it does not lead), so docker_kind reads its pieces
subs, j, quote = [], 0, ""
while j < len(raw):
    c = raw[j]
    if c == "\\" and quote != "'":
        j += 2
        continue
    if not quote and raw.startswith("$'", j):
        quote, j = "$", j + 2
        continue
    if (c == "'" and quote == "$") or (c in "'\"" and quote in ("", c)):
        quote = "" if quote else c
    elif quote not in ("'", "$") and (c == "`" or raw.startswith("$(", j)):
        end, depth, inner = j + (1 if c == "`" else 2), 1, ""
        while end < len(raw) and depth:
            if raw[end] == "\\" and inner != "'":
                end += 1
            elif inner == '"' and (raw[end] == "`" or raw.startswith("$(", end)):
                end = len(raw)
                break
            elif inner:
                inner = "" if raw[end] == ("'" if inner == "$" else inner) else inner
            elif c != "`" and raw.startswith("$'", end):
                inner, end = "$", end + 1
            elif raw[end] in "'\"" and c != "`":
                inner = raw[end]
            elif c == "`":
                depth -= raw[end] == "`"
            else:
                depth += (raw[end] == "(") - (raw[end] == ")")
            end += 1
        # a ) its count cannot place (a case pattern's, a heredoc body's, a comment's, one in a ${…}, one after a $( or backquote inside a double quote in it) may end it early, so one holding case, <<, # or ${, or such a quoted substitution (above), reads to the script's end, failing closed
        if re.search(r"(^|[\s;&|()`])(case(\s|$)|#)|<<|\$\{", raw[j + 1 : end]):
            end = len(raw)
        subs.append(raw[j + 1 : end])
        j = end
        continue
    j += 1
for w in re.split(r"[\s;|&()<>\"'`]+", " ".join(subs).replace("\\", "")):
    brace = "{" in w and re.search(r",|\.\.", w)
    if (brace or re.search(r"[*?[]", w)) and can_be(w, {"docker", "podman"} | shells):
        unread = True
# each open case's state: pat while its patterns run (after `case … in`, or after ;;, ;& or ;;&, through each | up to the closing )), cmd for the arm's commands after that )
cases = []
for k, step in enumerate(steps):
    # past VAR=x and the reserved words that lead a command (if, then, do, !, coproc, function and its name, and the rest)
    i = 0
    while i < len(step) and (re.match(r"[A-Za-z_][A-Za-z0-9_]*=", step[i]) or step[i] in reserved):
        i += 2 if step[i] == "function" else 1
    head = step[i] if i < len(step) else None
    if head == "esac" and cases:
        cases.pop()
        if cases and seps[k + 1] in (";;", ";&", ";;&"):
            cases[-1] = "pat"
        continue
    # a pattern names no program, so `*)` reads as no glob of one; the case line itself names none either, and may hold the first pattern
    if (cases and cases[-1] == "pat") or head == "case":
        if head == "case":
            cases.append("pat")
        if step and seps[k + 1] == ")" and (head != "case" or len(step) - i > 3):
            cases[-1] = "cmd"
        continue
    if cases and seps[k + 1] in (";;", ";&", ";;&"):
        cases[-1] = "pat"
    hidden = lambda w: w == "eval" or "$" in w
    if i < len(step) and (hidden(step[i]) or (os.path.basename(step[i]).lower() in wrappers and any(map(hidden, step[i + 1 :])))):
        unread = True
    # a chain shell word (in any letter case) anywhere past VAR=x, whatever program leads the step, runs a script this does not read: its own -c script (a nested chain, split only one level), a script file, or one fed on stdin (a pipe, a < redirect or a heredoc), behind any option, value or fd number, so it reads as one it cannot read
    if any(os.path.basename(w).lower() in shells for w in step[i:]):
        unread = True
    # the program word, or the program word behind a wrapper (every later word past an option its list lacks), written as an unquoted glob or brace runs whatever the shell expands it to: one that can expand to docker or podman exits 3 in any step, however unreadable the rest, which docker_kind refuses, and a brace, or a glob that can expand to a shell or a wrapper, reads as one it cannot read
    for w in programs(step, i):
        brace = "{" in w and re.search(r",|\.\.", w)
        if not brace and not re.search(r"[*?[]", w):
            continue
        if can_be(w, ("docker", "podman")):
            sys.exit(3)
        if brace or can_be(w, shells | wrappers):
            unread = True
sys.exit(1 if unread else 0)
PY
}
# a git run's subcommand, past env, VAR=x and git's own options, each of -C, -c, --git-dir, --work-tree, --namespace and --config-env with its value; nothing for a step that runs no git
git_verb() {
  local a state=lead
  for a in "$@"; do
    case "$state" in
      lead) case "$a" in env|*=*) continue ;; esac; [ "$(basename -- "$a")" = git ] || return; state=git ;;
      git) case "$a" in -C | -c | --git-dir | --work-tree | --namespace | --config-env) state=value ;; -*) ;; *) echo "$a"; return ;; esac ;;
      value) state=git ;;
    esac
  done
}
# a word sh would leave as written, with no $, backquote, ~, glob, brace or # (a comment to sh, which shlex keeps as a word), quoted or not, so the word run-slot reads is the word the command gets; a ( stays, since chain_steps splits at each unquoted one (a type(scope): message)
plain() { local a; said "$@" || return 1; for a in "$@"; do case "$a" in *[$'\x02\x03\x04\x05\x06\x07']*) return 1 ;; esac; done; }
# a commit message word: as plain, but a ?, *, [, {, # or ~ that chain_steps found quoted is the message's own text (a `closes` line naming an issue), which no git step reads as a path
said() { local a; for a in "$@"; do case "$a" in *'$'* | *'`'* | *'~'* | *'*'* | *'?'* | *'['* | *'{'* | *'#'*) return 1 ;; esac; done; }
# a chain step's words as its script wrote them, each held \x02 to \x07 back to its ?, *, [, {, # or ~
shown() { local t=$1 c n=2; for c in '?' '*' '[' '{' '#' '~'; do t=${t//$(printf "\\$(printf %o $n)")/$c}; n=$((n + 1)); done; printf '%s' "$t"; }
# whether a git commit's words are plain but for its -m or --message value, which said() reads; another option's value and every word after -- are paths, read as plain
commit_words() {
  local w f c next=""
  for w in "$@"; do
    case "$next" in
      msg) said "$w" || return 1; next=""; continue ;;
      val) plain "$w" || return 1; next=""; continue ;;
      paths) plain "$w" || return 1; continue ;;
    esac
    case "$w" in
      --) next=paths ;;
      -m | --message) next=msg ;;
      --message=*) said "$w" || return 1 ;;
      --author | --cleanup | --date | --file | --fixup | --pathspec-from-file | --reedit-message | --reuse-message | --squash | --template | --trailer) next=val ;;
      -[!-]*) f=${w#-}
        while [ -n "$f" ]; do c=${f:0:1}; f=${f:1}
          case "$c" in
            m) if [ -z "$f" ]; then next=msg; else said "$w" || return 1; fi; continue 2 ;;
            [CFct]) [ -z "$f" ] && next=val; break ;;
            [uS]) break ;;
          esac
        done
        plain "$w" || return 1 ;;
      *) plain "$w" || return 1 ;;
    esac
  done
}
# a chain's git add words, failing closed (builder, 5 Nov): paths, and only the flags whose staging chain_add reads, never -f, which stages ignored files
add_flags() {
  local w skip=""
  for w in "$@"; do
    [ -z "$skip" ] || { skip=""; continue; }
    case "$w" in
      --) break ;;
      --pathspec-from-file) skip=1 ;;
      -A | --all | -u | --update | -v | --verbose | -n | --dry-run | -N | --intent-to-add | -p | --patch | --pathspec-from-file=*) ;;
      -*) return 1 ;;
    esac
  done
  [ -z "$skip" ]
}
# a script's `set` words that only switch -e, -o pipefail, -u or -x, as a chain script's `set -euo pipefail` does (set -k reads a later VAR=x as env)
set_flags() { local w; for w in "$@"; do case "$w" in pipefail) ;; [-+] | [-+]*[!eoux]*) return 1 ;; [-+]*) ;; *) return 1 ;; esac; done; }
# a folder with no trailing /, so `R` and `R/` read as one
bare_dir() { local d=$1; while [ ${#d} -gt 1 ] && [ "${d%/}" != "$d" ]; do d=${d%/}; done; printf '%s' "$d"; }
# an absolute folder in a git repo, written plain
abs_in_repo() { case "${1:-}" in /*) ;; *) return 1 ;; esac; plain "$1" && git -C "$1" rev-parse --show-toplevel >/dev/null 2>&1; }
# Whether every step of a chain is a form the commit lane proves safe, a closed list (builder, 5 Nov: three review rounds each found one more form a reading of cd, ~ or env let through): a git add, commit, merge or push in run-slot's own folder, a `cd` to an absolute folder in a repo, a git add, commit, merge or push after it or as `git -C <that kind of folder>`, `bun run precommit:light` in run-slot's own repo, and a script's `set` of shell options, each word plain. CHAIN_SAFE then holds each git step as `git -C <folder> <verb> ...`, joined by \x1f, one a line; else CHAIN_BAD holds the first step outside the list. Any other form, an env prefix, ~, $HOME, a backquote, cd - or a relative folder, is outside it, with no attempt to resolve it.
CHAIN_SAFE="" CHAIN_BAD=""
chain_safe() {
  local line words cdir="" folder verb rest=()
  CHAIN_SAFE="" CHAIN_BAD=""
  while IFS= read -r line; do
    IFS=$'\x1f' read -ra words <<< "$line"
    [ ${#words[@]} -gt 0 ] || continue
    CHAIN_BAD=${line//$'\x1f'/ }
    case "${words[0]}" in
      cd) [ ${#words[@]} -eq 2 ] && abs_in_repo "${words[1]}" || return 1; cdir=$(bare_dir "${words[1]}"); continue ;;
      # precommit:light in run-slot's own repo, since after a cd to another one it runs that repo's script
      bun) [ "${words[1]:-}" = run ] && [ "${words[2]:-}" = precommit:light ] && plain "${words[@]}" || return 1
        [ -z "$cdir" ] || [ "$(git -C "$cdir" rev-parse --show-toplevel 2>/dev/null)" = "$(git rev-parse --show-toplevel 2>/dev/null)" ] || return 1
        continue ;;
      set) set_flags "${words[@]:1}" || return 1; continue ;;
      git) ;;
      *) return 1 ;;
    esac
    if [ "${words[1]:-}" = -C ]; then
      plain "${words[@]:0:3}" && abs_in_repo "${words[2]:-}" || return 1
      folder=$(bare_dir "${words[2]}") verb=${words[3]:-} rest=("${words[@]:4}")
    else
      folder=${cdir:-$(bare_dir "$PWD")} verb=${words[1]:-} rest=("${words[@]:2}")
    fi
    plain git "$verb" || return 1
    case "$verb" in
      add) plain ${rest[@]+"${rest[@]}"} && add_flags ${rest[@]+"${rest[@]}"} || return 1 ;;
      commit) commit_words ${rest[@]+"${rest[@]}"} || return 1 ;;
      merge) merge_words ${rest[@]+"${rest[@]}"} || return 1 ;;
      push) plain ${rest[@]+"${rest[@]}"} || return 1 ;;
      *) return 1 ;;
    esac
    CHAIN_SAFE+=$(printf '%s\x1f' git -C "$folder" "$verb" ${rest[@]+"${rest[@]}"})$'\n'
  done < <(chain_steps "$@")
  CHAIN_BAD=""
}
# a git merge's words: --no-edit, --ff, --ff-only or --no-ff and one or more plain refs, since a merge runs commit-msg alone, never pre-commit's build, and any other option (-s, -X, -m) is off the list
merge_words() {
  local w refs=""
  for w in "$@"; do
    case "$w" in
      --no-edit | --ff | --ff-only | --no-ff) ;;
      -*) return 1 ;;
      *) plain "$w" || return 1; refs=1 ;;
    esac
  done
  [ -n "$refs" ]
}
# a chain's lane: `commit` when it commits, merges or pushes and chain_safe takes every step, so it ends in seconds as a bare commit does (4 Nov: a docs-only commit and push inside sh -c waited about 45 minutes in the general queue); `general <step>` for one that commits, merges or pushes with a step outside that list, which run-slot says, so its worker can run the commit on its own; else nothing
chain_lane() {
  local line words commits=""
  while IFS= read -r line; do
    IFS=$'\x1f' read -ra words <<< "$line"
    [ ${#words[@]} -gt 0 ] || continue
    case "$(git_verb "${words[@]}")" in commit|merge|push) commits=1 ;; esac
  done < <(chain_steps "$@")
  [ -n "$commits" ] || return
  if chain_safe "$@"; then echo commit; else echo "general $(shown "$CHAIN_BAD")"; fi
}
# Quick slots, outside the queue, one holder each: a plain git commit (its pre-commit build, about 17s) takes run-slot-commit (builder, 13 Oct: five commits waited in a fifteen-deep queue; a commit with a longer hook goes through the queue as <who> -- bash -c '...'), and a node_modules clone (cp -cR <sibling>/node_modules <worktree>/) takes run-slot-clone (dispatcher, 13 Oct: three load spikes, 77 and 43 among them, each with fseventsd near 100% while clones ran at once); a git merge or pull takes run-slot-commit too, and a bun install or a short bun test, docs:wrap or format:check takes run-slot-quick
quick_rule() {
  local a first=""
  # a pre-commit step commit-slot.ts hands over (the build or a type check), marked RUN_SLOT_COMMIT_STEP=1 under its commit-<worktree> name, is a plain git commit's own step, so it takes run-slot-commit too (3 Nov: a plain commit's build waited about an hour in the queue)
  case "$WHO" in commit-*) [ "${RUN_SLOT_COMMIT_STEP:-}" = 1 ] && { echo commit; return; } ;; esac
  # the command's first word past env and VAR=x, as box_fits finds it (optimizer, 19 Oct: a commit run as env NODE_ENV=... git commit waited 14 min in the queue)
  first=$(first_word "$@")
  case " $CHAIN_SHELLS " in *" $(basename -- "$first") "*) [ "$(chain_lane "$@")" = commit ] && echo commit; return ;; esac
  if [ "$(basename -- "$first")" = git ]; then
    # a merge or pull runs no pre-commit build (lefthook.yml has no merge hook), so it ends in seconds (optimizer, 20 Oct: a 1s git merge waited 26.6 min behind suites)
    # a push runs only the pre-push hook's seconds (retro 2, 31 Oct: git push queued 205 min in a day)
    case "$(git_verb "$@")" in commit | merge | pull | push) echo commit ;; esac
  elif [ "$(basename -- "$first")" = cp ]; then
    for a in "$@"; do a=${a%/.}; case "${a%/}" in node_modules|*/node_modules) echo clone; return ;; esac; done
  elif [ "$(basename -- "$first")" = bun ]; then
    # a bun test or bun run test:file naming 1 to 3 test files under tests/, nothing else, takes run-slot-quick, with --cwd=<p> anywhere or a bare --cwd after run or test, since bun misreads one before the subcommand (scripts/hooks/README.md's no-false-green; ops, 20 Oct: with slot-off, a 5-file run that ran 1s waited 52 min behind suites; PG-2158)
    # bun run docs:wrap and format:check never run past seconds (run-slot.runs.log, 20 Oct: max 2s and 9s), so they take run-slot-quick too
    for a in "$@"; do case "$a" in docs:wrap|format:check) echo quick; return ;; esac; done
    # every bun install takes run-slot-quick, whatever its flags: on the shared warm cache a full one ran 1.9 to 3.3 s on 2.9 to 3.5 s of CPU, its two root scripts included, while it waited 3 to 6 min in the queue (PG-1344, measured; retro 2, 31 Oct: --ignore-scripts alone queued 619 min in a day); only a cold cache holds the slot longer (353 s, measured), once, since every later install reads the cache it filled
    # install is bun's subcommand when only env, VAR=x, --cwd=<p> or another flag word stands before it: a bare --cwd before it makes bun run package.json's install script instead (no-false-green), as one before test does
    for a in "$@"; do case "$a" in env|*=*|-*) continue ;; "$first") continue ;; install) echo quick; return ;; *) break ;; esac; done
    local n=0 t="" skip=""
    for a in "$@"; do
      [ -n "$skip" ] && { skip=""; continue; }
      if [ "$a" = --cwd ]; then [ -n "$t" ] && skip=1 || return; continue; fi
      case "$a" in env|*=*|-*) continue ;; esac
      [ "$a" = "$first" ] && continue
      # only a test file under the repo's tests/ folder counts, so a replay of scratch test files goes through the queue (retro 35: one held the quick slot 30 min, and its waiters waited 87 min in all)
      case "$a" in run|test|test:file) t="$t $a" ;; *.e2e.* | */../*) return ;; tests/*.test.ts|tests/*.test.tsx|./tests/*.test.ts|./tests/*.test.tsx) n=$((n + 1)) ;; *) return ;; esac
    done
    case "$t" in " test" | " run test:file") [ "$n" -ge 1 ] && [ "$n" -le 3 ] && echo quick ;; esac
  fi
}
# whether each of the last 3 runs of this exact command line in run-slot.runs.log ran over $2 s ($1 over) or $2 s or less ($1 within); the words after them are the line
ran_last3() {
  local side=$1 bound=$2; shift 2
  tail -n 20000 "$OPS/run-slot.runs.log" 2>/dev/null | RUN_LINE="$*" BOUND=$bound SIDE=$side awk '
    $2 == "ask" { c = $0; for (k = 0; k < 4; k++) sub(/^[^ ]+ /, "", c); line[$4] = c; next }
    $2 == "end" && line[$4] == ENVIRON["RUN_LINE"] { delete line[$4]; for (i = 5; i <= NF; i++) if ($i ~ /^ran=[0-9]+s$/) r[++n] = substr($i, 5) + 0 }
    END { if (n < 3) exit 1; for (i = n - 2; i <= n; i++) if ((r[i] > ENVIRON["BOUND"] + 0) != (ENVIRON["SIDE"] == "over")) exit 1 }'
}
# each of the last 3 ended in 10 s or less (retro 2, 31 Oct: 408 of 686 CPU-lane runs did, and queued 2,004 min against 17 min of running)
ran_short() { ran_last3 within 10 "$@"; }
# each of the last 3 ran over 60 s (1 Nov: a two-file test:file line ran 39, 421 and 226 s back to back in the one quick slot, and the quick lane's waiters waited 63 min in the hour from 12:00Z)
ran_long() { ran_last3 over 60 "$@"; }
# whether a test file this line names (tests/... or ./tests/..., read as one) ran over 60 s within that file's last 3 runs, under any line, so a new line naming a known-slow file beside others reads that file's history (issue 1242: since 5 Nov 19 quick runs of 188 to 857 s did); a quick run counts, and so does a started run of 1 to 3 test files in any other lane, while a run outside quick naming more than 3 test files adds nothing, so 3 big suite runs cannot push a slow file's long run out of the window (issue 1507)
file_ran_long() {
  local a files=""
  for a in "$@"; do case "$a" in tests/*.test.ts | tests/*.test.tsx | ./tests/*.test.ts | ./tests/*.test.tsx) files="$files ${a#./}" ;; esac; done
  [ -n "$files" ] || return 1
  tail -n 20000 "$OPS/run-slot.runs.log" 2>/dev/null | FILES="$files" awk '
    $2 == "ask" { c = $0; for (k = 0; k < 4; k++) sub(/^[^ ]+ /, "", c); line[$4] = c; next }
    $2 == "start" { lane[$4] = $5; next }
    $2 == "end" && ($4 in line) && ($4 in lane) {
      ran = 0; for (i = 5; i <= NF; i++) if ($i ~ /^ran=[0-9]+s$/) ran = substr($i, 5) + 0
      n = split(line[$4], w, " ")
      m = 0; for (i = 1; i <= n; i++) { f = w[i]; sub(/^\.\//, "", f); if (f ~ /^tests\/.*\.test\.tsx?$/) m++ }
      if (lane[$4] != "run-slot-quick" && m > 3) { delete line[$4]; delete lane[$4]; next }
      long = ran > 60
      for (i = 1; i <= n; i++) { f = w[i]; sub(/^\.\//, "", f); if (f ~ /^tests\/.*\.test\.tsx?$/) h[f] = substr(h[f] long, length(h[f] long) > 3 ? length(h[f] long) - 2 : 1) }
      delete line[$4]; delete lane[$4]
    }
    END { n = split(ENVIRON["FILES"], want, " "); for (i = 1; i <= n; i++) if (index(h[want[i]], "1")) exit 0; exit 1 }'
}
# the slot a command takes outside the queue: its rule's, else quick when it ran short its last 3 times, so a long run after short ones holds the one quick slot and sends the next back to the queue; a line the rule calls quick that ran long its last 3 times goes to the queue, since its file count says nothing of its time, and so does a quick line naming a test file that ran long within its own last 3 runs (file_ran_long)
quick_kind() {
  # a read command takes no slot and runs a bare true, so three short true runs in the log would take can-take and head down the quick lane, past their own exits (issue 285)
  [ -n "$CAN_TAKE" ] && return
  [ -n "$HEAVY" ] && return
  local kind
  kind=$(quick_rule "$@")
  [ "$kind" = quick ] && ran_long "$@" && kind=""
  [ -z "$kind" ] && ran_short "$@" && kind=quick
  [ "$kind" = quick ] && file_ran_long "$@" && kind=""
  echo "$kind"
}
# whether turbo's dry run, in the run's checkout and with its env words, finds every check-types task and the builds under it cached; a dry run that fails or takes over 10 s counts as not cached (retro 5, 31 Oct: the dry run takes about 0.2 s, while 88 of 226 check-types runs ended in 10 s or less and waited 19,953 s, and the rest ran up to 190 s)
types_cached() {
  local a vars=()
  for a in "$@"; do case "$a" in env) continue ;; *=*) vars+=("$a") ;; *) break ;; esac; done
  turbo_cached check-types "$(box_dir "$@")" ${vars[@]+"${vars[@]}"}
}
# whether turbo's dry run of task $1, in folder $2 with the VAR=x words after them, finds every task it runs cached
turbo_cached() {
  (cd "$2" 2>/dev/null && python3 -I - "$1" "${@:3}" 2>/dev/null <<'PY'
import json, os, signal, subprocess, sys
env = dict(os.environ, **dict(v.split("=", 1) for v in sys.argv[2:]))
p = subprocess.Popen(["bun", "run", "turbo", "run", sys.argv[1], "--dry=json"], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
try:
    out, _ = p.communicate(timeout=10)
except subprocess.TimeoutExpired:
    os.killpg(p.pid, signal.SIGKILL)
    p.wait()
    sys.exit(1)
tasks = [t for t in json.loads(out)["tasks"] if t.get("command") != "<NONEXISTENT>"]
sys.exit(0 if p.returncode == 0 and tasks and all(t["cache"]["status"] == "HIT" for t in tasks) else 1)
PY
  )
}
# what a chain's git add step stages, for its later commit step, read from the step's own folder (4 Nov: read against the index alone, a chain whose own add staged a next file took the commit lane): the whole tree, untracked files included, for :/, -A, --all or a pathspec file; every tracked change for -u, --update or -p; else the paths it names, . among them; nothing for -n or --dry-run
CHAIN_ADD_ALL="" CHAIN_ADD_TRACKED="" CHAIN_ADD=()
chain_add() {
  local a past="" skip="" dry="" all="" tracked="" dashes="" paths=()
  for a in "$@"; do
    [ -n "$past" ] || { [ "$a" = add ] && past=1; continue; }
    [ -z "$skip" ] || { skip=""; continue; }
    [ -z "$dashes" ] || { paths+=("$a"); continue; }
    case "$a" in
      --) dashes=1 ;;
      -n | --dry-run) dry=1 ;;
      --pathspec-from-file) all=1; skip=1 ;;
      :/ | -A | --all | --pathspec-from-file=* | -[!-]*A*) all=1 ;;
      -u | --update | -p | --patch | -[!-]*u*) tracked=1 ;;
      -*) ;;
      *) paths+=("$a") ;;
    esac
  done
  [ -z "$dry" ] || return 0
  [ -z "$all" ] || CHAIN_ADD_ALL=1
  [ -z "$tracked" ] || CHAIN_ADD_TRACKED=1
  CHAIN_ADD+=(${paths[@]+"${paths[@]}"})
}
# whether a verb is one of git's own commands that run-slot lists, which no alias can replace: its porcelain, apply among it, and the plumbing reads below; a chain counts any other verb as a commit, a plumbing write such as update-ref or hash-object or a read off the list such as diff-tree
git_known() {
  case "$1" in
    add | am | apply | archive | bisect | blame | branch | bundle | cat-file | checkout | cherry | cherry-pick | clean | clone | commit | config | describe | diff \
      | difftool | fetch | for-each-ref | format-patch | fsck | gc | grep | help | init | log | ls-files | ls-remote | ls-tree | merge | merge-base | mergetool \
      | mv | notes | pull \
      | push | range-diff | rebase | reflog | remote | repack | replace | reset | restore | revert | rev-list | rev-parse | rm | shortlog | show \
      | show-ref | sparse-checkout | stash | status | submodule | switch | tag | version | whatchanged | worktree) return 0 ;;
  esac
  return 1
}
# whether a git verb is an alias in that folder's config, which may run a commit (`git ci`); git ignores an alias that names one of its own commands
aliased() { ! git_known "$1" && git ${2:+-C "$2"} config --get "alias.$1" >/dev/null 2>&1; }
# the first word past env, its no-argument flags and VAR=x, the command box_fits finds
first_word() { local a; for a in "$@"; do case "$a" in env | -i | - | *=*) continue ;; esac; printf '%s' "$a"; return; done; }
# a git -c key that runs a program or a hook (core.hooksPath, an alias, an include), which counts as a build for any verb
runs_program() {
  case "$(printf '%s' "${1%%=*}" | tr '[:upper:]' '[:lower:]')" in
    core.hookspath | core.fsmonitor | core.editor | core.askpass | core.gitproxy | alias.* | include.* | includeif.* | filter.* | credential.* | sequence.editor \
      | diff.external | *.driver | *.textconv | *.command | *.program | *.cmd | *.tool | *.uploadpack | *.receivepack | *.proxycommand) return 0 ;;
  esac
  return 1
}
# a commit whose pre-commit build runs next build goes through the queue as a big run (3 Nov, 04:05Z and 06:41Z: one built at 1.7 cores beside its own session's big run, and one beside a clone with load1 at 56): a git commit but -n, in a repo whose lefthook.yml pre-commit runs a build, staging a file @web/next#build builds from (unless every one is Markdown or a Python test under tests/, which lefthook's build skips), with -a or a pathspec file any it may stage, or one under a path it names, or commit-slot.ts's build (commit-<worktree>) for one; and, failing closed, a git run with a word outside these lists, or a verb that is an alias
heavy_build() {
  local a c f files top dir="" commit="" all="" gitc="" magic="" noverify="" unlisted="" loose="" prev="" after="" seen="" verb="" state=lead paths=() vars=() line words first adir="" merged=""
  # a chain that commits counts as a build unless chain_safe takes every step; then it builds when one of its commit steps would, read with what its git add steps stage, and when an add runs in another folder than a commit, whose paths it would misread
  first=$(first_word "$@")
  case " $CHAIN_SHELLS " in
    *" $(basename -- "$first") "*)
      while IFS= read -r line; do
        IFS=$'\x1f' read -ra words <<< "$line"
        [ ${#words[@]} -gt 0 ] || continue
        # a verb outside git_known may be an alias in any folder's or -c's config, or a plumbing write, so a chain counts it as a commit, failing closed
        verb=$(git_verb "${words[@]}")
        { [ "$verb" = commit ] || { [ -n "$verb" ] && ! git_known "$verb"; }; } && commit=1
      done < <(chain_steps "$@")
      if [ -n "$commit" ]; then
        chain_safe "$@" || return 0
        CHAIN_ADD_ALL="" CHAIN_ADD_TRACKED="" CHAIN_ADD=()
        while IFS= read -r line; do
          IFS=$'\x1f' read -ra words <<< "$line"
          [ ${#words[@]} -gt 0 ] || continue
          # an add or commit after a merge counts as a build, since a merge that stops on a conflict leaves the other side's files for them to stage
          case "${words[3]}:$merged" in add:1 | commit:1) CHAIN_ADD_ALL="" CHAIN_ADD_TRACKED="" CHAIN_ADD=(); return 0 ;; esac
          case "${words[3]}" in
            merge) merged=1 ;;
            add) adir=${adir:-${words[2]}}; [ "$adir" = "${words[2]}" ] && chain_add "${words[@]}" || { CHAIN_ADD_ALL="" CHAIN_ADD_TRACKED="" CHAIN_ADD=(); return 0; } ;;
            commit) { [ -z "$adir" ] || [ "$adir" = "${words[2]}" ]; } && ! heavy_build "${words[@]}" || { CHAIN_ADD_ALL="" CHAIN_ADD_TRACKED="" CHAIN_ADD=(); return 0; } ;;
          esac
        done <<< "$CHAIN_SAFE"
        CHAIN_ADD_ALL="" CHAIN_ADD_TRACKED="" CHAIN_ADD=()
        return 1
      fi ;;
  esac
  # commit-slot.ts's build step (`bun run build`) alone, never its type checks, which build nothing
  case "$WHO" in commit-*) for a in "$@"; do [ "$a" = build ] && commit=1; done ;; esac
  for a in "$@"; do
    case "$state" in
      lead) case "$a" in
          env) continue ;;
          NODE_ENV=* | RUN_SLOT_HERE=* | SKIP_ENV_VALIDATION=* | TURBO_CACHE_DIR=*) vars+=("$a"); continue ;;
          GIT_AUTHOR_NAME=* | GIT_AUTHOR_EMAIL=* | GIT_AUTHOR_DATE=* | GIT_COMMITTER_NAME=* | GIT_COMMITTER_EMAIL=* | GIT_COMMITTER_DATE=* | GIT_SSH_COMMAND=* | GIT_TERMINAL_PROMPT=*) continue ;;
          *=*) unlisted=1 loose=1; continue ;;
        esac
        [ "$(basename -- "$a")" = git ] || break; state=git ;;
      git) case "$a" in
          -C) state=dir ;;
          -c | --config-env) state=gitvalue ;;
          --git-dir | --work-tree | --namespace) unlisted=1 loose=1; state=gitvalue ;;
          -p | -P | --paginate | --no-pager | --version | --help | --no-optional-locks | --no-replace-objects | --no-advice) ;;
          --literal-pathspecs | --glob-pathspecs | --noglob-pathspecs | --icase-pathspecs) magic=1 ;;
          -*) unlisted=1 loose=1 ;;
          # a -c before a commit fails closed, since a config key can turn its hook path or editor to a program, and so does a pathspec option, which changes what its paths match past the diff run-slot reads
          commit) commit=1; state=commit; [ -z "$gitc$magic" ] || unlisted=1 loose=1 ;;
          *) verb=$a; break ;;
        esac ;;
      gitvalue) gitc=1; runs_program "$a" && unlisted=1 loose=1; state=git ;;
      dir) case "$a" in /*) dir=$a ;; *) dir=${dir:+$dir/}$a ;; esac; state=git ;;
      value) after=""; state=commit ;;
      paths) paths+=("$a") ;;
      commit) prev=$after after=""
        case "$a" in
          --) state=paths ;;
          # -n turns the hook off unless the word before it is an unlisted option, which may take it as its value
          -n | --no-verify) [ -n "$prev" ] || noverify=1 ;;
          --all | --pathspec-from-file=*) all=1 ;;
          --pathspec-from-file) all=1; state=value ;;
          --author|--cleanup|--date|--file|--fixup|--message|--reedit-message|--reuse-message|--squash|--template|--trailer) state=value ;;
          --allow-empty | --allow-empty-message | --amend | --edit | --gpg-sign | --gpg-sign=* | --include | --no-edit | --no-gpg-sign | --no-signoff \
            | --only | --pathspec-file-nul | --quiet | --reset-author | --signoff | --untracked-files | --untracked-files=* | --verbose | --author=* \
            | --cleanup=* | --date=* | --file=* | --fixup=* | --message=* | --reedit-message=* | --reuse-message=* | --squash=* | --template=* | --trailer=*) ;;
          # an unlisted long option may be --verify, which turns the hook back on
          --*) unlisted=1 loose=1 after=1 ;;
          -?*) f=${a#-} seen=""
            while [ -n "$f" ]; do c=${f:0:1}; f=${f:1}
              case "$c" in a) all=1 ;; n) [ -n "$prev$seen" ] || noverify=1 ;; [CFcmt]) [ -z "$f" ] && state=value; break ;; [uS]) break ;; [eioqsv]) ;; *) unlisted=1 seen=1 after=1 ;; esac
            done ;;
          *) paths+=("$a") ;;
        esac ;;
    esac
  done
  if [ -z "$commit" ]; then
    # a git run that commits nothing builds nothing, but for an alias, which may commit, and one with an unlisted word, failing closed
    [ "$state" = git ] && [ -n "$verb$unlisted" ] || return 1
    [ -n "$verb" ] && aliased "$verb" "$dir" && return 0
    [ -z "$unlisted" ] || return 0
    return 1
  fi
  # -n with every other word listed or an unlisted short letter after it runs no hook; any other unlisted word counts as a build, failing closed (builder, 5 Nov)
  [ -z "$noverify" ] || [ -n "$loose" ] || return 1
  [ -z "$unlisted" ] || return 0
  # only a repo whose own lefthook.yml pre-commit runs a build builds on commit (the dispatcher, 4 Nov: another repo's lint-staged commit sat 65 min in the big-run queue for a 1 s job)
  top=$(git ${dir:+-C "$dir"} rev-parse --show-toplevel 2>/dev/null)
  awk '/^[^ #]/ { pre = ($0 ~ /^pre-commit:/) } pre && /^ +(- )?run:.* run build([ "'"'"']|$)/ { found = 1 } END { exit !found }' \
    "$top/lefthook.yml" 2>/dev/null || return 1
  files=$({ git ${dir:+-C "$dir"} diff --cached --name-only; [ -z "$all" ] || git ${dir:+-C "$dir"} diff --name-only
    [ ${#paths[@]} -eq 0 ] || git ${dir:+-C "$dir"} diff --name-only HEAD -- "${paths[@]}"
    [ -z "$CHAIN_ADD_ALL$CHAIN_ADD_TRACKED" ] || git ${dir:+-C "$dir"} diff --name-only
    [ -z "$CHAIN_ADD_ALL" ] || git ${dir:+-C "$dir"} ls-files --others --exclude-standard --full-name :/
    [ ${#CHAIN_ADD[@]} -eq 0 ] || { git ${dir:+-C "$dir"} diff --name-only -- "${CHAIN_ADD[@]}"; git ${dir:+-C "$dir"} ls-files --others --exclude-standard --full-name -- "${CHAIN_ADD[@]}"; }; } 2>/dev/null)
  grep -Evq '^$|\.md$|^tests/.*\.py$' <<<"$files" || return 1
  grep -Eq '^(web/next|api/hono|packages)/|^(bun\.lock|package\.json|turbo\.json)$' <<<"$files" || return 1
  # a build turbo replays whole from its cache runs in seconds, so only one with a task to run counts big (5 Nov: under run-slot, commit-slot.ts runs the build bare inside the commit's own slot, so a big one stays in the queue); the cache folder is lefthook.yml's pre-commit default
  ! turbo_cached build "$top" "TURBO_CACHE_DIR=${TURBO_CACHE_DIR:-$HOME/.cache/turbo/playground}" ${vars[@]+"${vars[@]}"}
}
# packages/scripts/src/docker-build.ts, the docker build reader run-slot shares with the hooks
docker_reader() { "$BUN" "$(checkout_root)/packages/scripts/src/docker-build.ts" "$@" </dev/null; }
# the pieces of a command's words that hold a glob or brace character, one a line, each word split at blanks, quotes, backquotes and the shell's ; | & ( ) < >, its backslashes dropped as an outer shell's quote removal drops them
glob_pieces() { printf '%s\n' "$@" | tr -d '\\' | tr -s "[:space:];|&()<>\"'\`" '\n' | grep -E '[*?[]|[{].*(,|[.][.])'; }
# A docker build, as docker_reader reads it past the hooks' wrappers: run (one image), each (a compose build of no service or several, built one at a time), refuse <why>, or nothing; a chain with a docker build in any step is refused, so each build is a run of its own, and so is a chain whose words name docker or portless and whose steps chain_steps cannot read
docker_kind() {
  local found line words steps pieces rc=0 fix="run each docker build as a run-slot run of its own, so run-slot holds it to one at a time"
  local glob="refuse run-slot.sh refuses a chain with a program word written as a glob or a brace that can expand to docker or podman: $fix"
  # the reader starts only for a command that names docker or portless, in any letter case, so every other run skips its bun start; one that holds a glob or brace character is read for a program word that can expand to docker or podman (exit 3)
  case " $(printf '%s ' "$@" | tr '[:upper:]' '[:lower:]')" in
    *docker*|*portless*) ;;
    *[\*\?\[\{]*)
      chain_steps "$@" > /dev/null || rc=$?
      # a chain it cannot read may run a glob in a script it does not open (a nested -c, one fed on stdin, eval's words), so each piece of its words, split at blanks, quotes and shell punctuation, is read as a program word of its own
      if [ "$rc" -eq 1 ]; then
        rc=0 pieces=$(glob_pieces "$@")
        [ -z "$pieces" ] || chain_steps sh -c "$pieces" > /dev/null || rc=$?
      fi
      [ "$rc" -eq 3 ] && echo "$glob"
      return ;;
    *) return ;;
  esac
  found=$(docker_reader kind -- "$@")
  [ "$found" != none ] && { echo "$found"; return; }
  # a chain whose steps chain_steps cannot read may hold a docker build, so it is refused rather than read as no steps
  steps=$(chain_steps "$@") || rc=$?
  [ "$rc" -eq 3 ] && { echo "$glob"; return; }
  [ "$rc" -eq 0 ] || { echo "refuse run-slot.sh cannot read this chain's steps, so it refuses one that names docker or portless: $fix"; return; }
  while IFS= read -r line; do
    IFS=$'\x1f' read -ra words <<< "$line"
    [ ${#words[@]} -gt 0 ] || continue
    case "$(docker_reader kind -- "${words[@]}")" in
      none) ;;
      *) echo "refuse run-slot.sh refuses a chain that builds a docker image (${words[*]}): $fix"; return ;;
    esac
  done < <(printf '%s\n' "$steps" | grep -iE "docker|portless")
}
# a light run, whatever its session's size: a quick kind, a bun install or add, a filtered turbo run, a plain tsc, or a check-types whose work is cached (retro 3, 31 Oct: a big session's 2s git push and 1s bun install each waited over 1,290s for the age bump)
light_run() {
  [ -n "$(quick_kind "$@")" ] && return
  local a first="" next="" turbo="" filter="" types=""
  for a in "$@"; do case "$a" in env|-i|-|*=*) continue ;; esac; [ -z "$first" ] && first=$a && continue; next=$a; break; done
  # the 4 bare bunx tsc runs in the runs log each ran 1 s or less, while an sh -c holding a build and then tsc ran up to 152 s, so only the bare program counts (retro 5, 31 Oct)
  [ "$(basename -- "$first")" = tsc ] && return
  case "$(basename -- "$first")" in bun|bunx) ;; *) return 1 ;; esac
  [ "$(basename -- "$first")" = bunx ] && [ "$next" = tsc ] && return
  for a in "$@"; do case "$a" in install|add) return 0 ;; turbo) turbo=1 ;; --filter|--filter=*|-F) filter=1 ;; check-types) types=1 ;; esac; done
  [ -n "$turbo" ] && [ -n "$filter" ] && return
  [ -n "$types" ] && types_cached "$@"
}
# one line when a Mac run asks, takes its slot and ends, so a run's wait sits beside its run time (optimizer, 19 Oct)
rlog() { echo "$(date -u +%FT%TZ) $1 $WHO $$ $2" >> "$OPS/run-slot.runs.log" 2>/dev/null; }
[ -n "$KIND_ONLY" ] || [ -n "$CAN_TAKE" ] || [ -n "$REREAD" ] || rlog ask "$*"
# a named run from a worktree under .claude/worktrees/ records its session as that worktree's owner, named as commit-slot.ts names the folder
case "$WHO:$PWD" in
  commit-*) ;;
  */.claude/worktrees/*)
    if [ -z "$KIND_ONLY" ] && [ -z "$CAN_TAKE" ] && [ -z "$REREAD" ]; then
      OWNED=${PWD#*/.claude/worktrees/}
      OWNED=$(printf '%s' "${OWNED%%/*}" | tr -c 'A-Za-z0-9._#-' '-')
      mkdir -p "$OPS/run-slot.owner" && printf '%s\n' "$WHO" > "$OPS/run-slot.owner/$OWNED"
    fi ;;
esac
# a chain that commits beside a heavier step says the lane it takes and why, on stderr and as a `why` line after its ask (the ask line stays the command alone, which ran_last3 matches)
if [ -z "$KIND_ONLY" ] && [ -z "$CAN_TAKE" ] && [ -z "$REREAD" ]; then
  WHY=$(chain_lane "$@")
  case "$WHY" in
    "general "*)
      echo "run-slot.sh: this chain goes through the general queue, not the commit lane, since \`${WHY#general }\` is not a form the commit lane takes (git add, commit, push, or merge with --no-edit, --ff, --ff-only or --no-ff, in run-slot's folder, or after a cd or as git -C to an absolute folder in the repo, and bun run precommit:light); run the commit or merge as one of those to take the commit lane, or run an off-list merge and its push as two calls" >&2
      rlog why "general: \`${WHY#general }\` is outside the commit lane's forms" ;;
  esac
fi
read -r SIZE UNITS <<EOF
$(size_of "$WHO")
EOF
case "$UNITS" in 1|2|3) ;; *) SIZE=medium UNITS=2 ;; esac
# a ticket's units come from the run, so a light run from a big session ranks as small; a suite or a full build keeps its session's size
HEAVY=
heavy_build "$@" && HEAVY=1
light_run "$@" && SIZE=small UNITS=1
DOCKER=$(docker_kind "$@")
# kind's answer: refuse for a docker run run-slot refuses, docker for one it takes to run-slot-docker, else quick_kind's lane (clone, commit, quick, or nothing for the queue)
if [ -n "$KIND_ONLY" ]; then case "$DOCKER" in refuse\ *) echo refuse ;; ?*) echo docker ;; *) quick_kind "$@" ;; esac; exit 0; fi
case "$DOCKER" in refuse\ *) echo "${DOCKER#refuse }" >&2; rlog refused "docker"; exit 2 ;; ?*) HEAVY=1 ;; esac
# a model-bound run skips the queue's lanes, run-slot-docker among them, and a build fills the VM rather than waiting on a model
[ -n "$DOCKER" ] && [ -n "$MODEL_BOUND" ] && { echo "run-slot.sh refuses --model-bound for a docker build, which fills the Docker VM rather than waiting on a model: run it without --model-bound, so it takes run-slot-docker, one docker build at a time" >&2; rlog refused "docker"; exit 2; }
[ -n "$HEAVY" ] && SIZE=big UNITS=3
# Merging keeps going: a run that gates a merge (Checks, local CI, the merge train, the dashboard's build) and a ship's own runs (ops-ship) go before the
# rest and may use the small reserve, as may an org's run (below) and the run-slot.priority pick. A checker's run is ranked by its worker's size (size_of), and
# the rest keep class 2 so an older copy's ticket still ranks.
case "$WHO" in ops-checks-*|ops-localci|ops-merge-train|ops-dashboard|ops-ship) CLASS=0 ;; *) CLASS=2 ;; esac
# the session a run counts as for the priority pick and its class: a commit-<worktree> pre-commit step counts as the last named session that ran run-slot from
# that worktree (run-slot.owner/<worktree>), since the hook's waiter carries no session's name (4 Nov: a commit's build waited from 20:45Z
# while the priority named its session, until a lead named its commit-<worktree> by hand)
owner_of() { case "$1" in commit-*) cat "$OPS/run-slot.owner/${1#commit-}" 2>/dev/null ;; *) echo "$1" ;; esac; }
# A company's runs go ahead of every other waiter (the owner's priority): class 1, for a session whose roster
# entry, or its worker's (a checker's), has a pr or repo under a GitHub org ext.links guards. Else a session whose entry, or its worker's, has an
# owner (the owner's own ask, which its lead set) marks its ticket ask, which ordered_waiters ranks after the merge gates; a commit-<worktree>
# pre-commit step reads as its worktree's session (owner_of)
ASK=""
[ "$CLASS" = 2 ] && { python3 -I - "$(owner_of "$WHO")" "$SELF" <<'PY'
import json, os, re, shutil, subprocess, sys

data = os.path.abspath(os.environ.get("PLAYGROUND_DATA_DIR") or os.path.expanduser("~/.playground"))
try:
    with open(os.path.join(data, "roster.json")) as f:
        by = {a["name"]: a for a in json.load(f)["agents"] if isinstance(a, dict) and isinstance(a.get("name"), str)}
except (OSError, ValueError, KeyError, TypeError):
    sys.exit(1)
entry = by.get(sys.argv[1]) or {}
chain = [entry, by.get(str(entry.get("worker"))) or {}]
# exit 0 for an org's run, 3 for the owner's ask, 1 for neither
other = 3 if any(str(e.get("owner") or "").strip() for e in chain) else 1
values = [str(e.get(k, "")).lower() for e in chain for k in ("pr", "repo") if e.get(k)]
if not values:
    sys.exit(other)
# the guarded orgs as the settings reader in this script's checkout prints them, read only for a session with a pr or repo
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[2]))))
bun = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
try:
    r = subprocess.run([bun, os.path.join(root, "packages", "scripts", "src", "playground", "setting.ts"), "--guarded-orgs"], capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    orgs = json.loads(r.stdout) if r.returncode == 0 else []
except (OSError, ValueError, TypeError, subprocess.SubprocessError):
    sys.exit(other)
sys.exit(0 if any(re.search(rf"(?:^|/){re.escape(o)}/", v) for o in orgs for v in values) else other)
PY
  case $? in 0) CLASS=1 ;; 3) ASK=ask ;; esac; }
# Caps pytest-xdist's `-n auto` at 4 workers (a 15-worker round pushed load5 to 26).
export PYTEST_XDIST_AUTO_NUM_WORKERS=4
SLOT=""
DOCKER_SLOT=""
CHILD=""
# seconds between a waiter's looks, and a held clone's (the tests shorten both)
POLL=${RUN_SLOT_POLL:-15}
# the longest a commit or quick start waits on load5 (issue 1385)
LOAD_WAIT=${RUN_SLOT_LOAD_WAIT:-300}
# the seconds load5 reads under load_line's cap before single, 3-off and 4-off lift (lifted), the longest gap between two readings the hold counts across, and the file holding the second of the first reading under and of the last
LIFT_HOLD=300
LIFT_GAP=90
UNDER="$OPS/run-slot.under"
# the wait past which a waiter counts as a backlog the burst hold keeps spaced, small runs included (issue 1417): a queue that releases starts its small runs all at once, and load5 reads them only about a minute later (7 Nov 13:10 to 13:15Z: 12 queued runs started on run-slot and run-slot-2, and load5 crossed 15 at 13:16:08Z), so a small run that has waited this long also waits for burst_held to clear; a fresh small run starts at once (the tests shorten it; a waiter's waited count is the real seconds since its wait began, so the line reads in seconds whatever RUN_SLOT_POLL is)
BACKLOG_WAIT=${RUN_SLOT_BACKLOG_WAIT:-300}
CLONE_POLL=${RUN_SLOT_POLL:-5}
# the seconds a clone waits after the last clone's end, so fseventsd settles between two clones, and the load5 under the brake (clone_brake) it waits within, since a clone lifts load1 by about 15 for a minute or two, about 4 on load5 (estimated)
CLONE_GAP=180
CLONE_MARGIN=4
# a clone that has waited this long passes the big-run hold, so back-to-back big runs cannot starve the lane (issue 1317, 7 Nov 10:24 to 11:55Z: about 11 clones asked and none started while a big run held a slot); 10 minutes is past a cold install's 353 s (issue 1344)
CLONE_WAIT_MAX=${RUN_SLOT_CLONE_WAIT_MAX:-600}
# the clones' brake, the owner's load rule of 5 Nov (load5 under 15, the owner's Mac's core count), one per core: sysctl's hw.ncpu, the count spawn.sh's load gate starts from, else 15; never load_line, whose cap shuts run-slot-2 (6 Nov, 06:52Z to 07:03Z: a cap of 1 held every clone)
clone_brake() {
  local n
  n=$(sysctl -n hw.ncpu 2>/dev/null | tr -cd 0-9)
  if [ "${n:-0}" -gt 0 ]; then echo "$n"; else echo 15; fi
}

# Waiters take slots oldest first (builder, 12 Oct: a request queued at 13:28Z lost three slots in a row to later ones): each waiter leaves a
# ticket, run-slot.waiters/<ns>-<pid>-<who>, and only the oldest ticket whose pid is alive may take a slot; a ticket goes once its slot is taken
# or its waiter ends. The dashboard's own build and the merge train take run-slot-2 outside the queue, as in single-slot mode.
QUEUE="$OPS/run-slot.waiters"
NEXTF="$OPS/run-slot.next"
# the stat flavour, probed once on the ops folder, which always exists, since ticket() alone makes the queue folder and a run that skips it would probe a missing path on a GNU box, whose stat -f then reads its flags as a path (issues 1654 and 1818)
if stat -c %Y "$OPS" > /dev/null 2>&1; then ST=(-c '%Y %n'); else ST=(-f '%m %N'); fi
TICKET=""
CLONE_TICKET=""
ticket() {
  [ "$WHO" != ops-dashboard ] && [ "$WHO" != ops-merge-train ] && [ -z "$CAN_TAKE" ] && [ -z "$MODEL_BOUND" ] || return 0
  mkdir -p "$QUEUE"
  TICKET="$QUEUE/$(python3 -I -c 'import time; print(time.time_ns())')-$$-$WHO"
  # "s2" marks a waiter that can take run-slot-2 in single-slot mode (#i162); an empty ticket is an older copy that takes run-slot only.
  # Then its rank (class and units, 01 to 23), units and size, which order the queue, and ask for the owner's own ask, which an older copy ignores
  # then ask or -, and the second it first asked at, which a reread's new ticket keeps (load5_held)
  echo "s2 $CLASS$UNITS $UNITS $SIZE ${ASK:--} $ASKED" > "$TICKET"
}
ticket
# A pinned ticket keeps its place by age: one with no rank, from an older copy or local CI (plain "s2", or empty), which no newer ticket
# passes, since those take a slot only while theirs is the oldest live ticket and any other order deadlocks them (a review's round 1), and
# one that has waited AGED seconds, 20 minutes, which no newer ticket of its class passes, so the slots drain and a run too big for the free
# units still starts; a class above it (ordered_waiters) passes it, as a merge's gates and a reviewer's pass an aged worker's
AGED=1200
# the ready line, "<pr> <place>" a line: merge-queue.json's entries (PLAYGROUND_MERGE_QUEUE moves it, as for the train) with a readyAt, by goAt (one with none after) and then readyAt
# (Checks on a ready PR goes first by itself, as run-slot.priority does by hand, after an org's runs); a file that does not read ranks nothing
ready_line() {
  python3 -I - "${PLAYGROUND_MERGE_QUEUE:-${PLAYGROUND_DATA_DIR:-$HOME/.playground}/merge-queue.json}" 2>/dev/null <<'READY'
import json, sys
try:
    queue = json.load(open(sys.argv[1]))["queue"]
    ready = [e for e in queue if isinstance(e, dict) and isinstance(e.get("pr"), int) and isinstance(e.get("readyAt"), str)]
except (OSError, ValueError, KeyError, TypeError):
    sys.exit(0)
ready.sort(key=lambda e: (not isinstance(e.get("goAt"), str), str(e.get("goAt", "")), e["readyAt"]))
for place, e in enumerate(ready):
    print(e["pr"], place)
READY
}
# the best place in the ready line ($2) of the PRs a Checks run names (ops-checks-<n>, or -<n>-<m> for a batch), else nothing
ready_place() {
  local n p best=""
  case "$1" in ops-checks-*) ;; *) return ;; esac
  for n in $(printf '%s' "${1#*-checks-}" | tr -c '0-9' ' '); do
    p=$(printf '%s\n' "$2" | awk -v n="$n" '$1 == n { print $2 }')
    [ -n "$p" ] && { [ -z "$best" ] || [ "$p" -lt "$best" ]; } && best=$p
  done
  echo "$best"
}
ordered_waiters() {
  # the live tickets in the order they take slots, one "<pinned 0|1> <ticket>" a line. A ticket with no rank (local CI's, an older copy's) is a wall
  # no newer ticket passes. Between walls go first the runs that go ahead, past AGED or not, class by class: an org's, then Checks for a PR in the
  # ready line by its place there, then those that gate a merge, then one for the owner's own ask (a ticket marked ask), then a reviewer's
  # (<id>-reviewer, -reviewer-spec), so a drafted review is never held behind workers' long runs (Ops, 2 Nov: 9 of 17 waiters were reviewers). Then
  # the rest. Within each class one past AGED is pinned, so no newer ticket of its class passes it; each small before medium before big, oldest first.
  # A dead waiter's goes on the way
  local t pid rank ask m p aged k sub seg=0 now ready name mt
  local -a subs=(1 1 1 1 1 1)
  # the tickets' mtimes, one stat call for every ticket, name and time paired by the name the line carries and checked against the loop's own, with a
  # stat of its own for a line that does not pair (a ticket gone between the two reads; a ticket that arrives between them reads in with the stat
  # line's own name, and the final sort orders it, so nothing is passed over), instead of a stat a ticket a call (issue 1654)
  now=$(date +%s)
  ready=$(ready_line)
  while read -r t name mt; do
    [ -n "$t" ] || continue
    pid=${t#*-}; pid=${pid%%-*}
    if ! alive "$pid"; then rm -f "${QUEUE:?}/${t:?}"; continue; fi
    if [ "$name" != "$t" ]; then mt=$(stat "${ST[0]}" "${ST[1]}" "$QUEUE/$t" 2>/dev/null); name=$t; fi
    [ -n "$mt" ] || continue
    m=$mt
    rank="" ask=""
    read -r _ rank _ _ ask _ 2>/dev/null < "$QUEUE/$t"
    case "$rank" in
      [0-2][1-3]) ;;
      *) echo "$((seg + 1)) 0 0 00 1 $t"; seg=$((seg + 2)); subs=(1 1 1 1 1 1); continue ;;
    esac
    aged=0
    [ $((now - m)) -lt "$AGED" ] || aged=1
    case "$rank" in
      1?) rank=0$rank ;;
      2?) case "${t#*-*-}" in *-reviewer|*-reviewer-spec) rank=21${rank#2} ;; *) rank=2$rank ;; esac ;;
      *) p=$(ready_place "${t#*-*-}" "$ready"); if [ -n "$p" ]; then rank=1$(printf '%04d' "$p"); else rank=2$rank; fi ;;
    esac
    # the class: 0 an org's, 1 the ready line, 2 the merge gates, 3 the owner's ask, 4 a reviewer's, 5 the rest
    case "$rank" in 0*) k=0 ;; 1*) k=1 ;; 20?) k=2 ;; 21?) k=4 ;; *) k=5 ;; esac
    # an ask ticket ranks as 23<units>, so a checker's and a worker's sort by units alone within the class
    [ "$k" -lt 4 ] || [ "$ask" != ask ] || { k=3; rank=23${rank: -1}; }
    sub=${subs[$k]}
    if [ "$aged" = 0 ]; then echo "$seg $k $sub $rank 0 $t"; else echo "$seg $k $((sub + 1)) 00 1 $t"; subs[$k]=$((sub + 2)); fi
  done < <(paste -d ' ' <(ls "$QUEUE" 2>/dev/null | sort -t- -k1,1n) <(stat "${ST[0]}" "${ST[1]}" "$QUEUE"/* 2>/dev/null | awk -v q="$QUEUE/" '{ i = index($0, " "); print substr($0, i + 1 + length(q)) "\t" substr($0, 1, i - 1) }' | sort -t- -k1,1n)) | sort -s -k1,1n -k2,2n -k3,3n -k4,4 | cut -d' ' -f5,6
}
first_waiter() {
  # the first waiter in that order whose run fits the units free now (unit_fits), so a run too big for them never holds back a smaller one behind it;
  # a pinned one that does not fit holds its place while it is a wall (no rank) or the runs that passed it are all that keep it out, and is named
  # when no run behind it fits, so it starts once its lanes open and is never starved (issue 1216: a pinned 3-unit head kept 11 smaller waiters
  # behind it for 25 minutes with 2 lanes free); with s2, only among the waiters that can take run-slot-2 (builder, 12 Oct: older copies at
  # the head left slot 2 idle)
  local p t f c held list pc pl mode=${1:-} blocked="" lu holder
  # the walk's lane units and priority holder read once, so it pays no read a ticket (issue 1654)
  c=$(capacity); held=$(held_units)
  lu=$(lane_units); holder=$(prio_holder) || holder=
  list=$(ordered_waiters)
  while read -r p t; do
    [ -n "$t" ] || continue
    f=; read -r f 2>/dev/null < "$QUEUE/$t" || :
    [ "$mode" = s2 ] && [ -z "$f" ] && continue
    set -- $f
    if unit_fits "${2:-22}" "${3:-2}" "${4:-medium}" "${t#*-*-}" "$c" "$held" "" "$lu" "$holder"; then echo "$t"; return; fi
    [ "$p" = 1 ] || continue
    [ -n "${2:-}" ] && read -r pc pl <<< "$(passer_units "$t")"
    if [ -z "${2:-}" ] || unit_fits "$2" "${3:-2}" "${4:-medium}" "${t#*-*-}" "$c" $((held - pc)) "$pl" "$lu" "$holder"; then echo "$t"; return; fi
    [ -n "$blocked" ] || blocked=$t
  done <<< "$list"
  [ -z "$blocked" ] || echo "$blocked"
}
# "<slots> <lanes>": the units of every holder the load units count (holders) that took its slot after ticket $1 was written, the runs that passed
# it, in held_units' and lane_units' shares; one rule over holders, so a holder they count later passes by it too (review rounds 1 and 2: a lane and a peer)
passer_units() {
  local since
  since=$(mtime "$QUEUE/$1") || { echo "0 0"; return; }
  since=$(date -u -r "$since" +%FT%TZ 2>/dev/null || date -u -d "@$since" +%FT%TZ)
  holders | awk -v since="$since" '$2 > since { if ($1 == "lane") l += $3; else t += $3 } END { print t + 0, l + 0 }'
}
# a waiter whose script was replaced while it waits (a pull, a link-skills run) runs the new copy with its own arguments, since bash keeps
# reading the old file (dispatcher, 18 Oct: waiters started before a run-slot change kept the old clone-allow and queue rules)
reread() {
  [ "$(stamp "$SELF")" = "$STAMP" ] && return
  [ -r "$SELF" ] || return
  echo "run-slot.sh: $SELF changed while $WHO waited; running the new copy" >&2
  [ -n "$TICKET" ] && rm -f "$TICKET"
  RUN_SLOT_ASKED=$ASKED RUN_SLOT_ASK_STAMP=$ASK_STAMP exec bash "$SELF" "${ARGS[@]}"
}
# A waiter's idle poll starts one process, its sleep (issue 1338, 7 Nov: sixteen waiters started about 60 processes a second between them, which held load5
# between 30 and 42 on 15 cores with the CPU half idle, so the slots they waited for stayed shut): it reads what its last look read through bash builtins
# alone (a glob, read, test) and looks again only once one of them has changed. REF is touched at each look, so a file not older than it changed since,
# or was written in the look's own second, which -nt's whole seconds on bash 3.2 cannot tell apart (one look more at most)
REF="$OPS/.run-slot-ref-$$"
# whether this script was written since the last look, a replaced copy included, by its mtime; a copy that kept an older mtime waits for the next look's reread
self_changed() { ! [ "$SELF" -ot "$REF" ]; }
# SIG: each run-slot entry of the ops folder and the queue by name, with the line of each holder and of the switches whose line counts, each peer's holder
# lines, and a mark for each holder's or ticket's pid that has ended, since a killed run leaves its line; the runs log, the lanes' and gauges' caches,
# run-slot.next (the oldest waiter's own write), this script and the switches' history stay out
cheap_sig() {
  local f l w d p
  SIG=
  for f in "$OPS"/run-slot* "$QUEUE"/*; do
    case "$f" in *.runs.log | */run-slot.lanes* | */run-slot.gauges* | *.lifted-* | *.expired-* | */run-slot.sh | */run-slot.next) continue ;; esac
    SIG="$SIG|$f"
    p=
    case "$f" in
      */run-slot.load5-cap) l=; while read -r w || [ -n "$w" ]; do l=$w; done 2>/dev/null < "$f"; SIG="$SIG=$l" ;;
      *.holder | */run-slot.priority | */run-slot.focus) l=; read -r l 2>/dev/null < "$f"; SIG="$SIG=$l"; [ "${f%.holder}" = "$f" ] || { p=${l#* }; p=${p%% *}; } ;;
      "$QUEUE"/*) p=${f##*/}; p=${p#*-}; p=${p%%-*} ;;
    esac
    case "$p" in '' | *[!0-9]*) ;; *) alive "$p" || SIG="$SIG!ended" ;; esac
  done
  for d in "$@"; do
    for f in "$d"/run-slot*.holder; do l=; read -r l 2>/dev/null < "$f"; SIG="$SIG|$f=$l"; p=${l#* }; p=${p%% *}; case "$p" in '' | *[!0-9]*) ;; *) alive "$p" || SIG="$SIG!ended" ;; esac; done
  done
  # a look mark whose pid has ended is swept here, since the waiter it belonged to was killed past its trap and free() never ran
  for f in "$OPS"/.run-slot-ref-*; do [ -e "$f" ] || continue; p=${f##*-}; case "$p" in '' | *[!0-9]*) continue ;; esac; [ "$p" = "$$" ] && continue; alive "$p" || rm -f "$f"; done
}
# the load's line, its 1- and 5-minute loads in whole numbers, which a waiter at the head looks again on (two processes, so only the head's polls read it)
cheap_load() { local l; l=$(loadavg); set -- $l; LOAD="${2%%.*} ${3%%.*}"; }
# whether this waiter's ticket is the queue's oldest, the one that names who goes next in run-slot.next
oldest_is_me() { local a=("$QUEUE"/*); [ -n "$TICKET" ] && [ "${a[0]}" = "$TICKET" ]; }
# the lines a waiter behind the head watches: who the oldest waiter names next, and the lead's pick and focus, which name a session whatever its place
next_sig() { local f l; NSIG=; for f in "$NEXTF" "$OPS/run-slot.priority" "$OPS/run-slot.focus"; do l=; read -r l 2>/dev/null < "$f"; NSIG="$NSIG|$l"; done; }
# the epoch second the first rule a look reads by the clock alone turns, nothing while none will: a ticket reaching AGED (the queue's order),
# run-slot.priority's hour, a switch's expiry and a holder line with no pid going stale at 2 hours, so a waiter at the head looks again then
due_at() {
  local now f m e l ends d= name mt
  # the candidates' mtimes, one stat call for every file, each line carrying its own name, in the script's one stat flavour (issue 1654)
  now=$(date +%s)
  while read -r mt name; do
    case "$name" in
      */run-slot.priority) m=3600 ;;
      *.holder) l=; read -r _ l _ 2>/dev/null < "$name"; case "$l" in '' | *[!0-9]*) m=7200 ;; *) continue ;; esac ;;
      *) m=$AGED ;;
    esac
    e=$((mt + m))
    [ "$e" -gt "$now" ] && { [ -z "$d" ] || [ "$e" -lt "$d" ]; } && d=$e
  done < <(stat "${ST[0]}" "${ST[1]}" "$QUEUE"/* "$OPS/run-slot.priority" "$OPS"/run-slot*.holder 2>/dev/null)
  # the load5 hold's ceiling for slots 2 to 4 (load5_held)
  oldest_asked; e=$((OLDEST + LOAD_WAIT))
  [ "$e" -gt "$now" ] && { [ -z "$d" ] || [ "$e" -lt "$d" ]; } && d=$e
  for f in $SWITCHES; do
    [ -e "$OPS/$f" ] || continue
    switch_ends "$f"
    ends=$ENDS
    if [ -n "$ends" ]; then
      e=$(date -u -j -f %Y-%m-%dT%H:%M:%SZ "$ends" +%s 2>/dev/null || date -u -d "$ends" +%s 2>/dev/null) || continue
    else
      e=$(mtime "$OPS/$f") || continue
      e=$((e + 14400))
    fi
    [ "$e" -gt "$now" ] && { [ -z "$d" ] || [ "$e" -lt "$d" ]; } && d=$e
  done
  echo "$d"
}
# G: the gauges' verdict the slots a look counts open on, open while they shut none: the lanes (lanes_open, which rewrites run-slot.lanes), and in
# single-slot mode memory's room, which opens run-slot-2 alone
gate_sig() { G=shut; lanes_open && G=open; switch_on run-slot.single && ! lifted && ! mem_ok && G="$G nomem"; return 0; }
# whether this waiter may sleep again with no look: its script is unchanged and the oldest waiter alive. A waiter at the head (one with no ticket, the
# head of either order, or the oldest) looks again on anything its last look decides by: a file it read (SIG, merge-queue.json), the load's whole numbers,
# the clock's next turn (due_at), the burst's minute while one held it, and the gauges: every poll while they shut a slot, and while they open one,
# whenever a fresh reading of them moves the line its verdict came from, its stamp apart (a `-nt` against the look's mark and a builtin compare, no
# process of their own, so a flip lands with the reading that moved it, issue 1477, and rewrites run-slot.next within a poll; memory's pressure and free
# share move without the cache, and a fresh reader's own lanes read names them); any other, which a new waiter or a run's end never moves to the head,
# looks on the look signature too, so a freeing, a run's end or a new ask wakes it once per change within a poll (issue 1818), and once it is the oldest
# or next_sig changes; the load's, merge queue's, clock's and gauges' reads stay the head's alone
cheap_idle() {
  local a pid l=
  self_changed && return 1
  a=("$QUEUE"/*)
  if [ -e "${a[0]}" ]; then pid=${a[0]##*/}; pid=${pid#*-}; pid=${pid%%-*}; alive "$pid" || return 1; fi
  cheap_sig $PEERS
  [ "$SIG" = "$SIG0" ] || return 1
  if [ "$LOOKER" = 1 ]; then
    [ -e "$MQ" ] && ! [ "$MQ" -ot "$REF" ] && return 1
    [ -z "$DUE" ] || [ "$SECONDS" -lt "$DUE" ] || return 1
    cheap_load
    [ "$LOAD" = "$LOAD0" ] || return 1
    under_seen || return 1
    [ -z "$BURST" ] || burst_held > /dev/null || return 1
    if [ "$G0" = open ]; then
      [ "$OPS/run-slot.gauges" -ot "$REF" ] && return 0
      l=; read -r _ l 2>/dev/null < "$OPS/run-slot.gauges"
      [ "$l" = "$G0_CACHE" ] && return 0
    fi
    gate_sig
    [ "$G" = "$G0" ] || return 1
    G0_CACHE=$l
  else
    [ "${a[0]}" = "$TICKET" ] && return 1
    next_sig
    [ "$NSIG" = "$NSIG0" ]
  fi
}
# marks a look before it reads anything, so a change after any of its reads sets off the next look: what it reads from here on counts as seen, and the
# load, the clock's next turn and the gauges' verdict, which the look's slot counts then take (LANES), so G0 is the verdict the look acted on; every waiter
# takes them all, since one can come to the head within a look, and a mark taken after the look's reads lost the change between the two (issue 1414)
look_mark() {
  local d
  : > "$REF" 2>/dev/null
  cheap_sig $PEERS
  SIG0=$SIG
  next_sig
  NSIG0=$NSIG
  LOOKED=1 DUE= BURST= LIFT_AT=
  cheap_load
  LOAD0=$LOAD
  d=$(due_at)
  # the clock's second, read once a look while a turn is due or a lift mark stands (under_seen)
  { [ -z "$d" ] && ! [ -e "$UNDER" ]; } || LIFT_AT=$(date +%s) LIFT_S=$SECONDS
  [ -z "$d" ] || DUE=$((SECONDS + d - LIFT_AT))
  read -r _ G0_CACHE 2>/dev/null < "$OPS/run-slot.gauges"
  gate_sig
  G0=$G
  LANES=${G%% *}
  HELD5=unread
  load5_held || :
}
MQ=${PLAYGROUND_MERGE_QUEUE:-${PLAYGROUND_DATA_DIR:-$HOME/.playground}/merge-queue.json}
LOOKER=1
LOOKED=
G0_CACHE=

# run-slot.priority (a lead's pick, under an hour old) works with the queue (builder, 12 Oct: a priority naming the 8th waiter deadlocked it):
# the named session may take a slot whatever its place, and the reservation holds only while that session is itself waiting in the queue
prio_holder() {
  local m
  # while run-slot.focus stands its session is the pick, whatever run-slot.priority says or its age, so focus never loses its slot to a lapse
  focus_holder && return
  m=$(mtime "$OPS/run-slot.priority") || return
  # an mtime that reads back empty counts as no pick, rather than as a shell error, as in stale
  case "$m" in '' | *[!0-9]*) return 1 ;; esac
  [ $(( $(date +%s) - m )) -lt 3600 ] && cut -d' ' -f1 "$OPS/run-slot.priority"
}
# the session run-slot.focus names while it stands (playground focus); nothing, exit 1, when it does not or goes between the check and the read (issue 1491)
focus_holder() {
  switch_on run-slot.focus || return 1
  local h=
  read -r h _ 2>/dev/null < "$OPS/run-slot.focus"
  [ -n "$h" ] && printf '%s\n' "$h"
}
# true while focus holds this run: a heavy lane waits for every session but the focus one and ops' upkeep (ops-tick's beats, the dashboard), which keep running (dispatcher, 5 Nov); FOCUS_HOLDER keeps the name it read, so can-take prints the holder that held (issue 1647)
focus_holds() {
  FOCUS_HOLDER=$(focus_holder) || return 1
  ! focus_spares "$FOCUS_HOLDER" "$WHO"
}
# the wait under the battery's red mark or focus, its line naming the battery's first
hold_wait() {
  waited=$((SECONDS - WAIT_FROM))
  # each wait line prints at its first poll, its threshold 0, and again each time the clock's waited count crosses the next 300 s mark, whatever the poll slept
  if [ "$waited" -ge "$FAT" ]; then
    if battery_holds; then
      echo "run-slot.sh: waiting for the Mac's charge to rise (run-slot.battery, which ops-awake lifts once it does)" >&2
    else
      echo "run-slot.sh: waiting for $(focus_holder)'s focus to end (run-slot.focus, until $(cut -d' ' -f3 "$OPS/run-slot.focus" 2>/dev/null))" >&2
    fi
    FAT=$(((waited / 300 + 1) * 300))
  fi
  sleep "$POLL"
}
# true while the battery's red mark holds this run: ops-awake keeps run-slot.battery standing while the charge is at 5% or under and falling, on battery or on a charger losing to the load, so every heavy run on this Mac waits, a focused session's too, but ops' upkeep (ops-tick's beats, the dashboard), as under focus
battery_holds() {
  switch_on run-slot.battery || return 1
  case "$WHO" in ops-dashboard | ops-tick) return 1 ;; esac
}
# whether a hold the wait list obeys first stands, the one check the verdict reads share, so they cannot drift apart
verdict_holds() { battery_holds || focus_holds; }
prio_for() { local h; h=$(prio_holder) && [ -n "$h" ] && [ "$(owner_of "$1")" = "$h" ]; }
# the oldest live ticket the priority holder owns, its worktree's commit steps' included: the one of its tickets that skips the queue, so its runs go in the order it asked for them (4 Nov: a merge asked later took a slot before the same session's older merge)
prio_first() {
  local h t pid
  h=$(prio_holder) || return
  [ -n "$h" ] || return
  for t in $(ls "$QUEUE" 2>/dev/null | sort -t- -k1,1n); do
    [ "$(owner_of "${t#*-*-}")" = "$h" ] || continue
    pid=$(printf '%s' "$t" | cut -d- -f2)
    alive "$pid" && { echo "$t"; return; }
  done
}
# true while the priority holder has a ticket whose waiter still runs
prio_waiting() { [ -n "$(prio_first)" ]; }

free() {
  # give the slot back only while its holder line is still ours
  if [ -n "$SLOT" ] && [ "$(cut -d' ' -f2 "$SLOT.holder" 2>/dev/null)" = "$$" ]; then
    # the holder line goes first, so a waiter whose mkdir loses to the next taker never reads our dead pid and reclaims that taker's slot (reviewer-ops-load-units, 19 Oct)
    rm -f "$SLOT.holder" "$SLOT.child" "$SLOT.preempted"
    rmdir "$SLOT" 2>/dev/null
  fi
  SLOT=""
  if [ -n "$DOCKER_SLOT" ] && [ "$(cut -d' ' -f2 "$DOCKER_SLOT.holder" 2>/dev/null)" = "$$" ]; then
    # however the build ended, a TERM included, its builder stops before the next build may start, so its idle memory goes back to the VM
    env -u BUILDX_BUILDER docker buildx stop "$DOCKER_BUILDER" >/dev/null 2>&1
    rm -f "$DOCKER_SLOT.holder"
    rmdir "$DOCKER_SLOT" 2>/dev/null
  fi
  DOCKER_SLOT=""
  [ -n "$TICKET" ] && rm -f "$TICKET"
  [ -n "$CLONE_TICKET" ] && rm -f "$CLONE_TICKET"
  [ -e "$REF" ] && rm -f "$REF"
  [ -n "${MEM_TOLD:-}" ] && rm -f "$MEM_TOLD-suite" "$MEM_TOLD-clone" "$MEM_TOLD-idle" "$MEM_TOLD-swap" "$MEM_TOLD-busy"
}
trap 'free' EXIT
# a wait loop bash dropped with no slot taken stops the run with 143 and says why, so its caller runs it again (issue 1641): bash 5.2 drops a loop when a TERM lands while it expands a "$(...)" and the trap below fails to parse, so the stop it was sent still ends the run; free, the EXIT trap, gives back its place in the queue
dropped() { echo "run-slot.sh: the $1 wait loop ended with no slot taken (bash drops a loop when a signal lands mid-expansion), so $WHO stops with 143: run it again" >&2; exit 143; }
trap '[ -n "$CHILD" ] && kill -TERM -- "-$CHILD" 2>/dev/null; wait "$CHILD" 2>/dev/null; [ -n "$CHILD" ] && { reap "$CHILD"; rlog end "rc=143 ran=$(($(date +%s) - TOOK))s"; }; exit 143' TERM INT HUP

# process group $1's members, a `<pid> <command>` line each: from ps, else from the kernel's process table (ptable.py), since Claude Code's sandbox refuses the setuid ps
members() {
  local all
  if all=$(ps -A -o pid=,pgid=,command= 2>/dev/null); then
    printf '%s\n' "$all" | awk -v g="$1" '$2 == g { $2 = ""; print }'
  else
    python3 -I "$(dirname "$(realpath "$SELF")")/ptable.py" group "$1"
  fi
}
# stops what is left in the command's group once it has ended, TERM then KILL after 3 seconds, logging each pid (a suite's worker once outlived it by 5 hours)
reap() {
  local left
  left=$(members "$1")
  [ -n "$left" ] || return 0
  printf '%s\n' "$left" | while read -r pid cmd; do rlog reap "pid=$pid $cmd"; done
  kill -TERM -- "-$1" 2>/dev/null
  gone "$1" && return 0
  kill -KILL -- "-$1" 2>/dev/null
  gone "$1"
}

# whether a process group has emptied within 3 seconds, since a signalled process lingers until the kernel has torn it down
gone() {
  local i
  for i in $(seq 15); do
    [ -n "$(members "$1")" ] || return 0
    sleep 0.2
  done
  return 1
}

# a clone runs through this: the clone itself, then, once it exits 0 from one checkout's root node_modules into another, each workspace's own the same way, so no bun install has to follow (PG-655: 74 of 80 clones in a day were followed by one, 177 min queued)
CLONE_WORKSPACES='
import glob, json, os, subprocess, sys
code = subprocess.call(sys.argv[1:])
if code:
    sys.exit(code)
words = sys.argv[1:]
words = words[next((i for i, w in enumerate(words) if os.path.basename(w) == "cp"), len(words)):]
flags = [w for w in words[1:] if w.startswith("-")]
paths = [w.rstrip("/") for w in words[1:] if not w.startswith("-")]
if not words or len(paths) != 2 or os.path.basename(paths[0]) != "node_modules":
    sys.exit(0)
src = os.path.dirname(paths[0]) or "."
dst = os.path.dirname(paths[1]) if os.path.basename(paths[1]) == "node_modules" else paths[1]
try:
    workspaces = json.load(open(os.path.join(src, "package.json"))).get("workspaces", [])
    json.load(open(os.path.join(dst, "package.json")))
except (OSError, ValueError):
    sys.exit(0)
if isinstance(workspaces, dict):
    workspaces = workspaces.get("packages", [])
for pattern in workspaces:
    for ws in sorted(glob.glob(os.path.join(src, pattern, "node_modules"))):
        into = os.path.join(dst, os.path.relpath(os.path.dirname(ws), src))
        if os.path.isdir(into) and not os.path.lexists(os.path.join(into, "node_modules")):
            code = subprocess.call([words[0], *flags, ws, into + "/"])
            if code:
                sys.exit(code)'

# a clone's source checkout and destination, from cp <flags> <src>/node_modules <dst>[/node_modules] (the shape CLONE_WORKSPACES reads), each absolute and led by a tab, for the clone lane's holder line, so playground rm refuses a worktree a running clone reads from or copies into (PG-714); nothing for words of another shape
clone_ends() {
  local a seen="" paths=()
  for a in "$@"; do
    [ -n "$seen" ] || { [ "$(basename -- "$a")" = cp ] && seen=1; continue; }
    case "$a" in -*) ;; *) a=${a%/.}; paths+=("${a%/}") ;; esac
  done
  [ ${#paths[@]} -eq 2 ] && [ "$(basename -- "${paths[0]}")" = node_modules ] || return 0
  local dst=${paths[1]}
  [ "$(basename -- "$dst")" = node_modules ] && dst=$(dirname -- "$dst")
  printf '\t%s\t%s' "$(absolute "$(dirname -- "${paths[0]}")")" "$(absolute "$dst")"
}
absolute() { (cd -- "$1" 2>/dev/null && pwd -P) || case "$1" in /*) printf %s "$1" ;; *) printf %s "$PWD/$1" ;; esac; }

# A docker build runs in playground-capped, a docker-container BuildKit capped at half the Docker VM's memory, made when missing and never the default (no --use), loading its image into the engine's store
DOCKER_BUILDER=playground-capped
# half the VM, as the engine reports it, so the cap follows the VM's size (6 Nov 01:38Z: the VM went from 3 GiB to 8 GiB) and the other half stays for the engine, the kernel and the live dashboard's Postgres
docker_memory() {
  local total
  total=$(docker info --format '{{.MemTotal}}' 2>/dev/null)
  case "$total" in ''|*[!0-9]*) return 1 ;; esac
  echo "$((total / 2 / 1048576))m"
}
capped_builder() {
  local memory have
  memory=$(docker_memory) || return 1
  if have=$(docker buildx inspect "$DOCKER_BUILDER" 2>/dev/null); then
    case "$have" in *"memory=\"$memory\""*) return ;; esac
    # a builder made under another VM size keeps its old cap, so it is made again at this one's
    docker buildx rm "$DOCKER_BUILDER" >/dev/null 2>&1 || return 1
  fi
  docker buildx create --name "$DOCKER_BUILDER" --driver docker-container --driver-opt "memory=$memory" \
    --driver-opt "memory-swap=$memory" --driver-opt default-load=true >/dev/null
}

# runs the command as the leader of a process group of its own (macOS has no setsid(1)), which reap stops once it ends, and exits with its code; where Claude Code's sandbox refuses the new group or the nice, it says so on stderr and runs the command without it
run_command() {
  local code
  [ "${KIND:-}" = clone ] && set -- python3 -I -c "$CLONE_WORKSPACES" "$@"
  if [ -n "${DOCKER:-}" ]; then
    capped_builder || { echo "run-slot.sh: could not make the capped builder $DOCKER_BUILDER, so this docker build does not run uncapped" >&2; rlog end "rc=1 ran=0s"; exit 1; }
    export BUILDX_BUILDER=$DOCKER_BUILDER DOCKER_BUILDKIT=1
  fi
  [ "${DOCKER:-}" = each ] && set -- "$BUN" "$(checkout_root)/packages/scripts/src/docker-build.ts" each -- "$@"
  python3 -I -c '
import os, sys
for step, call in (("its own process group", os.setsid), ("nice " + os.environ.get("RUN_SLOT_NICE", "10"), lambda: os.nice(int(os.environ.get("RUN_SLOT_NICE", "10"))))):
    try:
        call()
    except OSError as error:
        print(f"run-slot.sh: runs the command without {step} ({error.strerror})", file=sys.stderr)
os.execvp(sys.argv[1], sys.argv[1:])' "$@" <&3 3<&- &
  CHILD=$!
  # the child's record, the one handle preempt signals
  [ -n "$SLOT" ] && echo "$CHILD" > "$SLOT.child"
  wait "$CHILD"
  code=$?
  [ -n "$SLOT" ] && [ "$(cat "$SLOT.preempted" 2>/dev/null)" = "$CHILD" ] && echo "run-slot.sh: focus preempted this run for $(focus_holder || echo a session that has since ended); ask again once its focus ends" >&2
  reap "$CHILD"
  CHILD=""
  rlog end "rc=$code ran=$(($(date +%s) - TOOK))s"
  exit "$code"
}

reclaim() {
  # $1 is a slot directory that mkdir found taken: free it when its holder line ($2 of stale) has gone stale; the line and the directory are
  # read again just before the rmdir, so a waiter that freed and took the slot meanwhile keeps it
  local line dir
  line=$(cat "$1.holder" 2>/dev/null); dir=$(stamp "$1")
  stale "$1" "$line" || return 0
  [ "$(cat "$1.holder" 2>/dev/null)" = "$line" ] && [ "$(stamp "$1")" = "$dir" ] && rmdir "$1" 2>/dev/null
}

# the 5-minute load run-slot-2 in single-slot mode starts under, and a commit or quick start waits under (issue 1385): 22, or run-slot.load5-cap's cap while it stands (builder, 12 Oct: 12 while the live dashboard's terminal reads time out), 22 at most
# its cap is the file's last line, the one a set writes below its reason or an old-shape file's only one
load_line() {
  local cap
  cap=$(switch_on run-slot.load5-cap && tail -n 1 "$OPS/run-slot.load5-cap" | grep -xE '[0-9]{1,3}'); [ -n "$cap" ] || cap=22; [ "$cap" -le 22 ] || cap=22
  echo "$cap"
}
# sets OLDEST to the earliest second a live waiter's ticket in the queue first asked at, its line's sixth field, which survives a reread, else its name's leading nanosecond (an older copy's), else now, so the wait loop, first_waiter, room, slots and can-take time the load5 hold from one waiter; builtins alone
oldest_asked() {
  local t a p
  OLDEST=
  for t in "$QUEUE"/[0-9]*; do
    [ -e "$t" ] || break
    # a dead waiter's ticket times no hold (its name is <ns>-<pid>-<who>)
    p=${t##*/} p=${p#*-} p=${p%%-*}
    case "$p" in '' | *[!0-9]*) continue ;; esac
    alive "$p" || continue
    a=; read -r _ _ _ _ _ a _ 2>/dev/null < "$t"
    case "$a" in '' | *[!0-9]*) a=${t##*/} a=${a%%-*} a=${a:0:10} ;; esac
    case "$a" in '' | *[!0-9]*) continue ;; esac
    { [ -z "$OLDEST" ] || [ "$a" -lt "$OLDEST" ]; } && OLDEST=$a
  done
  [ -n "$OLDEST" ] || OLDEST=$(date +%s)
}
# whether load5 holds slots 2 to 4 shut: at or over load_line's cap, until the queue's oldest waiter has waited LOAD_WAIT s (issue 1403, 7 Nov 11:07Z: two checker suites in run-slot and run-slot-2 took load5 to 17.96 on their own); one verdict for a count or a look (HELD5, as LANES), the clock first
load5_held() {
  case "${HELD5-}" in 1) return 0 ;; 0) return 1 ;; esac
  local h=0
  oldest_asked
  [ $(($(date +%s) - OLDEST)) -lt "$LOAD_WAIT" ] && [ "$(load5)" -ge "$(load_line)" ] && h=1
  [ "${HELD5-}" = unread ] && HELD5=$h
  [ "$h" = 1 ]
}
# whether single, 3-off and 4-off stand lifted: load5 has read under load_line's cap for LIFT_HOLD s, from the first of readings UNDER holds no more than LIFT_GAP s apart (issue 1737, 11 Nov: single and a cap of 14 stood by timer at load5 5.6, and eight runs queued behind one lane); a reading at or over the cap removes UNDER, so the throttle holds again until its end time, and a reading under after a longer gap, which may have hidden one over, starts the hold again
lifted() {
  local l5= since= last= now s0
  read -r _ _ l5 _ <<< "$(loadavg)"; l5=${l5%%.*}
  case "$l5" in '' | *[!0-9]*) return 1 ;; esac
  if [ "$l5" -ge "$(load_line)" ]; then
    [ ! -e "$UNDER" ] || rm -f "$UNDER"
    return 1
  fi
  read -r since last 2>/dev/null < "$UNDER"
  now=$(date +%s) s0="$since $last"
  case "$since $last" in *[!0-9\ ]* | ' ' | *' ') since=$now ;; *) [ $((now - last)) -le "$LIFT_GAP" ] || since=$now ;; esac
  [ "$since $now" = "$s0" ] || under_write "$since $now"
  [ $((now - since)) -ge "$LIFT_HOLD" ]
}
# a waiting head's idle poll, with builtins alone but for its write, at most once in 30 s, while its load reads as its look read it: false once the hold in UNDER has ended since that look, so the head looks again and the throttle lifts on time, a hold restarted in place included; else it writes the poll's second as UNDER's last again, at most every 30 s, so the hold counts across polls with no look of their own (a reading at or over the cap moves the load's whole numbers, so the head looks instead)
under_seen() {
  local first= last= now
  [ -n "$LIFT_AT" ] || return 0
  read -r first last 2>/dev/null < "$UNDER" || return 0
  case "$first $last" in *[!0-9\ ]* | ' '* | *' ') return 0 ;; esac
  now=$((LIFT_AT + SECONDS - LIFT_S))
  [ "$LIFT_AT" -lt $((first + LIFT_HOLD)) ] && [ "$now" -ge $((first + LIFT_HOLD)) ] && return 1
  [ $((now - last)) -lt 30 ] || under_write "$first $now"
  return 0
}
# UNDER's line written whole: to a dotted file of this run's, which cheap_sig's run-slot* glob never reads, then moved over it, so another run's read never meets the empty file a truncating write leaves for a moment
under_write() { echo "$1" > "$OPS/.run-slot.under.$$" && mv -f "$OPS/.run-slot.under.$$" "$UNDER"; }
# whether the load rules open slot $1 to this run now
slot_open() {
  local s=$1
  # run-slot.single (builder, 9 Oct: heavy suites one at a time) closes slots 2 and 3 to new holders while it exists
  # ...except for the dashboard's own build and the merge train (12 Oct: single-slot mode left both waiting an hour behind testers' runs), which shut lanes leave run-slot-2 open to as well (retro 22: two 5/5 PRs sat about 55 min while the train raced the queue for run-slot alone)
  # #i162: in single-slot mode run-slot-2 still opens for a second suite; since 13 Oct (dispatcher, so work runs while the
  # machine allows) it opens on memory: free share 40% or more (ops, 19 Oct 01:16Z, from the optimizer: 9 Mac-only waiters at
  # pressure 1 with 43% free), pressure normal and swap-ins under SWAPINS_MAX (mem_ok), and the 5-minute load under 22 as a backstop
  if [ "$s" != run-slot ] && switch_on run-slot.single && [ "$WHO" != ops-dashboard ] && [ "$WHO" != ops-merge-train ] && ! lifted; then
    if [ "$s" = run-slot-2 ] && [ "$(load5)" -lt "$(load_line)" ] && mem_ok; then :; else return 1; fi
  elif [ "$s" != run-slot ] && [ "$WHO" != ops-dashboard ] && [ "$WHO" != ops-merge-train ] && { load5_held || { [ "$s" = run-slot-2 ] && ! lanes_now; }; }; then
    return 1
  fi
  # a third slot, approved by dispatcher (8 Oct), opens only while lanes_open does; a holder that took it finishes either way
  # run-slot.3-off closes it too (dispatcher, 18 Oct: the owner's machine loud at load1 29.6; two slots until load5 holds under 12 for 10 minutes)
  if [ "$s" = run-slot-3 ] && { { switch_on run-slot.3-off && ! lifted; } || ! lanes_now; }; then
    return 1
  fi
  # a fourth slot, dispatcher's factory call (18 Oct, a two-way door: 14 waiters at 12:40Z, 5/5 PRs to merge within 30 minutes): it opens
  # only while lanes_open does and run-slot.4-off is absent; Ops creates run-slot.4-off when load5 holds over 25 for
  # 10 minutes or the owner's dictation shows a delay
  if [ "$s" = run-slot-4 ] && { { switch_on run-slot.4-off && ! lifted; } || ! lanes_now; }; then
    return 1
  fi
  return 0
}
# the CPU idle share slots 2 to 4 open at under the load1 stop: 40, or run-slot.idle-min's bar while it stands, a whole number from 0 to 100 on the file's last line as load_line reads its cap (issue 1431: a constant bar left Ops no way to put more of a machine's cores to use short of a code change); any other value keeps 40
idle_min() {
  local bar
  bar=$(switch_on run-slot.idle-min && tail -n 1 "$OPS/run-slot.idle-min" | grep -xE '[0-9]{1,3}'); [ -n "$bar" ] && [ "$bar" -le 100 ] || bar=40
  echo "$bar"
}
# the load1 value slots 2 to 4 open under: 45, or run-slot.load1-max's stop while it stands, a whole number from 1 to 999 on the file's last line as idle_min reads its bar (issue 1442: a fixed stop flipped the lanes between why=load1 and why=cpu while the CPU read 55 to 57% idle and 15 runs waited on one lane, with no lever on the stop short of a code change); any other value keeps 45
load1_max() {
  local stop
  stop=$(switch_on run-slot.load1-max && tail -n 1 "$OPS/run-slot.load1-max" | grep -xE '[0-9]{1,3}'); [ -n "$stop" ] && [ "$stop" -ge 1 ] || stop=45
  echo "$stop"
}
# whether the gauges open slots 2 to 4: mem_ok passing and the CPU idle at idle_min's bar or more, 40% unless run-slot.idle-min says, under the load1 stop, 45 unless run-slot.load1-max says (issue 1442) (5 Nov, 06:19 to 07:45Z: a 50% bar from load1 30
# to 45 left the CPU at a median 48% idle, and 14 of its 30 CPU shuts read 40 to 49% idle) (dispatcher, 3 Nov: the resting sessions held load1 at 14 to 20 on 15 cores while the CPU sat 53 to 67% idle, so the old load1 lines of 12
# and the cores left one lane open with 24 to 33 runs waiting; retro 36, 4 Nov: at a load1 30 stop the lanes were shut 109 of 120 minutes
# with the CPU about half idle, and heavy runs waited up to 122 minutes); the load1 stop stays a hard stop for the spikes, load1 64 after a burst
# of starts and 73 after a clone; a run's verdict that differs from the last, run-slot.lanes, is a lanes line in run-slot.runs.log with the
# gauges, mem_ok's free share and pressure level and, when shut, why: the first of load1, cpu and mem that shut it (dispatcher, 5 Nov: retro 39
# counted 19 shuts by the CPU, 12 by memory and 6 by load1 from readings alone), while a read subcommand writes neither; an idle share that reads
# - is a dark sensor, not a busy CPU, so it opens under the load stop and memory, and only a reading that says busy, or one below the bar, shuts (issue 1818)
lanes_open() {
  local idle swap tps mbs load need="" verdict=shut why="" seen free level
  # a read subcommand takes the verdict a waiter wrote in the last 30 s (the head rewrites it each poll while the gauges shut a slot, and, while they open one, whenever a fresh reading moves the readings past their stamp, gate_sig), so room, can-take and head see the lanes as the queue's head saw them, since the CPU gate can flip between two readings seconds apart (issue 1216: 55% then 33% idle); with none that fresh it reads the gauges itself
  if [ -n "$CAN_TAKE" ] && seen=$(fresh_lanes); then [ "$seen" = open ]; return; fi
  read -r idle swap tps mbs _ <<< "$(gauges)"
  load=$(loadavg | awk '{print $2}')
  case "$idle" in
    -) told idle "run-slot.sh: cannot read the CPU's idle share (top -l 2 -n 0), so the lanes go by the load and memory alone" ;;
    busy) told busy "$BUSY_TOLD" ;;
  esac
  if [ "${load%.*}" -lt "$(load1_max)" ] 2>/dev/null; then need=$(idle_min); fi
  if [ -z "$need" ]; then
    why=load1
  elif [ "$idle" = busy ] || { [ "$idle" != - ] && ! [ "${idle%.*}" -ge "$need" ]; } 2>/dev/null; then
    why=cpu
  elif ! mem_ok; then
    why=mem
  else
    verdict=open
  fi
  seen=$(cat "$OPS/run-slot.lanes" 2>/dev/null)
  if [ -z "$CAN_TAKE" ]; then
    # every waiter's reading rewrites the verdict, so its age says how fresh it is (fresh_lanes)
    echo "$verdict" > "$OPS/run-slot.lanes.$$" && mv -f "$OPS/run-slot.lanes.$$" "$OPS/run-slot.lanes"
    if [ "$seen" != "$verdict" ]; then
      free=$(memstat level); level=$(memstat vm_pressure_level)
      rlog lanes "$verdict${why:+ why=$why} idle=$idle% load1=$load free=${free:--}${free:+%} pressure=${level:--} swapins=$swap disk0_tps=${tps:--} disk0_mbs=${mbs:--}"
    fi
  fi
  [ "$verdict" = open ]
}
# the lanes verdict a waiter wrote in the last 30 s, two of the head's polls at POLL 15; an older one, as a copy from before every look rewrote it leaves, or one the head last wrote with the lanes open, reads as none
fresh_lanes() {
  local m age v
  m=$(mtime "$OPS/run-slot.lanes") || return 1
  age=$(($(date +%s) - m))
  [ "$age" -ge 0 ] && [ "$age" -lt 30 ] || return 1
  v=$(cat "$OPS/run-slot.lanes" 2>/dev/null)
  case "$v" in open | shut) echo "$v" ;; *) return 1 ;; esac
}

# the UTC time $1 seconds ago as run-slot.runs.log writes it, by BSD date, else GNU date
iso_ago() {
  local now
  now=$(date +%s)
  date -u -r $((now - $1)) +%FT%TZ 2>/dev/null || date -u -d "@$((now - $1))" +%FT%TZ 2>/dev/null
}

# A burst of starts outruns the reading the slots open on, since load1 shows a run's load about a minute after it starts (issue 610, 2 Nov:
# five medium suites and two clones started in 70 s at load1 16, and load1 reached 64): while run-slot.runs.log shows more runs started on
# run-slot to run-slot-4 or the clone slot in the last minute than ended there, so the held runs grew, a medium or big run waits for the
# reading to show them and the slots fill one a minute; a run that takes a slot a run freed adds nothing and goes on, a small run goes on
# until its waiter has waited past BACKLOG_WAIT, and the dashboard's and the merge train's runs go on too, as they skip slot 2's
# lanes_open; prints how many runs the last minute added when it holds
burst_held() {
  local cutoff
  { [ "$SIZE" != small ] || [ "${waited:-0}" -ge "$BACKLOG_WAIT" ]; } && [ "$WHO" != ops-dashboard ] && [ "$WHO" != ops-merge-train ] || return 1
  cutoff=$(iso_ago 60) || return 1
  tail -n 3000 "$OPS/run-slot.runs.log" 2>/dev/null | CUTOFF=$cutoff awk '
    $2 == "start" && $5 ~ /^run-slot(-[234]|-clone)?$/ { run[$3 " " $4] = 1; if ($1 > ENVIRON["CUTOFF"]) n++ }
    $2 == "end" && run[$3 " " $4] { delete run[$3 " " $4]; if ($1 > ENVIRON["CUTOFF"]) n-- }
    END { if (n > 0) print n; exit !(n > 0) }'
}

# Load units: each held CPU slot's run counts the units on its holder line (2, a medium, for a line with none), and the slots the load rules open now, or a holder already has, give 2 units each. A quarter of them, at least 1, stays for small runs and the runs that gate a merge, so a big run never blocks a small one
held_units() { holders | awk '$1 == "slot" { t += $3 } END { print t + 0 }'; }
# a held commit or clone lane's 2 units, which count only against a run that leaves the reserve, so a medium or big run waits beside a commit's build and a clone while a small run and one that gates a merge start beside them as before (3 Nov, 06:41Z: a next build ran on the commit lane beside a clone with no units held, and load1 reached 56)
lane_units() { holders | awk '$1 == "lane" { t += $3 } END { print t + 0 }'; }
# every holder the load units count, one "<slot|lane> <start> <units>" line each: run-slot to run-slot-4 (its holder line's units, 2 for none), each
# live holder of another factory's run slots (slots.peers), read only, since that folder is theirs (ops, 31 Oct: the two pools took load1 to 77),
# and a held commit or clone lane (2); a start that cannot be read is "-", which no ticket's time sorts before
holders() {
  local d s line at u
  for s in run-slot run-slot-2 run-slot-3 run-slot-4; do
    reclaim "$OPS/$s"
    [ -d "$OPS/$s" ] || continue
    at="" u=""
    read -r _ _ at u _ 2>/dev/null < "$OPS/$s.holder"
    case "$u" in 1 | 2 | 3) ;; *) u=2 ;; esac
    echo "slot ${at:--} $u"
  done
  for s in run-slot-commit run-slot-clone; do
    reclaim "$OPS/$s"
    [ -d "$OPS/$s" ] || continue
    at=""
    read -r _ _ at _ 2>/dev/null < "$OPS/$s.holder"
    echo "lane ${at:--} 2"
  done
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    for s in run-slot run-slot-2 run-slot-3 run-slot-4; do
      [ -d "$d/$s" ] || continue
      line=$(cat "$d/$s.holder" 2>/dev/null)
      stale "$d/$s" "$line" && continue
      at="" u=""
      read -r _ _ at u _ <<< "$line"
      case "$u" in 1 | 2 | 3) ;; *) u=2 ;; esac
      echo "slot ${at:--} $u"
    done
  done <<< "$PEERS"
}
# the units held against a run that must leave $1 free: the CPU slots' and peers' (held_units's $2 when given), plus the lanes' less $3 when $1 is over 0, never under 0
held_for() {
  # an out-variable's local carries a name no caller's target holds, since printf -v assigns the nearest scope holding that name (this function's own local h once swallowed its caller's h)
  local hh=${2:-$(held_units)}
  # $5 given names the walk's one lane_units read, so a walk pays no read a ticket (issue 1654)
  [ "$1" -gt 0 ] && hh=$((hh + ${5:-$(lane_units)} - ${3:-0}))
  [ "$hh" -ge 0 ] || hh=0
  if [ -n "${4:-}" ]; then printf -v "$4" '%s' "$hh"; else echo "$hh"; fi
}
# lanes_open, once per capacity() count: its slot checks share the first one's verdict, since a reading per slot counted slot 2 shut on a stale reading and slots 3 and 4 open on one that landed between them; a waiter's checks take the verdict its last look_mark read until its next look, and outside the wait loop and a count LANES is unset, so each check reads afresh
lanes_now() {
  case "${LANES-}" in
    open) return 0 ;;
    shut) return 1 ;;
    unread) if lanes_open; then LANES=open; else LANES=shut; return 1; fi ;;
    *) lanes_open ;;
  esac
}
capacity() {
  local s n=0 LANES=${LANES:-unread} HELD5=${HELD5:-unread}
  for s in run-slot run-slot-2 run-slot-3 run-slot-4; do
    { [ -d "$OPS/$s" ] || slot_open "$s"; } && n=$((n + 1))
  done
  echo $((2 * n))
}
# the one gate: whether a run of rank $1, $2 units and size $3, for $4, fits the load units free now, beside $6 held within capacity $5 when given (with $7 of the lanes' units left out); the wait loop, first_waiter, room and can-take all read it, so a lane room counts as free is one the queue's next run can take (issue 1216)
unit_fits() {
  local c=${5:-$(capacity)} m h r
  r=$(($c / 4)); [ "$r" -ge 1 ] || r=1
  may_reserve "$1" "$3" "$4" "$r" m ${9+"$9"}
  # the walk's lane units pass through empty, so held_for reads its own only when it needs one, and a call that names none keeps its old cost (issue 1818)
  held_for "$m" "${6:-}" "${7:-0}" h "${8:-}"
  fits "$h" "$2" $((c - m))
}
# whether a run of $2 units fits beside $1 held within a limit of $3; any run fits while no slot is held, so a big run still starts on a quiet machine
fits() { [ "$1" -eq 0 ] || [ $(($1 + $2)) -le "$3" ]; }
reserve() { local r=$(($1 / 4)); [ "$r" -ge 1 ] && echo "$r" || echo 1; }
# the units a run must leave free: none for a small run, one that gates a merge (rank 0x), an org's run (1x) or the run-slot.priority pick, else the reserve; with $5 given it is set instead of echoed, and $6 given names the holder the walk read once, empty when none stands, so a walk pays no read a ticket; callers without $6 read their own (issue 1654), and the two no-holder shapes differ: empty says the walk found none and skips prio_for, unset says none was passed and prio_for reads its own, so the match needs a non-empty holder
may_reserve() {
  local rr
  case "$2" in small) rr=0 ;; *)
    case "$1" in 0?|1?) rr=0 ;; *)
      if [ -z "$3" ]; then rr=$4
      elif [ -n "${6+x}" ]; then { [ -n "$6" ] && [ "$(owner_of "$3")" = "$6" ]; } && rr=0 || rr=$4
      elif prio_for "$3"; then rr=0; else rr=$4; fi
    ;; esac
  ;; esac
  if [ -n "${5:-}" ]; then printf -v "$5" '%s' "$rr"; else echo "$rr"; fi
}

# the load averages as `{ <1m> <5m> <15m> }`: from sysctl, else from uptime, since Claude Code's sandbox refuses the sysctl command's name lookup
loadavg() { sysctl -n vm.loadavg 2>/dev/null || LC_ALL=C uptime 2>/dev/null | sed -nE 's/.*load averages?: *([^ ,]+),? +([^ ,]+),? +([^ ,]+).*/{ \1 \2 \3 }/p'; }
load1() { loadavg | awk '{print int($2)}'; }
load5() { loadavg | awk '{print int($3)}'; }
# the swap-ins over vm_stat -c 2 1's one second: its second row under the header, never the first, which counts since boot; nothing when either row is missing
swapin_rate() {
  vm_stat -c 2 1 2>/dev/null | awk '!c { for (i = 1; i <= NF; i++) if ($i == "swapins") c = i; next } { n++; v = $c } END { if (n == 2 && v ~ /^[0-9]+$/) print v }'
}
# disk0's `<transfers/s> <MB/s>` over iostat -d -c 2 -w 1 disk0's one second: its second row, never the first, which counts since boot; nothing when either row is missing
disk_rate() {
  iostat -d -c 2 -w 1 disk0 2>/dev/null | awk 'NF == 3 && $2 ~ /^[0-9]+$/ { n++; t = $2; m = $3 } END { if (n == 2) print t, m }'
}
# the swap-ins a second at which memory has no room for another heavy run: spawn.sh's line for a GLM start, the gates.glmSwapinsMax setting's default (packages/settings/src/gates.ts): change both together
SWAPINS_MAX=100
# what a look says once a run while another takes the first reading of the gauges
BUSY_TOLD="run-slot.sh: another look is reading the CPU's idle share and the swap-ins, so slots 2 to 4 stay shut until it lands"
# `<idle> <swapins> <disk0 transfers/s> <disk0 MB/s> <the last reading's swapins>`: the CPU's idle share in top's second sample (top -l 2 -n 0), the swap-ins a second in
# vm_stat -c 2 1's last row (as spawn.sh's swapins() reads them) and disk_rate's two figures, which lanes lines log and no verdict reads (a bound on disk load waits on a day of them), each - when unread; every look shares one reading through run-slot.gauges
# (`<epoch> <idle> <swapins> <tps> <MB/s> <last swapins>`) for 10 s, since a top takes a second and about 0.7 s of system CPU, and the head waiter of a queue reads them every poll while they shut a slot, and, while they open one, whenever a fresh reading of them moves the readings past their stamp;
# one look refreshes it, under gauges_lock, while the rest keep the reading they have, or `busy busy` when there is none yet, since without the
# lock every look that found it stale ran its own top (3 Nov, 10:53Z: 16 to 23 tops at once from 26 waiters, and load1 56.8); the refresher
# removes the lock only while it still carries the mtime it took, so a refresher that ran past a takeover leaves the new holder's lock
gauges() {
  local now cached= idle= swap= tps= mbs= last= took lock="$OPS/run-slot.gauges.lock"
  now=$(date +%s)
  { read -r cached idle swap tps mbs last < "$OPS/run-slot.gauges"; } 2>/dev/null
  case "$cached" in ''|*[!0-9]*) cached=0 ;; esac
  if [ $((now - cached)) -ge 10 ]; then
    if took=$(gauges_lock "$now"); then
      idle=$(top -l 2 -n 0 2>/dev/null | sed -nE 's/^CPU usage:.* ([0-9.]+)% idle.*/\1/p' | awk 'END { if (NR == 2) print }')
      last=$swap
      swap=$(swapin_rate)
      read -r tps mbs <<< "$(disk_rate)"
      printf '%s %s %s %s %s %s\n' "$now" "${idle:--}" "${swap:--}" "${tps:--}" "${mbs:--}" "${last:--}" > "$OPS/run-slot.gauges.$$" 2>/dev/null && mv -f "$OPS/run-slot.gauges.$$" "$OPS/run-slot.gauges" 2>/dev/null
      [ "$(mtime "$lock")" = "$took" ] && rmdir "$lock" 2>/dev/null
    elif [ "$cached" -eq 0 ]; then
      idle=busy swap=busy
    fi
  fi
  echo "${idle:--} ${swap:--} ${tps:--} ${mbs:--} ${last:--}"
}
# takes the gauges' refresh lock at epoch $1, or one aged 30 s or more by its mtime, which a refresher killed mid-refresh left (a refresh
# takes about 2 s), and prints the mtime it took the lock at (scripts/ops/README.md says why two takeovers together are harmless)
gauges_lock() {
  local now=$1 lock="$OPS/run-slot.gauges.lock" born
  if ! mkdir "$lock" 2>/dev/null; then
    born=$(mtime "$lock") || return
    [ $((now - born)) -ge 30 ] && rmdir "$lock" 2>/dev/null && mkdir "$lock" 2>/dev/null || return
  fi
  mtime "$lock"
}
# macOS's memory reading $1: level (the free share) or vm_pressure_level (1 normal, 2 warn, 4 critical)
memstat() { sysctl -n "kern.memorystatus_$1" 2>/dev/null | tr -cd 0-9; }
# memory room for a second suite: macOS's free share at 40% or more, its pressure level normal (1; 2 is warn, 4 critical) and swap-ins under SWAPINS_MAX a
# second in this reading or the last, since a one-second sample spikes and falls back (5 Nov, 06:19 to 07:45Z: 17 of the 24 memory shuts came at pressure 1
# with 70 to 80% free, from readings such as 128, 242 and 1116 between 0, 8, 20 and 44); an unread reading (Claude Code's sandbox refuses the first two) leaves no room, said once a run on stderr
MEM_TOLD="${TMPDIR:-/tmp}/run-slot-mem-told.$$"
# says line $2 once a run on stderr, a file per kind ($1) marking it, since a look reads the gauges in a subshell
told() { [ -e "$MEM_TOLD-$1" ] || { echo "$2" >&2; : > "$MEM_TOLD-$1"; }; }
mem_unread() { told "$1" "run-slot.sh: cannot read the memory (sysctl kern.memorystatus_*), so $2"; }
mem_ok() {
  local free level swap last
  free=$(memstat level); level=$(memstat vm_pressure_level)
  if [ -z "$free" ] || [ -z "$level" ]; then
    mem_unread suite "no second suite runs beside this one"
    return 1
  fi
  read -r _ swap _ _ last <<< "$(gauges)"
  case "$swap" in
    -) told swap "run-slot.sh: cannot read the swap-ins (vm_stat -c 2 1), so no second suite runs beside this one"; return 1 ;;
    busy) told busy "$BUSY_TOLD"; return 1 ;;
  esac
  [ "$free" -ge 40 ] && [ "$level" -eq 1 ] && { [ "$swap" -lt "$SWAPINS_MAX" ] || ! [ "$last" -ge "$SWAPINS_MAX" ] 2>/dev/null; }
}

# Dictation misses come from input delay under load, so every command runs under nice 10, and the
# factory's CPU-heavy work yields to the owner's foreground apps; the live dashboard's own runs (ops-dashboard) keep normal priority
if [ "$WHO" = ops-dashboard ]; then export RUN_SLOT_NICE=0; else export RUN_SLOT_NICE="${RUN_SLOT_NICE:-10}"; fi
# the model-bound cap: slots.modelBound by setting(), and 2 when the reader cannot answer
model_cap() {
  local cap
  cap=$(setting slots.modelBound)
  case "$cap" in [1-9]|1[0-6]) echo "$cap" ;; *) echo 2 ;; esac
}
if [ -n "$MODEL_BOUND" ]; then
  CAP=$(model_cap)
  WAIT_FROM=$SECONDS MAT=0
  while :; do
    for n in $(seq 1 "$CAP"); do
      mkdir "$OPS/run-slot-model-$n" 2>/dev/null && { SLOT="$OPS/run-slot-model-$n"; break 2; }
      reclaim "$OPS/run-slot-model-$n"
    done
    reread
    waited=$((SECONDS - WAIT_FROM))
    if [ "$waited" -ge "$MAT" ]; then
      echo "run-slot.sh: waiting for one of the $CAP model-bound slots" >&2
      MAT=$(((waited / 300 + 1) * 300))
    fi
    sleep "$POLL"
  done
  echo "$WHO $$ $(date -u +%FT%TZ) 0 model" > "$SLOT.holder"
  echo "run-slot.sh: $WHO holds $(basename "$SLOT")" >&2
  TOOK=$(date +%s); rlog start "$(basename "$SLOT") waited=$((TOOK - ASKED))s"
  run_command "$@"
fi
# One docker build at a time on the machine, since each fills the Docker VM the live dashboard's Postgres shares (6 Nov 00:38Z: a parallel compose build got it killed): run-slot-docker is taken before the ticket, so a waiting build holds no place in the queue, and reclaimed only once its holder's pid has gone
if [ -n "$DOCKER" ]; then
  [ -n "$TICKET" ] && rm -f "$TICKET" && TICKET=""
  WAIT_FROM=$SECONDS DAT=0
  until mkdir "$OPS/run-slot-docker" 2>/dev/null; do
    reclaim "$OPS/run-slot-docker"
    reread
    waited=$((SECONDS - WAIT_FROM))
    if [ "$waited" -ge "$DAT" ]; then
      echo "run-slot.sh: waiting for run-slot-docker, one docker build at a time ($(cat "$OPS/run-slot-docker.holder" 2>/dev/null))" >&2
      DAT=$(((waited / 300 + 1) * 300))
    fi
    sleep "$CLONE_POLL"
  done
  DOCKER_SLOT="$OPS/run-slot-docker"
  echo "$WHO $$ $(date -u +%FT%TZ)" > "$DOCKER_SLOT.holder"
  ticket
fi
KIND=$(quick_kind "$@")
# the merge train's quick run starts at once, past the quick slot's race: only pr:merge's types gate runs as ops-merge-train, inside the merge lock, which keeps it to one run at a time (PG-796, 3 Nov: its 1 s metrics step waited 263 s for the slot, and its cached build ran past the gate's 600 s twice)
if [ "$KIND" = quick ] && [ "$WHO" = ops-merge-train ]; then
  [ -n "$TICKET" ] && rm -f "$TICKET" && TICKET=""
  TOOK=$(date +%s); rlog start "bare waited=$((TOOK - ASKED))s"
  run_command "$@"
fi
if [ -n "$KIND" ]; then
  [ -n "$TICKET" ] && rm -f "$TICKET" && TICKET=""
  WAIT_FROM=$SECONDS FAT=0 CAT=0
  # run-slot.clone-off holds every clone while it exists (dispatcher, 18 Oct, with run-slot.3-off)
  # run-slot.clone-allow holds, one a line, grep patterns for the clones a lead lets through while clone-off stands (builder, 18 Oct: priority clones in order; every checker by default, finish-first)
  # clone-off lets a clone through while load1 and load5 are under 30 and memory passes spawn.sh's gate, pressure level 1 or 2 with 8% or more free (dispatcher, 19 Oct 01:18Z;
  # builder, 19 Oct); spawn.sh keeps its 8 inside its own Python, so the number is written twice until one home holds it
  # load1 counts since load5 lags a fresh spike (optimizer, 19 Oct 03:42Z: a clone let through at load5 under 30 took load1 to 73)
  # an unread memory reading (Claude Code's sandbox refuses it) holds the clone, said once a run
  clone_held() {
    [ "$KIND" = clone ] && switch_on run-slot.clone-off && ! printf "%s\n" "$WHO" | grep -qxf "$OPS/run-slot.clone-allow" 2>/dev/null || return 1
    [ -n "$(memstat level)" ] || { mem_unread clone "run-slot.clone-off holds this clone until it expires or run-slot.clone-allow names $WHO"; return 0; }
    ! { case "$(memstat vm_pressure_level)" in 1|2) true ;; *) false ;; esac && [ "$(memstat level)" -ge 8 ] 2>/dev/null && [ "$(load5)" -lt 30 ] && [ "$(load1)" -lt 30 ]; }
  }
  # a clone waiter's place, run-slot.clone-waiters/<class>-<asked second>.<nanoseconds>-<pid>-<who>, keeps its name across a reread's exec, so a new copy a gate holds drops it until the gates pass (review round 1: it held back every clone clone-allow let through), and one no gate holds keeps its place; the nanoseconds keep two clones that ask in one second in ask order, where seconds alone tied and the glob fell to the pid (issues 1619, 1688)
  CLONE_QUEUE="$OPS/run-slot.clone-waiters"
  if [ "$KIND" = clone ]; then
    # the whole stamp from one read, since a second from one read and nanoseconds from another straddle the second between them and stamp an earlier ask after a newer one; where the read is refused, $ASKED.0 names the ticket, takes the earliest place in its second, and hands the same name through a reread
    [ -n "$ASK_STAMP" ] || ASK_STAMP=$(python3 -I -c 'import time; t = time.time_ns(); print(f"{t // 10**9}.{t % 10**9:09d}")' 2>/dev/null)
    [ -n "$ASK_STAMP" ] || ASK_STAMP="$ASKED.0"
    CLONE_TICKET="$CLONE_QUEUE/$CLASS-$ASK_STAMP-$$-$WHO"
    # the second, on this image's clock, past which this clone passes the big-run hold (CLONE_WAIT_MAX)
    CLONE_PASS_AT=$((SECONDS + ASKED + CLONE_WAIT_MAX - $(date +%s)))
  fi
  while clone_held; do rm -f "$CLONE_TICKET"; reread; sleep "$CLONE_POLL"; done
  # whether this clone passes the big-run hold: the Dashboard roll's, so a ship reaches the live Dashboard (issue 1314, 7 Nov: a roll waited about 13 minutes behind a worker's test run), or one that has waited CLONE_WAIT_MAX s
  clone_passes_big() { [ "$WHO" = ops-dashboard ] || [ "$SECONDS" -ge "$CLONE_PASS_AT" ]; }
  # a clone waits CLONE_GAP s after the last clone's end, while load5 is within CLONE_MARGIN of the brake, one per core, or at half the cores or more where that line sits lower (under 8 cores; on 4 or fewer the brake less the margin is 0 or less and would hold every clone), and while a big run holds a CPU slot, whatever clone-allow names, but for a clone clone_passes_big lets by; an unread load5 holds no clone (only where sysctl and uptime are both refused), while the gap and the big-run hold still stand (6 Nov, 02:45Z: one clone drove fseventsd to 226% CPU, load1 from 29 to 32.5 and load5 to 15.8, which engaged the brake); prints why it waits, nothing when it goes
  clone_spaced() {
    local brake line l s last
    brake=$(clone_brake)
    line=$((brake - CLONE_MARGIN))
    [ "$line" -lt $(((brake + 1) / 2)) ] && line=$(((brake + 1) / 2))
    l=$(load5)
    [ -n "$l" ] && [ "$l" -ge "$line" ] && { echo "for load5 under $line, the brake's $brake less $CLONE_MARGIN and never under half of it"; return; }
    clone_passes_big || for s in run-slot run-slot-2 run-slot-3 run-slot-4; do
      reclaim "$OPS/$s"
      [ -d "$OPS/$s" ] && [ "$(cut -d' ' -f5 "$OPS/$s.holder" 2>/dev/null)" = big ] && { echo "while a big run holds $s"; return; }
    done
    last=$(tail -n 3000 "$OPS/run-slot.runs.log" 2>/dev/null | CUTOFF=$(iso_ago "$CLONE_GAP") awk '
      $2 == "start" && $5 == "run-slot-clone" { run[$3 " " $4] = 1 }
      $2 == "end" && run[$3 " " $4] { delete run[$3 " " $4]; t = $1 }
      END { if (ENVIRON["CUTOFF"] != "" && t > ENVIRON["CUTOFF"]) print t }')
    [ -n "$last" ] && echo "${CLONE_GAP}s past the last clone's end at $last"
  }
  # a commit's build, a merge or a clone is heavy, so it waits under focus or the battery's red mark; the quick slot's short runs go on
  while [ "$KIND" != quick ] && verdict_holds; do
    [ -z "$CLONE_TICKET" ] || rm -f "$CLONE_TICKET"
    reread
    hold_wait
  done
  # bash 5.2 can fail to parse the TERM trap while it expands a "$(...)" and then drop the loop it was in (measured on the runner host:
  # the waiter ran its command with no slot), so each wait checks it ended as it should, and the waiter stops when it did not
  clone_held && { echo "run-slot.sh: run-slot.clone-off holds this clone, so $WHO stops" >&2; exit 143; }
  # a commit or quick start waits on load5 under load_line's cap, for LOAD_WAIT s at most (scripts/ops/README.md's run-slot bullets; issue 1385); its idle poll starts its load read and its sleep (issue 1338), so it reads the cap again only when the switch file appears, goes or changes, or once a minute
  if [ "$KIND" != clone ] && [ "$WHO" != ops-dashboard ] && [ "$WHO" != ops-merge-train ] && [ "$WHO" != ops-tick ]; then
    # LT0 the wait's start, LCAP the cap, LCT when it was read, LCF the switch file, LCE and LE whether it stood then and now, LDONE set on each way out; load5 is parsed inline, not through load5(), so a poll starts one process for it
    LT0=$SECONDS LSAID= LDONE= LCAP=$(load_line) LCT=$SECONDS LCE=
    LCF="$OPS/run-slot.load5-cap"
    [ -e "$LCF" ] && LCE=1
    : > "$REF" 2>/dev/null
    while :; do
      self_changed && reread
      LE=; [ -e "$LCF" ] && LE=1
      if [ "$LE" != "$LCE" ] || [ $((SECONDS - LCT)) -ge 60 ] || { [ -n "$LE" ] && ! [ "$LCF" -ot "$REF" ]; }; then
        LCAP=$(load_line) LCT=$SECONDS LCE=$LE
        : > "$REF" 2>/dev/null
      fi
      L5=; read -r _ _ L5 _ <<< "$(loadavg)"; L5=${L5%%.*}
      # an unread load holds no start
      case "$L5" in '' | *[!0-9]*) LDONE=1; break ;; esac
      [ "$L5" -lt "$LCAP" ] && { LDONE=1; break; }
      [ $((SECONDS - LT0)) -ge "$LOAD_WAIT" ] && { echo "run-slot.sh: load5 $L5 is still at or over $LCAP after $((SECONDS - LT0))s, so this $KIND run starts" >&2; LDONE=1; break; }
      [ -z "$LSAID" ] && { echo "run-slot.sh: waiting for load5 under $LCAP (now $L5) before the $KIND slot, ${LOAD_WAIT}s at most" >&2; LSAID=1; }
      sleep "$POLL"
    done
    # a loop bash dropped mid-expansion (the rule above) set no flag, so the waiter stops rather than run
    [ -n "$LDONE" ] || dropped "load5"
  fi
  # clone waiters take the lane in the heavy queue's order, class then ask time (issue 1317, 7 Nov: the first mkdir won, and a clone waited 13385 s while five asked after it passed): each leaves its place in CLONE_QUEUE holding its start time
  # pid $1's start time, from ps, else from the kernel's process table, since Claude Code's sandbox refuses the setuid ps
  started_at() {
    local s
    s=$(LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null) || s=$(python3 -I "$(dirname "$(realpath "$SELF")")/ptable.py" started "$1" 2>/dev/null | cut -d' ' -f2-)
    echo $s
  }
  # FIRST: the entry of the clone waiter that goes next, by the glob's order (a 1-digit class, then the asked second.nanoseconds), dropping each one before it whose pid is gone, or every 12th poll, the full reread's beat, whose pid shows another start time, since a waiter can die without its exit (issue 1316) and a read of the start time starts ps (issue 1338)
  clone_first() {
    local t n pid st c
    FIRST=
    for t in "$CLONE_QUEUE"/[0-9]*; do
      [ -e "$t" ] || continue
      n=${t##*/} pid=${n#*-*-} pid=${pid%%-*} st=
      [ "$t" = "$CLONE_TICKET" ] && { FIRST=$n; return; }
      # a start time either side could not read keeps the entry, since an empty read is no proof the pid was taken
      alive "$pid" && { [ $((polls % 12)) -ne 0 ] || { { read -r st < "$t"; } 2>/dev/null; c=$(started_at "$pid"); [ -z "$st" ] || [ -z "$c" ] || [ "$c" = "$st" ]; }; } && { FIRST=$n; return; }
      rm -f "$t"
    done
  }
  if [ "$KIND" = clone ]; then
    mkdir -p "$CLONE_QUEUE"
    started_at $$ > "$CLONE_QUEUE/.$$" && mv "$CLONE_QUEUE/.$$" "$CLONE_TICKET"
  fi
  # the clone's spacing is shared, so one waiter works it out about every 15 to 24 s for all of them (issue 1338): run-slot.clone-verdict holds the CPU slots' and
  # the clone lane's holder lines it was worked out under, then its verdict, and a waiter takes one written no earlier than its own last tick under the same lines, so a verdict serves up to 48 s
  CLONE_VERDICT="$OPS/run-slot.clone-verdict"
  clone_holders() { local s l; HL=; for s in run-slot run-slot-2 run-slot-3 run-slot-4 run-slot-clone; do l=; [ -d "$OPS/$s" ] && { read -r l 2>/dev/null < "$OPS/$s.holder"; l="held $l"; }; HL="$HL|$l"; done; }
  clone_verdict() {
    local h v f=$CLONE_VERDICT
    # a clone that passes the big-run hold shares a verdict file of its own, on the same tick, and a waiter crossing CLONE_WAIT_MAX works it out at once
    clone_passes_big && f="$CLONE_VERDICT-nobig"
    clone_holders
    if [ -n "$CT0" ] && [ $((SECONDS - CT0)) -lt "$CTICK" ] && [ "$HL" = "$CHL" ] && [ "$f" = "$CVF" ]; then spaced=$CSP; return; fi
    h= v=
    { read -r h; read -r v; } 2>/dev/null < "$f"
    if [ -n "$CT0" ] && [ -e "$f" ] && ! [ "$REF" -nt "$f" ] && [ "$h" = "$HL" ]; then
      CSP=$v
    else
      CSP=$(clone_spaced)
      printf '%s\n%s\n' "$HL" "$CSP" > "$f" 2>/dev/null
    fi
    : > "$REF" 2>/dev/null
    CT0=$SECONDS CHL=$HL CVF=$f spaced=$CSP
  }
  # each waiter ticks every 15 to 24 s, its own length, so waiters that started together do not all find the verdict stale in the same second
  CT0= CHL= CSP= CVF= CTICK=$((15 + RANDOM % 10))
  : > "$REF" 2>/dev/null
  GOT=
  polls=0
  LOOPS_LEFT=${RUN_SLOT_TEST_LOOP_END:-0}
  while :; do
    # RUN_SLOT_TEST_LOOP_END ends this loop once with no lane taken, the way bash 5.2's loop drop (the rule at the load5 wait) does, so a test can hold the guard after it to its contract
    [ "$LOOPS_LEFT" -gt 0 ] && { LOOPS_LEFT=$((LOOPS_LEFT - 1)); break; }
    spaced=
    waited=$((SECONDS - WAIT_FROM))
    self_changed && reread
    [ "$KIND" = clone ] && clone_verdict
    if [ "$KIND" = clone ] && [ -z "$spaced" ]; then
      clone_first
      [ -n "$FIRST" ] && [ "$FIRST" != "${CLONE_TICKET##*/}" ] && spaced="behind ${FIRST#*-*-*-}, who asked first"
    fi
    if [ -z "$spaced" ]; then
      if ! [ -d "$OPS/run-slot-$KIND" ]; then
        mkdir "$OPS/run-slot-$KIND" 2>/dev/null && { GOT=1; break; }
      fi
      [ $((polls % 3)) -eq 0 ] && reclaim "$OPS/run-slot-$KIND"
    fi
    # the full reread, a stat, every 12th poll, about a minute; a newer mtime than the last tick's is read at the top of the poll, before a tick moves it
    [ $((polls % 12)) -eq 0 ] && reread
    polls=$((polls + 1))
    if [ "$waited" -ge "$CAT" ]; then
      if [ -n "$spaced" ]; then echo "run-slot.sh: this clone waits $spaced" >&2; else echo "run-slot.sh: waiting for the $KIND slot ($(cat "$OPS/run-slot-$KIND.holder" 2>/dev/null))" >&2; fi
      CAT=$(((waited / 300 + 1) * 300))
    fi
    sleep "$CLONE_POLL"
  done
  [ -n "$GOT" ] || dropped "$KIND lane's"
  [ -n "$CLONE_TICKET" ] && rm -f "$CLONE_TICKET" && CLONE_TICKET=""
  SLOT="$OPS/run-slot-$KIND"
  ends=""
  [ "$KIND" = clone ] && ends=$(clone_ends "$@")
  echo "$WHO $$ $(date -u +%FT%TZ)$ends" > "$SLOT.holder"
  echo "run-slot.sh: $WHO holds run-slot-$KIND" >&2
  TOOK=$(date +%s); rlog start "run-slot-$KIND waited=$((TOOK - ASKED))s"
  run_command "$@"
fi

# slots.peers, one folder a line, read once here since held_units runs in a subshell; a reader that cannot answer counts no peer
PEERS=$(setting slots.peers 2>/dev/null | python3 -I -c 'import json, sys; [print(p) for p in json.load(sys.stdin) if isinstance(p, str)]' 2>/dev/null)
[ -n "$HEAD_ONLY" ] && { first_waiter; exit 0; }
[ -n "$SLOTS_ONLY" ] && { echo $(($(capacity) / 2)); exit 0; }
if [ -n "$ROOM_ONLY" ]; then
  held=0
  for s in run-slot run-slot-2 run-slot-3 run-slot-4; do
    reclaim "$OPS/$s"
    [ -d "$OPS/$s" ] && held=$((held + 1))
  done
  c=$(capacity)
  free=0
  waiters=$(ordered_waiters | grep -c .)
  # the free lanes are the ones the queue's next run can take: first_waiter's own units, none while no waiter can start, a medium's with no waiter; none while a hold stands, since it holds the queue's next run (issue 1818)
  if ! verdict_holds; then
    t=$(first_waiter)
    if [ -n "$t" ]; then
      set -- $(cat "$QUEUE/$t" 2>/dev/null)
      unit_fits "${2:-22}" "${3:-2}" "${4:-medium}" "${t#*-*-}" "$c" && free=$((c / 2 - held))
    elif [ "$waiters" = 0 ]; then
      unit_fits 22 2 medium "" "$c" && free=$((c / 2 - held))
    fi
  fi
  echo "$((c / 2)) $held $free $waiters"
  exit 0
fi

if [ -n "$CAN_TAKE" ]; then
  if [ -n "$CAN_TICKET" ]; then
    rank="" UNITS="" SIZE=""
    read -r _ rank UNITS SIZE _ 2>/dev/null < "$QUEUE/$CAN_TICKET"
    case "$rank" in [0-2][1-3]) CLASS=${rank%?} ;; *) CLASS=2 ;; esac
    case "$UNITS" in 1 | 2 | 3) ;; *) UNITS=2 SIZE=medium ;; esac
    # the ticket's own wait, its ask's time_ns in its name, so a small one past the backlog line answers for the hold the queue holds it under (issue 1417); a session-name ask has no wait to read and reads as fresh
    waited=$((($(date +%s) - ${CAN_TICKET%%-*} / 1000000000)))
  fi
  # the holds the wait loop obeys first (its hold check) answer here too, so a held run reads closed to the verdict while it holds (issue 1818), and the stderr line names the hold, the battery's first as hold_wait names it, for ops-unstick's slot-stuck alert (issue 1842); the line comes from the reads verdict_holds made, FOCUS_HOLDER set only when the battery did not hold, so a lapse between two reads prints no empty name (issue 1647)
  FOCUS_HOLDER=
  if verdict_holds; then
    if [ -n "$FOCUS_HOLDER" ]; then echo "run-slot.sh: held by run-slot.focus for $FOCUS_HOLDER" >&2; else echo "run-slot.sh: held by run-slot.battery" >&2; fi
    exit 1
  fi
  reclaim "$OPS/$CAN_TAKE"
  [ ! -d "$OPS/$CAN_TAKE" ] && slot_open "$CAN_TAKE" && ! burst_held > /dev/null || exit 1
  unit_fits "$CLASS$UNITS" "$UNITS" "$SIZE" "$WHO"
  exit
fi

WAIT_FROM=$SECONDS FAT=0 QAT=0 UAT=0 BAT=0 SAT=0
# a waiter that is not at the head and has waited past the backlog line polls at twice POLL (issue 1338)
case "$POLL" in *[!0-9]*) SLOW_POLL=$POLL ;; *) SLOW_POLL=$((2 * POLL)) ;; esac
nap() { if [ "$LOOKER" = 0 ] && [ "$waited" -ge "$BACKLOG_WAIT" ]; then sleep "$SLOW_POLL"; else sleep "$POLL"; fi; }
while :; do
  waited=$((SECONDS - WAIT_FROM))
  if [ -n "$LOOKED" ] && cheap_idle; then
    nap
    continue
  fi
  look_mark
  # the script's stamp is read after the mark, so a copy put in place once it is read is no older than the mark, and the next poll finds it (issue 1414)
  reread
  # HEAD: first in the queue (any slot); S2: first among waiters that can take run-slot-2, so an older copy at the head cannot idle it
  HEAD=1; S2=1; fw= fw2=
  if [ -n "$TICKET" ] && prio_for "$WHO"; then
    [ "$(prio_first)" = "${TICKET##*/}" ] || { HEAD=0; S2=0; }
    oldest_is_me && { fw=$(first_waiter); fw2=$(first_waiter s2); }
  elif [ -n "$TICKET" ]; then
    fw=$(first_waiter); fw2=$(first_waiter s2)
    [ "$fw" = "${TICKET##*/}" ] || HEAD=0
    [ "$fw2" = "${TICKET##*/}" ] || S2=0
  fi
  # the oldest waiter names who goes next, "<first_waiter> <first_waiter s2> <prio_first>", under the priority pick too, so a waiter its look passed over, the
  # pick's next ticket included once its first has gone, looks again at once (its poll reads run-slot.next); each write is a `next` line in run-slot.runs.log,
  # so a window where head named a waiter the line passed over reads back who the oldest named and when (issue 1477)
  if [ -n "$TICKET" ] && oldest_is_me; then
    pf=; [ -e "$OPS/run-slot.priority" ] || [ -e "$OPS/run-slot.focus" ] && pf=$(prio_first)
    nx=; read -r nx 2>/dev/null < "$NEXTF"
    if [ "$nx" != "${fw:--} ${fw2:--} ${pf:--}" ]; then
      printf '%s\n' "${fw:--} ${fw2:--} ${pf:--}" > "$NEXTF" 2>/dev/null && rlog next "${fw:--} ${fw2:--} ${pf:--}"
    fi
  fi
  # a waiter that comes to the head keeps its look's marks, which look_mark took before the look's reads
  LOOKER=0
  { [ -z "$TICKET" ] || [ "$HEAD" = 1 ] || [ "$S2" = 1 ] || oldest_is_me; } && LOOKER=1
  if [ "$HEAD" = 0 ] && [ "$S2" = 0 ]; then
    if [ "$waited" -ge "$QAT" ]; then
      pos=$(ordered_waiters | cut -d' ' -f2 | grep -nxF "${TICKET##*/}" | cut -d: -f1)
      echo "run-slot.sh: queued behind $(( ${pos:-1} - 1 )) waiter(s) ahead of it in the queue's order" >&2
      QAT=$(((waited / 300 + 1) * 300))
    fi
    nap
    continue
  fi
  # under the battery's red mark or focus a run keeps its place in the queue and takes no slot
  if verdict_holds; then
    hold_wait
    continue
  fi
  # this run's own units must fit beside what the slots hold now (the queue's order checked them for a waiter at its head)
  c=$(capacity)
  if ! unit_fits "$CLASS$UNITS" "$UNITS" "$SIZE" "$WHO" "$c"; then
    m=$(may_reserve "$CLASS$UNITS" "$SIZE" "$WHO" "$(reserve "$c")")
    if [ "$waited" -ge "$UAT" ]; then echo "run-slot.sh: waiting for $UNITS free load units ($SIZE; $(held_for "$m") of $c held)" >&2; UAT=$(((waited / 300 + 1) * 300)); fi
    sleep "$POLL"
    continue
  fi
  if added=$(burst_held); then
    BURST=1
    if [ "$waited" -ge "$BAT" ]; then echo "run-slot.sh: waiting for the load to show the $added run(s) the last minute added" >&2; BAT=$(((waited / 300 + 1) * 300)); fi
    sleep "$POLL"
    continue
  fi
  for s in run-slot run-slot-2 run-slot-3 run-slot-4; do
    # a waiter that is not the queue's head may take run-slot-2 alone
    if [ "$HEAD" = 0 ] && [ "$s" != run-slot-2 ]; then
      continue
    fi
    slot_open "$s" || continue
    # run-slot.priority names the one session that takes run-slot next (a lead sets it, as for the owner's SDK demo); everyone else leaves
    # run-slot to it while the file is under an hour old
    if [ "$s" = run-slot ] && [ -n "$(prio_holder)" ] && ! prio_for "$WHO" && prio_waiting; then
      continue
    fi
    if mkdir "$OPS/$s" 2>/dev/null; then
      SLOT="$OPS/$s"
      echo "$WHO $$ $(date -u +%FT%TZ) $UNITS $SIZE" > "$SLOT.holder"
      [ -n "$TICKET" ] && rm -f "$TICKET" && TICKET=""
      break 2
    fi
    reclaim "$OPS/$s"
  done
  if [ "$waited" -ge "$SAT" ]; then
    echo "run-slot.sh: waiting for a run slot ($(cat "$OPS/run-slot.holder" 2>/dev/null))" >&2
    SAT=$(((waited / 300 + 1) * 300))
  fi
  sleep "$POLL"
done

[ -n "$SLOT" ] || dropped "run slot's"
echo "run-slot.sh: $WHO holds $(basename "$SLOT")" >&2
TOOK=$(date +%s); rlog start "$(basename "$SLOT") waited=$((TOOK - ASKED))s"
run_command "$@"
