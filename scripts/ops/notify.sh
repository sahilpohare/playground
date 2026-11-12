#!/usr/bin/env bash
# notify.sh <job> <text>: queue one line from an ops job for a session, ops by default or the session NOTIFY_TO names. It never
# types into any pane: text typed into a pane lands as a user turn and reads as the owner's, and nothing sends a message on the owner's behalf.
# A manager kind (builder, ops, planner, optimizer) or dispatcher, the primary, names whoever holds its seat, by roster.ts who, which falls back to sessions.names; the kind word itself when roster.ts fails.
# The line goes to alerts.log and to ops/outbox/ops-<job>.jsonl as {at, job, to, text}; the relay, runner-plain-relay, sends each
# queued line with SendMessage, so it arrives as a cross-session message from the relay.
case ${PLAYGROUND_DATA_DIR:-/} in /*) ;; *) echo "notify.sh: PLAYGROUND_DATA_DIR is relative ($PLAYGROUND_DATA_DIR), so each process would read it from its own folder: set it to an absolute path" >&2; exit 1 ;; esac
OPS=${PLAYGROUND_DATA_DIR:-$HOME/.playground}/ops
to="${NOTIFY_TO:-ops}"
case "$to" in
  builder | dispatcher | ops | optimizer | planner) seat=$to ;;
  *) seat= ;;
esac
# roster.ts sits beside the checkout's scripts/ops, so a call through the state folder's link (link-skills.sh) resolves the link first
[ -z "$seat" ] || to=$("$(command -v bun || echo "$HOME/.bun/bin/bun")" "$(dirname "$(readlink "$0" || echo "$0")")/../roster.ts" who "$to" 2>/dev/null) || to=$seat
case "$to" in *[!a-z0-9-]*|"") to=${seat:-ops} ;; esac
line=$(printf '%s' "$2" | tr '\r\n' '  ')
# NOTIFY_WHOLE=1: the line goes whole, as the channel watch's posts do (a runner's SendMessage carried them uncut); every other line stops at 400.
[ "$NOTIFY_WHOLE" = 1 ] || line=$(printf '%s' "$line" | cut -c1-400)
mkdir -p "$OPS/outbox"
# NOTIFY_PRIVATE=1: alerts.log names the line's length alone, as ops-wa sets for the owner's WhatsApp words, which stay out of every log.
logged=$line
[ "$NOTIFY_PRIVATE" != 1 ] || logged="(a private line of ${#line} characters)"
echo "$(date -u +%FT%TZ) [ops-$1 → $to] $logged" >> "$OPS/alerts.log"
# NOTIFY_MAC=1: the line also shows as a macOS banner, for what must reach the owner away from the Dashboard.
[ "$NOTIFY_MAC" != 1 ] || osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Playground"' -e 'end run' "$line" > /dev/null 2>&1
OUTBOX="$OPS/outbox" NOTIFY_JOB="$1" NOTIFY_TO_NAME="$to" NOTIFY_LINE="$line" python3 -I -c 'import json, os, time
rec = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "job": os.environ["NOTIFY_JOB"], "to": os.environ["NOTIFY_TO_NAME"], "text": os.environ["NOTIFY_LINE"]}
with open(os.path.join(os.environ["OUTBOX"], "ops-" + rec["job"] + ".jsonl"), "a") as f:
    f.write(json.dumps(rec) + "\n")'
