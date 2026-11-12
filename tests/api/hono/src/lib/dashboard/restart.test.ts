import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { fixtureRestart, restartArgv, restartPrs, restartSession } =
  await import("../../../../../../api/hono/src/lib/dashboard/restart")
type Run = import("../../../../../../api/hono/src/lib/dashboard/restart").Run

const scratch = mkdtempSync(join(tmpdir(), "restart-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const SESSION = {
  cwd: "/Users/someone/playground/.claude/worktrees/leads",
  name: "dispatcher",
  sessionId: "0f000000-0000-4000-8000-000000000001",
}

// spawn.sh as a script: each argv recorded, the answers given in turn.
const spawn = (...answers: { code: number; stderr?: string }[]) => {
  const calls: string[][] = []
  const run: Run = async (argv) => {
    calls.push(argv)
    return { stderr: "", stdout: "", ...(answers[calls.length - 1] ?? { code: 0 }) }
  }
  return { calls, run }
}

describe("a restart after a login expires", () => {
  test("a checker's resume names its pr first, then the rest of its prs, and one naming no pull request, issues alone included, reads null, which the route refuses before the close; a session that is no checker or has no row names none (#1135)", () => {
    const A = "https://github.com/acme/factory/pull/1"
    const B = "https://github.com/acme/factory/pull/2"
    const ISSUE = "https://github.com/acme/factory/issues/5"
    expect(restartPrs(true, { pr: A, prs: [A, B] })).toEqual([A, B])
    expect(restartPrs(true, { pr: B, prs: [A, B] })).toEqual([B, A])
    expect(restartPrs(true, { prs: [A, B] })).toEqual([A, B])
    expect(restartPrs(true, { pr: B })).toEqual([B])
    expect(restartPrs(true, {})).toBeNull()
    expect(restartPrs(true, { prs: [ISSUE] })).toBeNull()
    expect(restartPrs(true, { pr: A, prs: [ISSUE, A] })).toEqual([A, ISSUE])
    expect(restartPrs(true, { prs: ["acme/script/start-up"] })).toBeNull()
    expect(restartPrs(true, { pr: A, prs: [A, "acme/script/start-up"] })).toEqual([
      A,
      "acme/script/start-up",
    ])
    expect(restartPrs(true, undefined)).toBeUndefined()
    expect(restartPrs(false, { pr: A, prs: [A] })).toBeUndefined()
  })

  test("closes the pane spawn.sh opened, then resumes the same session on the account added", async () => {
    const { calls, run } = spawn({ code: 0 }, { code: 0 })
    const done = await restartSession(
      { ...SESSION, account: "made-up@example.com" },
      { live: true, root: "/p", run },
    )
    expect(done).toEqual({ status: "restarted" })
    expect(calls).toEqual([
      ["/p/scripts/spawn.sh", "close", "dispatcher"],
      [
        "/p/scripts/spawn.sh",
        "resume",
        "dispatcher",
        SESSION.cwd,
        SESSION.sessionId,
        "--account",
        "made-up@example.com",
      ],
    ])
  })

  test("with no account it resumes on this Mac's own login, naming no --account", () => {
    expect(restartArgv("/p", SESSION)[1]).toEqual([
      "/p/scripts/spawn.sh",
      "resume",
      "dispatcher",
      SESSION.cwd,
      SESSION.sessionId,
    ])
  })

  test("a checker's restart names the PRs its row lists, so its resume on the row close ended starts again (#1135)", async () => {
    const { calls, run } = spawn({ code: 0 }, { code: 0 })
    const prs = [
      "https://github.com/acme/factory/pull/1",
      "https://github.com/acme/factory/issues/2",
    ]
    const checker = { ...SESSION, name: "reviewer-brave-otter", prs }
    expect(await restartSession(checker, { live: true, root: "/p", run })).toEqual({
      status: "restarted",
    })
    expect(calls[1]).toEqual([
      "/p/scripts/spawn.sh",
      "resume",
      "reviewer-brave-otter",
      SESSION.cwd,
      SESSION.sessionId,
      "--pr",
      prs.join(","),
    ])
  })

  test("a refused close stops it there, with spawn.sh's own words", async () => {
    const { calls, run } = spawn({ code: 1, stderr: "spawn.sh: no pane is labelled dispatcher\n" })
    expect(await restartSession(SESSION, { live: true, root: "/p", run })).toEqual({
      detail: "spawn.sh: no pane is labelled dispatcher",
      status: "refused",
    })
    expect(calls).toHaveLength(1)
  })

  test("a fixture stack runs nothing and clears only that session's login block", () => {
    const path = join(scratch, "state.json")
    const blocked = [
      { kind: "login", name: "dispatcher" },
      { kind: "usage-limit", name: "dispatcher" },
      { kind: "login", name: "planner" },
    ]
    writeFileSync(path, JSON.stringify({ blocked, writtenAt: "2026-12-31T12:00:00.000Z" }))
    fixtureRestart("dispatcher", path)
    const state = JSON.parse(readFileSync(path, "utf8"))
    expect(state.blocked).toEqual(blocked.slice(1))
    expect(state.writtenAt).toBe("2026-12-31T12:00:00.000Z")
  })
})
