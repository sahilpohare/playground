import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { SCRIPT, WAITING, machine, runSlot, shim, starts, stop, waiter } from "./run-slot-fake"

// a check waits on its run's exit, so the timeout only catches a hang, and the drift row runs a cost window like the reads family's
setDefaultTimeout(180_000)

// issue 1477, 7 Nov: a ticket sat 30 minutes while every fresh head read named it, because the oldest's look had named a bigger ticket under its own frozen lanes verdict and never looked again; capacity counts the slots the lanes open, and a waiter behind the head wakes on run-slot.next alone, so these rows hold the oldest to naming, within a poll, whoever a fresh read names
type Machine = ReturnType<typeof machine>

// the held slots and the two paper tickets behind the live oldest waiter, ns names after its spawn's so the oldest writes run-slot.next: a reviewer's medium, which fits the lanes open alone (4 held of 8, class 4 ahead of the plain), and a plain small, which fits both verdicts (4 held of 6 shut)
const setup = (idle: number) => {
  const m = machine({ idle, load1: 2, load5: 2 })
  m.hold("run-slot-3", 2, "medium")
  m.hold("run-slot-4", 2, "medium")
  const now = Date.now()
  const ns2 = now * 1e6 + 60e9
  const ns3 = now * 1e6 + 120e9
  m.ticket(ns2, "rt2-reviewer", "s2 22 2 medium")
  m.ticket(ns3, "worker-t3", "s2 21 1 small")
  const t2 = `${ns2}-${process.pid}-rt2-reviewer`
  const t3 = `${ns3}-${process.pid}-worker-t3`
  const named = () =>
    existsSync(join(m.ops, "run-slot.next"))
      ? readFileSync(join(m.ops, "run-slot.next"), "utf8")
      : ""
  return { m, t2, t3, named }
}
// the fake top reading `idle` next, and the gauges cache staled, so the next gauges read lands on it
const flip = (m: Machine, idle: number) => {
  writeFileSync(
    join(m.bin, "top"),
    `#!/bin/bash\necho "$*" >> ${join(m.root, "top.log")}\necho "CPU usage: 1.00% user, 1.00% sys, 98.00% idle "\necho "CPU usage: ${((100 - idle) / 2).toFixed(2)}% user, ${((100 - idle) / 2).toFixed(2)}% sys, ${idle}% idle "\n`,
  )
  writeFileSync(join(m.ops, "run-slot.gauges"), "0 80 0 120 3.50\n")
}
// a fresh read, whose own lanes reading reads the gauges as they are now
const head = async (m: Machine) => {
  const p = runSlot(["bash", SCRIPT, "head"], {
    cwd: m.root,
    env: m.env(),
    stdout: "pipe",
    ops: m.ops,
  })
  return (await new Response(p.stdout).text()).trim()
}
// whether run-slot.next names `ticket` within a deadline, so a loaded pass waits for the gauges' next reading instead of racing one check; the base never names it, so the red run takes the deadline whole
const namesWithin = async (named: () => string, ticket: string, seconds: number) => {
  const at = Date.now()
  while (!named().startsWith(ticket) && Date.now() - at < seconds * 1000) await Bun.sleep(50)
  return named().startsWith(ticket)
}

describe("the oldest names the queue's fresh pick through a lanes flip", () => {
  test("one the gauges shut within a poll of its open-lanes look, as a fresh head read names it", async () => {
    const { m, t2, t3, named } = setup(80)
    const w = m.start("worker-w", { RUN_SLOT_POLL: "0.2", RUN_SLOT_SIZE: "big" })
    // the open-lanes look names the reviewer's medium, the first in the order that fits 4 held of 8
    while (!named().startsWith(t2)) await Bun.sleep(20)
    flip(m, 30)
    // the oldest follows the fresh pick within a poll, and a fresh read then names the small ticket the frozen verdict never named again
    expect(await namesWithin(named, t3, 20)).toBe(true)
    expect(await head(m)).toBe(t3)
    expect(existsSync(join(m.ops, "run-slot.holder"))).toBe(false)
    await stop(w.p)
  })

  // the direction the head already watched, so the flip in both directions keeps its naming
  test("and one the gauges open within a poll of its shut-lanes look, as a fresh head read names it", async () => {
    const { m, t2, t3, named } = setup(30)
    const w = m.start("worker-w", { RUN_SLOT_POLL: "0.2", RUN_SLOT_SIZE: "big" })
    // the shut-lanes look names the small ticket, the first in the order that fits 4 held of 6
    while (!named().startsWith(t3)) await Bun.sleep(20)
    flip(m, 80)
    expect(await namesWithin(named, t2, 20)).toBe(true)
    expect(await head(m)).toBe(t2)
    expect(existsSync(join(m.ops, "run-slot.holder"))).toBe(false)
    await stop(w.p)
  })
})

// canary's reads row under readings that drift, as a real top's do: the idle share moves between 78 and 84 with the lanes open, and an outside reading lands at 3 s, so a watch that re-read the gauges on every moved line would cost like the unconditional read it replaced; the head re-baselines its compare after a same-verdict read instead
describe("the head's watch under drifting readings", () => {
  test("five queue waiters across 25 polls start fewer than 2 processes a poll each while the idle share drifts", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 3, "big")
    m.hold("run-slot-2", 3, "big")
    writeFileSync(
      join(m.bin, "top"),
      `#!/bin/bash\necho "$*" >> ${join(m.root, "top.log")}\ni=$((78 + RANDOM % 7))\necho "CPU usage: 1.00% user, 1.00% sys, 98.00% idle "\necho "CPU usage: 5.00% user, 5.00% sys, $i.00% idle "\n`,
    )
    chmodSync(join(m.bin, "top"), 0o755)
    const { count, path } = shim(m)
    const waiters = Array.from({ length: 5 }, (_, i) =>
      waiter(m, path, `worker-${i}`, ["touch"], { RUN_SLOT_POLL: "1" }),
    )
    const outside = async () => {
      await Bun.sleep(3_000)
      writeFileSync(join(m.ops, "run-slot.gauges"), "0 81 0 120 3.50\n")
      await runSlot(["bash", SCRIPT, "slots"], {
        cwd: m.root,
        env: m.env(),
        stdout: "ignore",
        stderr: "ignore",
        ops: m.ops,
      }).exited
    }
    const rate = await starts(count, waiters, new RegExp(WAITING.source, "m"), 25, outside)
    expect(rate / waiters.length).toBeLessThan(2)
  })
})
