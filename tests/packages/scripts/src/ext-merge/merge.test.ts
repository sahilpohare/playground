import { describe, expect, test } from "bun:test"

import { extMerge } from "../../../../../packages/scripts/src/ext-merge/merge"
import { type Run, type RunResult } from "../../../../../packages/scripts/src/pr-merge/merge"

// Made-up values: the account quillco and PR 3 of its extension repository quillco/acme-skills.
const REPO = "quillco/acme-skills"
const HEAD = "69a6a4c5e6caf46c4abda6a89de4ce6f3b309e88"
const URL = `https://github.com/${REPO}/pull/3`
const AGENTS = [
  { kind: "worker", name: "ab12cd-worker", pr: URL },
  { kind: "reviewer", name: "ef34gh-reviewer", prs: [URL] },
]
const ok = (stdout: string): RunResult => ({ code: 0, stderr: "", stdout })

// A stub gh: the PR, the repository, the account and one 5/5 comment; workflows answers the contents read, and every call is recorded.
function stub(workflows: RunResult, checks: unknown[] = []) {
  const calls: string[][] = []
  let merged = false
  const run: Run = async (args) => {
    calls.push(args)
    const line = args.join(" ")
    if (line.startsWith("pr view 3") && line.includes("mergeCommit"))
      return ok(
        JSON.stringify({
          mergeCommit: merged ? { oid: "abc1234" } : null,
          state: merged ? "MERGED" : "OPEN",
        }),
      )
    if (line.startsWith("pr view 3") && line.includes("body")) return ok("Fix the export.")
    if (line.startsWith("pr view 3"))
      return ok(
        JSON.stringify({
          author: { login: "quillco" },
          baseRefName: "main",
          headRefOid: HEAD,
          isCrossRepository: false,
          isDraft: false,
          mergeable: "MERGEABLE",
          state: "OPEN",
          statusCheckRollup: checks,
          url: URL,
        }),
      )
    if (line.startsWith(`repo view ${REPO}`)) return ok("main")
    if (line.startsWith("api user")) return ok("quillco")
    if (line.startsWith(`api repos/${REPO}/issues/3/comments`))
      return ok(
        JSON.stringify({
          author: "quillco",
          body: `## ReviewBot · round 1: 5/5 at ${HEAD.slice(0, 7)}`,
          createdAt: "2026-11-12T01:00:00Z",
        }),
      )
    if (line.startsWith(`api repos/${REPO}/contents/.github/workflows`)) return workflows
    if (line.startsWith("pr merge 3")) {
      merged = true
      return ok("")
    }
    throw new Error(`unexpected gh ${line}`)
  }
  return { calls, run }
}
const options = (run: Run) => ({ agents: AGENTS, repos: new Set([REPO]), run })
const NOT_FOUND: RunResult = { code: 1, stderr: "gh: Not Found (HTTP 404)", stdout: "" }

describe("ext:merge", () => {
  test("a repository with no workflow folder and no checks merges at its head", async () => {
    const { calls, run } = stub(NOT_FOUND)
    const outcome = await extMerge(REPO, 3, options(run))
    expect(outcome).toMatchObject({ kind: "merged", sha: "abc1234" })
    const merge = calls.find((args) => args[0] === "pr" && args[1] === "merge")
    expect(merge).toContain("--match-head-commit")
    expect(merge).toContain(HEAD)
  })

  test("a repository whose workflows have not reported waits, and merges nothing", async () => {
    const { calls, run } = stub(ok("1"))
    const outcome = await extMerge(REPO, 3, options(run))
    expect(outcome.kind).toBe("refused")
    expect(calls.some((args) => args[1] === "merge")).toBe(false)
  })

  test("a workflow read that fails for another reason throws", async () => {
    const { run } = stub({ code: 1, stderr: "HTTP 502", stdout: "" })
    await expect(extMerge(REPO, 3, options(run))).rejects.toThrow(
      "could not read the workflow files",
    )
  })

  test("--explain merges nothing", async () => {
    const { calls, run } = stub(NOT_FOUND)
    const outcome = await extMerge(REPO, 3, { ...options(run), explain: true })
    expect(outcome.kind).toBe("explained")
    expect(calls.some((args) => args[1] === "merge")).toBe(false)
  })
})
