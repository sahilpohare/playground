import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Proc } from "../../../../../../api/hono/src/lib/system/parse"
import {
  checkoutOf,
  compose,
  cpuShares,
  freshState,
  HISTORY_POINTS,
  IDLE_AFTER_MS,
  INTERVAL_MS,
  QUIET_MS,
  Sampler,
  STOP_UNREAD_MS,
  TIMER_LOST,
  type Readings,
  type SamplerState,
} from "../../../../../../api/hono/src/lib/system/sampler"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const GB = 1024 ** 3
const MB = 1024 * 1024
const T0 = Date.parse("2026-10-06T08:00:00Z")

const proc = (pid: number, ppid: number, mb: number, cpuSeconds = 0): Proc => ({
  cpuSeconds,
  pid,
  ppid,
  rssBytes: mb * MB,
})

const checkouts = (cwd: string): string | null =>
  ["/r/wt/a", "/r/wt/run", "/r"].find((root) => cwd === root || cwd.startsWith(`${root}/`)) ?? null

const ZAI = {
  fiveHour: { cap: 100, resetsAt: null, used: 41 },
  stale: false,
  week: null,
  writtenAt: "2026-10-06T07:58:00.000Z",
}

// worker-a (200) serves a stack from /r/wt/a; the runner the roster calls runner-dashboard, launched as plain dashboard (300), serves the live dashboard from /r/wt/run. Each stack's server burns the CPU seconds given so far.
const readings = (cpu: { a: number; run: number }): Readings => ({
  account: { email: "merritt@example.com", name: "Merritt" },
  accounts: [],
  cores: 15,
  cwds: new Map([
    [200, "/r"],
    [210, "/r/wt/a"],
    [211, "/r/wt/a/api/hono"],
    [300, "/r"],
    [310, "/r/wt/run"],
    [311, "/r/wt/run/api/hono"],
  ]),
  disk: { freeBytes: 785 * GB, totalBytes: 994 * GB },
  docker: {
    containers: [{ bytes: 25 * MB, id: "aaa", name: "playground-a-db", ports: [33591] }],
    problem: null,
    vmPid: 4313,
  },
  glmAccount: true,
  hostname: "machine-a",
  load: [11.7, 10.6, 9.1],
  peers: [],
  platform: "linux",
  problems: [],
  procs: [
    proc(4313, 1, 1000),
    proc(200, 150, 400),
    proc(210, 200, 2),
    proc(211, 210, 500, cpu.a),
    proc(300, 150, 300),
    proc(310, 300, 2),
    proc(311, 310, 600, cpu.run),
  ],
  pulls: null,
  roster: [
    {
      name: "runner-dashboard",
      role: "runner",
      status: "working",
      task: "Keep the live dashboard",
    },
  ],
  sessions: [
    { name: "worker-a", pid: 200, sessionId: "s-a" },
    { name: "dashboard", pid: 300, sessionId: "s-run" },
  ],
  sockets: { connects: new Map([[211, new Set([33591])]]), listens: new Set([211, 311]) },
  sysctl: {
    freePercent: 48,
    pressure: "normal",
    swap: { totalBytes: 6 * GB, usedBytes: 4.9 * GB },
  },
  totalBytes: 24 * GB,
  update: null,
  usage: null,
  usedBytes: 17 * GB,
  workspaces: new Map(),
  zai: ZAI,
})

// Samples every INTERVAL_MS from T0, each stack burning the CPU seconds busy() gives for that sample.
const run = (count: number, busy: (i: number) => { a: number; run: number }) => {
  let state: SamplerState = freshState(T0)
  const total = { a: 0, run: 0 }
  let report = null as ReturnType<typeof compose>["report"] | null
  for (let i = 0; i < count; i++) {
    const burn = busy(i)
    total.a += burn.a
    total.run += burn.run
    ;({ report, state } = compose(readings({ ...total }), state, T0 + i * INTERVAL_MS, checkouts))
  }
  return { report: report as NonNullable<typeof report>, state }
}

