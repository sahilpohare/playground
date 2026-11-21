import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { NOW, SCRIPT, WAITING, machine, ran, stop } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang: 60s, twice the slowest case under SLOW_CHILD=1.5 but local CI's, which sets its own
setDefaultTimeout(60_000)

// #610: load1 shows a run's load about a minute after it starts, so a drained queue once started five suites in 70 s at load1 16, and load1 reached 64; while the runs started in the last minute outnumber those that ended in it, the next medium or big run waits, at any load.
describe("a burst of starts", () => {
  const medium = { RUN_SLOT_SIZE: "medium" }

  test("a medium run waits while a run started under a minute ago, with load1 under every line", async () => {
    const m = machine({ load1: 2, now: NOW })
    ran(m.ops, 101, "run-slot", 10)
    expect(await m.waits("worker-m", medium)).toBe(true)
  })

  test("and starts once that run started a minute ago", async () => {
    const m = machine({ load1: 2, now: NOW })
    ran(m.ops, 101, "run-slot", 61)
    expect(await m.runs("worker-m", medium)).toBe(true)
  })

  test("a clone started under a minute ago holds it too", async () => {
    const m = machine({ load1: 2, now: NOW })
    ran(m.ops, 101, "run-slot-clone", 10)
    expect(await m.waits("worker-m", medium)).toBe(true)
  })

  test("a run that took the slot a run freed in the last minute adds nothing, so the next goes on", async () => {
    const m = machine({ load1: 2, now: NOW })
    ran(m.ops, 101, "run-slot", 300, 15)
    ran(m.ops, 102, "run-slot", 10)
    expect(await m.runs("worker-m", medium)).toBe(true)
  })

  test("a run that started and ended inside the minute frees nothing that was held before it", async () => {
    const m = machine({ load1: 2, now: NOW })
    ran(m.ops, 101, "run-slot", 40, 20)
    ran(m.ops, 102, "run-slot-2", 10)
    expect(await m.waits("worker-m", medium)).toBe(true)
  })

  test("with several waiters queued, the first starts and the rest wait for the reading", async () => {
    const m = machine({ load1: 2, now: NOW })
    writeFileSync(join(m.bin, "long"), '#!/bin/bash\ntouch "$1"\nsleep 30\n')
    chmodSync(join(m.bin, "long"), 0o755)
    const first = m.start("worker-a", medium, SCRIPT, ["long"])
    while (!existsSync(first.marker)) await Bun.sleep(20)
    try {
      expect(await Promise.all([m.waits("worker-b", medium), m.waits("worker-c", medium)])).toEqual(
        [true, true],
      )
    } finally {
      await stop(first.p)
    }
  })

  test("a single waiter on an idle machine starts at once", async () => {
    const m = machine({ load1: 2, now: NOW })
    const run = m.start("worker-m", medium)
    const waited = await run.saw(WAITING)
    if (waited) await stop(run.p)
    expect(waited).toBe(false)
    expect(await run.ran()).toBe(true)
  })

  test("a fresh small run and the merge train's go on beside a fresh start", async () => {
    const m = machine({ load1: 2, now: NOW })
    ran(m.ops, 101, "run-slot", 5)
    expect(await m.runs("worker-s", { RUN_SLOT_SIZE: "small" })).toBe(true)
    expect(await m.runs("ops-merge-train", medium)).toBe(true)
  })

  test("can-take answers no while a run started under a minute ago, and yes once it started a minute ago", async () => {
    const fresh = machine({ load1: 2, now: NOW })
    ran(fresh.ops, 101, "run-slot", 5)
    expect(await fresh.canTake("run-slot-2", "worker-m", medium)).toBe(false)
    const old = machine({ load1: 2, now: NOW })
    ran(old.ops, 101, "run-slot", 61)
    expect(await old.canTake("run-slot-2", "worker-m", medium)).toBe(true)
  })
})
