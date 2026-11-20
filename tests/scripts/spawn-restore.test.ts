import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  capacityLog,
  herdrPin,
  lw,
  minutesAgo,
  placing,
  root,
  spawn,
  transcript,
} from "./spawn-fake"

// Each case runs restore, which runs spawn.sh resume once a record, each starting fake processes.
setDefaultTimeout(60_000)

const ids = {
  builder: "bbbbbbbb-0000-4000-8000-0000000000b1",
  optimizer: "cccccccc-0000-4000-8000-0000000000c1",
  planner: "dddddddd-0000-4000-8000-0000000000d1",
}
const managers = Object.keys(ids) as (keyof typeof ids)[]
const row = (name: string, status: string) => ({
  kind: name,
  name,
  role: "manager",
  status,
  task: "t",
})

// A resume record for each manager as spawn.sh writes it, with no --account, on the factory's server.
const recorded = (home: string) => {
  herdrPin()(home)
  for (const dir of ["resume", "runtimes", "backends"])
    mkdirSync(lw(home, dir), { recursive: true })
  for (const name of managers) {
    writeFileSync(
      lw(home, "resume", `${name}.sh`),
      `#!/bin/bash\n# server: playground\nexec /x/scripts/spawn.sh resume ${name} ${root} ${ids[name]}\n`,
    )
    writeFileSync(lw(home, "runtimes", name), "herdr\n")
    writeFileSync(lw(home, "backends", name), "claude\n")
    transcript(home, ids[name])
  }
}

