import { afterAll, expect } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Subprocess } from "bun"

import { slowChild } from "../../slow-child"

// run-slot.sh's fakes and the scratch machine for the run-slot*.test.ts files, split so the parallel pass spreads them; test-sandbox's --parallel loads this afresh for each file, so the afterAll is that file's own
// Load is weighed by size, so a big plan never blocks small runs: small, medium and big weigh 1, 2 and 3.
export const SCRIPT = join(import.meta.dir, "../../../scripts/ops/run-slot.sh")
// run-slot.sh's line for a look that takes no slot
export const WAITING = /^run-slot\.sh: (queued behind|waiting for) /gm
// Stops a run whose verdict is already read: SIGTERM, then SIGKILL after 5s, since a waiter on GitHub's Linux runner outlived its SIGTERM by 24s for a cause not yet known and timed the test out
export const stop = async (p: Subprocess) => {
  p.kill("SIGTERM")
  if (await Promise.race([p.exited.then(() => true), Bun.sleep(5_000).then(() => false)])) return
  p.kill("SIGKILL")
  await p.exited
}

// Ubuntu 26.04's default mkdir, uutils 0.10.0, reports success when another process made the folder between its own check and its mkdir (fixed in uutils 0.11.0), so two looks could each take one of run-slot.sh's mkdir locks; the image keeps GNU's as gnumkdir, which fails there as the Mac's mkdir does, so a machine's fake bin runs that one where it exists
const GNU_MKDIR = Bun.which("gnumkdir")

// 7 Nov 00:38Z, issue 1316: five run-slot.sh processes from these fixtures outlived their tests, each with ppid 1, since a child left running when its test fails or times out is stopped by nothing. runSlot records every run-slot.sh child of these tests, and the file's afterAll ends each one still running, with the command it started, through endChildren. The child stays in the test run's own process group, so a TERM to the run (Ctrl-C, TaskStop, run-slot's trap, the sandbox's deadline) reaches it as canary's helper let it, ending it and, through its trap, its command.
type RunSlotOptions<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable,
> = Bun.SpawnOptions.SpawnOptions<In, Out, Err> & {
  ops?: string
}
const children: { p: { exited: Promise<number>; pid: number }; ops?: string; at: number }[] = []
// Starts `argv` recorded, so endChildren can end it; `ops` is the machine's ops folder, whose *.child files name the command's group once the run starts.
export const runSlot = <
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "inherit",
>(
  argv: string[],
  opts: RunSlotOptions<In, Out, Err> = {} as RunSlotOptions<In, Out, Err>,
): Bun.Subprocess<In, Out, Err> => {
  const { ops, ...spawnOpts } = opts
  const p = Bun.spawn<In, Out, Err>(argv, spawnOpts)
  children.push({ p, ops, at: Date.now() })
  return p
}
// Ends every recorded child still unreaped, with the command group it owns, on pass, fail and timeout alike: TERM first, which run-slot.sh's own trap turns on its command's group, then KILL after 5 s for what outlives it, as stop() does. A child that has ended is never signalled itself, since its pid may be anyone's on a Mac that wraps them in minutes. A *.child pid is signalled as a group only while the identity holds it is this run's own: still its runner's child leading its own group (the guard run-slot.sh's own preempt reads) while the runner lives, or, once the runner died without its trap, an orphan leading its own group that was already running when its *.child was written, since a stale or wrapped id passes neither.
export const endChildren = async () => {
  const exited = (p: { exited: Promise<number> }) =>
    Promise.race([p.exited.then(() => true), Bun.sleep(50).then(() => false)])
  const alive = (pid: number, group = false) => {
    try {
      process.kill(group ? -pid : pid, 0)
      return true
    } catch {
      return false
    }
  }
  const kill = (pid: number, group: boolean, sig: number | "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(group ? -pid : pid, sig)
    } catch {
      // it ended since the last look
    }
  }
  const live: { p: { exited: Promise<number> }; pid: number; groups: number[] }[] = []
  for (const child of children.splice(0)) {
    const done = await exited(child.p)
    const groups: number[] = []
    if (child.ops && existsSync(child.ops))
      for (const file of readdirSync(child.ops)) {
        if (!file.endsWith(".child")) continue
        const command = Number(readFileSync(join(child.ops, file), "utf8").trim())
        if (!(command > 1)) continue
        const written = statSync(join(child.ops, file)).mtimeMs
        if (written < child.at - 60_000) continue
        const [etime, ppid, pgid] = Bun.spawnSync([
          "ps",
          "-o",
          "etime=,ppid=,pgid=",
          "-p",
          String(command),
        ])
          .stdout.toString()
          .trim()
          .split(/\s+/)
        if (Number(pgid) !== command) continue
        // the process must have started no later than the .child was written, which run-slot.sh does right after its command: a reused pid started after the write, and a wrap puts one there in minutes
        const [days, rest] = etime.includes("-")
          ? [etime.split("-")[0]!, etime.split("-")[1]!]
          : ["0", etime]
        const started =
          Date.now() -
          (Number(days) * 86_400 + rest.split(":").reduce((s, n) => s * 60 + Number(n), 0)) * 1_000
        const runsIt = started <= written + 1_000
        if (done ? Number(ppid) === 1 && runsIt : Number(ppid) === child.p.pid) groups.push(command)
      }
    if (!done || groups.length > 0) live.push({ p: child.p, pid: child.p.pid, groups })
  }
  for (const { pid, groups } of live) {
    kill(pid, false, "SIGTERM")
    for (const gid of groups) kill(gid, true, "SIGTERM")
  }
  const left = async () =>
    (await Promise.all(live.map(async ({ p }) => !(await exited(p))))).some(Boolean) ||
    live.some(({ groups }) => groups.some((gid) => alive(gid, true)))
  const deadline = Date.now() + 5_000
  while ((await left()) && Date.now() < deadline) await Bun.sleep(50)
  if (await left())
    for (const { p, pid, groups } of live) {
      if (!(await exited(p))) kill(pid, false, "SIGKILL")
      for (const gid of groups) if (alive(gid, true)) kill(gid, true, "SIGKILL")
    }
  const end = Date.now() + 5_000
  while ((await left()) && Date.now() < end) await Bun.sleep(50)
}

