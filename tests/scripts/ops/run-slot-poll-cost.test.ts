import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { machine, shim, stop, waiter, lookedSince, type Waiter } from "./run-slot-fake"

// the slowest row here, the head's, took 72 s beside the rate files at load5 15 to 34 (issue 1671, measured), so each row has about 5 times its time
setDefaultTimeout(360_000)

// round 1 of the review of issue 1338's fix: a head whose idle poll watched the files and the load alone missed the CPU opening slots 2 to 4, and waited 20 polls
describe("a waiter at the head reads the gate that held its last look", () => {
  test("so a run held by shut lanes takes run-slot-2 within a poll of the CPU opening them", async () => {
    const m = machine({ idle: 10 })
    m.hold("run-slot", 3, "big")
    const { path } = shim(m)
    const w = waiter(m, path, "worker-a", ["touch"], { RUN_SLOT_POLL: "1" })
    while (!/^\+\d+ look_mark$/m.test(w.err) || !/^\+0 sleep 1$/m.test(w.err)) await Bun.sleep(50)
    const top = join(m.root, "bin", "top")
    writeFileSync(top, readFileSync(top, "utf8").replace(/ 10% idle/, " 80% idle"))
    rmSync(join(m.ops, "run-slot.gauges"), { force: true })
    const from = w.err.length
    while (!existsSync(w.marker)) await Bun.sleep(50)
    // the gauges keep a reading 10 s, which this test's removal of run-slot.gauges skips, so a poll or two passes between the CPU opening and the take
    expect(w.err.slice(from).match(/^\+0 sleep 1$/gm)?.length ?? 0).toBeLessThanOrEqual(2)
    await stop(w.p)
  })
})

