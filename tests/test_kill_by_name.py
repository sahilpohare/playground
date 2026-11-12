#!/usr/bin/env python3
"""Nothing in the repo signals processes it chose by name, pattern or port.

A pattern matches the live dashboard and every worker's stack: on 2026-10-06 a review subagent
SIGKILLed every pid named turbo on the machine and took the live dashboard down. A port is no
narrower: whoever holds the proxy's port is the proxy every worktree routes through. The allowed way is
pids from your own process tree: a child you spawned, its process group, or TaskStop for a
background task. So no text file in the repo (scripts, tests, skills, docs) may:

- run pkill, killall, fkill, `fuser -k` or kill-port, as a command or a spawned argv
- feed kill the pids pgrep, pidof, ps or lsof found: `... | xargs kill`, `kill $(...)`, a
  loop over them (`for p in $(...)`, `... | while read p`, `while read p ... done < <(...)`)
  that kills, or a variable or array holding them (`PIDS=$(...)`, `mapfile -t PIDS < <(...)`)
  that later reaches kill
- walk processes with psutil, or call os.kill or process.kill in a file that runs pgrep,
  pidof or `lsof -t` to find pids

Reading pids (`pgrep -f x` to check something runs) stays allowed. Markdown prose is read
as prose: a line holding `kill-check: names only` is skipped, and backticks are inline code,
not command substitution. Fenced and indented blocks are code like any script, and so is
what an inline code span holds, for loops and captures. A loop's extent is read with its
strings and comments blanked, so a "do" or "done" in them does not end it; its kill is read
with only comments blanked, so `sh -c "kill $p"` counts. CHANGELOG.md is skipped: it records
commit subjects. The no-kill-by-name hook, its test and the refused-forms fixture are
skipped too, since they hold the commands it refuses as data. So is guards.js, the bundle
that holds the hook beside every other Bash guard.

Run: python3 tests/test_kill_by_name.py
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SELF = os.path.relpath(os.path.abspath(__file__), ROOT)
SKIP = {
    "CHANGELOG.md",
    "scripts/hooks/bundled/guards.js",
    "scripts/hooks/no-kill-by-name.ts",
    "tests/scripts/hooks/no-kill-by-name.test.ts",
}
# The refused-forms fixture's folder, one file a source, skipped whole.
SKIP_DIRS = ("tests/scripts/hooks/fixtures/refused-forms/",)
NAMES_ONLY = "kill-check: names only"
SEARCH = r"(?:pgrep|pidof|ps|lsof)"
SOURCE = rf"(?:\$\(|<\(|`)\s*{SEARCH}\b"
BY_NAME = re.compile(r"(?:^|[\s`$(;&|'\"\[/])(?:pkill|killall|fkill(?:-cli)?)(?=[\s'\"`,\]]|$)")
BY_PORT = re.compile(r"\bfuser\b[^|;\n]*\s(?:-[a-zA-Z]*k|--kill)\b|\bkill-port\b")
PIPED = re.compile(rf"\b{SEARCH}\b[^\n]*\|\s*xargs\b[^|\n]*\bkill\b")
SUBSTITUTED = re.compile(rf"\bkill\b[^|\n]*(?:\$\(|`)\s*{SEARCH}\b")
SUBSTITUTED_MD = re.compile(rf"\bkill\b[^|\n]*\$\(\s*{SEARCH}\b")
FOR_SEARCH = re.compile(rf"\bfor\s+\w+\s+in\s+{SOURCE}")
WHILE_SEARCH = re.compile(rf"\b{SEARCH}\b[^\n]*\|\s*while\s+read\b")
WHILE_READ = re.compile(r"\bwhile\s+read\b")
# lsof yields pids under -t, alone or in a cluster (-ti:3000); -sTCP and -iTCP carry no lowercase t
LSOF_PIDS = r"lsof\b[^)\n]*?\s['\"]?-[a-zA-Z]*t[a-zA-Z]*"
# a captured search yields pids only from pgrep, pidof, `lsof -t` or a filtered ps; `cwd=$(lsof -a -p "$p" -d cwd)` reads a directory
PID_SEARCH = rf"(?:pgrep|pidof)\b|{LSOF_PIDS}|ps\b[^)\n]*\|"
CAPTURED = re.compile(
    rf"""\b(\w+)=["'(]?\s*(?:\$\(|<\(|`)\s*(?:{PID_SEARCH})"""
    rf"""|\b(?:mapfile|readarray)\s+(?:-\w+\s+)*(\w+)\s*<\s*<\(\s*(?:{PID_SEARCH})"""
    rf"""|\bread\s+-\w*a\w*\s+(\w+)\s*<<<\s*["']?(?:\$\(|`)\s*(?:{PID_SEARCH})"""
)
PSUTIL = re.compile(r"\bprocess_iter\b|\bpsutil\.pids\b")
# in Markdown, backticks are inline code rather than a command or an argv
SEARCH_ARGV = re.compile(rf"""['"`](?:pgrep|pidof)\b|['"`]{LSOF_PIDS}""")
SEARCH_ARGV_MD = re.compile(rf"""['"](?:pgrep|pidof)\b|['"]{LSOF_PIDS}""")
KILL_CALL = re.compile(r"""\b(?:os\.kill(?:pg)?|process\.kill|syscall\.Kill)\(|['"`]kill\b""")
KILL_CALL_MD = re.compile(r"""\b(?:os\.kill(?:pg)?|process\.kill|syscall\.Kill)\(|['"]kill\b""")
FENCE = re.compile(r"^\s*(```|~~~)")