export const dirs: string[] = []
// endChildren's own budget is 10 s at the worst (TERM grace, then KILL wait), so the hook takes 30 s rather than the 5 s default a hook without one reads
afterAll(async () => {
  await endChildren()
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
}, 30_000)

export type Setup = {
  // the core count sysctl's hw.ncpu reads
  cores?: number
  // disk0's transfers/s and MB/s in iostat's second sample
  disk?: [number, number]
  free?: number
  idle?: number
  load1?: number
  load5?: number
  mergeQueue?: unknown
  // the epoch second every `date` that names no time of its own reads, so a log line written seconds back keeps its age through every look; an age run-slot.sh reads from a file's real mtime (the queue's AGED pin, the switch expiry, a stale holder, the gauges cache) then reads below zero and never trips, so a test of one of those leaves it unset
  now?: number
  off?: string[]
  peers?: string[]
  plan?: unknown
  // the seconds between two looks of a waiting run (run-slot.sh's RUN_SLOT_POLL: 15 real for a queued run's looks, 5 for a clone's and an --after wait; 0.2 in the tests, 0.05 in the commit-lane files)
  poll?: number
  pressure?: number
  roster?: unknown
  sandboxed?: boolean
  swapins?: number
  topDelay?: number
}

// A scratch state folder and config folder, with a fake sysctl on PATH giving the load asked for (load5 and load15 as load1 unless given), the core count asked for (15 unless given) and normal memory, a fake uptime giving the same load, a fake top whose second sample reads the CPU idle share asked for, a fake vm_stat whose last row reads the swap-ins asked for, and a fake iostat whose second sample reads disk0's transfers/s and MB/s asked for; sandboxed, sysctl and ps refuse every read as Claude Code's sandbox does, so the load comes from uptime alone.
export const machine = ({
  cores = 15,
  disk = [120, 3.5],
  free = 80,
  idle = 80,
  load1 = 2,
  load5 = load1,
  mergeQueue,
  now,
  off = [],
  peers = [],
  plan,
  poll,
  pressure = 1,
  roster,
  sandboxed = false,
  swapins = 0,
  topDelay = 0,
}: Setup = {}) => {
  const root = mkdtempSync(join(tmpdir(), "run-slot-"))
  dirs.push(root)
  const ops = join(root, "ops")
  const config = join(root, "claude")
  const bin = join(root, "bin")
  for (const dir of [ops, join(config, "playground", "bundles"), bin])
    mkdirSync(dir, { recursive: true })
  for (const name of off) writeFileSync(join(ops, name), "")
  if (roster) writeFileSync(join(config, "playground", "roster.json"), JSON.stringify(roster))
  if (plan) writeFileSync(join(config, "playground", "bundles", "plan.json"), JSON.stringify(plan))
  if (mergeQueue)
    writeFileSync(join(config, "playground", "merge-queue.json"), JSON.stringify(mergeQueue))
  writeFileSync(
    join(bin, "sysctl"),
    `#!/bin/bash
echo "$2" >> ${join(root, "sysctl.log")}
${sandboxed ? 'echo "sysctl: sysctl fmt -1 1024 1: Operation not permitted" >&2; exit 1' : ""}
case "$2" in
  hw.ncpu) echo ${cores} ;;
  vm.loadavg) echo "{ ${load1.toFixed(2)} ${load5.toFixed(2)} ${load5.toFixed(2)} }" ;;
  kern.memorystatus_level) echo ${free} ;;
  kern.memorystatus_vm_pressure_level) echo ${pressure} ;;
esac
`,
  )
  chmodSync(join(bin, "sysctl"), 0o755)
  writeFileSync(
    join(bin, "uptime"),
    `#!/bin/bash\necho "22:15  2 users, load averages: ${load1.toFixed(2)} ${load5.toFixed(2)} ${load5.toFixed(2)}"\n`,
  )
  chmodSync(join(bin, "uptime"), 0o755)
  // top's first sample reads since boot and its second the last interval, as `top -l 2 -n 0` prints them, after topDelay seconds as the real one's samples take; each call is a line in top.log
  writeFileSync(
    join(bin, "top"),
    `#!/bin/bash\necho "$*" >> ${join(root, "top.log")}\n${topDelay ? `sleep ${topDelay}\n` : ""}echo "CPU usage: 1.00% user, 1.00% sys, 98.00% idle "\necho "CPU usage: ${((100 - idle) / 2).toFixed(2)}% user, ${((100 - idle) / 2).toFixed(2)}% sys, ${idle}% idle "\n`,
  )
  chmodSync(join(bin, "top"), 0o755)
  // vm_stat -c 2 1's first row counts since boot and its last the last second, as the real one prints them
  writeFileSync(
    join(bin, "vm_stat"),
    `#!/bin/bash\necho "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\necho "    free   active  pageins  pageout  swapins swapouts"\necho "  203349   476233   253407  3087181  4049933   116968"\necho "  194438   485624        0        0  ${swapins}        0"\n`,
  )
  chmodSync(join(bin, "vm_stat"), 0o755)
  // iostat -d -c 2 -w 1 disk0's first row counts since boot and its second the last second, as the real one prints them
  writeFileSync(
    join(bin, "iostat"),
    `#!/bin/bash\necho "              disk0 "\necho "    KB/t  tps  MB/s "\necho "   32.98 2576 82.98 "\necho "   30.00 ${disk[0]} ${disk[1].toFixed(2)} "\n`,
  )
  chmodSync(join(bin, "iostat"), 0o755)
  if (sandboxed) {
    writeFileSync(
      join(bin, "ps"),
      `#!/bin/bash\necho "bash: /bin/ps: Operation not permitted" >&2\nexit 126\n`,
    )
    chmodSync(join(bin, "ps"), 0o755)
  }
  // the settings reader answers factory.repo, the guarded orgs and slots.peers as a store that sets them would, and every other key as the real one does
  writeFileSync(
    join(bin, "bun"),
    `#!/bin/bash\n[ "$2" = factory.repo ] && { echo '"acme/app"'; exit 0; }\n[ "$2" = --guarded-orgs ] && { echo '["acme-co"]'; exit 0; }\n[ "$2" = slots.peers ] && { echo '${JSON.stringify(peers)}'; exit 0; }\nexec ${process.execPath} "$@"\n`,
  )
  chmodSync(join(bin, "bun"), 0o755)
  if (now !== undefined) {
    writeFileSync(
      join(bin, "date"),
      `#!/bin/bash\nfor a in "$@"; do case "$a" in -r*|-d*) exec ${Bun.which("date")} "$@" ;; esac; done\nexec ${Bun.which("date")} ${process.platform === "darwin" ? `-r ${now}` : `-d @${now}`} "$@"\n`,
    )
    chmodSync(join(bin, "date"), 0o755)
  }
  // SLOW_CHILD puts a slowed python3 in the fake bin folder, which PATH reads first
  slowChild("python3", bin)
  if (GNU_MKDIR) {
    writeFileSync(join(bin, "mkdir"), `#!/bin/bash\nexec ${GNU_MKDIR} "$@"\n`)
    chmodSync(join(bin, "mkdir"), 0o755)
  }
  const env = (extra: Record<string, string> = {}) => ({
    CLAUDE_CONFIG_DIR: config,
    PLAYGROUND_DATA_DIR: join(config, "playground"),
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    RUN_SLOT_OPS: ops,
    RUN_SLOT_POLL: poll === undefined ? "0.2" : String(poll),
    ...extra,
  })
  // A slot already held by this test's own process, which stays alive throughout, taken at `at`.
  const hold = (slot: string, units: number, size: string, at = "2026-10-18T19:00:00Z") => {
    mkdirSync(join(ops, slot))
    writeFileSync(
      join(ops, `${slot}.holder`),
      `worker-held ${process.pid} ${at} ${units} ${size}\n`,
    )
  }
  const release = (slot: string) => {
    rmSync(join(ops, slot), { force: true, recursive: true })
    rmSync(join(ops, `${slot}.holder`), { force: true })
  }
  // A waiter's ticket from a live process (this test's), as run-slot.sh writes one, its mtime `ago` seconds back.
  const ticket = (ns: number, who: string, line: string, ago = 0) => {
    mkdirSync(join(ops, "run-slot.waiters"), { recursive: true })
    const path = join(ops, "run-slot.waiters", `${ns}-${process.pid}-${who}`)
    writeFileSync(path, `${line}\n`)
    const at = Date.now() / 1000 - ago
    utimesSync(path, at, at)
  }
  const tickets = () =>
    existsSync(join(ops, "run-slot.waiters")) ? readdirSync(join(ops, "run-slot.waiters")) : []
  // Starts `touch <marker>` through run-slot (or the copy at `script`) in the background, reading its stderr as it comes. Each check waits on an event (the run's exit, a line it prints), never a wall-clock budget, so a loaded runner only makes it slower.
  // command: the words before the marker, which a fake bin in the machine's bin folder touches; touch by default; cwd: the folder it runs from, the scratch root by default
  const start = (
    who: string,
    extra: Record<string, string> = {},
    script = SCRIPT,
    command = ["touch"],
    cwd = root,
  ) => {
    const marker = join(root, `ran-${who}-${Math.random()}`)
    const p = runSlot(["bash", script, who, "--", ...command, marker], {
      cwd,
      env: env(extra),
      stderr: "pipe",
      ops,
    })
    let err = ""
    let ended = false
    void p.exited.then(() => (ended = true))
    const read = (async () => {
      const text = new TextDecoder()
      for await (const chunk of p.stderr) err += text.decode(chunk, { stream: true })
    })()
    const lines = (re: RegExp) => err.match(re)?.length ?? 0
    // whether `n` lines matching `re` arrived before it ended; `re` takes the g flag, since match without it returns one match's groups
    const saw = async (re: RegExp, n = 1) => {
      while (!ended && lines(re) < n) await Bun.sleep(20)
      if (ended) await read
      return lines(re) >= n
    }
    // whether it ran, read once it has ended
    const ran = async () => {
      await p.exited
      return existsSync(marker)
    }
    // whether it printed a waiting line, as a look that takes no slot does, and kept waiting through its first three looks without running; it is stopped then, and it needs a waiter that left a ticket, as every worker-* and ops-checks-* one does
    const waits = async () => {
      let waiting = await saw(WAITING)
      // a look removes at most one dead ticket in each of its two queue reads before it decides, so the fifth goes no earlier than the fourth look, after three looks decided to wait
      for (let i = 0; i < 5 && waiting; i++) waiting = await lookedAgain()
      waiting &&= !existsSync(marker)
      await stop(p)
      return waiting
    }
    // Puts a dead waiter's ticket at the queue's front (0-, before every ticket a test writes) and says whether this waiter, as the one live waiter left, removed it in a look and is still waiting, since a waiter behind the head looks when the oldest's pid has ended (issue 1338); false at once if it ends first, and a ticket that never goes (a run-slot.priority pick skips the queue reads) fails by the timeout, never as a pass
    const lookedAgain = async () => {
      const gone = Bun.spawn(["true"])
      await gone.exited
      const path = join(ops, "run-slot.waiters", `0-${gone.pid}-worker-gone`)
      writeFileSync(path, "s2 21 1 small\n")
      while (!ended && existsSync(path)) await Bun.sleep(20)
      return !ended && !existsSync(marker)
    }
    return { marker, p, ran, saw, stderr: () => err, waits }
  }
  const canTake = async (slot: string, who: string, extra: Record<string, string> = {}) => {
    const p = runSlot(["bash", SCRIPT, "can-take", slot, who], {
      cwd: root,
      env: env(extra),
      ops,
    })
    return (await p.exited) === 0
  }
  const size = async (who: string, extra: Record<string, string> = {}, cwd = root) => {
    const p = runSlot(["bash", SCRIPT, "size", who], {
      cwd,
      env: env(extra),
      stdout: "pipe",
      ops,
    })
    await p.exited
    return (await new Response(p.stdout).text()).trim()
  }
  // Runs `touch <marker>` through run-slot and reports whether it ran, or whether it waited on its first look
  const runs = (who: string, extra: Record<string, string> = {}) => start(who, extra).ran()
  const waits = (who: string, extra: Record<string, string> = {}) => start(who, extra).waits()
  // the times run-slot.sh has read the memory pressure level, which clone-off's gate reads once a check
  const pressureReads = () =>
    existsSync(join(root, "sysctl.log"))
      ? readFileSync(join(root, "sysctl.log"), "utf8")
          .split("\n")
          .filter((l) => l === "kern.memorystatus_vm_pressure_level").length
      : 0
  // Clones the folder named by `from` (relative to the scratch root) through run-slot and reports whether the copy landed (cp -R, since -c is the Mac's alone and the clone slot reads only cp and the path): once it ends, or once clone-off's gate has held it, since a clone it lets through reads the pressure level twice and goes on, and one it holds reads it again each RUN_SLOT_POLL.
  const clones = async (from: string, who = "worker-c", prefix: string[] = []) => {
    mkdirSync(join(root, "x", "node_modules"), { recursive: true })
    const to = `copy-${Math.random()}`
    const before = pressureReads()
    const p = runSlot(["bash", SCRIPT, who, "--", ...prefix, "cp", "-R", from, to], {
      cwd: from.startsWith("node_modules") ? join(root, "x") : root,
      env: env(),
      stderr: "ignore",
      ops,
    })
    let ended = false
    void p.exited.then(() => (ended = true))
    while (!ended && pressureReads() - before < 3) await Bun.sleep(20)
    if (!ended) await stop(p)
    return existsSync(join(from.startsWith("node_modules") ? join(root, "x") : root, to))
  }
  return {
    bin,
    canTake,
    clones,
    env,
    hold,
    ops,
    release,
    root,
    runs,
    size,
    start,
    ticket,
    tickets,
    waits,
  }
}

