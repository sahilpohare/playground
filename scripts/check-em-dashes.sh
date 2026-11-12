#!/usr/bin/env bash
set -uo pipefail
# CLAUDE.md: no em-dashes in this repo's prose. Checks tracked and untracked (not
# ignored) files; a git or python error fails the check instead of passing it.
# Two uses are not prose and are skipped: inline code, and a table cell holding
# only an em-dash, the empty-cell marker in an output format the user specified.
# Core's vendored graphify and impeccable, and upstream/, hold upstream's bytes.
cd "$(dirname "$0")/.."
hits="$(git grep --untracked -n -I "$(printf '\xe2\x80\x94')" -- ':!package-lock.json' ':!extensions/core/skills/graphify' ':!extensions/core/skills/impeccable' ':!extensions/core/upstream')"
case $? in
  0) ;;
  1) echo "no em-dashes"; exit 0 ;;
  *) echo "em-dash check could not run (not a git checkout?)" >&2; exit 2 ;;
esac
prose="$(printf '%s\n' "$hits" | python3 -c '
import re, sys
dash = chr(0x2014)
for line in sys.stdin:
    _, _, rest = line.rstrip("\n").partition(":")
    _, _, text = rest.partition(":")
    if text.count("`") % 2 == 0:  # a stray backtick would make a code span swallow prose
        text = re.sub(r"`[^`]*`", "", text)
    text = re.sub(r"[|\u2502]\s*" + dash + r"\s*(?=[|\u2502])", "|", text)  # a Markdown or box-drawn cell holding only an em-dash
    if dash in text:
        print(line.rstrip("\n"))
')" || { echo "em-dash check could not run (python3 failed)" >&2; exit 2; }
if [ -n "$prose" ]; then
  printf '%s\n' "$prose"
  echo "em-dash found in prose: rewrite those sentences (see CLAUDE.md)" >&2
  exit 1
fi
echo "no em-dashes in prose"
