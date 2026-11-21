import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-kill-by-name"

const root = join(import.meta.dir, "..", "..", "..")

const input = (command: string) =>
  JSON.stringify({
    cwd: root,
    hook_event_name: "PreToolUse",
    tool_input: { command },
    tool_name: "Bash",
  })
const bash = (command: string) => check(input(command))

describe("a signal sent by name or pattern is refused, with the way out", () => {
  test.each([
    "pkill -f 'watch-ci.sh 1a2b3c4'",
    "pkill node",
    "arr=($(pkill -f node))",
    "killall node",
    "/usr/bin/pkill -9 next-server",
    "\\pkill node",
    "timeout 5 pkill node",
    "echo stopping && pkill -f dev",
    "fuser -k 3000/tcp",
    "fuser --kill 3000/tcp",
    "pkill -f command -v",
    "pkill command -v",
    "killall command -V",
    "pkill -x command -V node",
    "pgrep -f watch; kill $!",
    "kill $(pgrep -f watch)",
    'kill -9 "$(pgrep -f watch)"',
    "kill -9 `pidof node`",
    "kill $(lsof -t -i :3000)",
    "pgrep -f watch | xargs kill",
    "pgrep -f watch | xargs -I{} kill -9 {}",
    "lsof -t -i :3000 | xargs kill -9",
    "ps aux | grep node | awk '{print $2}' | xargs kill",
    "pid=$(pgrep -f watch); kill $pid",
    "sh -c 'pkill node'",
    'bash -c "kill \\$(pgrep -f watch)"',
    'xargs kill <<< "$(pgrep -f watch)"',
    "xargs kill <<< $(pgrep -f watch)",
    "cat <(pgrep -f watch) | xargs kill",
    "while read p; do kill $p; done < <(pgrep -f watch)",
    "(pgrep -f watch) | xargs kill",
    "{ pgrep -f watch; } | xargs kill",
    "pgrep -f watch | xargs -I{} sh -c 'kill {}'",
    "ps -ef | grep watch | awk '{print $2}' | xargs kill",
    "~/.playground/ops/run-slot.sh w -- pkill -f watch",
    "~/.playground/ops/run-slot.sh w -- killall node",
    "~/.playground/ops/run-slot.sh w -- kill $(lsof -ti :3000)",
    "~/.playground/ops/run-slot.sh w -- pgrep -f watch | xargs kill",
    "bash ~/.playground/ops/run-slot.sh w -- pkill node",
    "sh ~/.playground/ops/run-slot.sh w -- killall node",
    "zsh ~/.playground/ops/run-slot.sh w -- kill $(lsof -ti :3000)",
    "pgrep -f watch | xargs ~/.playground/ops/run-slot.sh w -- kill",
    "lsof -ti :3000 | xargs ~/.playground/ops/run-slot.sh w -- kill -9",
    "pgrep -f watch | xargs -n1 ~/.playground/ops/run-slot.sh w -- kill",
    "pgrep -f watch | xargs bash ~/.playground/ops/run-slot.sh w -- kill",
    "pgrep -f watch | xargs sh ~/.playground/ops/run-slot.sh w -- kill",
    "pgrep -f watch | xargs -n1 bash ~/.playground/ops/run-slot.sh w -- kill",
    "pgrep -f watch | xargs zsh ~/.playground/ops/run-slot.sh w -- kill",
    "W=w; ~/.playground/ops/run-slot.sh $W -- pkill -f watch",
  ])("%s", async (command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-kill-by-name hook refuses")
    expect(reason).toContain("TaskStop")
    expect(reason).toContain("bun run dev:stop")
    expect(reason).toContain("kill <pid>")
  })
})

describe("a kill beside a search", () => {
  test("is told to run the stop in a call of its own", async () => {
    expect(await bash("pid=$(pgrep -f watch); kill $pid")).toContain("in a Bash call of its own")
  })
})

describe("a command built from a value the reader cannot read, in a call that names a kill", () => {
  // each program word is an expansion no reading resolves, so it may be any kill (#2136)
  test.each([
    '"$X" pkill -f watch',
    '$X"" pkill -f watch',
    '"$*" pkill -f watch',
    '"${X:-}" pkill -f watch',
    '"${@:-}" pkill -f watch',
    '"$1" pkill -f watch',
    "$((0)) pkill -f watch",
    "$X''$'' pkill -f watch",
    "${X^^} pkill -f watch",
    "${#X} pkill -f watch",
    "${X:-a} pkill -f watch",
    "${X:?} pkill -f watch",
    "for s in a b; do $s pkill -f watch; done",
    "getopts ab s; $s pkill -f watch",
    "printf -v s x; $s pkill -f watch",
    // #2244: a relative glob after a cd into a folder the reader cannot read may match any file there
    'cd "$X" && pk?ll -f watch',
  ])("%s is refused", async (command) => {
    expect(await bash(command)).toContain("a command built from a value it cannot read")
  })
})