// round 2 of the review: an oldest waiter under the priority pick wrote no run-slot.next, so a waiter behind it that a freed slot let start never looked
describe("a waiter behind the head", () => {
  test("starts within a poll or two of a freed slot when the oldest is the priority pick and still does not fit", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 3, "big")
    m.hold("run-slot-2", 3, "big")
    writeFileSync(join(m.ops, "run-slot.priority"), "worker-p\n")
    const path = m.env().PATH
    const asleep = (w: Waiter) => /^\+0 sleep 1$/m.test(w.err)
    const pick = waiter(m, path, "worker-p", ["touch"], {
      RUN_SLOT_POLL: "1",
      RUN_SLOT_SIZE: "big",
    })
    while (!asleep(pick)) await Bun.sleep(50)
    const next = waiter(m, path, "worker-y", ["touch"], {
      RUN_SLOT_POLL: "1",
      RUN_SLOT_SIZE: "small",
    })
    while (!asleep(next)) await Bun.sleep(50)
    const nextf = join(m.ops, "run-slot.next")
    const named = () => (existsSync(nextf) ? readFileSync(nextf, "utf8") : "")
    const was = named()
    const seen = pick.err.length
    const freed = next.err.length
    m.release("run-slot-2")
    const sleeps = (from: number) => next.err.slice(from).match(/^\+0 sleep 1$/gm)?.length ?? 0
    // the pick's look writes run-slot.next partway through, which a loaded Mac can take seconds to reach, so worker-y's polls count from the first sign it could act, that write or the look's end, read before its take, and from the release when its take or 10 sleeps come first (issue 1612: that look took 5.4 to 5.8 s at load5 22, and a count from the release read 4 polls against 3, measured)
    let signed = false
    while (
      !(signed = named() !== was || lookedSince(pick, seen)) &&
      !existsSync(next.marker) &&
      sleeps(freed) < 10
    )
      await Bun.sleep(50)
    const from = signed ? next.err.length : freed
    while (!existsSync(next.marker) && sleeps(from) < 10) await Bun.sleep(50)
    expect(sleeps(from)).toBeLessThanOrEqual(3)
    expect(existsSync(pick.marker)).toBe(false)
    await Promise.all([stop(pick.p), stop(next.p)])
  })

  // round 3 of the review: run-slot.next named first_waiter's pair alone, which held while the pick's first ticket took run-slot and went, so the pick's second, behind an older waiter that every look named, never looked and run-slot sat free
  test("the priority pick's second run takes run-slot within a poll or two of its first run's end", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 1, "small")
    m.hold("run-slot-2", 2, "medium")
    writeFileSync(join(m.ops, "run-slot.priority"), "worker-p\n")
    const path = m.env().PATH
    const poll = { RUN_SLOT_POLL: "1", RUN_SLOT_SIZE: "small" }
    const asleep = (w: Waiter) => /^\+0 sleep 1$/m.test(w.err)
    // the older waiter fits the units throughout, so first_waiter names it at every look, and it leaves run-slot to the pick
    const older = waiter(m, path, "worker-w", ["touch"], poll)
    while (!asleep(older)) await Bun.sleep(50)
    const gate = join(m.root, "gate")
    // both runs are worker-p's and share one marker, so the first touches none and the marker says the second ran (issue 1612: the first's touch passed the row before its count began)
    const first = waiter(
      m,
      path,
      "worker-p",
      ["bash", "-c", `until [ -e "${gate}" ]; do sleep 0.1; done`],
      poll,
    )
    while (!asleep(first)) await Bun.sleep(50)
    const second = waiter(m, path, "worker-p", ["touch"], poll)
    while (!asleep(second)) await Bun.sleep(50)
    m.release("run-slot")
    while (!/^run-slot\.sh: worker-p holds run-slot$/m.test(first.err)) await Bun.sleep(50)
    // the older waiter looks at the first run's take before its end
    const seen = older.err.length
    while (!lookedSince(older, seen)) await Bun.sleep(50)
    const from = second.err.length
    writeFileSync(gate, "")
    await first.p.exited
    const sleeps = () => second.err.slice(from).match(/^\+0 sleep 1$/gm)?.length ?? 0
    while (!existsSync(second.marker) && sleeps() < 10) await Bun.sleep(50)
    expect(sleeps()).toBeLessThanOrEqual(3)
    expect(existsSync(older.marker)).toBe(false)
    await Promise.all([stop(older.p), stop(second.p)])
  })

  // a waiter killed past its trap leaves its ticket, the oldest, at the queue's front; the waiters behind it watch that ticket's pid
  test("starts within a poll or two of a freed slot when the oldest waiter was killed and left its ticket", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 3, "big")
    m.hold("run-slot-2", 3, "big")
    const path = m.env().PATH
    const asleep = (w: Waiter) => /^\+0 sleep 1$/m.test(w.err)
    const oldest = waiter(m, path, "worker-x", ["touch"], {
      RUN_SLOT_POLL: "1",
      RUN_SLOT_SIZE: "big",
    })
    while (!asleep(oldest)) await Bun.sleep(50)
    const next = waiter(m, path, "worker-y", ["touch"], {
      RUN_SLOT_POLL: "1",
      RUN_SLOT_SIZE: "small",
    })
    while (!asleep(next)) await Bun.sleep(50)
    const left = m.tickets().find((t) => t.endsWith("-worker-x"))
    expect(left).toBeDefined()
    // the test started this waiter, so it ends it by its own pid, with no trap run
    oldest.p.kill("SIGKILL")
    await oldest.p.exited
    expect(m.tickets()).toContain(left!)
    const from = next.err.length
    m.release("run-slot-2")
    const sleeps = () => next.err.slice(from).match(/^\+0 sleep 1$/gm)?.length ?? 0
    while (!existsSync(next.marker) && sleeps() < 10) await Bun.sleep(50)
    expect(sleeps()).toBeLessThanOrEqual(3)
    expect(m.tickets()).not.toContain(left!)
    await stop(next.p)
  })
})

// #1378: a waiter's waited count is the real seconds since its wait began, so the five-minute marks land on real minutes whatever RUN_SLOT_POLL is; a poll that added 15 of its own ran the marks early on a slow poll and late on a fast one
describe("a waiter's waited count is the real seconds since its wait began", () => {
  const script = readFileSync(join(import.meta.dir, "../../../scripts/ops/run-slot.sh"), "utf8")

  test("no poll adds a figure of its own", () => {
    expect(script.match(/waited=\$\(\(waited \+/g) ?? []).toEqual([])
  })

  test("each wait records its start, and four loops and hold_wait read the clock against it", () => {
    expect(script.match(/WAIT_FROM=\$SECONDS/g) ?? []).toHaveLength(4)
    expect(script.match(/waited=\$\(\(SECONDS - WAIT_FROM\)\)/g) ?? []).toHaveLength(5)
  })

  // a sampled clock count steps over an exact multiple, so each wait line prints by a threshold it raises past the mark, not by the modulo
  test("each wait line prints by a threshold, and no modulo or first-line flag holds the five-minute marks", () => {
    expect(script.match(/-ge "\$(FAT|QAT|UAT|BAT|SAT|MAT|DAT|CAT)"/g) ?? []).toHaveLength(8)
    expect(script.match(/AT=\$\(\(\(waited \/ 300 \+ 1\) \* 300\)\)/g) ?? []).toHaveLength(8)
    expect(script.match(/% 300/g) ?? []).toEqual([])
    expect(script.match(/(?:F|M|D|C|Q)SAID=/g) ?? []).toEqual([])
  })
})
