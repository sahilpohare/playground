#!/usr/bin/env bash
# The live dashboard's ops job outside any Claude session: supervisor.sh (dev + follower as its children, rolls each move
# of the branch upstream.sh names), the off-loopback Docker watch, and a notifier that tells Ops (notify.sh) only about a FAIL,
# DOWN or ANOMALY line in results.log, a watch alert, or the supervisor exiting. up.py runs it as a herdr pane's command, from the dashboard's
# checkout. It follows its terminal: on SIGHUP, or once its parent has exited (the pane is gone, as when its server stops), it stops its
# stack by the recorded process groups (procs.sh, never by name), so a detached stack never keeps the portless names.
D=$(cd "$(dirname "$0")" && pwd); OPS=$(dirname "$D")
# The data folder, as packages/env/src/data-dir.ts resolves it: PLAYGROUND_DATA_DIR, else ~/.playground
case ${PLAYGROUND_DATA_DIR:-/} in /*) ;; *) echo "run.sh: PLAYGROUND_DATA_DIR is relative ($PLAYGROUND_DATA_DIR), so each process would read it from its own folder: set it to an absolute path" >&2; exit 1 ;; esac
DATA=${PLAYGROUND_DATA_DIR:-$HOME/.playground}
S=$DATA/ops/dashboard; mkdir -p "$S"
touch "$S/results.log"; n=$(wc -l < "$S/results.log")
started=$(date -u +%FT%TZ)
# the traps come first, so a signal before the supervisor starts still runs stop()
stop() {
  trap '' TERM INT HUP
  echo "$(date -u +%FT%TZ) stopping: $1"
  kill -TERM -- "-$watch" 2>/dev/null; kill -TERM -- "-$sup" 2>/dev/null; wait "$sup" "$watch"
  "$D/procs.sh" stop dashboard-ingest; "$D/procs.sh" stop dashboard-dev; "$D/procs.sh" stop dashboard-web-next; "$D/procs.sh" stop dashboard-web
  python3 -I "$OPS/beat.py" ops-dashboard $$ "$started" 60 "loop exited: $1"
  [ "$1" = TERM ] || "$OPS/notify.sh" dashboard "ops-dashboard stopped its stack ($1); up.py starts it again in herdr"
  exit 0
}
trap 'stop TERM' TERM INT
trap 'stop HUP' HUP
set -m
bash "$D/supervisor.sh" &
sup=$!
(
  # $$ is run.sh's pid here too: the watch ends with run.sh, even one SIGKILLed past its trap (watch-stuck.py checks it each tick)
  while kill -0 $$ 2>/dev/null; do
    OPS_DASHBOARD_PID=$$ python3 -I "$D/watch-stuck.py" > /dev/null 2>&1; code=$?
    kill -0 $$ 2>/dev/null || break
    if [ "$code" -eq 0 ]; then
      "$OPS/notify.sh" stuck "$(bun --no-env-file "$D/alert-summary.ts" "$S/stuck-alert.json" 2>&1)"
    else
      "$OPS/notify.sh" stuck "watch-stuck.py exited $code; retrying in 5 min"
      for _ in $(seq 20); do kill -0 $$ 2>/dev/null || break 2; sleep 15; done
    fi
  done
) &
watch=$!
echo "$(date -u +%FT%TZ) dashboard supervisor pid $sup, watch pid $watch"
dashboard_result() { tail -1 "$S/results.log" | awk '{ if ($0 ~ / PASS / || $2 == "CURRENT" || (($2 == "RESTART" || $2 == "START") && $3 == "follower")) print "ok"; else { $1=""; print substr($0, 2, 100) } }'; }
notify_new() {
  m=$(wc -l < "$S/results.log")
  if [ "$m" -gt "$n" ]; then
    tail -n +"$((n + 1))" "$S/results.log" | head -n "$((m - n))" | grep -E ' (FAIL|DOWN|ANOMALY) ' | while read -r line; do "$OPS/notify.sh" dashboard "$line"; done
    n=$m
  fi
}
# One block, read whole before it runs, so a roll that rewrites this file never breaks the lines bash would read next
{
  while kill -0 "$sup" 2>/dev/null; do
    # a pid's parent changes only when that parent has exited (its herdr pane closed): launchd, or a subreaper, adopts it
    parent=$(ps -o ppid= -p $$ | tr -d ' '); [ -n "$parent" ] && [ "$parent" != "$PPID" ] && stop "terminal gone"
    python3 -I "$OPS/beat.py" ops-dashboard $$ "$started" 60 "$(dashboard_result)"
    # a background sleep and wait, so a signal runs its trap at once rather than after the sleep
    sleep 15 & wait $!
    notify_new
  done
  wait "$sup"; code=$?
  notify_new
  # 75: the supervisor rolled onto a head whose scripts/ops/dashboard/ differs from the code running, its API and follower down, so run that head's own
  if [ "$code" -eq 75 ]; then
    kill -TERM -- "-$watch" 2>/dev/null; wait "$watch"
    python3 -I "$OPS/beat.py" ops-dashboard $$ "$started" 60 "reloading $(git rev-parse --short HEAD)"
    echo "$(date -u +%FT%TZ) reloading on $PWD/scripts/ops/dashboard/run.sh"
    exec bash "$PWD/scripts/ops/dashboard/run.sh"
  fi
  python3 -I "$OPS/beat.py" ops-dashboard $$ "$started" 60 "supervisor exited"
  "$OPS/notify.sh" dashboard "supervisor exited; the dashboard may be down: restart $D/run.sh in its ops-dashboard workspace"
  kill -TERM -- "-$watch" 2>/dev/null
  exit
}
