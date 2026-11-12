import { afterAll, expect, test } from "bun:test"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CARVE_OUTS } from "../../../../../packages/safe-delete/src"
import {
  callerOf,
  clonesOf,
  processesOf,
  RM_USAGE,
  type Decision,
  discardRefusal,
  type PrState,
  prStateOf,
  type RmDeps,
  rmArgs,
  rmDeps,
  runRm,
} from "../../../../../packages/scripts/src/playground/rm"
import type { Proc } from "../../../../../scripts/hooks/session-state"

test("rm takes one path, or --worktree's with an optional --discard and --pr, with an optional reason", () => {
  expect(rmArgs(["old"])).toEqual({
    discard: false,
    path: "old",
    reason: "playground rm",
    worktree: false,
  })
  expect(rmArgs(["--worktree", "wt", "--reason", "merged"])).toEqual({
    discard: false,
    path: "wt",
    reason: "merged",
    worktree: true,
  })
  expect(rmArgs(["--worktree", "wt", "--discard"])).toEqual({
    discard: true,
    path: "wt",
    reason: "playground rm",
    worktree: true,
  })
  expect(rmArgs(["--worktree", "wt", "--discard", "--decision", "#i9"])).toEqual({
    decision: "#i9",
    discard: true,
    path: "wt",
    reason: "playground rm",
    worktree: true,
  })
  expect(rmArgs(["--worktree", "wt", "--pr", "https://github.com/o/r/pull/1"])).toEqual({
    discard: false,
    path: "wt",
    pr: "https://github.com/o/r/pull/1",
    reason: "playground rm",
    worktree: true,
  })
})

test("rm takes --list or --restore <id> alone", () => {
  expect(rmArgs(["--list"])).toEqual({ list: true })
  expect(rmArgs(["--restore", "20261102T120000Z-s/1"])).toEqual({ restore: "20261102T120000Z-s/1" })
})

test.each([
  [[]],
  [["a", "b"]],
  [["--worktree"]],
  [["--force", "a"]],
  [["--list", "a"]],
  [["a", "--worktree", "b"]],
  [["a", "--discard"]],
  [["--worktree", "wt", "--discard", "--discard"]],
  [["--worktree", "wt", "--decision", "#i9"]],
  [["--worktree", "wt", "--discard", "--decision"]],
  [["a", "--pr", "https://github.com/o/r/pull/1"]],
  [["--worktree", "wt", "--pr"]],
])("rm refuses %j with its usage", (words) => {
  expect(rmArgs(words)).toEqual({ error: RM_USAGE })
})

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  return run.stdout.toString().trim()
}

const file = (path: string, text = "x"): void => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

// A mkdtemp machine: HOME with its main checkout and data folder, and deps that record each notify line.
const machine = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rm-")))
  dirs.push(root)
  const home = join(root, "home")
  const main = join(home, "playground")
  const data = join(home, ".playground")
  mkdirSync(join(main, ".claude", "worktrees"), { recursive: true })
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, "roster.json"), JSON.stringify({ agents: [] }))
  const told: string[] = []
  const deps: RmDeps = {
    caller: async () => undefined,
    clones: () => [],
    procs: () => [],
    data,
    decision: async () => null,
    home,
    main,
    merged: () => false,
    notify: (text) => void told.push(text),
    places: () => [],
    prState: async () => null,
    session: async () => "j6rjgy-worker",
  }
  return { deps, home, main, root, told }
}

test("runRm moves a path, lists it and restores it, telling no one", async () => {
  const { deps, home, told } = machine()
  const path = join(home, "old.txt")
  writeFileSync(path, "x")
  expect(await runRm([path], deps)).toBe(0)
  expect(existsSync(path)).toBe(false)
  expect(await runRm(["--list"], deps)).toBe(0)
  const [batch] = readdirSync(join(deps.data, "trash"))
  expect(await runRm(["--restore", `${batch}/1`], deps)).toBe(0)
  expect(existsSync(path)).toBe(true)
  expect(told).toEqual([])
})

test("rm of a tree leaves its node_modules and web/next/.next out of the trash, keeps every other file, and the move and restore lines name the install", async () => {
  const { deps, home } = machine()
  const tree = join(home, "review-clone")
  file(join(tree, "node_modules", "left-pad", "index.js"))
  file(join(tree, "packages", "web", "node_modules", "react", "index.js"))
  file(join(tree, "web", "next", ".next", "build-manifest.json"))
  file(join(tree, "web", "next", ".next-cache", "y.js"))
  file(join(tree, "src", "index.ts"))
  const log = console.log
  const said: string[] = []
  console.log = (line: string) => void said.push(line)
  const code = await runRm([tree, "--reason", "scratch"], deps)
  expect(code).toBe(0)
  const trash = join(deps.data, "trash")
  const [batch] = readdirSync(trash)
  const item = join(trash, batch, "1", "review-clone")
  expect(existsSync(join(item, "node_modules"))).toBe(false)
  expect(existsSync(join(item, "packages", "web", "node_modules"))).toBe(false)
  expect(existsSync(join(item, "web", "next", ".next"))).toBe(false)
  expect(existsSync(join(item, "web", "next", ".next-cache", "y.js"))).toBe(true)
  expect(existsSync(join(item, "src", "index.ts"))).toBe(true)
  expect(said.join("\n")).toContain("bun install")
  expect(await runRm(["--restore", `${batch}/1`], deps)).toBe(0)
  console.log = log
  expect(existsSync(join(tree, "src", "index.ts"))).toBe(true)
  expect(existsSync(join(tree, "node_modules"))).toBe(false)
  expect(said.join("\n")).toContain("bun install")
})