def blank(text, strings=True):
    """The text with every # comment, and unless strings is False every quoted string, turned to spaces; lengths and lines are kept. A # inside a string is no comment either way."""
    def spaces(match):
        if not strings and not match.group(0).startswith("#"):
            return match.group(0)
        return re.sub(r"[^\n]", " ", match.group(0))
    return re.sub(r"""(?m)"(?:\\.|[^"\\\n])*"|'[^'\n]*'|(?:^|(?<=\s))#[^\n]*""", spaces, text)


INLINE_CODE = re.compile(r"`([^`\n]+)`")
LIST_ITEM = re.compile(r"\s*(?:[-*+]|\d+[.)])\s")


def code_of(rel, text):
    """The text read as code, and the numbers of its lines that are code blocks.

    A script is code throughout. In Markdown, fenced blocks and indented blocks are code
    lines; a prose line keeps only what its inline code spans hold, in place, the rest
    blanked, so a one-line recipe in backticks is read like a script.
    """
    if not rel.endswith((".md", ".mdx")):
        return text, set(range(1, text.count("\n") + 2))
    lines, block_lines = [], set()
    fenced = indented = False
    # the column an indented code block starts at: 4, or within a list the item's content column plus 4
    block_column = 4
    previous_blank = True
    for n, line in enumerate(text.splitlines(), 1):
        if FENCE.match(line):
            fenced = not fenced
            lines.append("")
            previous_blank = False
            continue
        if not fenced:
            width = len(line.expandtabs(4)) - len(line.expandtabs(4).lstrip())
            item = LIST_ITEM.match(line)
            if item and not indented:
                block_column = len(item.group(0).expandtabs(4)) + 4
            elif line.strip() and width == 0:
                block_column = 4
            starts_block = previous_blank and line.strip() and width >= block_column and not item
            indented = bool(starts_block or (indented and (not line.strip() or width >= block_column)))
        if fenced or indented:
            lines.append(line)
            block_lines.add(n)
        elif NAMES_ONLY in line:
            lines.append("")
        else:
            spans = re.sub(r"[^\n]", " ", line)
            for span in INLINE_CODE.finditer(line):
                spans = spans[:span.start(1)] + span.group(1) + spans[span.end(1):]
            lines.append(spans)
        previous_blank = not line.strip()
    return "\n".join(lines), block_lines


