import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { machine, stop, waiter } from "./run-slot-fake"

// the run-slot.priority pick's own medium keeps its reserve exemption: beside a held medium it runs, since its units must leave nothing free (the rank's class is 2 and the pick is its holder's); round 2 of the review held the walk's hoisted holder to reaching may_reserve only where the walk computed it, after every caller outside the walk passed an empty one and both the pick and a commit step with no owner record lost the read
setDefaultTimeout(180_000)

describe("the priority pick's reserve", () => {
  test("the pick's medium runs beside a held medium where a plain medium waits", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 2, "medium")
    writeFileSync(join(m.ops, "run-slot.priority"), "worker-p\n")
    const w = waiter(m, m.env().PATH, "worker-p", ["touch"], {
      RUN_SLOT_SIZE: "medium",
      RUN_SLOT_POLL: "1",
    })
    const at = Date.now()
    while (!existsSync(w.marker) && Date.now() - at < 30_000) await Bun.sleep(50)
    expect(existsSync(w.marker)).toBe(true)
    await stop(w.p)
  })
})
