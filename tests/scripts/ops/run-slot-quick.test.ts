import { describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { SCRIPT, WAITING, runSlot, stop, machine } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang: 60s, twice the slowest case under SLOW_CHILD=1.5 but local CI's, which sets its own
setDefaultTimeout(60_000)

// review round 1: a big run let every smaller run pass it, so it could wait all night; the held run here took its slot after the ticket, a passer, so it alone keeps the ticket out (issue 1216: one held from before the ticket lets a run that fits pass, run-slot-one-gate.test.ts)
describe("a waiter that has waited 20 minutes", () => {
  const held = () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 1, "small", `${new Date().toISOString().slice(0, 19)}Z`)
    return m
  }

  test("lets no newer run pass it while only the runs that passed it keep it out", async () => {
    const m = held()
    m.ticket(1, "worker-big", "s2 23 3 big", 21 * 60)
    expect(await m.waits("worker-m", { RUN_SLOT_SIZE: "medium" })).toBe(true)
  })

  test("while one that has waited less lets a run that fits go", async () => {
    const m = held()
    m.ticket(1, "worker-big", "s2 23 3 big", 19 * 60)
    expect(await m.runs("worker-m", { RUN_SLOT_SIZE: "medium" })).toBe(true)
  })
})

// dispatcher, 18 Oct: a waiter started before a run-slot change kept the old copy's rules
describe("a waiter whose script is replaced", () => {
  test("runs the new copy with its own arguments and leaves its ticket", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 3, "big")
    const copy = join(m.root, "run-slot.sh")
    copyFileSync(SCRIPT, copy)
    const waiter = m.start("worker-m", { RUN_SLOT_SIZE: "medium" }, copy)
    while (!m.tickets().some((t) => t.endsWith("-worker-m"))) await Bun.sleep(50)
    const out = join(m.root, "reexec")
    writeFileSync(`${copy}.new`, `#!/bin/bash\nprintf '%s\\n' "$@" > ${out}\n`)
    renameSync(`${copy}.new`, copy)
    expect(await waiter.p.exited).toBe(0)
    expect(readFileSync(out, "utf8")).toBe(`worker-m\n--\ntouch\n${waiter.marker}\n`)
    expect(m.tickets()).toEqual([])
  })

  // review round 4: the new copy takes the first ask's time, so the runs log has one ask and the whole wait
  test("its wait is logged as one ask", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 3, "big")
    const copy = join(m.root, "run-slot.sh")
    copyFileSync(SCRIPT, copy)
    const waiter = m.start("worker-m", { RUN_SLOT_SIZE: "medium" }, copy)
    while (!m.tickets().some((t) => t.endsWith("-worker-m"))) await Bun.sleep(50)
    copyFileSync(SCRIPT, `${copy}.new`)
    renameSync(`${copy}.new`, copy)
    // the log's waited= counts whole seconds, so the wait lasts at least one
    await Promise.all([waiter.saw(/running the new copy/g), Bun.sleep(1_000)])
    m.release("run-slot")
    expect(await waiter.ran()).toBe(true)
    const log = readFileSync(join(m.ops, "run-slot.runs.log"), "utf8")
    expect(log.match(/ ask worker-m /g)).toHaveLength(1)
    expect(log).toMatch(/ start worker-m \d+ run-slot(-\d)? waited=[1-9]\d*s\n/)
  })
})

