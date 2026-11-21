import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Check, PrFacts } from "../../../../../packages/scripts/src/pr-merge/gates"
import { FREEZE_LAPSE_MS, heldOf } from "../../../../../packages/scripts/src/pr-merge/held"
import type { Run, RunResult } from "../../../../../packages/scripts/src/pr-merge/merge"
import { forecast, gatedOf, resolve } from "../../../../../packages/scripts/src/pr-merge/train"
import { SKILL_BODY } from "./bodies"
import "./scratch-config"
import { greenChecks } from "./suite"

// Each test runs real git against a scratch origin, slower than bun's 5s default on a loaded machine.
setDefaultTimeout(30_000)

const scratch = mkdtempSync(join(tmpdir(), "pr-train-"))
// No test may take the factory's real lock or read its real queue.
process.env.PLAYGROUND_MERGE_LOCK_DIR = join(scratch, "default-lock")
process.env.PLAYGROUND_MERGE_QUEUE = join(scratch, "no-queue.json")
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const REPO = "o/r"
const OWNER = "o"
const ok = (stdout = ""): RunResult => ({ code: 0, stderr: "", stdout })

const ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_AUTHOR_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
}

// A scratch world: a bare origin with canary, a clone pr:train runs git in, and each PR's head pushed to origin as refs/pull/<n>/head, or as its branch pr<n> alone for a PR branchOnly names, as GitHub leaves a PR whose pull ref it has not made yet. edits names, per PR, the files it writes over the base.
function world(edits: Record<number, Record<string, string>>, branchOnly: number[] = []) {
  const root = mkdtempSync(join(scratch, "world-"))
  const origin = join(root, "origin.git")
  const work = join(root, "work")
  const sh = (cwd: string, ...args: string[]) => {
    const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { env: ENV })
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
    return proc.stdout.toString().trim()
  }
  Bun.spawnSync(["git", "init", "--quiet", "--bare", "--initial-branch=canary", origin])
  Bun.spawnSync(["git", "init", "--quiet", "--initial-branch=canary", work])
  sh(work, "remote", "add", "origin", origin)
  for (const file of ["a.txt", "b.txt", "c.txt", "d.txt"])
    writeFileSync(join(work, file), "one\ntwo\nthree\n")
  sh(work, "add", "-A")
  sh(work, "commit", "--quiet", "--no-verify", "-m", "base")
  sh(work, "push", "--quiet", "origin", "canary")
  const heads: Record<number, string> = {}
  for (const [n, files] of Object.entries(edits)) {
    sh(work, "checkout", "--quiet", "-B", `pr${n}`, "canary")
    for (const [file, text] of Object.entries(files)) writeFileSync(join(work, file), text)
    sh(work, "add", "-A")
    sh(work, "commit", "--quiet", "--no-verify", "-m", `pr ${n}`)
    heads[Number(n)] = sh(work, "rev-parse", "HEAD")
    sh(
      work,
      "push",
      "--quiet",
      "origin",
      branchOnly.includes(Number(n)) ? `HEAD:refs/heads/pr${n}` : `HEAD:refs/pull/${n}/head`,
    )
  }
  sh(work, "checkout", "--quiet", "--detach", "canary")
  const git: Run = async (args) => {
    const proc = Bun.spawnSync(["git", "-C", work, ...args], { env: ENV })
    return { code: proc.exitCode, stderr: proc.stderr.toString(), stdout: proc.stdout.toString() }
  }
  return { git, heads, origin, root, sh, work }
}

type World = ReturnType<typeof world>

// A stubbed gh over a world: its open PRs, drafts among them, and each one's head; it records every call.
function hub(w: World, open: number[], drafts: number[] = []) {
  const calls: string[][] = []
  const run: Run = async (args) => {
    calls.push(args)
    const joined = args.join(" ")
    if (joined.startsWith("pr list")) {
      return ok(
        open.map((n) => JSON.stringify({ author: OWNER, draft: drafts.includes(n), n })).join("\n"),
      )
    }
    if (joined.startsWith("pr view") && joined.includes("headRefName")) {
      const n = Number(args[2])
      return ok(JSON.stringify({ headRefName: `pr${n}`, headRefOid: w.heads[n] ?? "" }))
    }
    if (joined.startsWith("pr view") && joined.includes("headRefOid")) {
      return ok(w.heads[Number(args[2])] ?? "")
    }
    return { code: 1, stderr: `unexpected gh ${joined}`, stdout: "" }
  }
  return { calls, run }
}

type Hub = ReturnType<typeof hub>