// each wait gives up at WITHIN_MS, just under bun's 60 s hang ceiling, or at the chain's end when given, failing with the bound it used, both queues' waiter names and the log's start lines, so a hang says what it waited on (issues 1723 and 1725: hangs that said nothing); a chain of waits shares one deadline(), since two chained waits of this budget can outlast the ceiling and the second wait's message would never fire
const WITHIN_MS = 45_000
// the one budget a chain of waits shares
export const deadline = () => ({ end: Date.now() + WITHIN_MS })
// a runs.log start line's who, pid and lane, or null when the line is not one; the one parser the wait messages and the rows read
export const startOf = (line: string): string[] | null => {
  const fields = line.split(" ")
  return fields[1] === "start" ? fields.slice(2, 5) : null
}
export const within = async (
  ok: () => boolean,
  what: string,
  m: { ops: string },
  chain?: { end: number },
) => {
  const from = Date.now()
  const end = chain ? chain.end : from + WITHIN_MS
  while (!ok() && Date.now() < end) await Bun.sleep(50)
  if (ok()) return
  const names = (dir: string) =>
    existsSync(join(m.ops, dir)) ? readdirSync(join(m.ops, dir)).sort() : []
  const waiters = [...names("run-slot.waiters"), ...names("run-slot.clone-waiters")]
  const starts = existsSync(join(m.ops, "run-slot.runs.log"))
    ? readFileSync(join(m.ops, "run-slot.runs.log"), "utf8")
        .split("\n")
        .map(startOf)
        .filter((f) => f !== null)
        .map((f) => f.join(" "))
    : []
  throw new Error(
    `${what} within ${Math.round((end - from) / 1000)}s; waiters: ${waiters.join(", ") || "none"}; starts: ${starts.join(", ") || "none"}`,
  )
}

