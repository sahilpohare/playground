import { describe, expect, test } from "bun:test"

import {
  machineGh,
  POLL_SECONDS,
  runCiWait,
} from "../../../../../packages/scripts/src/playground/ci-wait"
import { withGhDown } from "../../../../gh-down"

const REPO = "acme/factory"
const A = "a".repeat(40)
const B = "b".repeat(40)
const NOW = Date.parse("2026-11-14T08:00:00Z")

type Reply = { body?: unknown; headers?: Record<string, string>; path: string; status?: string }

const pr = (sha: string, mergeable: boolean | null = true, state = "open"): Reply => ({
  body: { base: "canary", mergeable, sha, state },
  path: `repos/${REPO}/pulls/7`,
})
const runs = (sha: string, ...checks: [string, string, string | null, number][]): Reply => ({
  body: checks.map(([name, status, conclusion, id]) => ({ conclusion, id, name, status })),
  path: `repos/${REPO}/commits/${sha}/check-runs?per_page=100`,
})
const workflows = (sha: string, ...list: [string, string, number][]): Reply => ({
  body: list.map(([name, status, id]) => ({ id, name, status })),
  path: `repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100`,
})
const limited = (path: string, reset: number): Reply => ({
  headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
  path,
})

// A gh that answers each `gh api -i <path>` from the replies in order, refusing a path out of turn; a reply with no body fails as gh does, its headers on stdout.
const fakeGh = (replies: Reply[]) => {
  const left = [...replies]
  return (args: string[]) => {
    const next = left.shift()
    if (!next) throw new Error(`no reply left for ${args.join(" ")}`)
    expect(args.slice(0, 3)).toEqual(["api", "-i", next.path])
    const headers = Object.entries(next.headers ?? {}).map(([k, v]) => `${k}: ${v}`)
    const head = [`HTTP/2.0 ${next.status ?? "200 OK"}`, ...headers].join("\n")
    if (next.body === undefined)
      return { code: 1, stderr: "gh: API rate limit exceeded", stdout: `${head}\n\n{}` }
    return { code: 0, stderr: "", stdout: `${head}\n\n${JSON.stringify(next.body)}` }
  }
}

const wait = async (replies: Reply[], words = ["7", "--repo", REPO]) => {
  const sleeps: number[] = []
  const lines: string[] = []
  const code = await runCiWait(words, {
    err: (line) => lines.push(`err: ${line}`),
    gh: fakeGh(replies),
    now: () => NOW,
    out: (line) => lines.push(line),
    repo: async () => REPO,
    sleep: async (seconds) => void sleeps.push(seconds),
  })
  return { code, lines, sleeps }
}

const BUILD = "Audit, Lint, and Build"