test("a strip that stops partway still moves the tree, and the move line names it", async () => {
  const { deps, home } = machine()
  const tree = join(home, "review-clone")
  file(join(tree, "node_modules", "locked", "child.js"))
  file(join(tree, "node_modules", "ok", "child.js"))
  file(join(tree, "src", "index.ts"))
  chmodSync(join(tree, "node_modules", "locked"), 0o555)
  const log = console.log
  const said: string[] = []
  console.log = (line: string) => void said.push(line)
  expect(await runRm([tree, "--reason", "scratch"], deps)).toBe(0)
  console.log = log
  expect(said.join("\n")).toContain("the strip stopped")
  const trash = join(deps.data, "trash")
  const [batch] = readdirSync(trash)
  expect(existsSync(join(trash, batch, "1", "review-clone", "src", "index.ts"))).toBe(true)
  chmodSync(join(trash, batch, "1", "review-clone", "node_modules", "locked"), 0o755)
})

test("the restore of a batch the strip took rebuildables from names the install", async () => {
  const { deps, home } = machine()
  const trash = join(deps.data, "trash")
  const batch = "20261101T120000Z-xssrgq"
  file(join(trash, batch, "1", "review-clone", "node_modules", "left-pad", "index.js"))
  file(join(trash, batch, "1", "review-clone", "src", "index.ts"))
  writeFileSync(
    join(trash, batch, "manifest.jsonl"),
    `${JSON.stringify({
      at: "2026-11-01T12:00:00.000Z",
      files: 2,
      id: `${batch}/1`,
      path: join(home, "review-clone"),
      reason: "playground rm",
      session: "xssrgq",
      size: 20,
      stripped: 1,
    })}\n`,
  )
  const log = console.log
  const said: string[] = []
  console.log = (line: string) => void said.push(line)
  expect(await runRm(["--restore", `${batch}/1`], deps)).toBe(0)
  console.log = log
  expect(existsSync(join(home, "review-clone", "src", "index.ts"))).toBe(true)
  expect(said.join("\n")).toContain("bun install")
})

test("runRm tells the dispatcher once when a session hits the per-minute cap, however many tries it refuses", async () => {
  const { deps, home, told } = machine()
  const paths = Array.from({ length: 14 }, (_, i) => {
    const path = join(home, `old-${i}.txt`)
    writeFileSync(path, "x")
    return path
  })
  const codes: number[] = []
  for (const path of paths) codes.push(await runRm([path], deps))
  expect(codes).toEqual([0, 0, 0, ...Array(11).fill(1)])
  expect(told).toEqual([
    "j6rjgy-worker: j6rjgy-worker quarantined 3 paths in the last minute, the most one session may",
  ])
})

test("runRm clears the caller's own scratch folder", async () => {
  const { deps, home } = machine()
  const scratch = join(home, ".playground", "scratch", "j6rjgy-worker")
  mkdirSync(join(scratch, "tmp"), { recursive: true })
  writeFileSync(join(scratch, "tmp", "work.txt"), "x")
  expect(await runRm([scratch], deps)).toBe(0)
  expect(existsSync(scratch)).toBe(false)
})

test("runRm refuses another session's scratch folder", async () => {
  const { deps, home } = machine()
  const other = join(home, ".playground", "scratch", "a4b5c6-worker")
  mkdirSync(other, { recursive: true })
  expect(await runRm([other], deps)).toBe(1)
  expect(existsSync(other)).toBe(true)
})

test("runRm refuses a .. escape out of the caller's own scratch folder", async () => {
  const { deps, home } = machine()
  const scratch = join(home, ".playground", "scratch", "j6rjgy-worker")
  const other = join(home, ".playground", "scratch", "a4b5c6-worker")
  mkdirSync(other, { recursive: true })
  expect(await runRm([`${scratch}/../a4b5c6-worker`], deps)).toBe(1)
  expect(existsSync(other)).toBe(true)
})

test("runRm refuses a symlink inside the caller's own scratch folder that points out of it", async () => {
  const { deps, home } = machine()
  const scratch = join(home, ".playground", "scratch", "j6rjgy-worker")
  mkdirSync(join(home, ".ssh"), { recursive: true })
  mkdirSync(scratch, { recursive: true })
  symlinkSync(join(home, ".ssh"), join(scratch, "keys"))
  expect(await runRm([join(scratch, "keys")], deps)).toBe(1)
  expect(existsSync(join(scratch, "keys"))).toBe(true)
})

test("runRm tells the dispatcher of a protected path, and not of a missing one", async () => {
  const { deps, home, told } = machine()
  expect(await runRm([home], deps)).toBe(1)
  expect(told).toEqual([`j6rjgy-worker: ${home} is protected`])
  expect(await runRm([join(home, "gone")], deps)).toBe(1)
  expect(told.length).toBe(1)
  expect(await runRm(["a", "b"], deps)).toBe(2)
})

// A carve-out is its own script's alone: playground rm names none, so an entry in each carve-out's folder stays protected and nothing moves.
test.each(Object.entries(CARVE_OUTS))(
  "runRm takes no carve-out: an entry in %s's folder stays protected",
  async (_, carve) => {
    const { deps, told } = machine()
    const entry = join(deps.data, carve.folder, "entry")
    mkdirSync(entry, { recursive: true })
    expect(await runRm([entry], deps)).toBe(1)
    expect(existsSync(entry)).toBe(true)
    expect(told).toEqual([`j6rjgy-worker: ${entry} is inside the protected ${deps.data}`])
  },
)

