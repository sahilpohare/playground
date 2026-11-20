import { describe, expect, setDefaultTimeout, test } from "bun:test"

import { WAITING, machine, stop } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang: 60s, twice the slowest case under SLOW_CHILD=1.5 but local CI's, which sets its own
setDefaultTimeout(60_000)

// Slots 3 and 4 closed, as tonight's hold has them: 2 slots give 4 units, 1 of them kept for small runs and the runs that gate a merge.
describe("load units", () => {
  const held = () => machine({ off: ["run-slot.3-off", "run-slot.4-off"] })

  test("a small run starts while a big one holds the rest", async () => {
    const m = held()
    m.hold("run-slot", 3, "big")
    expect(await m.runs("worker-s", { RUN_SLOT_SIZE: "small" })).toBe(true)
  })

  test("a medium build waits while a big one holds the rest", async () => {
    const m = held()
    m.hold("run-slot", 3, "big")
    expect(await m.waits("worker-m", { RUN_SLOT_SIZE: "medium" })).toBe(true)
  })

  test("a second medium build leaves the small reserve free", async () => {
    const m = held()
    m.hold("run-slot", 2, "medium")
    expect(await m.waits("worker-m", { RUN_SLOT_SIZE: "medium" })).toBe(true)
  })

  test("a medium run that gates a merge may use the reserve", async () => {
    const m = held()
    m.hold("run-slot", 2, "medium")
    expect(await m.runs("ops-checks-9", { RUN_SLOT_SIZE: "medium" })).toBe(true)
  })

  test("so may one under ops-checks-<n>", async () => {
    const m = held()
    m.hold("run-slot", 2, "medium")
    expect(await m.runs("ops-checks-9", { RUN_SLOT_SIZE: "medium" })).toBe(true)
  })

  // 02:49Z on 22 Oct: a pre-commit build on a ticket's branch, sized big from that item, waited 815s while 4 units were held, so a big run did not fit
  test("a pre-commit build takes a free slot beside 4 held units and a medium waiter", async () => {
    const m = machine({ plan: { lanes: [{ items: [{ id: "PG-9", size: "big" }] }] } })
    Bun.spawnSync(["git", "init", "-q", "-b", "pg-9-x"], { cwd: m.root })
    m.hold("run-slot-2", 2, "medium")
    m.hold("run-slot-3", 2, "medium")
    m.ticket(1, "worker-m", "s2 22 2 medium")
    const commit = m.start("commit-pg-9-x")
    const waited = await commit.saw(WAITING)
    if (waited) await stop(commit.p)
    expect(waited).toBe(false)
    expect(await commit.ran()).toBe(true)
  })

  test("a big run starts on a quiet machine", async () => {
    const m = machine({ load1: 20 })
    expect(await m.runs("worker-b", { RUN_SLOT_SIZE: "big" })).toBe(true)
  })
})
