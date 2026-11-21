import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { dashboardCheckout } from "../../../../../packages/scripts/src/playground/probe"

// A user install's clone root, a git repo whose Dashboard's checkout is the worktree on live.branch, holding the .env, and a stand-in ask there that prints what it reached, so no database is touched.
const CLI = join(import.meta.dir, "../../../../../api/hono/src/bin/dashboard-ask.ts")
const URL = "postgresql://postgres:stub@127.0.0.1:1/dashboard"
const scratch = mkdtempSync(join(tmpdir(), "playground-ask-root-"))
const data = join(scratch, "data")
mkdirSync(data)
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(
    ["git", "-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd, stderr: "pipe", stdout: "pipe" },
  )
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
}

const clone = (name: string) => {
  const root = join(scratch, name)
  mkdirSync(root)
  git(root, "init", "-q", "-b", "canary")
  git(root, "commit", "-q", "--allow-empty", "-m", "init")
  return root
}

// The stand-in ask a checkout runs, and its .env (none when env is null).
const standIn = (path: string, env: string | null = `POSTGRES_URL=${URL}\n`) => {
  if (env !== null) writeFileSync(join(path, ".env"), env)
  writeFileSync(
    join(path, "package.json"),
    JSON.stringify({ scripts: { ask: `${process.execPath} reached.ts` } }),
  )
  writeFileSync(
    join(path, "reached.ts"),
    'console.log(`reached ${process.env.POSTGRES_URL} ${process.argv.slice(2).join(" ")}`)\nconsole.error(`at ${process.cwd()}`)\n',
  )
  return path
}

const checkout = (root: string, path: string, branch: string, env?: string | null) => {
  git(root, "worktree", "add", "-q", "-b", branch, path)
  return standIn(path, env)
}

// The live checkout sits outside .claude/worktrees/desk, where a fresh install would first cut it.
const live = clone("live")
checkout(live, join(scratch, "dashboard-elsewhere"), "live/dashboard")
const worker = join(live, ".claude", "worktrees", "worker")
git(live, "worktree", "add", "-q", "-b", "worker", worker)

// A desk folder on another branch, so no worktree is on live.branch.
const unset = clone("unset")
checkout(unset, join(unset, ".claude", "worktrees", "desk"), "not-live")

// A live worktree with no .env.
const bare = clone("bare")
checkout(bare, join(scratch, "dashboard-bare"), "live/dashboard", null)

// A clone root that is itself on live.branch, with a .env that sets no POSTGRES_URL.
const self = clone("self")
git(self, "checkout", "-q", "-b", "live/dashboard")
standIn(self, "PLAYGROUND_UNUSED=1\n")

// A data folder whose policy.json does not parse.
const broken = join(scratch, "broken")
mkdirSync(join(broken, "extensions"), { recursive: true })
writeFileSync(join(broken, "extensions", "policy.json"), "{")

const ask = (cwd: string, env: Record<string, string | undefined>, ...args: string[]) => {
  const { POSTGRES_URL: _, ...rest } = process.env
  return Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd,
    env: { ...rest, PLAYGROUND_DATA_DIR: data, SKIP_ENV_VALIDATION: "true", ...env },
    stderr: "pipe",
    stdout: "pipe",
  })
}

const stays = (run: ReturnType<typeof ask>) => {
  expect(run.stdout.toString()).not.toContain("reached")
  expect(run.stderr.toString()).toContain("usage: bun run ask")
  expect(run.exitCode).toBe(2)
}

test("from the clone root with no POSTGRES_URL, ask runs as the checkout on live.branch's, on its .env, wherever it sits", () => {
  const run = ask(live, {}, "get", "#i1")
  expect(run.stdout.toString()).toBe(`reached ${URL} get #i1\n`)
  expect(run.exitCode).toBe(0)
})

test("with validation on, the clone root still hands off before ask says there is no database yet (#2318)", () => {
  const run = ask(live, { SKIP_ENV_VALIDATION: "", SKIP_ENV_VALIDATION_SERVER: "" }, "get", "#i1")
  expect(run.stdout.toString()).toBe(`reached ${URL} get #i1\n`)
  expect(run.stderr.toString()).not.toContain("No database yet")
  expect(run.exitCode).toBe(0)
})

// ask-from-clone.ts scans git's worktrees itself, since the API's build would write .d.ts files into packages/scripts/src if it imported probe.ts, so the scan is held to dashboardCheckout() here.
test("hands off to the very checkout dashboardCheckout() finds, and to none where it finds none", () => {
  const saved = process.env.PLAYGROUND_DATA_DIR
  process.env.PLAYGROUND_DATA_DIR = data
  try {
    const found = dashboardCheckout(live)
    expect(found).not.toBeNull()
    expect(ask(live, {}).stderr.toString()).toContain(`at ${realpathSync(found!)}\n`)
    expect(dashboardCheckout(unset)).toBeNull()
    expect(ask(unset, {}).stdout.toString()).not.toContain("reached")
  } finally {
    if (saved === undefined) delete process.env.PLAYGROUND_DATA_DIR
    else process.env.PLAYGROUND_DATA_DIR = saved
  }
})

test("with no worktree on live.branch, ask stays in the clone root, a desk folder on another branch included", () => {
  stays(ask(unset, {}))
})

test("from a worktree other than the clone root, ask stays in it", () => {
  stays(ask(worker, {}))
})

test("a live worktree with no .env takes no hand-off", () => {
  stays(ask(bare, {}))
})

test("a clone root on live.branch itself takes no hand-off to itself", () => {
  stays(ask(self, {}))
})

test("a policy.json that does not parse means no hand-off, so ask's own guard refuses it", () => {
  const run = ask(live, { PLAYGROUND_DATA_DIR: broken })
  expect(run.stdout.toString()).not.toContain("reached")
  expect(run.stderr.toString()).toContain("policy.json does not parse")
  expect(run.stderr.toString()).toContain("live-dashboard.ts")
  expect(run.stderr.toString()).not.toContain("ask-from-clone.ts")
})

test("a POSTGRES_URL already set keeps ask in the checkout it runs from", () => {
  stays(ask(live, { POSTGRES_URL: "postgresql://postgres:own@127.0.0.1:2/own" }))
})
