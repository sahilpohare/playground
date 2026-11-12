import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { COMMANDS, WAITING, machine, shim, stop, subshells, waiter } from "./run-slot-fake"

// each look of the two waits out its own quiet (asleep, its last start the sleep, no look over a whole poll), so the row has about 8 times its quiet time
setDefaultTimeout(300_000)

// issue 1654: one look's process starts climbed with queue depth, 21 a ticket over a base of about 516 (measured at canary 628d629: 516 at depth 0, 936 at depth 20), because ordered_waiters paid a printf|cut and a stat per ticket and first_waiter paid a cat per ticket it walked, so a full folder made every look about twice the process starts of an empty one; this row bounds one head waiter's look beside 20 ranked tickets within a small margin of one beside none. The look's segment is counted from its trace, the external commands it runs and the subshells it enters, from look_mark to the sleep that ends it, since a time window would count the polls that land in it, which varies with the box's load
type Machine = ReturnType<typeof machine>
const EXECS = new Set(COMMANDS)
// `line` is the tickets' holder line: a medium beside 6 held units does not fit, so those rows walk the whole order, while the small rows name a pick at their first ticket
const look = async (depth: number, line = "s2 21 1 small") => {
  const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
  m.hold("run-slot", 3, "big")
  m.hold("run-slot-2", 3, "big")
  const { path } = shim(m)
  const base = Date.now() * 1e6
  const w = waiter(m, path, "worker-a", ["touch"], { RUN_SLOT_POLL: "2" })
  while (!new RegExp(WAITING.source, "m").test(w.err)) await Bun.sleep(50)
  for (let i = 0; i < depth; i++) m.ticket(base + 1e12 + i * 1e6, `worker-${i}`, line)
  for (;;) {
    const at = w.err.length
    await Bun.sleep(3_000)
    if (
      !/^\++\d+ look_mark$/m.test(w.err.slice(at)) &&
      /^\+0 sleep \S+$/.test(w.err.slice(at).split("\n").filter(Boolean).at(-1) ?? "")
    )
      break
  }
  const from = w.err.length
  // a holder line that changes, so the head's next poll looks once
  writeFileSync(
    join(m.ops, "run-slot-2.holder"),
    `worker-held ${process.pid} 2026-10-18T19:00:01Z 3 big\n`,
  )
  while (!/^\++\d+ look_mark$/m.test(w.err.slice(from))) await Bun.sleep(20)
  const mark = w.err.indexOf("look_mark", from)
  while (!/^\+0 sleep \S+$/m.test(w.err.slice(mark))) await Bun.sleep(20)
  const end = w.err.indexOf("\n", w.err.slice(mark).search(/^\+0 sleep \S+$/m) + mark)
  const trace = w.err.slice(mark, end)
  let execs = 0
  for (const l of trace.split("\n")) {
    const matched = l.match(/^\++\d+ (.*)$/)
    if (!matched) continue
    const command = matched[1].split(" ")[0].replaceAll("'", "")
    if (EXECS.has(command)) execs++
  }
  const total = execs + subshells(trace)
  await stop(w.p)
  expect(existsSync(w.marker)).toBe(false)
  return total
}

describe("one look's process starts stay flat with queue depth", () => {
  test("a head waiter's look beside 20 tickets costs within 60 starts of one beside none", async () => {
    const shallow = await look(0)
    const deep = await look(20)
    expect(deep - shallow).toBeLessThan(60)
  })

  // round 1 of the review: the walk paid a prio_holder and a lane_units a ticket it walked, which only a queue whose tickets do not fit shows, so this row walks 20 medium ones
  test("a head waiter's look beside 20 medium tickets costs within 60 starts of one beside none", async () => {
    const shallow = await look(0, "s2 22 2 medium")
    const deep = await look(20, "s2 22 2 medium")
    expect(deep - shallow).toBeLessThan(60)
  })
})
