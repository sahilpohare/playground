import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"

import { WAITING, machine, shim, starts, stop, waiter, within } from "./run-slot-fake"

// five waiters' first looks under xtrace and the shims, about 700 process starts each at a queue of 10 (issue 1612, measured), open the window, and this row took 52.8 s in CI and 55.5 to 61.8 s at load5 9.7 to 13.8 here (issue 1671, measured), so it has about 3 times its time
setDefaultTimeout(180_000)

// every waiter's first WAITING line, bounded so a hang names the wait rather than surfacing as the row's timeout; the first looks get 150 s of the row's 180 s
const waiting = (m: ReturnType<typeof machine>, waiters: { err: string }[]) => {
  const waits = new RegExp(WAITING.source, "m")
  return within(
    () => waiters.every((w) => waits.test(w.err)),
    "each waiter's first WAITING line",
    m,
    {
      end: Date.now() + 150_000,
    },
  )
}

// issue 1338, 7 Nov: sixteen waiters started about 60 processes a second between them, which held load5 between 30 and 42 on 15 cores with the CPU half idle, so the slots they waited for stayed shut
describe("waiters cost close to nothing while they wait", () => {
  // five waiters and a poll of 5 s keep the first looks and the quiet rounds short, since ten waiters at a 15 s poll took 135 s in CI against a file's 60 s (issue 1671, measured); the bound is per waiter and poll, the old 5 a second for ten at a 15 s poll
  test("five queue waiters behind held slots start fewer than 7.5 processes a poll each", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 3, "big")
    m.hold("run-slot-2", 3, "big")
    const { count, path } = shim(m)
    const waiters = Array.from({ length: 5 }, (_, i) =>
      waiter(m, path, `worker-${i}`, ["touch"], { RUN_SLOT_POLL: "5" }),
    )
    await waiting(m, waiters)
    const rate = await starts(count, waiters, new RegExp(WAITING.source, "m"), 10)
    expect((rate * 5) / waiters.length).toBeLessThan(7.5)
  })

  // the wake fix reads the look signature behind the head (issue 1818), so one change - here one new ask - costs every waiter behind the head one look, not one a poll: the herd is one look a change, and the steady polls between changes stay sleep-only
  test("one new ask wakes each of five waiters behind held slots once, not once a poll", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 3, "big")
    m.hold("run-slot-2", 3, "big")
    const { path } = shim(m)
    const waiters = Array.from({ length: 5 }, (_, i) =>
      waiter(m, path, `worker-${i}`, ["touch"], { RUN_SLOT_POLL: "5" }),
    )
    await waiting(m, waiters)
    const looks = (w: (typeof waiters)[number]) =>
      (w.err.match(/^\++\d+ look_mark$/gm) ?? []).length
    // the quiet rounds pass first, so the window's looks are the ask's alone: a whole poll with no new look
    await Bun.sleep(11_000)
    const before = waiters.map((w) => looks(w))
    // the ask: a later ticket of a live process, one that never fits, so no verdict or next line moves
    m.ticket(6, "worker-late", "0 23 3 big", 0)
    // each waiter's one look lands within a poll, whenever the box gets to it, and one more poll adds no second look
    await within(
      () => waiters.every((w, i) => looks(w) - before[i]! >= 1),
      "each waiter to look once the ask landed",
      m,
    )
    await Bun.sleep(6_000)
    const woke = waiters.map((w, i) => looks(w) - before[i]!)
    expect(woke.every((n) => n === 1)).toBe(true)
    expect(waiters.every((w) => !existsSync(w.marker))).toBe(true)
    await Promise.all(waiters.map((w) => stop(w.p)))
  })
})
