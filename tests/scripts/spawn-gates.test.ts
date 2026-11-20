import { describe, expect, setDefaultTimeout, test } from "bun:test"

import { capacityLog, minutesAgo, others, placing, root, spawn, workers } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

const ID = "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27"

describe("the capacity gate refuses and spawns nothing", () => {
  // With gates.sessionCap unset, no count of live sessions or workers holds a spawn; the load, memory, slots and usage gates guard the Mac.
  test.each([30, 50])("%d live sessions, workers among them, hold nothing", async (n) => {
    const r = await spawn(
      ["column", "tester", "tester-x", "worker-x", "w1:p2", "b.md", "--pr", "1"],
      [...others(n - 8), ...workers(8)],
    )
    expect(r.code).toBe(0)
    expect(capacityLog(r)).toEqual([expect.objectContaining({ verdict: "pass" })])
  })

  test("load5 at the cores' count, however many sessions are live", async () => {
    const r = await spawn(["runner", "runner-x", "b.md"], [...others(42), ...workers(8)], {
      FAKE_LOAD5: "15.00",
    })
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      "the load gate holds it: max(load1, load5) is 15.00 and 0 started in the last 5 minutes",
    )
    expect(r.err).toContain("the 15 cores")
    expect(capacityLog(r)).toEqual([expect.objectContaining({ gate: "load", verdict: "refused" })])
  })

  test("a load multiplier raises the cap", async () => {
    const r = await spawn(["runner", "runner-x", "b.md", "--size", "small"], [], {
      FAKE_LOAD5: "16.50",
      PLAYGROUND_LOAD_MULT: "1.2",
    })
    expect(r.code).toBe(0)
    expect(placing(r)).not.toEqual([])
  })

  test("a set load multiplier names itself when the raised cap still holds", async () => {
    const r = await spawn(["runner", "runner-x", "b.md", "--size", "small"], [], {
      FAKE_LOAD5: "18.00",
      PLAYGROUND_LOAD_MULT: "1.2",
    })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the load gate holds it: max(load1, load5) is 18.00 and 0 started in the last 5 minutes",
    )
    expect(r.err).toContain("at or over 18, the 15 cores at PLAYGROUND_LOAD_MULT 1.2")
  })

  test("a load multiplier that is not a number above 0 refuses", async () => {
    for (const mult of ["0", "1.2x", "inf"]) {
      const r = await spawn(["runner", "runner-x", "b.md"], [], { PLAYGROUND_LOAD_MULT: mult })
      expect(r.code).not.toBe(0)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain(`PLAYGROUND_LOAD_MULT is ${mult}`)
    }
  })

  test("load1 above load5 is the reading that counts", async () => {
    const r = await spawn(["runner", "runner-x", "b.md"], [], {
      FAKE_LOAD1: "20.00",
      FAKE_LOAD5: "2.00",
    })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("max(load1, load5) is 20.00")
  })

  test("starts of the last 5 minutes count toward the cores, and older ones do not", async () => {
    const fresh = [...Array(14)]
      .map(() => JSON.stringify({ at: minutesAgo(1), gate: null, readings: {}, verdict: "pass" }))
      .join("\n")
    const lagged = await spawn(["worker", "worker-brave-otter", "b.md", "--size", "small"], [], {
      CAPACITY_JSONL: `${fresh}\n`,
    })
    expect(lagged.code).not.toBe(0)
    expect(lagged.err).toContain(
      "and 14 started in the last 5 minutes, at or over 13.125: the 15 cores",
    )
    const old = [...Array(14)]
      .map((_, k) =>
        JSON.stringify({ at: minutesAgo(6 + k), gate: null, readings: {}, verdict: "pass" }),
      )
      .join("\n")
    const settled = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      CAPACITY_JSONL: `${old}\n`,
    })
    expect(settled.code).toBe(0)
  })

  test("a malformed line in the log costs itself alone, the starts count reads on", async () => {
    const fresh = [...Array(14)]
      .map(() => JSON.stringify({ at: minutesAgo(1), gate: null, readings: {}, verdict: "pass" }))
      .join("\n")
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--size", "small"], [], {
      CAPACITY_JSONL: `${fresh}\nnot json\n`,
    })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain("and 14 started in the last 5 minutes, at or over 13.125: the 15 cores")
  })

  test("memory pressure away from normal", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], { FAKE_PRESSURE: "4" })
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      "the memory gate holds it: pressure level is 4 (sysctl kern.memorystatus_vm_pressure_level), 1 or 2 passes",
    )
  })

  test("memory pressure level 2 with room passes", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      FAKE_FREE: "50",
      FAKE_PRESSURE: "2",
    })
    expect(r.code).toBe(0)
  })

  test("memory pressure level 2 at 12% free, this Mac's usual reading, passes (#1249)", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      FAKE_FREE: "12",
      FAKE_PRESSURE: "2",
    })
    expect(r.code).toBe(0)
  })

  test("memory pressure level 2 at the 8% floor passes", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      FAKE_FREE: "8",
      FAKE_PRESSURE: "2",
    })
    expect(r.code).toBe(0)
  })

  test("memory pressure level 2 under the free floor", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      FAKE_FREE: "7",
      FAKE_PRESSURE: "2",
    })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the memory gate holds it: free is 7% (sysctl kern.memorystatus_level), 8% is the floor",
    )
  })

  test("a pressure level it cannot read", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], { FAKE_PRESSURE: "x" })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the memory gate holds it: it cannot read the pressure level (sysctl kern.memorystatus_vm_pressure_level)",
    )
  })

  test("a free share it cannot read", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], { FAKE_FREE: "x" })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the memory gate holds it: it cannot read the free share (sysctl kern.memorystatus_level)",
    )
  })

  test("free memory under 8%", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], { FAKE_FREE: "5" })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the memory gate holds it: free is 5% (sysctl kern.memorystatus_level), 8% is the floor",
    )
  })

  test("with no arguments it prints the whole header, the worker line and the pin note included", async () => {
    const r = await spawn([], [])
    expect(r.code).toBe(2)
    expect(r.err).toContain("spawn.sh worker")
    expect(r.err).toContain("backends/<name>")
  })
})