const RED: Check[] = greenChecks().map((check) =>
  check.name === "test" ? { ...check, conclusion: "FAILURE" } : check,
)

// Each PR's facts at its head: a 5/5 there, and GitHub's jobs green unless red names it.
const factsFor =
  (w: World, red: number[] = []) =>
  async (_run: Run, _repo: string, n: number): Promise<PrFacts> => {
    const head = w.heads[n] ?? ""
    return {
      aheadBy: 0,
      author: OWNER,
      base: "canary",
      canary: "",
      checks: red.includes(n) ? RED : greenChecks(),
      comments: [
        {
          author: OWNER,
          body: `## ReviewBot · round 1: 5/5 at ${head.slice(0, 7)} · 0 blocking`,
          createdAt: "2026-10-07T16:00:00.000Z",
        },
      ],
      draft: false,
      files: ["packages/scripts/src/x.ts"],
      head,
      held: null,
      lost: [],
      mergeTree: null,
      n,
      owner: OWNER,
      state: "OPEN",
    }
  }

const localOf = (w: World, _h: Hub, extra: { queue?: number[]; red?: number[] } = {}) => {
  const lockRoot = mkdtempSync(join(w.root, "lock-"))
  const queue = join(w.root, "queue.json")
  writeFileSync(queue, JSON.stringify({ queue: (extra.queue ?? []).map((pr) => ({ pr })) }))
  return { facts: factsFor(w, extra.red), git: w.git, lockRoot, queue }
}

const edit = (line: string) => `one\n${line}\nthree\n`