describe("restore resumes every manager its records name, or says which it left and why", () => {
  test("a manager whose row reads starting is resumed, as one that should be up", async () => {
    const r = await spawn(
      ["restore"],
      [],
      { ROSTER_JSON: JSON.stringify({ agents: managers.map((name) => row(name, "starting")) }) },
      undefined,
      undefined,
      recorded,
    )
    expect(r.out).toBe("restored builder\nrestored optimizer\nrestored planner\n")
    expect(r.code).toBe(0)
    expect(placing(r).filter((c) => c[1] === "run")).toHaveLength(3)
    expect(readFileSync(lw(r.home, "launch", "planner.sh"), "utf8")).toContain(
      `--resume ${ids.planner} -n planner`,
    )
  })

  test("a manager the load gate holds is printed as waiting with the gate's reason, and the run exits 0, since a wait is progress (#1682)", async () => {
    const r = await spawn(
      ["restore"],
      [],
      {
        FAKE_LOAD1: "77.00",
        FAKE_LOAD5: "77.00",
        ROSTER_JSON: JSON.stringify({ agents: managers.map((name) => row(name, "starting")) }),
      },
      undefined,
      undefined,
      recorded,
    )
    const lines = r.out.split("\n").filter(Boolean)
    expect(lines).toHaveLength(3)
    for (const [i, name] of managers.entries())
      expect(lines[i]).toStartWith(
        `waiting ${name}: the load gate holds it: max(load1, load5) is 77.00`,
      )
    expect(r.code).toBe(0)
    expect(placing(r).filter((c) => c[1] === "run")).toEqual([])
    expect(capacityLog(r).filter((l) => l.gate === "load")).toHaveLength(3)
  })

  // #1682 round 1: focus ends by itself, so a resume it holds waits as a gate's does.
  test("a manager focus holds is printed as waiting, and the run exits 0", async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString()
    const r = await spawn(
      ["restore"],
      [],
      { ROSTER_JSON: JSON.stringify({ agents: managers.map((name) => row(name, "starting")) }) },
      undefined,
      undefined,
      (home: string) => {
        recorded(home)
        writeFileSync(lw(home, "focus.json"), JSON.stringify({ session: "other-worker", until }))
      },
    )
    const lines = r.out.split("\n").filter(Boolean)
    expect(lines).toHaveLength(3)
    for (const [i, name] of managers.entries())
      expect(lines[i]).toStartWith(`waiting ${name}: focus stands for other-worker until ${until}`)
    expect(r.code).toBe(0)
    expect(placing(r).filter((c) => c[1] === "run")).toEqual([])
  })

  // #1682 round 1: a bad setting never clears by waiting, so it is a failure, not a wait.
  test("a gate that reads a bad setting is not restored, and the run exits 1", async () => {
    const r = await spawn(
      ["restore"],
      [],
      {
        PLAYGROUND_LOAD_MULT: "abc",
        ROSTER_JSON: JSON.stringify({ agents: managers.map((name) => row(name, "starting")) }),
      },
      undefined,
      undefined,
      recorded,
    )
    const lines = r.out.split("\n").filter(Boolean)
    expect(lines).toHaveLength(3)
    for (const [i, name] of managers.entries())
      expect(lines[i]).toStartWith(
        `not restored ${name}: the load gate holds it: PLAYGROUND_LOAD_MULT is abc`,
      )
    expect(r.code).toBe(1)
  })

  // #1696: a run read the roster once at its start, so a close that landed while it resumed others was undone 6 s later.
  test("a session closed while the restore runs is skipped, since its resume reads the row again once it finds the session gone", async () => {
    const r = await spawn(
      ["restore"],
      [],
      {
        FAKE_HERDR_RUN_ENDS: "planner",
        ROSTER_JSON: JSON.stringify({ agents: managers.map((name) => row(name, "starting")) }),
      },
      undefined,
      undefined,
      recorded,
    )
    expect(r.out).toBe(
      "restored builder\nrestored optimizer\nskipped planner: its roster row reads ended\n",
    )
    expect(r.code).toBe(0)
    expect(placing(r).filter((c) => c[1] === "run")).toHaveLength(2)
  })

  // A close can land after the resume's first read, during the gates and the pane's placement, or during the launch itself.
  const plannerAlone = JSON.stringify({
    agents: [row("builder", "ended"), row("optimizer", "ended"), row("planner", "starting")],
  })
  const downAbove =
    "skipped builder: its roster row reads ended\nskipped optimizer: its roster row reads ended\n"

  test("a session closed after its gate passed is skipped, since its resume reads the row again just before the launch", async () => {
    const r = await spawn(
      ["restore"],
      [],
      { FAKE_HERDR_LIST_ENDS: "planner", ROSTER_JSON: plannerAlone },
      undefined,
      undefined,
      recorded,
    )
    expect(r.out).toBe(`${downAbove}skipped planner: its roster row reads ended\n`)
    expect(r.code).toBe(0)
    expect(
      capacityLog(r).filter((l) => l.session === "planner" && l.verdict === "pass"),
    ).toHaveLength(1)
    expect(placing(r).filter((c) => c[1] === "run")).toEqual([])
    expect(existsSync(lw(r.home, "launch", "planner.sh"))).toBe(false)
    expect((r.rosterLog ?? []).filter((l) => l.includes("status=starting"))).toEqual([])
  })

  test("a session closed while its launch runs keeps its ended row, so the next restore leaves it down", async () => {
    const r = await spawn(
      ["restore"],
      [],
      { FAKE_HERDR_RUN_ENDS: "planner", ROSTER_JSON: plannerAlone },
      undefined,
      undefined,
      recorded,
    )
    expect(r.out).toBe(`${downAbove}restored planner\n`)
    expect(r.code).toBe(0)
    expect(r.rosterLog?.some((l) => l.startsWith("set planner "))).toBe(true)
    expect((r.rosterLog ?? []).filter((l) => l.includes("status=starting"))).toEqual([])
  })

  test.each([
    ["by hand reopens it and sets the row to starting", {}, 0, 1],
    ["from restore leaves it down and exits 4", { SPAWN_RESTORING: "1" }, 4, 0],
  ])("a resume of an ended row %s", async (_, env, code, runs) => {
    const r = await spawn(
      ["resume", "planner", root, ids.planner],
      [],
      { ...env, ROSTER_JSON: JSON.stringify({ agents: [row("planner", "ended")] }) },
      undefined,
      undefined,
      recorded,
    )
    expect(r.code).toBe(code)
    expect(placing(r).filter((c) => c[1] === "run")).toHaveLength(runs)
    expect((r.rosterLog ?? []).some((l) => l.includes("status=starting"))).toBe(runs === 1)
    if (code === 4) expect(r.err).toContain("spawn.sh refuses planner: its roster row reads ended")
  })

  test("each record it passes over is named with its reason", async () => {
    const r = await spawn(
      ["restore"],
      [],
      {
        ROSTER_JSON: JSON.stringify({
          agents: [
            row("builder", "ended"),
            row("optimizer", "starting"),
            row("planner", "starting"),
          ],
        }),
      },
      undefined,
      undefined,
      (home) => {
        recorded(home)
        for (const [name, ok] of [
          ["worker-a", false],
          ["worker-b", true],
          ["worker-c", true],
        ] as const) {
          writeFileSync(
            lw(home, "resume", `${name}.sh`),
            ok
              ? `#!/bin/bash\nexec /x/scripts/spawn.sh resume ${name} ${root} ${ids.planner} --brief x.md\n`
              : "#!/bin/bash\n",
          )
          if (name !== "worker-c") writeFileSync(lw(home, "runtimes", name), "herdr\n")
        }
        // a pin holding another word, or none, skips no record: every session resumes in herdr
        writeFileSync(lw(home, "runtimes", "optimizer"), "made-up\n")
      },
    )
    expect(r.out).toBe(
      [
        "skipped builder: its roster row reads ended",
        "restored optimizer",
        "restored planner",
        "skipped worker-a: its resume record has no exec line",
        "skipped worker-b: its exec line is not a resume restore runs",
        "skipped worker-c: its exec line is not a resume restore runs",
        "",
      ].join("\n"),
    )
    expect(r.code).toBe(0)
    expect(readFileSync(lw(r.home, "runtimes", "optimizer"), "utf8")).toBe("herdr\n")
  })
})

