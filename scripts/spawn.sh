#!/usr/bin/env bash
set -euo pipefail

# Spawns a factory session in herdr, the one way a factory session starts one
# (the no-raw-spawn hook refuses the rest). A capacity gate refuses, failing
# closed, unless four gates pass in order,
# the first failure naming its gate and its reading, every pass and refusal
# logged as one JSON line in ~/.playground/ops/capacity.jsonl, where the
# load gate reads the starts of the last 5 minutes back, with each slots.peers folder's own log's. No count of live sessions holds a spawn, so
# the gates cap nothing but the machine's own room:
#   1. load, max(load1, load5) plus those starts under the core count (sysctl
#      hw.ncpu) times PLAYGROUND_LOAD_MULT (default 1.0), each start weighing
#      half its item's load units (small 1, medium 2, big 3: --size, else small
#      for a reviewer or tester, else what `ops/run-slot.sh size <name>` reads),
#      and a quarter of that cap kept for small items, so a big plan never blocks a small one,
#      a small worker keeping an eighth in its place for the reviewers and testers; a load at or over
#      that line refuses whatever the CPU's idle share, so the load stays under the cores, but for a
#      --priority start while a priority file stands (PRIORITY_FILE), logged as readings.priority,
#      and a resume within 15 minutes of close ending a row that read live (JUST_CLOSED), logged as
#      readings.just_closed
#   2. memory, pressure level 1 or 2 (kern.memorystatus_vm_pressure_level) and
#      free at 8% or more (kern.memorystatus_level); a fresh worker start also needs swap-ins
#      under 100/s (vm_stat -c 2 1, gates.glmSwapinsMax), since free memory counts compressible
#      pages and read 62% on 7 Nov while 150 pages swapped in a second; every other start keeps
#      its pass, as at the slots gate
#   A GLM session takes its own load and memory gate in place of both:
#   load5 under 30, pressure level 1 and swap-ins under 100/s (vm_stat -c 2 1)
#   Under Claude Code's sandbox the load comes from uptime, and a refused pressure level leaves the swap-ins to decide (scripts/README.md)
#   3. slots, for a fresh worker start alone (a reviewer, tester or resume skips it, so work
#      already admitted finishes): `ops/run-slot.sh room`, refusing while runs wait in its queue and no
#      lane is free with the load units for a run (but for a --priority start while a priority file
#      stands, PRIORITY_FILE, logged as readings.priority), or when room gives no reading
#   4. usage, the launching backend's own window: Claude reads usage.json
#      (5-hour under 90%, the week within 14.3 points a day of pace, floored at one day's share, readings
#      no older than 15 minutes; one never written, as on a fresh install before ops-usage first runs, passes,
#      its row reading it unread; a missing 5-hour window is an account with no 5-hour limit, read as none) and each other login's
#      usage-<name>.json or reading in login-flip.json's seen (the same checks, readings no older than 60 minutes); with no --account it
#      starts on the passing login next in the account split, else the one with the lowest week, naming it, and refuses
#      only when every login is over, its pick kept off the resume record's exec line so a restore picks afresh; a login whose usage.accounts
#      row is parked (parkedUntil a later time) counts as over, and an --account naming it is refused; --account skips the usage
#      check, since the other login's usage is not this machine's, but refuses a week a reading names at 100%; an --account naming
#      this machine's own login starts there, the split skipped, judged and refused as that login is in a bare start; GLM reads zai-usage.json
#      (the 5-hour window under 95% of its credits, with no week check, and no empty balance (its `balance`), valid only
#      while the zai usage job's last beat is ok and within 3 cycles)
#   The first dispatcher starts past every gate, by a manager start or a resume, so the owner always has one: the gates still read, a failure
#   logs a skipped row naming its gate and reading (which the load gate counts as a start) and prints it, and the
#   pass picks its login as for any start; every other manager start, an orchestrator's included, takes them all
# It also refuses a name a live session holds, since Claude Code would start the
# new one under a generated name. Every launch is in bypass mode, and drops
# inscope's own CLAUDE_CONFIG_DIR where inscope exports one.
#
#   spawn.sh worker    <name> <brief> --title "<t>"    its own workspace, this checkout or --in's folder; reports to the builder (roster.ts who builder), or to --reports-to's session
#   spawn.sh runner    <name> <brief>                  its own workspace, this checkout; reports to ops (roster.ts who ops)
#   spawn.sh column    <reviewer|tester|probe|lead|dispatcher> <name> <reports-to> <pane> <brief>
#                      a column right of a herdr pane id (w1:p2), its spawner's own being $HERDR_PANE_ID
#   spawn.sh column    <manager> <pane> <brief>        a manager's column names it once: a lead (sessions.names' builder, ops or planner, an <id>-builder, -ops or -planner, or a name the roster kinds) reports to the first dispatcher, and the first dispatcher (sessions.names' dispatcher or an <id>-dispatcher) is briefed by the session running spawn.sh
#   spawn.sh probe     <name> <reports-to> <brief>     in herdr alone: its own workspace, this checkout, for a server with no pane to split beside
#   spawn.sh manager   <dispatcher|second dispatcher|optimizer|builder|ops|planner|orchestrator> <brief>   its own workspace in the main checkout's .claude/worktrees/leads: the first dispatcher (sessions.names' dispatcher), which works with the owner and reports to no session; the second dispatcher (Inbox #i520), sessions.names' dispatcher with -2 or an <id>-dispatcher it records as slot=2, on --backend glm or --account <a second account>; the optimizer (optimizer, an <id>-optimizer, or a session the roster gives the optimizer kind) and the builder, ops and planner (playground <manager> starts each), leads; these report to the first dispatcher; an orchestrator, a session whose roster row holds a manager kind of kinds.ts (ROSTER_ROLE_OF_KIND) and reportsTo, set first with roster.ts set <name> kind=<kind> reportsTo=<session>, a lead reporting to that session
#   spawn.sh resume    <name> <dir> [session-id]        reopens a closed session: in herdr in the pane herdr kept under its label while that pane holds no agent, else in a workspace of its own; with no session id, only in a folder it ran in; a <dir> in the Desktop folder resumes in the same tree under the code root, its transcript copied there when a session id is given; with no code root it resumes in the Desktop folder itself
#   spawn.sh restore                                    resumes every herdr session whose resume record (~/.playground/resume) names it on the server PLAYGROUND_HERDR_SESSION names (playground by default) and whose roster row is not done, ended, parked or paused, read again once its resume finds the session gone so a session closed mid-run stays down, each through `spawn.sh resume` and its gate with the --account its start was given, the --model it started with, for a reviewer or tester --pr with the PRs its roster row serves, and an --effort other than high; a live one is skipped, each record it passes over and each resume that fails is named with its reason, and one restore runs at a time; the first dispatcher's record runs first, a resume a gate's falling reading or focus holds prints as waiting (restore_waits), and a restore whose only misses wait exits 0, since a later restore brings them back
#   spawn.sh close     <name>                           closes the herdr pane spawn.sh opened for <name>, by the label it set, on the server its resume record names; it refuses any other pane and your own, and ends its roster row just before the pane closes, putting its status back when herdr refuses the close
#   --size <small|medium|big>  with any mode but restore or close, anywhere among its words: the item's size the load gate counts, in place of small for a reviewer or tester and the one ops/run-slot.sh size reads from the roster and plan.json for the rest
#   --check            with any mode but restore or close, anywhere among its words: run every check and gate but the live-name one, print "ok: <name> can start" and start or close nothing
#   --priority         with any mode but restore or close, anywhere among its words: the start passes the load gate and the slots gate's full queue (the memory gate and an unread room still hold it) while a priority file stands in the data folder (priority.json, an urgent window, an org's own priority-<name>.json, its own urgent window, a session's own window that playground priority on opens, or priority-start.json, a job's own starts), and focus's refusal while any does; it is refused while none does.
#   --brief <file>     with resume alone, anywhere among its words: the resumed session's first prompt has it read ~/.playground/<file>; without it, a resume's first prompt has it act on the after-resume hook's instruction
#   --account <email>  with any mode but restore or close, anywhere among its words: the session logs in as that Claude account, its token read from the Keychain (the service usage.keychainService names) by the new pane's own shell, which stops on an empty one before claude runs; this machine's own login starts on its config with no token, past the account split, its usage judged as a bare start's; with --backend glm it takes a GLM row's label instead
#   --backend glm      with any mode but restore, close or a reviewer's or a tester's, outside a checkout of an org ext.links guards and on a brief naming no word of the glm-refused-sources list, anywhere among its words: the session runs on Z.ai's GLM (models.glm, glm-5.3-flash by default) through Claude Code, its key read from the Keychain (the service models.glmKeychainService names, the account its usage.accounts row's label names: --account's, else the first GLM row's) by the new pane's own shell, which stops on an empty one before claude runs
#   --backend claude   the same places: the session runs on Claude (the default; named to set its pin on a fresh start)
#   --harness codex    with the first dispatcher's manager start or its resume alone, on a scratch data folder (PLAYGROUND_DATA_DIR naming one) until phase 3 lifts that, and no --backend, --account, --model or --effort: the session runs in Codex (the codex on PATH), its CODEX_HOME the data folder's codex/, whose config.toml, hooks.json (the factory's guards and the beat) and app-server-daemon/settings.json each launch writes; its hooks always run trusted (--dangerously-bypass-hook-trust), and it fails closed: a session whose SessionStart hook writes no beat within 60 seconds has its pane closed and the start refused, with no new pin, record or roster row (a resume keeps its earlier ones), and a pane herdr will not close is named for you to close; a Codex start also stops when PowerShell is installed (a pwsh or powershell on PATH, or /usr/local/bin/pwsh), which the beat names. The beat names its thread, which takes the session's name through codex app-server's thread/name/set.
#   --harness claude-code  the default: the session runs in Claude Code.
#     The harness and backend are recorded at the start in ~/.playground/backends/<name> (claude-code glm, codex openai), and carried on its resume, which also reads a pin of the backend alone: a resume takes no --backend or --harness while a pin stands, and refuses with no pin and none given, or with a pin that reads as none of those.
#   --model <id>       with any mode but restore or close, anywhere among its words: the Claude model, one of models.claude (claude-opus-5-5, claude-fable-5-1, claude-sonnet-5-5 and claude-haiku-5-5 by default), else models.default (claude-opus-5-5); never on GLM, which maps every model itself, and a reviewer or a tester runs on models.checker (claude-opus-5-5) alone. Nothing records it: a resume takes it afresh, so a resume with no --model runs on models.default.
#   --effort <level>   with any mode but restore or close, anywhere among its words: the session's effort, one of low, medium, high, xhigh or max, high by default; the resume record keeps one other than high, so a restore runs at the same effort, and a resume with none runs at high.
#   --title "<title>"  with worker or a reviewer's or tester's column, anywhere among its words: the plain title the sidebar reads the session by, up to 40 characters; a worker needs one, and a checker with none takes "Review: " or "Test: " before its worker's roster title
#   --pr <url>[,<url>]  with resume or a reviewer's or tester's column, anywhere among its words: the PRs the checker serves, each by its URL or its number alone, with an issue's URL beside a pull request for a PR not yet opened, or an extension item it scores as <scope>/<kind>/<key>; a reviewer's or tester's start is refused unless it names a pull request or an extension item, and its roster row records it before the pane opens; on an ended roster row it replaces the row's prs, and its pr with the first pull request named; on a live row, or none, it joins them and gives a row with no pr the first pull request named
#   --reports-to <session>  with worker alone, anywhere among its words: the session it reports to, named in its first prompt in place of the builder
#   --in <dir>         with worker alone, anywhere among its words: the folder the worker runs in, in place of this checkout: an existing folder under the code root (paths.codeRoot) or under ~/<org> for an org ext.links guards, any other refused
#   --memory <dir>     with any mode but restore or close, anywhere among its words: the launch runs with Claude Code's auto-memory on, writing to <dir>, an absolute folder: its built settings file, one of its own (factory-settings-...-memory-<name>.json), sets autoMemoryEnabled and autoMemoryDirectory, while every other launch's file stays as it is, for the auto-memory trial; --memory off launches with memory off on the shared file, whatever arm the role or the row would take
#   --runtime herdr    with any mode but restore or close, anywhere among its words: the session opens in herdr, on the playground server of ~/.playground/herdr (PLAYGROUND_HERDR_DIR and PLAYGROUND_HERDR_SESSION move it), by the binary its pin.json names alone; a column's anchor is then a herdr pane id (w1:p2, or lettered as wN:p1A), its spawner's own being $HERDR_PANE_ID. The session's name is at most 32 characters, herdr's limit for an agent's name.
#     With no --runtime, every start and resume opens in herdr, whatever terminal its spawner runs in.
#     The runtime is recorded at every start and resume in ~/.playground/runtimes/<name>, a resume rewriting whatever word the pin held.
#
# <name> is lowercase words joined by hyphens that give its kind: a new one from `bun run name <kind>` (<id>-<kind>), an old `<kind>-<words>` one, or a manager's own; the mode gives the kind, and a name that gives none or another is refused, but on a resume.
# <brief> is a file under ~/.playground. Every session runs at high effort unless --effort names another,
# on models.default unless --model names another of models.claude, or on models.glm with --backend glm. The first dispatcher reports to no one: its <reports-to> is the lead that briefs it.
# Each start lands in the roster.

REPO="$(cd -P "$(dirname "$0")/.." && pwd -P)"
# The main checkout: git's common dir less .git, the same folder from a worktree as from the checkout itself.
MAIN="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" && MAIN="$(cd -P "$(dirname "$MAIN")" && pwd -P)" || MAIN=$REPO
ROSTER="$REPO/scripts/roster.ts"
# pid $1 and its start, one `<pid> <lstart>` line words single-spaced, or nothing once it has gone: from ps, else from the kernel's process table, since Claude Code's sandbox refuses the setuid ps
started() { echo $(LC_ALL=C TZ=UTC ps -o pid=,lstart= -p "$1" 2>/dev/null || python3 -I "$REPO/scripts/ops/ptable.py" started "$1"); }
# launchd runs a login item (herdr's restore) on /usr/bin:/bin, where bun is not on PATH, so the roster write falls back to bun's own install folder.
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
REGISTRY="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions"
# inscope can export a workspace's own CLAUDE_CONFIG_DIR (with INSCOPE_CCD), where a session starts with no login. Where it does, a launch drops both, so it runs from ~/.claude, and the live-name check and roster read there too.
UNSET=
INSCOPE_HOOK="${XDG_CONFIG_HOME:-$HOME/.config}/inscope/inscope.zsh"
if [ -n "${INSCOPE_CCD:-}" ] || { [ -r "$INSCOPE_HOOK" ] && grep -q -e INSCOPE_CCD -e CLAUDE_CONFIG_DIR "$INSCOPE_HOOK"; }; then
  UNSET="-u CLAUDE_CONFIG_DIR -u INSCOPE_CCD "
  REGISTRY="$HOME/.claude/sessions"
