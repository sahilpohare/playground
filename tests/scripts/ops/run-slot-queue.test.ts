import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { WAITING, machine, stop } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang: 60s, twice the slowest case under SLOW_CHILD=1.5 but local CI's, which sets its own
setDefaultTimeout(60_000)

describe("the queue's order", () => {
  test("a small waiter goes before an older medium one", async () => {
    const m = machine()
    m.ticket(1, "worker-small", "s2 21 1 small")
    expect(await m.waits("worker-m", { RUN_SLOT_SIZE: "medium" })).toBe(true)
  })

  test("a medium waiter goes before an older big one", async () => {
    const m = machine()
    m.ticket(1, "worker-big", "s2 23 3 big")
    expect(await m.runs("worker-m", { RUN_SLOT_SIZE: "medium" })).toBe(true)
  })

  test("a run that gates a merge goes before an older small worker's", async () => {
    const m = machine()
    m.ticket(1, "worker-x", "s2 21 1 small")
    expect(await m.runs("ops-checks-9", { RUN_SLOT_SIZE: "big" })).toBe(true)
  })

  test("an older copy's plain ticket keeps its place by age", async () => {
    const m = machine()
    m.ticket(1, "worker-old", "s2")
    expect(await m.waits("worker-s", { RUN_SLOT_SIZE: "small" })).toBe(true)
  })

  // review round 1: local CI writes a plain "s2" ticket and takes a slot only while its ticket is the oldest live one
  test("local CI's plain ticket stays behind an older big waiter and ahead of a newer medium", async () => {
    const m = machine({ off: ["run-slot.3-off", "run-slot.4-off"] })
    m.hold("run-slot", 1, "small")
    const big = m.start("worker-b", { RUN_SLOT_SIZE: "big" })
    while (!m.tickets().some((t) => t.endsWith("-worker-b"))) await Bun.sleep(50)
    m.ticket(Date.now() * 1e6, "ops-localci", "s2")
    await Bun.sleep(50)
    const medium = m.start("worker-m", { RUN_SLOT_SIZE: "medium" })
    expect(await medium.saw(WAITING)).toBe(true)
    m.release("run-slot")
    expect(await big.ran()).toBe(true)
    // waits() puts its first dead ticket after big's run ended, so the look before the one that clears the fifth began and decided after it
    expect(await medium.waits()).toBe(true)
    // SLOW_CHILD=5, the load that turned it red on CI, takes it about 82s
  }, 180_000)

  // A run for a GitHub org ext.links guards goes first; a checker reads its worker's PR, and the CPU 30% idle leaves run-slot the one slot
  const order = async (priority?: string, pr = "https://github.com/acme-co/web/pull/1") => {
    const m = machine({
      idle: 30,
      roster: {
        agents: [
          { name: "worker-lw", pr },
          { name: "reviewer-lw", worker: "worker-lw" },
        ],
      },
    })
    if (priority) writeFileSync(join(m.ops, "run-slot.priority"), `${priority}\n`)
    m.hold("run-slot", 1, "small")
    const own = m.start("worker-made", { RUN_SLOT_SIZE: "small" })
    expect(await own.saw(WAITING)).toBe(true)
    const org = m.start("reviewer-lw", { RUN_SLOT_SIZE: "small" })
    expect(await org.saw(WAITING)).toBe(true)
    m.release("run-slot")
    expect(await org.ran()).toBe(true)
    expect(await own.ran()).toBe(true)
    return readFileSync(join(m.ops, "run-slot.runs.log"), "utf8")
      .split("\n")
      .filter((l) => l.split(" ")[1] === "start")
      .map((l) => l.split(" ")[2])
  }

  test("an org's waiter takes the freed slot before an older one of the factory's", async () => {
    expect(await order()).toEqual(["reviewer-lw", "worker-made"])
  })

  test("a waiter on an org ext.links does not guard keeps its place", async () => {
    expect(await order(undefined, "https://github.com/other-co/web/pull/1")).toEqual([
      "worker-made",
      "reviewer-lw",
    ])
  })

  test("and before an older Checks run in the ready line, by its repo", async () => {
    const m = machine({
      mergeQueue: { queue: [{ pr: 7, readyAt: "2026-10-19T00:00:00Z" }] },
      roster: { agents: [{ name: "worker-lw", repo: "acme-co/web" }] },
    })
    m.ticket(1, "ops-checks-7", "s2 02 2 medium")
    expect(await m.runs("worker-lw", { RUN_SLOT_SIZE: "medium" })).toBe(true)
  })

  test("and may use the reserve, so a gating medium does not pass it", async () => {
    const m = machine({
      off: ["run-slot.3-off", "run-slot.4-off"],
      roster: { agents: [{ name: "worker-lw", repo: "acme-co/web" }] },
    })
    m.hold("run-slot", 2, "medium")
    m.ticket(1, "ops-checks-9", "s2 02 2 medium")
    expect(await m.runs("worker-lw", { RUN_SLOT_SIZE: "medium" })).toBe(true)
  })

  test("but not before the run-slot.priority pick", async () => {
    expect(await order("worker-made")).toEqual(["worker-made", "reviewer-lw"])
  })

  // 4 Nov: a commit's build queued as commit-<worktree> waited 2 h while the priority named the session committing in that worktree
  const commitOrder = async (from: string) => {
    const m = machine({ idle: 30 })
    writeFileSync(join(m.ops, "run-slot.priority"), "worker-p\n")
    const tree = join(m.root, ".claude", "worktrees", from)
    mkdirSync(tree, { recursive: true })
    expect(await m.start("worker-p", {}, undefined, ["touch"], tree).ran()).toBe(true)
    m.hold("run-slot", 1, "small")
    const other = m.start("worker-o", { RUN_SLOT_SIZE: "small" })
    expect(await other.saw(WAITING)).toBe(true)
    const commit = m.start("commit-wt-p", { RUN_SLOT_SIZE: "small" })
    expect(await commit.saw(WAITING)).toBe(true)
    m.release("run-slot")
    expect(await other.ran()).toBe(true)
    expect(await commit.ran()).toBe(true)
    return readFileSync(join(m.ops, "run-slot.runs.log"), "utf8")
      .split("\n")
      .filter((l) => l.split(" ")[1] === "start")
      .map((l) => l.split(" ")[2])
      .slice(1)
  }

  test("and the pick's commit step, from a worktree the picked session last ran from, takes the slot before an older waiter", async () => {
    expect(await commitOrder("wt-p")).toEqual(["commit-wt-p", "worker-o"])
  })

  test("while a commit step from a worktree the pick never ran from keeps its place", async () => {
    expect(await commitOrder("wt-q")).toEqual(["worker-o", "commit-wt-p"])
  })

  // 4 Nov: with the pick on one session, its merge asked later took a slot before its older one
  test("the pick's own runs go oldest first, so a newer one waits while its older ticket waits", async () => {
    const m = machine()
    writeFileSync(join(m.ops, "run-slot.priority"), "worker-p\n")
    m.ticket(1, "worker-p", "s2 22 2 medium")
    const newer = m.start("worker-p", { RUN_SLOT_SIZE: "small" })
    expect(await newer.saw(WAITING)).toBe(true)
    await stop(newer.p)
    expect(existsSync(newer.marker)).toBe(false)
  })
})