// Playground's own lefthook.yml, whose pre-commit runs the build, as the commit-lane tests read it
export const LEFTHOOK = readFileSync(join(import.meta.dir, "../../../lefthook.yml"), "utf8")
// A machine whose fake git fails on a `-C` folder that is not one, answers `git config --get alias.<verb>` from a folder whose top level is the root by whether the root's `aliases` file lists that key, answers `git rev-parse --show-toplevel` with its folder's physical path, as git does (the root's, from `docs`, `web` or a folder under it), which holds `lefthook` unless it is null, `git diff --cached --name-only` with `staged`, a plain `git diff --name-only` with `unstaged`, a `git diff --name-only [HEAD] -- <paths>` with each of either under one of the paths (each pathspec read from the `-C` folder, `.` included), `git ls-files --others` with `untracked` (under the paths after a `--`, relative to a `-C` folder under the root unless `--full-name`, every one for `:/`, as git prints them), and touches its last argument for anything else, as a commit's marker
export const repo = (
  setup: Setup,
  staged: string[],
  unstaged: string[] = [],
  lefthook: string | null = LEFTHOOK,
  untracked: string[] = [],
) => {
  // the commit-lane rows wait often, so they look on a faster clock than the fake's 0.2
  const m = machine({ poll: 0.05, ...setup })
  if (lefthook !== null) writeFileSync(join(m.root, "lefthook.yml"), lefthook)
  writeFileSync(
    join(m.bin, "git"),
    `#!/bin/bash
[ "$1" = -C ] && { [ -d "$2" ] || exit 128; }
d=$PWD; [ "$1" = -C ] && d=$2
top() { (case "$1" in ${m.root}/web | ${m.root}/web/* | ${m.root}/docs) cd ${m.root} ;; *) cd "$1" ;; esac; pwd -P); }
case " $* " in *" config --get "*) [ "$(top "$d")" = "$(top ${m.root})" ] && grep -qxF -- "\${@: -1}" ${m.root}/aliases 2>/dev/null; exit ;; esac
case " $* " in *" rev-parse --show-toplevel "*) top "$d"; exit 0 ;; esac
pre=""; case "$d" in ${m.root}/*) pre=\${d#${m.root}/}/ ;; esac
full=""; case " $* " in *" --full-name "*) full=1 ;; esac
case " $* " in *" :/ "*) pre="" ;; esac
# whether path $2 is under pathspec $1, read from the folder, as git reads one
under() { local q=$pre$1; [ "$1" = . ] && q=\${pre%/}; [ -z "$q" ] || case "$2" in "$q" | "$q"/*) ;; *) return 1 ;; esac; }
case " $* " in
  *" ls-files "*" -- "*) while [ "$1" != -- ]; do shift; done; shift
    for f in ${untracked.join(" ")}; do for p in "$@"; do under "$p" "$f" && { [ -n "$full" ] && echo "$f" || echo "\${f#"$pre"}"; }; done; done; exit 0 ;;
  *" ls-files "*) for f in ${untracked.join(" ")}; do case "$f" in "$pre"*) [ -n "$full" ] && echo "$f" || echo "\${f#"$pre"}" ;; esac; done; exit 0 ;;
esac
for a in "$@"; do
  [ "$a" = diff ] || continue
  case " $* " in
    *" --cached "*) printf '%s\\n' ${staged.join(" ")} ;;
    *" -- "*) while [ "$1" != -- ]; do shift; done; shift
      for f in ${[...staged, ...unstaged].join(" ")}; do for p in "$@"; do under "$p" "$f" && echo "$f"; done; done ;;
    *) printf '%s\\n' ${unstaged.join(" ")} ;;
  esac
  exit 0
done
touch "\${@: -1}"
`,
  )
  chmodSync(join(m.bin, "git"), 0o755)
  return m
}
// a fake bun whose `turbo run build --dry=json` reads every task with the cache status given, or fails for null, passing anything else to the machine's own
export const turbo = (m: ReturnType<typeof machine>, status: string | null) => {
  renameSync(join(m.bin, "bun"), join(m.bin, "bun-machine"))
  const dry =
    status === null
      ? "exit 1"
      : `echo '{"tasks":[{"command":"next build","cache":{"status":"HIT"}},{"command":"tsc","cache":{"status":"${status}"}}]}'; exit 0`
  writeFileSync(
    join(m.bin, "bun"),
    `#!/bin/bash\ncase " $* " in *" turbo run build --dry=json "*) ${dry} ;; esac\nexec ${join(m.bin, "bun-machine")} "$@"\n`,
  )
  chmodSync(join(m.bin, "bun"), 0o755)
}
// a pre-commit step as commit-slot.ts hands it to run-slot, its last word the step's name (sh's $0), touching the marker the fake appends
export const step = (name: string) => ["sh", "-c", 'touch "$1"', name]
export const log = (m: ReturnType<typeof machine>) => {
  const path = join(m.ops, "run-slot.runs.log")
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}
// a quick lane's holder line, as run-slot writes one: who, pid and when, with no units
export const holdLane = (m: ReturnType<typeof machine>, lane: string, who: string) => {
  writeFileSync(join(m.ops, `${lane}.holder`), `${who} ${process.pid} 2026-11-03T06:41:00Z\n`)
  mkdirSync(join(m.ops, lane))
}
// starts a shell chain of git steps through run-slot, from a folder outside the repo's root unless `inRepo`, as the commit-lane chain tests read one
export const chainStart = (
  m: ReturnType<typeof machine>,
  steps: string,
  inRepo = false,
  shell = "sh",
) => {
  const outside = join(m.root, "outside")
  mkdirSync(outside, { recursive: true })
  return m.start(
    "worker-x",
    {},
    undefined,
    [shell, "-c", steps.replaceAll("ROOT", m.root)],
    inRepo ? m.root : outside,
  )
}
// the lane a chain on the closed list takes, read from its start line once it has run
export const chainLane = async (
  m: ReturnType<typeof machine>,
  steps: string,
  inRepo = false,
  shell = "sh",
) => {
  await chainStart(m, steps, inRepo, shell).p.exited
  return log(m).match(/ start worker-x \d+ (\S+) waited=/)?.[1]
}
// a `shell -c` chain whose ROOT words name the machine's root
export const chain = (m: ReturnType<typeof machine>, steps: string, shell = "sh") => [
  shell,
  "-c",
  steps.replaceAll("ROOT", m.root),
]
// the lane a run takes, read from its start line, or "waited" once it prints a waiting line, when it is stopped
export const takes = async (
  m: ReturnType<typeof machine>,
  argv: string[],
  cwd = join(m.root, "outside"),
  extra: Record<string, string> = {},
) => {
  mkdirSync(cwd, { recursive: true })
  const run = m.start("worker-x", extra, undefined, argv, cwd)
  if (await run.saw(WAITING)) {
    await stop(run.p)
    return "waited"
  }
  return log(m).match(/ start worker-x \d+ (\S+) waited=/)?.[1]
}