describe("playground ci-wait (PG-2113)", () => {
  test("a head whose required check is not yet created keeps waiting, a poll at a time", async () => {
    const { code, lines, sleeps } = await wait([
      pr(A),
      runs(A, [BUILD, "completed", "success", 3]),
      workflows(A, ["auto-check-build", "completed", 10], ["auto-test", "queued", 11]),
      pr(A),
      runs(A, [BUILD, "completed", "success", 3], ["test", "completed", "success", 4]),
    ])
    expect(code).toBe(0)
    expect(sleeps).toEqual([POLL_SECONDS])
    expect(lines.slice(-2)).toEqual([`success ${BUILD}`, "success test"])
  })

  test("both required checks completed and passed exits 0 at once, naming each conclusion", async () => {
    const { code, lines, sleeps } = await wait([
      pr(A),
      runs(A, [BUILD, "completed", "success", 3], ["test", "completed", "success", 4]),
    ])
    expect(code).toBe(0)
    expect(sleeps).toEqual([])
    expect(lines).toContain(`success ${BUILD}`)
    expect(lines).toContain("success test")
  })

  test("one failed required check exits 1", async () => {
    const { code, lines } = await wait([
      pr(A),
      runs(A, [BUILD, "completed", "failure", 3], ["test", "completed", "success", 4]),
    ])
    expect(code).toBe(1)
    expect(lines).toContain(`failure ${BUILD}`)
  })

  test("a run still in progress waits, and its newest run by id is the one read", async () => {
    const { code, sleeps } = await wait([
      pr(A),
      runs(
        A,
        [BUILD, "completed", "failure", 3],
        [BUILD, "in_progress", null, 5],
        ["test", "completed", "success", 4],
      ),
      pr(A),
      runs(
        A,
        [BUILD, "completed", "failure", 3],
        [BUILD, "completed", "success", 5],
        ["test", "completed", "success", 4],
      ),
    ])
    expect(code).toBe(0)
    expect(sleeps).toEqual([POLL_SECONDS])
  })

  test("a head that moves restarts the wait on the new head, whose checks alone count", async () => {
    const { code, lines, sleeps } = await wait([
      pr(A),
      runs(A, [BUILD, "in_progress", null, 3], ["test", "in_progress", null, 4]),
      pr(B),
      runs(B),
      workflows(B),
      pr(B),
      runs(B, [BUILD, "completed", "failure", 7], ["test", "completed", "success", 8]),
    ])
    expect(code).toBe(1)
    expect(sleeps).toEqual([POLL_SECONDS, POLL_SECONDS])
    expect(lines.some((line) => line.includes(B.slice(0, 7)))).toBe(true)
  })

  test("a near-twin check (Lint and Build) never stands in for the required one", async () => {
    const { code, sleeps } = await wait([
      pr(A),
      runs(A, ["Lint and Build", "completed", "success", 3], ["test", "completed", "success", 4]),
      workflows(A, ["auto-check-build", "in_progress", 10], ["auto-test", "completed", 11]),
      pr(A),
      runs(
        A,
        ["Lint and Build", "completed", "success", 3],
        ["test", "completed", "success", 4],
        [BUILD, "completed", "failure", 9],
      ),
    ])
    expect(code).toBe(1)
    expect(sleeps).toEqual([POLL_SECONDS])
  })

  test("a required check whose workflow run finished without creating it exits 1, naming it and the rerun", async () => {
    const { code, lines, sleeps } = await wait([
      pr(A),
      runs(A, ["Lint and Build", "completed", "success", 3], ["test", "completed", "success", 4]),
      workflows(A, ["auto-check-build", "completed", 10], ["auto-test", "completed", 11]),
    ])
    expect(code).toBe(1)
    expect(sleeps).toEqual([])
    expect(lines.join("\n")).toContain(`no ${BUILD} check`)
    expect(lines.join("\n")).toContain("gh run rerun 10")
  })

  test("a PR or repo GitHub does not know, or a login it refuses, exits 2 at once rather than waiting for good", async () => {
    for (const status of ["404 Not Found", "401 Unauthorized"]) {
      const { code, lines, sleeps } = await wait([{ path: `repos/${REPO}/pulls/7`, status }])
      expect(code).toBe(2)
      expect(sleeps).toEqual([])
      expect(lines.join("\n")).toContain(status)
    }
  })

  test("a rate limit waits out its reset, then reads again", async () => {
    const { code, sleeps } = await wait([
      limited(`repos/${REPO}/pulls/7`, NOW / 1000 + 60),
      pr(A),
      runs(A, [BUILD, "completed", "success", 3], ["test", "completed", "success", 4]),
    ])
    expect(code).toBe(0)
    expect(sleeps).toEqual([65])
  })

  // PG-2486: GitHub starts no pull_request run on a PR that conflicts with its base, so a wait on its checks never ends
  test("a PR that conflicts with its base exits 1 at once, naming the merge it needs, and reads no check", async () => {
    const { code, lines, sleeps } = await wait([pr(A, false)])
    expect(code).toBe(1)
    expect(sleeps).toEqual([])
    expect(lines).toContain("#7 conflicts with canary: no CI runs until canary is merged in")
  })

  // the fake gh refuses a path out of turn, so a check-runs read before mergeable turns true fails this test
  test("a mergeable state GitHub has not yet worked out waits a poll and reads the PR again, reading checks only once it turns mergeable", async () => {
    const { code, lines, sleeps } = await wait([
      pr(A, null),
      pr(A, true),
      runs(A, [BUILD, "completed", "success", 3], ["test", "completed", "success", 4]),
    ])
    expect(code).toBe(0)
    expect(sleeps).toEqual([POLL_SECONDS])
    expect(lines.join("\n")).not.toContain("conflicts")
  })

  // a merged or closed PR, which REST reads as state closed, reads mergeable null for good, so a wait on it reads its checks as they stand rather than waiting without end
  test("a merged or closed PR whose mergeable reads null reads its checks at once", async () => {
    const { code, sleeps } = await wait([
      pr(A, null, "closed"),
      runs(A, [BUILD, "completed", "success", 3], ["test", "completed", "success", 4]),
    ])
    expect(code).toBe(0)
    expect(sleeps).toEqual([])
  })

  test("a PR that turns conflicting while its checks run stops at the next poll", async () => {
    const { code, lines, sleeps } = await wait([
      pr(A, true),
      runs(A, [BUILD, "in_progress", null, 3], ["test", "in_progress", null, 4]),
      pr(A, false),
    ])
    expect(code).toBe(1)
    expect(sleeps).toEqual([POLL_SECONDS])
    expect(lines.at(-1)).toBe("#7 conflicts with canary: no CI runs until canary is merged in")
  })

  test("a PR number that is not a number, or a repo that is not owner/name, is a usage error", async () => {
    expect((await wait([], ["seven"])).code).toBe(2)
    expect((await wait([], ["7", "--repo", "factory"])).code).toBe(2)
  })

  test("the repo defaults to the factory's own", async () => {
    const { code } = await wait(
      [pr(A), runs(A, [BUILD, "completed", "success", 3], ["test", "completed", "success", 4])],
      ["7"],
    )
    expect(code).toBe(0)
  })
})

// a waiter polls every 5 minutes for each worker, so it skips gh while ops-tick's gh sign-in probe reads failed
test("machineGh answers gh unreachable while the gh sign-in probe reads failed", async () => {
  expect(await withGhDown(() => machineGh(["api", "user"]))).toEqual({
    code: 1,
    stderr: "gh unreachable: gh token invalid",
    stdout: "",
  })
})