describe("cpuShares", () => {
  test("CPU seconds since the last sample over the seconds between, per process; a new one's are all new", () => {
    const state: SamplerState = {
      ...freshState(T0),
      cpuSeconds: new Map([[1, 10]]),
      sampledAt: T0,
    }
    const shares = cpuShares([proc(1, 0, 1, 13), proc(2, 0, 1, 0.3)], state, T0 + 30_000)
    expect(shares.get(1)).toBeCloseTo(10)
    expect(shares.get(2)).toBeCloseTo(1)
    expect(cpuShares([proc(1, 0, 1, 13)], freshState(T0), T0).size).toBe(0)
  })
})

describe("compose", () => {
  test("one report: the account, memory, CPU, disk, Docker's VM by its pid, each agent with its role, and the room line", () => {
    const { report } = run(1, () => ({ a: 0, run: 0 }))
    expect(report.account).toEqual({ email: "merritt@example.com", name: "Merritt" })
    expect(report.memory).toEqual({
      freePercent: 48,
      pressure: "normal",
      swap: { totalBytes: 6 * GB, usedBytes: 4.9 * GB },
      totalBytes: 24 * GB,
      usedBytes: 17 * GB,
    })
    expect(report.cpu).toEqual({ cores: 15, load: [11.7, 10.6, 9.1] })
    expect(report.platform).toBe("linux")
    expect(report.docker).toEqual({
      containers: [{ bytes: 25 * MB, name: "playground-a-db", stack: "/r/wt/a" }],
      problem: null,
      vmBytes: 1000 * MB,
    })
    expect(report.agents.map((a) => [a.name, a.role, a.bytes / MB])).toEqual([
      ["worker-a", "worker", 400 + 2 + 500 + 25],
      ["runner-dashboard", "runner", 300 + 2 + 600],
    ])
    expect(report.capacity.line).toBe("Room for ~4 more workers, by CPU load")
    expect(report.capacity.idle).toEqual({ bytes: 0, line: null, ready: false, stacks: [] })
    expect(report.sampledAt).toBe("2026-10-06T08:00:00.000Z")
    expect(report.zai).toEqual(ZAI)
  })

  test("with no GLM row in usage.accounts the report carries no GLM windows, though a file is left behind", () => {
    const { report } = compose(
      { ...readings({ a: 0, run: 0 }), glmAccount: false },
      freshState(T0),
      T0,
      checkouts,
    )
    expect(report.zai).toBeNull()
  })

  test("a worker's stack under 1% of a core for 15 minutes is idle and offered up; a runner's never is", () => {
    const samples = IDLE_AFTER_MS / INTERVAL_MS + 2
    const { report } = run(samples, () => ({ a: 0.1, run: 0 }))
    const [a] = report.agents
    expect(a?.stacks[0]?.idleSince).toBe("2026-10-06T08:00:00.000Z")
    expect(report.agents[1]?.stacks[0]?.idleSince).toBe("2026-10-06T08:00:00.000Z")
    expect(report.capacity.idle).toEqual({
      bytes: (2 + 500 + 25) * MB,
      line: "Stop the idle dev stack to free 0.5 GB",
      ready: true,
      stacks: [
        {
          bytes: (2 + 500 + 25) * MB,
          checkout: "/r/wt/a",
          idleSince: "2026-10-06T08:00:00.000Z",
          name: "worker-a",
        },
      ],
    })
  })

  test("a manager's idle stack is never offered, and the roster's role wins over the launch name", () => {
    const samples = IDLE_AFTER_MS / INTERVAL_MS + 2
    let state: SamplerState = freshState(T0)
    let report = null as ReturnType<typeof compose>["report"] | null
    for (let i = 0; i < samples; i++) {
      const managed: Readings = {
        ...readings({ a: 0, run: 0 }),
        roster: [
          ...readings({ a: 0, run: 0 }).roster,
          { name: "worker-a", role: "manager", status: "working", task: "Lead" },
        ],
      }
      ;({ report, state } = compose(managed, state, T0 + i * INTERVAL_MS, checkouts))
    }
    expect(report?.agents.map((a) => [a.name, a.role])).toEqual([
      ["worker-a", "manager"],
      ["runner-dashboard", "runner"],
    ])
    expect(report?.agents[0]?.stacks[0]?.idleSince).not.toBeNull()
    expect(report?.capacity.idle.stacks).toEqual([])
  })

  test("a session pairs with its roster agent by workspace when its name says nothing", () => {
    const paired: Readings = {
      ...readings({ a: 0, run: 0 }),
      roster: [
        {
          name: "runner-pride",
          role: "runner",
          status: "working",
          task: "Keep the live dashboard",
          workspace: "workspace:7",
        },
      ],
      sessions: [
        { name: "worker-a", pid: 200, sessionId: "s-a" },
        { name: "session 1d426794", pid: 300, sessionId: "s-run" },
      ],
      workspaces: new Map([["s-run", "workspace:7"]]),
    }
    const { report } = compose(paired, freshState(T0), T0, checkouts)
    expect(report.agents.map((a) => [a.name, a.role, a.sessionId])).toEqual([
      ["worker-a", "worker", "s-a"],
      ["runner-pride", "runner", "s-run"],
    ])
  })

  test("a sample whose ps failed keeps the last CPU times, so the next shares span both intervals", () => {
    const first = compose(readings({ a: 0, run: 0 }), freshState(T0), T0, checkouts)
    const failed = compose(
      { ...readings({ a: 0, run: 0 }), procs: [] },
      first.state,
      T0 + INTERVAL_MS,
      checkouts,
    )
    expect(failed.state.sampledAt).toBe(T0)
    expect(failed.state.cpuSeconds.get(211)).toBe(0)
    const next = compose(readings({ a: 6, run: 0 }), failed.state, T0 + 2 * INTERVAL_MS, checkouts)
    expect(next.report.agents[0]?.stacks[0]?.cpuPercent).toBe(10)
  })

  test("a stack busy within the last 15 minutes is not idle, and its clock restarts", () => {
    const samples = IDLE_AFTER_MS / INTERVAL_MS + 2
    const { report } = run(samples, (i) => ({ a: i === 5 ? 3 : 0, run: 0 }))
    expect(report.agents[0]?.stacks[0]?.idleSince).toBeNull()
    expect(report.capacity.idle.stacks).toEqual([])
    const later = run(samples + 10, (i) => ({ a: i === 5 ? 3 : 0, run: 0 })).report
    expect(later.agents[0]?.stacks[0]?.idleSince).toBe(new Date(T0 + 5 * INTERVAL_MS).toISOString())
  })

  test("samples taken only on reads keep the last hour by time, not just the last 120", () => {
    let state: SamplerState = freshState(T0)
    let report = null as ReturnType<typeof compose>["report"] | null
    for (const minutes of [0, 20, 50, 75, 90]) {
      ;({ report, state } = compose(
        readings({ a: 0, run: 0 }),
        state,
        T0 + minutes * 60_000,
        checkouts,
      ))
    }
    expect(report?.history.map((p) => (Date.parse(p.at) - T0) / 60_000)).toEqual([50, 75, 90])
  })

  test("a fresh sample that fails while the timer is lost leaves the last one answering", async () => {
    let fail = false
    let now = T0
    const timers: { tick: () => void }[] = []
    const sampler = new Sampler({
      cancel: () => {},
      checkoutOf: checkouts,
      now: () => now,
      read: async () => {
        if (fail) throw new Error("read failed")
        return readings({ a: 0, run: 0 })
      },
      schedule: (tick) => {
        timers.push({ tick })
        return timers.at(-1)
      },
    })
    const first = await sampler.report()
    now += QUIET_MS + 1
    fail = true
    const kept = await sampler.report()
    expect(kept.sampledAt).toBe(first.sampledAt)
    expect(kept.problems).toEqual([TIMER_LOST])
  })

  test("an hour of totals, the oldest dropped first", () => {
    const { report } = run(HISTORY_POINTS + 5, () => ({ a: 0, run: 0 }))
    expect(report.history).toHaveLength(HISTORY_POINTS)
    expect(report.history[0]?.at).toBe(new Date(T0 + 5 * INTERVAL_MS).toISOString())
    expect(report.history.at(-1)).toEqual({
      at: report.sampledAt,
      load1: 11.7,
      swapUsedBytes: 4.9 * GB,
      usedBytes: 17 * GB,
      week: null,
    })
  })

  test("each point carries the signed-in account's fresh week share, and none for a window the file no longer holds", () => {
    const usage = (sevenDay: { resetsAt: null; seenAt?: string; usedPercent: number }) => ({
      fiveHour: null,
      sevenDay,
      stale: false,
      writtenAt: new Date(T0).toISOString(),
    })
    const point = (u: ReturnType<typeof usage>) =>
      compose({ ...readings({ a: 0, run: 0 }), usage: u }, freshState(T0), T0, checkouts).report
        .history[0]?.week
    expect(point(usage({ resetsAt: null, usedPercent: 42 }))).toEqual({
      account: "merritt@example.com",
      used: 42,
    })
    expect(
      point(usage({ resetsAt: null, seenAt: new Date(T0).toISOString(), usedPercent: 42 })),
    ).toBeNull()
  })
})