def commands(text):
    """Each line with its number, a command continued by a trailing backslash, |, && or || joined into its first line."""
    joined, start = "", 0
    for n, line in enumerate(text.splitlines(), 1):
        if not joined:
            start = n
        stripped = line.rstrip()
        if stripped.endswith("\\"):
            joined += stripped[:-1] + " "
            continue
        if stripped.endswith(("|", "&&", "||")):
            joined += stripped + " "
            continue
        yield start, joined + line
        joined = ""
    if joined:
        yield start, joined


def line_of(text, index):
    return text.count("\n", 0, index) + 1


def loop_end(blanked, start):
    """Where the loop from start ends: after the done that closes its own do, nested loops counted, read in blanked text; start when it never closes."""
    depth = 0
    for keyword in re.finditer(r"\b(do|done)\b", blanked[start:]):
        depth += 1 if keyword.group(1) == "do" else -1
        if depth == 0:
            return start + keyword.end()
    return start


def problems_in(rel, text):
    markdown = rel.endswith((".md", ".mdx"))
    code, block_lines = code_of(rel, text)
    found = []
    for n, line in commands(text):
        prose = markdown and n not in block_lines
        if prose and NAMES_ONLY in line:
            continue
        substituted = SUBSTITUTED_MD if prose else SUBSTITUTED
        if BY_NAME.search(line):
            found.append(f"{rel}:{n}: runs pkill, killall or fkill, which signal every process a name matches")
        elif BY_PORT.search(line):
            found.append(f"{rel}:{n}: kills whatever holds a port, which may be another stack or the shared proxy")
        elif PIPED.search(line) or substituted.search(line):
            found.append(f"{rel}:{n}: kills the pids a search by name or pattern found")
    # strings and comments are blanked to find where a loop ends; only comments, to find a kill, since `sh -c "kill $p"` kills
    blanked = blank(code)
    uncommented = blank(code, strings=False)
    kills = lambda start, end: re.search(r"\bkill\b", uncommented[start:end])

    def reach(start):
        """How far a loop or capture from start may read: the whole code, or its own line when it sits in a prose span, so later paragraphs' spans never join it."""
        if markdown and line_of(code, start) not in block_lines:
            line_end = code.find("\n", start)
            return len(code) if line_end < 0 else line_end
        return len(code)

    for start in [m.start() for m in [*FOR_SEARCH.finditer(code), *WHILE_SEARCH.finditer(code)]]:
        end = loop_end(blanked[:reach(start)], start)
        if kills(start, end):
            found.append(f"{rel}:{line_of(code, start)}: kills inside a loop over the pids a search found")
    for loop in WHILE_READ.finditer(code):
        limit = reach(loop.start())
        end = loop_end(blanked[:limit], loop.start())
        fed = code[end:limit][:200]
        if end > loop.start() and re.match(rf"\s*<\s*<\(\s*{SEARCH}\b", fed) and kills(loop.start(), end):
            found.append(f"{rel}:{line_of(code, loop.start())}: kills inside a loop over the pids a search found")
    for capture in CAPTURED.finditer(code):
        # a capture reads on past its line, since a later step's `kill $PIDS` is specific enough; only its loops keep to their line
        var = re.escape(next(group for group in capture.groups() if group))
        used = rf"\$\{{?{var}\b"
        rest, rest_quiet = code[capture.end():], uncommented[capture.end():]
        reaches = any(re.search(used, line) and re.search(r"\bkill\b", quiet)
                      for line, quiet in zip(rest.splitlines(), rest_quiet.splitlines()))
        for loop in re.finditer(rf"\bfor\s+\w+\s+in\s+\"?{used}", rest):
            start = capture.end() + loop.start()
            reaches = reaches or bool(kills(start, loop_end(blanked[:reach(start)], start)))
        if reaches:
            found.append(f"{rel}:{line_of(code, capture.start())}: kills the pids a search stored in ${var}")
    for walk in PSUTIL.finditer(code):
        found.append(f"{rel}:{line_of(code, walk.start())}: walks processes with psutil to pick some to signal")
    search_argv, kill_call = (SEARCH_ARGV_MD, KILL_CALL_MD) if markdown else (SEARCH_ARGV, KILL_CALL)
    if search_argv.search(text) and kill_call.search(text):
        found.append(f"{rel}:{line_of(text, kill_call.search(text).start())}: kills in a file that searches for pids with pgrep, pidof or lsof -t")
    return found


