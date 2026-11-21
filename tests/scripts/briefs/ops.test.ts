import { expect, test } from "bun:test"
import { join } from "node:path"

// an extension's job raises the signal, and Ops turns it into the stop and the all-clear
test("the Ops brief raises the stop and the all-clear from the extension's signal", async () => {
  const text = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/ops.md")).text()
  const line = text.split("\n").find((l) => l.startsWith("**stop**:")) ?? ""
  expect(line).toContain("the extension's signal")
  expect(line).toContain("raise the stop")
  expect(line).toContain("raise the all-clear")
})

// for an urgent ticket the owner wants everything else stopped, so the stop gives the ticket's session focus and preempts the runs already in a slot
test("the Ops brief's stop gives the ticket's session focus, preempts, and ends focus at the all-clear", async () => {
  const text = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/ops.md")).text()
  const line = text.split("\n").find((l) => l.startsWith("**stop**:")) ?? ""
  expect(line).toContain("playground focus on --session")
  expect(line).toContain("run-slot.sh preempt")
  expect(line).toContain("playground focus off")
})

// issue 2030: an org's ops job is set through its settings key, and an accepted extension item renders on ops-up's next pass
test("a brief for an org's ops job names its settings key and holds a render before the accept", async () => {
  const text = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/ops.md")).text()
  expect(text).toContain("`jobs.<name>.config`")
  expect(text).toContain("`jobs.json` is rendered output")
  expect(text).toContain("renders on `up.py`'s next pass")
  expect(text).toContain("must hold before the accept, or live in the job itself")
})