// A sampler on a hand-turned clock: schedule records each timer's tick, and cancel marks it gone, as a failed hot reload clears it without a word.
const harness = () => {
  let now = T0
  const reads: number[] = []
  const timers: { cancelled: boolean; tick: () => void }[] = []
  const sampler = new Sampler({
    cancel: (timer) => {
      ;(timer as { cancelled: boolean }).cancelled = true
    },
    checkoutOf: checkouts,
    now: () => now,
    read: async () => {
      reads.push(now)
      return readings({ a: 0, run: 0 })
    },
    schedule: (tick) => {
      const timer = { cancelled: false, tick }
      timers.push(timer)
      return timer
    },
  })
  const tick = async () => {
    const live = timers.filter((t) => !t.cancelled)
    for (const timer of live) timer.tick()
    await Bun.sleep(0)
  }
  return {
    advance: (ms: number) => {
      now += ms
    },
    reads,
    sampler,
    tick,
    timers,
  }
}

describe("Sampler", () => {
  test("the first read starts it and waits for a sample; each tick takes another, served on the next read", async () => {
    const { advance, reads, sampler, tick, timers } = harness()
    const first = await sampler.report()
    expect(reads).toEqual([T0])
    expect(timers).toHaveLength(1)
    expect(first.sampledAt).toBe(new Date(T0).toISOString())
    advance(INTERVAL_MS)
    await tick()
    const second = await sampler.report()
    expect(second.sampledAt).toBe(new Date(T0 + INTERVAL_MS).toISOString())
    expect(second.history).toHaveLength(2)
    expect(timers).toHaveLength(1)
  })

  test("a timer gone quiet, as a failed hot reload leaves every timer, keeps sampling at the pace of reads and says so", async () => {
    const { advance, reads, sampler, tick, timers } = harness()
    await sampler.report()
    advance(INTERVAL_MS)
    await tick()
    expect((await sampler.report()).history).toHaveLength(2)
    // From here no timer fires: the reload cleared them, and Bun starts no new one in this process.
    timers.forEach((timer) => {
      timer.cancelled = true
    })
    advance(QUIET_MS + 1)
    expect(sampler.running()).toBe(false)
    const lost = await sampler.report()
    expect(lost.history).toHaveLength(3)
    expect(lost.problems).toEqual([TIMER_LOST])
    expect(lost.sampledAt).toBe(new Date(T0 + INTERVAL_MS + QUIET_MS + 1).toISOString())
    advance(INTERVAL_MS / 2)
    expect((await sampler.report()).history).toHaveLength(3)
    advance(INTERVAL_MS / 2)
    const next = await sampler.report()
    expect(next.history).toHaveLength(4)
    expect(reads).toHaveLength(4)
    expect(timers).toHaveLength(1)
    // A tick that does arrive again ends it.
    timers[0]?.tick()
    await Bun.sleep(0)
    expect((await sampler.report()).problems).toEqual([])
  })

  test("it stops once nobody has read it for STOP_UNREAD_MS, and a later read starts it again", async () => {
    const { advance, reads, sampler, tick, timers } = harness()
    await sampler.report()
    for (let at = INTERVAL_MS; at <= STOP_UNREAD_MS + INTERVAL_MS; at += INTERVAL_MS) {
      advance(INTERVAL_MS)
      await tick()
    }
    expect(timers[0]?.cancelled).toBe(true)
    expect(sampler.running()).toBe(false)
    const count = reads.length
    await sampler.report()
    expect(reads).toHaveLength(count + 1)
    expect(timers).toHaveLength(2)
  })
})

