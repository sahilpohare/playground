#!/usr/bin/env bash
# The live dashboard's supervisor: run.sh's child in ops-dashboard's herdr pane, which keeps the dashboard stack and
# the session follower running as its own children (so both stay descendants of that terminal), the web beside them, and rolls them
# to every new head of the branch upstream.sh names end to end: build it while the old stack serves (prebuild, from a staging worktree, unless it migrates), swap the web to that build with no stop (swap_web), stop the API and the follower by their recorded process groups, reset to it, install, build or
# migrate when the merge needs it, take its build (build_head, kept per head in $S/builds) and serve it, check it, start the follower, check it. Each roll, outage or anomaly
# appends one line to results.log (a refused roll a second, naming its refusal), which wakes the runner to report it. It signals only processes it started.
# It runs the latest head of the branch its main checkout sits on (upstream.sh: main for an install, canary for a checkout kept on canary), never one-off hashes or branches
# or worktrees. A head that fails its roll is remembered in bad-builds and never rolled again (one dev refused to start for its own settings, on its third refusal), and the dashboard falls back to the head it ran
# before. A file named paused in its state folder (ops/dashboard) stops every roll (restarts of a dead stack still run): touch it before a
# restart by hand, remove it after.
# It runs in the dashboard's checkout (run.sh's working directory), and stops its stack on SIGHUP, SIGTERM, or once run.sh has exited and left it to launchd.
set -m   # each background child gets its own process group, so stopping one never touches this script
D=$(cd "$(dirname "$0")" && pwd)
# The data folder, as packages/env/src/data-dir.ts resolves it: PLAYGROUND_DATA_DIR, else ~/.playground
case ${PLAYGROUND_DATA_DIR:-/} in /*) ;; *) echo "supervisor.sh: PLAYGROUND_DATA_DIR is relative ($PLAYGROUND_DATA_DIR), so each process would read it from its own folder: set it to an absolute path" >&2; exit 1 ;; esac
DATA=${PLAYGROUND_DATA_DIR:-$HOME/.playground}
S=$DATA/ops/dashboard; mkdir -p "$S"
WT=$PWD
RESULTS="$S/results.log"
LOG="$S/supervisor.log"
DEVLOG="$S/dev.log"
INGLOG="$DATA/dashboard-ingest.log"
OPS=$(dirname "$D")
BAD="$S/bad-builds"
# prebuild's clone, install and build queue in run-slot as ops-dashboard when the data folder holds it (a fork or a machine with no ops runs them bare), each checked every PREBUILD_POLL s; one queued PREBUILD_SLOW s logs once that it still waits, and keeps waiting
RS=$DATA/ops/run-slot.sh RUNS=$DATA/ops/run-slot.runs.log PREBUILD_SLOW=1200 PREBUILD_POLL=5
# 12 Oct (the owner saw "Network request failed" errors on the API grow frequent; five rolls 16:21-16:59Z each restarted the API):
# every roll, an upstream move included, waits ROLL_GAP after the last and for OWNER_IDLE with no owner action (a dashboard message or an Inbox
# answer), batching what lands meanwhile, or ROLL_GAP alone when the owner's idle cannot be read while the dashboard's Postgres runs (roll_due); a file named roll-now in its state folder (ops/dashboard) rolls at once, for a fix to live breakage
# or `playground update`, and with nothing to roll to it logs CURRENT, or SKIP for a head in bad-builds, and is removed
ROLL_GAP=1800 OWNER_IDLE=300 ASKS=$DATA/asks
cd "$WT" || exit 1
# a roll resets this checkout hard (redeploy-pull.sh), so only the dashboard's own checkout, on the branch live.branch names, is ever taken
LIVE=$(bun --no-env-file "$D/../../../packages/scripts/src/playground/setting.ts" --text live.branch 2>&1) ||
  { echo "supervisor: refusing to run in $WT: it cannot read live.branch: $LIVE" >&2; exit 1; }
branch=$(git symbolic-ref --short HEAD 2>/dev/null)
[ "$branch" = "$LIVE" ] || { echo "supervisor: refusing to run in $WT on ${branch:-a detached HEAD}: the dashboard's checkout is on $LIVE" >&2; exit 1; }

say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }
# A folder in $S/builds goes to the trash through trash-build.ts, the dashboard-supervisor carve-out's one caller, $2 its reason; a refusal is logged and returns 1, and the folder stays for the next keep_builds
trash_build() { [ -e "$1" ] || return 0; bun --no-env-file "$D/../../../packages/scripts/src/trash-build.ts" "$1" "$2" >> "$LOG" 2>&1 || { say "the trash refused $1, so it stays (supervisor.log has why)"; return 1; }; }
# A folder in $S/builds moves aside as <name>.aside-<epoch> and then to the trash, so a refusal leaves only a stray that keep_builds trashes later and never fails the build; returns 1 only when the move aside fails
set_aside() { [ -e "$1" ] || return 0; local aside; aside="$1.aside-$(date +%s)"; mv "$1" "$aside" || return 1; trash_build "$aside" "$2" || :; }
result() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$RESULTS"; say "RESULT $*"; }

# The head's production build, kept in $S/builds/<sha> outside the checkout: made by bun run build when it is missing, or when it was built for other URLs, since next bakes NEXT_PUBLIC_APP_URL and NEXT_PUBLIC_API_URL into its client and auth bakes HONO_APP_URL's host; NODE_ENV and SKIP_ENV_VALIDATION_SERVER let it build before first run writes its .env, whose values the stack reads at its start; a failure prints its last error line; $1 is the tree it builds, the checkout by default, or prebuild's staging worktree, whose build ($2 set) goes through slot_step
build_head() {
  local src=${1:-.} sha dir was started out
  sha=$(git -C "$src" rev-parse HEAD); dir=$S/builds/$sha
  dashboard_urls || { echo "bunx portless get failed"; return 1; }
  if [ -d "$dir" ]; then
    was=$(cat "$dir/urls" 2>/dev/null)
    [ "$was" = "$WEB $API" ] && return 0
    say "rebuilding ${sha:0:7}: its build was for ${was:-no URLs}, the Dashboard is now on $WEB $API"
  fi
  say "building ${sha:0:7} for $WEB $API"; started=$(date +%s)
  local via=(); [ -z "${2:-}" ] || via=(slot_step build .)
  if ! out=$(cd "$src" && HONO_APP_URL=$API HONO_TRUSTED_ORIGINS=$WEB NEXT_PUBLIC_API_URL=$API NEXT_PUBLIC_APP_URL=$WEB NODE_ENV=production SKIP_ENV_VALIDATION_SERVER=true "${via[@]}" bun run build 2>&1); then
    echo "$out" >> "$LOG"
    echo "$out" | grep -E 'error|Error|ERR' | tail -1 | cut -c1-200; return 1
  fi
  set_aside "$dir.tmp" "a build copy an earlier run left half made" || { echo "moving $dir.tmp aside failed"; return 1; }; mkdir -p "$dir.tmp"
  # next's standalone server leaves .next/static and public for its host to copy beside it
  cp -R "$src/web/next/.next/standalone" "$dir.tmp/web" && mkdir -p "$dir.tmp/web/web/next/.next" && cp -R "$src/web/next/.next/static" "$dir.tmp/web/web/next/.next/static" &&
    { [ ! -d "$src/web/next/public" ] || cp -R "$src/web/next/public" "$dir.tmp/web/web/next/public"; } &&
    echo "$WEB $API" > "$dir.tmp/urls" || { echo "copying the build to $dir failed"; return 1; }
  # the head's own web launcher, bundled into one file, so the web a roll swaps in runs the target's launcher, not the checkout's older one
  (cd "$src" && bun build packages/scripts/src/portless.ts --target=bun --outfile="$dir.tmp/launcher.js") >> "$LOG" 2>&1 || say "bundling ${sha:0:7}'s web launcher failed; its web starts through the checkout's portless.ts"
  set_aside "$dir" "rebuilt for the Dashboard's URLs" || { echo "moving $dir aside failed"; return 1; }; mv "$dir.tmp" "$dir"
  say "built ${sha:0:7} in $(( $(date +%s) - started ))s, $(du -sh "$dir" | cut -f1)"
}
# One prebuild step, $1 its name, run in folder $2: through run-slot as ops-dashboard when $RS is executable, else bare. It logs how long the step queued, and once, past PREBUILD_SLOW s, that it still queues.
# It waits as the supervisor's background child, checked every PREBUILD_POLL s, so a stack that goes down meanwhile stops the step by its pid and the loop restarts the stack that same tick, never after the queue's wait.
# A skip goes to $S/prebuild-skip as its reason: that stop, or an exit run-slot made itself (2, a refusal, or 143, a stopped wait) before its runs.log holds a start line for this pid; the step returns its exit either way
slot_step() {
  local name=$1 dir=$2 p rc mark t0 line said= down=; shift 2
  [ -x "$RS" ] || { (cd "$dir" && "$@"); return; }
  mark=$(wc -l 2>/dev/null < "$RUNS" | tr -d ' '); t0=$(date +%s)
  (cd "$dir" && exec "$RS" ops-dashboard -- "$@") & p=$!
  echo "$p" > "$S/prebuild.pid"
  step_started() { tail -n +"$((${mark:-0} + 1))" "$RUNS" 2>/dev/null | awk -v p="$p" '$2 == "start" && $4 == p' | tail -1; }
  while kill -0 "$p" 2>/dev/null; do
    sleep "$PREBUILD_POLL" & wait $!
    if [ -z "$down" ] && ! { alive dashboard-dev && alive dashboard-web; }; then kill -TERM "$p" 2>/dev/null; down=1; fi
    [ -z "$said" ] && [ $(($(date +%s) - t0)) -ge "$PREBUILD_SLOW" ] && [ -z "$(step_started)" ] && { say "prebuild $name still queued after $(($(date +%s) - t0))s; it keeps waiting"; said=1; }
  done
  wait "$p"; rc=$?
  rm -f "$S/prebuild.pid"
  line=$(step_started)
  [ -z "$line" ] || say "prebuild $name queued $(echo "$line" | sed -n 's/.* waited=\([0-9]*\)s.*/\1/p')s"
  if [ -n "$down" ]; then
    echo "the stack went down during prebuild's $name, so the supervisor stopped it" > "$S/prebuild-skip"
  elif [ -z "$line" ]; then
    case "$rc" in 2 | 143) echo "run-slot exited $rc before prebuild's $name ran" > "$S/prebuild-skip" ;; esac
  fi
  return "$rc"
}
# A roll whose prebuild step was skipped (Ops' ruling of 6 Nov): nothing stops, one supervisor.log line names the reason, the next tick tries again, and the same target skipped 3 rolls in a row tells ops once
skip_roll() {
  local why; why=$(cat "$S/prebuild-skip")
  [ "$(head -1 "$S/skips" 2>/dev/null)" = "$1" ] || : > "$S/skips"
  echo "$1" >> "$S/skips"
  say "roll to ${1:0:7} skipped: $why; trying again at the next tick"
  [ "$(wc -l < "$S/skips" | tr -d ' ')" -ne 3 ] || "$OPS/notify.sh" dashboard "dashboard roll to ${1:0:7} skipped 3 times: $why"
}
# Before a roll stops anything: build the target ($1, the roll tagged $2) into $S/builds/<sha> from a detached staging worktree while the old stack serves, so build_head finds it kept after the stop; a target that migrates, whose commit cannot be had here, or whose staging worktree or install fails, builds after the stop as before; a build that fails lists the target in bad-builds and returns 1 with nothing stopped; a step slot_step marks skipped skips the roll (skip_roll) and returns 1 with nothing stopped and no bad-builds entry; the staging worktree goes either way
prebuild() {
  local target=$1 tag=$2 stage=$S/staging built rc=0
  prebuilt=; rm -f "$S/prebuild-skip"
  drop_stage() { git worktree remove --force "$stage" >> "$LOG" 2>&1 || rm -rf "$stage"; git worktree prune; }
  "$D/net-git.sh" fetch -q origin >> "$LOG" 2>&1
  git cat-file -e "$target^{commit}" 2>/dev/null || { say "no commit ${target:0:7} here yet; building after the stop"; return 0; }
  git diff --quiet HEAD "$target" -- packages/db/drizzle/ || { say "${target:0:7} migrates; building after the stop"; return 0; }
  rm -rf "$stage"; git worktree prune
  git worktree add -q --detach "$stage" "$target" >> "$LOG" 2>&1 || { say "the staging worktree for ${target:0:7} failed; building after the stop"; drop_stage; return 0; }
  # node_modules as a copy-on-write clone of the checkout's (cp -c on macOS; --reflink=auto elsewhere, since GNU cp has no -c), then an install for what the move changed and each workspace's own links; .env as the checkout's, which bun run build loads
  local clone=(-cR); [ "$(uname -s)" = Darwin ] || clone=(-R --reflink=auto)
  if ! { { [ ! -d node_modules ] || slot_step clone . cp "${clone[@]}" node_modules "$stage/"; } && (unset NODE_ENV SKIP_ENV_VALIDATION && slot_step install "$stage" bun install --frozen-lockfile --ignore-scripts); } >> "$LOG" 2>&1; then
    [ ! -s "$S/prebuild-skip" ] || { skip_roll "$target"; drop_stage; return 1; }
    say "the staging worktree's install for ${target:0:7} failed; building after the stop"
    drop_stage; return 0
  fi
  [ ! -f .env ] || cp .env "$stage/.env"
  say "building ${target:0:7} before the stop, from $stage"
  built=$(build_head "$stage" slot) || rc=1
  drop_stage
  [ ! -s "$S/prebuild-skip" ] || { skip_roll "$target"; return 1; }
  [ $rc -eq 0 ] && { prebuilt=1; return 0; }
  echo "$target" >> "$BAD"
  result "$tag ${target:0:7} FAIL build before the stop: ${built:-no error line; see supervisor.log}; still serving $(git rev-parse --short HEAD)"
  tell_dispatcher "Dashboard roll to ${target:0:7} FAILED its build; nothing stopped, still on $(git rev-parse --short HEAD)"
  return 1
}
# After a pass: keep this head's build and the last one that passed before it, for the next fallback, and move the rest to the trash, a stray .tmp or .aside-<epoch> folder included
keep_builds() {
  local before d; before=$(cat "$S/builds/passed" 2>/dev/null)
  for d in "$S/builds"/*/; do d=$(basename "$d"); [ "$d" = "$1" ] || [ "$d" = "$before" ] || trash_build "${S:?}/builds/$d" "neither this head's build nor the last one that passed"; done
  [ "$before" = "$1" ] || echo "$1" > "$S/builds/passed"
}
# The API alone, from the checkout's source, under the dev launcher; the web runs on its own (web_up)
start_dev() {
  PLAYGROUND_BUILD=$S/builds/$(git rev-parse HEAD) bun run serve --filter=@api/hono --ui stream > "$DEVLOG" 2>&1 &
  echo $! > "$S/dashboard-dev.pid"; say "dev started, pid $!"
}
start_follower() {
  bash "$D/start-ingest.sh" &
  echo $! > "$S/dashboard-ingest.pid"; say "follower started, pid $!"
}
# The web launcher for the build of $1: the head's own, which build_head bundles beside it, else the checkout's packages/scripts/src/portless.ts (a build kept from before the bundle), with a line saying why
launcher() {
  [ -f "$S/builds/$1/launcher.js" ] && { echo "$S/builds/$1/launcher.js"; return; }
  say "the build of ${1:0:7} keeps no launcher; its web starts through the checkout's portless.ts"
  echo ../../packages/scripts/src/portless.ts
}
# The web: next's standalone server from the head's kept build ($2), started as job $1 on a port of its own, with the env the head's launcher gives the serve task; ready once / answers 2xx or 3xx, within 60s
# It returns 1 for the head's fault (its web exited, or answered only errors) and 2 for the machine's (no free port, the port taken, a web still silent at 60s), and names which in web_why
web_up() {
  local job=$1 sha=$2 port i code=000 launch
  port=$(bun --no-env-file -e 'const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); console.log(s.port); s.stop(true)') || { web_why="no free port for the web"; return 2; }
  launch=$(launcher "$sha")
  (cd web/next && PORTLESS_URL=$WEB PORT=$port HOSTNAME=127.0.0.1 exec bun "$launch" bun "$S/builds/$sha/web/web/next/server.js") > "$S/$job.log" 2>&1 &
  echo $! > "$S/$job.pid"; echo "$port" > "$S/$job.port"; echo "$sha" > "$S/$job.sha"
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")
    case "$code" in 2*|3*) "$D/procs.sh" record "$job" >> "$LOG" 2>&1; say "web ${sha:0:7} up on :$port, pid $(cat "$S/$job.pid")"; return 0 ;; esac
    alive "$job" || break; sleep 1
  done
  if alive "$job"; then
    [ "$code" = 000 ] && { web_why="the web ${sha:0:7} was still silent on :$port at 60s"; return 2; }
    web_why="the web ${sha:0:7} answered only $code"; return 1
  fi
  grep -q EADDRINUSE "$S/$job.log" 2>/dev/null && { web_why="the web's port :$port was taken"; return 2; }
  web_why="the web ${sha:0:7} exited: $(tail -1 "$S/$job.log" | cut -c1-200)"; return 1
}
# The web's portless route, and its bare alias, to port $1, owned by run.sh ($PPID, which a reload keeps), so moving it from one web to the next is one write and the old web's exit leaves it; a refusal (another live process holds the name) is the machine's
web_route() { bun "$WT/api/hono/src/bin/web-route.ts" "$WEB" "$1" "$PPID" >> "$LOG" 2>&1 || { web_why="the web's route was refused (see supervisor.log)"; return 2; }; }
serving_web() { alive dashboard-web && [ "$(cat "$S/dashboard-web.sha" 2>/dev/null)" = "$1" ]; }
web_stop() { local rc=0; "$D/procs.sh" stop "$1" >> "$LOG" 2>&1 || rc=1; rm -f "$S/$1.pid" "$S/$1.port" "$S/$1.sha"; return $rc; }
stop_web() { web_stop dashboard-web-next; web_stop dashboard-web; }
# The head's web ($1) serving and routed: the one that serves it already is kept (a swap, or a reload's), else a new one starts in the old one's place; returns web_up's or web_route's 1 or 2
ensure_web() {
  local rc
  serving_web "$1" || { stop_web; web_up dashboard-web "$1" || { rc=$?; say "$web_why"; return $rc; }; }
  web_route "$(cat "$S/dashboard-web.port")" || { say "$web_why"; return 2; }
}
# A roll's web with no gap: the target's ($1) starts beside the serving one, the route moves to it, and the old one stops once the proxy has read the move; returns 1, the old one serving, when no web of this supervisor's serves or the new one does not take over
swap_web() {
  local sha=$1
  alive dashboard-web || return 1
  if ! web_up dashboard-web-next "$sha" || ! web_route "$(cat "$S/dashboard-web-next.port")"; then
    web_stop dashboard-web-next; say "web ${sha:0:7} did not take over ($web_why); stopping both as before"; return 1
  fi
  sleep "${ROUTE_SETTLE:-3}"
  web_stop dashboard-web || say "the old web outlived its stop (see supervisor.log)"
  local f; for f in pid port sha procs log; do [ ! -e "$S/dashboard-web-next.$f" ] || mv "$S/dashboard-web-next.$f" "$S/dashboard-web.$f"; done
  say "web swapped to ${sha:0:7} on :$(cat "$S/dashboard-web.port") with no stop"
}
# Stop the follower and the API, and the web too unless $1 is keep-web (a roll whose web has swapped already)
stop_all() {
  dashboard_container > /dev/null
  "$D/procs.sh" stop dashboard-ingest >> "$LOG" 2>&1
  "$D/procs.sh" stop dashboard-dev >> "$LOG" 2>&1
  [ "${1:-}" = keep-web ] || stop_web
}
# the dashboard's URLs as portless names them for this checkout, from the state folder portlessDir() picks (the 1355 proxy's while only it serves, so its https is named), read at every check, since portless's proxy can move (from 1355 to 443)
dashboard_urls() { local dir; dir=$(bun --no-env-file -e "console.log((await import('$D/../../../api/hono/src/lib/dev/proxy.ts')).portlessDir())") && WEB=$(PORTLESS_STATE_DIR=$dir bunx portless get playground) && API=$(PORTLESS_STATE_DIR=$dir bunx portless get api.playground); }
# Up to 90 tries, a second apart, for the dashboard's health to answer, its URLs read afresh each try: before portless's proxy runs, portless get names its default port
# The branch the dashboard rolls to, read once at start, and its head on origin, read each time
UPSTREAM=$("$D/upstream.sh")
upstream_head() { "$D/net-git.sh" ls-remote origin "refs/heads/$UPSTREAM" 2>>"$LOG" | cut -f1; }
# A roll only moves forward: an upstream head the running head already holds (main behind a checkout that rolled on canary) waits until the upstream passes it
behind() { git merge-base --is-ancestor "$1" HEAD 2>/dev/null; }
wait_dashboard() { local i; for i in $(seq 1 90); do dashboard_urls && curl -sf "$API/api/health" > /dev/null 2>&1 && return 0; sleep 1; done; return 1; }
alive() { kill -0 "$(cat "$S/$1.pid" 2>/dev/null)" 2>/dev/null; }
# first run's setup has not written the database yet: no POSTGRES_URL in the environment or this checkout's .env, so the follower, which validates it as it starts, waits rather than exiting on every tick
setup_pending() { [ -z "${POSTGRES_URL:-}" ] && ! grep -qE "^POSTGRES_URL=[\"']?[^\"'[:space:]]" "$WT/.env" 2>/dev/null; }
# an importer holds the follower's lock: a follower an earlier supervisor left running counts, so this one's "another importer holds the lock" exit is no outage; the status read gets HELD_WAIT seconds, then is stopped by its own process group (set -m gives it one), so a wedged docker child under it goes too, and exits 2, holder unknown, so a wedged Docker or database never freezes the loop
follower_held() { local p i; bun api/hono/src/bin/dashboard-ingest.ts status > /dev/null 2>&1 & p=$!; for i in $(seq 1 "${HELD_WAIT:-20}"); do kill -0 "$p" 2>/dev/null || { wait "$p" && return 0 || return 1; }; sleep 1; done; kill -- -"$p" 2>/dev/null; wait "$p" 2>/dev/null; return 2; }

# The bare aliases (playground.localhost, api.playground.localhost) hold the ports of the live stack's own routes in portless's route file, in the folder portlessDir() names, read by alias.ts and never written: its exit is 0 when they do, 1 when one points elsewhere, 2 for a missing file or route
read_aliases() { bun --no-env-file "$D/alias.ts" "$WEB" "$API" 2>&1; }
# A mismatch is read again after ALIAS_CONFIRM seconds (6), past the launcher's 2 s alias sync, which an alias waits on after a restart (live.md); one that holds, a missing file or a missing route is one ALIAS FAIL result (run.sh's notify_new alerts it), written again only when it changes, and ALIAS PASS once it is right, so the heartbeat reads ok again
# A missing route for the web's own name, as when web_route wrote it before the stack's API started portless's proxy in its fallback folder, is written again by web_route into the folder that serves now and read again after ALIAS_CONFIRM, once the launcher's sync has given it its bare alias
check_aliases() { local out rc=0 host; dashboard_urls || return 0; out=$(read_aliases) || rc=$?; host=${WEB#*://}; host=${host%%[:/]*}; if [ $rc -eq 2 ] && [[ $out == "no route for $host in "* ]] && alive dashboard-web && web_route "$(cat "$S/dashboard-web.port")"; then say "the web's route was missing ($out), so web_route wrote it again"; rc=1; fi; if [ $rc -eq 1 ]; then sleep "${ALIAS_CONFIRM:-6}" & wait $!; rc=0; out=$(read_aliases) || rc=$?; fi; if [ $rc -eq 0 ]; then [ -z "${alias_said:-}" ] || result "ALIAS PASS $out"; alias_said=; return 0; fi; [ "$out" = "${alias_said:-}" ] || result "ALIAS FAIL $out"; alias_said=$out; return 1; }
# The owner's address as probe.ts's dashboardUrls() reads it, the bare name in the folder portlessDir() picks (PDIR), which names the 1355 fallback only while its proxy.pid lives
owner_url() { PDIR=$(bun --no-env-file -e "console.log((await import('$D/../../../api/hono/src/lib/dev/proxy.ts')).portlessDir())") && OWNER=$(PORTLESS_STATE_DIR=$PDIR bunx portless get playground --no-worktree); }
# Whether address $1 gives any HTTP answer, under the CA in folder $2 as probe.ts trusts it: a 502 counts, since the proxy answers and the pid checks own the stack; refused, timed out or a failed handshake is a miss
answers() { local ca=(); [ ! -f "$2/ca.pem" ] || ca=(--cacert "$2/ca.pem"); curl -s -o /dev/null --max-time 10 "${ca[@]}" "$1"; }
# portless's proxy, read through the owner's address every PROXY_EVERY s (60): a stopped proxy leaves the web and the API alive, so the pid checks never see it (16 Nov, 09:23Z to 09:33Z).
# Two misses in a row write one DOWN proxy result (run.sh tells ops) and tell the dispatcher once; a proxy the last answered check read in the fallback folder is started again there by portless's own start, on its address's port, since its stop removed the proxy.port and proxy.pid that would name them; a service's proxy, or one this supervisor never saw answer, is left to the owner. A failed start tells the dispatcher again, and nothing more runs until the address answers.
check_proxy() {
  local now port hp i
  now=$(date +%s)
  [ $((now - ${proxy_at:-0})) -ge "${PROXY_EVERY:-60}" ] || return $((${proxy_miss:-0} > 0))
  proxy_at=$now
  if owner_url && answers "$OWNER" "$PDIR"; then
    [ "${proxy_miss:-0}" -lt 2 ] || result "UP proxy PASS $OWNER answers again"
    proxy_miss=0 proxy_dir=$PDIR proxy_url=$OWNER
    return 0
  fi
  proxy_miss=$((${proxy_miss:-0} + 1))
  [ "$proxy_miss" -eq 2 ] || return 1
  local down="DOWN proxy: ${proxy_url:-the Dashboard address} answered nothing at 2 checks ${PROXY_EVERY:-60} s apart"
  result "$down"
  if [ -z "${proxy_dir:-}" ]; then tell_dispatcher "$down; not restarting it, since this supervisor never saw it answer and nothing names its port"; return 1; fi
  if [ "$(basename "$proxy_dir")" != fallback ]; then tell_dispatcher "$down; not restarting it, since a service owns the proxy in $proxy_dir"; return 1; fi
  hp=${proxy_url#*://}; hp=${hp%%/*}
  case $hp in *:*) port=${hp##*:} ;; *) [ "${proxy_url%%:*}" = http ] && port=80 || port=443 ;; esac
  tell_dispatcher "$down; starting it again on $port"
  PORTLESS_STATE_DIR=$proxy_dir "$WT/node_modules/.bin/portless" proxy start -p "$port" --skip-trust > "$S/proxy-start.log" 2>&1
  for i in $(seq 1 "${PROXY_WAIT:-10}"); do
    answers "$proxy_url" "$proxy_dir" && { result "RESTART proxy PASS on $port: $proxy_url answers"; proxy_miss=0; return 0; }
    sleep 1
  done
  local why; why=$(sed $'s/\x1b\\[[0-9;]*m//g' "$S/proxy-start.log" | grep . | tail -1 | cut -c1-200)
  result "RESTART proxy FAIL on $port: ${why:-portless printed nothing}"
  tell_dispatcher "The Dashboard's proxy did not come back on $port: ${why:-portless printed nothing} (ops/dashboard/proxy-start.log)"
  return 1
}
# Dev up and checked: health answers, verify passes against HEAD, approvals stay off. Prints one summary.
# every verify check but pages, one call each (verify takes one check per call): the pages check opens /dashboard/apps/changelog,
# which marks the changelog read for LocalAgent, the owner's account, so each roll cleared the owner's +1 (fixed since, 7 Oct)
# signin, ws and system sign in through the agent route, which only a checkout whose .env turns AGENT_SIGNIN_ENABLED on serves; a person's checkout starts it blank from .env.example, so there health and map are the checks
verify_dashboard() {
  local c out rc=0 checks="health map"
  grep -qiE '^AGENT_SIGNIN_ENABLED=(true|1|yes|on|y|enabled)$' .env 2>/dev/null && checks="health signin ws system map"
  dashboard_urls || { echo "✗ urls: bunx portless get failed"; return 1; }
  for c in $checks; do
    out=$(bun run verify "$c" --web "$WEB" --api "$API" --expect "$(git rev-parse HEAD)" 2>&1) || rc=1
    echo "$out"
  done
  return $rc
}

# The dev log's line that names why the stack stopped, on the dev launcher's vocabulary: the launcher's own notes pass over, a refusal or an error names itself
dev_reason() {
  awk '/^dev: / && !/^dev: refusing/ { next } /^dev: refusing|EADDRINUSE|ERROR|SyntaxError|error:/ { print; exit }'
}

check_dev() {
  wait_dashboard
  # the launcher's own dev: notes pass over to the line that stopped the stack, a refusal kept
  if ! alive dashboard-dev; then echo "dev=DOWN ($(dev_reason < "$DEVLOG" | cut -c1-140))"; return 1; fi
  sleep 3; "$D/procs.sh" record dashboard-dev >> "$LOG" 2>&1
  local version v ok=0
  version=$(curl -sf "$API/api/health" | sed -nE 's/.*"version":"([^"]+)".*/\1/p' | head -1)
  v=$(verify_dashboard); ok=$?
  # a roll's first verify can land while next or the proxy is still settling (502): wait and verify once more before reporting FAIL
  if [ $ok -ne 0 ]; then sleep 45; v=$(verify_dashboard); ok=$?; fi
  echo "$v" >> "$LOG"
  local fails; fails=$(echo "$v" | grep '^✗' | cut -c1-120 | tr '\n' ';')
  local appr="blank"; grep -qE '^(PLAYGROUND_APPROVALS_ENABLED|DESK_APPROVALS_ENABLED)=.+' .env && appr="SET(!)"
  echo "version=${version:-unknown} verify=$([ $ok -eq 0 ] && echo PASS || echo "FAIL $fails") approvals=$appr"
  [ $ok -eq 0 ] && [ "$appr" = blank ]
}
# Follower up and checked: waits for its "following" line after this start, then bun run ingest status.
check_follower() {
  local since=$1 i line
  for i in $(seq 1 90); do
    line=$(awk -v t="$since" '$1 >= t' "$INGLOG" | grep -E 'following|refusing|exited with code' | tail -1)
    case "$line" in *following*) break ;; esac
    alive dashboard-ingest || break; sleep 1
  done
  "$D/procs.sh" record dashboard-ingest >> "$LOG" 2>&1
  local st code; st=$(bun run ingest status 2>&1); code=$?
  echo "follower=$([ $code -eq 0 ] && echo running || echo "FAIL $(tail -2 "$INGLOG" | tr '\n' ' ' | cut -c1-160)") $(echo "$st" | sed -n 2p | cut -c1-60) $(echo "$st" | grep -o 'entries: [0-9]*')"
  [ $code -eq 0 ]
}
# The loop's DOWN dev reason: the echoed bun command spent the old tail's 200 before the refusal showed, so the reason names itself first; bun's own `error: script` exit line drops out first, or every crash but a refusal would name it, and the last line left names a death the vocabulary does not; three lines suffice, since a refusal exits at once and only that line follows it, and 360 holds the launcher-gone refusal's pids inside notify's 400 past the 31-character stamp
dev_down() {
  local tail reason
  tail=$(tail -3 "$DEVLOG" | grep -v '^error: script ')
  reason=$(printf '%s\n' "$tail" | dev_reason)
  [ -n "$reason" ] || reason=$(printf '%s\n' "$tail" | tail -1)
  printf '%s' "$reason" | cut -c1-360
}
# An install made before the loopback rule publishes its database on every interface, which the follower's guard refuses: move it onto 127.0.0.1 alone with this checkout's code (lib/setup/move.ts) while the API and the follower are down, so it is healthy before either connects; a container on loopback is left alone with nothing printed. A move sets moved_note, which the roll's PASS or FAIL line carries for playground update to print, and a failed one, which starts the old container again as it was, sets move_failure, which finish_roll puts first in the roll's refusal
move_database() { local out; if out=$(bun "$WT/api/hono/src/bin/dashboard-db.ts" move 2>&1); then [ -z "$out" ] || { moved_note="database: $(echo "$out" | awk 'NR>1{printf "; "} {printf "%s", $0} END{print ""}')"; say "$moved_note"; }; else move_failure=$(echo "$out" | tail -1 | cut -c1-300); say "database: $move_failure"; fi; }
# The follower's last line when it is the guard's refusal of the database's publish (a container published beyond loopback, or none publishing the port): the machine's, not the head's, so finish_roll keeps the head out of bad-builds
guard_reason() { tail -2 "$INGLOG" | grep -m1 -oE 'refusing to write: .*(beyond loopback|no single running Docker container publishes port [0-9]+)'; }
roll_up() {   # build the head when it has no build, start it and the follower, check both, and report one line; returns 0 on PASS
  local tag=$1 sha dev fol t built moved_note=
  guard_refusal= move_failure=
  sha=$(git rev-parse --short HEAD)
  # a failed build leaves no dev log of its own, so finish_roll never reads the last stack's refusal as this head's
  built=$(build_head) || { : > "$DEVLOG"; result "$tag $sha FAIL build: $built"; return 1; }
  # a web the head broke fails the roll as a bad build; the machine's fault writes the refusal line finish_roll reads, so the head is tried again
  dashboard_urls; ensure_web "$(git rev-parse HEAD)"; local wrc=$?
  if [ $wrc -ne 0 ]; then
    if [ $wrc -eq 2 ]; then echo "dev: refusing to start: $web_why" > "$DEVLOG"; else : > "$DEVLOG"; fi
    result "$tag $sha FAIL web: $web_why"; return 1
  fi
  setup_pending || move_database
  start_dev; dev=$(check_dev); local dok=$?
  local fok=0
  if setup_pending; then
    fol="follower=waiting for first run's setup"; say "follower: waiting for first run's setup, which writes POSTGRES_URL; not starting it"; waiting_f=1
  else
    t=$(date -u +%Y-%m-%dT%H:%M:%S); start_follower; fol=$(check_follower "$t"); fok=$?
    [ $fok -eq 0 ] || guard_refusal=$(guard_reason)
  fi
  if [ $dok -eq 0 ] && [ $fok -eq 0 ]; then result "$tag $sha PASS $dev $fol${moved_note:+ $moved_note}"; keep_builds "$(git rev-parse HEAD)"; return 0; else result "$tag $sha FAIL $dev $fol${move_failure:+ database move: $move_failure}${moved_note:+ $moved_note}"; return 1; fi
}
# The owner's rule: restart the app every time something lands on the upstream, so the change is visible at once
tell_dispatcher() { NOTIFY_TO=dispatcher "$OPS/notify.sh" dashboard "$1"; }