fi
# The data folder of the config folder the launch runs from, as dataDir() resolves it, and as a brief or a refusal names it.
DATA=$(cd / && env $UNSET "$BUN" --no-env-file -e "import { dataDir } from '$REPO/packages/env/src/data-dir.ts'; console.log(dataDir())") || { echo "spawn.sh: bun could not resolve the data folder" >&2; exit 1; }
# The roster's manager kinds (kinds.ts' ROSTER_ROLE_OF_KIND), so a kind role_of_kind does not list runs as a lead: an orchestrator. A read that fails leaves the named kinds alone, so an orchestrator is refused rather than guessed.
MANAGER_KINDS=$(cd / && env $UNSET "$BUN" --no-env-file -e "import { ROSTER_ROLE_OF_KIND as r } from '$REPO/packages/config/src/kinds.ts'; console.log(Object.keys(r).filter((k) => r[k] === 'manager').join(' '))" 2>/dev/null) || MANAGER_KINDS=
# The priority file standing in the data folder, exit 1 when none does, its content unread: every priority*.json (priority.json, an org's own priority-<name>.json, a session's from playground priority, or a job's own start file, priority-start.json, each writer keeping its own) passes the load and slots gates and focus.
priority_file() {
  local f
  for f in "$DATA"/priority*.json; do
    [ -e "$f" ] && { echo "$f"; return 0; }
  done
  return 1
}
[[ $DATA == "$HOME"/* ]] && SHOWN="~${DATA#"$HOME"}" || SHOWN=$DATA
SETTINGS="$DATA/factory-settings.json"
HERDR_DIR=${PLAYGROUND_HERDR_DIR:-${DESK_HERDR_DIR:-$DATA/herdr}}
PINS="$DATA/backends"
RESUME_DIR="$DATA/resume"
ROSTER_JSON="$DATA/roster.json"
# A setting as setting.ts prints it, JSON; empty when the render set cannot be trusted or no piece defines the key.
setting() { (cd / && env $UNSET "$BUN" --no-env-file "$REPO/packages/scripts/src/playground/setting.ts" "$1" 2>/dev/null); }
# A string setting as text, and empty, exiting 0, when it is unset, not a string, or setting.ts refuses.
setting_text() { setting "$1" | python3 -I -c 'import json, sys; v = json.load(sys.stdin); print(v if isinstance(v, str) else "")' 2>/dev/null || true; }
# The code root: paths.codeRoot, else the folder that holds the factory's main checkout.
code_root() { local set; set=$(setting_text paths.codeRoot); echo "${set:-$(dirname "${PLAYGROUND_REPO:-$MAIN}")}"; }
# The folders whose trust prompt spawn.sh answers: the code root, and a folder in the home folder named for each org ext.links guards.
trusted_root() {
  local real root
  real=$(cd -P "$1" 2>/dev/null && pwd -P) || return 1
  for root in "$(code_root)" $(org_roots); do
    root=$(cd -P "$root" 2>/dev/null && pwd -P) || continue
    [[ $real/ == "$root"/* ]] && return 0
  done
  return 1
}
# A guard list of words as guard-list.ts prints it, JSON; its refusal on stderr, exiting 2, when the list cannot be trusted.
guard_list() { (cd / && env $UNSET "$BUN" --no-env-file "$REPO/packages/scripts/src/playground/guard-list.ts" spawn.sh "$1"); }
# A folder in the home folder for each org ext.links guards.
org_roots() { setting --guarded-orgs | python3 -I -c 'import json, os, sys; [print(os.path.join(os.path.expanduser("~"), org)) for org in json.load(sys.stdin)]' 2>/dev/null; }
# Claude Code keeps a folder's transcripts in the project folder named from its real path, each character outside [A-Za-z0-9] a hyphen.
PROJECTS="$(dirname "$REGISTRY")/projects"
project_of() { echo "$PROJECTS/$(sed 's/[^A-Za-z0-9]/-/g' <<<"$1")"; }

usage() {
  if [ $# -gt 0 ]; then
    printf 'spawn.sh: %s\n' "$1" >&2
  fi
  # every mode's line through the runtime record's, found by its first and next lines so an added line never cuts it
  awk '/^#   spawn\.sh /{p = 1} /^# <name> is/{exit} p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
refuse() {
  echo "spawn.sh refuses $NAME: $1" >&2
  exit "${REFUSE_CODE:-1}"
}
word() { [[ $1 =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; }
# One field of a session's roster row: nothing when the row has none or the roster does not read.
roster_field() {
  python3 -I - "$ROSTER_JSON" "$1" "$2" <<'PY' 2>/dev/null || true
import json, sys
try:
    agents = json.load(open(sys.argv[1])).get("agents") or []
    value = next((a.get(sys.argv[3]) for a in agents if isinstance(a, dict) and a.get("name") == sys.argv[2]), None)
    print(value if isinstance(value, str) else "")
except Exception:
    pass
PY
}
# A session's kind: the roster's for its name, which a name need not carry.
roster_kind() { roster_field "$1" kind; }
# The kind a name gives: a manager's or dispatcher's own name (sessions.names) or an old one (sessions.aliases), a new `<id>-<kind>` name's suffix (bun run name), else an old name's role prefix.
kind_of_name() {
  local named
  named=$(session_kind "$1")
  [ -z "$named" ] || { echo "$named"; return; }
  case "$1" in
    optimizer) echo optimizer ;;
    worker-* | reviewer-* | tester-* | runner-* | probe-*) echo "${1%%-*}" ;;
    *)
      if [[ $1 =~ ^[23456789bcdfghjkmnpqrstvwxyz]{6}-([a-z]+)$ ]]; then
        local suffix=${BASH_REMATCH[1]}
        [ -z "$(role_of_kind "$suffix")" ] || echo "$suffix"
      fi
      ;;
  esac
}
# The PLAYGROUND_ROLE a kind runs under: lead for any other manager kind (an orchestrator), nothing for a kind off the list.
role_of_kind() {
  case "$1" in
    worker | researcher) echo worker ;;
    reviewer | tester | runner | probe) echo "$1" ;;
    builder | ops | optimizer | planner) echo lead ;;
    dispatcher) echo dispatcher ;;
    *) case " $MANAGER_KINDS " in *" $1 "*) [ -z "$1" ] || echo lead ;; esac ;;
  esac
}

# A session's kind: the roster's, else the one its old name gives.
kind_of() {
  local kind
  kind=$(roster_kind "$1")
  [ -n "$(role_of_kind "$kind")" ] || kind=$(kind_of_name "$1")
  echo "$kind"
}
# The session holding a manager kind's seat, by roster.ts who; the kind's sessions.names name when roster.ts cannot run.
manager_of() { env $UNSET "$BUN" "$ROSTER" who "$1" 2>/dev/null || session_name "$1"; }
# The dispatcher holding slot $1 (1 Alpha, 2 Bravo), its sessions.names name when the roster cannot answer, with -2 for the second.
dispatcher_of() { env $UNSET "$BUN" "$ROSTER" who dispatcher "$1" 2>/dev/null || { [ "$1" = 2 ] && echo "$(session_name dispatcher)-2" || session_name dispatcher; }; }
# A manager's name and kind, one `<name> <kind>` line each, from sessions.names (the second dispatcher's `<dispatcher>-2` beside them), then sessions.aliases: read once SESSION_KINDS is set, below.
session_kind() { local n k; while read -r n k; do [ "$n" != "$1" ] || { echo "$k"; return; }; done <<<"$SESSION_KINDS"; }
session_name() { local n k; while read -r n k; do [ "$k" != "$1" ] || { echo "$n"; return; }; done <<<"$SESSION_KINDS"; }
# The second dispatcher's own name is a dispatcher's name, from sessions.names or sessions.aliases, with -2.
second_dispatcher() { [ "${1%-2}" != "$1" ] && [ "$(session_kind "${1%-2}")" = dispatcher ]; }
# The first dispatcher, a dispatcher (its caller reads KIND) that holds slot 1 or is sessions.names' own and not the second, starts past every gate, by manager and by resume alike, so a restore brings the owner's dispatcher back at once.
first_dispatcher() { [ "$1" = "$(dispatcher_of 1)" ] || { [ "$(session_kind "$1")" = dispatcher ] && ! second_dispatcher "$1"; }; }
# A resume's refusal that a later restore clears with no change: a gate holding it over a reading that falls, or focus standing for another session. A gate that cannot read its input or reads a bad setting is a fault, which waiting never ends.
restore_waits() {
  local wait_re='the [a-z]+ gate holds it:|focus stands for' fault_re='cannot read|PLAYGROUND_LOAD_MULT is|holds no'
  [[ $1 =~ $wait_re ]] && ! [[ $1 =~ $fault_re ]]
}

# The live sessions: a registry file whose pid is alive with the start time the file records, as the Dashboard reads them, but for a `claude -p` run (entrypoint sdk-cli), which holds no name. It prints a line, tab-separated pid, session id, folder and process start ("-" for a field the file lacks), for each live session named $1, the lowest pid first.
live_holders() {
  python3 - "$REGISTRY" "$1" "$REPO" <<'PY'
import json, os, subprocess, sys

folder, wanted, repo = sys.argv[1:4]
entries = {}
# Claude Code makes its sessions folder with its first session, so a Mac that never ran one holds no live session.
try:
    files = os.listdir(folder)
except FileNotFoundError:
    files = []
for file in files:
    stem = file[:-5]
    if not file.endswith(".json") or not stem.isdigit():
        continue
    try:
        with open(os.path.join(folder, file)) as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        data = {}
    entries[int(stem)] = data if isinstance(data, dict) else {}
me = os.getpid()
pids = [me, *entries]
# each pid's start from ps, else from the kernel's process table (ptable.py), since Claude Code's sandbox refuses the setuid ps
try:
    listing = subprocess.run(
        ["ps", "-o", "pid=,lstart=", "-p", ",".join(str(p) for p in pids)],
        capture_output=True,
        env=dict(os.environ, LC_ALL="C", TZ="UTC"),
        text=True,
    ).stdout
except OSError:
    listing = ""
starts = {}
for line in listing.splitlines():
    parts = line.split(None, 1)
    if len(parts) == 2 and parts[0].isdigit():
        starts[int(parts[0])] = " ".join(parts[1].split())
if me not in starts:
    sys.path.insert(0, os.path.join(repo, "scripts", "ops"))
    import ptable
    starts = {pid: start for pid in pids if (start := ptable.started(pid))}
if me not in starts:
    sys.exit("neither ps nor the kernel's process table listed this process")
def field(value):
    return " ".join(value.split()) if isinstance(value, str) and value.strip() else "-"
for pid, data in sorted(entries.items()):
    start = data.get("procStart")
    if pid not in starts or (isinstance(start, str) and " ".join(start.split()) != starts[pid]):
        continue
    if data.get("name") == wanted and data.get("entrypoint") != "sdk-cli":
        print(pid, field(data.get("sessionId")), field(data.get("cwd")), starts[pid], sep="\t")
PY
}
# The capacity gate: four gates in order (load, memory, slots for a fresh worker start, usage), the first failure naming its gate and its reading (a first dispatcher's failures each kept as a skip, the gates after it still read), every pass and refusal, and a first dispatcher's skipped start, one JSON line in ~/.playground/ops/capacity.jsonl naming its session (the load gate reads the last 5 minutes of starts back; a refusal's carries its printed words as detail); python exits 0 printing a past line for each skip and then ok, or the refusal for refuse() to print.
# The login a launch runs on with no --account, from Claude Code's config, which the launch reads from ~ when it drops inscope's folder.
own_config() { if [ -n "$UNSET" ]; then echo "$HOME/.claude.json"; else echo "${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"; fi; }
gate_capacity() {
  # run-slot's room, for the slots gate (the header's gate 3)
  room=
  if [ "$MODE" = worker ]; then
    room=$(RUN_SLOT_OPS="$DATA/ops" bash "$REPO/scripts/ops/run-slot.sh" room 2>/dev/null) || room=
    [ -n "$room" ] || room=unread
  fi
  verdict=$(
    python3 -I - "$DATA" "$ACCOUNT" "$BACKEND" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "$(own_config)" "${CHECK:+check}" "$GATES" $ITEM "$ROLE" "$room" "${FIRST:+first}" "${PRIORITY_FILE:-}" "${JUST_CLOSED:-}" "$NAME" "$OWN_LOGIN" <<'PY'
import datetime as dt
import glob
import json
import math
import os
import re
import subprocess
import sys

data_dir, account, backend, config_dir, own_config, check, gates, size, units, role, room, first, priority, just_closed, session, own_pick = sys.argv[1:17]
log_path = os.path.join(data_dir, "ops", "capacity.jsonl")
units = int(units)
gates = json.loads(gates)
now = dt.datetime.now(dt.timezone.utc)
readings = {}

# The first dispatcher starts past a failing gate, so the owner always has one: the skip is kept and the gates after it still read, its login pick included.
skips = []

class Skip(Exception):
    pass

def refuse(gate, detail):
    if first:
        skips.append((gate, detail))
        raise Skip
    row = {"at": now.isoformat(timespec="seconds").replace("+00:00", "Z"), "detail": detail, "gate": gate, "readings": readings, "session": session, "verdict": "refused"}
    try:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "a") as f:
            f.write(json.dumps(row, sort_keys=True) + "\n")
    except OSError:
        pass
    print(f"the {gate} gate holds it: {detail}")
    sys.exit(0)

def from_iso(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return dt.datetime.fromtimestamp(value, dt.timezone.utc)
        except (OverflowError, OSError, ValueError):
            raise ValueError(f"not a time: {value!r}")
    return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))

def sysctl_int(name):
    out = subprocess.run(["sysctl", "-n", name], capture_output=True, text=True)
    try:
        return int(out.stdout.strip())
    except ValueError:
        return None

# whether Claude Code's sandbox refuses sysctl reading name, as it does every kern.memorystatus_* reading
def sandbox_refuses(name):
    return "not permitted" in subprocess.run(["sysctl", "-n", name], capture_output=True, text=True).stderr

# (load1, load5) from sysctl, else from uptime, since Claude Code's sandbox refuses the sysctl command's name lookup; None when neither reads
def loadavg():
    words = subprocess.run(["sysctl", "-n", "vm.loadavg"], capture_output=True, text=True).stdout.strip(" {}\n").split()
    if len(words) < 2:
        out = subprocess.run(["uptime"], capture_output=True, text=True, env=dict(os.environ, LC_ALL="C")).stdout
        words = out.rpartition("load average")[2].lstrip("s:").replace(",", " ").split()
    try:
        return float(words[0]), float(words[1])
    except (IndexError, ValueError):
        return None

# the last second's swap-ins, from vm_stat's last row under a header naming each column, or None when it cannot be read
def swapins():
    try:
        rows = [line.split() for line in subprocess.run(["vm_stat", "-c", "2", "1"], capture_output=True, text=True, timeout=10, check=True).stdout.splitlines()]
        column = next(row for row in rows if "swapins" in row).index("swapins")
        return int(rows[-1][column])
    except (IndexError, OSError, StopIteration, subprocess.SubprocessError, ValueError):
        return None

def load(name):
    path = os.path.join(data_dir, name)
    if not os.path.exists(path):
        return None, f"it cannot read {path} (no such file)"
    try:
        with open(path) as f:
            return json.load(f), None
    except (OSError, ValueError):
        return None, f"it cannot read {path} (does not read)"

def read(name):
    data, detail = load(name)
    if detail:
        refuse("usage", detail)
    return data

def pct(part, whole):
    return float(part) / float(whole) * 100

def fmt(x):
    return f"{x:g}"

if backend == "glm":
    try:
        # a GLM session draws no Claude usage, so it has its own gate: load5 under gates.glmLoad5Max, memory pressure 1 and swap-ins under gates.glmSwapinsMax a second
        loads = loadavg()
        if loads is None:
            refuse("load", "it cannot read the load average (sysctl vm.loadavg or uptime)")
        readings["load5"] = loads[1]
        if readings["load5"] >= gates["glmLoad5Max"]:
            refuse("load", f"load5 is {readings['load5']:.2f} (sysctl vm.loadavg), and a GLM session starts under {fmt(gates['glmLoad5Max'])}")
        readings["pressure"] = sysctl_int("kern.memorystatus_vm_pressure_level")
        if readings["pressure"] is None and sandbox_refuses("kern.memorystatus_vm_pressure_level"):
            readings["memory"] = "pressure level refused by the sandbox, so the swap-ins alone decide"
        elif readings["pressure"] is None:
            refuse("memory", "it cannot read the pressure level (sysctl kern.memorystatus_vm_pressure_level)")
        elif readings["pressure"] != 1:
            refuse("memory", f"pressure level is {readings['pressure']} (sysctl kern.memorystatus_vm_pressure_level), and a GLM session starts at 1 alone")
        readings["swapins"] = swapins()
        if readings["swapins"] is None:
            refuse("memory", "it cannot read the swap-ins (vm_stat -c 2 1)")
        if readings["swapins"] >= gates["glmSwapinsMax"]:
            refuse("memory", f"swap-ins are {readings['swapins']}/s (vm_stat), and a GLM session starts under {fmt(gates['glmSwapinsMax'])}/s")
    except Skip:
        pass
else:
    try:
        # 1 load: max(load1, load5) plus the starts the log holds from the last gates.startsWindow seconds
        loads = loadavg()
        if loads is None:
            refuse("load", "it cannot read the load average (sysctl vm.loadavg or uptime)")
        load1, load5 = loads
        cores = sysctl_int("hw.ncpu") or os.cpu_count()
        if cores is None:
            refuse("load", "it cannot read the core count (sysctl hw.ncpu)")
        readings["cores"] = cores
        mult = 1.0
        raw_mult = os.environ.get("PLAYGROUND_LOAD_MULT")
        if raw_mult is not None:
            try:
                mult = float(raw_mult)
            except ValueError:
                mult = 0.0
            if not (math.isfinite(mult) and mult > 0):
                readings["load_mult"] = raw_mult
                refuse("load", f"PLAYGROUND_LOAD_MULT is {raw_mult}; set a number above 0, or unset it for the default 1.0")
        readings["load5"] = max(load1, load5)
        readings["size"] = size
        readings["units"] = units
        readings["load_mult"] = mult
        cap = cores * mult
        starts = 0
        # this factory's starts (a pass row, or a first dispatcher's skipped one), then each peer's (slots.peers) from its own log, read only, since the load average lags a start on either side
        for path in [log_path] + [os.path.join(p, "capacity.jsonl") for p in gates["peers"] if isinstance(p, str)]:
            try:
                with open(path) as f:
                    for line in f:
                        try:
                            row = json.loads(line)
                        except ValueError:
                            continue
                        if not isinstance(row, dict) or row.get("verdict") not in ("pass", "skipped"):
                            continue
                        try:
                            if (now - from_iso(row["at"])).total_seconds() <= gates["startsWindow"]:
                                weight = (row.get("readings") or {}).get("units") if isinstance(row.get("readings"), dict) else None
                                starts += weight / 2 if weight in (1, 2, 3) else 1
                        except (KeyError, TypeError, ValueError):
                            continue
            except OSError:
                pass
        readings["starts"] = starts
        # the reserves nest: a start that is not small keeps gates.smallReserve for small items, so a big plan never blocks the small ones, and a small worker keeps gates.reviewReserve for the checkers, which start small
        share = (gates["reviewReserve"] if role == "worker" else 0) if size == "small" else gates["smallReserve"]
        keep = cap * share
        readings["reserve"] = keep
        # the owner's rule keeps the load under the cores, so a worker or two can be closed to make room: a load at or over the line refuses whatever the CPU's idle share, but a --priority start passes while a priority file stands (PRIORITY_FILE), since priority work comes first, and a resume of a row spawn.sh closed live in the last 15 minutes passes (JUST_CLOSED), since that session already counts in the load; the memory gate still reads both
        if priority:
            readings["priority"] = priority
        elif just_closed:
            readings["just_closed"] = just_closed
        elif readings["load5"] + starts >= cap - keep:
            at = (
                f"{cap:g}, the {cores} cores at PLAYGROUND_LOAD_MULT {mult:g}"
                if mult != 1
                else f"the {cores} cores"
            )
            at = f"at or over {at}" if not keep else f"at or over {cap - keep:g}: {at}, less the {keep:g} kept for {'checkers (gates.reviewReserve; this start is a small worker)' if size == 'small' else f'small items (this start is {size})'}"
            refuse("load", f"max(load1, load5) is {readings['load5']:.2f} and {starts:g} started in the last {fmt(gates['startsWindow'] / 60)} minutes, {at}. Wait for it to fall, or close a session that is done, and run it again.")
    except Skip:
        pass

    try:
        # 2 memory; where Claude Code's sandbox refuses the pressure level and free share, the swap-ins stand in, under GLM's line
        readings["pressure"] = sysctl_int("kern.memorystatus_vm_pressure_level")
        if readings["pressure"] is None and sandbox_refuses("kern.memorystatus_vm_pressure_level"):
            readings["memory"] = "pressure level and free share refused by the sandbox"
            readings["swapins"] = swapins()
            if readings["swapins"] is None:
                refuse("memory", "the sandbox refuses the pressure level, and it cannot read the swap-ins (vm_stat -c 2 1)")
            if readings["swapins"] >= gates["glmSwapinsMax"]:
                refuse("memory", f"the sandbox refuses the pressure level, and swap-ins are {readings['swapins']}/s (vm_stat), {fmt(gates['glmSwapinsMax'])}/s is the line. Close a session or wait for the pressure to pass, and run it again.")
        else:
            if readings["pressure"] is None:
                refuse("memory", "it cannot read the pressure level (sysctl kern.memorystatus_vm_pressure_level)")
            if readings["pressure"] not in (1, 2):
                refuse("memory", f"pressure level is {readings['pressure']} (sysctl kern.memorystatus_vm_pressure_level), 1 or 2 passes")
            readings["free"] = sysctl_int("kern.memorystatus_level")
            if readings["free"] is None:
                refuse("memory", "it cannot read the free share (sysctl kern.memorystatus_level)")
            if readings["free"] < gates["memoryFreeMin"]:
                refuse("memory", f"free is {readings['free']}% (sysctl kern.memorystatus_level), {gates['memoryFreeMin']}% is the floor. Close a session or wait for the pressure to pass, and run it again.")
        # paging, for a fresh worker start alone (room is read for one), since free memory counts compressible pages
        if room and "swapins" not in readings:
            readings["swapins"] = swapins()
            if readings["swapins"] is None:
                refuse("memory", "it cannot read the swap-ins (vm_stat -c 2 1)")
            if readings["swapins"] >= gates["glmSwapinsMax"]:
                free = f", while free reads {readings['free']}% (sysctl kern.memorystatus_level), which counts compressible pages" if "free" in readings else ""
                refuse("memory", f"swap-ins are {readings['swapins']}/s (vm_stat), {fmt(gates['glmSwapinsMax'])}/s is the line{free}. Close a session or wait for the paging to pass, and run it again.")
    except Skip:
        pass

# 3 slots (the header's gate 3)
try:
    if room:
        try:
            lanes, held, free, waiters = (int(n) for n in room.split())
        except ValueError:
            refuse("slots", "it cannot read run-slot's lanes and queue (run-slot.sh room)")
        readings.update(lanes=lanes, lanes_free=free, lanes_held=held, waiters=waiters)
        # a full queue holds a fresh worker so admitted runs finish first, but priority work comes first, as at the load gate
        if priority:
            readings["priority"] = priority
        elif free == 0 and waiters > 0:
            short = "run-slot has no lane open" if lanes == 0 else f"run-slot's {lanes} lanes are all held" if held >= lanes else f"{held} of run-slot's {lanes} lanes are held and the rest lack the load units for a run"
            refuse("slots", f"{short}, and {waiters} {'run waits' if waiters == 1 else 'runs wait'} in its queue (run-slot.sh room). Wait for the queue to drain, or close a worker that is done, and run it again.")
except Skip:
    pass

# 4 usage: the launching backend's own window
try:
    readings["backend"] = backend or "claude"
    # usage.accounts' rows parked until a later time (parkedUntil), by email: no new session starts on one, picked or named
    parked = {}
    for row in gates["accounts"]:
        try:
            if from_iso(row["parkedUntil"]) > now:
                parked[row["email"].lower()] = row["parkedUntil"]
        except (KeyError, TypeError, ValueError, AttributeError):
            pass
    if account:
        if account.lower() in parked:
            refuse("usage", f"--account {account} is parked until {parked[account.lower()]} (usage.accounts parkedUntil). Name another account, or none, so it starts on the login with the most room")
        # a week at 100% leaves no room on any login, so a reading that names the account (usage.json, stored-login.json or a usage-<name>.json) refuses it before its week resets.
        names = ["usage.json", "ops/usage/stored-login.json"] + [os.path.basename(p) for p in sorted(glob.glob(os.path.join(data_dir, "usage-*.json")))]
        for name in names:
            data, detail = load(name)
            if detail or not isinstance(data, dict) or str(data.get("account") or "").lower() != account.lower():
                continue
            try:
                week = data["rate_limits"]["seven_day"]
                week_pct, resets = week["used_percentage"], from_iso(week["resets_at"])
            except (KeyError, TypeError, ValueError):
                continue
            if isinstance(week_pct, (int, float)) and not isinstance(week_pct, bool) and week_pct >= 100 and resets > now:
                readings["week"] = week_pct
                refuse("usage", f"--account {account}: its week reads {fmt(week_pct)}% ({name} seven_day.used_percentage) until {resets:%a %H:%M} UTC. Name another account, or, for a session that may run on this machine's login, none, so it starts on the login with the most room")
        # usage.json's accounts map holds every account's week as login-flip reads it, a week past its weekReset read as 0, so a full one refuses too, naming the account with the most room as most_room() in ops/unstick/run.py picks it: the lowest week under 100.
        own_usage, own_detail = load("usage.json")
        accounts = own_usage.get("accounts") if not own_detail and isinstance(own_usage, dict) else None
        weeks = {}
        for acct, entry in accounts.items() if isinstance(accounts, dict) else []:
            acct_week = entry.get("week") if isinstance(entry, dict) else None
            if not isinstance(acct_week, (int, float)) or isinstance(acct_week, bool):
                continue
            try:
                acct_reset = from_iso(entry.get("weekReset"))
            except (TypeError, ValueError):
                acct_reset = None
            weeks[str(acct).lower()] = (str(acct), 0 if acct_reset and acct_reset <= now else acct_week, acct_reset)
        if account.lower() in weeks:
            _, week_pct, resets = weeks[account.lower()]
            if week_pct >= 100 and resets:
                readings["week"] = week_pct
                roomiest = min(((acct, week) for key, (acct, week, _) in weeks.items() if key != account.lower() and week < 100), key=lambda pair: pair[1], default=None)
                hint = f"Name {roomiest[0]}, the account with the most room (its week reads {fmt(roomiest[1])}%), or, for a session that may run on this machine's login, none" if roomiest else "No account in usage.json's accounts has room; wait for a week to reset"
                refuse("usage", f"--account {account}: its week reads {fmt(week_pct)}% (usage.json accounts) until {resets:%a %H:%M} UTC. {hint}")
        readings["usage"] = f"skipped (--account {account}, whose usage this machine does not read)"
    elif backend == "glm":
        beat = read("ops/ops-zai-usage.json")
        if not isinstance(beat, dict) or beat.get("lastResult") != "ok":
            refuse("usage", f"the zai usage job's last beat is not ok ({beat.get('lastResult') if isinstance(beat, dict) else 'unread'}, ops-zai-usage.json)")
        try:
            age = (now - from_iso(beat["lastBeatAt"])).total_seconds()
            cycle = beat["cycleSeconds"]
            if isinstance(cycle, bool) or not isinstance(cycle, (int, float)) or cycle <= 0:
                raise ValueError
            cycles = math.ceil(age / cycle)
        except (KeyError, TypeError, ValueError):
            refuse("usage", "it cannot read ops-zai-usage.json (does not read)")
        if cycles > 3:
            refuse("usage", f"the zai usage job's last beat is {cycles} cycles old (ops-zai-usage.json), 3 is the limit")
        zai = read("zai-usage.json")
        try:
            five = zai["windows"]["fiveHour"]
            five_pct = pct(five["used"], five["cap"])
        except (KeyError, TypeError):
            five_pct = None
        balance = zai.get("balance") if isinstance(zai, dict) else None
        if isinstance(balance, dict) and balance.get("empty") is True:
            readings["balance"] = "empty"
            refuse("usage", f"the GLM balance is empty (zai-usage.json balance, a GLM session's 429 [1113] at {balance.get('seenAt', 'an unread time')}). Top it up at Z.ai: the gate lets GLM starts try again an hour after that failure.")
        if five_pct is None:
            refuse("usage", "zai-usage.json holds no five-hour window")
        readings["fiveHour"] = five_pct
        if five_pct >= 95:
            refuse("usage", f"the 5-hour window is at {fmt(five_pct)}% of its credits (zai-usage.json windows.fiveHour), 95 is its cap. Wait for the window to reset, or close a session, and run it again.")
        try:
            week = zai["windows"]["week"]
            week_pct = pct(week["used"], week["cap"])
        except (KeyError, TypeError):
            week_pct = None
        readings["week"] = week_pct
    else:
        # The pace override (#i509): while ~/.playground/usage-pace-off-until holds a future ISO 8601 time with its zone,
        # the week-pace check is off and a 98% sanity backup holds instead; anything else leaves the pace on (fail closed).
        pace_off = None
        try:
            with open(os.path.join(data_dir, "usage-pace-off-until")) as f:
                until = dt.datetime.fromisoformat(f.read().strip().replace("Z", "+00:00"))
            if until.tzinfo is not None and until > now:
                pace_off = until.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        except (OSError, ValueError):
            pass
        if pace_off:
            readings["pace"] = f"skipped until {pace_off} (usage-pace-off-until)"

        # One login's reading: what it read, and why it is over the gate (None when it passes).
        def judge(name, usage, limit, writer):
            seen = {}
            try:
                written = from_iso(usage["writtenAt"])
            except (KeyError, TypeError, ValueError):
                return seen, f"it cannot read {name} (does not read)"
            age = int((now - written).total_seconds() // 60)
            if age >= limit:
                return seen, f"{name} was written {age} minutes ago (writtenAt), {limit} is its limit. {writer}"
            rate = usage.get("rate_limits")
            if not isinstance(rate, dict):
                return seen, f"{name} holds no rate_limits (does not read)"
            try:
                week = rate["seven_day"]
                resets = from_iso(week["resets_at"])
                week_pct = week["used_percentage"]
                if isinstance(week_pct, bool) or not isinstance(week_pct, (int, float)):
                    raise TypeError
            except (KeyError, TypeError, ValueError):
                return seen, f"{name} holds no week share (seven_day.used_percentage with seven_day.resets_at)"
            five = rate.get("five_hour")
            five_hour = five.get("used_percentage") if isinstance(five, dict) else None
            if isinstance(five_hour, bool) or not isinstance(five_hour, (int, float)):
                five_hour = None  # no 5-hour window: an account Anthropic gives no 5-hour limit, so none, never 0%
            seen["fiveHour"] = "none" if five_hour is None else five_hour
            if five_hour is not None and five_hour >= 90:
                try:
                    reset = f"{from_iso(five['resets_at']):%H:%M} UTC"
                except (KeyError, TypeError, ValueError):
                    reset = "later"
                return seen, f"the 5-hour window is at {fmt(five_hour)}% ({name} five_hour.used_percentage), 90 is its cap. It resets {reset}."
            seen["week"] = week_pct
            if pace_off:
                if week_pct >= 98:
                    return seen, f"the week is at {fmt(week_pct)}% ({name} seven_day.used_percentage), and 98% is the sanity backup while the pace check is off until {pace_off} (usage-pace-off-until)"
            else:
                days_in = 7 - (resets - now).total_seconds() / 86400
                pace = max(days_in, 1) * 100 / 7  # never below one day's share, so a week that has just reset is not refused for its first points
                if week_pct > pace:
                    return seen, f"the week is at {fmt(week_pct)}% ({name} seven_day.used_percentage), past 14.3 points a day ({days_in:.1f} days in, {pace:.1f} is its pace)"
            return seen, None

        # this machine's own login (usage.json, which ops-usage writes every 5 minutes) and each other login with a usage-<name>.json,
        # which ops-usage writes for the stored login and account-watch.py <email>, run by hand, for another; another login's week moves slowly, so its reading holds for an hour.
        usage, detail = load("usage.json")
        own = usage.get("account") if isinstance(usage, dict) else None
        writer = "The ops-usage job writes it every 5 minutes; wait for its next run and try again."
        # a usage.json never written, as on a fresh install before ops-usage first runs, passes: the gate paces spending, and Anthropic's own limits still bind the login. One that exists is judged.
        if not os.path.exists(os.path.join(data_dir, "usage.json")):
            seen, detail = {"usage": "unread (usage.json not yet written)"}, None
        else:
            seen, detail = judge("usage.json", usage, 15, writer) if not detail else ({}, detail)
        logins = [(own or "this machine's login", "usage.json", None, seen, detail)]
        # a bare start runs on the config's own login; while usage.json reads another account (the factory's), that login is judged by ops-usage's stored-login.json, failing when the file is missing, stale or names another account, and the factory becomes a login --account reaches.
        try:
            with open(own_config) as f:
                runs_on = (json.load(f).get("oauthAccount") or {}).get("emailAddress")
        except Exception:
            runs_on = None
        if isinstance(runs_on, str) and runs_on and own and runs_on.lower() != own.lower():
            name = "ops/usage/stored-login.json"
            stored, stored_detail = load(name)
            named = stored.get("account") if isinstance(stored, dict) else None
            if not stored_detail and (not isinstance(named, str) or named.lower() != runs_on.lower()):
                stored_detail = f"{name} reads {named or 'no account'}, not {runs_on}, the login a start with no --account runs on"
            stored_seen, stored_detail = judge(name, stored, 15, writer) if not stored_detail else ({}, stored_detail)
            logins = [(runs_on, "stored-login.json", None, stored_seen, stored_detail), (own, "usage.json", own, seen, detail)]
        known = {login[0].lower() for login in logins}
        for path in sorted(glob.glob(os.path.join(data_dir, "usage-*.json"))):
            name = os.path.basename(path)
            try:
                with open(path) as f:
                    other = json.load(f)
            except (OSError, ValueError):
                other = None
            email = other.get("account") if isinstance(other, dict) else None
            if not isinstance(email, str) or not email or email.lower() in known:
                continue
            seen, detail = judge(name, other, 60, "ops-usage writes the stored login's every 5 minutes, and account-watch.py <email>, run by hand, another account's.")
            logins.append((email, name, email, seen, detail))
            # a refused file leaves the account open to its login-flip reading below
            if detail is None:
                known.add(email.lower())
        # each account login-flip probes, from its reading in login-flip.json's seen, so the split's accounts reach the pick with no usage-<name>.json of their own
        try:
            with open(os.path.join(data_dir, "ops", "usage", "login-flip.json")) as f:
                flip_seen = json.load(f).get("seen") or {}
        except Exception:
            flip_seen = {}
        for email, s in sorted(flip_seen.items()) if isinstance(flip_seen, dict) else []:
            if not isinstance(email, str) or "@" not in email or email.lower() in known or not isinstance(s, dict):
                continue
            rate = {"seven_day": {"used_percentage": s.get("week"), "resets_at": s.get("weekReset")}}
            if isinstance(s.get("five"), (int, float)):
                rate["five_hour"] = {"used_percentage": s["five"], "resets_at": s.get("fiveReset")}
            name = "login-flip.json seen"
            seen, detail = judge(name, {"rate_limits": rate, "writtenAt": s.get("at")}, 60, "login-flip.py probes it each ops tick.")
            logins.append((email, name, email, seen, detail))
            if detail is None:
                known.add(email.lower())
        logins = [(email, name, acct, seen, detail or (f"it is parked until {parked[email.lower()]} (usage.accounts parkedUntil)" if email.lower() in parked else None)) for email, name, acct, seen, detail in logins]
        # --account naming the own login: that login alone, judged as a bare start judges it, refused on its reading's failure and never split
        if own_pick:
            logins = logins[:1]
            if logins[0][4]:
                readings.update(logins[0][3])
                refuse("usage", f"--account {own_pick}, this machine's own login: {logins[0][4]}")
        passing = [login for login in logins if login[4] is None]
        if not passing:
            readings.update(logins[0][3])
            if len(logins) == 1:
                refuse("usage", logins[0][4])
            readings["logins"] = {f"{email} ({name})": detail for email, name, _, _, detail in logins}
            refuse("usage", "every login is over it: " + "; ".join(f"{email} ({name}): {detail}" for email, name, _, _, detail in logins))
        # login-flip.py's split, under 30 minutes old (two of the ops tick's 15-minute beats), picks among the passing logins it shares by smooth weighted round robin over split-picks.json (playbook's SPAWN.md, --account), else the lowest week
        flip_dir = os.path.join(data_dir, "ops", "usage")
        try:
            with open(os.path.join(flip_dir, "login-flip.json")) as f:
                split = json.load(f)["split"]
            shares = {a.lower(): v for a, v in split["shares"].items()} if now.timestamp() - split["at"] < 1800 and not own_pick else {}
        except Exception:
            shares = {}
        shared = {login[0]: shares[login[0].lower()] for login in passing if isinstance(shares.get(login[0].lower()), (int, float)) and shares[login[0].lower()] > 0}
        if shared:
            picks_path = os.path.join(flip_dir, "split-picks.json")
            try:
                with open(picks_path) as f:
                    credit = {a: float(c) for a, c in json.load(f).items() if a in shared}
            except Exception:
                credit = {}
            for a, share in shared.items():
                credit[a] = credit.get(a, 0) + share
            pick = max(shared, key=lambda a: credit[a])
            credit[pick] -= sum(shared.values())
            if not check:
                try:
                    with open(f"{picks_path}.{os.getpid()}", "w") as f:
                        json.dump(credit, f)
                    os.replace(f"{picks_path}.{os.getpid()}", picks_path)
                except OSError:
                    pass
            chosen = next(login for login in passing if login[0] == pick)
            readings["share"] = shared[pick]
        else:
            chosen = min(passing, key=lambda login: login[3].get("week", 0))
        readings.update(chosen[3])
        if len(logins) > 1:
            readings["logins"] = {f"{email} ({name})": detail or (f"week {fmt(seen['week'])}%" if "week" in seen else seen["usage"]) for email, name, _, seen, detail in logins}
        if chosen[2]:
            readings["account"] = chosen[2]
except Skip:
    pass

row = {"at": now.isoformat(timespec="seconds").replace("+00:00", "Z"), "gate": None, "readings": readings, "session": session, "verdict": "check" if check else "pass"}
if skips:
    row.update(detail="; ".join(d for _, d in skips), gate=", ".join(g for g, _ in skips), verdict="check" if check else "skipped")
try:
    with open(log_path, "a") as f:
        f.write(json.dumps(row, sort_keys=True) + "\n")
except OSError:
    pass
# each skip's words without the refusal's advice to run it again, since this start goes ahead; the pattern stays outside the f-string, where macOS's own python3 (3.9, on launchd's PATH) refuses a backslash
advice = re.compile(r"\. Wait for|\. Close a session|; wait for its next run")
for gate, detail in skips:
    words = advice.split(detail)[0]
    print(f"past the first dispatcher starts past the {gate} gate, which would hold another start: {words}")
why = f"next in the account split ({fmt(readings['share'] * 100)}% of new sessions)" if "share" in readings else "the login with the most room this week"
if any(gate == "usage" for gate, _ in skips):
    print("ok")
elif own_pick:
    week = f"its week is at {fmt(readings['week'])}%" if "week" in readings else f"its usage {readings.get('usage', 'unread')}"
    print(f"ok - --account {own_pick} is this machine's own login, so it starts there, the split skipped: {week} ({chosen[1]})")
elif readings.get("account"):
    print(f"ok {readings['account']} no --account, so it starts on {readings['account']}, {why}: its week is at {fmt(readings['week'])}% ({chosen[1]})")
elif "logins" in readings:
    print(f"ok - no --account, so it stays on {chosen[0]}, {why}: its week is at {fmt(readings['week'])}% ({chosen[1]})")
else:
    print("ok")
PY
  ) || refuse "it cannot read the machine's readings"
  # A first dispatcher's skips come first, one line each, before the verdict's own.
  while [[ $verdict == "past "*$'\n'* ]]; do
    line=${verdict%%$'\n'*}
    echo "spawn.sh: ${line#past }"
    verdict=${verdict#*$'\n'}
  done
  case "$verdict" in
    ok) ;;
    "ok "*)
      pick=${verdict#ok }
      pick=${pick%% *}
      [ "$pick" = - ] || { ACCOUNT=$pick; PICKED=1; check_account; }
      echo "spawn.sh: ${verdict#ok "$pick" }"
      ;;
    *) refuse "$verdict" ;;
  esac
}

# --account, --backend, --harness, --model, --effort, --brief, --pr, --reports-to, --title, --in, --memory, --check and --priority may sit anywhere among the words; the rest are the mode's.
ACCOUNT=
PICKED=
BACKEND=
HARNESS=
GLM_ACCOUNT=
GLM_GIVEN=
# usage.accounts sits mid-list, since an empty list prints an empty line, which a last line would lose. The models a session runs on (models.*) and the capacity gate's lines (gates.*) are settings, each in the docs' list of keys, so changing one is a settings write, never an edit here.
MODEL_SETTINGS=$(env $UNSET "$BUN" "$REPO/packages/scripts/src/playground/setting.ts" --text models.claude models.default models.checker models.glm models.glmKeychainService \
  gates.glmLoad5Max gates.glmSwapinsMax gates.memoryFreeMin gates.reviewReserve gates.smallReserve gates.startsWindow usage.accounts sessions.names sessions.aliases context.window 2>&1) ||
  { echo "spawn.sh refuses: it cannot read the model and gate settings: $MODEL_SETTINGS" >&2; exit 1; }
{
  read -r CLAUDE_MODELS; read -r DEFAULT_MODEL; read -r CHECKER_MODEL; read -r GLM_ID; read -r GLM_KEYCHAIN
  read -r GLM_LOAD5_MAX; read -r GLM_SWAPINS_MAX; read -r MEMORY_FREE_MIN; read -r REVIEW_RESERVE; read -r SMALL_RESERVE; read -r STARTS_WINDOW
  read -r USAGE_ACCOUNTS; read -r SESSION_NAMES; read -r SESSION_ALIASES; read -r WINDOW
} <<<"$MODEL_SETTINGS"
SESSION_KINDS=$(python3 -I -c 'import json, sys; n, a = map(json.loads, sys.argv[1:3]); [print(*row) for row in [(v, k) for k, v in n.items()] + [(n["dispatcher"] + "-2", "dispatcher")] + list(a.items())]' "$SESSION_NAMES" "$SESSION_ALIASES")
# slots.peers, the ops folders of the other factories on this machine, whose starts the load gate counts beside this one's; none when unread
PEERS=$(setting slots.peers) || PEERS=; [ -n "$PEERS" ] || PEERS="[]"
GATES="{\"accounts\": ${USAGE_ACCOUNTS:-[]}, \"glmLoad5Max\": $GLM_LOAD5_MAX, \"glmSwapinsMax\": $GLM_SWAPINS_MAX, \"memoryFreeMin\": $MEMORY_FREE_MIN, \"peers\": $PEERS, \"reviewReserve\": $REVIEW_RESERVE, \"smallReserve\": $SMALL_RESERVE, \"startsWindow\": $STARTS_WINDOW}"
MODELS=$(printf '%s\n' $CLAUDE_MODELS | awk '{ m[NR] = $0 } END { for (i = 1; i <= NR; i++) printf "%s%s", m[i], (i < NR - 1 ? ", " : i == NR - 1 ? " or " : "") }')
CLAUDE_MODEL=
EFFORT=
RESUME_BRIEF=
PR_ARG=
# An extension item a checker scores, <scope>/<kind>/<key>, checked as roster.ts and playground ext check one: the kinds are packages/settings' KINDS.
ITEM_FORM='[A-Za-z0-9][A-Za-z0-9-]*/(doc|learning|list|rule|script|skill|template)/[a-z0-9][a-z0-9._-]*'
REPORTS_TO=
TITLE_ARG=
IN_DIR=
MEMORY_DIR=
MEMORY_OFF=
CHECK=
PRIORITY=
NAME_PROJECT=
SIZE=
RUNTIME=
words=()
while [ $# -gt 0 ]; do
  if [ "$1" = --account ]; then
    [ $# -ge 2 ] && [ -n "$2" ] && [ -z "$ACCOUNT" ] || usage
    case "$2" in --*) usage "--account needs a value; \"$2\" starts with --" ;; esac
    ACCOUNT=$2
    shift 2
  elif [ "$1" = --backend ]; then
    [ $# -ge 2 ] && [ -n "$2" ] && [ -z "$BACKEND" ] || usage
    case "$2" in --*) usage "--backend needs a value; \"$2\" starts with --" ;; esac
    BACKEND=$2
    shift 2
  elif [ "$1" = --harness ]; then
    [ $# -ge 2 ] && [ -z "$HARNESS" ] || usage "--harness takes claude-code or codex, once"
    case "$2" in claude-code | codex) HARNESS=$2 ;; *) usage "--harness takes claude-code or codex, not \"$2\"" ;; esac
    shift 2
  elif [ "$1" = --model ]; then
    [ $# -ge 2 ] && [ -n "$2" ] && [ -z "$CLAUDE_MODEL" ] || usage "--model takes one of $MODELS, once"
    case "$2" in --*) usage "--model needs a value; \"$2\" starts with --" ;; esac
    CLAUDE_MODEL=$2
    shift 2
  elif [ "$1" = --effort ]; then
    [ $# -ge 2 ] && [ -n "$2" ] && [ -z "$EFFORT" ] || usage "--effort takes one of low, medium, high, xhigh or max, once"
    case "$2" in --*) usage "--effort needs a value; \"$2\" starts with --" ;; esac
    EFFORT=$2
    shift 2
  elif [ "$1" = --pr ]; then
    [ $# -ge 2 ] && [ -n "$2" ] && [ -z "$PR_ARG" ] || usage "--pr takes the PR a checker serves, once"
    pr_form="^(#?[1-9][0-9]*|https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(pull|issues)/[1-9][0-9]*|$ITEM_FORM)\$"
    IFS=, read -ra prs_named <<<"$2"
    for one in "${prs_named[@]}"; do
      [[ $one =~ $pr_form ]] || usage "--pr takes a PR's URL or its number alone, comma-separated, an issue's URL beside one for a PR not yet opened, or an extension item as <scope>/<kind>/<key>, not \"$2\""
    done
    PR_ARG=$2
    shift 2
  elif [ "$1" = --reports-to ]; then
    [ $# -ge 2 ] && [ -n "$2" ] && [ -z "$REPORTS_TO" ] || usage "--reports-to takes a session name, once"
    case "$2" in --*) usage "--reports-to needs a value; \"$2\" starts with --" ;; esac
    REPORTS_TO=$2
    shift 2
  elif [ "$1" = --title ]; then
    [ $# -ge 2 ] && [ -n "$2" ] && [ -z "$TITLE_ARG" ] || usage "--title takes a plain title, once"
    case "$2" in --*) usage "--title needs a value; \"$2\" starts with --" ;; esac
    TITLE_ARG=$2
    shift 2
  elif [ "$1" = --in ]; then
    [ $# -ge 2 ] && [ -n "$2" ] && [ -z "$IN_DIR" ] || usage "--in takes a folder, once"
    case "$2" in --*) usage "--in needs a value; \"$2\" starts with --" ;; esac
    IN_DIR=$2
    shift 2
  elif [ "$1" = --memory ]; then
    [ $# -ge 2 ] && [ -z "$MEMORY_DIR$MEMORY_OFF" ] && [[ $2 == /* || $2 == off ]] || usage "--memory takes an absolute folder or off, once"
    if [ "$2" = off ]; then MEMORY_OFF=1; else MEMORY_DIR=$2; fi
    shift 2
  elif [ "$1" = --runtime ]; then
    [ $# -ge 2 ] && [ -n "$2" ] && [ -z "$RUNTIME" ] || usage
    case "$2" in
      --*) usage "--runtime needs a value; \"$2\" starts with --" ;;
      herdr) ;;
      *) usage "--runtime takes herdr alone, not \"$2\"" ;;
    esac
    RUNTIME=$2
    shift 2
  elif [ "$1" = --size ]; then
    [ $# -ge 2 ] && [ -z "$SIZE" ] || usage "--size takes small, medium or big, once"
    case "$2" in small | medium | big) SIZE=$2 ;; *) usage "--size takes small, medium or big, not \"$2\"" ;; esac
    shift 2
  elif [ "$1" = --check ]; then
    CHECK=1
    shift
  elif [ "$1" = --priority ]; then
    PRIORITY=1
    shift
  elif [ "$1" = --brief ]; then
    [ $# -ge 2 ] && [ -n "$2" ] && [ -z "$RESUME_BRIEF" ] || usage
    case "$2" in --*) usage "--brief needs a value; \"$2\" starts with --" ;; esac
    RESUME_BRIEF=$2
    shift 2
  else
    words+=("$1")
    shift
  fi
done
set -- ${words[@]+"${words[@]}"}

# herdr runs by the absolute path herdr's pin names, never a bare herdr, and only while that file is the pinned version and hash and the server $1 is running; hr then speaks to that server.
herdr_ready() {
  HERDR_SESSION_NAME=$1
  word "$HERDR_SESSION_NAME" || refuse "PLAYGROUND_HERDR_SESSION is a word, not $HERDR_SESSION_NAME"
  pinned=$(python3 -I - "$HERDR_DIR/pin.json" <<'PY'
import hashlib, json, os, sys
try:
    with open(sys.argv[1]) as f:
        pin = json.load(f)
    path, version, sha = pin["path"], pin["version"], pin["sha256"]
    assert all(isinstance(v, str) and v and "\n" not in v for v in (path, version, sha)) and os.path.isabs(path)
except Exception:
    sys.exit(1)
try:
    with open(os.path.realpath(path), "rb") as f:
        found = hashlib.sha256(f.read()).hexdigest()
except OSError:
    found = "unreadable"
print(path, version, sha, found, sep="\n")
PY
  ) || refuse "it cannot read the herdr pin $HERDR_DIR/pin.json ({path, sha256, version}); the ops-herdr job writes it"
  HERDR=$(sed -n 1p <<<"$pinned")
  pin_version=$(sed -n 2p <<<"$pinned")
  [ "$(sed -n 3p <<<"$pinned")" = "$(sed -n 4p <<<"$pinned")" ] ||
    refuse "herdr at $HERDR does not hash to its pin's sha256 ($HERDR_DIR/pin.json), so it is not the pinned copy"
  found_version=$("$HERDR" --version 2>/dev/null | head -1) || found_version=
  [ "$found_version" = "herdr $pin_version" ] ||
    refuse "herdr at $HERDR reads ${found_version:-nothing} on --version, and its pin names herdr $pin_version"
  hr() { env HERDR_SESSION="$HERDR_SESSION_NAME" HERDR_SOCKET_PATH="$HERDR_DIR/$HERDR_SESSION_NAME.sock" HERDR_CONFIG_PATH="$HERDR_DIR/config.toml" "$HERDR" "$@"; }
  # spawn.sh never starts or stops a server: a stop exits every pane, and the ops-herdr job owns both.
  hr status server --json 2>/dev/null | python3 -I -c 'import json, sys; sys.exit(0 if json.load(sys.stdin).get("running") is True else 1)' ||
    refuse "the herdr server $HERDR_SESSION_NAME is not running at $HERDR_DIR/$HERDR_SESSION_NAME.sock; playground, or bun run ops:herdr start, brings it up"
}

MODE=${1:-}
[ $# -gt 0 ] && shift
[ -z "$REPORTS_TO" ] || [ "$MODE" = worker ] || usage "--reports-to is for a worker, not ${MODE:-no mode}"
[ -z "$IN_DIR" ] || [ "$MODE" = worker ] || usage "--in is for a worker, not ${MODE:-no mode}"
[ -z "$PR_ARG" ] || [[ $MODE =~ ^(column|resume)$ ]] || usage "--pr is for a reviewer's or tester's column or resume, not ${MODE:-no mode}"
[ -z "$TITLE_ARG" ] || [[ $MODE =~ ^(worker|column|resume)$ ]] || usage "--title is for a worker or a reviewer's or tester's column, not ${MODE:-no mode}"
# herdr 0.9.5 keeps a resume command only from a source that holds the pane through report-agent, and then shows that source's state in place of its own (measured: a 14s turn read idle throughout), so restore reruns the sessions spawn.sh itself listed, with ops-herdr's resume_agents_on_restore off. Each goes through resume, so the gate and the live-name check judge it, and a live one is left as it is.
if [ "$MODE" = restore ]; then
  NAME=restore
  [ $# -eq 0 ] && [ -z "$CHECK$ACCOUNT$BACKEND$CLAUDE_MODEL$EFFORT$MEMORY_DIR$MEMORY_OFF$RESUME_BRIEF$RUNTIME$SIZE" ] || usage "restore takes no other words"
  # One restore at a time: ops-herdr's start and its job's next cycle can both run one, and two resumes of a name both pass the live-name check until its claude writes its registry file, so it would start twice. The lock is a symlink naming its holder's pid and start time, so a holder that died, or a pid macOS handed on, frees it.
  LOCK="$RESUME_DIR/.restore.lock"
  ME=$(started $$)
  ME=${ME:-$$}
  mkdir -p "$RESUME_DIR"
  if ! ln -s "$ME" "$LOCK" 2>/dev/null; then
    HELD=$(readlink "$LOCK")
    if [ -n "$HELD" ] && [ "$HELD" = "$(started "${HELD%% *}")" ]; then
      echo "another restore is running (pid ${HELD%% *})"
      exit 1
    fi
    rm -f "$LOCK"
    ln -s "$ME" "$LOCK" 2>/dev/null || { echo "another restore is running"; exit 1; }
  fi
  trap '[ "$(readlink "$LOCK")" = "$ME" ] && rm -f "$LOCK"' EXIT
  # A function holds the heredoc, since macOS bash 3.2 misreads the # in a heredoc inside $( ). The roster is roster.ts's own, which runs without CLAUDE_CONFIG_DIR under inscope, as the TITLE read below does.
  # Each server restores the sessions its own records place there (a probes server restored nothing of its own on 18 Oct), a record with no server line being playground's, as every session before the line was.
  SERVER=${PLAYGROUND_HERDR_SESSION:-${DESK_HERDR_SESSION:-playground}}
  word "$SERVER" || refuse "PLAYGROUND_HERDR_SESSION is a word, not $SERVER"
  restore_list() {
    env $UNSET python3 -I - "$DATA" "$SERVER" <<'PY'
import json, os, shlex, sys

lw, server = sys.argv[1], sys.argv[2]
roster = os.path.join(lw, "roster.json")
try:
    agents = json.load(open(roster)).get("agents", []) if os.path.exists(roster) else []
    down = {a.get("name"): a.get("status") for a in agents if isinstance(a, dict) and a.get("status") in ("done", "ended", "parked", "paused")}
    # a checker's resume names the PRs its row serves, which every reviewer or tester start takes as --pr
    served = {}
    for a in agents:
        if isinstance(a, dict) and a.get("kind") in ("reviewer", "tester") and isinstance(a.get("name"), str):
            listed = a.get("prs") if isinstance(a.get("prs"), list) else []
            served[a["name"]] = ",".join(dict.fromkeys(u for u in [a.get("pr"), *listed] if isinstance(u, str) and u))
except (OSError, ValueError, AttributeError, TypeError):
    sys.exit("it cannot read the roster " + roster)

def skip(name, reason):
    print("skip\t" + name + "\t" + reason)

folder = os.path.join(lw, "resume")
for file in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
    name = file[:-3]
    if not file.endswith(".sh") or "\t" in name or "\n" in name:
        continue
    try:
        lines = open(os.path.join(folder, file)).read().splitlines()
    except (OSError, ValueError):
        skip(name, "its resume record does not read")
        continue
    if next((l[len("# server: "):] for l in lines if l.startswith("# server: ")), "playground") != server:
        continue
    if name in down:
        skip(name, "its roster row reads " + down[name])
        continue
    try:
        words = shlex.split(next(l for l in lines if l.startswith("exec ")))
    except StopIteration:
        skip(name, "its resume record has no exec line")
        continue
    except ValueError:
        skip(name, "its exec line does not parse")
        continue
    extras = words[6:]
    keys = extras[::2]
    if (
        len(words) >= 6
        and words[1].endswith("/scripts/spawn.sh")
        and words[2:4] == ["resume", name]
        and len(extras) % 2 == 0
        and sorted(set(keys)) == sorted(keys)
        and set(keys) <= {"--account", "--effort", "--model"}
        and not any("\t" in w or "\n" in w for w in words)
    ):
        print("run\t" + "\t".join(words[3:] + (["--pr", served[name]] if served.get(name) else [])))
    else:
        skip(name, "its exec line is not a resume restore runs")
PY
  }
  lines=$(restore_list) || refuse "it cannot read the roster or the resume files"
  # The first dispatcher's record runs first, so the owner's dispatcher is back before any other resume takes the gate's room.
  first=$(dispatcher_of 1)
  lead= rest=
  while IFS= read -r line; do
    case "$line" in "run"$'\t'"$first"$'\t'*) lead+="$line"$'\n' ;; *) rest+="$line"$'\n' ;; esac
  done <<<"$lines"
  lines="$lead$rest"
  # A resume that waits (restore_waits) comes back on a later restore, so it is progress, printed as waiting, and leaves the exit 0; any other miss fails the restore.
  failed=0
  while IFS=$'\t' read -r -a args; do
    case "${args[0]:-}" in
      skip) echo "skipped ${args[1]}: ${args[2]}" ;;
      run)
        args=("${args[@]:1}")
        [ "${#args[@]}" -ge 3 ] || continue
        # A close can end a row after restore_list read the roster, so each resume reads the row again once it finds the session gone (SPAWN_RESTORING, below) and exits 4 on a down row.
        if said=$(SPAWN_RESTORING=1 bash "$0" resume "${args[@]}" 2>&1 </dev/null); then
          echo "restored ${args[0]}"
        else
          rc=$?
          said=$(tail -1 <<<"$said")
          said=${said#"spawn.sh refuses ${args[0]}: "}
          if [ "$rc" -eq 3 ]; then
            echo "skipped ${args[0]}: live"
          elif [ "$rc" -eq 4 ]; then
            echo "skipped ${args[0]}: $said"
          elif restore_waits "$said"; then
            echo "waiting ${args[0]}: $said"
          else
            failed=1
            echo "not restored ${args[0]}: $said"
          fi
        fi
        ;;
    esac
  done <<<"$lines"
  exit "$failed"
fi
# A factory session closes a herdr session's pane only here, since the no-raw-spawn hook refuses herdr's own pane close: herdr's socket has no access control. It closes only a pane spawn.sh opened, by the label it set, on the server the session's resume record names, and ends the session's roster row just before the pane closes (putting its status back when herdr refuses the close), so a restore that finds the session gone reads ended, keeping its time and the row's status in $DATA/closes/<name> for the load gate (JUST_CLOSED) and leaving the pins and the record as they are, so a resume, which sets the row back to starting, can reopen it.
if [ "$MODE" = close ]; then
  NAME=${1:-close}
  [ $# -eq 1 ] && [ -z "$CHECK$ACCOUNT$BACKEND$CLAUDE_MODEL$EFFORT$MEMORY_DIR$MEMORY_OFF$RESUME_BRIEF$RUNTIME$SIZE" ] || usage "close takes a session's name alone"
  word "$NAME" || refuse "a name is lowercase words joined by hyphens"
  [ "$(cat "$DATA/runtimes/$NAME" 2>/dev/null)" = herdr ] ||
    refuse "its runtime pin ($SHOWN/runtimes/$NAME) does not read herdr, so spawn.sh did not open it in herdr"
  [ -f "$RESUME_DIR/$NAME.sh" ] || refuse "it has no resume record ($RESUME_DIR/$NAME.sh), which spawn.sh writes when herdr runs a session it opened"
  # A record with no server line is playground's, as restore reads it.
  server=$(sed -n 's/^# server: //p' "$RESUME_DIR/$NAME.sh" | head -1)
  server=${server:-playground}
  word "$server" || refuse "its resume record names its server $server, which is not a word"
  herdr_ready "$server"
  panes=$(hr pane list 2>/dev/null | python3 -I -c 'import json, sys
try:
    for pane in json.load(sys.stdin)["result"]["panes"]:
        if pane.get("label") == sys.argv[1]:
            print(pane["pane_id"])
except (ValueError, KeyError, TypeError):
    sys.exit(1)' "$NAME") || refuse "it cannot read the panes of the herdr server $server"
  count=$(grep -c . <<<"$panes" || true)
  [ "$count" -gt 0 ] || refuse "no pane on the herdr server $server carries the label $NAME, so spawn.sh opened none it can close"
  [ "$count" -eq 1 ] || refuse "$count panes on the herdr server $server carry the label $NAME, so it cannot tell which one spawn.sh opened"
  # herdr sets HERDR_PANE_ID and HERDR_SESSION in every pane, and a pane id is unique on its own server alone.
  [ "$panes" != "${HERDR_PANE_ID:-}" ] || [ "${HERDR_SESSION:-$server}" != "$server" ] ||
    refuse "pane $panes is your own; a session ends itself with /exit"
  # The row reads ended before the pane closes, so a restore's resume that finds the session gone reads ended too and leaves it down; a close herdr refuses puts the row's status back.
  # roster.ts drops a parked row's hold once it reads ended, and a park takes one in the same call, so the put-back names it.
  was=$(roster_field "$NAME" status)
  back=("status=$was")
  [ "$was" != parked ] || back+=("hold=$(roster_field "$NAME" hold)")
  ended=1
  rostered=$(env $UNSET "$BUN" "$ROSTER" set "$NAME" status=ended 2>&1 >/dev/null) || ended=
  if ! said=$(hr pane close "$panes" 2>&1 >/dev/null | tr -s '\n' ' '); then
    said=${said% }
    if [ -n "$ended" ] && [ -n "$was" ] && ! rostered=$(env $UNSET "$BUN" "$ROSTER" set "$NAME" "${back[@]}" 2>&1 >/dev/null); then
      [ -n "$rostered" ] && echo "roster.ts says: $rostered" >&2
      echo "spawn.sh: $NAME's row reads ended, but its pane stays open; put it back with $BUN $ROSTER set $NAME ${back[*]}" >&2
    fi
    refuse "herdr would not close pane $panes (${said:-no answer from herdr})"
  fi
  echo "closed $NAME (pane $panes on $server)"
  # The close keeps its time and the row's status before it ended it, for the load gate's pass of a resume within 15 minutes (JUST_CLOSED, below).
  { mkdir -p "$DATA/closes" && echo "$(date -u +%s) $(date -u +%FT%TZ) ${was:-none}" > "$DATA/closes/$NAME"; } 2>/dev/null || true
  if [ -z "$ended" ]; then
    [ -n "$rostered" ] && echo "roster.ts says: $rostered" >&2
    echo "spawn.sh: $NAME closed, but its roster write failed; record it with $BUN $ROSTER set $NAME status=ended, adding task=<what it does> for a name the roster lacks" >&2
  fi
  exit 0
fi
# A manager's column names it once, read as the long form: a lead reports to the first dispatcher, and the first dispatcher is briefed by the session running spawn.sh, its name read from Claude's registry entry for CLAUDE_PID.
if [ "$MODE" = column ] && [ $# -eq 3 ]; then
  NAME=$1
  if [ "$(kind_of "$NAME")" = dispatcher ] && [ "$NAME" != "$(dispatcher_of 2)" ] && ! second_dispatcher "$NAME"; then
    by=
    [[ ${CLAUDE_PID:-} =~ ^[0-9]+$ ]] && by=$(python3 -I -c 'import json, sys
try:
    name = json.load(open(sys.argv[1])).get("name")
    print(name if isinstance(name, str) else "")
except Exception:
    pass' "$REGISTRY/$CLAUDE_PID.json")
    word "$by" || refuse "it reads no session running spawn.sh (CLAUDE_PID's entry in $REGISTRY) to brief $NAME: name it, column dispatcher $NAME <the lead that briefs it> <pane> <brief>"
    set -- dispatcher "$NAME" "$by" "$2" "$3"
  else
    kind=$(kind_of "$NAME")
    { [[ $kind =~ ^(dispatcher|optimizer)$ ]] || { [ "$(role_of_kind "$kind")" = lead ] && [[ ! $kind =~ ^(builder|ops|planner)$ ]]; }; } && refuse "$NAME opens in a workspace of its own: spawn.sh manager $NAME <brief>"
    [[ $(kind_of "$NAME") =~ ^(builder|ops|planner)$ ]] ||
      refuse "$NAME is no manager: column <manager> <pane> <brief> takes a lead or the first dispatcher, and column <reviewer|tester|probe|lead|dispatcher> <name> <reports-to> <pane> <brief> takes the rest"
    set -- lead "$NAME" "$(dispatcher_of 1)" "$2" "$3"
  fi
fi
# Every start opens in herdr.
[ "$MODE" = resume ] || RUNTIME=herdr
SURFACE=
# The first dispatcher, started by manager, works with the owner and reports to no session.
FIRST=
case "$MODE" in
  worker | runner)
    [ $# -eq 2 ] || usage
    NAME=$1 BRIEF=$2
    ROLE=$MODE KIND=$MODE
    if [ -n "$REPORTS_TO" ]; then
      TO=$REPORTS_TO
      word "$TO" || refuse "it reports to a session name, not $TO"
    else
      if [ "$ROLE" = runner ]; then TO=$(manager_of ops); else TO=$(manager_of builder); fi
      word "$TO" || refuse "roster.ts who gave $TO, not a session name"
    fi
    DIR=$REPO
    if [ -n "$IN_DIR" ]; then
      [ -d "$IN_DIR" ] || refuse "--in names no folder: $IN_DIR"
      trusted_root "$IN_DIR" || refuse "--in $IN_DIR is outside $(code_root) and each folder of an org ext.links guards, so Claude's trust prompt there is the owner's to answer"
      DIR=$(cd -P "$IN_DIR" && pwd -P)
    fi
    ;;
  column)
    [ $# -eq 5 ] || usage
    ROLE=$1 NAME=$2 TO=$3 SURFACE=$4 BRIEF=$5
    case "$ROLE" in
      reviewer | tester | probe) ;;
      lead) kind=$(kind_of "$NAME"); [[ $kind =~ ^(builder|ops|planner)$ ]] || { [ "$(role_of_kind "$kind")" = lead ] && refuse "$NAME opens in a workspace of its own: spawn.sh manager $NAME <brief>"; } || refuse "a lead is a builder, ops or planner by its roster kind, else by its sessions.names name; give a new name its kind first: roster.ts set <name> kind=<kind> task=<what it does>" ;;
      dispatcher)
        ROLE=dispatcher
        [ "$(kind_of "$NAME")" = dispatcher ] || refuse "the dispatcher is an <id>-dispatcher, or sessions.names' dispatcher"
        { [ "$NAME" != "$(dispatcher_of 2)" ] && ! second_dispatcher "$NAME"; } || refuse "$NAME holds the second dispatcher's slot, so it opens in a workspace of its own: spawn.sh manager $NAME <brief>"
        ;;
      *) refuse "a column is a reviewer, tester, probe, lead or dispatcher, not $ROLE" ;;
    esac
    KIND=$ROLE
    [[ $ROLE =~ ^(dispatcher|lead)$ ]] && KIND=$(kind_of "$NAME")
    word "$TO" || refuse "it reports to a session name, not $TO"
    [[ $SURFACE =~ ^w[0-9A-Za-z]+:p[0-9A-Za-z]+$ ]] || refuse "$SURFACE is not a herdr pane id (w1:p2): a column in herdr opens beside a pane, its spawner's own being \$HERDR_PANE_ID"
    ;;
  probe)
    [ $# -eq 3 ] || usage
    ROLE=probe KIND=probe NAME=$1 TO=$2 BRIEF=$3
    word "$TO" || refuse "it reports to a session name, not $TO"
    DIR=$REPO
    ;;
  manager)
    [ $# -eq 2 ] || usage
    NAME=$1 BRIEF=$2
    # the first dispatcher works with the owner, the second answers to the first (Alpha), and the optimizer reports to it as a lead does
    case "$(kind_of "$NAME")" in
      dispatcher) ROLE=dispatcher KIND=dispatcher TO=$(dispatcher_of 1) ;;
      optimizer) ROLE=lead KIND=optimizer TO=$(dispatcher_of 1) ;;
      builder | ops | planner) ROLE=lead KIND=$(kind_of "$NAME") TO=$(dispatcher_of 1) ;;
      *)
        # An orchestrator: any other manager kind the roster gives the name, reporting to the session its row names.
        KIND=$(kind_of "$NAME") TO=$(roster_field "$NAME" reportsTo) ROLE=lead
        [ "$(role_of_kind "$KIND")" = lead ] || refuse "a manager in a workspace of its own is the first dispatcher (sessions.names' dispatcher), the second (an <id>-dispatcher, or sessions.names' dispatcher with -2), the optimizer, the builder, ops or the planner, or an orchestrator, a name the roster gives a manager kind ($MANAGER_KINDS) and a session to report to; give a new name both first: roster.ts set <name> kind=<kind> reportsTo=<session> task=<what it does>"
        word "$TO" || refuse "$NAME is an orchestrator of the $KIND kind, and its roster row names no session it reports to: roster.ts set $NAME reportsTo=<session>"
        ;;
    esac
    [ "$KIND" = dispatcher ] && first_dispatcher "$NAME" && FIRST=1 TO=
    DIR="${PLAYGROUND_REPO:-$MAIN}/.claude/worktrees/leads"
    # A fresh checkout has no leads worktree until its first manager start cuts one as branch leads from origin's copy of the branch the checkout was cloned on, tracking it: canary only for a checkout cloned on canary on purpose, else main, so a public install's managers run what it shipped. A branch of its own, since the checkout holds its branch already, and a manager's bare git calls land in its own tree, never the main checkout.
    CUT=
    if [ ! -e "$DIR" ]; then
      base=main
      [ "$(git -C "${PLAYGROUND_REPO:-$MAIN}" symbolic-ref -q --short HEAD 2>/dev/null)" = canary ] && base=canary
      made=$(git -C "${PLAYGROUND_REPO:-$MAIN}" worktree add -q --track -B leads "$DIR" "origin/$base" 2>&1) || refuse "git worktree add $DIR origin/$base failed, so there is no leads worktree to open in: ${made%%$'\n'*}"
      CUT=1
    fi
    [ -d "$DIR" ] || refuse "$DIR is not a folder"
    # Its install follows until one has exited 0, which leaves node_modules/.playground-installed, since a failed install leaves a partial node_modules and a manager runs bun run from it; a failed install moves only this start's cut to the trash for the next start to cut again, and keeps any other leads worktree, which may hold work, for the next start's install.
    if [ ! -e "$DIR/node_modules/.playground-installed" ]; then
      made=$(bash "$REPO/scripts/ops/run-slot.sh" "$NAME" -- "$BUN" install --frozen-lockfile --ignore-scripts --cwd "$DIR" 2>&1) || { [ -n "${CUT:-}" ] || refuse "bun install in the leads worktree $DIR failed, and this start did not cut it, so it stays for the next start's install: ${made##*$'\n'}"; gone=$("$BUN" --no-env-file "$REPO/packages/scripts/src/playground/cli.ts" rm --worktree "$DIR" --reason "its install failed" 2>&1) || refuse "bun install in the new leads worktree $DIR failed (${made##*$'\n'}), and playground rm --worktree refused to move it, so it stays: ${gone##*$'\n'}"; refuse "bun install in the new leads worktree $DIR failed, so it is moved to the trash for the next start to cut again: ${made##*$'\n'}"; }
      mkdir -p "$DIR/node_modules" && : > "$DIR/node_modules/.playground-installed"
    fi
    ;;
  resume)
    [ $# -ge 2 ] && [ $# -le 3 ] || usage
    [ -z "$TITLE_ARG" ] || usage "--title is for a worker's or a checker's start, not a resume"
    NAME=$1 DIR=$2 SESSION=${3:-$1} BRIEF=$RESUME_BRIEF
    KIND=$(kind_of "$NAME")
    ROLE=$(role_of_kind "$KIND")
    [ -n "$ROLE" ] || refuse "$NAME is not a factory session's name, and the roster gives it no kind"
    [ "$KIND" = dispatcher ] && first_dispatcher "$NAME" && FIRST=1
    # A checker whose roster row names an ended worker is ended again on the checker reaper's next pass unless a live worker serves one of its open PRs (checker-worker-gone; the rule: scripts/ops/README.md's optimizer/ entry), so its row moves to the worker it now serves before it comes back.
    if [[ $ROLE =~ ^(reviewer|tester)$ ]]; then
      serves=$(roster_field "$NAME" worker)
      [ -z "$serves" ] || [ "$(roster_field "$serves" status)" != ended ] ||
        refuse "its roster row names $serves as its worker, which has ended, so the checker reaper ends it again unless a live worker serves one of its open PRs: point it at the worker it serves first, with bun scripts/roster.ts assign $NAME \"<title>\" review worker=<live worker> pr=<url>, or, when it serves none, end its row with bun scripts/roster.ts set $NAME status=ended"
    fi
    # macOS guards the Desktop folder, so a new pane there fails until Full Disk Access is granted again after each update: a folder there resumes in the same tree under the code root, and in place where the code root is on the Desktop itself.
    desktop="$HOME/Desktop/" # the folder the factory left
    off_desktop() { local rest=${1#"$desktop"} root; root=$(code_root); [[ $1 == "$desktop"* && -d $root && $root/ != "$desktop"* ]] && echo "$root/${rest#"$(basename "$root")"/}" || echo "$1"; }
    [[ $DIR != "$desktop"* ]] || FROM=$DIR DIR=$(off_desktop "$DIR")
    [[ $SESSION == "$NAME" || $SESSION =~ ^[0-9a-f-]{36}$ ]] || refuse "$SESSION is not a session id"
    # The session's transcripts, whose newest line names the folder it ran in and its branch, so a refusal names the way back.
    # The newest copy is the one the session last wrote, since a Desktop move leaves the old project's copy behind; a folder it names there reads as its twin.
    found= ran= branch= t=
    if [[ $SESSION =~ ^[0-9a-f-]{36}$ ]]; then
      t=$(ls -t "$PROJECTS"/*/"$SESSION.jsonl" 2>/dev/null | head -1) || true
      [ -z "$t" ] || found=1
    fi
    # Only a refusal reads the whole transcript, since a long one takes seconds and herdr gives up on a restore at 10s.
    trail() {
      if [ -n "$found" ]; then
        ran=$(LC_ALL=C sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p' "$t" | tail -1)
        [ -z "$ran" ] || ran=$(off_desktop "$ran")
        branch=$(LC_ALL=C sed -n 's/.*"gitBranch":"\([^"]*\)".*/\1/p' "$t" | tail -1)
      fi
      branch=${branch:-$(roster_field "$NAME" branch)}
    }
    # Only a worktree of this checkout comes back with git -C $MAIN worktree add; a folder in another repo is named with its branch alone.
    way_back() {
      if [[ $1 == "$MAIN/.claude/worktrees/"* ]]; then
        echo "bring the worktree back with git -C $MAIN worktree add $1 ${branch:-<branch>}, then resume it there"
      else
        echo "bring it back${branch:+ on $branch}, then resume it there"
      fi
    }
    [ -d "$DIR" ] || { trail; refuse "$DIR is not a folder${branch:+, and its branch is $branch}: $(way_back "$DIR")"; }
    # The main rule keeps every session from building or committing in the main checkout, so a session that ran elsewhere never moves into it; one that started there, as spawn.sh worker starts every worker, keeps resuming there.
    if [ -n "$found" ] && [ "$(cd -P "$DIR" && pwd -P)" = "$MAIN" ]; then
      started=
      for home_dir in "$MAIN" ${FROM:+"$FROM"}; do
        [ -e "$(project_of "$home_dir")/$SESSION.jsonl" ] && started=1
      done
      if [ -z "$started" ]; then
        trail
        back="resume it in ${ran:-the folder it ran in}"
        [ -z "$ran" ] || [ -d "$ran" ] || back=$(way_back "$ran")
        refuse "$DIR is the main checkout, and $NAME ran in ${ran:-another folder}: $back"
      fi
    fi
    # With no id, the folder's project folder, whose transcripts the name check reads once the capacity gate has read as --check does (below).
    [ $# -ne 2 ] || NAME_PROJECT=$(project_of "$(cd -P "$DIR" && pwd -P)")
    ;;
  *) NAME=${MODE:-session}; usage ;;
esac
word "$NAME" || refuse "a name is lowercase words joined by hyphens"
# A new name gives its kind, since a reader of the name alone would show and place it as another; a lead or manager may take its kind from the roster instead, and a resume keeps the name it has.
NAMED=$(kind_of_name "$NAME")
[ "$MODE" = resume ] || [ -z "$NAMED" ] || [ "$NAMED" = "$KIND" ] || refuse "$NAME reads as a $NAMED, not a $KIND: bun run name $KIND gives one"
[ "$MODE" = resume ] || [ -n "$NAMED" ] || [[ $ROLE =~ ^(dispatcher|lead)$ ]] || refuse "$NAME gives no kind: bun run name $KIND gives one"
[ -z "$RESUME_BRIEF" ] || [ "$MODE" = resume ] || refuse "--brief is for resume; a $MODE takes its brief as a word"
# A worker or checker starts with a plain title the sidebar reads it by, never its first ask: a worker's from --title, a checker's from --title, the one its row holds, or "Review: " or "Test: " before its worker's.
if [ -n "$TITLE_ARG" ]; then
  [ "$MODE" = worker ] || { [ "$MODE" = column ] && [[ $ROLE =~ ^(reviewer|tester)$ ]]; } || usage "--title is for a worker or a reviewer's or tester's column, not ${MODE:-no mode}"
  [ ${#TITLE_ARG} -le 40 ] || refuse "--title is at most 40 characters, and \"$TITLE_ARG\" has ${#TITLE_ARG}"
fi
if [ "$MODE" = worker ] && [ -z "$TITLE_ARG" ]; then
  refuse "a worker starts with a plain title of up to 40 characters saying what it does: --title \"<title>\""
elif [ "$MODE" = column ] && [[ $ROLE =~ ^(reviewer|tester)$ ]] && [ -z "$TITLE_ARG" ] && [ -z "$(roster_field "$NAME" title)" ]; then
  of=$(roster_field "$TO" title)
  [ -n "$of" ] || refuse "a $ROLE starts with a title: set its worker's (roster.ts set $TO title=<title>), or pass --title \"Review: <its title>\""
  if [ "$ROLE" = reviewer ]; then TITLE_ARG="Review: $of"; else TITLE_ARG="Test: $of"; fi
fi
[ -z "$PR_ARG" ] || [[ $ROLE =~ ^(reviewer|tester)$ ]] || usage "--pr is for a reviewer's or tester's start, not a $ROLE's"
# A checker's row names the pull request or extension item it serves, which no-outside-pr-code reads at its first tool call (a row naming no pull request holds it in read mode) and auto-end reads to end it (an ended row's are the PRs it last served), so every reviewer or tester start names one.
[[ ! $ROLE =~ ^(reviewer|tester)$ ]] || [[ ,$PR_ARG, =~ ,(#?[1-9][0-9]*|https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*|$ITEM_FORM), ]] ||
  refuse "a $ROLE starts with --pr <pull url>, the pull request it serves now, by its URL or its number, or the extension item it scores as <scope>/<kind>/<key>, which its roster row records before its pane opens; an issue's URL alone leaves the row with no pr, so open the PR as a draft first"
if [ "$MODE" != resume ] || [ -n "$BRIEF" ]; then
  # The brief's path under ~/.playground names the same file as its bare name.
  BRIEF=${BRIEF#"$DATA/"}
  BRIEF=${BRIEF#"$SHOWN/"}
  { [[ $BRIEF =~ ^[A-Za-z0-9._-][A-Za-z0-9._/-]*$ ]] && [[ /$BRIEF/ != */../* ]]; } || refuse "a brief is a file name under $SHOWN"
  # Only the file's name reaches the prompt, so a session reads the file itself.
  [ -f "$DATA/$BRIEF" ] || refuse "$SHOWN/$BRIEF is not a file"
  # A brief filled from its role's template (new-reviewer.md for a reviewer) keeps none of that template's slots, so a session never starts on a bare slot, while a brief's prose about another role's slot is left alone.
  template="$REPO/scripts/briefs/new-${ROLE:-}.md"
  slots=$([ ! -f "$template" ] || grep -oE '__[A-Z0-9]+__' "$template" | sort -u || true)
  left=$([ -z "$slots" ] || grep -oE '__[A-Z0-9]+__' "$DATA/$BRIEF" | sort -u | grep -Fx -f <(printf '%s\n' "$slots") | paste -sd ' ' - || true)
  [ -z "$left" ] || refuse "$SHOWN/$BRIEF still holds the slot $left: fill each one, read the brief back, then run spawn.sh again (playbook's SESSIONS.md, the fill rule)"
fi
# A resume runs the session the way its start recorded; only a start takes a backend fresh.
PIN_GIVEN=
if [ "$MODE" = resume ]; then
  if [ -e "$PINS/$NAME" ]; then
    [ -z "$BACKEND$HARNESS" ] || refuse "the pin decides how $NAME runs; --backend or --harness would change it mid-life. Close it and start it again instead."
    pin=$(cat "$PINS/$NAME") || refuse "it cannot read the backend pin for $NAME"
    # Its words, one space apart, as readPin() reads them, so a hand edit's spacing changes nothing.
    read -ra pin_words <<<"$pin" || true
    pin=${pin_words[*]+"${pin_words[*]}"}
    # A pin names its harness, then its backend (HARNESSES in packages/settings/src/harnesses.ts); one written before the harness split names its backend alone.
    case "$pin" in
      glm | "claude-code glm") BACKEND=glm ;;
      claude | "claude-code claude") ;;
      "codex openai") HARNESS=codex ;;
      *) refuse "the backend pin for $NAME reads none of claude-code claude, claude-code glm, codex openai, glm or claude: it cannot know how $NAME ran. Fix or remove $SHOWN/backends/$NAME, then resume." ;;
    esac
  elif [ -n "$BACKEND$HARNESS" ]; then
    PIN_GIVEN=1
  else
    if [ "$ROLE" = reviewer ] || [ "$ROLE" = tester ]; then
      refuse "no backend pin for $NAME: it cannot know how $NAME ran. Resume it with --backend claude, which records the pin."
    fi
    refuse "no backend pin for $NAME: it cannot know how $NAME ran. Resume it with --backend glm or --backend claude, whichever it ran on, which records the pin."
  fi
fi
# Codex runs the first dispatcher alone, on the one login its CODEX_HOME holds, with the model and effort its own config names.
if [ "$HARNESS" = codex ]; then
  { [ -n "$FIRST" ] && [[ $MODE =~ ^(manager|resume)$ ]]; } || refuse "Codex runs the first dispatcher alone, in a workspace of its own (spawn.sh manager $(dispatcher_of 1) <brief> --harness codex), not $NAME"
  [ -z "$BACKEND$ACCOUNT$CLAUDE_MODEL$EFFORT" ] || refuse "Codex runs on the login and model its CODEX_HOME holds, so it takes no --backend, --account, --model or --effort"
  # A Codex session runs only on a scratch data folder until phase 3 of the harness layer lifts this, once a live probe has passed.
  # The live data folder is the one dataDir() gives with no PLAYGROUND_DATA_DIR set.
  live=$(cd / && env $UNSET -u PLAYGROUND_DATA_DIR "$BUN" --no-env-file -e "import { dataDir } from '$REPO/packages/env/src/data-dir.ts'; console.log(dataDir())") || refuse "bun could not resolve the live data folder"
  [ "$(cd -P "$DATA" 2>/dev/null && pwd -P)" != "$(cd -P "$live" 2>/dev/null && pwd -P)" ] ||
    refuse "Codex starts only on a scratch data folder (PLAYGROUND_DATA_DIR naming one) until phase 3 of the harness layer (the plan-harness-layer doc) lifts that, once a live probe has passed, and $SHOWN is the live one"
fi
# Every start and resume runs in herdr, the one runtime: a resume reads no pin, and the write below rewrites it whatever word it held.
RUNTIMES="$DATA/runtimes"
case "${RUNTIME:=herdr}" in
  herdr) ;;
  *) refuse "--runtime takes herdr, not $RUNTIME" ;;
esac
# the Keychain service each account's long-lived token is kept under: usage.keychainService, else its default when the reader cannot answer
KEYCHAIN=$(setting_text usage.keychainService)
KEYCHAIN=${KEYCHAIN:-playground-claude-oauth}
# Whether --account names the login the launch runs on with no --account, read from its config.
own_login() {
  python3 -I - "$(own_config)" "$ACCOUNT" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        email = (json.load(f).get("oauthAccount") or {}).get("emailAddress")
except Exception:
    sys.exit(1)
sys.exit(0 if isinstance(email, str) and email.lower() == sys.argv[2].lower() else 1)
PY
}
# An --account, or the login the usage gate picks for a bare spawn, is a second login whose Keychain item exists.
check_account() {
  # The email goes into the pane's command, so it is a plain local@domain: no quote, space or $.
  [[ $ACCOUNT =~ ^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]] || refuse "--account takes a plain email, not $ACCOUNT"
  ! own_login || refuse "--account $ACCOUNT is this machine's own Claude login, whose usage the session would share unchecked: name a second account"
  # Only that the item exists: no -w, so the token is never read here.
  security find-generic-password -s "$KEYCHAIN" -a "$ACCOUNT" >/dev/null 2>&1 ||
    refuse "the Keychain holds no $KEYCHAIN item for $ACCOUNT"
}
# --account naming this machine's own login starts on it with no token, as a bare start does, its usage judged by that login's reading and the split skipped.
OWN_LOGIN=
if [ -n "$ACCOUNT" ] && [ "$BACKEND" != glm ] && own_login; then
  OWN_LOGIN=$ACCOUNT
  ACCOUNT=
fi
# --account names a GLM row's label on a GLM start, checked in its block below.
[ -z "$ACCOUNT" ] || [ "$BACKEND" = glm ] || check_account
if [ -n "$BACKEND" ]; then
  case "$BACKEND" in
    glm | claude) ;;
    *) refuse "--backend takes glm or claude, not $BACKEND" ;;
  esac
  # A checker's verdict gates a merge, so it stays on Claude.
  case "$ROLE" in reviewer | tester) [ "$BACKEND" = glm ] && refuse "a $ROLE runs on Claude, so it takes no --backend glm" ;; esac
fi
# Inbox #i520: the second dispatcher (a manager start, a dispatcher's name with -2, or a roster slot of 2) never shares the first's login, so it keeps answering when the first runs out.
if [ "$KIND" = dispatcher ] && { { [ "$MODE" = manager ] && [ -z "$FIRST" ]; } || second_dispatcher "$NAME" || [ "$(roster_field "$NAME" slot)" = 2 ]; } && [ "$BACKEND" != glm ] && [ -z "$ACCOUNT" ]; then
  refuse "$NAME, the second dispatcher, runs on --backend glm, or on Claude with --account <email>, a second account: on this machine's own login it would run out with the first"
fi
case "${EFFORT:-high}" in
  low | medium | high | xhigh | max) ;;
  *) refuse "--effort takes low, medium, high, xhigh or max, not $EFFORT" ;;
esac
[ -z "$CLAUDE_MODEL" ] || case " $CLAUDE_MODELS " in
  *" $CLAUDE_MODEL "*) ;;
  *) refuse "--model takes $MODELS, not $CLAUDE_MODEL" ;;
esac
# A checker's verdict gates a merge, so it stays on Opus, as it stays on Claude.
case "$ROLE" in
  reviewer | tester) [ -z "$CLAUDE_MODEL" ] || [ "$CLAUDE_MODEL" = "$CHECKER_MODEL" ] ||
    refuse "a $ROLE runs on $CHECKER_MODEL, since its verdict gates a merge, so it takes no --model $CLAUDE_MODEL" ;;
esac
if [ "$BACKEND" = glm ]; then
  # The GLM launch maps every model Claude Code asks for to GLM, so a Claude model asked for here would never run; a resume reads glm from its pin first.
  [ -z "$CLAUDE_MODEL" ] || refuse "a session on GLM takes no --model: GLM maps every model itself"
  # No guarded org's data reaches GLM: a session in a folder named for an org ext.links guards, or on a brief naming a word glm-refused-sources lists, runs on Claude.
  # A failed read of the guarded orgs refuses.
  orgs=$( (cd / && env $UNSET "$BUN" --no-env-file "$REPO/packages/scripts/src/playground/setting.ts" --guarded-orgs) 2>&1) ||
    refuse "it cannot read the orgs ext.links guards, so it cannot tell a guarded org's checkout: $orgs"
  origin=$(git -C "${DIR:-/}" remote get-url origin 2>/dev/null) || origin=
  # A guarded org, as a folder on the session's path or as the owner of that folder's GitHub origin, in any case.
  org=$(python3 -I -c 'import json, re, sys; parts = sys.argv[1].lower().split("/"); m = re.search(r"github\.com[:/]([\w.-]+)/", sys.argv[3]); owner = m.group(1).lower() if m else ""; print(next((o for o in json.loads(sys.argv[2]) if o in parts or o == owner), ""))' "${DIR:-}" "$orgs" "$origin") || refuse "it cannot read the orgs ext.links guards"
  [ -z "$org" ] || refuse "$NAME runs in a checkout of $org, an org ext.links guards, so it runs on Claude: start it with --backend claude, closing a GLM-pinned session first"
  if [ -n "${BRIEF:-}" ]; then
    words=$(guard_list glm-refused-sources 2>&1) || refuse "$words"
    named=$(python3 -I -c 'import json, sys; text = open(sys.argv[1], encoding="utf-8", errors="replace").read().lower(); print(next((w for w in json.loads(sys.argv[2]) if w and w.lower() in text), ""))' "$DATA/$BRIEF" "$words") || refuse "it cannot read $SHOWN/$BRIEF for glm-refused-sources' words"
    [ -z "$named" ] || refuse "$BRIEF names $named, a source glm-refused-sources keeps off GLM, so it runs on Claude: start it with --backend claude, closing a GLM-pinned session first"
  fi
  # The GLM key is a usage.accounts row of provider glm: the one --account labels, else the first; ACCOUNT then empties, since it names a Claude login everywhere below.
  GLM_LABELS=$(setting usage.accounts | python3 -I -c 'import json, sys; [print(a["label"]) for a in json.load(sys.stdin) if a.get("provider") == "glm"]' 2>/dev/null) || GLM_LABELS=
  if [ -n "$ACCOUNT" ]; then
    grep -qxF -- "$ACCOUNT" <<<"$GLM_LABELS" || refuse "--account $ACCOUNT labels no GLM row in usage.accounts${GLM_LABELS:+, which lists $(echo $GLM_LABELS)}"
    GLM_ACCOUNT=$ACCOUNT GLM_GIVEN=$ACCOUNT ACCOUNT=
  else
    GLM_ACCOUNT=$(head -n 1 <<<"$GLM_LABELS") GLM_GIVEN=
    [ -n "$GLM_ACCOUNT" ] || refuse "usage.accounts lists no GLM key: add one with playground accounts add --provider glm --label <label>"
  fi
  security find-generic-password -s "$GLM_KEYCHAIN" -a "$GLM_ACCOUNT" >/dev/null 2>&1 ||
    refuse "the Keychain holds no $GLM_KEYCHAIN item for $GLM_ACCOUNT"
fi

holders=$(live_holders "$NAME") || refuse "it cannot read the live sessions in $REGISTRY"
taken=$(tail -n 1 <<<"$holders" | cut -f 1)
# Claude Code gives a session whose name is taken a generated one, while the roster would still point at the old session.
# It exits 3, so restore tells a live session, which it leaves as it is, from a resume that failed.
[ -z "$taken" ] || [ -n "$CHECK" ] ||
  REFUSE_CODE=3 refuse "a live session already holds the name $NAME (pid $taken), so the new one would start under a generated name. A respawned session takes the name only once the old session is gone: close it first (its handoff written, SESSIONS.md End), then run this again."
# restore's resume leaves a down row down, since a close ends the row before its pane closes: it reads the row once the session is gone and again just before the launch, exiting 4 on a down row, which restore prints as skipped, and its roster write keeps ended (write_row) for a close that lands after that.
restoring_row_down() {
  [ "$MODE" = resume ] && [ -n "${SPAWN_RESTORING:-}" ] || return 1
  row_status=$(roster_field "$NAME" status)
  case "$row_status" in done | ended | parked | paused) return 0 ;; esac
  return 1
}
! restoring_row_down || REFUSE_CODE=4 refuse "its roster row reads $row_status"
# The item's size and its load units: --size, else small for a checker, a short read run-slot.sh knows no name for, else the roster and plan.json through run-slot.sh's own reader
[ -n "$SIZE" ] || case "$ROLE" in reviewer | tester) SIZE=small ;; esac
case "$SIZE" in
  small) ITEM="small 1" ;; medium) ITEM="medium 2" ;; big) ITEM="big 3" ;;
  *) ITEM=$(bash "$REPO/scripts/ops/run-slot.sh" size "$NAME" 2>/dev/null) || ITEM= ;;
esac
case "$ITEM" in "small 1" | "medium 2" | "big 3") ;; *) ITEM="medium 2" ;; esac
PRIORITY_FILE=
if [ -n "$PRIORITY" ]; then
  PRIORITY_FILE=$(priority_file) || refuse "--priority starts only while a priority file stands in $DATA (priority.json, priority-start.json or another priority-<name>.json), and none does: playground priority on <session> --reason \"<why>\" opens one, on the owner's or the dispatcher's word"
fi
# A resume within 15 minutes of spawn.sh closing its row while it read live (not ended, parked, paused or done) passes the load gate, as a Claude Code update's close and resume do, since that session already counts in the load it comes back into; a new start, an older close and a close of a row that read otherwise meet it.
JUST_CLOSED=
if [ "$MODE" = resume ] && [ -f "$DATA/closes/$NAME" ] && read -r closed_at closed_iso closed_was < "$DATA/closes/$NAME"; then
  case "${closed_was:-none}" in
    none | ended | parked | paused | done) ;;
    *) if [[ $closed_at =~ ^[0-9]+$ ]] && age=$(($(date -u +%s) - closed_at)) && [ "$age" -ge 0 ] && [ "$age" -le 900 ]; then JUST_CLOSED="its $closed_was row closed at $closed_iso"; fi ;;
  esac
fi
# While focus stands (playground focus), one session has the Mac, so a start waits for its end, but for that session's own reviewer and tester and a --priority start on any priority file (below).
if FOCUS=$(python3 -I - "$DATA/focus.json" <<'PY' 2>/dev/null
import datetime, json, sys
try:
    f = json.load(open(sys.argv[1]))
    until = datetime.datetime.fromisoformat(f["until"].replace("Z", "+00:00"))
except Exception:
    sys.exit(1)
if until <= datetime.datetime.now(datetime.timezone.utc):
    sys.exit(1)
print(f"{f.get('session')} until {f['until']}")
PY
); then
  # the focused session's own reviewer and tester start, the one a column reports to or a resume's roster row serves, so an urgent fix is still checked, and a --priority start goes on while any priority file stands, a job's own start file included, since no gate but the machine's own delays a job's ticket start
  [ -n "$PRIORITY_FILE" ] || case "$ROLE" in reviewer | tester) [ "${TO:-${serves:-}}" = "${FOCUS%% until *}" ] ;; *) false ;; esac ||
    refuse "focus stands for $FOCUS, so no new session starts until it ends but its own reviewer and tester (playground focus off ends it)"
fi
# With no id, Claude's resume picker looks the name up only in the transcripts of the folder it starts in (its project folder, named from the folder's real path), so in a folder the session never ran in it finds nothing and the launch waits out its timeout; that check reads every transcript there, so the gate reads first as --check does, logging no start, and the gate proper runs after it.
if [ -n "$NAME_PROJECT" ]; then
  (CHECK=1 && gate_capacity) > /dev/null || exit $?
  grep -l -m 1 -F -e "\"customTitle\":\"$NAME\"" -e "\"agentName\":\"$NAME\"" "$NAME_PROJECT"/*.jsonl > /dev/null 2>&1 ||
    refuse "no session named $NAME ran in $DIR, so Claude's resume picker would find nothing there: pass its session id, or resume it in the folder it ran in"
fi
gate_capacity
# Codex runs on the login its CODEX_HOME holds, so a Claude login the usage gate picked stays off its launch.
if [ "$HARNESS" = codex ]; then ACCOUNT= PICKED=; fi
if [ "$RUNTIME" = herdr ]; then
  # herdr names an agent by [a-z][a-z0-9_-]{0,31}, so a longer name could never name the session's agent there.
  [ "${#NAME}" -le 32 ] || refuse "herdr names an agent with at most 32 characters, and $NAME has ${#NAME}"
  herdr_ready "${PLAYGROUND_HERDR_SESSION:-${DESK_HERDR_SESSION:-playground}}"
fi
if [ -n "$CHECK" ]; then
  echo "ok: $NAME can start"
  exit 0
fi
# The auto-memory trial's arm, by role, as ADR 0022 holds; a fresh worker's turn is written once its roster write runs, so a refused start takes no turn.
MEMORY=off
ARM=
if [ -n "$MEMORY_DIR" ]; then
  MEMORY=on
elif [ -z "$MEMORY_OFF" ] && [ "$BACKEND" != glm ]; then
  case "$ROLE:$KIND" in
    dispatcher:* | lead:builder | lead:ops | lead:planner)
      # a resume keeps a row --memory off left off, as a worker's keeps its arm
      if [ "$MODE" != resume ] || [ "$(roster_field "$NAME" memory)" != off ]; then
        MEMORY=on MEMORY_DIR="$DATA/memory/$KIND"
      fi
      ;;
    worker:*)
      if [ "$MODE" = resume ]; then
        [ "$(roster_field "$NAME" memory)" = on ] && MEMORY=on
      else
        ARM="$DATA/memory/worker-arm"
        [ "$(cat "$ARM" 2>/dev/null)" = off ] && MEMORY=on
      fi
      [ "$MEMORY" = on ] && MEMORY_DIR="$DATA/memory/worker-b"
      ;;
  esac
fi
# A session moved off the Desktop folder keeps its transcript in that folder's project, so it is copied to the new folder's, where --resume looks.
if [ -n "${FROM:-}" ] && [[ $SESSION =~ ^[0-9a-f-]{36}$ ]]; then
  old="$(project_of "$FROM")/$SESSION.jsonl"
  new=$(project_of "$(cd -P "$DIR" && pwd -P)")
  if [ ! -e "$new/$SESSION.jsonl" ] && [ -e "$old" ]; then
    { mkdir -p "$new" && cp -p "$old" "$new/"; } || refuse "it cannot copy $SESSION's transcript into $new"
  fi
fi

# A data folder PLAYGROUND_DATA_DIR named goes into the session's environment, so its hooks read the folder this launch wrote.
CARRY=; [ -n "${PLAYGROUND_DATA_DIR:-}" ] && CARRY="PLAYGROUND_DATA_DIR=$(printf %q "$DATA") "
LAUNCH="env ${UNSET}${CARRY}PLAYGROUND_ROLE=$ROLE claude"
# Single quotes keep the lookup as text, so the pane's own shell reads the token, never into an argv, this script's output or the roster; the pane stops on an empty one before claude runs.
[ -n "$ACCOUNT" ] && LAUNCH='tk="$(security find-generic-password -s '"$KEYCHAIN"' -a '"$ACCOUNT"' -w)" || exit 1; [ -n "$tk" ] || { echo "The '"$KEYCHAIN"' item for '"$ACCOUNT"' holds an empty token; save it again with security add-generic-password -s '"$KEYCHAIN"' -a '"$ACCOUNT"' -w, then respawn." >&2; exit 1; }; CLAUDE_CODE_OAUTH_TOKEN="$tk" '"$LAUNCH"
MODEL=${CLAUDE_MODEL:-$DEFAULT_MODEL}
case "$ROLE" in reviewer | tester) MODEL=$CHECKER_MODEL ;; esac
GLM_MODEL="'$GLM_ID[1m]'"
if [ "$BACKEND" = glm ]; then
  # Every model Claude Code asks for (a subagent's, the small fast one) goes to GLM, so nothing falls back to a Claude login. Flash carries 3x the plan's quota of glm-5.3 (Z.ai), and the Max plan's 28k credits per 5h burned to empty in one morning on glm-5.3 (16 Oct), so flash it is. The [1m] suffix gives Claude Code GLM's 1M window: without it Claude Code takes an unknown model's small default, and a session that loads the factory's rules compacts over and over (16 Oct). It compacts in the factory's one window, as a Claude session does (below). Claude Code turns tool search off for a base URL that is not Anthropic's, so every MCP tool's schema would load at start, 230k on this machine (measured, 16 Oct); ENABLE_TOOL_SEARCH=true defers them again, to 58k at start, and GLM loads and calls a deferred tool (measured). The quotes keep zsh from reading the brackets as a glob.
  LAUNCH='tk="$(security find-generic-password -s '"$GLM_KEYCHAIN"' -a '"$GLM_ACCOUNT"' -w)" || exit 1; [ -n "$tk" ] || { echo "The '"$GLM_KEYCHAIN"' item for '"$GLM_ACCOUNT"' holds an empty token; save it again with playground accounts add --provider glm --label '"$GLM_ACCOUNT"', then respawn." >&2; exit 1; }; ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic ANTHROPIC_AUTH_TOKEN="$tk" ANTHROPIC_DEFAULT_OPUS_MODEL='"$GLM_MODEL"' ANTHROPIC_DEFAULT_SONNET_MODEL='"$GLM_MODEL"' ANTHROPIC_DEFAULT_HAIKU_MODEL='"$GLM_ID"' ENABLE_TOOL_SEARCH=true '"$LAUNCH"
  MODEL=$GLM_MODEL
fi
# Every kind compacts in one window, context.window (400k by default), GLM's included, the window the factory's settings give a session spawn.sh did not start; it was read with the model settings above.
# The window reaches the session through its one settings file, built here from the factory's on every launch so the two never drift, one file per backend. On GLM: the user settings may turn on telemetry to an org's usage collector, which counts Claude usage alone, so a GLM session exports none. Claude Code keeps only the last --settings, and the user settings' env beats a variable on the launch line (both measured by a reviewer, 16 Oct), so the session's one settings file also turns the telemetry off (measured from a folder outside any checkout, 16 Oct: a SessionStart hook ran, no-env-dump refused printenv, and no metric left).
TAG=
[ "$BACKEND" = glm ] && TAG=glm-
# A probe runs its shell commands in Claude Code's sandbox, which every child process inherits, so a delete a script makes where no guard hook sees it stays inside the write roots; its settings go in a file of their own. Workers and testers join once the worker git flow runs inside it, as run-slot and spawn.sh do.
SANDBOX=
[ "$ROLE" = probe ] && SANDBOX=sandbox-
# A manager hands every build, read or research to a worker session (playbook's **workers**), so its file of its own denies the Agent and Workflow tools, which a bare deny takes out of its tools; every other session keeps both, a reviewer's code-review sub-agents among them.
MANAGER=
case "$ROLE" in dispatcher | lead) MANAGER=manager- ;; esac
BUILT="$DATA/factory-settings-$TAG$MANAGER$SANDBOX$((WINDOW / 1000))k.json"
# A --memory launch builds a file of its own, so the shared one every other session reads keeps the factory's memory off.
[ -n "$MEMORY_DIR" ] && BUILT="$DATA/factory-settings-$TAG$SANDBOX$((WINDOW / 1000))k-memory-$NAME.json"
# The folder the session runs in, as the launch below moves to it.
OWN=${DIR:-$REPO}
[ "$MODE" = column ] && OWN=$REPO
python3 -I - "$SETTINGS" "$BUILT" "$WINDOW" "$BACKEND" "$SANDBOX" "$DATA" "$HERDR_DIR" "$MAIN" "$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null)" "$OWN" "$MEMORY_DIR" "$MANAGER" <<'PY' || refuse "it cannot build $BUILT from $SETTINGS"
import json, os, sys
src, dst, window, backend, sandbox, data, herdr, main, temp, own, memory, manager = sys.argv[1:13]
settings = json.load(open(src))
settings["autoCompactWindow"] = int(window)
if manager:
    permissions = settings.get("permissions", {})
    settings["permissions"] = {**permissions, "deny": sorted({*permissions.get("deny", []), "Agent", "Workflow"})}
# The home skill set link-skills.sh turns on at user scope stays off here, since the session loads its own set (below) and two plugins that ship one name refuse it at call time.
settings["enabledPlugins"] = {**settings.get("enabledPlugins", {}), "ws-home@ws": False}
if backend == "glm":
    settings["env"] = {**settings.get("env", {}), "CLAUDE_CODE_ENABLE_TELEMETRY": "0", "OTEL_METRICS_EXPORTER": "none"}
if sandbox:
    # The sandbox lets a session write its own folder, the main checkout or a worktree in it; a deny wins over that, so every entry of the main checkout is denied, .git and every other worktree included, but the path down to a worktree the session runs in.
    own = os.path.realpath(own)
    def denied(folder):
        paths = [os.path.join(folder, name) for name in sorted(os.listdir(folder))]
        return [d for p in paths if p != own for d in (denied(p) if own.startswith(p + os.sep) else [p])]
    deny = denied(main)
    home = os.path.expanduser("~")
    settings["sandbox"] = {
        # Bypass mode would run the unsandboxed retry with no prompt, and a sandbox that cannot start would run every command unsandboxed.
        "allowUnsandboxedCommands": False,
        "enabled": True,
        # gh, a Go CLI, verifies TLS through trustd, which the sandbox closes without this.
        "enableWeakerNetworkIsolation": True,
        # Docker cannot run in the sandbox, and a wildcard in an exclusion spans arguments, so only the read-only listing leaves it when typed; a script's own docker stays inside, its socket closed.
        "excludedCommands": ["docker ps", "docker ps *"],
        "failIfUnavailable": True,
        "filesystem": {
            "allowWrite": sorted({data, os.path.join(home, ".agent-browser"), os.path.join(home, ".bun", "install", "cache"), os.path.join(home, ".cache", "turbo"), os.path.join(home, ".portless")} | ({temp.rstrip("/")} if temp else set())),
            "denyWrite": deny,
        },
        "network": {"allowLocalBinding": True, "allowUnixSockets": sorted({herdr, os.path.join(home, ".agent-browser")})},
    }
if memory:
    settings["autoMemoryEnabled"] = True
    settings["autoMemoryDirectory"] = memory
tmp = f"{dst}.{os.getpid()}.tmp"
with open(tmp, "w") as f:
    json.dump(settings, f, indent=2)
os.replace(tmp, dst)
PY
SETTINGS=$BUILT
# The factory's sessions run in bypass mode, passed here so it never rests on the machine's own settings: a session in another mode holds every cross-session message for approval.
FLAGS="--model $MODEL --effort ${EFFORT:-high} --settings $SETTINGS --dangerously-skip-permissions"
# The skills: one merged plugin per session, from the login's scope, its repo's org, core, then each always org's new names, less each skill whose SKILL.md its checkout's .claude/skills already holds byte for byte, loaded in place by --plugin-dir, from the data folder this launch reads (under inscope ~/.claude's, not the workspace's); the resolver writes it fresh on every spawn, so a skill `playground ext add` puts in an extension reaches the next session with no install. A column runs in this checkout.
SKILLS_REPO=$OWN
PLUGIN=$(PLAYGROUND_DATA_DIR="$DATA" "$BUN" --no-env-file "$REPO/packages/scripts/src/playground/orgs.ts" resolve --repo "$SKILLS_REPO") && [ -d "$PLUGIN" ] || refuse "playground orgs resolve gave no skill plugin for $SKILLS_REPO"
FLAGS+=" --plugin-dir $(printf %q "$PLUGIN")"
READ="Load the playbook skill first. Your brief is in $SHOWN/$BRIEF: read it in full and follow it."
# Two GLM workers searched ToolSearch for Read, Bash and Skill, found none since it lists only deferred tools, and stopped as if they had none.
[ "$BACKEND" = glm ] && READ="$READ Skill, Read, Bash, Edit and Write are already loaded; ToolSearch lists only deferred tools."
# A herdr start names its session id up front, so its resume record can resume exactly that session.
SID=${SESSION:-}
if [ "$RUNTIME" = herdr ] && [ "$MODE" != resume ]; then
  SID=$(uuidgen | tr 'A-F' 'a-f') || refuse "it cannot make a session id (uuidgen)"
fi
FRESH=
if [ "$MODE" = resume ]; then
  COMMAND="$LAUNCH --resume $SESSION -n $NAME $FLAGS"
  PROMPT=
  # A herdr session that never took a message has no transcript, so --resume finds no conversation, while --session-id refuses an id that has one (both measured on claude in herdr): it starts afresh under its own id and name, with the prompt its start recorded.
  # A Codex thread that never wrote its rollout has nothing to resume either, so it starts afresh the same way, under the thread its new beat names.
  saved=$(find "$PROJECTS" -mindepth 2 -maxdepth 2 -name "$SESSION.jsonl" -print -quit 2>/dev/null) || saved=
  if [ "$HARNESS" = codex ]; then saved=$(find "$DATA/codex/sessions" -name "rollout-*-$SESSION.jsonl" -print -quit 2>/dev/null) || saved=; fi
  if [ "$RUNTIME" = herdr ] && [[ $SESSION =~ ^[0-9a-f-]{36}$ ]] && [ -z "$saved" ]; then
    FRESH=1
    COMMAND="$LAUNCH --session-id $SESSION -n $NAME $FLAGS"
    PROMPT=$(cat "$RESUME_DIR/$NAME.prompt" 2>/dev/null) || PROMPT=
    # The prompt goes into the launch inside double quotes, so a quote, $, backquote or backslash would end or run them.
    if [[ $PROMPT == *[\"\$\`\\]* || $PROMPT == *$'\n'* ]]; then
      echo "spawn.sh: $NAME starts afresh without its prompt, since its recorded prompt holds a quote, \$, backquote or backslash" >&2
      PROMPT=
    fi
  else
    # Whom it reports to, by scripts/README.md's order, so the re-sends reach the right session; a value that is not a session name would break the launch's quotes.
    if [[ $ROLE =~ ^(reviewer|tester)$ ]]; then
      UP=$(roster_field "$NAME" worker)
    else
      UP=$(roster_field "$NAME" reportsTo)
      word "$UP" || UP=$(roster_field "$NAME" lead)
    fi
    word "$UP" || UP=$(sed -n 's/.*; you report to \([A-Za-z0-9-]*\)\..*/\1/p' "$RESUME_DIR/$NAME.prompt" 2>/dev/null | head -1) || UP=
    # A session idle at the restart takes no turn, so it would never act on after-resume's context.
    PROMPT="You are $NAME, resumed after a restart${UP:+; you report to $UP}. Act on the after-resume instruction in your context first, then carry on."
  fi
  [ -z "$BRIEF" ] || PROMPT="You are $NAME, resumed. $READ"
  [ -z "$PROMPT" ] || COMMAND="$COMMAND \"$PROMPT\""
else
  BINDS=
  [ "$ROLE" = worker ] && [ "$BACKEND" != glm ] && [ -f "$DATA/brief-rush.md" ] && BINDS=" $SHOWN/brief-rush.md binds you too, on this Claude lane."
  WHO="a $ROLE in the Playground factory; you report to $TO"
  REPORT=" Report to $TO with SendMessage (to: $TO)."
  if [ "$ROLE" = dispatcher ]; then
    WHO="the Playground factory's dispatcher; $TO briefs you with a handoff"
    [ -z "$FIRST" ] || WHO="the Playground factory's dispatcher; you work with the owner, who talks to you here and in the Dashboard's chat"
    REPORT=
  fi
  PROMPT="You are $NAME, $WHO. $READ$BINDS$REPORT"
  COMMAND="$LAUNCH --session-id $SID -n $NAME $FLAGS \"$PROMPT\""
fi
# Codex's launch: its CODEX_HOME's files are written fresh each launch, and its hooks always run trusted, since a hook with no recorded trust is silently dropped (measured); the session id comes from the SessionStart beat its hook writes, read after the pane runs.
BEAT=
if [ "$HARNESS" = codex ]; then
  CODEX=$(command -v codex) || refuse "codex is not on PATH, so $NAME cannot start in Codex"
  CODEX_HOME="$DATA/codex"
  BEAT="$DATA/launch/$NAME.beat"
  mkdir -p "$CODEX_HOME/app-server-daemon" || refuse "it cannot prepare $CODEX_HOME"
  # The factory's guards as Codex loads them (packages/scripts/src/codex-hooks.ts), with the beat added below.
  GUARDS=$(cd / && env $UNSET "$BUN" --no-env-file "$REPO/packages/scripts/src/codex-hooks.ts" "$REPO/scripts/factory-settings.json") || refuse "it cannot render $CODEX_HOME's hooks.json from the factory's settings"
  python3 -I - "$CODEX_HOME" "$(cd -P "$OWN" && pwd -P)" "$GUARDS" <<'PY' || refuse "it cannot write $CODEX_HOME's config.toml and hooks.json"
import json, os, sys
home, folder, guards = sys.argv[1:4]
def write(name, text):
    tmp = os.path.join(home, f"{name}.{os.getpid()}.tmp")
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, os.path.join(home, name))
# The login stays in CODEX_HOME's auth.json, no update check or self-update runs mid-session, and the session's folder is trusted, so no prompt waits on the owner.
write("config.toml", f'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n\n[projects.{json.dumps(folder)}]\ntrust_level = "trusted"\n')
write(os.path.join("app-server-daemon", "settings.json"), json.dumps({"autoUpdateEnabled": False}) + "\n")
# The beat lands whole: written beside its path, then moved onto it, so the wait never reads half of it. A Codex start stops when PowerShell is installed, so the beat names a pwsh or powershell on PATH, or at /usr/local/bin/pwsh, where Codex also looks (shell_detect.rs, codex-cli 0.167.1), in place of the thread.
beat = {"hooks": [{"command": 'f="$SPAWN_CODEX_BEAT"; p=$(command -v pwsh || command -v powershell || { [ -x /usr/local/bin/pwsh ] && echo /usr/local/bin/pwsh; }); if [ -n "$p" ]; then printf \'{"powershell":"%s"}\\n\' "$p" > "$f.tmp"; else cat > "$f.tmp"; fi && mv "$f.tmp" "$f"', "timeout": 10, "type": "command"}], "matcher": ""}
hooks = json.loads(guards)
hooks.setdefault("SessionStart", []).append(beat)
write("hooks.json", json.dumps({"hooks": hooks}, indent=2) + "\n")
PY
  LAUNCH="env ${UNSET}${CARRY}PLAYGROUND_ROLE=$ROLE CODEX_HOME=$(printf %q "$CODEX_HOME") SPAWN_CODEX_BEAT=$(printf %q "$BEAT") $(printf %q "$CODEX")"
  if [ "$MODE" = resume ] && [ -z "$FRESH" ]; then
    COMMAND="$LAUNCH resume --dangerously-bypass-hook-trust $SESSION"
  else
    COMMAND="$LAUNCH --dangerously-bypass-hook-trust"
  fi
  [ -z "$PROMPT" ] || COMMAND="$COMMAND \"$PROMPT\""
fi
# The pane's shell runs this text, so the whole launch goes in a subshell: a failed Keychain read's exit ends only that, the message stays on the pane, and tk dies with it.
COMMAND="($COMMAND)"

# macOS types at most MAX_CANON 1024 bytes into a pane, and a GLM worker's launch line crosses it (1,025 bytes, measured), so the tail never arrives and the pane waits at >. The same text runs from a file instead: the typed line names the file alone, and the file, read by the pane's own shell, holds the Keychain lookup, never a token. Its first line removes the file, so no past launch outlives its pane to be rerun past this script's refusals.
LAUNCH_DIR="$DATA/launch"
mkdir -p "$LAUNCH_DIR" && chmod 700 "$LAUNCH_DIR" || refuse "it cannot prepare $LAUNCH_DIR"
LAUNCH_FILE="$LAUNCH_DIR/$NAME.sh"
[ -z "$BEAT" ] || rm -f -- "$BEAT"
# The factory's hooks read PLAYGROUND_REPO before the session's own folder, so the launch file's second line exports this script's main checkout: a session in a worktree, or outside any Playground checkout, runs the main checkout's guards.
HEAD_LINES=
if [ "$RUNTIME" = herdr ]; then
  CWD=${DIR:-}
  [ "$MODE" = column ] && CWD=$REPO
  mkdir -p "$RESUME_DIR" && chmod 700 "$RESUME_DIR" || refuse "it cannot prepare $RESUME_DIR"
  # A pane herdr restored keeps the folder it had, so the launch moves to the session's own; a resume stamps each run in <name>.ran, so you can see when a restore ran it.
  HEAD_LINES="cd $(printf %q "$CWD") || exit 1"$'\n'
  # A herdr server hands its panes the shell basics alone, so the launch gives the session the user's temp folder, keeping one already set.
  HEAD_LINES+='export TMPDIR="${TMPDIR:-$(getconf DARWIN_USER_TEMP_DIR)}"'$'\n'
  [ "$MODE" = resume ] && HEAD_LINES+="date -u +%FT%TZ >> $(printf %q "$RESUME_DIR/$NAME.ran")"$'\n'
fi
(umask 077 && printf 'rm -f -- "$0"\n%sexport PLAYGROUND_REPO=%q\n%s' "$HEAD_LINES" "$MAIN" "$COMMAND" > "$LAUNCH_FILE" && chmod 700 "$LAUNCH_FILE") ||
  refuse "it cannot write $LAUNCH_FILE"

# Claude's folder trust and MCP picker approve a folder in the owner's name, so spawn.sh answers them only under the two roots the owner trusts (#i502, #i503); anywhere else the prompt stays for the owner.
# herdr matches one screen row at a time, and a narrow column wraps each row, so the trust and ready patterns are each a part short enough for a narrow row to keep.
TRUST_RE='Yes, I trust'
# The pickers' own titles (Claude Code 2.1.319), since a REPL's status line can name an MCP server too: one server's, then several servers', which leads with their count.
MCP_RE='New MCP server found in this project|[0-9]+ new MCP servers found'
# Claude Code's mode mark leads its status line and survives the cut: 27 columns read "⏵⏵ bypass permissions" and 12 read "⏵⏵" (measured, 24 Oct).
READY_RE='⏵⏵'
# The servers an MCP picker's screen shows, one a line: the one server's name from its title, or each `[✔] <name>` row under several servers' title.
mcp_names() {
  hr pane read "$PANE" --source recent-unwrapped --lines 80 | python3 -I -c '
import re, sys
rows = sys.stdin.read().splitlines()
titles = [i for i, r in enumerate(rows) if re.search(r"New MCP server found in this project|[0-9]+ new MCP servers found", r)]
if not titles:
    sys.exit(1)
one = re.search(r"New MCP server found in this project: (.+?)\s*$", rows[titles[-1]])
if one:
    print(one.group(1))
    sys.exit(0)
for r in rows[titles[-1] + 1:]:
    row = re.search(r"\[[^\]]?\]\s*(\S.*?)\s*$", r)
    if row:
        print(row.group(1))
'
}
# The row the MCP picker's pointer marks, the last row after its title that leads with ❯.
mcp_focused() {
  hr pane read "$PANE" --source recent-unwrapped --lines 80 | python3 -I -c '
import re, sys
rows = sys.stdin.read().splitlines()
titles = [i for i, r in enumerate(rows) if re.search(r"New MCP server found in this project|[0-9]+ new MCP servers found", r)]
focused = [r for r in rows[titles[-1] + 1:] if r.lstrip().startswith("❯")] if titles else []
print(focused[-1].lstrip()[1:].strip() if focused else "")
'
}
# Why the picker is the owner's, printed, unless the names on stdin are $1 servers, each one of the factory's own MCP file, ~/.mcp.json, the only servers spawn.sh enables in the owner's name.
# Claude Code merges the .mcp.json of $CWD and of each folder above it but /, the nearest taking a name over, so another on that walk that defines a server leaves the picker to the owner; a plugin's server reads "<name> (from plugin <plugin>)", which no key matches.
mcp_factory_only() {
  python3 -I -c '
import json, os, sys
def stop(why):
    print(why)
    sys.exit(1)
factory = os.path.realpath(sys.argv[1])
try:
    servers = set(json.load(open(factory))["mcpServers"])
except Exception:
    stop(f"has no server list it can read in {sys.argv[1]}")
d = os.path.realpath(sys.argv[3])
while d != os.path.dirname(d):
    f = os.path.join(d, ".mcp.json")
    if os.path.lexists(f) and os.path.realpath(f) != factory:
        try:
            other = json.load(open(f)).get("mcpServers") or {}
        except Exception:
            other = None
        if other != {}:
            stop(f"also reads {f}")
    d = os.path.dirname(d)
names = set(sys.stdin.read().splitlines()) - {""}
if len(names) != int(sys.argv[2]) or not names <= servers:
    stop(f"lists a server from outside {sys.argv[1]}")' "$HOME/.mcp.json" "$1" "$CWD"
}
# The screens come in order (trust, then the MCP picker, then the REPL), so each wait looks only for what can still come and a screen already answered never matches twice. One key a request, since herdr drops part of several keys sent together.
herdr_answer() {
  local want="$TRUST_RE|$MCP_RE|$READY_RE" line k n names why target focused
  while :; do
    line=$(hr pane wait-output "$PANE" --regex "$want" --source visible --timeout 120000 |
      python3 -I -c 'import json, sys; print(json.load(sys.stdin)["result"]["matched_line"])' 2>/dev/null) ||
      { echo "spawn.sh: $NAME showed no REPL within 2 minutes; read it with herdr pane read $PANE" >&2; return 1; }
    if grep -q "$READY_RE" <<<"$line"; then
      return 0
    elif [[ $want == "$TRUST_RE|"* ]] && grep -q "$TRUST_RE" <<<"$line"; then
      trusted_root "$CWD" ||
        { echo "spawn.sh: $NAME waits at Claude's folder trust prompt for $CWD, outside $(code_root) and each org's folder, so it is the owner's to answer" >&2; return 1; }
      hr pane send-keys "$PANE" down >/dev/null && hr pane send-keys "$PANE" enter >/dev/null || return 1
      want="$MCP_RE|$READY_RE"
    elif [[ $want != "$READY_RE" ]] && grep -qE "$MCP_RE" <<<"$line"; then
      trusted_root "$CWD" ||
        { echo "spawn.sh: $NAME waits at Claude's MCP server picker for $CWD, outside $(code_root) and each org's folder, so it is the owner's to answer" >&2; return 1; }
      # Esc on either picker writes its servers to disabledMcpjsonServers, so the answer enables them, and only the factory's own: Claude Code drops keys in a picker's first 250 ms, so it waits first.
      sleep 0.5
      n=1
      [[ $line =~ ([0-9]+)\ new\ MCP\ servers ]] && n=${BASH_REMATCH[1]}
      names=$(mcp_names)
      # Several servers show five rows at a time, scrolled with the focus, so each move down reads the rows it brings in; a picker left before "Enable selected" writes nothing.
      for ((k = 1; k < n; k++)); do
        hr pane send-keys "$PANE" down >/dev/null || return 1
        sleep 0.2
        names+=$'\n'$(mcp_names)
      done
      why=$(mcp_factory_only "$n" <<<"$names") ||
        { echo "spawn.sh: $NAME waits at Claude's MCP server picker for $CWD, which $why, so it is the owner's to answer" >&2; return 1; }
      # Then "Enable selected", one row below the last server with all selected at the start, or one server's "Use this MCP server", two rows above the focused "Continue without".
      # herdr can drop a key, and Enter on "Use this and all future MCP servers" would trust every later .mcp.json of the folder unseen, so Enter goes only to the row the pointer marks as the one wanted.
      if [ "$n" -gt 1 ]; then
        hr pane send-keys "$PANE" down >/dev/null || return 1
        target="Enable selected"
      else
        hr pane send-keys "$PANE" up >/dev/null && hr pane send-keys "$PANE" up >/dev/null || return 1
        target="Use this MCP server"
      fi
      sleep 0.2
      focused=$(mcp_focused)
      [ "$focused" = "$target" ] ||
        { echo "spawn.sh: $NAME waits at Claude's MCP server picker for $CWD with \"${focused:-no row}\" marked where \"$target\" was wanted, so it is the owner's to answer" >&2; return 1; }
      hr pane send-keys "$PANE" enter >/dev/null || return 1
      want=$READY_RE
    else
      return 0
    fi
  done
}

# The roster row: a checker's is written before its pane opens, since no-outside-pr-code reads the PR it names at the session's first tool call, and every other row once its session has started.
write_row() {
  set -- set "$NAME" "kind=$KIND"
  # A resume, or a start that reuses an ended name, runs the session again, so a row close ended reads starting once more; a live row keeps its status, and so does restore's resume, whose row a close can end mid-launch.
  [ "$(roster_field "$NAME" status)" = ended ] && [ -z "${SPAWN_RESTORING:-}" ] && set -- "$@" "status=starting"
  # A checker's --pr replaces an ended row's prs, the PRs it last served, and its pr, which auto-end's merge check and the checker's write mode read, with the first pull request named; on a live row, or none, it joins prs, as assign does, and gives a row with no pr the first pull request named.
  if [ -n "$PR_ARG" ]; then
    first_pull=
    IFS=, read -ra prs_named <<<"$PR_ARG"
    for one in "${prs_named[@]}"; do
      if [[ $one =~ ^(#?[1-9][0-9]*|https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*)$ ]]; then
        first_pull=$one
        break
      fi
    done
    if [ "$(roster_field "$NAME" status)" = ended ]; then
      set -- "$@" "prs=$PR_ARG" "pr=$first_pull"
    else
      set -- "$@" "prs+=$PR_ARG"
      [ -n "$(roster_field "$NAME" pr)" ] || set -- "$@" "pr=$first_pull"
    fi
  fi
  # A second dispatcher started under an <id>-dispatcher name records its slot, which roster.ts who dispatcher 2 reads; a dispatcher's name with -2 holds slot 2 by its name.
  [ "$MODE" = manager ] && [ "$KIND" = dispatcher ] && [ -z "$FIRST" ] && ! second_dispatcher "$NAME" && set -- "$@" "slot=2"
  if [ "$MODE" = column ]; then
    [[ $ROLE =~ ^(reviewer|tester)$ ]] && { [ "$(kind_of_name "$TO")" = worker ] || [ "$(roster_kind "$TO")" = worker ]; } && set -- "$@" "worker=$TO"
  else
    # A worker or runner records whom it reports to, --reports-to's session or its lead's seat, which the Dashboard's tree and every escalation read; a resume keeps the row's.
    [[ $MODE =~ ^(worker|runner)$ ]] && set -- "$@" "reportsTo=$TO"
    # A session in a workspace of its own clears the roster surface a column's anchor left; its pane's label carries its name.
    set -- "$@" "surface="
  fi
  # set keeps an entry's work for a respawned session, and creates a new one.
  roster() { said=$(env $UNSET "$BUN" "$ROSTER" "$@" 2>&1 >/dev/null); }
  # An entry with no title shows its first ask as its sidebar row, so a new probe takes a words-only default, a new runner its name, and a respawned one keeps the title its entry already holds; a worker's or checker's title is TITLE_ARG, above.
  TITLE=
  if [ "$ROLE" = probe ]; then
    [[ $NAME == probe-* ]] && TITLE="Probe: ${NAME#probe-}" || TITLE="Probe of $TO"
  elif [ "$ROLE" = runner ]; then
    TITLE=$NAME
  fi
  # The dashboard drops an entry with no task, so a new one takes its brief's name, else its role and name; a respawned one keeps its own.
  if [ -n "$BRIEF" ]; then TASK=$BRIEF; else TASK="$ROLE $NAME"; fi
  held=$(python3 -I - "$NAME" "$ROSTER_JSON" <<'PY'
import json, sys
name, path = sys.argv[1], sys.argv[2]
filled = lambda entry, key: isinstance(entry.get(key), str) and entry[key] != ""
try:
    entry = next((a for a in json.load(open(path)).get("agents", []) if isinstance(a, dict) and a.get("name") == name), None)
    if not isinstance(entry, dict):
        print("00")
    else:
        print(("1" if entry.get("pr") or filled(entry, "title") else "0") + ("1" if entry.get("pr") or filled(entry, "task") else "0"))
except (OSError, ValueError):
    print("00")
PY
  ) || held=00
  [ -z "$TITLE" ] || [ "${held:0:1}" = 1 ] || set -- "$@" "title=$TITLE"
  [ -z "$TITLE_ARG" ] || set -- "$@" "title=$TITLE_ARG"
  [ "${held:1:1}" = 1 ] || set -- "$@" "task=$TASK"
  set -- "$@" "memory=$MEMORY"
  [ -z "${ARM:-}" ] || { mkdir -p "$DATA/memory" && printf '%s\n' "$MEMORY" > "$ARM"; } || echo "spawn.sh: $NAME $WHEN, but the memory trial's turn could not be written to $ARM" >&2
  said=
  if ! roster "$@"; then
    [ -n "$said" ] && echo "roster.ts says: $said" >&2
    # A checker's row is written before its pane opens, so a failed write refuses the start, its launch file removed as every later refusal removes it, since a row naming no PR would hold the checker in read mode.
    [ -z "$ROW_FIRST" ] || { rm -f -- "$LAUNCH_FILE"; refuse "its roster write failed before its pane opened, so its row may name no PR; record it with $BUN $ROSTER $*, then start it again"; }
    echo "spawn.sh: $NAME $WHEN, but its roster write failed; record it with $BUN $ROSTER $*" >&2
  fi
}
ROW_FIRST=
[[ $ROLE =~ ^(reviewer|tester)$ ]] && ROW_FIRST=1
[ -z "$ROW_FIRST" ] || WHEN="is starting" write_row

if [ "$RUNTIME" = herdr ]; then
  # A restarted server brings each pane back as a shell under its label, so a resume reopens the session in the pane that held it, while it holds no agent; the live-name check above has already refused a live session.
  placed=
  if [ "$MODE" = resume ]; then
    # A list herdr will not give leaves placed empty, so the session opens in a workspace of its own rather than ending the script under set -e.
    placed=$(hr pane list 2>/dev/null | python3 -I -c 'import json, sys
try:
    for pane in json.load(sys.stdin)["result"]["panes"]:
        if pane.get("label") == sys.argv[1] and pane.get("agent_status", "unknown") == "unknown" and "agent" not in pane:
            print(pane["pane_id"], pane["workspace_id"])
            break
except (ValueError, KeyError, TypeError):
    pass' "$NAME" || true)
  fi
  out=reused
  # herdr says why it refused on stderr, kept apart from the JSON it answers with, so a refusal names herdr's own words.
  said_file="$LAUNCH_DIR/$NAME.herdr"
  if ! { : > "$said_file"; } 2>/dev/null; then
    rm -f -- "$LAUNCH_FILE"
    refuse "it cannot write $said_file, so nothing was started and no pin was written"
  fi
  if [ -z "$placed" ]; then
    if [ "$MODE" = column ]; then
      out=$(hr pane split "$SURFACE" --direction right --cwd "$REPO" --no-focus 2>>"$said_file" || true)
    else
      out=$(hr workspace create --cwd "$DIR" --label "$NAME" --no-focus 2>>"$said_file" || true)
    fi
    placed=$(python3 -I -c 'import json, sys
try:
    r = json.load(sys.stdin)["result"]
    pane = r.get("root_pane") or r.get("pane")
    print(pane["pane_id"], pane["workspace_id"])
except (ValueError, KeyError, TypeError):
    pass' <<<"$out" || true)
  fi
  PANE=${placed% *} ws=${placed#* }
  if restoring_row_down; then
    rm -f -- "$LAUNCH_FILE" "$said_file"
    [ -z "$placed" ] || [ "$out" = reused ] || hr pane close "$PANE" >/dev/null 2>&1 || true
    REFUSE_CODE=4 refuse "its roster row reads $row_status"
  fi
  # herdr clears an agent's name after every turn (measured), while a pane's label stays and comes back after a restart, so the label carries the name.
  if [ -z "$placed" ] || ! hr pane rename "$PANE" "$NAME" >/dev/null 2>>"$said_file" || ! hr pane run "$PANE" "exec bash '$LAUNCH_FILE'" >/dev/null 2>>"$said_file"; then
    herdr_said=$(tr -s '\n' ' ' 2>/dev/null <"$said_file" || true)
    herdr_said=${herdr_said% }
    rm -f -- "$LAUNCH_FILE" "$said_file"
    [ -z "$placed" ] || [ "$out" = reused ] || hr pane close "$PANE" >/dev/null 2>&1 || true
    # A placed or reused pane's answer is JSON or `reused`, never why, so with herdr silent it names the pane herdr would not use.
    [ -z "$placed" ] || out="herdr would not label pane $PANE or run the launch in it"
    refuse "herdr opened no session for $NAME (${herdr_said:-${out:-no answer from herdr}}), so nothing was started and no pin was written"
  fi
  rm -f -- "$said_file"
  echo "herdr pane $PANE workspace $ws"
  # Codex fails closed: the beat its SessionStart hook writes proves its hooks loaded, and names its thread, so a session with none is stopped within 60 seconds of its start.
  if [ "$HARNESS" = codex ]; then
    for ((tick = 0; tick < 120; tick++)); do
      [ -s "$BEAT" ] && break
      sleep 0.5
    done
    # the beat names the thread, or the PowerShell the start stops on
    SID=$(python3 -I -c 'import json, sys; b = json.load(open(sys.argv[1])); print("powershell " + b["powershell"] if "powershell" in b else b["session_id"])' "$BEAT" 2>/dev/null) || SID=
    rm -f -- "$BEAT"
    if ! [[ $SID =~ ^[0-9a-f-]{36}$ ]]; then
      rm -f -- "$LAUNCH_FILE"
      why="Codex's SessionStart hook wrote no beat within 60 seconds, so its guards may not have loaded"
      [[ $SID != "powershell "* ]] || why="a Codex start stops when PowerShell is installed, and ${SID#powershell } is"
      hr pane close "$PANE" >/dev/null 2>&1 ||
        refuse "$why, and herdr would not close $NAME's pane $PANE, so the session may still run: close that pane yourself"
      # A resume's pin and record stand from its last start, so a later resume tries again.
      left="no pin, record or roster row was written"
      [ "$MODE" != resume ] || left="no new pin, record or roster row was written, so its earlier pin and resume record stand"
      refuse "$why: $NAME's pane $PANE is closed, and $left"
    fi
    # The thread takes the session's name through the app-server's thread/name/set, so Codex's own lists and resume by name find it.
    python3 -I - "$CODEX" "$CODEX_HOME" "$SID" "$NAME" <<'PY' || echo "spawn.sh: $NAME started in Codex, but its thread $SID kept no name" >&2
import json, os, signal, subprocess, sys
codex, home, thread, name = sys.argv[1:5]
server = subprocess.Popen([codex, "app-server"], env={**os.environ, "CODEX_HOME": home}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
# An app-server that answers nothing in 20 seconds is ended with the naming, so none outlives the start.
def give_up(*_):
    server.kill()
    sys.exit(1)
signal.signal(signal.SIGALRM, give_up)
signal.alarm(20)
def call(id, method, params):
    server.stdin.write(json.dumps({"id": id, "method": method, "params": params}, separators=(",", ":"), sort_keys=True) + "\n")
    server.stdin.flush()
    for line in server.stdout:
        answer = json.loads(line)
        if answer.get("id") == id:
            return "error" not in answer
    return False
named = call(1, "initialize", {"clientInfo": {"name": "spawn.sh", "version": "1"}})
server.stdin.write(json.dumps({"method": "initialized"}) + "\n")
named = named and call(2, "thread/name/set", {"name": name, "threadId": thread})
server.stdin.close()
server.wait()
sys.exit(0 if named else 1)
PY
  fi
  # The session's resume record, which spawn.sh restore reads after a server's restart, written once herdr runs the session. It is the one resume that brings it back, with the --account its start was given, the model it started with and an effort other than high, and never a token.
  record="exec $(printf %q "$MAIN/scripts/spawn.sh") resume $(printf '%q ' "$NAME" "$CWD" "$SID")"
  # A login the usage gate picked stays off the exec line, so a restore picks afresh, and on the account line, which ops-unstick and no-headless-login read.
  [ -n "$ACCOUNT" ] && [ -z "$PICKED" ] && record+="--account $ACCOUNT "
  [ -n "$GLM_GIVEN" ] && record+="--account $GLM_GIVEN "
  [ -n "$OWN_LOGIN" ] && record+="--account $OWN_LOGIN "
  [ -n "$CLAUDE_MODEL" ] && record+="--model $CLAUDE_MODEL "
  [ -n "$EFFORT" ] && [ "$EFFORT" != high ] && record+="--effort $EFFORT "
  account_line=
  [ -n "$ACCOUNT" ] && account_line="# account: $ACCOUNT"$'\n'
  (umask 077 && printf '#!/bin/bash\n# spawn.sh writes this at every herdr start and resume; spawn.sh restore reads its exec line and the server it ran on.\n# server: %s\n%s%s\n' "$HERDR_SESSION_NAME" "$account_line" "${record% }" > "$RESUME_DIR/$NAME.sh" && chmod 700 "$RESUME_DIR/$NAME.sh") ||
    echo "spawn.sh: $NAME started, but its resume record write failed, so spawn.sh restore cannot bring it back" >&2
  # A start's prompt, which a resume sends again when the session never took it (no transcript yet); it names the brief's file, never its text.
  [ "$MODE" = resume ] || (umask 077 && printf '%s\n' "$PROMPT" > "$RESUME_DIR/$NAME.prompt") ||
    echo "spawn.sh: $NAME started, but its prompt record write failed, so a restore before its first turn starts it without its brief" >&2
  [ "$HARNESS" = codex ] || herdr_answer || true
fi

# The pin lands only once herdr has the session; a healed resume records the backend it was given.
if [ "$MODE" != resume ] || [ -n "$PIN_GIVEN" ]; then
  pin="claude-code ${BACKEND:-claude}"
  [ "$HARNESS" = codex ] && pin="codex openai"
  if ! { mkdir -p "$PINS" && printf '%s\n' "$pin" > "$PINS/$NAME"; }; then
    echo "spawn.sh: $NAME started, but its backend pin write failed; its next resume refuses until the pin reads $pin" >&2
  fi
fi
if ! { mkdir -p "$RUNTIMES" && printf '%s\n' "$RUNTIME" > "$RUNTIMES/$NAME"; }; then
  echo "spawn.sh: $NAME started, but its runtime pin write failed; its next resume opens in herdr all the same" >&2
fi

[ -n "$ROW_FIRST" ] || WHEN=started write_row