// #1430: free memory counts compressible pages, so it read 62% on 7 Nov while 150 pages swapped in a second; a fresh worker start also waits on the swap-ins, and every other start keeps its pass, as at the slots gate.
describe("the memory gate holds a fresh worker start while the machine pages", () => {
  const PAGING = { FAKE_FREE: "62", FAKE_PRESSURE: "1", FAKE_SWAPINS: "150" }

  test("7 Nov's readings refuse a fresh worker start on the swap-ins, naming them and the free share", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], PAGING)
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
    expect(r.err).toContain(
      "the memory gate holds it: swap-ins are 150/s (vm_stat), 100/s is the line, while free reads 62% (sysctl kern.memorystatus_level), which counts compressible pages",
    )
    expect(capacityLog(r)).toEqual([
      expect.objectContaining({ gate: "memory", verdict: "refused" }),
    ])
  })

  test("swap-ins it cannot read refuse a fresh worker start", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], { FAKE_VMSTAT_BROKEN: "1" })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(
      "the memory gate holds it: it cannot read the swap-ins (vm_stat -c 4 1)",
    )
  })

  test.each([
    [
      "a reviewer",
      ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "r.md", "--pr", "1"],
      undefined,
    ],
    [
      "a tester",
      ["column", "tester", "tester-x", "worker-x", "w1:p2", "t.md", "--pr", "1"],
      undefined,
    ],
    ["a runner", ["runner", "runner-calm-heron", "b.md"], undefined],
    ["a manager", ["manager", "optimizer", "b.md"], undefined],
    ["a resume", ["resume", "worker-brave-otter", root, ID], "worker-brave-otter"],
  ])("%s start keeps its pass while the machine pages", async (_, args, pinned) => {
    const r = await spawn(
      args,
      [],
      PAGING,
      undefined,
      pinned ? { backend: "claude", name: pinned } : undefined,
    )
    expect(r.code, r.err).toBe(0)
  })

  test("a fresh worker start passes once the swap-ins are under their line", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
      ...PAGING,
      FAKE_SWAPINS: "99",
    })
    expect(r.code, r.err).toBe(0)
  })
})
