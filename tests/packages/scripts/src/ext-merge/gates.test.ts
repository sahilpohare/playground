import { describe, expect, test } from "bun:test"

import {
  gatesOf,
  reviewersOf,
  type Agent,
  type ExtFacts,
} from "../../../../../packages/scripts/src/ext-merge/gates"
import { type Comment } from "../../../../../packages/scripts/src/pr-merge/gates"

// Made-up values: the account quillco, its extension repository quillco/acme-skills, and PR 3 there.
const HEAD = "69a6a4c5e6caf46c4abda6a89de4ce6f3b309e88"
const URL = "https://github.com/quillco/acme-skills/pull/3"
const said = (body: string, author = "quillco"): Comment => ({
  author,
  body,
  createdAt: "2026-11-12T01:00:00Z",
})
const FIVE = said(`## ReviewBot · round 1: 5/5 at ${HEAD.slice(0, 7)} · 0 blocking`)
const PASSED = { conclusion: "SUCCESS", name: "test", status: "COMPLETED", workflowName: "ci" }
const WORKER: Agent = { kind: "worker", name: "ab12cd-worker", pr: URL }
const REVIEWER: Agent = { kind: "reviewer", name: "ef34gh-reviewer", pr: URL, prs: [URL] }

const facts = (over: Partial<ExtFacts> = {}): ExtFacts => ({
  author: "quillco",
  base: "main",
  checks: [PASSED],
  comments: [FIVE],
  crossRepo: false,
  defaultBranch: "main",
  draft: false,
  guarded: true,
  head: HEAD,
  mergeable: "MERGEABLE",
  repo: "quillco/acme-skills",
  reviewers: reviewersOf([WORKER, REVIEWER], URL),
  state: "OPEN",
  viewer: "quillco",
  workflows: 1,
  ...over,
})
const failing = (f: ExtFacts) =>
  gatesOf(f)
    .filter((gate) => !gate.ok)
    .map((gate) => gate.name)

describe("ext:merge's gates", () => {
  test("a reviewed, green, clean PR into the default passes every gate", () => {
    expect(failing(facts())).toEqual([])
  })

  test.each<[string, Partial<ExtFacts>, string]>([
    ["a repository the hook does not guard", { guarded: false }, "extension"],
    ["a closed PR", { state: "CLOSED" }, "open"],
    ["a PR another account opened", { author: "mallory" }, "author"],
    ["a draft", { draft: true }, "ready"],
    ["a base other than the default", { base: "dev" }, "base"],
    ["a head in a fork", { crossRepo: true }, "head"],
    ["no review", { comments: [] }, "review"],
    ["a 4/5", { comments: [said(`## ReviewBot · round 2: 4/5 at ${HEAD.slice(0, 7)}`)] }, "review"],
    [
      "a 5/5 at an older head",
      { comments: [said("## ReviewBot · round 1: 5/5 at 5740cea")] },
      "review",
    ],
    ["a 5/5 from another account", { comments: [said(FIVE.body, "mallory")] }, "review"],
    ["a failed check", { checks: [{ ...PASSED, conclusion: "FAILURE" }] }, "ci"],
    ["a pending check", { checks: [{ ...PASSED, conclusion: null, status: "IN_PROGRESS" }] }, "ci"],
    ["a conflict", { mergeable: "CONFLICTING" }, "mergeable"],
    ["a merge GitHub has not worked out", { mergeable: "UNKNOWN" }, "mergeable"],
  ])("%s is refused", (_, over, gate) => {
    expect(failing(facts(over))).toEqual([gate])
  })

  test("a head with no checks passes when the repository has no workflow file", () => {
    expect(failing(facts({ checks: [], workflows: 0 }))).toEqual([])
  })

  test("a head with no checks waits while the repository has a workflow file", () => {
    const gate = gatesOf(facts({ checks: [], workflows: 2 })).find((g) => g.name === "ci")
    expect(gate?.ok).toBe(false)
    expect(gate?.detail).toContain("2 workflow files: wait for them to report")
  })
})

describe("the independence gate", () => {
  test("an author's own 5/5, with no reviewer session listing the PR, is refused", () => {
    expect(failing(facts({ reviewers: reviewersOf([WORKER], URL) }))).toEqual(["independent"])
  })

  test("a reviewer row that lists another PR does not count", () => {
    const other = { ...REVIEWER, pr: `${URL}0`, prs: [`${URL}0`] }
    expect(reviewersOf([WORKER, other], URL)).toEqual([])
  })

  test("a session that lists the PR as its own work never counts as its reviewer", () => {
    const both: Agent = { kind: "reviewer", name: "ab12cd-worker", prs: [URL] }
    expect(reviewersOf([WORKER, both], URL)).toEqual([])
  })

  test("a reviewer session listing the PR by prs alone counts", () => {
    expect(reviewersOf([WORKER, { ...REVIEWER, pr: null }], URL)).toEqual(["ef34gh-reviewer"])
  })
})