describe("a signal to a pid you hold, and a read, pass", () => {
  test.each([
    "kill 1234",
    "kill -9 1234",
    "kill -TERM -4567",
    "kill -s TERM 1234",
    "kill $!",
    "kill %1",
    "kill $(cat ops/dashboard/dashboard-web.pid)",
    'kill "$(cat .pid)"',
    "pgrep -f watch",
    "pgrep -f watch | wc -l",
    "lsof -i :3000",
    "fuser 3000/tcp",
    "ps aux | grep node",
    "echo pkill node",
    "git log --grep=pkill",
    "grep -rn killall scripts",
    "PID=$(cat x.pid); ps -p $PID >/dev/null && kill $PID",
    "sleep 60 & pid=$!; ps -p $pid; kill $pid",
    "sleep 60 & pid=$!; ps -o pid= -p $pid && kill $pid",
    "command -v pkill",
    "echo $X",
    "git log $X",
    "for f in a b; do $f --version; done",
    "if true; then for s in a; do $s pkill -f watch; done; fi",
    "for s in a; do for t in b; do $t pkill -f watch; done; done",
    "select s in a; do $s pkill -f watch; done",
    "pkill --help",
    "killall -V",
    "sleep 60 & pid=$!; ps -q $pid && kill $pid",
    "sleep 60 & pid=$!; ps --pid $pid && kill $pid",
    "sleep 60 & pid=$!; ps --quick-pid $pid && kill $pid",
    "echo 1234 | xargs kill",
    "~/.playground/ops/run-slot.sh w -- kill 1234",
    "~/.playground/ops/run-slot.sh w -- kill $!",
    "~/.playground/ops/run-slot.sh w -- pkill --help",
    "~/.playground/ops/run-slot.sh w -- git commit -m 'no pkill here'",
    "~/.playground/ops/run-slot.sh w -- bun run test:file tests/scripts/hooks/no-kill-by-name.test.ts",
    "~/.playground/ops/run-slot.sh w -- pgrep -f watch",
    "echo 1234 | xargs ~/.playground/ops/run-slot.sh w -- kill",
    "echo 1234 | xargs bash ~/.playground/ops/run-slot.sh w -- kill",
    "pgrep -f watch | xargs ~/.playground/ops/run-slot.sh w -- sh -c 'kill 1234'",
    "P=1234; kill $P",
    'C="kill 1234"; $C',
    "W=w; ~/.playground/ops/run-slot.sh $W -- kill 1234",
    // #2161's controls: a variable set once to one word with no later change, and one changed only after its use
    "X=a; $X pkill -f watcher",
    "X=a; $X pkill -f watcher; unset X",
    "X=a; $X pkill -f watcher; read X < /dev/null",
    // #2136's controls: a program word the reader resolves, and an expansion used only as an argument
    "C=echo; $C pkill -f watcher",
    'A=(echo pkill -f watcher); "${A[@]}"',
    'A=(agent-browser --session w); "${A[@]}" open about:blank; kill 1234',
    "S='echo pkill'; eval \"$S\"",
    "S='echo pkill'; sh -c \"$S\"",
    "for c in echo; do $c pkill -f watcher; done",
    'echo "$X" pkill',
    'kill "$PID"',
    // #2244's controls: a glob used only as an argument, a program word with no glob, a glob that matches no file, which keeps its typed word, and a glob in a quoted expansion, which the shell does not match
    "ls /usr/bin/pk?ll",
    "/usr/bin/pgrep -f watcher",
    "/no/such/folder/pk?ll -f watcher",
    'X=/usr/bin; "$X/pk?ll" -f watcher',
    // #2259's controls: a brace list or zsh group used only as an argument, a commit subject holding (…), a quoted or escaped brace the shell does not expand, and a brace list in a comment
    "ls /usr/bin/{pkill,ls}",
    "echo {a,b} && ls",
    "git commit -m 'fix(PG-1): pkill (a|b) watcher'",
    'pk"{i,x}"ll -f watcher',
    "/usr/bin/pk\\{i,x}ll -f watcher",
    "echo hi # /usr/bin/pk{i,x}ll -f watcher",
    "touch f{1..3}.txt",
    // a zsh group holding an extended glob character used only as an argument, and one in a program word that spells no kill
    "ls /usr/bin/pk(i|^x)ll",
    "/usr/bin/pg(r|^x)ep -f watcher",
    // a bare * names no program, so a case arm the reader takes for a program word passes
    'cd x && for f in *.ts; do case "$f" in *" a "*) ;; esac; done',
  ])("%s", async (command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test("leaves another tool alone", async () => {
    const raw = JSON.stringify({
      tool_input: { file_path: "/tmp/x", content: "pkill node" },
      tool_name: "Write",
    })
    expect(await check(raw)).toBeUndefined()
  })
})