test("runRm --worktree checks the holders, moves the worktree and prunes it from git", async () => {
  const { deps, main, root } = machine()
  git(root, "init", "--bare", "-q", join(root, "remote.git"))
  git(main, "init", "-q", "-b", "canary")
  writeFileSync(join(main, "README.md"), "x")
  git(main, "add", ".")
  git(main, "commit", "-qm", "init")
  git(main, "remote", "add", "origin", join(root, "remote.git"))
  git(main, "push", "-q", "origin", "canary")
  const wt = join(main, ".claude", "worktrees", "pg-1")
  git(main, "worktree", "add", "-q", "-b", "PG-1-thing", wt)
  git(wt, "push", "-q", "origin", "PG-1-thing")
  const held = { command: "zsh", cwd: wt, pid: 7, sockets: [] }
  expect(await runRm(["--worktree", wt], { ...deps, procs: () => [held] })).toBe(1)
  expect(existsSync(wt)).toBe(true)
  const url = "https://github.com/o/r/pull/1"
  const merging = { name: "abc123-worker", pr: url, status: "working" }
  writeFileSync(join(deps.data, "roster.json"), JSON.stringify({ agents: [merging] }))
  expect(await runRm(["--worktree", wt], deps)).toBe(1)
  expect(await runRm(["--worktree", wt, "--pr", `${url}0`], deps)).toBe(1)
  expect(existsSync(wt)).toBe(true)
  expect(await runRm(["--worktree", wt, "--pr", url], deps)).toBe(0)
  expect(existsSync(wt)).toBe(false)
  expect(git(main, "worktree", "list")).not.toContain("pg-1")
})

test("runRm --worktree refuses a worktree with uncommitted work, naming --discard, which a session passes only with an approved delete decision", async () => {
  const { deps, main, root } = machine()
  git(root, "init", "--bare", "-q", join(root, "remote.git"))
  git(main, "init", "-q", "-b", "canary")
  writeFileSync(join(main, "README.md"), "x")
  git(main, "add", ".")
  git(main, "commit", "-qm", "init")
  git(main, "remote", "add", "origin", join(root, "remote.git"))
  git(main, "push", "-q", "origin", "canary")
  const wt = join(main, ".claude", "worktrees", "pg-1")
  git(main, "worktree", "add", "-q", "-b", "PG-1-thing", wt)
  writeFileSync(join(wt, "wip.txt"), "x")
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--worktree", wt], deps)).toBe(1)
  } finally {
    console.error = error
  }
  expect(said).toEqual([
    `playground: ${wt} holds 1 uncommitted change (wip.txt): playground rm --worktree ${wt} --discard removes it anyway, which a session runs as it is once the worktree's PR has merged or closed, else with --decision <id> once an Inbox delete decision naming it is approved`,
  ])
  expect(existsSync(wt)).toBe(true)
  said.length = 0
  const session = { ...deps, caller: async () => "a session (role worker)" }
  console.error = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--worktree", wt, "--discard"], session)).toBe(1)
  } finally {
    console.error = error
  }
  expect(said).toEqual([
    `playground: a session (role worker) passes --discard only with --decision <id>: post an Inbox delete decision with bun run ask new naming ${wt} and why (bun run ask example delete prints one to start from), then run playground rm --worktree ${wt} --discard --decision <id> once it is approved`,
  ])
  expect(existsSync(wt)).toBe(true)
  const approved = async (id: string): Promise<Decision | null> =>
    id === "#i9"
      ? {
          kind: "decision",
          preview: { type: "delete", what: `the worktree ${wt}` },
          status: "approved",
        }
      : null
  expect(
    await runRm(["--worktree", wt, "--discard", "--decision", "#i9"], {
      ...session,
      decision: approved,
    }),
  ).toBe(0)
  expect(existsSync(wt)).toBe(false)
})

test("a session's --discard passes only on an approved delete decision whose what names the path", async () => {
  const wt = "/h/playground/.claude/worktrees/pg-1"
  const item = (
    status: string,
    what = `\`${wt}/\`, its work is stale`,
    type = "delete",
  ): Decision => ({
    kind: "decision",
    preview: { type, what },
    status,
  })
  const refusal = (found: Decision | null) =>
    discardRefusal(wt, "#i9", "a session (role worker)", {
      decision: async () => found,
      prState: async () => null,
    })
  const route = `post an Inbox delete decision with bun run ask new naming ${wt} and why (bun run ask example delete prints one to start from), then run playground rm --worktree ${wt} --discard --decision <id> once it is approved`
  expect(await refusal(item("approved"))).toBeNull()
  expect(await refusal(item("denied"))).toBe(`--decision #i9 is denied, not approved: ${route}`)
  expect(await refusal(item("open"))).toBe(`--decision #i9 is open, not approved: ${route}`)
  expect(await refusal(null)).toBe(
    `--decision #i9 names no Inbox item the Dashboard's checkout can read: ${route}`,
  )
  expect(await refusal(item("approved", `${wt}-old`))).toBe(
    `--decision #i9's delete names another path, not ${wt}: ${route}`,
  )
  expect(await refusal(item("approved", wt, "ask"))).toBe(
    `--decision #i9 is not a delete decision: ${route}`,
  )
  expect(
    await discardRefusal(wt, undefined, "a session (role worker)", {
      decision: async () => item("approved"),
      prState: async () => null,
    }),
  ).toBe(`a session (role worker) passes --discard only with --decision <id>: ${route}`)
})