// #2065: after a reboot load5 still carries the boot's spike and each settled start still counts, so a manager is judged by the CPU's idle share (top -l 2 -n 0) and memory, while a worker keeps the load line.
describe("a manager's start or resume goes by the CPU's idle share and memory, a worker's by the load line", () => {
  const starts = `${[...Array(4)]
    .map(() => JSON.stringify({ at: minutesAgo(1), gate: null, readings: {}, verdict: "pass" }))
    .join("\n")}\n`
  const busy = { CAPACITY_JSONL: starts, FAKE_FREE: "50", FAKE_LOAD1: "8.53", FAKE_LOAD5: "8.53" }
  const roster = JSON.stringify({
    agents: [
      ...managers.map((name) => row(name, "starting")),
      { kind: "worker", name: "worker-brave-otter", role: "worker", status: "working", task: "t" },
    ],
  })
  const resume = (name: string, env: Record<string, string>) =>
    spawn(
      ["resume", name, root, ids.builder],
      [],
      { ...busy, ROSTER_JSON: roster, SPAWN_RESTORING: "1", ...env },
      undefined,
      undefined,
      (home) => {
        recorded(home)
        writeFileSync(lw(home, "backends", "worker-brave-otter"), "claude\n")
      },
    )

  test("a manager's restore passes a high load and recent starts while the CPU reads idle and memory free", async () => {
    const r = await resume("builder", { FAKE_CPU_IDLE: "63.00" })
    expect(r.err).not.toContain("gate holds it")
    expect(r.code).toBe(0)
    expect(placing(r).filter((c) => c[1] === "run")).toHaveLength(1)
    expect(capacityLog(r).at(-1)).toEqual(
      expect.objectContaining({
        readings: expect.objectContaining({ cpu_idle: 63, load5: 8.53, starts: 4 }),
        session: "builder",
        verdict: "pass",
      }),
    )
  })

  test("a manager's start by manager mode passes on the same readings", async () => {
    const r = await spawn(["manager", "optimizer", "b.md"], [], {
      ...busy,
      FAKE_CPU_IDLE: "63.00",
      ROSTER_JSON: roster,
    })
    expect(r.err).not.toContain("gate holds it")
    expect(r.code).toBe(0)
  })

  test("a manager's restore is held while the CPU reads busy, naming the idle share", async () => {
    const r = await resume("builder", { FAKE_CPU_IDLE: "10.00" })
    expect(r.code).not.toBe(0)
    expect(placing(r).filter((c) => c[1] === "run")).toEqual([])
    expect(r.err).toContain("the load gate holds it: max(load1, load5) is 8.53")
    expect(r.err).toContain("the CPU reads 10% idle (top -l 2 -n 0), under the 40% a manager needs")
  })

  test("a manager's restore is held while memory shows no room, however idle the CPU", async () => {
    const r = await resume("builder", { FAKE_CPU_IDLE: "63.00", FAKE_FREE: "3" })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("the memory gate holds it: free is 3%")
  })

  test("a worker's restore under the same readings is judged by the load line, as before", async () => {
    const r = await resume("worker-brave-otter", { FAKE_CPU_IDLE: "63.00" })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the load gate holds it: max(load1, load5) is 8.53 and 4 started in the last 5 minutes, at or over 11.25",
    )
    expect(existsSync(join(r.home, "top.calls"))).toBe(false)
  })
})

describe("restore runs the managers ahead of the workers", () => {
  test("a worker's record that sorts first resumes after every manager", async () => {
    const r = await spawn(
      ["restore"],
      [],
      {
        ROSTER_JSON: JSON.stringify({
          agents: [
            { kind: "worker", name: "bcdfgh-worker", role: "worker", status: "working", task: "t" },
            ...managers.map((name) => row(name, "starting")),
          ],
        }),
      },
      undefined,
      undefined,
      (home) => {
        recorded(home)
        writeFileSync(
          lw(home, "resume", "bcdfgh-worker.sh"),
          `#!/bin/bash\n# server: playground\nexec /x/scripts/spawn.sh resume bcdfgh-worker ${root} ${ids.planner}\n`,
        )
        writeFileSync(lw(home, "runtimes", "bcdfgh-worker"), "herdr\n")
        writeFileSync(lw(home, "backends", "bcdfgh-worker"), "claude\n")
      },
    )
    expect(r.out).toBe(
      "restored builder\nrestored optimizer\nrestored planner\nrestored bcdfgh-worker\n",
    )
    expect(r.code).toBe(0)
  })
})
