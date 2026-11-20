import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { OLD } from "../session-names"
import { capacityLog, minutesAgo, placing, script, spawn } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

describe("the capacity gate refuses and spawns nothing", () => {
  // the owner's rule keeps the load under the cores, so an idle CPU no longer lets a start past a load at or over them.
  describe("the core count", () => {
    test("a load over the cores refuses while the CPU is mostly idle, and never reads the CPU", async () => {
      const r = await spawn(["runner", "runner-x", "b.md", "--size", "small"], [], {
        FAKE_CPU_IDLE: "55.00",
        FAKE_LOAD5: "24.00",
      })
      expect(r.code).not.toBe(0)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain(
        "max(load1, load5) is 24.00 and 0 started in the last 5 minutes, at or over the 15 cores. Wait for it to fall",
      )
      expect(existsSync(join(r.home, "top.calls"))).toBe(false)
    })

    test("a --priority start passes a load over the cores while priority.json stands, and the memory gate still holds it", async () => {
      const args = ["runner", "runner-x", "b.md", "--size", "small", "--priority"]
      const trigger = (home: string) =>
        writeFileSync(join(home, ".playground", "priority.json"), "{}")
      const r = await spawn(args, [], { FAKE_LOAD5: "24.00" }, script, undefined, trigger)
      expect(r.code).toBe(0)
      expect(capacityLog(r)).toEqual([
        expect.objectContaining({
          readings: expect.objectContaining({
            priority: expect.stringMatching(/\/\.playground\/priority\.json$/),
          }),
          verdict: "pass",
        }),
      ])
      const memory = await spawn(
        args,
        [],
        { FAKE_LOAD5: "24.00", FAKE_PRESSURE: "4" },
        script,
        undefined,
        trigger,
      )
      expect(memory.code).not.toBe(0)
      expect(memory.err).toContain("the memory gate holds it")
    })

    // --reads-only lifts the slots gate alone, so the load and memory gates refuse it as they refuse a plain worker start (#833)
    test.each([
      ["load", { FAKE_LOAD5: "24.00" }],
      ["memory", { FAKE_PRESSURE: "4" }],
      ["memory", { FAKE_SWAPINS: "150" }],
    ] as const)("the %s gate still holds a --reads-only worker start at %o", async (gate, env) => {
      const worker = ["worker", "worker-brave-otter", "b.md", "--size", "small"]
      for (const args of [worker, [...worker, "--reads-only"]]) {
        const r = await spawn(args, [], { ...env })
        expect(r.code).not.toBe(0)
        expect(placing(r)).toEqual([])
        expect(r.err).toContain(`the ${gate} gate holds it`)
      }
    })

    test.each(["priority.json", "priority-start.json"])(
      "a --priority start passes a load over the cores while %s stands (#1334)",
      async (file) => {
        const r = await spawn(
          ["runner", "runner-x", "b.md", "--size", "small", "--priority"],
          [],
          { FAKE_LOAD5: "24.00" },
          script,
          undefined,
          (home) => writeFileSync(join(home, ".playground", file), "{}"),
        )
        expect(r.code).toBe(0)
        expect(capacityLog(r)).toEqual([expect.objectContaining({ verdict: "pass" })])
      },
    )

    test("a start under the line never reads the CPU", async () => {
      const r = await spawn(["runner", "runner-x", "b.md", "--size", "small"], [])
      expect(r.code).toBe(0)
      expect(existsSync(join(r.home, "top.calls"))).toBe(false)
    })
  })

  // Load is weighed by size, so a big plan never blocks small runs: small, medium and big weigh 1, 2 and 3.
  describe("load units", () => {
    test("a medium start leaves a quarter of the cap for small items", async () => {
      const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], { FAKE_LOAD5: "12.00" })
      expect(r.code).not.toBe(0)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain(
        "at or over 11.25: the 15 cores, less the 3.75 kept for small items (this start is medium)",
      )
      expect(capacityLog(r)).toEqual([
        expect.objectContaining({
          gate: "load",
          readings: expect.objectContaining({ reserve: 3.75, size: "medium", units: 2 }),
        }),
      ])
    })

    test("a small start may use that reserve", async () => {
      const r = await spawn(["worker", "worker-brave-otter", "b.md", "--size", "small"], [], {
        FAKE_LOAD5: "12.00",
      })
      expect(r.code).toBe(0)
      expect(capacityLog(r)).toEqual([
        expect.objectContaining({
          readings: expect.objectContaining({ size: "small", units: 1 }),
          verdict: "pass",
        }),
      ])
    })

    // a PR's first review waited a median 47 minutes, so a checker takes the band a small worker keeps back, and every other small start keeps today's line
    test.each<{ args: string[]; passes: boolean }>([
      {
        args: ["column", "reviewer", "reviewer-x", "worker-x", "w1:p2", "r.md", "--pr", "1"],
        passes: true,
      },
      {
        args: ["column", "tester", "tester-x", "worker-x", "w1:p2", "r.md", "--pr", "1"],
        passes: true,
      },
      {
        args: ["column", "probe", "probe-x", "ops", "w1:p2", "p.md", "--size", "small"],
        passes: true,
      },
      {
        args: ["column", "lead", OLD.planner, OLD.dispatcher, "w1:p2", "h.md", "--size", "small"],
        passes: true,
      },
      { args: ["worker", "worker-brave-otter", "b.md", "--size", "small"], passes: false },
    ])("a checker takes the cap a small worker keeps back: $args.1", async ({ args, passes }) => {
      const r = await spawn(args, [], { FAKE_LOAD5: "14.00" })
      if (passes) return expect(r.code, r.err).toBe(0)
      expect(r.code).not.toBe(0)
      expect(r.err).toContain(
        "at or over 13.125: the 15 cores, less the 1.875 kept for checkers (gates.reviewReserve; this start is a small worker)",
      )
    })

    test("the roster's size counts when --size is not given", async () => {
      const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
        FAKE_LOAD5: "12.00",
        ROSTER_JSON: JSON.stringify({ agents: [{ name: "worker-brave-otter", size: "small" }] }),
      })
      expect(r.code).toBe(0)
    })

    // one test per start, so each start has the whole timeout to itself on a loaded runner
    test.each<{ passes: boolean; role: string; size: string; sizeArgs: string[]; units: number }>([
      { passes: true, role: "reviewer", size: "small", sizeArgs: [], units: 1 },
      { passes: true, role: "tester", size: "small", sizeArgs: [], units: 1 },
      { passes: false, role: "reviewer", size: "medium", sizeArgs: ["--size", "medium"], units: 2 },
      { passes: false, role: "tester", size: "medium", sizeArgs: ["--size", "medium"], units: 2 },
    ])(
      "a $role with no --size starts small, and --size still wins: $size",
      async ({ passes, role, size, sizeArgs, units }) => {
        const column = [
          "column",
          role,
          `${role}-x`,
          "worker-x",
          "w1:p2",
          "r.md",
          "--pr",
          "1",
          ...sizeArgs,
        ]
        const r = await spawn(column, [], { FAKE_LOAD5: "12.00" })
        if (passes) expect(r.code).toBe(0)
        else expect(r.code).not.toBe(0)
        expect(capacityLog(r)).toEqual([
          expect.objectContaining({ readings: expect.objectContaining({ size, units }) }),
        ])
      },
    )

    test("each start of the last 5 minutes weighs half its units", async () => {
      const starts = (units: number) =>
        [...Array(10)]
          .map(() =>
            JSON.stringify({ at: minutesAgo(1), gate: null, readings: { units }, verdict: "pass" }),
          )
          .join("\n")
      const light = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
        CAPACITY_JSONL: `${starts(1)}\n`,
      })
      expect(light.code).toBe(0)
      const heavy = await spawn(["worker", "worker-brave-otter", "b.md", "--size", "small"], [], {
        CAPACITY_JSONL: `${starts(3)}\n`,
      })
      expect(heavy.code).not.toBe(0)
      expect(heavy.err).toContain(
        "and 15 started in the last 5 minutes, at or over 13.125: the 15 cores",
      )
    })

    test("--size takes small, medium or big alone", async () => {
      const r = await spawn(["worker", "worker-brave-otter", "b.md", "--size", "huge"], [])
      expect(r.code).toBe(2)
      expect(r.err).toContain('--size takes small, medium or big, not "huge"')
    })
  })

  // a GLM session draws no Claude usage, so it starts while memory is normal, swap-ins are under 100/s and load5 is under 30.
  describe("a GLM session's own gate", () => {
    const glm = ["worker", "worker-brave-otter", "b.md", "--backend", "glm"]
    const claude = ["worker", "worker-brave-otter", "b.md"]

    test("a GLM start at load5 20 with normal memory passes, where a Claude start is refused", async () => {
      const allowed = await spawn(glm, [], { FAKE_LOAD5: "20.00" })
      expect(allowed.code).toBe(0)
      expect(placing(allowed)).not.toEqual([])
      const refused = await spawn(claude, [], { FAKE_LOAD5: "20.00" })
      expect(refused.code).not.toBe(0)
      expect(refused.err).toContain("the load gate holds it: max(load1, load5) is 20.00")
    })

    test("a GLM start at swap-ins 150/s is refused", async () => {
      const r = await spawn(glm, [], { FAKE_SWAPINS: "150" })
      expect(r.code).not.toBe(0)
      expect(placing(r)).toEqual([])
      expect(r.err).toContain(
        "the memory gate holds it: swap-ins are 150/s (vm_stat), and a GLM session starts under 100/s",
      )
    })

    test("a GLM start at load5 30 is refused", async () => {
      const r = await spawn(glm, [], { FAKE_LOAD5: "30.00" })
      expect(r.code).not.toBe(0)
      expect(r.err).toContain(
        "the load gate holds it: load5 is 30.00 (sysctl vm.loadavg), and a GLM session starts under 30",
      )
    })

    test("a GLM start at pressure level 2 is refused", async () => {
      const r = await spawn(glm, [], { FAKE_PRESSURE: "2" })
      expect(r.code).not.toBe(0)
      expect(r.err).toContain(
        "the memory gate holds it: pressure level is 2 (sysctl kern.memorystatus_vm_pressure_level), and a GLM session starts at 1 alone",
      )
    })

    test("a GLM start refuses when it cannot read the swap-ins", async () => {
      const r = await spawn(glm, [], { FAKE_VMSTAT_BROKEN: "1" })
      expect(r.code).not.toBe(0)
      expect(r.err).toContain(
        "the memory gate holds it: it cannot read the swap-ins (vm_stat -c 4 1)",
      )
    })
  })

  // The gate's lines are settings: a render set that moves one moves what spawn.sh holds a start to, with no edit to spawn.sh.
  describe("the gate's lines as settings", () => {
    const withGates = (values: Record<string, unknown>) => ({
      SETTINGS_JSON: JSON.stringify(values),
    })
    const glm = ["worker", "worker-brave-otter", "b.md", "--backend", "glm"]

    test("gates.glmLoad5Max and gates.glmSwapinsMax move a GLM session's lines", async () => {
      const env = withGates({ "gates.glmLoad5Max": 20, "gates.glmSwapinsMax": 200 })
      const load = await spawn(glm, [], { ...env, FAKE_LOAD5: "20.00" })
      expect(load.err).toContain(
        "the load gate holds it: load5 is 20.00 (sysctl vm.loadavg), and a GLM session starts under 20",
      )
      const swap = await spawn(glm, [], { ...env, FAKE_SWAPINS: "150" })
      expect(swap.code, swap.err).toBe(0)
    })

    test("gates.memoryFreeMin moves the free floor", async () => {
      const env = withGates({ "gates.memoryFreeMin": 10 })
      const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
        ...env,
        FAKE_FREE: "9",
      })
      expect(r.err).toContain(
        "the memory gate holds it: free is 9% (sysctl kern.memorystatus_level), 10% is the floor",
      )
    })

    test("gates.glmSwapinsMax moves a fresh Claude worker's swap-in line", async () => {
      const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
        ...withGates({ "gates.glmSwapinsMax": 200 }),
        FAKE_SWAPINS: "150",
      })
      expect(r.code, r.err).toBe(0)
    })

    test("gates.smallReserve moves the share kept for small items", async () => {
      const env = withGates({ "gates.smallReserve": 0.5 })
      const r = await spawn(["worker", "worker-brave-otter", "b.md"], [], {
        ...env,
        FAKE_LOAD5: "8.00",
      })
      expect(r.err).toContain(
        "at or over 7.5: the 15 cores, less the 7.5 kept for small items (this start is medium)",
      )
    })

    // ops, 31 Oct: another factory's starts on this Mac never reached this gate, and the two together took load1 to 77
    test("slots.peers counts another factory's starts from its own log beside this one's", async () => {
      const peer = mkdtempSync(join(tmpdir(), "peer-ops-"))
      const fresh = [...Array(14)]
        .map(() => JSON.stringify({ at: minutesAgo(1), gate: null, readings: {}, verdict: "pass" }))
        .join("\n")
      writeFileSync(join(peer, "capacity.jsonl"), `${fresh}\n`)
      const args = ["worker", "worker-brave-otter", "b.md", "--size", "small"]
      try {
        const alone = await spawn(args, [])
        expect(alone.code, alone.err).toBe(0)
        const r = await spawn(args, [], withGates({ "slots.peers": [peer] }))
        expect(r.err).toContain(
          "and 14 started in the last 5 minutes, at or over 13.125: the 15 cores",
        )
        expect(readFileSync(join(peer, "capacity.jsonl"), "utf8")).toBe(`${fresh}\n`)
      } finally {
        rmSync(peer, { force: true, recursive: true })
      }
    })

    test("gates.startsWindow moves how long a start counts", async () => {
      const env = withGates({ "gates.startsWindow": 600 })
      const older = [...Array(14)]
        .map(() => JSON.stringify({ at: minutesAgo(6), gate: null, readings: {}, verdict: "pass" }))
        .join("\n")
      const r = await spawn(["worker", "worker-brave-otter", "b.md", "--size", "small"], [], {
        ...env,
        CAPACITY_JSONL: `${older}\n`,
      })
      expect(r.err).toContain(
        "and 14 started in the last 10 minutes, at or over 13.125: the 15 cores",
      )
    })
  })
})
