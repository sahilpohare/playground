import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { SCRIPT, machine, stop, within } from "./run-slot-fake"

// the verdicts answer for the holds the wait loop obeys: battery_holds and focus_holds gate the wait loop first (run-slot.sh's hold check), and can-take and room answer for them too, so a hold reads closed to every check while it keeps a fitting head waiter from taking
setDefaultTimeout(60_000)

// the battery switch, held for the row: its line's third field is its expiry, far out, since run-slot reads it against the real clock
const battery = (m: ReturnType<typeof machine>) =>
  writeFileSync(
    join(m.ops, "run-slot.battery"),
    "ops 2026-11-11T12:00:00Z 2099-01-01T00:00:00Z held for the row\n",
  )

// what `run-slot.sh room` prints: "<lanes> <held> <free> <waiters>"
const room = (m: ReturnType<typeof machine>) =>
  Bun.spawnSync(["bash", SCRIPT, "room"], { cwd: m.root, env: m.env() }).stdout.toString().trim()

describe("a hold the wait loop obeys", () => {
  test("can-take and room answer closed beside the hold the wait loop obeys", async () => {
    const m = machine()
    battery(m)
    const w = m.start("worker-h", {})
    // the hold names itself on the waiter's stderr
    expect(await w.saw(/waiting for the Mac's charge to rise/)).toBe(true)
    const ticket = m.tickets().find((t) => t.endsWith("-worker-h"))
    expect(ticket).toBeDefined()
    // the verdicts answer for the hold: the lane reads closed to both, as it reads to the wait loop
    expect(await m.canTake("run-slot", ticket!)).toBe(false)
    expect(room(m)).toBe("4 0 0 1")
    // no start across three polls while the hold stands
    await Bun.sleep(700)
    expect(existsSync(w.marker)).toBe(false)
    await stop(w.p)
  })

  test("once the hold lifts, the start lands within one poll", async () => {
    const m = machine()
    battery(m)
    const w = m.start("worker-h", {})
    expect(await w.saw(/waiting for the Mac's charge to rise/)).toBe(true)
    rmSync(join(m.ops, "run-slot.battery"))
    await within(() => existsSync(w.marker), "the run to start once the battery hold lifted", m)
    await w.p.exited
    expect(existsSync(w.marker)).toBe(true)
  })
})
