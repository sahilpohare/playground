import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { WAITING, deadline, machine, stop, within } from "./run-slot-fake"

// the frozen pick: a waiter behind the head reads the look signature in the branch that watches the next line, so a freeing - a holder's end, a SIG change - with next unchanged makes the pick look and start within a poll, and a bump with next unchanged makes it look without starting (a look is not a start). The wall is a rank-1 ticket of a live process that never looks, so nothing rewrites next and the pick stays behind it.
setDefaultTimeout(60_000)

// three holds put five held units up: c=8 with the reserve 2 means the big wall needs h<=3 and the medium pick h<=4, so nothing fits until the freeing drops the held to 4, which fits the pick alone - the wall reads closed before and after, so next's content never changes
const stalled = (m: ReturnType<typeof machine>) => {
  m.hold("run-slot", 3, "big")
  m.hold("run-slot-2", 1, "small")
  m.hold("run-slot-3", 1, "small")
  m.ticket(1, "worker-wall", "0 23 3 big", 120)
}

// the pick's look mark, the one file its looks touch and truncate, whose mtime moves once a look
const lookMark = (m: ReturnType<typeof machine>) => {
  const f = readdirSync(m.ops).find((n) => n.startsWith(".run-slot-ref-"))
  return f ? join(m.ops, f) : ""
}

describe("a stable pick behind a wall", () => {
  test("a freeing with next unchanged makes the pick look and start within a poll", async () => {
    const m = machine()
    stalled(m)
    const w = m.start("worker-pick", { RUN_SLOT_SIZE: "medium" })
    expect(await w.saw(WAITING)).toBe(true)
    const ref = lookMark(m)
    expect(ref).not.toBe("")
    const t0 = statSync(ref).mtimeMs
    // the freeing: the gate's slot ends, a holder's end, a SIG change the else branch never read before the fix
    m.release("run-slot-3")
    const chain = deadline()
    await within(
      () => statSync(ref).mtimeMs !== t0,
      "the pick to look once the freeing landed",
      m,
      chain,
    )
    await within(() => existsSync(w.marker), "the pick to start once it looked", m, chain)
    await w.p.exited
    expect(existsSync(w.marker)).toBe(true)
  })

  test("with no freeing and no bump the pick sleeps through its polls", async () => {
    const m = machine()
    stalled(m)
    const w = m.start("worker-pick", { RUN_SLOT_SIZE: "medium" })
    expect(await w.saw(WAITING)).toBe(true)
    await Bun.sleep(1_500)
    expect(existsSync(w.marker)).toBe(false)
    await stop(w.p)
  })

  test("a look signature bump makes the pick look, and not start", async () => {
    const m = machine()
    stalled(m)
    const w = m.start("worker-pick", { RUN_SLOT_SIZE: "medium" })
    expect(await w.saw(WAITING)).toBe(true)
    const ref = lookMark(m)
    expect(ref).not.toBe("")
    const t0 = statSync(ref).mtimeMs
    // the bump: a no-op switch, Ops' 17:04:36Z idle-min write; the pick's look mark stayed frozen through it live
    writeFileSync(
      join(m.ops, "run-slot.noop"),
      "ops 2026-11-11T12:00:00Z 2026-11-12T12:00:00Z the bump\n",
    )
    await within(() => statSync(ref).mtimeMs !== t0, "the pick to look once the bump landed", m)
    await Bun.sleep(1_500)
    expect(existsSync(w.marker)).toBe(false)
    await stop(w.p)
  })
})