// builder, 18 Oct (a review): a clone named without a folder before node_modules missed clone-off, which passes at load1 and load5 under 30 and spawn.sh's memory gate
describe("a node_modules clone waits while clone-off stands", () => {
  const off = ["run-slot.clone-off"]
  for (const from of ["x/node_modules", "node_modules", "node_modules/", "./node_modules"])
    test(from, async () => {
      expect(await machine({ off, pressure: 4 }).clones(from)).toBe(false)
    })

  test("and the machine is loaded", async () => {
    expect(await machine({ load1: 30, off }).clones("node_modules")).toBe(false)
  })

  // optimizer, 19 Oct 03:42Z: a clone let through at load5 under 30 took load1 to 73
  test("and load1 is 30 while load5 is under it", async () => {
    expect(await machine({ load1: 30, load5: 2, off }).clones("node_modules")).toBe(false)
  })

  test("behind env and VAR=x words", async () => {
    expect(
      await machine({ off, pressure: 4 }).clones("node_modules", "worker-c", ["env", "X=1"]),
    ).toBe(false)
  })

  test("but goes on normal pressure and load1 and load5 under 30", async () => {
    expect(await machine({ load1: 29, load5: 2, off }).clones("node_modules")).toBe(true)
  })

  test("and on warn pressure with 8% free", async () => {
    expect(await machine({ free: 8, off, pressure: 2 }).clones("node_modules")).toBe(true)
  })

  test("but holds on warn pressure with 7% free", async () => {
    expect(await machine({ free: 7, off, pressure: 2 }).clones("node_modules")).toBe(false)
  })

  test("and runs once it is gone", async () => {
    expect(await machine().clones("node_modules")).toBe(true)
  })

  test("but for a session clone-allow's patterns name", async () => {
    const m = machine({ off, pressure: 4 })
    writeFileSync(join(m.ops, "run-slot.clone-allow"), "tester-.*\n")
    expect(await m.clones("node_modules", "tester-sloth")).toBe(true)
    expect(await m.clones("node_modules", "worker-c")).toBe(false)
  })

  test("and under Claude Code's sandbox, whose memory reads empty, it holds and says so once a run", async () => {
    const m = machine({ off, sandboxed: true })
    mkdirSync(join(m.root, "node_modules"))
    const run = m.start("worker-c", {}, SCRIPT, ["cp", "-R", "node_modules"])
    const said =
      /^run-slot\.sh: cannot read the memory \(sysctl kern\.memorystatus_\*\), so run-slot\.clone-off holds this clone /gm
    expect(await run.saw(said)).toBe(true)
    // each look reads the free share once, so five reads are four looks after the line
    const reads = () =>
      readFileSync(join(m.root, "sysctl.log"), "utf8")
        .split("\n")
        .filter((l) => l === "kern.memorystatus_level").length
    while (reads() < 5) await Bun.sleep(20)
    await stop(run.p)
    expect(await run.saw(said, 2)).toBe(false)
    expect(await run.ran()).toBe(false)
  })
})

// 6 Nov, 02:45Z: one clone drove fseventsd to 226% CPU, load1 from 29 to 32.5 and load5 to 15.8, which engaged the load brake
describe("a node_modules clone waits for its spacing", () => {
  const SPACED = /^run-slot\.sh: this clone waits /gm
  // whether the clone waited (printed its spacing line and had not run when stopped) or ran
  const clone = async (m: ReturnType<typeof machine>, who = "worker-c") => {
    mkdirSync(join(m.root, "node_modules"), { recursive: true })
    const run = m.start(who, {}, SCRIPT, ["cp", "-R", "node_modules"])
    if (await run.saw(SPACED)) {
      await stop(run.p)
      return existsSync(run.marker) ? "ran" : "waited"
    }
    return (await run.ran()) ? "ran" : "ended"
  }
  const iso = (ago: number) => new Date(Date.now() - ago * 1000).toISOString().slice(0, 19) + "Z"
  // a runs log whose last clone ended `ago` seconds back, or whose run on `slot` did
  const ended = (m: ReturnType<typeof machine>, ago: number, slot = "run-slot-clone") =>
    writeFileSync(
      join(m.ops, "run-slot.runs.log"),
      `${iso(ago + 30)} start worker-a 111 ${slot} waited=0s\n${iso(ago)} end worker-a 111 rc=0 ran=30s\n`,
    )

  test("within the gap of the last clone's end", async () => {
    const m = machine()
    ended(m, 60)
    expect(await clone(m)).toBe("waited")
  })

  test("but starts once the gap has passed", async () => {
    const m = machine()
    ended(m, 400)
    expect(await clone(m)).toBe("ran")
  })

  test("and a run on another slot that ended within the gap holds no clone", async () => {
    const m = machine()
    ended(m, 60, "run-slot")
    expect(await clone(m)).toBe("ran")
  })

  // the owner's load rule, 5 Nov: load5 under the core count, one per core
  test("while load5 is within 4 of the brake, one per core", async () => {
    expect(await clone(machine({ cores: 8, load1: 2, load5: 4 }))).toBe("waited")
  })

  test("but starts under it", async () => {
    expect(await clone(machine({ cores: 8, load1: 2, load5: 3 }))).toBe("ran")
  })

  // with 4 cores or fewer the brake minus 4 is 0 or less, which would hold every clone, so the line keeps a floor of half the cores
  test("and on 4 cores a clone at low load starts", async () => {
    expect(await clone(machine({ cores: 4, load1: 1, load5: 1 }))).toBe("ran")
  })

  test("while one at half the cores waits", async () => {
    expect(await clone(machine({ cores: 4, load1: 2, load5: 2 }))).toBe("waited")
  })

  // 6 Nov, 06:52Z to 07:03Z: a run-slot.load5-cap of 1, set to shut lane 2, held every clone, since the brake read that cap
  test("and run-slot.load5-cap moves no clone: a cap of 1 still lets one start under the brake", async () => {
    const m = machine({ load1: 2, load5: 10 })
    writeFileSync(join(m.ops, "run-slot.load5-cap"), "1\n")
    expect(await clone(m)).toBe("ran")
  })

  test("while one within 4 of the brake still waits under that cap", async () => {
    const m = machine({ load1: 2, load5: 11 })
    writeFileSync(join(m.ops, "run-slot.load5-cap"), "1\n")
    expect(await clone(m)).toBe("waited")
  })

  // under Claude Code's sandbox sysctl is refused, so the brake falls back to this Mac's 15 cores
  test("and a core count it cannot read is 15: within 4 of it waits", async () => {
    expect(await clone(machine({ load1: 2, load5: 11, sandboxed: true }))).toBe("waited")
  })

  test("and under it starts", async () => {
    expect(await clone(machine({ load1: 2, load5: 10, sandboxed: true }))).toBe("ran")
  })

  test("while a big run holds a lane", async () => {
    const m = machine()
    m.hold("run-slot-3", 3, "big")
    expect(await clone(m)).toBe("waited")
  })

  test("but starts beside a medium run", async () => {
    const m = machine()
    m.hold("run-slot-3", 2, "medium")
    expect(await clone(m)).toBe("ran")
  })

  test("and starts at once with neither hold standing", async () => {
    expect(await clone(machine())).toBe("ran")
  })

  test("and a session clone-allow names keeps its pass past clone-off", async () => {
    const m = machine({ off: ["run-slot.clone-off"], pressure: 4 })
    writeFileSync(join(m.ops, "run-slot.clone-allow"), "tester-.*\n")
    expect(await clone(m, "tester-sloth")).toBe("ran")
  })
})

