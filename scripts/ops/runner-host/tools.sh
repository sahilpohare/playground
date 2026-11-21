#!/bin/bash
# tools.sh: checks, as root, that an Actions runner VPS's runner user has what suite.sh's steps need: a full name for git, each tool on the PATH a
# run gets, and systemd-run for ci.sh's units. Prints `ok <what>` or `missing <what>` for each, and exits 1 when any is missing.
set -u
missing=0
check() { if eval "$2" > /dev/null 2>&1; then echo "ok $1"; else echo "missing $1"; missing=1; fi; }
as_runner() { runuser -u runner -- env -i HOME=/home/runner PATH=/home/runner/.bun/bin:/home/runner/.local/bin:/usr/bin:/bin bash -c "$1"; }
check "runner's full name, which git needs" '[ -n "$(getent passwd runner | cut -d: -f5 | cut -d, -f1)" ]'
for t in bun docker flock git go node tar timeout uv zsh; do check "$t" "as_runner 'command -v $t'"; done
check "docker for the runner user" "as_runner 'docker info'"
check systemd-run 'command -v systemd-run'
exit "$missing"
