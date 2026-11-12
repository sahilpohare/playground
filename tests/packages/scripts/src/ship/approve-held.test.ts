import { describe, expect, test } from "bun:test"

import type { Run, RunResult } from "../../../../../packages/scripts/src/pr-merge/merge"
import {
  approveHeld,
  heldRefusals,
  heldRuns,
  type HeldFacts,
  type HeldRun,
} from "../../../../../packages/scripts/src/ship/approve-held"

const HEAD = "abc123def456abc123def456abc123def456a"
const OTHER = "9999999999999999999999999999999999999"

// A run as GitHub's list returns it, whose head_sha and conclusion the script maps onto HeldRun: a held run reads status completed with conclusion action_required.
const wireOf = (
  headSha: string,
  status: string,
  conclusion: string,
  event: string,
  id: number,
) => ({
  conclusion,
  event,
  head_sha: headSha,
  id,
  status,
})

// The four-run fixture, written once: the held run at the head, one at another sha, one whose conclusion is success, and one whose event is push.
const four = [
  wireOf(HEAD, "completed", "action_required", "pull_request", 101),
  wireOf(OTHER, "completed", "action_required", "pull_request", 202),
  wireOf(HEAD, "completed", "success", "pull_request", 303),
  wireOf(HEAD, "completed", "action_required", "push", 404),
]

const heldAtHead = JSON.stringify({ workflow_runs: four })

// The rows mapped onto HeldRun the way approveHeld maps them, for heldRuns' own test.
const toHeld = (r: (typeof four)[number]): HeldRun => ({
  conclusion: r.conclusion,
  event: r.event,
  headSha: r.head_sha,
  id: r.id,
})

// A stub Run that answers gh reads from a map keyed by the call's first two arguments and records every call, so a test can assert which approve went out.
const fakeRun = (answers: Record<string, string>): { run: Run; calls: string[] } => {
  const calls: string[] = []
  const run: Run = async (args) => {
    const key = args.slice(0, 2).join(" ")
    const answer = answers[key] ?? ""
    calls.push(args.join(" "))
    const result: RunResult = { code: 0, stderr: "", stdout: answer }
    return result
  }
  return { calls, run }
}

const prAnswer = JSON.stringify({
  base: { ref: "main" },
  head: { ref: "canary", sha: HEAD },
  state: "open",
})

const runsKey = `api repos/o/r/actions/runs?event=pull_request&head_sha=${HEAD}&per_page=100&status=action_required`

describe("heldRefusals", () => {
  const base: HeldFacts = { base: "main", head: "canary", sha: HEAD, state: "open" }
  test("an open ship PR holds no refusal", () => {
    expect(heldRefusals(base)).toBeNull()
  })
  test("a PR whose head is not canary is refused", () => {
    expect(heldRefusals({ ...base, head: "other-branch" })).toContain("head other-branch")
  })
  test("a PR whose base is not main is refused", () => {
    expect(heldRefusals({ ...base, base: "canary" })).toContain("into canary")
  })
  test("a closed PR is refused", () => {
    expect(heldRefusals({ ...base, state: "closed" })).toContain("closed")
  })
})

describe("heldRuns", () => {
  test("keeps only a held run at the head", () => {
    expect(heldRuns(four.map(toHeld), HEAD).map((r) => r.id)).toEqual([101])
  })
})

describe("approveHeld", () => {
  test("a held run at the head is approved", async () => {
    const { calls, run } = fakeRun({
      "api repos/o/r/pulls/5": prAnswer,
      [runsKey]: heldAtHead,
    })
    const lines = await approveHeld(run, "o/r", 5)
    const approves = calls.filter((call) => call.includes("/approve"))
    expect(approves).toEqual(["api -X POST repos/o/r/actions/runs/101/approve"])
    expect(lines.join("\n")).toContain("101")
  })
  test("a held run at another sha is left alone", async () => {
    const { calls, run } = fakeRun({
      "api repos/o/r/pulls/5": prAnswer,
      [runsKey]: JSON.stringify({
        workflow_runs: [four[1]],
      }),
    })
    const lines = await approveHeld(run, "o/r", 5)
    expect(calls.filter((call) => call.includes("/approve"))).toEqual([])
    expect(lines.join("\n")).toContain("none held")
  })
  test("a completed run whose conclusion is success is left alone", async () => {
    const { calls, run } = fakeRun({
      "api repos/o/r/pulls/5": prAnswer,
      [runsKey]: JSON.stringify({
        workflow_runs: [four[2]],
      }),
    })
    await approveHeld(run, "o/r", 5)
    expect(calls.filter((call) => call.includes("/approve"))).toEqual([])
  })
  test("a PR whose head is not canary is refused with no call made", async () => {
    const { calls, run } = fakeRun({
      "api repos/o/r/pulls/5": JSON.stringify({
        base: { ref: "main" },
        head: { ref: "feature", sha: HEAD },
        state: "open",
      }),
    })
    await expect(approveHeld(run, "o/r", 5)).rejects.toThrow("canary")
    expect(calls.filter((call) => call.includes("/approve"))).toEqual([])
    expect(calls.length).toBe(1)
  })
  test("a PR whose base is not main is refused with no call made", async () => {
    const { calls, run } = fakeRun({
      "api repos/o/r/pulls/5": JSON.stringify({
        base: { ref: "canary" },
        head: { ref: "canary", sha: HEAD },
        state: "open",
      }),
    })
    await expect(approveHeld(run, "o/r", 5)).rejects.toThrow("into canary")
    expect(calls.filter((call) => call.includes("/approve"))).toEqual([])
    expect(calls.length).toBe(1)
  })
})
