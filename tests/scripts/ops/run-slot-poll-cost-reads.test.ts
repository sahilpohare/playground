import { describe, expect, setDefaultTimeout, test } from "bun:test"

import { SCRIPT, WAITING, machine, runSlot, shim, starts, waiter } from "./run-slot-fake"

// five waiters' first looks under xtrace and the shims, about 700 process starts each at a queue of 10 (issue 1612, measured), open the window, and this row took 42.7 s in CI and 53.9 to 57.2 s at load5 9.7 to 13.8 here (issue 1671, measured), so it has about 3 times its time
setDefaultTimeout(180_000)

// issue 1338, 7 Nov: sixteen waiters started about 60 processes a second between them, which held load5 between 30 and 42 on 15 cores with the CPU half idle, so the slots they waited for stayed shut
describe("waiters cost close to nothing while they wait", () => {
  // a count of polls to look again on (an older copy's 20) sets each waiter looking within the window, about 900 to 2,200 processes a look with ten tickets
  // round 4 of the review: every waiter's mark shared one path, which a read subcommand's exit removed, so each run's end set every waiter looking
  test("five queue waiters across 25 polls, with nothing changed but a read of the slots, start fewer than 2 processes a poll each", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 3, "big")
    m.hold("run-slot-2", 3, "big")
    const { count, path } = shim(m)
    const waiters = Array.from({ length: 5 }, (_, i) =>
      waiter(m, path, `worker-${i}`, ["touch"], { RUN_SLOT_POLL: "1" }),
    )
    // a read subcommand, run outside the shims, so only the waiters' own starts count
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
    // five waiters keep the first looks short, since ten took this row to 74 s in CI against a file's 60 s (issue 1671, measured); the bound is the old 20 a poll for ten, per waiter
    const rate = await starts(count, waiters, new RegExp(WAITING.source, "m"), 25, slots)
    expect(rate / waiters.length).toBeLessThan(2)
  })
})