describe("checkoutOf", () => {
  test("the nearest directory holding .git, a worktree's file before the main checkout's folder", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "checkout-")))
    dirs.push(root)
    mkdirSync(join(root, ".git"))
    mkdirSync(join(root, ".claude/worktrees/a/api/hono"), { recursive: true })
    writeFileSync(join(root, ".claude/worktrees/a/.git"), "gitdir: elsewhere")
    mkdirSync(join(root, "docs"))
    expect(checkoutOf(join(root, ".claude/worktrees/a/api/hono"))).toBe(
      join(root, ".claude/worktrees/a"),
    )
    expect(checkoutOf(join(root, "docs"))).toBe(root)
    expect(checkoutOf(join(root, ".claude/worktrees/gone/api"))).toBe(
      join(root, ".claude/worktrees/gone/api"),
    )
    expect(checkoutOf("/")).toBeNull()
  })
})

describe("compose: a cluster", () => {
  const peerReading = {
    cores: 20,
    disk: { freeBytes: 300 * GB, totalBytes: 994 * GB },
    load: [0.4, 0.3, 0.2] as [number, number, number],
    memory: { totalBytes: 128 * GB, usedBytes: 4 * GB },
    swap: { totalBytes: 16 * GB, usedBytes: 1 * GB },
  }
  const up = { name: "machine-b", problem: null, reading: peerReading }
  const down = { name: "machine-b", problem: "ssh you@10.0.0.2 ran past 5s", reading: null }
  const sample = (peers: Readings["peers"], state: SamplerState, at: number) =>
    compose({ ...readings({ a: 0, run: 0 }), peers }, state, at, checkouts)

  test("with no peers there are no machines, and the hour's point is this machine's alone, as before", () => {
    const { report } = sample([], freshState(T0), T0)
    expect(report.machines).toEqual([])
    expect(report.history.at(-1)).toMatchObject({
      load1: 11.7,
      swapUsedBytes: 4.9 * GB,
      usedBytes: 17 * GB,
    })
  })

  test("with a peer that reads, this machine comes first under its name, then the peer, and the hour's point is their sum", () => {
    const { report } = sample([up], freshState(T0), T0)
    expect(report.machines).toEqual([
      {
        down: null,
        name: "machine-a",
        reading: {
          cores: 15,
          disk: { freeBytes: 785 * GB, totalBytes: 994 * GB },
          load: [11.7, 10.6, 9.1],
          memory: { totalBytes: 24 * GB, usedBytes: 17 * GB },
          swap: { totalBytes: 6 * GB, usedBytes: 4.9 * GB },
        },
      },
      { down: null, name: "machine-b", reading: peerReading },
    ])
    expect(report.history.at(-1)).toMatchObject({
      load1: 12.1,
      swapUsedBytes: 5.9 * GB,
      usedBytes: 21 * GB,
    })
    // this machine's own figures, which the sidebar and the room for workers judge, stay its own
    expect(report.cpu.cores).toBe(15)
    expect(report.memory.totalBytes).toBe(24 * GB)
  })

  test("a peer that does not read is down with its reason since the first sample that missed it, never zeros, and is up again once it reads", () => {
    const first = sample([down], freshState(T0), T0)
    expect(first.report.machines[1]).toEqual({
      down: { reason: "ssh you@10.0.0.2 ran past 5s", since: new Date(T0).toISOString() },
      name: "machine-b",
      reading: null,
    })
    expect(first.report.history.at(-1)).toMatchObject({ load1: 11.7, usedBytes: 17 * GB })
    const second = sample([down], first.state, T0 + INTERVAL_MS)
    expect(second.report.machines[1]?.down?.since).toBe(new Date(T0).toISOString())
    const back = sample([up], second.state, T0 + 2 * INTERVAL_MS)
    expect(back.report.machines[1]?.down).toBeNull()
    const again = sample([down], back.state, T0 + 3 * INTERVAL_MS)
    expect(again.report.machines[1]?.down?.since).toBe(new Date(T0 + 3 * INTERVAL_MS).toISOString())
  })
})
