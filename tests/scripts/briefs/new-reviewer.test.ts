import { expect, test } from "bun:test"
import { join } from "node:path"

// a held PR opens no round: an unexpected push during the hold spent model time (#2343)
test("the reviewer template carries the hold: stop the push waiter with TaskStop, and start it again on the lead's resume word", async () => {
  const text = await Bun.file(
    join(import.meta.dir, "../../../scripts/briefs/new-reviewer.md"),
  ).text()
  const line = text.split("\n").find((l) => l.startsWith("**hold**:")) ?? ""
  expect(line).toContain("stop your push waiter")
  expect(line).toContain("`TaskStop`")
  expect(line).toContain("that lead's resume word")
  expect(line).toContain("ship's freeze is no hold")
})

// an urgent ticket gets the Mac: every other session idles on the lead's stop until the all-clear
test("the reviewer template carries the stop: stop your own slot tasks, go idle, and carry on at the all-clear", async () => {
  const text = await Bun.file(
    join(import.meta.dir, "../../../scripts/briefs/new-reviewer.md"),
  ).text()
  const line = text.split("\n").find((l) => l.startsWith("**stop**:")) ?? ""
  expect(line).toContain("stop your own queued and running slot tasks by their own handle")
  expect(line).toContain("go idle, with no new round, merge or spawn")
  expect(line).toContain("all-clear, carry on where you stopped")
  expect(line).toContain("the urgent ticket's own session and its checkers keep working")
})