describe("pr:train", () => {
  test("forecast predicts each queued PR's conflicts with canary and the PRs ahead, gated or not and drafts included, and writes nothing", async () => {
    const w = world({
      81: { "AGENTS.md": "ours\n" },
      82: { "b.txt": edit("B") },
      83: { "AGENTS.md": "theirs\n" },
    })
    const h = hub(w, [81, 82, 83], [83])
    const result = await forecast(
      { repo: REPO },
      h.run,
      localOf(w, h, { queue: [81, 82, 83], red: [81] }),
    )
    expect(result.order).toEqual([81, 82, 83])
    expect(result.conflicts).toMatchObject([{ files: ["AGENTS.md"], n: 83, with: "#81" }])
    expect(h.calls.filter((args) => args[1] === "comment")).toEqual([])
  })

  test("forecast fetches a PR's branch when GitHub has not made its pull ref yet, and merges it at that head (#2389)", async () => {
    const w = world({ 84: { "a.txt": edit("A") }, 85: { "a.txt": edit("B") } }, [85])
    const h = hub(w, [84, 85])
    const result = await forecast({ repo: REPO }, h.run, localOf(w, h, { queue: [84, 85] }))
    expect(result.order).toEqual([84, 85])
    expect(result.conflicts).toMatchObject([{ files: ["a.txt"], n: 85, with: "#84" }])
  })

  test("forecast refuses a branch that moved past the PR's head, so it never merges another commit (#2389)", async () => {
    const w = world({ 86: { "a.txt": edit("A") } }, [86])
    w.sh(w.work, "checkout", "--quiet", "pr86")
    writeFileSync(join(w.work, "b.txt"), edit("later"))
    w.sh(w.work, "commit", "--quiet", "--no-verify", "-am", "later")
    w.sh(w.work, "push", "--quiet", "origin", "HEAD:refs/heads/pr86")
    w.sh(w.work, "checkout", "--quiet", "--detach", "canary")
    const h = hub(w, [86])
    await expect(forecast({ repo: REPO }, h.run, localOf(w, h, { queue: [86] }))).rejects.toThrow(
      `refs/pull/86/head is missing, and its branch pr86 is at `,
    )
  })

  test("the gated PRs keep the queue's order, then PRs it does not list by number, and a red one is held", async () => {
    const w = world({
      3: { "a.txt": edit("3") },
      5: { "a.txt": edit("5") },
      7: { "a.txt": edit("7") },
      9: { "a.txt": edit("9") },
    })
    const h = hub(w, [9, 3, 5, 7])
    const local = localOf(w, h, { queue: [5, 3], red: [7] })
    const { held, order } = await gatedOf(h.run, REPO, local.facts, local.queue)
    expect(order.map((c) => c.n)).toEqual([5, 3, 9])
    expect(held).toEqual([{ n: 7, why: "not gated: ci" }])
  })

  // merge-on-ready picks from gatedOf, so a ship's freeze holds its pick as it holds pr:merge
  test('a ship\'s fresh "*" line holds every pick at 5/5 with green checks, and one past its lapse holds none', async () => {
    const w = world({ 3: { "a.txt": edit("3") }, 5: { "b.txt": edit("5") } })
    const h = hub(w, [3, 5])
    const local = localOf(w, h, { queue: [3, 5] })
    const line = "v0.0.38 ships: canary is frozen until its tag lands"
    const frozen = (ago: number) =>
      JSON.stringify({
        held: { "*": line },
        since: { "*": new Date(Date.now() - ago).toISOString() },
      })
    const reading =
      (text: string) =>
      async (run: Run, repo: string, n: number): Promise<PrFacts> => ({
        ...(await local.facts(run, repo, n)),
        held: heldOf(text, repo, n, Date.now()),
      })
    const fresh = await gatedOf(h.run, REPO, reading(frozen(60_000)), local.queue)
    expect(fresh.order).toEqual([])
    expect(fresh.held).toEqual([
      { n: 3, why: `not gated: held (${line})` },
      { n: 5, why: `not gated: held (${line})` },
    ])
    const lapsed = await gatedOf(h.run, REPO, reading(frozen(FREEZE_LAPSE_MS)), local.queue)
    expect(lapsed.order.map((c) => c.n)).toEqual([3, 5])
  })

  test("a stacked PR whose parent is open is held, and one whose parent merged is gated (PG-1274)", async () => {
    const w = world({ 3: { "a.txt": edit("3") }, 5: { "b.txt": edit("5") } })
    const h = hub(w, [3, 5])
    const local = localOf(w, h, { queue: [3, 5] })
    const stacked =
      (states: Record<number, string>) =>
      async (run: Run, repo: string, n: number): Promise<PrFacts> => ({
        ...(await local.facts(run, repo, n)),
        body: `${SKILL_BODY}\n- Stacked on #12`,
        parents: [{ n: 12, state: states[n] ?? "MERGED" }],
      })
    const { held, order } = await gatedOf(h.run, REPO, stacked({ 3: "OPEN" }), local.queue)
    expect(order.map((c) => c.n)).toEqual([5])
    expect(held).toEqual([{ n: 3, why: "not gated: parent" }])
  })

  test("a PR whose facts cannot be read is held with why, and the others are gated as before", async () => {
    const w = world({
      3: { "a.txt": edit("3") },
      5: { "b.txt": edit("5") },
      7: { "c.txt": edit("7") },
    })
    const h = hub(w, [3, 5, 7])
    const local = localOf(w, h, { queue: [3, 5, 7] })
    const unreadable = async (run: Run, repo: string, n: number): Promise<PrFacts> => {
      if (n === 5) throw new Error("git fetch exited 128: couldn't find remote ref")
      return local.facts(run, repo, n)
    }
    const { held, order } = await gatedOf(h.run, REPO, unreadable, local.queue)
    expect(order.map((c) => c.n)).toEqual([3, 7])
    expect(held).toEqual([
      { n: 5, why: "not gated: facts unreadable (git fetch exited 128: couldn't find remote ref)" },
    ])
  })

  test("outside a scratch lock folder and a git stub, it refuses to run", async () => {
    const w = world({})
    const h = hub(w, [])
    await expect(forecast({ repo: REPO }, h.run, {})).rejects.toThrow("needs a git stub")
  })

  test("a run is real from pr:train's script, and from nowhere else", () => {
    const dir = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "..",
      "packages",
      "scripts",
      "src",
      "pr-merge",
    )
    expect(resolve({}, join(dir, "train-cli.ts")).cli).toBe(true)
    expect(() => resolve({}, join(dir, "cli.ts"))).toThrow("pr:train under test")
    expect(() => resolve({})).toThrow("pr:train under test")
  })
})

test("the CLI takes forecast and ready alone, and refuses the train's old commands", () => {
  const lock = mkdtempSync(join(scratch, "cli-"))
  const cli = join(import.meta.dir, "../../../../../packages/scripts/src/pr-merge/train-cli.ts")
  const env = { ...process.env, PLAYGROUND_MERGE_LOCK_DIR: lock }
  const help = Bun.spawnSync(["bun", cli, "--help"], { env })
  expect(help.exitCode).toBe(0)
  expect(help.stdout.toString()).toContain("forecast")
  expect(help.stdout.toString()).toContain("ready")
  for (const old of ["build", "next", "land", "end"]) {
    const proc = Bun.spawnSync(["bun", cli, old], { env })
    expect(proc.exitCode).toBe(1)
    expect(proc.stderr.toString()).toContain(`unknown command ${old}`)
  }
})
