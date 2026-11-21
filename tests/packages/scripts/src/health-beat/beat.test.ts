import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  beatText,
  memoryPasses,
  readBeat,
  type Reading,
} from "../../../../../packages/scripts/src/health-beat/beat"
import { procDir } from "../../../../scripts/fixtures/proc"

const scratch = mkdtempSync(join(tmpdir(), "health-beat-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const AT = new Date("2026-11-01T18:05:00Z")

const reading = (over: Partial<Reading> = {}): Reading => ({
  at: AT,
  cores: 12,
  down: [],
  freeMin: 8,
  freePct: 64,
  idlePct: 41,
  late: [],
  load5: 6.4,
  ok: 9,
  pressure: 1,
  running: { build: "main build, at 1a1291d", version: "v0.0.23 + 1 local commit (8b6438a)" },
  sessions: { idle: 3, working: 5 },
  zone: "UTC",
  ...over,
})

describe("memoryPasses, spawn.sh's memory gate", () => {
  test("passes at pressure 1 or 2 and refuses at 4", () => {
    expect(memoryPasses(1, 64, 8)).toBe(true)
    expect(memoryPasses(2, 64, 8)).toBe(true)
    expect(memoryPasses(4, 64, 8)).toBe(false)
  })

  test("passes at 8% free and refuses at 7% under the default floor, and follows a moved one", () => {
    expect(memoryPasses(1, 8, 8)).toBe(true)
    expect(memoryPasses(1, 7, 8)).toBe(false)
    expect(memoryPasses(1, 9, 10)).toBe(false)
  })
})

describe("beatText", () => {
  test("prints the header in the owner's zone, then the version and build, the Mac, memory, sessions and ops jobs", () => {
    expect(beatText(reading())).toBe(
      [
        "*Health, 6:05 pm UTC*",
        "🏷️ Main checkout: v0.0.23 + 1 local commit (8b6438a)",
        "🏗️ Dashboard: main build, at 1a1291d",
        "✅ Mac: load 6 on 12 cores, 41% CPU idle",
        "✅ Memory: pressure 1 (normal), 64% free",
        "✅ Sessions: 5 working, 3 idle, 0 stuck",
        "✅ Ops jobs: 9 ok",
      ].join("\n"),
    )
    expect(beatText(reading({ zone: "Asia/Kolkata" })).split("\n")[0]).toBe(
      "*Health, 11:35 pm IST*",
    )
  })

  test("warns on memory only when spawn's gate would refuse a start", () => {
    const memory = (pressure: number, freePct: number) =>
      beatText(reading({ freePct, pressure })).split("\n")[4]
    expect(memory(2, 8)).toBe("✅ Memory: pressure 2 (warning), 8% free")
    expect(memory(1, 7)).toBe(
      "⚠️ Memory: pressure 1 (normal), 7% free, so spawn's gate refuses a Claude start",
    )
    expect(memory(4, 64)).toBe(
      "⚠️ Memory: pressure 4 (critical), 64% free, so spawn's gate refuses a Claude start",
    )
  })

  test("warns on a load5 over 15, a stuck or failed session and a late ops job, and reads an unknown CPU as ?", () => {
    const lines = beatText(
      reading({
        idlePct: null,
        late: ["ops-sweep", "ops-tick"],
        load5: 15.6,
        sessions: { failed: 1, stuck: 1, working: 2 },
      }),
    ).split("\n")
    expect(lines[3]).toBe("⚠️ Mac: load 16 on 12 cores, ?% CPU idle")
    expect(lines[5]).toBe("⚠️ Sessions: 2 working, 0 idle, 2 stuck")
    expect(lines[6]).toBe("⚠️ Ops jobs: 9 ok, late: ops-sweep, ops-tick")
  })

  test("warns on an ops job that is down, beside any late one", () => {
    expect(beatText(reading({ down: ["ops-never"] })).split("\n")[6]).toBe(
      "⚠️ Ops jobs: 9 ok, down: ops-never",
    )
    expect(beatText(reading({ down: ["ops-never"], late: ["ops-tick"] })).split("\n")[6]).toBe(
      "⚠️ Ops jobs: 9 ok, late: ops-tick, down: ops-never",
    )
  })
})

describe("readBeat", () => {
  test("reads the Mac through ops-machine, the sessions of the last 2 hours, each job's heartbeat but a disabled one's and a job with no readable heartbeat as down", async () => {
    const data = join(scratch, "data")
    const ops = join(data, "ops")
    const states = join(data, "session-state")
    mkdirSync(ops, { recursive: true })
    mkdirSync(states, { recursive: true })
    const state = (id: string, name: string, minutesAgo: number) =>
      writeFileSync(
        join(states, `${id}.json`),
        JSON.stringify({
          at: new Date(AT.getTime() - minutesAgo * 60_000).toISOString(),
          event: "Stop",
          sessionId: id,
          state: name,
        }),
      )
    state("a", "working", 5)
    state("b", "working", 30)
    state("c", "idle", 60)
    state("d", "stuck", 10)
    state("e", "working", 180)
    writeFileSync(join(states, "f.json"), "not json")
    writeFileSync(
      join(ops, "jobs.json"),
      JSON.stringify({
        jobs: [
          { name: "ops-sweep" },
          { heartbeat: "ops-tick-beat", name: "ops-tick" },
          { name: "ops-flow" },
          { disabled: true, name: "ops-off" },
          { name: "ops-never" },
          { name: "ops-broken" },
          { name: "ops-empty" },
          { disabled: true, name: "ops-paused" },
        ],
      }),
    )
    const beat = (name: string, secondsAgo: number, lastResult = "ok", cycleSeconds = 300) =>
      writeFileSync(
        join(ops, `${name}.json`),
        JSON.stringify({
          cycleSeconds,
          lastBeatAt: new Date(AT.getTime() - secondsAgo * 1000).toISOString(),
          lastResult,
        }),
      )
    beat("ops-sweep", 120)
    beat("ops-tick-beat", 1000)
    beat("ops-flow", 60, "error: boom")
    beat("ops-off", 99_999)
    writeFileSync(join(ops, "ops-broken.json"), "not json")
    writeFileSync(join(ops, "ops-empty.json"), "[]")
    const sysctl: Record<string, string> = {
      "hw.ncpu": "12",
      "kern.memorystatus_level": "7",
      "kern.memorystatus_vm_pressure_level": "1",
      "vm.loadavg": "{ 3.10 4.20 5.30 }",
      "vm.swapusage": "total = 0.00M  used = 0.00M  free = 0.00M",
    }
    const run = async (argv: string[]) => {
      if (argv[0] === "sysctl") return { code: 0, out: `${sysctl[argv[2]!]}\n` }
      if (argv[0] === "top")
        return {
          code: 0,
          out: "CPU usage: 10.0% user, 5.0% sys, 85.0% idle\nCPU usage: 30.5% user, 9.0% sys, 60.5% idle\n",
        }
      return { code: 1, out: "" }
    }
    const got = await readBeat({
      at: AT,
      data,
      freeMin: 8,
      portless: join(scratch, "no-portless"),
      repo: join(scratch, "repo"),
      run,
      zone: "UTC",
    })
    expect(got).toEqual({
      at: AT,
      cores: 12,
      down: ["ops-never", "ops-broken", "ops-empty"],
      freeMin: 8,
      freePct: 7,
      idlePct: 60.5,
      late: ["ops-tick", "ops-flow"],
      load5: 4.2,
      ok: 1,
      pressure: 1,
      running: {
        build:
          "unknown (portless has no route for playground.localhost), at unknown (portless has no route for api.playground.localhost)",
        version: "unknown (git describe: no output)",
      },
      sessions: { idle: 1, stuck: 1, working: 2 },
      zone: "UTC",
    })
  })
})

// Linux's top has no -l, so the idle share comes from two /proc/stat reads a wait apart, and with neither it reads as unknown, never 0 (#2201).
describe("the idle share where top has no -l", () => {
  const saved = process.env.PLAYGROUND_PROC
  afterAll(() => {
    process.env.PLAYGROUND_PROC = saved
  })
  const linux = async (argv: string[]) =>
    argv[0] === "top"
      ? { code: 1, out: "top: unknown option 'l'\n" }
      : argv[0] === "sysctl"
        ? { code: 255, out: `sysctl: cannot stat /proc/sys/${argv[2]!.replaceAll(".", "/")}\n` }
        : { code: 1, out: "" }
  const read = (wait: () => Promise<void>) =>
    readBeat({
      at: AT,
      data: join(scratch, "linux"),
      freeMin: 8,
      portless: join(scratch, "no-portless"),
      repo: join(scratch, "repo"),
      run: linux,
      wait,
      zone: "UTC",
    })

  test("reads /proc/stat twice", async () => {
    const dir = procDir({ cores: 20, idle: 37.5, load5: 4 }, [], [["stat"]])
    process.env.PLAYGROUND_PROC = dir
    const got = await read(async () =>
      renameSync(join(dir, "later", "1", "stat"), join(dir, "stat")),
    )
    expect(got).toMatchObject({ cores: 20, idlePct: 37.5, load5: 4 })
  })

  test("reads unknown when /proc/stat does not move between the reads", async () => {
    process.env.PLAYGROUND_PROC = procDir()
    expect(await read(async () => {})).toMatchObject({ idlePct: null })
  })
})
