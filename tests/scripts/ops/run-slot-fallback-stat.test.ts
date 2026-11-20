import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { WAITING, machine } from "./run-slot-fake"

setDefaultTimeout(60_000)

// ordered_waiters pairs each ticket with its mtime from one stat over the whole queue, and re-stats a ticket that line misses alone; a stat stub that drops the older waiter's line from the whole-queue call stands in for a ticket arriving between the two reads (#2508)
describe("the waiter walk's fallback re-stat", () => {
  test("reads the mtime alone, so the walk finishes in order with no error", async () => {
    const m = machine({ idle: 30 })
    const stubs = join(m.root, "stat-stub")
    mkdirSync(stubs)
    writeFileSync(
      join(stubs, "stat"),
      `#!/bin/bash\nif [ $# -gt 3 ]; then ${Bun.which("stat")} "$@" | grep -v -- '-worker-o$'; else exec ${Bun.which("stat")} "$@"; fi\n`,
    )
    chmodSync(join(stubs, "stat"), 0o755)
    const path = `${stubs}:${m.env().PATH}`
    m.hold("run-slot", 1, "small")
    const older = m.start("worker-o", { PATH: path, RUN_SLOT_SIZE: "small" })
    expect(await older.saw(WAITING)).toBe(true)
    const later = m.start("worker-p", { PATH: path, RUN_SLOT_SIZE: "small" })
    expect(await later.saw(WAITING)).toBe(true)
    m.release("run-slot")
    expect(await older.ran()).toBe(true)
    expect(await later.ran()).toBe(true)
    const starts = readFileSync(join(m.ops, "run-slot.runs.log"), "utf8")
      .split("\n")
      .filter((l) => l.split(" ")[1] === "start")
      .map((l) => l.split(" ")[2])
    expect(starts).toEqual(["worker-o", "worker-p"])
    for (const w of [older, later]) expect(w.stderr()).not.toContain("unbound variable")
  })
})
