import { describe, expect, setDefaultTimeout, test } from "bun:test"

import { procDir, type Proc } from "./fixtures/proc"
import { capacityLog, placing, spawn } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

// Ubuntu's answers (FAKE_LINUX): no macOS command reads, so each reading comes from /proc's recorded text, a second read `later` on where it takes two (#2201).
const linux = (proc: Proc = {}, omit: string[] = [], later: string[][] = []) => ({
  FAKE_LINUX: "1",
  PLAYGROUND_PROC: procDir(proc, omit, later),
})
const worker = ["worker", "worker-brave-otter", "b.md"]
const glm = [...worker, "--backend", "glm"]

describe("on Linux the capacity gate reads /proc", () => {
  test("a calm machine passes a worker start, each reading from its /proc text", async () => {
    const r = await spawn(worker, [], linux({ cores: 20, free: 50, load1: 1.25, load5: 2.5 }))
    expect(r.code, r.err).toBe(0)
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({
        readings: expect.objectContaining({
          cores: 20,
          free: 50,
          load5: 2.5,
          pressure: 1,
          swapins: 0,
        }),
        verdict: "pass",
      }),
    ])
  })

  test("/proc/loadavg's load at the cores holds a start", async () => {
    const r = await spawn(["runner", "runner-x", "b.md"], [], linux({ cores: 20, load5: 20 }))
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      "the load gate holds it: max(load1, load5) is 20.00 and 0 started in the last 5 minutes, at or over",
    )
    expect(r.err).toContain("the 20 cores")
  })

  test("PSI's some avg10 at 10% reads as pressure level 2, which passes", async () => {
    const r = await spawn(worker, [], linux({ some: 10 }))
    expect(r.code, r.err).toBe(0)
    expect(capacityLog(r).at(-1).readings.pressure).toBe(2)
  })

  test("PSI's full avg10 at 10% reads as pressure level 4, which holds a start", async () => {
    const r = await spawn(worker, [], linux({ full: 10, some: 30 }))
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the memory gate holds it: pressure level is 4 (/proc/pressure/memory), 1 or 2 passes",
    )
  })

  test("MemAvailable under the floor holds a start", async () => {
    const r = await spawn(worker, [], linux({ free: 7 }))
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("the memory gate holds it: free is 7% (/proc/meminfo), 8% is the floor")
  })

  // a fresh worker's start reads run-slot's room first, whose gauges take the first two second reads, then the gate's three
  test("pswpin's rise at 150 a second holds a fresh worker start", async () => {
    const r = await spawn(
      worker,
      [],
      linux(
        { free: 62, swapins: 150 },
        [],
        [["stat"], ["vmstat"], ["vmstat"], ["vmstat"], ["vmstat"]],
      ),
    )
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the memory gate holds it: swap-ins are 150/s (/proc/vmstat), 100/s is the line, while free reads 62% (/proc/meminfo), which counts compressible pages",
    )
  })

  // a GLM worker reads run-slot's room first too, whose gauges take the first two second reads (its swap-ins at 0), then the gate's three
  test.each([
    ["a start on one second at 8403, then seconds at 5, passes, reading 5", [0, 8403, 5, 5], 5],
    ["two of the three seconds over 100 refuse, reading 150", [0, 150, 8403, 120], 150],
  ])(
    "PG-2659 a GLM start takes pswpin's median rise over 3 seconds: %s",
    async (_, swapins, median) => {
      const r = await spawn(
        glm,
        [],
        linux({ swapins }, [], [["stat"], ["vmstat"], ["vmstat"], ["vmstat"], ["vmstat"]]),
      )
      expect(r.code === 0, r.err).toBe(median < 100)
      expect(capacityLog(r).at(-1).readings.swapins).toBe(median)
    },
  )

  test("a GLM start reads its load and pressure from /proc", async () => {
    const load = await spawn(glm, [], linux({ load5: 30 }))
    expect(load.code).not.toBe(0)
    expect(load.err).toContain("load5 is 30.00 (/proc/loadavg), and a GLM session starts under")
    const pressure = await spawn(glm, [], linux({ some: 10 }))
    expect(pressure.code).not.toBe(0)
    expect(pressure.err).toContain(
      "pressure level is 2 (/proc/pressure/memory), and a GLM session starts at 1 alone",
    )
  })

  test.each([
    [55, true],
    [30, false],
  ])(
    "a manager over the load line reads the CPU at %d% idle from two /proc/stat reads",
    async (idle, passes) => {
      const r = await spawn(
        ["manager", "optimizer", "b.md"],
        [],
        linux({ cores: 20, idle, load5: 21 }, [], [["stat"]]),
      )
      expect(r.code === 0, r.err).toBe(passes)
      if (!passes)
        expect(r.err).toContain(
          "the CPU reads 30% idle (/proc/stat), under the 40% a manager needs to pass it",
        )
    },
  )
})

describe("on Linux a reading /proc does not give holds the start, never reading as 0", () => {
  test.each([
    [
      "pressure/memory",
      "it cannot read the pressure level (sysctl kern.memorystatus_vm_pressure_level), nor Linux's /proc/pressure/memory",
    ],
    [
      "meminfo",
      "it cannot read the free share (sysctl kern.memorystatus_level), nor Linux's /proc/meminfo",
    ],
    ["vmstat", "it cannot read the swap-ins (vm_stat -c 4 1), nor Linux's /proc/vmstat"],
  ])("with no /proc/%s", async (file, line) => {
    const r = await spawn(worker, [], linux({}, [file]))
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(`the memory gate holds it: ${line}`)
  })

  test("with no /proc/loadavg and no uptime", async () => {
    const r = await spawn(worker, [], { ...linux({}, ["loadavg"]), FAKE_UPTIME_BROKEN: "1" })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the load gate holds it: it cannot read the load average (sysctl vm.loadavg or uptime), nor Linux's /proc/loadavg",
    )
  })

  test("a manager over the load line, with /proc/stat still between the reads", async () => {
    const r = await spawn(["manager", "optimizer", "b.md"], [], linux({ cores: 20, load5: 21 }))
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the CPU's idle share, which passes a manager at 40% or more, does not read (top -l 2 -n 0), nor Linux's /proc/stat",
    )
  })
})

// The Planner's ruling d-2021p: PLAYGROUND_PROC is read under the test sandbox's marker alone, so a session that sets it cannot feed the gates a low load.
test("a start with PLAYGROUND_PROC set outside the test runner never reads its text", async () => {
  const r = await spawn(worker, [], {
    ...linux({ free: 3, load1: 7.25, load5: 7.75 }),
    TEST_SANDBOX_HOME: "",
  })
  expect(r.err).not.toContain("free is 3% (/proc/meminfo)")
  expect(capacityLog(r).at(-1).readings.load5).not.toBe(7.75)
})
