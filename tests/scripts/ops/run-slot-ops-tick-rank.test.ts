import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { WAITING, machine } from "./run-slot-fake"

setDefaultTimeout(60_000)

// #2479, 16 Nov: the 21:30Z nightly clean's first run-slot call, a git fetch as ops-tick, waited behind every worker's run past its 10-minute timeout, so the night never ran
describe("ops-tick's upkeep", () => {
  test("takes the freed slot before older worker waiters, as the class-0 names do", async () => {
    const m = machine({ idle: 30 })
    m.hold("run-slot", 1, "small")
    const waiters = []
    for (const who of ["worker-a", "worker-b", "ops-tick"]) {
      const w = m.start(who, { RUN_SLOT_SIZE: "small" })
      expect(await w.saw(WAITING)).toBe(true)
      waiters.push(w)
    }
    m.release("run-slot")
    for (const w of waiters) expect(await w.ran()).toBe(true)
    const starts = readFileSync(join(m.ops, "run-slot.runs.log"), "utf8")
      .split("\n")
      .filter((l) => l.split(" ")[1] === "start")
      .map((l) => l.split(" ")[2])
    expect(starts).toEqual(["ops-tick", "worker-a", "worker-b"])
  })
})
