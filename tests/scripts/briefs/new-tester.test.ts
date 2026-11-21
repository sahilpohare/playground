import { expect, test } from "bun:test"
import { join } from "node:path"

test("the tester template moves the build output into the scratchpad before a cold build, which a commit's pre-commit build warms (#1762), and no-raw-delete refuses git clean -dX (#536)", async () => {
  const text = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/new-tester.md")).text()
  expect(text).toContain(
    "mv <worktree>/web/next/.next <worktree>/.turbo ~/.playground/scratch/<your name>/cold-1/",
  )
  expect(text).not.toContain("clean -fdX")
})

test("the tester template has agent-browser written by its literal name, since no-raw-spawn refuses a program it cannot read (#1859)", async () => {
  const text = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/new-tester.md")).text()
  expect(text).toContain("write `agent-browser` by its literal name")
})

// an urgent ticket gets the Mac: every other session idles on the lead's stop until the all-clear
test("the tester template carries the stop: set the drive aside, stop your own slot tasks and stacks, go idle, and carry on at the all-clear", async () => {
  const text = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/new-tester.md")).text()
  const line = text.split("\n").find((l) => l.startsWith("**stop**:")) ?? ""
  expect(line).toContain(
    "stop your own queued and running slot tasks and dev stacks by their own handle",
  )
  expect(line).toContain("go idle, with no new round, merge or spawn")
  expect(line).toContain("all-clear, carry on where you stopped")
  expect(line).toContain("the urgent ticket's own session and its checkers keep working")
})
