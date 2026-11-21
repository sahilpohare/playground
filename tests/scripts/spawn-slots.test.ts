import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { capacityLog, placing, root, scratch, script, slots, spawn } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

// the CPU 80% idle, so run-slot's gauges open every lane it does not hold
const start = (args: string[], held: number, waiters: number, units?: number) =>
  spawn(args, [], { FAKE_CPU_IDLE: "80" }, undefined, undefined, slots(held, waiters, units))
const worker = ["worker", "worker-brave-otter", "b.md"]

describe("the slots gate admits a new worker only when run-slot has room for its runs", () => {
  test("a worker start is refused while every lane is held and waiters queue", async () => {
    const r = await start(worker, 4, 2)
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      "the slots gate holds it: run-slot's 4 lanes are all held, and 2 runs wait in its queue (run-slot.sh room)",
    )
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        gate: "slots",
        readings: expect.objectContaining({ lanes: 4, lanes_free: 0, lanes_held: 4, waiters: 2 }),
        verdict: "refused",
      }),
    ])
  })

  test("a worker start is refused while the free lanes lack the load units for a run", async () => {
    const r = await start(worker, 2, 1, 3)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the slots gate holds it: 2 of run-slot's 4 lanes are held and the rest lack the load units for a run, and 1 run waits in its queue",
    )
  })

  test.each(["reviewer", "tester"])("a %s start passes on the same full lanes", async (role) => {
    const r = await start(
      ["column", role, `${role}-x`, "worker-x", "w1:p2", "b.md", "--pr", "1"],
      4,
      2,
    )
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([expect.objectContaining({ verdict: "pass" })])
  })

  test("a worker start passes while a lane is free with the load units for a run, waiters or not", async () => {
    const r = await start(worker, 3, 2, 1)
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({ lanes: 4, lanes_free: 1, lanes_held: 3, waiters: 2 }),
        verdict: "pass",
      }),
    ])
  })

  test("a worker start passes on held lanes with no one waiting", async () => {
    const r = await start(worker, 4, 0)
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([expect.objectContaining({ verdict: "pass" })])
  })

  // a reads-only worker reads code and never takes a run-slot lane, so a full room leaves it be (#833)
  test("a --reads-only worker start passes a full room and its row records reads-only, while a plain one is refused (#833)", async () => {
    const r = await start([...worker, "--reads-only"], 4, 12)
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({ reads_only: true }),
        verdict: "pass",
      }),
    ])
    const plain = await start(worker, 4, 12)
    expect(plain.code).not.toBe(0)
    expect(plain.err).toContain("the slots gate holds it")
  })

  test.each([
    ["a runner", ["runner", "runner-x", "b.md"]],
    ["a reviewer", ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "b.md", "--pr", "1"]],
  ])("--reads-only on %s start is refused as a worker's flag alone", async (_, args) => {
    const r = await start([...args, "--reads-only"], 0, 0)
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain("--reads-only is for a worker")
  })

  // run-slot's queue full, as on 6 Nov's urgent start: the free lanes lack the load units, and 8 runs wait.
  const fullQueue = slots(2, 8, 3)
  const standing = (home: string) => writeFileSync(join(home, ".playground", "priority.json"), "{}")
  const trigger = (home: string) => {
    fullQueue(home)
    standing(home)
  }
  const urgent = (args: string[], setup: (home: string) => void) =>
    spawn(args, [], { FAKE_CPU_IDLE: "80" }, undefined, undefined, setup)

  test("a --priority worker start passes a full queue while priority.json stands (#1147)", async () => {
    const r = await urgent([...worker, "--priority"], trigger)
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({
          priority: expect.stringMatching(/\/\.playground\/priority\.json$/),
          lanes_free: 0,
          waiters: 8,
        }),
        verdict: "pass",
      }),
    ])
  })

  test("a worker start without --priority keeps the slots gate while priority.json stands", async () => {
    const r = await urgent(worker, trigger)
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain("the slots gate holds it")
  })

  test("a --priority worker start with no priority file standing is refused, naming the files", async () => {
    const r = await urgent([...worker, "--priority"], fullQueue)
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain("--priority starts only while a priority file stands in")
    expect(r.err).toContain(
      "priority.json, priority-start.json or another priority-<name>.json), and none does",
    )
    expect(r.err).toContain('playground priority on <session> --reason "<why>" opens one')
  })

  // the old names went with the core start job: --firefighting is no flag, and an old file name is no priority file
  test("a --firefighting worker start passes no gate while priority.json stands", async () => {
    const r = await urgent([...worker, "--firefighting"], trigger)
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
  })

  test.each(["firefighting-stop.json", "firefighting-headstart.json", "firefighting-start.json"])(
    "a --priority worker start while only the old %s stands is refused",
    async (file) => {
      const r = await urgent([...worker, "--priority"], (home) => {
        fullQueue(home)
        writeFileSync(join(home, ".playground", file), "{}")
      })
      expect(r.code).not.toBe(0)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain("--priority starts only while a priority file stands in")
    },
  )

  // --priority passes a full queue under every priority file: priority.json, a job's priority-start.json and an org's own priority-<name>.json (#1334)
  test.each(
    [
      "priority.json",
      "priority-start.json",
      "priority-stop.json",
      "priority-headstart.json",
      "priority-acme.json",
    ].map((file) => ["--priority", file]),
  )("a %s worker start passes a full queue while %s stands (#1334)", async (flag, file) => {
    const r = await urgent([...worker, flag!], (home) => {
      fullQueue(home)
      writeFileSync(join(home, ".playground", file!), "{}")
    })
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({
          priority: expect.stringMatching(
            new RegExp(`/\\.playground/${file!.replaceAll(".", "\\.")}$`),
          ),
          waiters: 8,
        }),
        verdict: "pass",
      }),
    ])
  })

  // a session's own window, as playground priority on writes it, passes only the start it names, as run-slot's queue reads it (#2491)
  const ownWindow = (home: string, session: string) =>
    writeFileSync(
      join(home, ".playground", `priority-${session}.json`),
      `${JSON.stringify({ by: "dispatcher", reason: "the owner's ask", session, since: "2026-11-16T22:00:00.000Z" }, null, 2)}\n`,
    )
  const passedOn = (r: Awaited<ReturnType<typeof urgent>>, file: string) => {
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({
          priority: expect.stringMatching(
            new RegExp(`/\\.playground/${file.replaceAll(".", "\\.")}$`),
          ),
        }),
        verdict: "pass",
      }),
    ])
  }
  const refusedWith = (r: Awaited<ReturnType<typeof urgent>>, why: string) => {
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain("--priority starts only on a priority file that passes it, and none in")
    expect(r.err).toContain(why)
    expect(r.err).toContain('playground priority on worker-brave-otter --reason "<why>" opens one')
  }

  test("a --priority start is refused while only another session's window stands (#2491)", async () => {
    const r = await urgent([...worker, "--priority"], (home) => {
      fullQueue(home)
      ownWindow(home, "probe-y")
    })
    refusedWith(r, "priority-probe-y.json is probe-y's own window")
  })

  test("and passes on its own window, though another session's sorts ahead of it (#2491)", async () => {
    const r = await urgent([...worker, "--priority"], (home) => {
      fullQueue(home)
      ownWindow(home, "probe-y")
      ownWindow(home, "aaa-probe")
      ownWindow(home, "worker-brave-otter")
    })
    passedOn(r, "priority-worker-brave-otter.json")
  })

  test("and passes on a shared file beside another session's window (#2491)", async () => {
    const r = await urgent([...worker, "--priority"], (home) => {
      fullQueue(home)
      ownWindow(home, "aaa-probe")
      writeFileSync(join(home, ".playground", "priority-acme.json"), '{ "org": "acme" }\n')
    })
    passedOn(r, "priority-acme.json")
  })

  // a window cut short or emptied mid-write has lost its session line, so a file that is no JSON object passes no start, whatever its name; one that names a session outside run-slot's shape passes none either, since the queue ranks it for none
  test.each([
    ["an empty", "", "is no JSON object"],
    [
      "a truncated",
      '{\n  "by": "dispatcher",\n  "reason": "x",\n  "session": "worker-brave',
      "is no JSON object",
    ],
    [
      "a one-line",
      `${JSON.stringify({ by: "dispatcher", reason: "x", session: "worker-brave-otter", since: "2026-11-16T22:00:00.000Z" })}\n`,
      "names a session but is no window in playground priority on's shape",
    ],
  ])("%s priority-worker-brave-otter.json refuses its own start (#2491)", async (_, text, why) => {
    const r = await urgent([...worker, "--priority"], (home) => {
      fullQueue(home)
      writeFileSync(join(home, ".playground", "priority-worker-brave-otter.json"), text)
    })
    refusedWith(r, `priority-worker-brave-otter.json ${why}`)
  })

  test.each([
    ["a worker start", worker],
    ["a --priority worker start, priority.json standing,", [...worker, "--priority"]],
  ])("%s is refused when run-slot.sh room gives no reading", async (_, args) => {
    // a scratch checkout holding spawn.sh, its data-folder resolver and a run-slot.sh that prints nothing
    const checkout = mkdtempSync(join(scratch, "no-room-"))
    mkdirSync(join(checkout, "scripts", "ops"), { recursive: true })
    writeFileSync(join(checkout, "scripts", "spawn.sh"), readFileSync(script))
    writeFileSync(join(checkout, "scripts", "ops", "run-slot.sh"), "#!/bin/bash\nexit 0\n")
    chmodSync(join(checkout, "scripts", "ops", "run-slot.sh"), 0o755)
    mkdirSync(join(checkout, "packages", "env", "src"), { recursive: true })
    for (const file of ["aliases.ts", "data-dir.ts"])
      writeFileSync(
        join(checkout, "packages", "env", "src", file),
        readFileSync(join(root, "packages", "env", "src", file)),
      )
    const r = await spawn(args, [], {}, join(checkout, "scripts", "spawn.sh"), undefined, standing)
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      "the slots gate holds it: it cannot read run-slot's lanes and queue (run-slot.sh room)",
    )
  })
})