def self_test():
    """The patterns flag what they must and pass what they must, so a quiet scan means something."""
    bad = [
        ("run.sh", 'pkill -f "turbo run dev"'),
        ("run.sh", "killall node"),
        ("run.sh", "/usr/bin/pkill -f turbo"),
        ("run.sh", "/usr/bin/killall bun"),
        ("run.sh", "npx fkill turbo"),
        ("run.sh", "pkill -f turbo  # kill-check: names only"),
        ("run.sh", "pgrep -f next-server | xargs kill -9"),
        ("run.sh", "pgrep -f portless | xargs -n1 kill"),
        ("run.sh", "ps aux | grep turbo | awk '{print $2; }' | xargs kill"),
        ("run.sh", "kill -9 $(pgrep -f turbo)"),
        ("run.sh", "kill -s TERM $(pgrep x)"),
        ("run.sh", "kill `pidof bun`"),
        ("doc.md", "`kill -9 $(lsof -t -i:3000)`"),
        ("run.sh", "fuser -k 3000/tcp"),
        ("run.sh", "fuser --kill 3000/tcp"),
        ("run.sh", "npx kill-port 3000"),
        ("run.sh", 'for p in $(pgrep -f "turbo run dev|next dev"); do\n  cwd=$(lsof -a -p "$p" -d cwd)\n  kill -9 "$p"\ndone'),
        ("run.sh", 'for p in $(pgrep x); do echo "done"; kill $p; done'),
        ("run.sh", "for p in $(pgrep x); do\n  for q in a b; do echo $q; done\n  kill $p\ndone"),
        ("run.sh", "pgrep -f x | while read pid; do kill $pid; done"),
        ("run.sh", "pgrep -f x |\n  while read pid; do\n    kill $pid\n  done"),
        ("run.sh", "while read pid; do kill $pid; done < <(pgrep -f x)"),
        ("run.sh", "PIDS=$(pgrep -f x)\nkill $PIDS"),
        ("run.sh", 'PIDS="$(pgrep -f turbo)"\nkill $PIDS'),
        ("run.sh", "PIDS=$(pgrep -f x)\necho $PIDS | xargs kill"),
        ("run.sh", 'mapfile -t pids < <(pgrep -f x)\nkill "${pids[@]}"'),
        ("run.sh", "PIDS=$(lsof -t -i:3000)\nkill $PIDS"),
        ("run.sh", "PIDS=$(ps -eo pid,comm | awk '/turbo/ {print $1}')\nkill $PIDS"),
        ("run.sh", 'PIDS=$(pgrep -f x)\nfor p in $PIDS; do\n  kill "$p"\ndone'),
        ("run.ts", 'Bun.spawnSync(["pkill", "-f", "turbo"])'),
        ("run.py", 'subprocess.run(["killall", "bun"])'),
        ("run.py", "for proc in psutil.process_iter():\n    proc.kill()"),
        ("run.py", "from psutil import process_iter\nfor p in process_iter():\n    p.kill()"),
        ("run.py", 'pids = subprocess.check_output(["pgrep", "-f", "x"]).split()\nfor pid in pids:\n    os.kill(int(pid), 9)'),
        ("run.ts", 'const out = Bun.spawnSync(["pgrep", "-f", "turbo"]).stdout\nfor (const p of out) process.kill(Number(p))'),
        ("run.ts", 'const p = execSync("lsof -t -i:3000").toString()\nprocess.kill(+p)'),
        ("run.sh", "pgrep -f turbo \\\n  | xargs kill"),
        ("run.sh", "pgrep -f turbo |\n  xargs kill"),
        ("run.sh", 'for p in $(pgrep x); do echo "nothing to do here"; kill $p; done'),
        ("run.sh", 'for p in $(pgrep x); do echo "all done now"; kill $p; done'),
        ("run.sh", 'pgrep -f x | while read pid; do echo "we do it"; kill $pid; done'),
        ("run.sh", 'for p in $(pgrep x); do\n  # skip the proxy, do not kill it\n  [ "$p" = "$PROXY" ] && continue\n  kill $p\ndone'),
        ("run.sh", "PIDS=$(lsof -ti:3000)\nkill $PIDS"),
        ("run.py", "pids = subprocess.check_output(['lsof', '-ti:3000']).split()\nos.kill(int(pids[0]), 9)"),
        ("run.ts", 'const p = Bun.spawnSync(["lsof", "-ti:3000"]).stdout\nprocess.kill(Number(p))'),
        ("run.sh", 'pids=($(pgrep -f turbo))\nkill "${pids[@]}"'),
        ("run.sh", 'read -ra pids <<< "$(pgrep -f turbo)"\nkill "${pids[@]}"'),
        ("doc.md", "```bash\nkill -9 `pgrep -f turbo`\n```"),
        ("doc.md", "```bash\npkill -f turbo  # kill-check: names only\n```"),
        ("run.ts", 'const pids = execSync("pgrep -f x")\nexecSync(`kill ${pids}`)'),
        ("main.go", 'out, _ := exec.Command("pgrep", "x").Output()\nsyscall.Kill(pid, 9)'),
        ("run.sh", "npx fkill-cli turbo"),
        ("doc.md", "Stop them with `for p in $(pgrep -f turbo); do kill $p; done`."),
        ("doc.md", "`pgrep -f turbo | while read p; do kill $p; done`"),
        ("doc.md", "`while read p; do kill $p; done < <(pgrep -f turbo)`"),
        ("doc.md", "`PIDS=$(pgrep -f turbo); kill $PIDS`"),
        ("doc.md", "`PIDS=$(pgrep -f turbo)`, then run `kill $PIDS`"),
        ("doc.md", '`mapfile -t p < <(pgrep -f turbo); kill "${p[@]}"`'),
        ("doc.md", "- `for p in $(pgrep -f turbo); do kill $p; done`"),
        ("doc.md", "Run this:\n\n    for p in $(pgrep -f turbo); do kill $p; done\n"),
        ("run.sh", 'for p in $(pgrep x); do sh -c "kill -9 $p"; done'),
        ("run.sh", 'PIDS=$(pgrep -f x)\nsh -c "kill $PIDS"'),
        ("run.sh", 'PIDS=$(pgrep -f x)\ntrap "kill $PIDS" EXIT'),
        ("doc.md", "1. Find them: `PIDS=$(pgrep -f turbo)`\n2. Stop them: `kill $PIDS`"),
        ("doc.md", "Save them with `PIDS=$(pgrep -f turbo)`.\n\nThen run `kill $PIDS`."),
        ("doc.md", "1. `PIDS=$(pgrep -f turbo)`\n2. `for p in $PIDS; do kill $p; done`"),
        ("doc.md", '- `mapfile -t p < <(pgrep -f turbo)`\n- `kill "${p[@]}"`'),
        ("doc.md", "- Stop it:\n\n      for p in $(pgrep -f turbo); do kill $p; done\n"),
    ]
    good = [
        ("run.sh", 'kill -TERM "$PID"'),
        ("run.sh", 'kill -- -"$PGID"'),
        ("run.sh", "pgrep -f turbo"),
        ("run.sh", "ps -o ppid= -p $$"),
        ("run.sh", "lsof -nP -iTCP:443 -sTCP:LISTEN -t"),
        ("run.ts", 'process.kill(-child.pid, "SIGTERM")'),
        ("run.ts", "turbo.kill(signal)"),
        ("run.py", "os.kill(proc.pid, signal.SIGTERM)"),
        ("run.ts", 'const cwd = Bun.spawnSync(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"])\nprocess.kill(-pgid, "SIGTERM")'),
        ("doc.md", "Signal only processes you started; never select pids by name or pattern."),
        ("run.sh", 'for p in $(pgrep -f turbo); do echo "$p"; done'),
        ("doc.md", "skills/kill-check.md and a skillful killer"),
        ("doc.md", "man1/pkill.1.html"),
        ("doc.md", "Never reach for pkill or fuser -k here. <!-- kill-check: names only -->"),
        ("doc.md", "Don't kill anything; run `ps` to look."),
        ("run.sh", 'cwd=$(lsof -a -p "$PID" -d cwd -Fn)\necho "stopping $PID ($cwd)" && kill -TERM "$PID"'),
        ("doc.md", "Read with `pgrep -f x`, never to kill.\nStop your child with `process.kill(-child.pid)`."),
        ("run.sh", 'while read l; do kill "$MY_CHILD"; done < pidfile\nwhile read p; do echo $p; done < <(pgrep -f x)'),
        ("doc.md", "Read `PIDS=$(pgrep -f x)` only to look.\n\n```bash\nls\n```\n\nNever kill $PIDS by hand."),
        ("doc.md", "- a list item\n\n    - a nested item that names `for p in $(pgrep -f x); do echo $p; done`"),
        ("doc.md", "The old recipe ran `for p in $(pgrep -f x); do kill -9 $p; done`, which matched every stack. <!-- kill-check: names only -->"),
        ("doc.md", "Never `PIDS=$(pgrep -f x)` then `kill $PIDS`. <!-- kill-check: names only -->"),
        ("doc.md", "Not `psutil.process_iter()` either. <!-- kill-check: names only -->"),
        ("doc.md", "- an item\n\n    Run `PIDS=$(pgrep -f x)` to list them; never kill $PIDS."),
        ("doc.md", "- an item\n\n    Never kill a pid that `pgrep` printed."),
        ("doc.md", "A loop starts `for p in $(pgrep -f x)`.\n\nLater, `do` this, then `kill` that, and `done`."),
        ("doc.md", "1. `PIDS=$(pgrep -f turbo)` lists them.\n2. `kill $CHILD` stops your own."),
        ("run.sh", "for x in $(pgrep -f a); do echo $x; done\nThe killer docs are done."),
    ]
    wrong = [f"not flagged: {line!r}" for rel, line in bad if not problems_in(rel, line)]
    wrong += [f"flagged: {line!r}" for rel, line in good if problems_in(rel, line)]
    return wrong


def main():
    wrong = self_test()
    for line in wrong:
        print(f"FAIL self-test {line}")
    files = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard"],
                           cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines()
    checked = 0
    failures = []
    for rel in files:
        path = os.path.join(ROOT, rel)
        if rel in SKIP or rel.startswith(SKIP_DIRS) or rel == SELF or os.path.islink(path) or not os.path.isfile(path):
            continue
        try:
            text = open(path, encoding="utf-8").read()
        except UnicodeDecodeError:
            continue
        checked += 1
        failures += problems_in(rel, text)
    for failure in failures:
        print(f"FAIL {failure}")
    total = len(wrong) + len(failures) + (0 if checked else 1)
    print(f"{'PASS' if not total else 'FAIL'} {checked} files checked, {len(failures)} kills by name, pattern or port")
    print("FAILURES:", total)
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
