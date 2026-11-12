import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { machine, shim, starts, waiter } from "./run-slot-fake"

// clone waiters take no look, and this row took 29 s beside the other poll-cost files at load5 15 to 34 (issue 1671, measured), so it has about 4 times its time
setDefaultTimeout(120_000)

// issue 1338, 7 Nov: sixteen waiters started about 60 processes a second between them, which held load5 between 30 and 42 on 15 cores with the CPU half idle, so the slots they waited for stayed shut
describe("waiters cost close to nothing while they wait", () => {
  test("ten clone waiters behind the load brake start fewer than 5 processes a second together", async () => {
    const m = machine({ cores: 8, load1: 2, load5: 20 })
    mkdirSync(join(m.root, "node_modules"))
    const { count, path } = shim(m)
    const waiters = Array.from({ length: 10 }, (_, i) =>
      waiter(m, path, `worker-${i}`, ["cp", "-R", "node_modules"], { RUN_SLOT_POLL: "5" }),
    )
    expect(await starts(count, waiters, /^run-slot\.sh: this clone waits /m, 10)).toBeLessThan(5)
  })
})
