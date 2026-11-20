import { expect, test } from "bun:test"
import { join } from "node:path"

const text = await Bun.file(join(import.meta.dir, "../../../scripts/briefs/optimizer.md")).text()
const steps = text.split("\n").filter((line) => /^\d+\. /.test(line))

test("the optimizer's brief template loads the playbook, ends every step on a completion criterion and carries the signal rule", () => {
  expect(steps[0]).toContain("Load the playbook skill")
  expect(steps.length).toBeGreaterThanOrEqual(7)
  for (const step of steps) expect(step).toMatch(/ Done when [^.]+\.$/)
  expect(text).toContain("**signal**: signal only processes you started")
})

test("its retro runs on ops-tick's two beats, reads the table script, and keeps a failed run's error text when first seen", () => {
  expect(text).toContain("`optimizer tick`")
  expect(text).toContain("`optimizer daily`")
  expect(text).toContain("packages/scripts/src/retro/table.ts")
  expect(text).toContain("mkdir -p ~/.playground/scratchpad/optimizer/ci")
  expect(text).toContain("actions/runs/<run id>/jobs")
  expect(text).toContain("actions/jobs/<job id>/logs")
  expect(text).toContain("~/.playground/scratchpad/optimizer/ci/<run id>-job-<job id>.log")
  expect(text).toContain("as a background task")
})

// gh run view --log-failed hung and wrote nothing on a 26-job run, and ops/ is protected, so playground rm refused to clear the saved logs (PG-2523)
test("it saves a failed job's whole log to its scratchpad, never through gh run view --log-failed or into ops/", () => {
  expect(text).not.toContain("gh run view <run id> --log-failed")
  expect(text).not.toContain("ops/optimizer/ci")
})

test("a first retro with no state file has a since and a ship to start from, and the next starts where this one's table read", () => {
  expect(text).toContain("With no state file")
  expect(text).toContain("`lastRetroEnd` as step 4's mark")
})

test("the daily beat's threshold sits under its own day, and its reads go through REST as the github rule says", () => {
  expect(text).toContain("20 hours old or more")
  expect(text).toContain('gh api "repos/{owner}/{repo}/pulls?base=main&state=closed')
  expect(text).not.toMatch(/gh (issue|pr) (list|view)/)
})
