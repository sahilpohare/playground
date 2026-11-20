import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { SCRIPT, WAITING, machine, runSlot, shim, starts, waiter } from "./run-slot-fake"

// the reads row's shape (run-slot-poll-cost-reads.test.ts), which took 42.7 s in CI and up to 57.2 s at load5 13.8 here, so it has about 3 times its time
setDefaultTimeout(180_000)

// round 1 of the review: windows_sig runs in every waiter's idle poll (cheap_sig) and window_holder in every pick, so a standing window keeps the reads row's bound; measured 1.752 a poll at 0269bd8
describe("waiters cost close to nothing while a priority window stands", () => {
  test("five queue waiters across 25 polls, one of them a window's session, start fewer than 2 processes a poll each", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    const data = m.env().PLAYGROUND_DATA_DIR
    mkdirSync(data, { recursive: true })
    writeFileSync(
      join(data, "priority-worker-0.json"),
      `${JSON.stringify({ by: "dispatcher", reason: "the owner's ask", session: "worker-0", since: "2026-11-16T20:00:00.000Z" }, null, 2)}\n`,
    )
    m.hold("run-slot", 3, "big")
    m.hold("run-slot-2", 3, "big")
    const { count, path } = shim(m)
    const waiters = Array.from({ length: 5 }, (_, i) =>
      waiter(m, path, `worker-${i}`, ["touch"], { RUN_SLOT_POLL: "1" }),
    )
    const slots = async () => {
      await Bun.sleep(5_000)
      await runSlot(["bash", SCRIPT, "slots"], {
        cwd: m.root,
        env: m.env(),
        stdout: "ignore",
        stderr: "ignore",
        ops: m.ops,
      }).exited
    }
    const rate = await starts(count, waiters, new RegExp(WAITING.source, "m"), 25, slots)
    expect(rate / waiters.length).toBeLessThan(2)
  })
})
