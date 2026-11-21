import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { appendFileSync, existsSync } from "node:fs"
import { join } from "node:path"

import { NOW, WAITING, iso, machine, ran } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang: 60s, twice the slowest case under SLOW_CHILD=1.5 but local CI's, which sets its own
setDefaultTimeout(60_000)

// 7 Nov 13:10 to 13:15Z: a released backlog started 12 runs on run-slot and run-slot-2, small ones included, and load5 crossed the 15 cap at 13:16:08Z, since neither reading shows a start until about a minute after it; a small run whose waiter has waited past the backlog line also waits for the burst to clear, while a fresh small run in a queue with no backlog starts at once and the dashboard's and the merge train's runs keep their exemption
describe("a small run in a draining backlog", () => {
  const backlog = { RUN_SLOT_SIZE: "small", RUN_SLOT_BACKLOG_WAIT: "1", RUN_SLOT_POLL: "0.2" }

  test("a waited small run holds while a freed slot's minute is hot, then starts once it clears", async () => {
    const m = machine({ load1: 2, now: NOW, off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 3, "big")
    m.hold("run-slot-2", 3, "big")
    const run = m.start("worker-s", backlog)
    // saw, not waits: waits stops the run, and this one must go on to start once the minute clears
    expect(await run.saw(WAITING)).toBe(true)
    await Bun.sleep(1000)
    appendFileSync(
      join(m.ops, "run-slot.runs.log"),
      `${iso(1)} start worker-r 102 run-slot-3 waited=0s\n`,
    )
    m.release("run-slot-2")
    await Bun.sleep(3000)
    const startedHot = existsSync(run.marker)
    appendFileSync(join(m.ops, "run-slot.runs.log"), `${iso(0)} end worker-r 102 rc=0 ran=1s\n`)
    expect(await run.ran()).toBe(true)
    expect(startedHot).toBe(false)
  })

  test("with no backlog a small run starts at once", async () => {
    const m = machine({ load1: 2, now: NOW })
    expect(await m.runs("worker-s", backlog)).toBe(true)
  })

  test("the dashboard's and the merge train's runs still start in a backlog", async () => {
    const m = machine({ load1: 2, now: NOW })
    ran(m.ops, 101, "run-slot", 10)
    expect(await m.runs("ops-dashboard", { RUN_SLOT_BACKLOG_WAIT: "1" })).toBe(true)
    expect(await m.runs("ops-merge-train", { RUN_SLOT_SIZE: "medium" })).toBe(true)
  })

  for (const [label, ns, want] of [
    ["an old small ticket", 1, false],
    ["a fresh small ticket", Date.now() * 1_000_000, true],
  ] as const)
    test(`can-take inside a burst answers ${want} for ${label}`, async () => {
      const m = machine({ load1: 2, now: NOW })
      ran(m.ops, 101, "run-slot", 10)
      m.ticket(ns, "worker-s", "s2 22 1 small")
      expect(await m.canTake("run-slot-2", `${ns}-${process.pid}-worker-s`)).toBe(want)
    })
})