// A mkdtemp Claude Code registry naming session s-1 for the claude process at pid 300, started with it as its CLAUDE_CONFIG_DIR, and a process chain 100 -> 200 -> 300 -> 1 to climb; pid 400 is gone.
const registry = (root: string) => {
  const config = join(root, "claude")
  mkdirSync(join(config, "sessions"), { recursive: true })
  writeFileSync(
    join(config, "sessions", "300.json"),
    JSON.stringify({ pid: 300, sessionId: "s-1" }),
  )
  const chain: Record<number, Proc> = {
    1: { comm: "/sbin/launchd", env: {}, ppid: 0 },
    100: { comm: "bun", env: {}, ppid: 200 },
    200: { comm: "/bin/zsh", env: {}, ppid: 300 },
    300: { comm: "/opt/bin/claude", env: { CLAUDE_CONFIG_DIR: config, HOME: root }, ppid: 1 },
  }
  return { config, procs: (pid: number): Proc | undefined => chain[pid] }
}

// A main checkout on canary with worktree pg-1 holding one uncommitted file, and the route a --discard refusal names for it.
const dirtyWorktree = (main: string) => {
  git(main, "init", "-q", "-b", "canary")
  writeFileSync(join(main, "README.md"), "x")
  git(main, "add", ".")
  git(main, "commit", "-qm", "init")
  const wt = join(main, ".claude", "worktrees", "pg-1")
  git(main, "worktree", "add", "-q", "-b", "PG-1-thing", wt)
  writeFileSync(join(wt, "wip.txt"), "x")
  const route = `post an Inbox delete decision with bun run ask new naming ${wt} and why (bun run ask example delete prints one to start from), then run playground rm --worktree ${wt} --discard --decision <id> once it is approved`
  return { route, wt }
}

// runRm's exit and what it printed to stderr.
const discardBy = async (wt: string, deps: RmDeps) => {
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    return { code: await runRm(["--worktree", wt, "--discard"], deps), said }
  } finally {
    console.error = error
  }
}

// A session's --discard with the worktree's PR state stubbed, and each (path, pr) it was asked for.
const statedSession = (deps: RmDeps, state: PrState | null) => {
  const asked: [string, string | undefined][] = []
  const session: RmDeps = {
    ...deps,
    caller: async () => "a session (role worker)",
    prState: async (path, pr) => (
      asked.push([path, pr]),
      state === null ? null : { head: git(path, "rev-parse", "HEAD"), number: 1, state }
    ),
  }
  return { asked, session }
}

// PG-1165: a merged or closed PR's worktree goes to the trash with no Inbox delete decision
test("a session's --discard passes with no --decision on a worktree whose PR merged or closed", async () => {
  for (const state of ["MERGED", "CLOSED"] as const) {
    const { deps, main } = machine()
    const { wt } = dirtyWorktree(main)
    const { asked, session } = statedSession(deps, state)
    expect(await discardBy(wt, session)).toEqual({ code: 0, said: [] })
    expect(existsSync(wt)).toBe(false)
    expect(asked).toEqual([[wt, undefined]])
  }
  const { deps, main } = machine()
  const { wt } = dirtyWorktree(main)
  const { asked, session } = statedSession(deps, "MERGED")
  const url = "https://github.com/o/r/pull/1"
  expect(await runRm(["--worktree", wt, "--discard", "--pr", url], session)).toBe(0)
  expect(asked).toEqual([[wt, url]])
})

test("a session's --discard on an OPEN PR's worktree, or one whose PR state reads as none (no PR, or GitHub unreadable), keeps today's route", async () => {
  for (const state of ["OPEN", null] as const) {
    const { deps, main } = machine()
    const { route, wt } = dirtyWorktree(main)
    const { asked, session } = statedSession(deps, state)
    expect(await discardBy(wt, session)).toEqual({
      code: 1,
      said: [
        `playground: a session (role worker) passes --discard only with --decision <id>: ${route}`,
      ],
    })
    expect(asked).toEqual([[wt, undefined]])
    expect(existsSync(wt)).toBe(true)
  }
})

// runRm's exit and each line it printed, with the worktree's PR stubbed as #<number> in that state at <head> (its own HEAD unless given; none for null), and a live roster row given
const heldRun = async (
  deps: RmDeps,
  words: string[],
  state: PrState | null,
  row: Record<string, string>,
  number = 1,
  head = git(words[1]!, "rev-parse", "HEAD"),
) => {
  writeFileSync(join(deps.data, "roster.json"), JSON.stringify({ agents: [row] }))
  const prState = async () => (state === null ? null : { head, number, state })
  const decision = async (): Promise<Decision> => ({
    kind: "decision",
    preview: { type: "delete", what: `the worktree ${words[1]}` },
    status: "approved",
  })
  const out: string[] = []
  const [error, log] = [console.error, console.log]
  console.error = (line: string) => void out.push(line)
  console.log = (line: string) => void out.push(line)
  try {
    const session = { ...deps, caller: async () => "a session (role worker)", decision, prState }
    return { code: await runRm(words, session), out }
  } finally {
    console.error = error
    console.log = log
  }
}

// PG-1419: a working row that kept a finished PR's branch no longer holds that PR's worktree
test("a worktree whose PR merged or closed passes a working roster row naming its branch, and says which PR freed it", async () => {
  for (const state of ["MERGED", "CLOSED"] as const) {
    const { deps, main } = machine()
    const { wt } = dirtyWorktree(main)
    const row = { branch: "PG-1-thing", name: "abc123-worker", status: "working" }
    const words = ["--worktree", wt, "--discard", "--decision", "#i9"]
    const { code, out } = await heldRun(deps, words, state, row, 7)
    expect({ code, said: out[0] }).toEqual({
      code: 0,
      said: `playground: ${wt} is freed by #7, which reads ${state}, past abc123-worker's roster row (working)`,
    })
    expect(existsSync(wt)).toBe(false)
  }
})

