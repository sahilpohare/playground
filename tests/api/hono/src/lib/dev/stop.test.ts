import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  claimRecord,
  clearRecord,
  formatRecord,
  groupsOf,
  type Observed,
  parseRecord,
  pgidOf,
  type Proc,
  readRecord,
  recordHeld,
  recordLiveGroups,
  RECORD,
  stackIn,
  stackOf,
  startOf,
  stopStack,
  strangers,
  underLock,
  unstoppable,
  writeRecord,
} from "../../../../../../api/hono/src/lib/dev/stop"
import { MARKER } from "../../../../../../packages/safe-delete/src"

const ROOT = "/Users/me/dispatcher/.claude/worktrees/a"
const STARTED = "Tue Oct  6 02:30:00 2026"

describe("the record", () => {
  test("holds the launcher's pid, process group and start time, and reads back", () => {
    const record = { pgid: 4100, pid: 4123, started: STARTED }
    expect(parseRecord(formatRecord(record))).toEqual(record)
  })

  test("anything else reads as no record", () => {
    for (const text of [
      "",
      "4123 4100",
      "{}",
      "not json",
      JSON.stringify({ pgid: 4100, pid: 1, started: STARTED }),
      JSON.stringify({ pgid: 1, pid: 4123, started: STARTED }),
      JSON.stringify({ pgid: 4100, pid: 4123 }),
      JSON.stringify({ pgid: 4100, pid: "4123", started: STARTED }),
      JSON.stringify({ pgid: 4100, pid: 4123, started: "" }),
    ]) {
      expect([text, parseRecord(text)]).toEqual([text, null])
    }
  })

  test("is cleared only for the launcher that wrote it", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-record-"))
    const path = join(dir, RECORD)
    try {
      writeRecord(path, { pgid: 4100, pid: 4123, started: STARTED })
      clearRecord(path, 9999)
      expect(readRecord(path)?.pid).toBe(4123)
      clearRecord(path, 4123)
      expect(readRecord(path)).toBeNull()
      clearRecord(path, 4123)
      expect(readdirSync(dirname(path))).toEqual([])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("takes an unmarked lock a dead clear left aside, clears, and logs why the lock stays (#545)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-record-"))
    const path = join(dir, RECORD)
    const lock = `${path}.lock`
    const said = spyOn(console, "error").mockImplementation(() => {})
    try {
      writeRecord(path, { pgid: 4100, pid: 4123, started: STARTED })
      mkdirSync(lock)
      writeFileSync(join(lock, "left"), "")
      const old = new Date(Date.now() - 60_000)
      utimesSync(lock, old, old)
      clearRecord(path, 4123)
      expect(readRecord(path)).toBeNull()
      const left = readdirSync(dirname(path))
      expect(left).toHaveLength(1)
      expect(left[0]).toStartWith("dev.pgid.lock.stale-")
      expect(String(said.mock.calls[0]?.[0])).toContain(`has no ${MARKER} marker`)
    } finally {
      said.mockRestore()
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("a lock taken over as stale while held keeps the run's result and leaves the new holder's lock (#545)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-record-"))
    const path = join(dir, RECORD)
    const lock = `${path}.lock`
    const said = spyOn(console, "error").mockImplementation(() => {})
    try {
      writeRecord(path, { pgid: 4100, pid: 4123, started: STARTED })
      const result = underLock(
        path,
        () => {
          renameSync(lock, `${lock}.stale-test`)
          mkdirSync(lock)
          writeFileSync(join(lock, "owner"), "another")
          return "ran"
        },
        "busy",
      )
      expect(result).toBe("ran")
      expect(readFileSync(join(lock, "owner"), "utf8")).toBe("another")
      expect(String(said.mock.calls[0]?.[0])).toContain("was taken over as stale")
    } finally {
      said.mockRestore()
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test("holds the stack's task groups with their leaders' starts, and reads a record without them", () => {
    const withGroups = parseRecord(
      formatRecord({
        pgid: 4100,
        pid: 4123,
        started: STARTED,
        groups: [{ pgid: 4200, started: STARTED }],
      }),
    )
    expect(withGroups?.groups).toEqual([{ pgid: 4200, started: STARTED }])
    expect(
      parseRecord(formatRecord({ pgid: 4100, pid: 4123, started: STARTED }))?.groups,
    ).toBeUndefined()
    expect(
      parseRecord(
        formatRecord({
          pgid: 4100,
          pid: 4123,
          started: STARTED,
          groups: [{ pgid: 0, started: "" }],
        }),
      )?.groups,
    ).toBeUndefined()
  })
})

describe("unstoppable", () => {
  const record = { pgid: 4100, pid: 4123, started: STARTED }
  const launcher: Observed = { cwd: ROOT, pgid: 4100, started: STARTED }

  test("nothing stands in the way while the launcher that wrote the record still runs here, in its group", () => {
    expect(unstoppable(record, launcher, ROOT, 777)).toBeNull()
  })

  test("names each reason the group must be left alone, and whether the launcher has gone", () => {
    const cases: [Observed, number, boolean, string][] = [
      [{ cwd: null, pgid: null, started: null }, 777, true, "pid 4123 no longer runs"],
      [
        { ...launcher, started: "Tue Oct  6 03:00:00 2026" },
        777,
        true,
        "pid 4123 is no longer the launcher that wrote the record",
      ],
      [{ ...launcher, pgid: 5000 }, 777, false, "pid 4123 left process group 4100"],
      [
        { ...launcher, cwd: "/Users/me/other" },
        777,
        false,
        `pid 4123 runs in /Users/me/other, not ${ROOT}`,
      ],
      [launcher, 4100, false, "process group 4100 is this command's own"],
    ]
    for (const [seen, own, gone, reason] of cases) {
      expect(unstoppable(record, seen, ROOT, own)).toEqual({ gone, reason })
    }
  })
})

describe("the stack and its groups", () => {
  // A stack started from an agent's background task: its shell leads the group and runs `bun run dev`, which starts the launcher, which starts turbo; turbo starts each task in a group of its own, and portless the app in another.
  const procs: Proc[] = [
    { pgid: 4100, pid: 4100, ppid: 900 },
    { pgid: 4100, pid: 4110, ppid: 4100 },
    { pgid: 4100, pid: 4123, ppid: 4110 },
    { pgid: 4100, pid: 4130, ppid: 4123 },
    { pgid: 4200, pid: 4200, ppid: 4130 },
    { pgid: 4200, pid: 4210, ppid: 4200 },
    { pgid: 4300, pid: 4300, ppid: 4210 },
    { pgid: 4300, pid: 4310, ppid: 4300 },
    { pgid: 900, pid: 900, ppid: 1 },
    { pgid: 6000, pid: 6001, ppid: 1 },
  ]
  const record = { pgid: 4100, pid: 4123 }
  // who adopts an orphan: pid 1 alone, as on macOS, or with the user's systemd --user (pid 1500), as on a Linux desktop
  const PID1 = new Set([1])
  const LINUX = new Set([1, 1500])

  test("the stack is the launcher and all that descends from it, whatever group each sits in", () => {
    expect([...stackOf(procs, 4123)].sort()).toEqual([4123, 4130, 4200, 4210, 4300, 4310])
  })

  test("its groups are the launcher's and each one a process of the stack leads", () => {
    expect(groupsOf(procs, stackOf(procs, 4123), 4100)).toEqual([4100, 4200, 4300])
  })

  test("what started the launcher, and the stack itself, are no strangers", () => {
    expect(strangers(procs, record, () => false, PID1)).toEqual([])
  })

  test("an orphan counts only when it runs from this checkout", () => {
    const orphaned = [...procs, { pgid: 4300, pid: 4350, ppid: 1 }]
    expect(strangers(orphaned, record, (pid) => pid === 4350, PID1)).toEqual([])
    expect(strangers(orphaned, record, () => false, PID1)).toEqual([4350])
  })

  // #2402: on Linux the user's systemd --user adopts the orphan, so its parent reads that manager, not pid 1
  test("an orphan the user manager adopted counts as one, once that manager is a reaper given", () => {
    const orphaned = [...procs, { pgid: 4300, pid: 4350, ppid: 1500 }]
    expect(strangers(orphaned, record, (pid) => pid === 4350, LINUX)).toEqual([])
    expect(strangers(orphaned, record, (pid) => pid === 4350, PID1)).toEqual([4350])
  })

  test("anything else in those groups is a stranger, such as a sibling the shell started", () => {
    expect(
      strangers([...procs, { pgid: 4100, pid: 4160, ppid: 4100 }], record, () => true, PID1),
    ).toEqual([4160])
  })
})

// The checks against real processes, each one this test spawned in a process group of its own: stopStack signals only the groups the record leads to, and this file signals only the groups and pids it started.
describe("stopStack", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dev-stop-")))

  // A stand-in launcher: it starts a child, logs both pids, and (when told) shrugs off SIGTERM.
  // With STAND_IN_ORPHAN, the task leads its group only for a while: it starts a grandchild in its group, stays until the file STAND_IN_ORPHAN names exists, which the test writes once the group is recorded, then leaves, so the recorded group outlives its leader. With STAND_IN_FAMILY, the task stays after the launcher has gone, holding the grandchild it started in its group, as an orphaned next dev holds its next-server child. The grandchild's pid goes to its own log, so the launcher-and-child log stays one line; with STAND_IN_LATE_GRAND, the family task writes that log empty a second before its line.
  const ORPHAN_TASK = `const g = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] })
require("node:fs").appendFileSync(process.env.STAND_IN_GRAND_LOG, g.pid + "\\n")
while (!require("node:fs").existsSync(process.env.STAND_IN_ORPHAN)) await Bun.sleep(25)
process.exit(0)`
  const FAMILY_TASK = `const g = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] })
if (process.env.STAND_IN_LATE_GRAND) {
  require("node:fs").appendFileSync(process.env.STAND_IN_GRAND_LOG, "")
  await Bun.sleep(1000)
}
require("node:fs").appendFileSync(process.env.STAND_IN_GRAND_LOG, g.pid + "\\n")
setInterval(() => {}, 1000)`
  // With STAND_IN_STRANGER, the task starts a holder that starts a grandchild working outside the checkout, then leaves: the group holds a member whose cwd is outside and whose parent chain reaches no one, the stranger a recorded group is left alone for.
  const HOLDER = `const grand = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"], cwd: process.env.STAND_IN_STRANGER_CWD })
require("node:fs").appendFileSync(process.env.STAND_IN_GRAND_LOG, [process.pid, grand.pid].join(" ") + "\\n")
await Bun.sleep(150)
process.exit(0)`
  const STRANGER_TASK = `Bun.spawn(["bun", "-e", ${JSON.stringify(HOLDER)}], { stdio: ["ignore", "ignore", "ignore"] })
setInterval(() => {}, 1000)`
  const STAND_IN = `
import { appendFileSync } from "node:fs"
if (process.env.STAND_IN_STUBBORN) process.on("SIGTERM", () => {})
// with STAND_IN_TASK, the child sits in a process group of its own, as turbo's tasks do, and only a signal to that group reaches it
const task = process.env.STAND_IN_ORPHAN
  ? ${JSON.stringify(ORPHAN_TASK)}
  : process.env.STAND_IN_FAMILY
    ? ${JSON.stringify(FAMILY_TASK)}
    : process.env.STAND_IN_STRANGER
      ? ${JSON.stringify(STRANGER_TASK)}
      : "setInterval(() => {}, 1000)"
const child = Bun.spawn(["bun", "-e", task], { detached: Boolean(process.env.STAND_IN_TASK), stdio: ["ignore", "ignore", "ignore"] })
// with STAND_IN_LATE, the log exists empty for a while before its line, as on a busy runner
if (process.env.STAND_IN_LATE) {
  appendFileSync(process.env.STAND_IN_LOG, "")
  await Bun.sleep(300)
}
appendFileSync(process.env.STAND_IN_LOG, process.pid + " " + child.pid + "\\n")
setInterval(() => {}, 1000)
`
  const standIn = join(dir, "stand-in.ts")
  writeFileSync(standIn, STAND_IN)

  // This test's own groups, each one a group it started, ended whatever the outcome.
  const started: number[] = []
  afterAll(() => {
    for (const pgid of started) {
      // a pid misread as 0 would signal this test's own group
      if (!(pgid > 0)) continue
      try {
        process.kill(-pgid, "SIGKILL")
      } catch {
        // already gone
      }
    }
    rmSync(dir, { force: true, recursive: true })
  })

  const checkout = (name: string) => {
    const root = join(dir, name)
    mkdirSync(root, { recursive: true })
    return root
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  const waitFor = async (done: () => boolean, tries = 80) => {
    for (let i = 0; i < tries && !done(); i++) await Bun.sleep(25)
  }

  // Waits until a log holds a line of count pids, since a busy runner can read the file after it is made and before its line is written.
  const pids = async (path: string, count: number) => {
    for (let i = 0; i < 200; i++) {
      const text = (await Bun.file(path).exists()) ? await Bun.file(path).text() : ""
      const line = text.trim().split(" ").map(Number)
      if (line.length === count && line.every((pid) => pid > 0)) return line
      await Bun.sleep(25)
    }
    throw new Error(`${path} never held a line of ${count} pids`)
  }

  // Starts the stand-in in a new process group, from cwd, and waits for its log line; the group is recorded for the cleanup before anything can fail.
  const start = async (cwd: string, env: Record<string, string> = {}) => {
    const log = join(dir, `${crypto.randomUUID()}.log`)
    const proc = Bun.spawn(["bun", standIn], {
      cwd,
      detached: true,
      env: { ...process.env, ...env, STAND_IN_LOG: log },
      stdio: ["ignore", "ignore", "ignore"],
    })
    started.push(proc.pid)
    const [launcher, child] = await pids(log, 2)
    if (env.STAND_IN_TASK) started.push(child)
    expect(launcher).toBe(proc.pid)
    return { child, proc }
  }

  const record = (root: string, pid: number) => {
    const path = join(root, RECORD)
    writeRecord(path, { pgid: pgidOf(pid) ?? 0, pid, started: startOf(pid) ?? "" })
    return path
  }

  test("reads the stand-in's line even when its log is written empty first", async () => {
    const { child, proc } = await start(checkout("late"), { STAND_IN_LATE: "1" })
    expect([alive(proc.pid), alive(child)]).toEqual([true, true])
  }, 30_000)

  test("ends the recorded group, child and all, and clears the record", async () => {
    const root = checkout("stops")
    const { child, proc } = await start(root)
    expect(pgidOf(proc.pid)).toBe(proc.pid)
    const path = record(root, proc.pid)
    expect(await stopStack(root, { graceMs: 5_000 })).toEqual({ groups: [proc.pid], ok: true })
    await proc.exited
    expect(proc.signalCode).toBe("SIGTERM")
    await waitFor(() => !alive(child))
    expect(alive(child)).toBe(false)
    expect(readRecord(path)).toBeNull()
  }, 30_000)

  test("kills a group that outlives the grace period", async () => {
    const root = checkout("stubborn")
    const { child, proc } = await start(root, { STAND_IN_STUBBORN: "1" })
    record(root, proc.pid)
    expect(await stopStack(root, { graceMs: 400 })).toEqual({ groups: [proc.pid], ok: true })
    await proc.exited
    expect(proc.signalCode).toBe("SIGKILL")
    await waitFor(() => !alive(child))
    expect(alive(child)).toBe(false)
  }, 30_000)

  test("reaches a task in a process group of its own, as turbo starts each one", async () => {
    const root = checkout("task")
    const { child, proc } = await start(root, { STAND_IN_TASK: "1" })
    expect(pgidOf(child)).toBe(child)
    record(root, proc.pid)
    expect(await stopStack(root, { graceMs: 400 })).toEqual({
      groups: [proc.pid, child],
      ok: true,
    })
    await waitFor(() => !alive(child))
    expect(alive(child)).toBe(false)
  }, 30_000)

  test("leaves a newer launcher's record that arrives while it stops the old one", async () => {
    const root = checkout("newer")
    const { proc } = await start(root, { STAND_IN_STUBBORN: "1" })
    const path = record(root, proc.pid)
    const stopping = stopStack(root, { graceMs: 600 })
    await Bun.sleep(100)
    const newer = { pgid: 4100, pid: 4123, started: STARTED }
    writeRecord(path, newer)
    expect((await stopping).ok).toBe(true)
    expect(readRecord(path)).toEqual(newer)
  }, 30_000)

  test("signals nothing, and keeps the record, when the launcher runs from another checkout", async () => {
    const root = checkout("elsewhere")
    const other = checkout("other")
    const { proc } = await start(other)
    const path = record(root, proc.pid)
    expect(await stopStack(root, { graceMs: 400 })).toEqual({
      ok: false,
      reason: `pid ${proc.pid} runs in ${other}, not ${root}, so nothing is signalled`,
    })
    expect(alive(proc.pid)).toBe(true)
    expect(readRecord(path)?.pid).toBe(proc.pid)
  }, 30_000)

  test("signals nothing when the caller's own process group is one of the stack's", async () => {
    const root = checkout("own")
    const { child, proc } = await start(root, { STAND_IN_TASK: "1" })
    const path = record(root, proc.pid)
    expect(await stopStack(root, { graceMs: 400, ownPgid: proc.pid })).toEqual({
      ok: false,
      reason: `process group ${proc.pid} is this command's own, so nothing is signalled`,
    })
    expect(await stopStack(root, { graceMs: 400, ownPgid: child })).toEqual({
      ok: false,
      reason: `process group ${child} is this command's own, so nothing is signalled`,
    })
    expect([alive(proc.pid), alive(child)]).toEqual([true, true])
    expect(readRecord(path)?.pid).toBe(proc.pid)
  }, 30_000)

  test("clears a record whose launcher and group have both gone", async () => {
    const root = checkout("stale")
    const { child, proc } = await start(root)
    const path = record(root, proc.pid)
    process.kill(-proc.pid, "SIGKILL")
    await proc.exited
    await waitFor(() => !alive(child))
    const stopped = await stopStack(root)
    expect(stopped.ok).toBe(false)
    if (!stopped.ok) expect(stopped.reason).toEndWith("the stale record is cleared")
    expect(readRecord(path)).toBeNull()
  }, 30_000)

  test("keeps the record, and names what is left, when the launcher has gone but its group still runs", async () => {
    const root = checkout("orphaned")
    const { child, proc } = await start(root)
    const path = record(root, proc.pid)
    process.kill(proc.pid, "SIGKILL")
    await proc.exited
    expect(alive(child)).toBe(true)
    const stopped = await stopStack(root, { graceMs: 400 })
    expect(stopped.ok).toBe(false)
    if (!stopped.ok) {
      expect(stopped.reason).toContain("still holds pid")
      expect(stopped.reason).toContain(String(child))
      expect(stopped.reason).toContain("the record is kept")
    }
    expect(alive(child)).toBe(true)
    expect(readRecord(path)?.pid).toBe(proc.pid)
  }, 30_000)

  test("ends a gone launcher's recorded task group by the record, and clears the record", async () => {
    const root = checkout("by-record")
    const { child, proc } = await start(root, { STAND_IN_TASK: "1" })
    const path = join(root, RECORD)
    writeRecord(path, {
      pgid: pgidOf(proc.pid) ?? 0,
      pid: proc.pid,
      started: startOf(proc.pid) ?? "",
      groups: [{ pgid: child, started: startOf(child) ?? "" }],
    })
    process.kill(proc.pid, "SIGKILL")
    await proc.exited
    await waitFor(() => !alive(proc.pid))
    expect(alive(child)).toBe(true)
    const stopped = await stopStack(root, { graceMs: 400 })
    expect(stopped).toEqual({ groups: [child], ok: true })
    await waitFor(() => !alive(child))
    expect(alive(child)).toBe(false)
    expect(readRecord(path)).toBeNull()
  }, 30_000)

  test("leaves a recorded group whose leader lost its recorded start, and clears the record", async () => {
    const root = checkout("reused-pid")
    const { child, proc } = await start(root, { STAND_IN_TASK: "1" })
    const path = join(root, RECORD)
    writeRecord(path, {
      pgid: pgidOf(proc.pid) ?? 0,
      pid: proc.pid,
      started: startOf(proc.pid) ?? "",
      groups: [{ pgid: child, started: "Wed Oct  1 00:00:00 2026" }],
    })
    process.kill(proc.pid, "SIGKILL")
    await proc.exited
    const stopped = await stopStack(root, { graceMs: 400 })
    expect(stopped.ok).toBe(false)
    if (!stopped.ok) {
      expect(stopped.reason).toContain(
        `process group ${child} holds a pid whose start no longer matches`,
      )
      expect(stopped.reason).toEndWith("the stale record is cleared")
    }
    expect(alive(child)).toBe(true)
    expect(readRecord(path)).toBeNull()
  }, 30_000)

  test("the next start names the orphan by member pid, and says the record ends it", async () => {
    const root = checkout("names-orphan")
    const { child, proc } = await start(root, { STAND_IN_TASK: "1" })
    const path = join(root, RECORD)
    writeRecord(path, {
      pgid: pgidOf(proc.pid) ?? 0,
      pid: proc.pid,
      started: startOf(proc.pid) ?? "",
      groups: [{ pgid: child, started: startOf(child) ?? "" }],
    })
    process.kill(proc.pid, "SIGKILL")
    await proc.exited
    const claim = claimRecord(path, root, { pgid: 99999, pid: 99999, started: STARTED })
    expect(claim.ok).toBe(false)
    if (!claim.ok) {
      expect(claim.reason).toContain(`recorded groups still hold pid ${child}`)
      expect(claim.reason).toContain("`bun run dev:stop` ends them by their record")
    }
    expect(alive(child)).toBe(true)
  }, 30_000)

  test("a launcher killed with no stop leaves its task group on record, which dev:stop ends and the next start names", async () => {
    const root = checkout("no-stop")
    const { child, proc } = await start(root, { STAND_IN_TASK: "1" })
    const path = join(root, RECORD)
    writeRecord(path, {
      pgid: pgidOf(proc.pid) ?? 0,
      pid: proc.pid,
      started: startOf(proc.pid) ?? "",
    })
    recordLiveGroups(path, root, proc.pid)
    expect(readRecord(path)?.groups).toEqual([{ pgid: child, started: startOf(child) ?? "" }])
    process.kill(proc.pid, "SIGKILL")
    await proc.exited
    await waitFor(() => !alive(proc.pid))
    expect(alive(child)).toBe(true)
    const claim = claimRecord(path, root, { pgid: 99999, pid: 99999, started: STARTED })
    expect(claim.ok).toBe(false)
    if (!claim.ok) expect(claim.reason).toContain(`recorded groups still hold pid ${child}`)
    const stopped = await stopStack(root, { graceMs: 400 })
    expect(stopped).toEqual({ groups: [child], ok: true })
    await waitFor(() => !alive(child))
    expect(alive(child)).toBe(false)
  }, 30_000)

  test("a recorded group whose leader has left, its child holding the group, is still ended by the record, and the next start refuses beside it", async () => {
    const root = checkout("leader-gone")
    const grandLog = join(dir, `${crypto.randomUUID()}.grand`)
    const leave = join(dir, `${crypto.randomUUID()}.leave`)
    const { child, proc } = await start(root, {
      STAND_IN_TASK: "1",
      STAND_IN_ORPHAN: leave,
      STAND_IN_GRAND_LOG: grandLog,
    })
    const path = join(root, RECORD)
    const startedChild = startOf(child) ?? ""
    writeRecord(path, {
      pgid: pgidOf(proc.pid) ?? 0,
      pid: proc.pid,
      started: startOf(proc.pid) ?? "",
    })
    recordLiveGroups(path, root, proc.pid)
    expect(readRecord(path)?.groups).toEqual([{ pgid: child, started: startedChild }])
    process.kill(proc.pid, "SIGKILL")
    await proc.exited
    await waitFor(() => !alive(proc.pid))
    // the task leaves; the grandchild it started keeps the group
    writeFileSync(leave, "")
    await waitFor(() => !alive(child), 400)
    expect(alive(child)).toBe(false)
    // the tick keeps the leaderless group while its grandchild still runs here
    recordLiveGroups(path, root, proc.pid)
    expect(readRecord(path)?.groups).toEqual([{ pgid: child, started: startedChild }])
    const [grand] = await pids(grandLog, 1)
    expect(alive(grand)).toBe(true)
    const claim = claimRecord(path, root, { pgid: 99999, pid: 99999, started: STARTED })
    expect(claim.ok).toBe(false)
    if (!claim.ok) expect(claim.reason).toContain(`recorded groups still hold pid ${grand}`)
    const stopped = await stopStack(root, { graceMs: 400 })
    expect(stopped).toEqual({ groups: [child], ok: true })
    await waitFor(() => !alive(grand))
    expect(alive(grand)).toBe(false)
    expect(readRecord(path)).toBeNull()
  }, 30_000)

  test("a recorded group whose orphaned leader holds a child is still ended by the record", async () => {
    const root = checkout("two-level")
    const grandLog = join(dir, `${crypto.randomUUID()}.grand`)
    const { child, proc } = await start(root, {
      STAND_IN_TASK: "1",
      STAND_IN_FAMILY: "1",
      STAND_IN_GRAND_LOG: grandLog,
      STAND_IN_LATE_GRAND: "1",
    })
    const path = join(root, RECORD)
    writeRecord(path, {
      pgid: pgidOf(proc.pid) ?? 0,
      pid: proc.pid,
      started: startOf(proc.pid) ?? "",
    })
    recordLiveGroups(path, root, proc.pid)
    expect(readRecord(path)?.groups).toEqual([{ pgid: child, started: startOf(child) ?? "" }])
    process.kill(proc.pid, "SIGKILL")
    await proc.exited
    await waitFor(() => !alive(proc.pid))
    // the leader stays, adopted by pid 1, holding the child it started in its group
    expect(alive(child)).toBe(true)
    const [grand] = await pids(grandLog, 1)
    expect(alive(grand)).toBe(true)
    const stopped = await stopStack(root, { graceMs: 400 })
    expect(stopped).toEqual({ groups: [child], ok: true })
    await waitFor(() => !alive(child))
    expect(alive(child)).toBe(false)
    await waitFor(() => !alive(grand))
    expect(alive(grand)).toBe(false)
    expect(readRecord(path)).toBeNull()
  }, 30_000)

  test("a stop with the launcher still alive also ends a recorded group whose leader has left", async () => {
    const root = checkout("live-leaderless")
    const grandLog = join(dir, `${crypto.randomUUID()}.grand`)
    const leave = join(dir, `${crypto.randomUUID()}.leave`)
    const { child, proc } = await start(root, {
      STAND_IN_TASK: "1",
      STAND_IN_ORPHAN: leave,
      STAND_IN_GRAND_LOG: grandLog,
    })
    const path = join(root, RECORD)
    const startedChild = startOf(child) ?? ""
    writeRecord(path, {
      pgid: pgidOf(proc.pid) ?? 0,
      pid: proc.pid,
      started: startOf(proc.pid) ?? "",
    })
    recordLiveGroups(path, root, proc.pid)
    expect(readRecord(path)?.groups).toEqual([{ pgid: child, started: startedChild }])
    // the task leaves; the tick keeps the leaderless group while the grandchild runs on
    writeFileSync(leave, "")
    await waitFor(() => !alive(child), 400)
    expect(alive(child)).toBe(false)
    recordLiveGroups(path, root, proc.pid)
    const [grand] = await pids(grandLog, 1)
    expect(alive(grand)).toBe(true)
    const stopped = await stopStack(root, { graceMs: 400 })
    expect(stopped.ok).toBe(true)
    if (stopped.ok) expect(stopped.groups).toContain(child)
    await proc.exited
    await waitFor(() => !alive(grand))
    expect(alive(grand)).toBe(false)
    expect(readRecord(path)).toBeNull()
  }, 30_000)

  test("a recorded group that is the caller's own is left alone", async () => {
    const root = checkout("own-group")
    const { child, proc } = await start(root, { STAND_IN_TASK: "1" })
    const path = join(root, RECORD)
    writeRecord(path, {
      pgid: pgidOf(proc.pid) ?? 0,
      pid: proc.pid,
      started: startOf(proc.pid) ?? "",
      groups: [{ pgid: child, started: startOf(child) ?? "" }],
    })
    process.kill(proc.pid, "SIGKILL")
    await proc.exited
    await waitFor(() => !alive(proc.pid))
    expect(alive(child)).toBe(true)
    // the caller claims the recorded group as its own, as a dev:stop running inside it would
    const stopped = await stopStack(root, { graceMs: 400, ownPgid: child })
    expect(stopped.ok).toBe(false)
    if (!stopped.ok)
      expect(stopped.reason).toContain(
        `process group ${child} is this command's own, so it is left alone`,
      )
    expect(alive(child)).toBe(true)
    expect(readRecord(path)?.pid).toBe(proc.pid)
  }, 30_000)

  test("a recorded group that also holds a stranger's process is left alone, named, and kept on record", async () => {
    const root = checkout("recorded-stranger")
    const grandLog = join(dir, `${crypto.randomUUID()}.grand`)
    const { child, proc } = await start(root, {
      STAND_IN_TASK: "1",
      STAND_IN_STRANGER: "1",
      STAND_IN_GRAND_LOG: grandLog,
      STAND_IN_STRANGER_CWD: dir,
    })
    const path = join(root, RECORD)
    writeRecord(path, {
      pgid: pgidOf(proc.pid) ?? 0,
      pid: proc.pid,
      started: startOf(proc.pid) ?? "",
    })
    recordLiveGroups(path, root, proc.pid)
    expect(readRecord(path)?.groups).toEqual([{ pgid: child, started: startOf(child) ?? "" }])
    const [holder, grand] = await pids(grandLog, 2)
    process.kill(proc.pid, "SIGKILL")
    await proc.exited
    await waitFor(() => !alive(proc.pid))
    // the holder leaves; its grandchild stays in the group, adopted by pid 1, working outside the checkout
    await waitFor(() => !alive(holder))
    expect(alive(grand)).toBe(true)
    const stopped = await stopStack(root, { graceMs: 400 })
    expect(stopped.ok).toBe(false)
    if (!stopped.ok)
      expect(stopped.reason).toContain(
        `process group ${child} also holds pid ${grand}, which is not this stack's, so it is left alone`,
      )
    expect(alive(child)).toBe(true)
    expect(alive(grand)).toBe(true)
    expect(readRecord(path)?.pid).toBe(proc.pid)
  }, 30_000)

  test("the record is held while one of its groups still holds a checkout process, and not once none does", async () => {
    const root = checkout("held")
    const { child, proc } = await start(root, { STAND_IN_TASK: "1" })
    const base = {
      pgid: pgidOf(proc.pid) ?? 0,
      pid: proc.pid,
      started: startOf(proc.pid) ?? "",
    }
    expect(recordHeld(base, root)).toBe(false)
    const path = join(root, RECORD)
    writeRecord(path, base)
    recordLiveGroups(path, root, proc.pid)
    const held = readRecord(path)
    expect(held?.groups).toEqual([{ pgid: child, started: startOf(child) ?? "" }])
    expect(recordHeld(held!, root)).toBe(true)
    // a group whose leader's pid runs with another start is a new process, not the stack's
    expect(
      recordHeld({ ...base, groups: [{ pgid: child, started: "Wed Oct  1 00:00:00 2026" }] }, root),
    ).toBe(false)
    // the group is this test's own stand-in's task, ended by its group
    process.kill(-child, "SIGKILL")
    await waitFor(() => !alive(child))
    expect(recordHeld(held!, root)).toBe(false)
  }, 30_000)

  test("signals nothing when the group holds a process that is not the stack's", async () => {
    const root = checkout("shared")
    // a leader that starts the stand-in and, beside it, a sibling that is no part of it
    const log = join(root, "leader.log")
    const leader = Bun.spawn(
      [
        "bun",
        "-e",
        `const opts = { stdio: ["ignore", "ignore", "ignore"] }
const sibling = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], opts)
const launcher = Bun.spawn(["bun", ${JSON.stringify(standIn)}], { ...opts, env: { ...process.env, STAND_IN_LOG: ${JSON.stringify(join(root, "stand-in.log"))} } })
require("node:fs").writeFileSync(${JSON.stringify(log)}, launcher.pid + " " + sibling.pid)
setInterval(() => {}, 1000)`,
      ],
      { cwd: root, detached: true, stdio: ["ignore", "ignore", "ignore"] },
    )
    started.push(leader.pid)
    const [launcher, sibling] = await pids(log, 2)
    record(root, launcher)
    const stopped = await stopStack(root, { graceMs: 400 })
    expect(stopped.ok).toBe(false)
    if (!stopped.ok) {
      expect(stopped.reason).toStartWith(
        `the stack's process groups also hold pid ${sibling}, which is not this stack's`,
      )
    }
    expect([alive(leader.pid), alive(launcher), alive(sibling)]).toEqual([true, true, true])
  }, 30_000)

  test("leaves the live dashboard's checkout to its runner unless told otherwise", async () => {
    const root = checkout("live")
    const git = Bun.spawnSync(["git", "init", "-q", "-b", "live/dashboard", root], {
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        PATH: process.env.PATH ?? "",
      },
    })
    expect(git.exitCode).toBe(0)
    const { proc } = await start(root)
    record(root, proc.pid)
    const refused = await stopStack(root, { graceMs: 400, liveBranch: "live/dashboard" })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toStartWith("this is the live dashboard's checkout")
    expect(alive(proc.pid)).toBe(true)
    expect(await stopStack(root, { graceMs: 2_000, liveDashboard: true })).toEqual({
      groups: [proc.pid],
      ok: true,
    })
  }, 30_000)

  test("reads a start time the same whatever the caller's TZ and locale", async () => {
    const { proc } = await start(checkout("tz"))
    const read = Bun.spawnSync(
      [
        "bun",
        "-e",
        `const { startOf } = await import(${JSON.stringify(join(import.meta.dir, "../../../../../../api/hono/src/lib/dev/stop.ts"))}); process.stdout.write(startOf(${proc.pid}) ?? "")`,
      ],
      {
        env: {
          ...process.env,
          LC_ALL: "fr_FR.UTF-8",
          SKIP_ENV_VALIDATION: "true",
          TZ: "Asia/Kolkata",
        },
      },
    )
    expect(read.stdout.toString()).toBe(startOf(proc.pid) ?? "none")
  }, 30_000)

  // The pre-commit hook's check: a commit waits while this checkout's stack runs.
  describe("stackIn", () => {
    test("finds nothing when no stack is recorded", () => {
      expect(stackIn(checkout("commit-none"))).toBeNull()
    })

    test("names the recorded launcher while it runs from the checkout", async () => {
      const root = checkout("commit-running")
      const { proc } = await start(root)
      record(root, proc.pid)
      expect(stackIn(root)).toEqual({
        gone: false,
        what: `launcher pid ${proc.pid}, process group ${proc.pid}`,
      })
    }, 30_000)

    test("names what is left when the launcher has gone but its group still runs", async () => {
      const root = checkout("commit-orphaned")
      const { child, proc } = await start(root)
      record(root, proc.pid)
      process.kill(proc.pid, "SIGKILL")
      await proc.exited
      const running = stackIn(root)
      expect(running?.gone).toBe(true)
      expect(running?.what).toContain(String(child))
    }, 30_000)

    test("finds nothing once the recorded stack has stopped", async () => {
      const root = checkout("commit-stopped")
      const { child, proc } = await start(root)
      record(root, proc.pid)
      process.kill(-proc.pid, "SIGKILL")
      await proc.exited
      await waitFor(() => !alive(child))
      expect(stackIn(root)).toBeNull()
    }, 30_000)
  })

  describe("claimRecord", () => {
    const self = { pgid: 4100, pid: 4123, started: STARTED }

    test("claims a checkout no stack has recorded", () => {
      const path = join(checkout("claim-fresh"), RECORD)
      expect(claimRecord(path, dir, self)).toEqual({ ok: true })
      expect(readRecord(path)).toEqual(self)
    })

    test("refuses while the recorded launcher still runs from the checkout, and keeps its record", async () => {
      const root = checkout("claim-running")
      const { proc } = await start(root)
      const path = record(root, proc.pid)
      const claim = claimRecord(path, root, self)
      expect(claim.ok).toBe(false)
      if (!claim.ok) {
        expect(claim.reason).toStartWith(
          `a stack already runs in this checkout (launcher pid ${proc.pid}, process group ${proc.pid})`,
        )
      }
      expect(readRecord(path)?.pid).toBe(proc.pid)
    }, 30_000)

    test("refuses while the recorded launcher has gone but its group still runs, naming what is left", async () => {
      const root = checkout("claim-orphaned")
      const { child, proc } = await start(root)
      const path = record(root, proc.pid)
      process.kill(proc.pid, "SIGKILL")
      await proc.exited
      const claim = claimRecord(path, root, self)
      expect(claim.ok).toBe(false)
      if (!claim.ok) {
        expect(claim.reason).toContain(`launcher (pid ${proc.pid}) has gone`)
        expect(claim.reason).toContain(String(child))
      }
      expect(readRecord(path)?.pid).toBe(proc.pid)
    }, 30_000)

    test("replaces a record nothing runs under any more, or one that does not parse", async () => {
      const root = checkout("claim-stale")
      const { child, proc } = await start(root)
      const path = record(root, proc.pid)
      process.kill(-proc.pid, "SIGKILL")
      await proc.exited
      await waitFor(() => !alive(child))
      expect(claimRecord(path, root, self)).toEqual({ ok: true })
      expect(readRecord(path)).toEqual(self)
      writeFileSync(path, "not a record")
      expect(claimRecord(path, root, self)).toEqual({ ok: true })
      expect(readRecord(path)).toEqual(self)
    }, 30_000)

    test("lets the stack run without a record it cannot write, and says so", () => {
      const path = join(checkout("claim-blocked"), RECORD)
      mkdirSync(path, { recursive: true })
      const claim = claimRecord(path, dir, self)
      expect(claim.ok).toBe(true)
      if (claim.ok) {
        expect(claim.warning).toStartWith(
          `could not record the stack in ${path} (it is not a file)`,
        )
      }
    })

    // A group number the system has given to something running elsewhere is no stack of this checkout's, so the record naming it is stale.
    test("replaces a record whose group number now belongs to something running elsewhere", async () => {
      const root = checkout("claim-reused")
      const { proc } = await start(checkout("claim-reused-elsewhere"))
      const path = join(root, RECORD)
      writeRecord(path, { pgid: proc.pid, pid: 4123, started: STARTED })
      expect(claimRecord(path, root, self)).toEqual({ ok: true })
      expect(readRecord(path)).toEqual(self)
      writeRecord(path, { pgid: proc.pid, pid: 4123, started: STARTED })
      const stopped = await stopStack(root, { graceMs: 400 })
      expect(stopped.ok).toBe(false)
      if (!stopped.ok) {
        expect(stopped.reason).toContain("nothing in the recorded groups runs from this checkout")
        expect(stopped.reason).toEndWith("the stale record is cleared")
      }
      expect(alive(proc.pid)).toBe(true)
    }, 30_000)

    // Starts at the same instant, each a live process of its own from the checkout, as launchers are: over no record and over a stale one, exactly one claims and the rest refuse.
    test("gives the record to exactly one of several starts at once", async () => {
      const contender = join(dir, "contender.ts")
      // each says it is ready, then claims on the test's go, so the three claim microseconds apart (the go reaches one pipe after another) however late a loaded machine starts them
      writeFileSync(
        contender,
        `const [stop, path, root] = process.argv.slice(2)
const { claimRecord, pgidOf, startOf } = await import(stop)
const self = { pgid: pgidOf(process.pid), pid: process.pid, started: startOf(process.pid) }
console.log("ready")
for await (const _ of console) break
console.log(JSON.stringify(claimRecord(path, root, self)))
setInterval(() => {}, 1000)
`,
      )
      const stop = join(import.meta.dir, "../../../../../../api/hono/src/lib/dev/stop.ts")
      // the next line a contender prints
      const reader = (stream: ReadableStream<Uint8Array>) => {
        const chunks = stream.getReader()
        const decoder = new TextDecoder()
        let text = ""
        return async () => {
          while (!text.includes("\n")) {
            const { done, value } = await chunks.read()
            if (done) throw new Error(`a contender ended before its line, having printed ${text}`)
            text += decoder.decode(value, { stream: true })
          }
          const line = text.slice(0, text.indexOf("\n"))
          text = text.slice(line.length + 1)
          return line
        }
      }
      const race = async (root: string, path: string) => {
        const contenders = [0, 1, 2].map(() => {
          const proc = Bun.spawn(["bun", contender, stop, path, root], {
            cwd: root,
            detached: true,
            env: { ...process.env, SKIP_ENV_VALIDATION: "true" },
            stdio: ["pipe", "pipe", "ignore"],
          })
          started.push(proc.pid)
          return { line: reader(proc.stdout), proc }
        })
        expect(await Promise.all(contenders.map(({ line }) => line()))).toEqual([
          "ready",
          "ready",
          "ready",
        ])
        for (const { proc } of contenders) {
          proc.stdin.write("go\n")
          proc.stdin.flush()
        }
        const claims = await Promise.all(
          contenders.map(async ({ line }) => JSON.parse(await line())),
        )
        for (const { proc } of contenders) process.kill(-proc.pid, "SIGKILL")
        return claims.filter((claim) => claim.ok && !claim.warning).length
      }
      for (let trial = 0; trial < 6; trial++) {
        const fresh = checkout(`race-fresh-${trial}`)
        expect(await race(fresh, join(fresh, RECORD))).toBe(1)
        const stale = checkout(`race-stale-${trial}`)
        writeRecord(join(stale, RECORD), { pgid: 999_999, pid: 4123, started: STARTED })
        expect(await race(stale, join(stale, RECORD))).toBe(1)
      }
    }, 120_000)
  })

  test("says so when no stack is recorded", async () => {
    const root = checkout("none")
    expect(await stopStack(root)).toEqual({
      ok: false,
      reason: `no stack is recorded in ${join(root, RECORD)}`,
    })
  })

  // The signal races the group emptying; the spy stands in for the kernel's answer, and afterEach puts the real kill back.
  let killSpy: { mockRestore: () => void } | undefined
  afterEach(() => killSpy?.mockRestore())
  const errno = (e: string) => {
    const error = new Error(e) as NodeJS.ErrnoException
    error.code = e
    return error
  }
  const throwsAt = (pgid: number, e: string) => {
    killSpy = spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === -pgid) throw errno(e)
      return undefined
    }) as unknown as typeof process.kill)
  }

  test("a recorded group that empties before the signal still reads as stopped, the ESRCH swallowed", async () => {
    const root = checkout("esrch")
    const { child, proc } = await start(root, { STAND_IN_TASK: "1" })
    const path = join(root, RECORD)
    writeRecord(path, {
      pgid: pgidOf(proc.pid) ?? 0,
      pid: proc.pid,
      started: startOf(proc.pid) ?? "",
    })
    recordLiveGroups(path, root, proc.pid)
    expect(readRecord(path)?.groups).toEqual([{ pgid: child, started: startOf(child) ?? "" }])
    // the launcher leaves first, so the gone branch ends the recorded task group by the record
    process.kill(proc.pid, "SIGKILL")
    await waitFor(() => !alive(proc.pid))
    // the group emptied between the walk and the signal: every kill against it reads ESRCH
    throwsAt(child, "ESRCH")
    expect(await stopStack(root, { graceMs: 5_000 })).toEqual({ groups: [child], ok: true })
    expect(readRecord(path)).toBeNull()
  }, 30_000)

  test("a real error from the signal still throws", async () => {
    const root = checkout("eperm")
    const { child, proc } = await start(root, { STAND_IN_TASK: "1" })
    const path = join(root, RECORD)
    writeRecord(path, {
      pgid: pgidOf(proc.pid) ?? 0,
      pid: proc.pid,
      started: startOf(proc.pid) ?? "",
    })
    recordLiveGroups(path, root, proc.pid)
    process.kill(proc.pid, "SIGKILL")
    await waitFor(() => !alive(proc.pid))
    throwsAt(child, "EPERM")
    await expect(stopStack(root, { graceMs: 5_000 })).rejects.toThrow("EPERM")
  }, 30_000)

  test("the launcher's group emptying before its SIGTERM still reads as stopped, the ESRCH swallowed", async () => {
    const root = checkout("live-esrch")
    const { proc } = await start(root)
    const path = record(root, proc.pid)
    // the group emptied between the alive check and the signal: every kill against it reads ESRCH
    throwsAt(proc.pid, "ESRCH")
    expect(await stopStack(root, { graceMs: 5_000 })).toEqual({ groups: [proc.pid], ok: true })
    expect(readRecord(path)).toBeNull()
  }, 30_000)
})
