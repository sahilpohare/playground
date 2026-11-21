import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const SWEEP = join(import.meta.dir, "../../../../../extensions/core/skills/playbook/SWEEP.md")
const section = async (heading: string) =>
  (await Bun.file(SWEEP).text()).split(`## ${heading}`)[1]?.split("\n## ")[0] ?? ""

// issue 2030: a worker's merge-tree check reads the queue, so the Builder keeps it and the sweep says when it is missing or stale
describe("SWEEP.md keeps the merge queue", () => {
  test("step 1 names the sweep's missing and stale queue lines", async () => {
    const step = await section("1. Read what changed")
    expect(step).toContain("`merge queue missing`")
    expect(step).toContain("`merge queue stale`")
  })

  test("the Builder's step names the queue's upkeep, its order and its moments", async () => {
    const step = await section("4. Run the recovery scan and chase stalled PRs (the Builder)")
    const line = step.split("\n").find((l) => l.includes("keeps `merge-queue.json`")) ?? ""
    expect(line).toContain("on every PR open, merge and reorder")
    expect(line).toContain("in merge order")
    expect(line).toContain("the owner's items first")
  })
})