// PG-1419: the freed removal goes through the 7-day trash like any other, and --restore brings the worktree back, the work --discard let go with it
test("a freed worktree's removal is restorable: --restore brings it back on its branch, at its commit, listed, its discarded work back as untracked", async () => {
  const { deps, main } = machine()
  const { wt } = dirtyWorktree(main)
  const sha = git(wt, "rev-parse", "HEAD")
  const row = { branch: "PG-1-thing", name: "abc123-worker", status: "working" }
  const words = ["--worktree", wt, "--discard", "--decision", "#i9"]
  const { out } = await heldRun(deps, words, "MERGED", row, 7)
  const [batch] = readdirSync(join(deps.data, "trash"))
  const id = `${batch}/1`
  expect(out[1]).toContain(`playground rm --restore ${id} brings it back`)
  expect(await runRm(["--restore", id], deps)).toBe(0)
  expect(gitSees(main, wt)).toEqual({
    branch: "PG-1-thing",
    head: sha,
    listed: true,
    status: "?? wip.txt",
  })
})

// PG-1419: commits past the merged PR's head keep the row's hold, so --discard cannot take unmerged work, and the run names them
test("a worktree with a commit past its merged PR's head stays held by a working row naming its branch, its commit named", async () => {
  const { deps, main } = machine()
  const { wt } = dirtyWorktree(main)
  writeFileSync(join(wt, "more.txt"), "x")
  git(wt, "add", ".")
  git(wt, "commit", "-qm", "more")
  const past = git(wt, "rev-parse", "HEAD~1")
  const row = { branch: "PG-1-thing", name: "abc123-worker", status: "working" }
  const words = ["--worktree", wt, "--discard", "--decision", "#i9"]
  const { code, out } = await heldRun(deps, words, "MERGED", row, 7, past)
  expect({ code, said: out[0] }).toEqual({
    code: 1,
    said: `playground: ${wt} is held by abc123-worker, which the roster lists as working, and its commits past merged PR #7's head stay: ${git(wt, "rev-parse", "--short", "HEAD")}`,
  })
  expect(existsSync(wt)).toBe(true)
})

test("a working roster row naming the branch still holds a worktree whose PR is open or reads as none (no PR, or GitHub unreadable)", async () => {
  for (const state of ["OPEN", null] as const) {
    const { deps, main } = machine()
    const { wt } = dirtyWorktree(main)
    const row = { branch: "PG-1-thing", name: "abc123-worker", status: "working" }
    const words = ["--worktree", wt, "--discard", "--decision", "#i9"]
    expect(await heldRun(deps, words, state, row)).toEqual({
      code: 1,
      out: [`playground: ${wt} is held by abc123-worker, which the roster lists as working`],
    })
    expect(existsSync(wt)).toBe(true)
  }
})

test("a review clone at a merged PR's head stays held by a live row that names it by another PR, its next one, which is open", async () => {
  const { deps, main } = machine()
  dirtyWorktree(main)
  const clone = join(main, ".claude", "worktrees", "review-8")
  git(main, "worktree", "add", "-q", "--detach", clone)
  const row = { name: "abc123-reviewer", pr: "https://github.com/o/r/pull/8", status: "working" }
  const words = [
    "--worktree",
    clone,
    "--discard",
    "--decision",
    "#i9",
    "--pr",
    "https://github.com/o/r/pull/7",
  ]
  expect(await heldRun(deps, words, "MERGED", row, 7)).toEqual({
    code: 1,
    out: [`playground: ${clone} is held by abc123-reviewer, which the roster lists as working`],
  })
  expect(existsSync(clone)).toBe(true)
})

test("a worktree's PR state counts only when exactly one PR answers, as a branch used twice finds two, that PR is the worktree's own by branch or head, and its head is HEAD or an ancestor of it", () => {
  const holds = (sha: string) => sha === "head" || sha === "older"
  const at = { branch: "PG-1-thing", head: "head" }
  const pr = (headRefOid: string, state: PrState, headRefName = "PG-1-thing") => ({
    headRefName,
    headRefOid,
    number: 1,
    state,
  })
  expect(prStateOf([pr("head", "MERGED")], at, holds)).toEqual({
    head: "head",
    number: 1,
    state: "MERGED",
  })
  expect(prStateOf([pr("older", "CLOSED")], at, holds)).toEqual({
    head: "older",
    number: 1,
    state: "CLOSED",
  })
  expect(prStateOf([pr("other", "MERGED")], at, holds)).toBeNull()
  expect(prStateOf([pr("head", "MERGED"), pr("older", "OPEN")], at, holds)).toBeNull()
  expect(prStateOf([], at, holds)).toBeNull()
  expect(prStateOf(null, at, holds)).toBeNull()
  // a stacked child: its parent's PR is another branch's, whose head is only an ancestor of HEAD
  expect(prStateOf([pr("older", "MERGED", "PG-0-parent")], at, holds)).toBeNull()
  // a review clone on its own review-<n> branch, or detached, counts by the exact head alone
  expect(prStateOf([pr("head", "MERGED", "PG-0-parent")], at, holds)).toEqual({
    head: "head",
    number: 1,
    state: "MERGED",
  })
  const detached = { branch: null, head: "head" }
  expect(prStateOf([pr("head", "MERGED")], detached, holds)).toEqual({
    head: "head",
    number: 1,
    state: "MERGED",
  })
  expect(prStateOf([pr("older", "MERGED")], detached, holds)).toBeNull()
})