// what `run-slot.sh slots` prints on the machine: the count of run-slot to run-slot-4 held or open now, "4\n" with all four open and "1\n" with slots 2 to 4 shut
export const slots = (m: ReturnType<typeof machine>) =>
  Bun.spawnSync(["bash", SCRIPT, "slots"], { cwd: m.root, env: m.env() }).stdout.toString()
// run-slot.sh set's exit code and stderr on the machine
export const set = async (m: ReturnType<typeof machine>, ...args: string[]) => {
  const p = runSlot(["bash", SCRIPT, "set", ...args], {
    cwd: m.root,
    env: m.env(),
    stderr: "pipe",
    ops: m.ops,
  })
  return { code: await p.exited, err: await new Response(p.stderr).text() }
}

// the poll-cost files' shims, waiters and the trace readers that count what the waiters start
// every external command run-slot.sh calls by name; a shim for each counts its start, so a start the shims miss is a fork that runs bash alone, which the trace's subshell levels count
export const COMMANDS =
  "awk basename bun cat cut date diff dirname docker env find getconf git grep head id iostat ls mkdir mktemp mv nice ps python3 readlink realpath rm rmdir sed seq setsid sleep sort ssh stat sysctl tail timeout top touch tr uname uptime vm_stat wc xargs".split(
    " ",
  )

