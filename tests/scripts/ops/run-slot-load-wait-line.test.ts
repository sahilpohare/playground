import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { WAITING, machine, stop, waiter } from "./run-slot-fake"

// the units line's branch runs may_reserve and held_for with fewer arguments than the walk's calls pass them, so the row holds them to reading unset tails as empty under set -u (issue 1654 round 1: the out-parameters' bare tails died here). The waiter is a medium whose ticket reads small, so the look fits the ticket and the take checks the waiter's own two units against the held three and fails, both reads settled
setDefaultTimeout(180_000)

describe("the units hold's line", () => {
  test("a medium waiter whose take fails the units prints waiting for them, naming the held share", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 3, "big")
    const w = waiter(m, m.env().PATH, "worker-m", ["touch"], {
      RUN_SLOT_SIZE: "medium",
      RUN_SLOT_POLL: "1",
    })
    const q = join(m.ops, "run-slot.waiters")
    let ticket = ""
    while (!ticket) {
      ticket = existsSync(q) ? (readdirSync(q).find((f) => f.endsWith("-worker-m")) ?? "") : ""
      if (!ticket) await Bun.sleep(20)
    }
    writeFileSync(join(q, ticket), "s2 21 1 small\n")
    const at = Date.now()
    while (
      !/waiting for 2 free load units \(medium; 3 of 4 held\)/.test(w.err) &&
      Date.now() - at < 30_000
    )
      await Bun.sleep(50)
    expect(w.err).toMatch(/waiting for 2 free load units \(medium; 3 of 4 held\)/)
    expect(existsSync(w.marker)).toBe(false)
    await stop(w.p)
  })
})