// PG-1066: a folder outside the worktrees folder takes plain playground rm, which no --discard gate guards
test("a session's --worktree --discard on a folder outside the worktrees folder is refused naming playground rm, not a decision route it cannot follow", async () => {
  const { deps, home } = machine()
  const outside = join(home, "scratch", "old-site")
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, "index.html"), "x")
  const session = { ...deps, caller: async () => "a session (role worker)" }
  const worktrees = join(deps.main, ".claude", "worktrees")
  for (const words of [
    ["--worktree", outside, "--discard"],
    ["--worktree", outside, "--discard", "--decision", "#i9"],
  ]) {
    const said: string[] = []
    const error = console.error
    console.error = (line: string) => void said.push(line)
    try {
      expect(await runRm(words, session)).toBe(1)
    } finally {
      console.error = error
    }
    expect(said).toEqual([
      `playground: --worktree takes a folder in ${worktrees}, not ${outside}: playground rm ${outside} moves a folder outside it to the trash, with no --worktree or --discard, up to 5,000 files or 2 GB; leave a bigger tree in place for your lead's cleanup`,
    ])
    expect(existsSync(outside)).toBe(true)
  }
  expect(await runRm([outside], session)).toBe(0)
  expect(existsSync(outside)).toBe(false)
})

// PG-825: a Bash prefix drops PLAYGROUND_ROLE, but not the claude process above the call
test("a caller with no role, or whose role a prefix dropped, is still a session when a claude process runs above it, and --discard needs its decision", async () => {
  const { deps, main, root } = machine()
  const { procs } = registry(root)
  expect(await callerOf({}, 100, procs)).toBe("a session (session s-1)")
  expect(await callerOf({ PLAYGROUND_ROLE: "" }, 100, procs)).toBe("a session (session s-1)")
  expect(await callerOf({ PLAYGROUND_ROLE: "worker" }, 100, procs)).toBe("a session (role worker)")
  const { route, wt } = dirtyWorktree(main)
  for (const environment of [{}, { PLAYGROUND_ROLE: "" }]) {
    const caller = () => callerOf(environment, 100, procs)
    expect(await discardBy(wt, { ...deps, caller })).toEqual({
      code: 1,
      said: [
        `playground: a session (session s-1) passes --discard only with --decision <id>: ${route}`,
      ],
    })
    expect(existsSync(wt)).toBe(true)
  }
})

// A session's call detached from it is adopted by pid 1 before rm reads its parent, so its climb would find no session
test("a detached call, or one whose parent the system cannot read, needs the decision too", async () => {
  const { deps, main, root } = machine()
  const { procs } = registry(root)
  expect(await callerOf({}, 1, procs)).toBe("a detached call (its parent is pid 1)")
  expect(await callerOf({}, 400, procs)).toBe(
    "a call whose parent the system cannot read (pid 400)",
  )
  const { route, wt } = dirtyWorktree(main)
  const caller = () => callerOf({}, 1, procs)
  expect(await discardBy(wt, { ...deps, caller })).toEqual({
    code: 1,
    said: [
      `playground: a detached call (its parent is pid 1) passes --discard only with --decision <id>: ${route}`,
    ],
  })
  expect(existsSync(wt)).toBe(true)
})

// PG-828 flipped the residual this pinned: the registry is found through the claude process's own environment, so a prefix that moves CLAUDE_CONFIG_DIR or HOME hides nothing
test("a caller whose prefix moved the registry still reads as the session above it, and a claude process the registry does not name, or whose environment reads back empty, is a session too", async () => {
  const { deps, main, root } = machine()
  const { procs } = registry(root)
  const moved = { CLAUDE_CONFIG_DIR: join(root, "elsewhere"), HOME: join(root, "elsewhere") }
  expect(await callerOf(moved, 100, procs)).toBe("a session (session s-1)")
  const unnamed = (pid: number): Proc | undefined =>
    pid === 300 ? { comm: "claude", env: { HOME: join(root, "elsewhere") }, ppid: 1 } : procs(pid)
  expect(await callerOf({}, 100, unnamed)).toBe("a session (claude pid 300)")
  const unread = (pid: number): Proc | undefined =>
    pid === 300 ? { comm: "claude", env: {}, ppid: 1 } : procs(pid)
  expect(await callerOf({}, 100, unread)).toBe("a session (claude pid 300)")
  const { route, wt } = dirtyWorktree(main)
  const caller = () => callerOf(moved, 100, procs)
  expect(await discardBy(wt, { ...deps, caller })).toEqual({
    code: 1,
    said: [
      `playground: a session (session s-1) passes --discard only with --decision <id>: ${route}`,
    ],
  })
  expect(existsSync(wt)).toBe(true)
})

// The owner's own terminal: no claude process anywhere up its chain, so --discard passes alone
test("a terminal no claude process runs above passes --discard without a decision", async () => {
  const { deps, main, root } = machine()
  const { procs } = registry(root)
  const terminal = (pid: number): Proc | undefined =>
    pid === 200 ? { comm: "/bin/zsh", env: {}, ppid: 1 } : procs(pid)
  expect(await callerOf({}, 100, terminal)).toBeUndefined()
  const { wt } = dirtyWorktree(main)
  const caller = () => callerOf({}, 100, terminal)
  expect(await discardBy(wt, { ...deps, caller })).toEqual({ code: 0, said: [] })
  expect(existsSync(wt)).toBe(false)
})