// shims ahead of the machine's PATH, each a perl script, which the waiters' xtrace leaves untraced, that writes its name to the count file and runs the command the machine's PATH finds
export const shim = (m: ReturnType<typeof machine>) => {
  const dir = join(m.root, "shims")
  const count = join(m.root, "starts")
  mkdirSync(dir)
  writeFileSync(count, "")
  const rest = m.env().PATH
  for (const name of COMMANDS) {
    writeFileSync(
      join(dir, name),
      `#!/usr/bin/perl\nopen(my $f, ">>", "${count}"); print $f "${name}\\n"; close $f;\n$ENV{PATH} = "${rest}";\nexec { "${name}" } "${name}", @ARGV or exit 127;\n`,
    )
    chmodSync(join(dir, name), 0o755)
  }
  return { count, path: `${dir}:${rest}` }
}
// starts a waiter under xtrace, its PS4 the subshell level, and keeps its stderr
export const waiter = (
  m: ReturnType<typeof machine>,
  path: string,
  who: string,
  command: string[],
  extra: Record<string, string>,
) => {
  const marker = join(m.root, `ran-${who}`)
  const p = runSlot(["bash", SCRIPT, who, "--", ...command, marker], {
    cwd: m.root,
    env: m.env({ ...extra, PATH: path, PS4: "+$BASH_SUBSHELL ", SHELLOPTS: "xtrace" }),
    stderr: "pipe",
    ops: m.ops,
  })
  const w = { err: "", marker, p }
  void (async () => {
    const text = new TextDecoder()
    for await (const chunk of p.stderr) w.err += text.decode(chunk, { stream: true })
  })()
  return w
}
export type Waiter = ReturnType<typeof waiter>
// whether the waiter has ended a look since `at` in its trace: a look_mark, then a sleep after it
export const lookedSince = (w: Waiter, at: number) =>
  /^\++\d+ look_mark$[\s\S]*^\+0 sleep \S+$/m.test(w.err.slice(at))
