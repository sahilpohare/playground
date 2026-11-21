import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, renameSync } from "node:fs"
import { join } from "node:path"

import { SCRIPT, machine, set, stop, within } from "./run-slot-fake"

// the verdicts answer for the hold the wait loop obeys: focus_holds gates the wait loop first (run-slot.sh's hold check), and can-take and room answer for it too, so a hold reads closed to every check while it keeps a fitting head waiter from taking
setDefaultTimeout(60_000)

// what `run-slot.sh room` prints: "<lanes> <held> <free> <waiters>"
const room = (m: ReturnType<typeof machine>) =>
  Bun.spawnSync(["bash", SCRIPT, "room"], { cwd: m.root, env: m.env() }).stdout.toString().trim()

describe("a hold the wait loop obeys", () => {
  test("can-take and room answer closed beside the hold the wait loop obeys", async () => {
    const m = machine()
    await set(m, "worker-f", "focus", "--for", "30m", "--reason", "demo")
    const w = m.start("worker-h", {})
    // the hold names itself on the waiter's stderr
    expect(await w.saw(/waiting for worker-f's focus to end/)).toBe(true)
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
    await set(m, "worker-f", "focus", "--for", "30m", "--reason", "demo")
    const w = m.start("worker-h", {})
    expect(await w.saw(/waiting for worker-f's focus to end/)).toBe(true)
    renameSync(join(m.ops, "run-slot.focus"), join(m.ops, "run-slot.focus.lifted-20261105T0700Z"))
    await within(() => existsSync(w.marker), "the run to start once the focus hold lifted", m)
    await w.p.exited
    expect(existsSync(w.marker)).toBe(true)
  })
})
