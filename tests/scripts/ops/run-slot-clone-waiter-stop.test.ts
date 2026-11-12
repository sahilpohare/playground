import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { SCRIPT, deadline, machine, startOf, stop, within } from "./run-slot-fake"

// a check waits on a line its run prints or logs, so the timeout only catches a hang
setDefaultTimeout(60_000)

type Machine = ReturnType<typeof machine>
const DROP = { RUN_SLOT_TEST_LOOP_END: "1" }
const STOPPED = /wait loop ended with no slot taken .*, so \S+ stops with 143: run it again/gm
const cloning = (m: Machine, who: string, extra: Record<string, string> = {}) => {
  mkdirSync(join(m.root, "node_modules"), { recursive: true })
  return m.start(who, extra, SCRIPT, ["cp", "-R", "node_modules"])
}
const places = (m: Machine) => {
  const dir = join(m.ops, "run-slot.clone-waiters")
  return existsSync(dir) ? readdirSync(dir) : []
}
const runsLog = (m: Machine) => {
  const path = join(m.ops, "run-slot.runs.log")
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}
const starts = (m: Machine) =>
  runsLog(m)
    .split("\n")
    .map(startOf)
    .filter((f): f is string[] => f !== null)

// issue 1641: a waiter whose wait loop bash drops (a TERM mid-expansion on bash 5.2, the rule at the load5 wait) stopped with 143 and no word of why; RUN_SLOT_TEST_LOOP_END drops the lane's wait loop once, as bash does
describe("a waiter whose wait loop bash drops", () => {
  test("a clone says why and exits 143 without running, and gives back its place", async () => {
    const m = machine()
    m.hold("run-slot-clone", 1, "small")
    const run = cloning(m, "worker-dropped", DROP)
    expect(await run.saw(STOPPED)).toBe(true)
    expect(await run.p.exited).toBe(143)
    expect(existsSync(run.marker)).toBe(false)
    expect(places(m)).toEqual([])
  })

  // a reviewer: commit and quick waiters run the same lane loop as a clone
  test("a commit-lane run says why and exits 143 without running", async () => {
    const m = machine()
    const run = m.start("worker-push", DROP, SCRIPT, ["git", "push"])
    expect(await run.saw(STOPPED)).toBe(true)
    expect(await run.p.exited).toBe(143)
    expect(existsSync(run.marker)).toBe(false)
  })

  test("a newer clone is held by no place the stopped one left, and takes the lane once it frees", async () => {
    const m = machine()
    m.hold("run-slot-clone", 1, "small")
    const older = cloning(m, "worker-dropped", DROP)
    expect(await older.saw(STOPPED)).toBe(true)
    expect(await older.p.exited).toBe(143)
    const newer = cloning(m, "worker-newer")
    const chain = deadline()
    await within(
      () => places(m).some((n) => n.endsWith("-worker-newer")),
      "the newer clone's place",
      m,
      chain,
    )
    m.release("run-slot-clone")
    await within(
      () => starts(m).some((f) => f[2] === "run-slot-clone"),
      "a clone's start",
      m,
      chain,
    )
    await stop(newer.p)
    expect(starts(m).map((f) => f[0])).toEqual(["worker-newer"])
  })
})