// run-slot's clone lane copies <source>/node_modules from its caller's folder, so only its holder record names the source (PG-699)
test("runRm --worktree refuses a worktree a running clone reads from, naming the clone, and moves it once the record is gone", async () => {
  const { deps, main, root } = machine()
  git(root, "init", "--bare", "-q", join(root, "remote.git"))
  git(main, "init", "-q", "-b", "canary")
  writeFileSync(join(main, "README.md"), "x")
  git(main, "add", ".")
  git(main, "commit", "-qm", "init")
  git(main, "remote", "add", "origin", join(root, "remote.git"))
  git(main, "push", "-q", "origin", "canary")
  const wt = join(main, ".claude", "worktrees", "pg-1")
  git(main, "worktree", "add", "-q", "-b", "PG-1-thing", wt)
  git(wt, "push", "-q", "origin", "PG-1-thing")
  const into = join(main, ".claude", "worktrees", "pg-2")
  const reading = { destination: into, pid: 4242, source: wt, who: "k3m9px-worker" }
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--worktree", wt], { ...deps, clones: () => [reading] })).toBe(1)
  } finally {
    console.error = error
  }
  expect(said).toEqual([
    `playground: ${wt} is held by k3m9px-worker's node_modules clone (pid 4242) from ${wt} into ${into}`,
  ])
  expect(existsSync(wt)).toBe(true)
  expect(await runRm(["--worktree", wt], deps)).toBe(0)
  expect(existsSync(wt)).toBe(false)
})

// A main checkout with a remote and a worktree on PG-1-thing holding one commit of its own, which the deps call merged, so rm --worktree moves it, after a step of the caller's own and with its extra words; and the trash id of the move.
const trashedWorktree = async (
  before = (_wt: string, _main: string) => {},
  words: string[] = [],
) => {
  const { deps, main, root } = machine()
  git(root, "init", "--bare", "-q", join(root, "remote.git"))
  git(main, "init", "-q", "-b", "canary")
  writeFileSync(join(main, "README.md"), "x")
  git(main, "add", ".")
  git(main, "commit", "-qm", "init")
  git(main, "remote", "add", "origin", join(root, "remote.git"))
  git(main, "push", "-q", "origin", "canary")
  const wt = join(main, ".claude", "worktrees", "pg-1")
  git(main, "worktree", "add", "-q", "-b", "PG-1-thing", wt)
  writeFileSync(join(wt, "work.txt"), "work")
  git(wt, "add", ".")
  git(wt, "commit", "-qm", "work")
  const sha = git(wt, "rev-parse", "HEAD")
  const merged = { ...deps, merged: () => true }
  before(wt, main)
  expect(await runRm(["--worktree", wt, ...words], merged)).toBe(0)
  expect(existsSync(wt)).toBe(false)
  const [batch] = readdirSync(join(deps.data, "trash"))
  return { deps: merged, id: `${batch}/1`, main, sha, wt }
}

// What git reads in a restored worktree: its status, its branch, its HEAD, and whether the main checkout lists it.
const gitSees = (main: string, wt: string) => ({
  branch: git(wt, "symbolic-ref", "--short", "HEAD"),
  head: git(wt, "log", "-1", "--format=%H"),
  listed: git(main, "worktree", "list", "--porcelain").includes(`worktree ${wt}\n`),
  status: git(wt, "status", "--porcelain"),
})

test("runRm --restore brings a worktree back as git reads it: on its branch, at the commit it held, listed", async () => {
  const { deps, id, main, sha, wt } = await trashedWorktree()
  expect(await runRm(["--restore", id], deps)).toBe(0)
  expect(gitSees(main, wt)).toEqual({ branch: "PG-1-thing", head: sha, listed: true, status: "" })
})

test("runRm --restore recreates the worktree's branch at the commit it held when the branch has gone", async () => {
  const { deps, id, main, sha, wt } = await trashedWorktree()
  git(main, "branch", "-D", "PG-1-thing")
  expect(await runRm(["--restore", id], deps)).toBe(0)
  expect(gitSees(main, wt)).toEqual({ branch: "PG-1-thing", head: sha, listed: true, status: "" })
  expect(git(main, "rev-parse", "PG-1-thing")).toBe(sha)
})

test("runRm --restore refuses a worktree whose branch and commit have both gone, naming the commit, and moves nothing", async () => {
  const { deps, id, main, sha, wt } = await trashedWorktree()
  git(main, "branch", "-D", "PG-1-thing")
  git(main, "reflog", "expire", "--expire=now", "--all")
  git(main, "gc", "-q", "--prune=now")
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--restore", id], deps)).toBe(1)
  } finally {
    console.error = error
  }
  expect(said).toHaveLength(1)
  expect(said[0]).toContain(sha)
  expect(said[0]).toContain(`git -C ${main} branch PG-1-thing ${sha}`)
  expect(existsSync(wt)).toBe(false)
  expect(readdirSync(join(deps.data, "trash", id))).toEqual(["pg-1"])
})

test("runRm --restore leaves a worktree's git record as it is when it is still there, so a staged change stays staged", async () => {
  let saved = ""
  const { deps, id, main, wt } = await trashedWorktree(
    (wt, main) => {
      writeFileSync(join(wt, "staged.txt"), "s")
      git(wt, "add", "staged.txt")
      saved = join(main, "..", "pg-1-record")
      cpSync(join(main, ".git", "worktrees", "pg-1"), saved, { recursive: true })
    },
    ["--discard"],
  )
  cpSync(saved, join(main, ".git", "worktrees", "pg-1"), { recursive: true })
  expect(await runRm(["--restore", id], deps)).toBe(0)
  expect(git(wt, "diff", "--cached", "--name-only")).toBe("staged.txt")
})

test("runRm --restore refuses a worktree whose branch now points at another commit, naming both, and moves nothing", async () => {
  const { deps, id, main, sha, wt } = await trashedWorktree()
  git(main, "branch", "-f", "PG-1-thing", "canary")
  const moved = git(main, "rev-parse", "canary")
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--restore", id], deps)).toBe(1)
  } finally {
    console.error = error
  }
  expect(said).toHaveLength(1)
  expect(said[0]).toContain(sha)
  expect(said[0]).toContain(moved)
  expect(said[0]).not.toContain("branch -f")
  expect(existsSync(wt)).toBe(false)
  expect(git(main, "rev-parse", "PG-1-thing")).toBe(moved)
})