// A fake git and bun on PATH touch their last argument, so a run through run-slot shows whether it ran while a big run holds the queue's units.
// a lane question read from run-slot's own pick, with nothing run: a replay of the runs log's commands must never execute them
test("run-slot.sh kind prints the lane a command takes and runs nothing", async () => {
  const m = machine()
  const kind = async (words: string[]) => {
    const p = runSlot(["bash", SCRIPT, "kind", "--", ...words], {
      cwd: m.root,
      env: m.env(),
      stdout: "pipe",
      ops: m.ops,
    })
    expect(await p.exited).toBe(0)
    return (await new Response(p.stdout).text()).trim()
  }
  expect(await kind(["cp", "-R", "node_modules", join(m.root, "made")])).toBe("clone")
  expect(await kind(["touch", join(m.root, "made")])).toBe("")
  // issue 1722: env's no-argument flags and the VAR=x words before it wrap the command, so the lane and size read the command itself
  expect(await kind(["env", "-i", "X=Y", "bun", "install"])).toBe("quick")
  // review round 1: a run run-slot refuses reads as refuse, a dev stack's among them
  expect(await kind(["bun", "run", "dev"])).toBe("refuse")
  // a chain's git steps take the commit lane only in a repo, so these name a throwaway one: kind runs nothing, but the lane decision reads the named repo's index and lefthook.yml, and naming this checkout let a staged packages/ file answer for it (issue 1487)
  const repo = join(m.root, "repo")
  mkdirSync(repo)
  expect(Bun.spawnSync(["git", "-C", repo, "init"]).exitCode).toBe(0)
  for (const shell of ["sh", "dash", "ksh"])
    expect([
      shell,
      await kind([shell, "-c", `git -C ${repo} commit -m x; git -C ${repo} push origin`]),
    ]).toEqual([shell, "commit"])
  expect(existsSync(join(m.root, "made"))).toBe(false)
  expect(existsSync(join(m.ops, "run-slot.runs.log"))).toBe(false)
  expect(existsSync(join(m.ops, "run-slot.waiters"))).toBe(false)
})