# The dashboard's database container, by the rule bun run ingest proves (the one running container publishing POSTGRES_URL's port on loopback alone), read with this checkout's own code and .env, and written to dashboard-db for procs.sh's drain (empty when none); a failed lookup logs its reason once, when it starts failing
dashboard_container() { local c; if c=$(bun "$WT/api/hono/src/bin/dashboard-db.ts" 2>&1); then echo "$c" > "$S/dashboard-db"; echo "$c"; else { [ ! -e "$S/dashboard-db" ] || [ -s "$S/dashboard-db" ]; } && say "dashboard db not found: $c"; : > "$S/dashboard-db"; return 1; fi; }
# Seconds since the last message sent from the dashboard (the activity row deliver() writes); empty when it cannot tell
quiet_for() { local c; c=$(dashboard_container) || return 0; docker exec "$c" psql -U postgres -tAc "select coalesce(extract(epoch from now() - max(created_at))::int, 999999) from activity where action in ('dashboard.message', 'desk.message')" 2>/dev/null | tr -d ' '; }
# Seconds since the owner last acted on the dashboard: a dashboard message, or an Inbox answer (it rewrites the ask's file); empty when it cannot tell
owner_idle() {
  local q a newest
  q=$(quiet_for); [ -n "$q" ] || return 0
  newest=$({ stat -c %Y "$ASKS"/*.json 2>/dev/null || stat -f %m "$ASKS"/*.json 2>/dev/null; } | sort -n | tail -1)
  a=$(( $(date +%s) - ${newest:-0} ))
  [ "$a" -lt "$q" ] && echo "$a" || echo "$q"
}
# a roll is due once ROLL_GAP has passed ($1 seconds since the last) and the owner has been idle OWNER_IDLE ($2), or the owner's idle cannot be read while the dashboard's Postgres runs ($3 is up), so an upstream move never waits on a reading; with the container down a roll would fail its database proof, so it holds
roll_due() { [ "$1" -ge $ROLL_GAP ] && { [ -n "$2" ] && [ "$2" -ge $OWNER_IDLE ] || { [ -z "$2" ] && [ "$3" = up ]; }; }; }
dashboard_db() { dashboard_container > /dev/null && echo up || echo down; }
# When the running code (from head $1, or a copy outside this checkout) differs from the checkout's scripts/ops/dashboard/, write the roll to $S/reload (the head, tag $2, then $3-$5 for finish_roll) and exit 75 with the API and the follower down (a swapped web keeps serving), so run.sh execs the checkout's own copy
reload_if() {
  [ "$D" -ef "$WT/scripts/ops/dashboard" ] && git diff --quiet "$1" HEAD -- scripts/ops/dashboard/ && return 0
  printf '%s\n' "$(git rev-parse HEAD)" "$2" "${3:-}" "${4:-}" "${5:-}" > "$S/reload"
  say "reloading at $(git rev-parse --short HEAD) on its own scripts/ops/dashboard/ ($2)"; exit 75
}
# The roll the last supervisor handed on, read and removed; one written at another head is stale and dropped
take_reload() { [ -s "$S/reload" ] || return 1; { read -r r_head; read -r r_tag; read -r r_target; read -r r_prev; read -r r_mig; } < "$S/reload"; rm -f "$S/reload"; [ "$r_head" = "$(git rev-parse HEAD)" ]; }
# Pull to $1 and set out, mig and pulled, its exit; a pull that failed before it reached $1 (a fetch, the live branch's refusal) leaves the head it was on, so it reports an ANOMALY and returns 1 for the caller to start that head again, and the next roll tries again
pull_to() {
  pulled=0; mig=
  out=$("$D/redeploy-pull.sh" "$1" 2>&1) || pulled=$?; echo "$out" >> "$LOG"
  echo "$out" | grep -qx migrate && mig=migrate
  if [ "$pulled" -ne 0 ] && [ "$(git rev-parse HEAD)" != "$(git rev-parse -q --verify "$1^{commit}")" ]; then result "ANOMALY pull to ${1:0:7} failed before it moved (exit $pulled); staying on $(git rev-parse --short HEAD)"; return 1; fi
}
# Build $1 while the old stack serves (prebuild) and swap the web to it (swap_web), then stop, move the checkout to $1, start, check; falls back to the head it ran before when the roll fails (never after a migration).
roll_to() {
  local target=$1 why=$2 prev out notes mig tag pulled
  prebuild "$target" "ROLL $why" || return 0
  local keep=; [ -n "$prebuilt" ] && dashboard_urls && swap_web "$target" && keep=keep-web
  stop_all $keep
  if [ -n "$("$D/procs.sh" left dashboard-dev)$("$D/procs.sh" left dashboard-ingest)" ]; then result "ANOMALY stop left processes alive; not rolling"; return 1; fi
  prev=$running
  if ! pull_to "$target"; then roll_up RESTART; last_roll=$(date +%s); return; fi
  notes=$(echo "$out" | grep -E '^(install|build|migrate)$|^added ' | tr '\n' ' ')
  tag="ROLL $why${notes:+ ($notes)}"
  # a pull that failed on the head (its install, build or migration) fails the roll before the head starts, so it never runs on a stale dist
  [ "$pulled" -eq 0 ] && reload_if "$prev" "$tag" "$target" "$prev" "$mig"
  finish_roll "$tag" "$target" "$prev" "$mig" "$pulled"
  running=$(git rev-parse HEAD); last_roll=$(date +%s)
}
# Start and check the head a roll reset to ($2, tagged $1), and fall back to $3 when it fails or its pull failed ($5 non-zero), unless it migrated ($4)
finish_roll() {
  local tag=$1 target=$2 prev=$3 mig=$4 pulled=${5:-0}
  # a failed pull skips roll_up, so it writes the roll's FAIL line itself, which playground update reads before the FALLBACK
  [ "$pulled" -eq 0 ] || result "$tag $(git rev-parse --short HEAD) FAIL pull exited $pulled"
  if [ "$pulled" -eq 0 ] && roll_up "$tag"; then
    say "dashboard on $(git rev-parse --short HEAD)"   # 8 Oct: a passing roll needs no notice
  elif [ -n "$mig" ]; then
    tell_dispatcher "Dashboard roll to $(git rev-parse --short HEAD) FAILED after a migration; left on it for ops (see ops/dashboard/supervisor.log)"
    "$OPS/notify.sh" dashboard "roll to $(git rev-parse --short HEAD) failed after a migration; not falling back"
  else
    # bad-builds first: a supervisor the fallback reloads into keeps off the target at its start; a refusal dev_reason names is no bad build, but the head's own, its settings refusal (its env schema asks for what .env lacks), counts in refused, its third joining bad-builds
    # every other refusal is the machine's or the checkout's (the database, another stack, portless's proxy, whose `portless service install` needs the owner's sudo), so a retry each ROLL_GAP is all the supervisor can do, and a refusal no one listed stays out of bad-builds
    local refusal="" n note="not the head's, no bad build"
    [ "$pulled" -ne 0 ] || refusal=$(dev_reason 2>/dev/null < "$DEVLOG" | sed -n 's/^dev: refusing to start: //p')
    [ -n "$refusal" ] || [ "$pulled" -ne 0 ] || refusal=${guard_refusal:-}
    # a failed move is the machine's, and its reason goes first, since this line is the one playground update prints
    [ -z "${move_failure:-}" ] || [ "$pulled" -ne 0 ] || refusal="database move: $move_failure${refusal:+; $refusal}"
    if [ -z "$refusal" ]; then
      echo "$target" >> "$BAD"
    else
      if printf '%s' "$refusal" | grep -q "^the API's settings could not be read"; then
        echo "$target" >> "$S/refused"; n=$(grep -cx "$target" "$S/refused"); note="refusal $n of 3, no bad build"
        [ "$n" -lt 3 ] || { echo "$target" >> "$BAD"; note="refusal 3 of 3, so it joins bad-builds"; }
      fi
      result "$tag $(git rev-parse --short HEAD) FAIL dev refusing: $(printf '%s' "$refusal" | cut -c1-300) ($note)"
    fi
    stop_all
    "$D/redeploy-pull.sh" "$prev" >> "$LOG" 2>&1 && say "fell back to $(git rev-parse --short HEAD)"
    # the code running is the target's once its pull passed, and still the head before's when it failed
    reload_if "$([ "$pulled" -eq 0 ] && echo "$target" || echo "$prev")" FALLBACK "$target" "$prev"
    fall_back "$target" "$prev"
  fi
}
# a target the fallback left out of bad-builds was refused, which is no bad build
fall_back() {
  local failed=FAILED; grep -qx "$1" "$BAD" 2>/dev/null || failed="refused to start, which is no bad build"
  roll_up "FALLBACK" && tell_dispatcher "Dashboard roll to ${1:0:7} $failed; fell back to $(git rev-parse --short HEAD)" || tell_dispatcher "Dashboard roll to ${1:0:7} $failed and the fallback to ${2:0:7} failed too; ops is on it"
  "$OPS/notify.sh" dashboard "roll to ${1:0:7} failed; fell back to ${2:0:7}"
}
# At start: go on with the roll the last supervisor handed on, or else move to the upstream's head when it is new and not in bad-builds, and start
boot() {
  local was upstream out mig pulled
  # a handed-on roll is the checkout's own copy's to finish, so a copy outside it hands on again and leaves the file
  [ -s "$S/reload" ] && ! [ "$D" -ef "$WT/scripts/ops/dashboard" ] && { say "handing the pending roll on to $WT/scripts/ops/dashboard/"; exit 75; }
  if take_reload; then
    say "reloaded at $(git rev-parse --short HEAD): $r_tag"
    case "$r_tag" in
      START) roll_up START ;;
      FALLBACK) fall_back "$r_target" "$r_prev" ;;
      *) finish_roll "$r_tag" "$r_target" "$r_prev" "$r_mig" ;;
    esac
    return
  fi
  was=$(git rev-parse HEAD)
  upstream=$(upstream_head)
  [ -n "$upstream" ] && [ "$upstream" != "$was" ] && behind "$upstream" && say "$UPSTREAM ${upstream:0:7} is behind the running head ${was:0:7}; waiting"
  if [ ! -e "$S/paused" ] && [ -n "$upstream" ] && [ "$upstream" != "$was" ] && ! behind "$upstream" && ! grep -qx "$upstream" "$BAD" 2>/dev/null; then
    pull_to "$upstream" && [ "$pulled" -ne 0 ] && { finish_roll START "$upstream" "$was" "$mig" "$pulled"; return; }
  fi
  reload_if "$was" START
  roll_up START
}

# the clone's prebuild step, a job of this shell, is stopped by its pid, so run-slot ends its own command; the install and the build run in a subshell, which this trap waits out (bash defers it), while run.sh's group stop reaches the build's
trap 'say "supervisor stopping"; [ ! -s "$S/prebuild.pid" ] || kill -TERM "$(cat "$S/prebuild.pid")" 2>/dev/null; stop_all; exit 0' TERM INT HUP
rm -f "$S/prebuild.pid"

say "supervisor armed at $(git rev-parse --short HEAD)"
boot
running=$(git rev-parse HEAD); last_roll=$(date +%s); target=$running
while true; do
  # a background sleep and wait, so a signal runs its trap at once rather than after the sleep
  sleep 30 & wait $!
  parent=$(ps -o ppid= -p $$ | tr -d ' '); [ -n "$parent" ] && [ "$parent" != "$PPID" ] && { say "run.sh is gone; stopping"; stop_all; exit 0; }
  if [ -e "$S/paused" ]; then
    [ -z "${paused_said:-}" ] && say "paused: no rolls while $S/paused exists" && paused_said=1
  else
    paused_said=
    head=$(upstream_head)
    now=$(date +%s)
    if [ -n "$head" ] && [ "$head" != "$target" ]; then say "$UPSTREAM moved: ${target:0:7} -> ${head:0:7}"; target=$head; fi
    back=; [ -n "$head" ] && [ "$target" != "$running" ] && behind "$target" && back=1
    if [ -n "$back" ] && [ "${behind_said:-}" != "$target" ]; then say "$UPSTREAM ${target:0:7} is behind the running head ${running:0:7}; waiting"; behind_said=$target; fi
    if [ -n "$head" ] && [ -n "$target" ] && [ "$target" != "$running" ] && [ -z "$back" ] && ! grep -qx "$target" "$BAD" 2>/dev/null; then
      why="$UPSTREAM ${head:0:7}"
      if [ -e "$S/roll-now" ]; then
        rm -f "$S/roll-now"; say "roll-now: rolling to ${target:0:7} at once"
        roll_to "$target" "$why (roll-now)"; held_said=
      else
        idle=$(owner_idle); gap=$((now - last_roll)); db=up
        [ -n "$idle" ] || db=$(dashboard_db)
        if roll_due "$gap" "$idle" "$db"; then
          [ -n "$idle" ] || say "owner idle unread: rolling to ${target:0:7} on the gap alone"
          roll_to "$target" "$why"; held_said=
        elif [ "${held_said:-}" != "$target" ]; then
          say "roll to ${target:0:7} held: last roll ${gap}s ago (needs $ROLL_GAP), owner idle ${idle:-?}s (needs $OWNER_IDLE), dashboard db $db"; held_said=$target
        fi
      fi
    elif [ -n "$head" ] && [ -e "$S/roll-now" ]; then
      # nothing to roll to: answer the roll-now (playground update reads the line) and remove it, so it never lifts the next roll's holds
      rm -f "$S/roll-now"
      if [ "$target" != "$running" ] && [ -z "$back" ]; then result "SKIP ${target:0:7} FAIL ${target:0:7} failed its roll before (bad-builds)"; else result "CURRENT $(git rev-parse --short HEAD)"; fi
    fi
  fi
  if ! alive dashboard-dev; then
    result "DOWN dev: $(dev_down)"
    stop_all; roll_up RESTART
  elif ! alive dashboard-web; then
    result "DOWN web: $(tail -1 "$S/dashboard-web.log" 2>/dev/null | cut -c1-200)"
    stop_all; roll_up RESTART
  elif ! alive dashboard-ingest && setup_pending; then
    [ -n "${waiting_f:-}" ] || { say "follower: waiting for first run's setup, which writes POSTGRES_URL; not starting it"; waiting_f=1; }
  elif ! alive dashboard-ingest && { follower_held; held=$?; [ $held -ne 1 ]; }; then
    # a holder this supervisor did not start keeps its own code across rolls, so it is named once each time it appears; a status read past its wait leaves the follower as it is, since a restart would wait on the same database
    [ "${held_said_f:-}" = $held ] || { [ $held -eq 0 ] && say "follower: another importer holds the lock, a process this supervisor did not start; leaving it" || say "follower: bun run ingest status gave no answer in ${HELD_WAIT:-20}s; not restarting it"; held_said_f=$held; }
  elif ! alive dashboard-ingest; then
    held_said_f=
    if [ -n "${waiting_f:-}" ]; then
      waiting_f=; say "follower: first run's setup wrote POSTGRES_URL; starting it"; step=START
    else
      result "DOWN follower: $(tail -2 "$INGLOG" | tr '\n' ' ' | cut -c1-200)"; step=RESTART
    fi
    t=$(date -u +%Y-%m-%dT%H:%M:%S); start_follower; fol=$(check_follower "$t") && result "$step follower $fol" || result "FAIL follower $fol"
  else
    held_said_f=
  fi
  # while the proxy misses, the aliases read the same outage, so they wait for it to answer
  check_proxy && check_aliases
done