test("runRm --restore brings a detached worktree back detached, at the commit it held", async () => {
  const { deps, id, main, sha, wt } = await trashedWorktree((wt) =>
    git(wt, "checkout", "-q", "--detach"),
  )
  expect(await runRm(["--restore", id], deps)).toBe(0)
  expect(readFileSync(join(main, ".git", "worktrees", "pg-1", "HEAD"), "utf8")).toBe(`${sha}\n`)
  expect(git(wt, "rev-parse", "HEAD")).toBe(sha)
  expect(git(wt, "status", "--porcelain")).toBe("")
  expect(git(main, "worktree", "list", "--porcelain")).toContain(`worktree ${wt}\n`)
})

test("runRm --restore refuses a detached worktree whose commit has gone, naming the commit and no branch", async () => {
  const { deps, id, main, sha, wt } = await trashedWorktree((wt) =>
    git(wt, "checkout", "-q", "--detach"),
  )
  git(main, "branch", "-D", "PG-1-thing")
  git(main, "reflog", "expire", "--expire=now", "--all")
  git(main, "gc", "-q", "--prune=now")
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--restore", id], deps)).toBe(1)
  } finally {
    console.error = error
  }
  expect(said).toHaveLength(1)
  expect(said[0]).toContain(sha)
  expect(said[0]).not.toContain("git -C")
  expect(existsSync(wt)).toBe(false)
})

test("runRm --restore exits 1 naming the step when git cannot recreate the branch after the move", async () => {
  const { deps, id, main, wt } = await trashedWorktree()
  git(main, "branch", "-D", "PG-1-thing")
  writeFileSync(join(main, ".git", "refs", "heads", "PG-1-thing.lock"), "")
  const said: string[] = []
  const error = console.error
  console.error = (line: string) => void said.push(line)
  try {
    expect(await runRm(["--restore", id], deps)).toBe(1)
  } finally {
    console.error = error
  }
  expect(said).toHaveLength(1)
  expect(said[0]).toStartWith(
    `playground: restored ${wt}, but git cannot read it yet: git branch PG-1-thing `,
  )
  expect(existsSync(wt)).toBe(true)
})

test("clonesOf reads run-slot's clone holder line while its pid lives, and a line with no source as none", () => {
  const line = "k3m9px-worker 4242 2026-11-03T05:21:53Z\t/a/src\t/a/dst\n"
  expect(clonesOf(line, () => true)).toEqual([
    { destination: "/a/dst", pid: 4242, source: "/a/src", who: "k3m9px-worker" },
  ])
  expect(clonesOf(line, () => false)).toEqual([])
  expect(clonesOf("k3m9px-worker 4242 2026-11-03T05:21:53Z\n", () => true)).toEqual([])
  expect(clonesOf("", () => true)).toEqual([])
})

test("rmDeps' notify queues a safe-delete line for the dispatcher through notify.sh", () => {
  const { root } = machine()
  const data = join(root, "data")
  const before = process.env.PLAYGROUND_DATA_DIR
  process.env.PLAYGROUND_DATA_DIR = data
  try {
    rmDeps(join(import.meta.dir, "..", "..", "..", "..", "..")).notify("s: /x is protected")
  } finally {
    if (before === undefined) delete process.env.PLAYGROUND_DATA_DIR
    else process.env.PLAYGROUND_DATA_DIR = before
  }
  const line = JSON.parse(
    readFileSync(join(data, "ops", "outbox", "ops-safe-delete.jsonl"), "utf8"),
  )
  expect(line).toMatchObject({ job: "safe-delete", text: "s: /x is protected" })
})

test("rmDeps' clones reads run-slot's clone holder line from the data folder's ops, and no line as no clone", () => {
  const { root } = machine()
  const data = join(root, "data")
  mkdirSync(join(data, "ops"), { recursive: true })
  const before = process.env.PLAYGROUND_DATA_DIR
  process.env.PLAYGROUND_DATA_DIR = data
  try {
    const deps = rmDeps(join(import.meta.dir, "..", "..", "..", "..", ".."))
    expect(deps.clones()).toEqual([])
    writeFileSync(
      join(data, "ops", "run-slot-clone.holder"),
      `k3m9px-worker ${process.pid} 2026-11-03T05:21:53Z\t/a/src\t/a/dst\n`,
    )
    expect(deps.clones()).toEqual([
      { destination: "/a/dst", pid: process.pid, source: "/a/src", who: "k3m9px-worker" },
    ])
  } finally {
    if (before === undefined) delete process.env.PLAYGROUND_DATA_DIR
    else process.env.PLAYGROUND_DATA_DIR = before
  }
})

test("processesOf joins lsof's working folders with ps's command lines and each process's sockets", () => {
  const cwds = "p41\nfcwd\nn/wt/api\np43\nfcwd\nn/wt\np50\nfcwd\n"
  const ps = "   41 bun run dev\n   43 /x/agent-browser-darwin-arm64\n   50 launchd\n"
  const sockets = "p43\nf6\nn->0xe55b\nf10\nn/h/.agent-browser/s1.sock\n"
  expect(processesOf(cwds, ps, sockets)).toEqual([
    { command: "bun run dev", cwd: "/wt/api", pid: 41, sockets: [] },
    {
      command: "/x/agent-browser-darwin-arm64",
      cwd: "/wt",
      pid: 43,
      sockets: ["/h/.agent-browser/s1.sock"],
    },
  ])
})