describe("a quick run takes its own slot past a full queue", () => {
  // Runs argv through run-slot past a full queue and says whether it ran: once it ends, or once it prints the queue's waiting line, when it is stopped (an event, never a clock, so a loaded runner only makes it slower)
  // ran: the seconds each earlier run of the same command took, oldest first, as run-slot.runs.log records them
  // the slot the last quick() run took, from its runs log's start line, and what it printed on stderr
  let took = ""
  let said = ""
  // as: the run's session name and env words, and whether a CPU-queue waiter's ticket stands ahead of it
  const quick = async (
    argv: string[],
    ran: number[] = [],
    as: { env?: Record<string, string>; log?: string; waiter?: boolean; who?: string } = {},
  ) => {
    const who = as.who ?? "worker-q"
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 3, "big")
    if (as.waiter) m.ticket(1, "worker-w", "s2 23 3 big")
    // each fake touches its last word; git answers rev-parse, as a repo's folder does
    for (const bin of ["bun", "git"]) {
      writeFileSync(
        join(m.bin, bin),
        '#!/bin/bash\ncase " $* " in *" rev-parse "*) exit 0 ;; esac\ntouch "${@: -1}"\n',
      )
      chmodSync(join(m.bin, bin), 0o755)
    }
    // ROOT in a word stands for the machine's folder
    argv = argv.map((a) => a.replaceAll("ROOT", m.root))
    // the marker is the line's last word, a test file under the repo's tests/ folder, since only such a word counts toward the quick rule's files
    mkdirSync(join(m.root, "tests"))
    const marker = "tests/a.test.ts"
    writeFileSync(
      join(m.ops, "run-slot.runs.log"),
      as.log ??
        ran
          .map(
            (s, i) =>
              `2026-10-31T10:00:0${i}Z ask worker-q ${900 + i} ${[...argv, marker].join(" ")}\n2026-10-31T10:00:0${i}Z ask worker-r ${800 + i} bun run lint\n2026-10-31T10:01:0${i}Z end worker-r ${800 + i} rc=0 ran=1s\n2026-10-31T10:01:0${i}Z end worker-q ${900 + i} rc=0 ran=${s}s\n`,
          )
          .join(""),
    )
    const p = runSlot(["bash", SCRIPT, who, "--", ...argv, marker], {
      cwd: m.root,
      env: m.env({ RUN_SLOT_SIZE: "medium", ...as.env }),
      stderr: "pipe",
      ops: m.ops,
    })
    let err = ""
    let ended = false
    void p.exited.then(() => (ended = true))
    void (async () => {
      const text = new TextDecoder()
      for await (const chunk of p.stderr) err += text.decode(chunk, { stream: true })
    })()
    while (!ended && !err.match(WAITING)) await Bun.sleep(20)
    if (!ended) await stop(p)
    said = err
    took =
      readFileSync(join(m.ops, "run-slot.runs.log"), "utf8")
        .split("\n")
        .find((l) => l.split(" ")[1] === "start" && l.split(" ")[2] === who)
        ?.split(" ")[4] ?? ""
    return existsSync(join(m.root, marker))
  }

  // optimizer, 19 Oct: a commit run as env NODE_ENV=... git commit waited 14 min in the queue
  test("git commit", async () => {
    expect(await quick(["git", "commit"])).toBe(true)
  })

  test("env NODE_ENV=x git commit", async () => {
    expect(await quick(["env", "NODE_ENV=x", "git", "commit"])).toBe(true)
  })

  // optimizer, 20 Oct: a 1s git merge waited 26.6 min behind suites
  test("git merge", async () => {
    expect(await quick(["git", "-C", "x", "merge"])).toBe(true)
  })

  test("git pull", async () => {
    expect(await quick(["git", "pull"])).toBe(true)
  })

  // run-slot.runs.log, 20 Oct: docs:wrap and format:check ran 2s and 9s at most
  test("bun run docs:wrap", async () => {
    expect(await quick(["bun", "run", "docs:wrap"])).toBe(true)
  })

  test("bun run --cwd=<dir> format:check", async () => {
    expect(await quick(["bun", "run", "--cwd=x", "format:check"])).toBe(true)
  })

  test("but not another bun run script", async () => {
    expect(await quick(["bun", "run", "build"])).toBe(false)
  })

  // retro 2, 31 Oct: 408 of 686 CPU-lane runs ended in 10 s or less and queued 2,004 min against 17 min of running
  test("bun install --ignore-scripts", async () => {
    expect(await quick(["bun", "install", "--ignore-scripts"])).toBe(true)
    expect(took).toBe("run-slot-quick")
  })

  // PG-1344: a full install ran 1.9 to 3.3 s on a warm cache, its root scripts included, and waited 3 to 6 min in the queue
  test("and so does a bun install that runs its scripts", async () => {
    expect(await quick(["bun", "install"])).toBe(true)
    expect(took).toBe("run-slot-quick")
  })

  // a new worktree installs by path, a line no earlier run shares, so the rule, not ran_short, takes it there
  test("and one with --cwd", async () => {
    expect(await quick(["bun", "install", "--cwd", "/x/worktrees/a"])).toBe(true)
    expect(took).toBe("run-slot-quick")
  })

  test("and one with --frozen-lockfile", async () => {
    expect(await quick(["bun", "install", "--frozen-lockfile"])).toBe(true)
    expect(took).toBe("run-slot-quick")
  })

  test("and a bun --cwd=<dir> install", async () => {
    expect(await quick(["bun", "--cwd=/x/worktrees/a", "install"])).toBe(true)
    expect(took).toBe("run-slot-quick")
  })

  // a bare --cwd before install is no install: bun 1.4.4 runs that shape as package.json's install script (Script not found "install"), as it misreads one before test; it still runs as a light run, on the queue's small share
  test("but a bun --cwd <dir> install, which bun runs as package.json's install script, takes the queue", async () => {
    expect(await quick(["bun", "--cwd", "/x/worktrees/a", "install"])).toBe(true)
    expect(took).toBe("run-slot-2")
  })

  test("and an env NODE_ENV=x bun install takes run-slot-quick", async () => {
    expect(await quick(["env", "NODE_ENV=x", "bun", "install"])).toBe(true)
    expect(took).toBe("run-slot-quick")
  })

  // install after another subcommand is that subcommand's word: a script named install, or a package bunx runs
  test("but a bun run install takes the queue", async () => {
    expect(await quick(["bun", "run", "install"])).toBe(true)
    expect(took).toBe("run-slot-2")
  })

  test("and so does a bun x install", async () => {
    expect(await quick(["bun", "x", "install"])).toBe(true)
    expect(took).toBe("run-slot-2")
  })

  test("git push", async () => {
    expect(await quick(["git", "-C", "x", "push", "-u", "origin"])).toBe(true)
    expect(took).toBe("run-slot-commit")
  })

  test("a command whose last 3 runs each ended in 10 s or less", async () => {
    expect(await quick(["bun", "run", "build"], [400, 2, 10, 3])).toBe(true)
    expect(took).toBe("run-slot-quick")
  })

  test("but not one with 2 runs on record", async () => {
    expect(await quick(["bun", "run", "build"], [2, 3])).toBe(false)
  })

  // the bound on a long run after short ones: it holds the one quick slot, and its own time sends the next run of its command back to the queue
  test("nor one whose last run took over 10 s", async () => {
    expect(await quick(["bun", "run", "build"], [2, 3, 4, 11])).toBe(false)
  })

  // 1 Nov: a two-file test:file line ran 37, 36, 33, 39, 421 and 226 s back to back in the one quick slot, and the quick lane's waiters waited 63 min in the hour from 12:00Z
  test("a quick-rule line whose last 3 runs each took over 60 s goes to the queue", async () => {
    expect(await quick(["bun", "run", "test:file", "tests/b.test.ts"], [39, 421, 226, 61])).toBe(
      false,
    )
  })

  test("but one whose last 3 runs each took exactly 60 s still takes quick", async () => {
    expect(await quick(["bun", "run", "test:file", "tests/b.test.ts"], [60, 60, 60])).toBe(true)
    expect(took).toBe("run-slot-quick")
  })

  test("but one with a short run among its last 3 still takes quick", async () => {
    expect(
      await quick(["bun", "run", "test:file", "tests/b.test.ts"], [37, 36, 33, 39, 421, 226]),
    ).toBe(true)
    expect(took).toBe("run-slot-quick")
  })

  // issue 1242: run-slot.runs.log since 5 Nov held 19 quick runs of 188 to 857 s, each a new line naming a slow file beside others, which the line's own history never saw
  // runs: [command, lane, seconds] for each earlier run, oldest first, as run-slot.runs.log's ask, start and end lines record them
  const history = (runs: [string, string, number][]) =>
    runs
      .map(
        ([line, lane, s], i) =>
          `2026-10-31T10:0${i}:00Z ask worker-p ${700 + i} ${line}\n2026-10-31T10:0${i}:00Z start worker-p ${700 + i} ${lane} waited=0s\n2026-10-31T10:0${i}:30Z end worker-p ${700 + i} rc=0 ran=${s}s\n`,
      )
      .join("")
  test("a new line naming a file that ran long in a quick run goes to the queue", async () => {
    const log = history([["bun run test:file tests/slow.test.ts", "run-slot-quick", 400]])
    expect(await quick(["bun", "run", "test:file", "tests/slow.test.ts"], [], { log })).toBe(false)
  })

  test("while a line whose files all ran short takes quick", async () => {
    const log = history([
      ["bun run test:file tests/b.test.ts", "run-slot-quick", 5],
      ["bun run test:file tests/a.test.ts tests/c.test.ts", "run-slot-quick", 8],
    ])
    expect(await quick(["bun", "run", "test:file", "tests/b.test.ts"], [], { log })).toBe(true)
    expect(took).toBe("run-slot-quick")
  })

  test("and a file's long quick run counts only within its last 3 runs", async () => {
    const log = history([
      ["bun run test:file tests/slow.test.ts", "run-slot-quick", 400],
      ["bun run test:file tests/slow.test.ts tests/c.test.ts", "run-slot-2", 9],
      ["bun run test:file tests/slow.test.ts tests/d.test.ts", "run-slot-2", 9],
      ["bun run test:file tests/slow.test.ts tests/e.test.ts", "run-slot-2", 9],
    ])
    expect(await quick(["bun", "run", "test:file", "tests/slow.test.ts"], [], { log })).toBe(true)
  })

  // issue 1507: 3 big heavy runs that name a slow file pushed its long quick run out of the file history, and the file returned to the one quick slot (measured: run-slot-commit-lane.test.ts's quick runs at 766, 864 and 1046 s, 1227 s of quick-lane waits behind them)
  test("a file whose last quick run was long stays out of quick after 3 big heavy runs that name it", async () => {
    const log = history([
      ["bun run test:file tests/slow.test.ts", "run-slot-quick", 400],
      [
        "bun run test:file tests/slow.test.ts tests/a.test.ts tests/b.test.ts tests/c.test.ts",
        "run-slot-2",
        30,
      ],
      [
        "bun run test:file tests/slow.test.ts tests/a.test.ts tests/b.test.ts tests/c.test.ts",
        "run-slot-2",
        30,
      ],
      [
        "bun run test:file tests/slow.test.ts tests/a.test.ts tests/b.test.ts tests/c.test.ts",
        "run-slot-2",
        30,
      ],
    ])
    expect(await quick(["bun", "run", "test:file", "tests/slow.test.ts"], [], { log })).toBe(false)
  })

  test("and a file that ran long alone in run-slot-2 stays out of quick", async () => {
    const log = history([["bun run test:file tests/slow.test.ts", "run-slot-2", 400]])
    expect(await quick(["bun", "run", "test:file", "tests/slow.test.ts"], [], { log })).toBe(false)
  })

  // the skip's boundaries: a run outside quick naming exactly 3 files still counts, and a quick run naming any number counts
  test("and a file that ran long in a 3-file run outside quick still stays out of quick", async () => {
    const log = history([
      ["bun run test:file tests/slow.test.ts tests/a.test.ts tests/b.test.ts", "run-slot-2", 400],
    ])
    expect(await quick(["bun", "run", "test:file", "tests/slow.test.ts"], [], { log })).toBe(false)
  })

  test("and a file named by a quick run of 4 files stays out of quick", async () => {
    const log = history([
      [
        "bun run test:file tests/slow.test.ts tests/a.test.ts tests/b.test.ts tests/c.test.ts",
        "run-slot-quick",
        400,
      ],
    ])
    expect(await quick(["bun", "run", "test:file", "tests/slow.test.ts"], [], { log })).toBe(false)
  })

  test("and so does a docs:wrap that ran long", async () => {
    expect(await quick(["bun", "run", "docs:wrap"], [61, 70, 80])).toBe(false)
  })

  test("and a commit that ran long keeps its own slot", async () => {
    expect(await quick(["git", "commit"], [70, 80, 90])).toBe(true)
    expect(took).toBe("run-slot-commit")
  })

  // 3 Nov: a plain commit's build, which commit-slot.ts hands run-slot as commit-<worktree>, waited about an hour in the queue, since only git's own words took the commit slot
  const STEP = { env: { RUN_SLOT_COMMIT_STEP: "1" }, waiter: true, who: "commit-wt-one" }
  test("a pre-commit build commit-slot.ts marks takes run-slot-commit past a queue waiter", async () => {
    expect(await quick(["bun", "run", "build"], [], STEP)).toBe(true)
    expect(took).toBe("run-slot-commit")
  })

  test("and so does a type check it marks", async () => {
    expect(await quick(["bun", "run", "check-types:tests"], [], STEP)).toBe(true)
    expect(took).toBe("run-slot-commit")
  })

  test("but a commit- name with no mark goes through the queue", async () => {
    expect(await quick(["bun", "run", "build"], [], { ...STEP, env: {} })).toBe(false)
  })

  test("nor does the mark under a session's own name", async () => {
    expect(await quick(["bun", "run", "build"], [], { ...STEP, who: "worker-q" })).toBe(false)
  })

  // 4 Nov: a docs-only commit and push inside sh -c waited about 45 minutes in the general queue, while a bare git commit takes the commit lane within a minute; these read the slot each took, since a chain's own steps never touch the marker
  test("a sh -c chain of a cd to the repo, then git add, commit and push, takes run-slot-commit", async () => {
    await quick(
      ["sh", "-c", `cd ROOT && git add . && git commit -m "a b" && git push origin`],
      [],
      {
        waiter: true,
      },
    )
    expect(took).toBe("run-slot-commit")
  })

  // a login shell's profile puts the system's git ahead of the fake one, which the slot it took does not depend on
  test("and so does a bash -lc chain of git -C steps", async () => {
    await quick(["bash", "-lc", `git -C ROOT commit -m x; git -C ROOT push origin`])
    expect(took).toBe("run-slot-commit")
  })

  test("but a chain that commits beside a test goes through the queue and says why", async () => {
    expect(await quick(["bash", "-c", `cd ROOT && bun run test && git commit -m x`])).toBe(false)
    expect(said).toContain(
      "run-slot.sh: this chain goes through the general queue, not the commit lane, since `bun run test` is not a form the commit lane takes",
    )
  })

  test("while a chain with no git commit or push says nothing of the commit lane", async () => {
    expect(await quick(["bash", "-c", 'bun run test && git add "$0"'])).toBe(false)
    expect(said).not.toContain("commit lane")
  })

  // ops, 20 Oct: with slot-off, a 5-file run that ran 1s waited 52 min behind suites
  test("bun test naming one test file", async () => {
    expect(await quick(["env", "X=1", "bun", "test"])).toBe(true)
  })

  test("bun --cwd=<dir> test naming three test files", async () => {
    expect(await quick(["bun", "--cwd=x", "test", "tests/b.test.ts", "tests/c.test.tsx"])).toBe(
      true,
    )
  })

  test("but not a bun test naming four", async () => {
    expect(
      await quick(["bun", "test", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts"]),
    ).toBe(false)
  })

  test("nor an end-to-end test", async () => {
    expect(await quick(["bun", "test", "tests/b.e2e.test.ts"])).toBe(false)
  })

  // retro 35: a sharded replay of scratch test files held the one quick slot for 30 minutes, and its waiters waited 87 minutes in all
  test("nor a bun run test:file naming a test file outside the repo's tests/ folder", async () => {
    expect(await quick(["bun", "run", "test:file", "/private/tmp/scratchpad/replay.test.ts"])).toBe(
      false,
    )
  })

  test("nor a bun test naming a test file in another folder", async () => {
    expect(await quick(["bun", "test", "replay/b.test.ts"])).toBe(false)
  })

  test("nor one whose tests/ path climbs out of the folder", async () => {
    expect(await quick(["bun", "test", "tests/../replay.test.ts"])).toBe(false)
  })

  test("but a bun test naming a ./tests/ file", async () => {
    expect(await quick(["bun", "test", "./tests/b.test.ts"])).toBe(true)
  })

  test("nor a bun test with a word that is no test file", async () => {
    expect(await quick(["bun", "test", "-t", "name"])).toBe(false)
  })

  test("bun run test:file naming one test file", async () => {
    expect(await quick(["bun", "run", "test:file"])).toBe(true)
  })

  test("but not bun run test naming one", async () => {
    expect(await quick(["bun", "run", "test"])).toBe(false)
  })

  // --cwd=<p> took the quick slot only by accident (the VAR=x skip ate it), while --cwd <p> read the path as a word that is no test file
  test("bun run --cwd=<dir> test:file naming one test file", async () => {
    expect(await quick(["bun", "run", "--cwd=x", "test:file"])).toBe(true)
  })

  test("bun test --cwd <dir> naming two test files", async () => {
    expect(await quick(["bun", "test", "--cwd", "x", "tests/b.test.ts"])).toBe(true)
  })

  test("bun run --cwd <dir> test:file naming one test file", async () => {
    expect(await quick(["bun", "run", "--cwd", "x", "test:file"])).toBe(true)
  })

  test("bun --cwd=<dir> run test:file naming one test file", async () => {
    expect(await quick(["bun", "--cwd=x", "run", "test:file"])).toBe(true)
  })

  // a bare --cwd before the subcommand stays off the quick slot: bun misreads that shape and runs package.json's script instead (no-false-green)
  test("but not a bun --cwd <dir> test, which bun runs as package.json's test script", async () => {
    expect(await quick(["bun", "--cwd", "x", "test", "tests/b.test.ts"])).toBe(false)
  })

  test("nor a bun --cwd <dir> run", async () => {
    expect(await quick(["bun", "--cwd", "x", "run", "test:file"])).toBe(false)
  })

  test("but not a bun test --cwd <dir> naming four", async () => {
    expect(
      await quick([
        "bun",
        "test",
        "--cwd",
        "x",
        "tests/b.test.ts",
        "tests/c.test.ts",
        "tests/d.test.ts",
      ]),
    ).toBe(false)
  })

  test("nor a bun test --cwd <dir> end-to-end test", async () => {
    expect(await quick(["bun", "test", "--cwd", "x", "tests/b.e2e.test.ts"])).toBe(false)
  })
})

// PG-796, 3 Nov: pr:merge's types gate, holding the merge lock, waited 263 s for the quick slot on a 1 s step, and ran past its 600 s twice on a cached build
describe("the merge train's quick run skips the quick slot's race", () => {
  // A machine whose fake bun touches its last argument, its one quick slot held by a live session's run
  const busy = () => {
    const m = machine()
    writeFileSync(join(m.bin, "bun"), '#!/bin/bash\ntouch "${@: -1}"\n')
    chmodSync(join(m.bin, "bun"), 0o755)
    writeFileSync(
      join(m.ops, "run-slot-quick.holder"),
      `worker-q ${process.pid} 2026-11-03T21:29:51Z\n`,
    )
    mkdirSync(join(m.ops, "run-slot-quick"))
    return m
  }

  test("ops-merge-train's starts at once while the quick slot is held, logged bare", async () => {
    const m = busy()
    expect(await m.start("ops-merge-train", {}, undefined, ["bun", "run", "docs:wrap"]).ran()).toBe(
      true,
    )
    expect(readFileSync(join(m.ops, "run-slot.runs.log"), "utf8")).toMatch(
      / start ops-merge-train \d+ bare waited=\d+s/,
    )
  })

  test("while another session's waits for it", async () => {
    const run = busy().start("worker-x", {}, undefined, ["bun", "run", "docs:wrap"])
    expect(await run.saw(/waiting for the quick slot/g)).toBe(true)
    expect(existsSync(run.marker)).toBe(false)
    await stop(run.p)
  })
})

// #547: load from outside run-slot kept 44 quick runs waiting 201 min for 8 min of work after the 15 s pass (2 Nov), so the quick and commit lanes' load5 wait has a bound (issue 1385, run-slot-commit-load.test.ts)
describe("the quick and commit lanes start once their load5 wait's bound has passed", () => {
  // A machine whose fake bun and git touch their last argument, at the load5 asked for
  const loaded = (load5: number) => {
    const m = machine({ load1: 2, load5 })
    for (const bin of ["bun", "git"]) {
      writeFileSync(join(m.bin, bin), '#!/bin/bash\ntouch "${@: -1}"\n')
      chmodSync(join(m.bin, bin), 0o755)
    }
    return m
  }

  test("a quick-rule run with no runs on record at load5 30", async () => {
    const run = loaded(30).start("worker-q", { RUN_SLOT_LOAD_WAIT: "1" }, undefined, [
      "bun",
      "run",
      "docs:wrap",
    ])
    expect(await run.ran()).toBe(true)
    expect(
      await run.saw(/load5 30 is still at or over 22 after \d+s, so this quick run starts/g),
    ).toBe(true)
  })

  test("a commit at load5 30", async () => {
    const run = loaded(30).start("worker-q", { RUN_SLOT_LOAD_WAIT: "1" }, undefined, [
      "git",
      "commit",
    ])
    expect(await run.ran()).toBe(true)
    expect(
      await run.saw(/load5 30 is still at or over 22 after \d+s, so this commit run starts/g),
    ).toBe(true)
  })

  test("and so does a node_modules clone at load1 30, with clone-off unset and load5 under its margin", async () => {
    expect(await machine({ load1: 30, load5: 2 }).clones("node_modules")).toBe(true)
  })
})

// PG-298: a command's first word past env and VAR=x can be an option: env -i made each basename print "illegal option -- i", eight errors a run
describe("a command whose first word past env is an option", () => {
  test("runs with no basename error", async () => {
    const run = machine().start("worker-e", {}, undefined, ["env", "-i", "touch"])
    expect(await run.ran()).toBe(true)
    expect(await run.saw(/basename/g)).toBe(false)
  })
})