// the subshells a trace shows entered: each line at a deeper level than the line before it
export const subshells = (trace: string) => {
  let n = 0
  let last = 0
  for (const line of trace.split("\n")) {
    const level = line.match(/^\++(\d+) /)?.[1]
    if (level === undefined) continue
    if (Number(level) > last) n++
    last = Number(level)
  }
  return n
}
// whether a waiter has ended its last look: a sleep follows its last look_mark, or it has none (the clone loop never calls look_mark)
export const settled = (trace: string) => {
  const at = trace.lastIndexOf(" look_mark\n")
  return at < 0 || /^\+0 sleep \S+$/m.test(trace.slice(at))
}
// whether a whole poll ran in this part of a trace: a sleep, the wake after it, and the next sleep
export const polled = (trace: string) =>
  /^\+0 sleep \S+$[\s\S]*?^\+0 (?!sleep )[\s\S]*?^\+0 sleep \S+$/m.test(trace)
// the processes the waiters started together each second over `window` seconds, once each has printed its first wait line and then a round has passed that began with no look under way, in which each waiter ran a whole poll and none began a look, since a waiter whose first look ran before the others had joined looks once more at them; a fixed round of a poll and a second, 16 s at a 15 s poll, ended at load5 about 20 before a loaded Mac woke the waiters, so their look at the oldest's first run-slot.next landed in the window (issue 1612, measured)
export const starts = async (
  count: string,
  waiters: Waiter[],
  waits: RegExp,
  window: number,
  during: () => Promise<unknown> = async () => {},
) => {
  for (const w of waiters) while (!waits.test(w.err)) await Bun.sleep(50)
  for (let quiet = false; !quiet;) {
    const at = waiters.map((w) => w.err.length)
    const idle = waiters.every((w) => settled(w.err))
    while (!waiters.every((w, i) => polled(w.err.slice(at[i])))) await Bun.sleep(50)
    quiet = idle && waiters.every((w, i) => !/^\++\d+ look_mark$/m.test(w.err.slice(at[i])))
  }
  const from = waiters.map((w) => w.err.length)
  const before = readFileSync(count, "utf8").split("\n").length
  await Promise.all([Bun.sleep(window * 1000), during()])
  const execs = readFileSync(count, "utf8").split("\n").length - before
  const forks = waiters.reduce((n, w, i) => n + subshells(w.err.slice(from[i])), 0)
  const rate = (execs + forks) / window
  if (rate >= 5)
    console.error(
      "looks in the window:",
      waiters
        .map((w, i) => (w.err.slice(from[i]).match(/^\++\d+ look_mark$/gm) ?? []).length)
        .join(","),
    )
  await Promise.all(waiters.map((w) => stop(w.p)))
  expect(waiters.every((w) => !existsSync(w.marker))).toBe(true)
  return rate
}
