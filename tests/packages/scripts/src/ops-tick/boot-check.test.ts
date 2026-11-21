import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GATE_WORKTREES } from "../../../../../packages/scripts/src/ops-tick/boot-check"
import { BEATS, bootCheck, type Context } from "../../../../../packages/scripts/src/ops-tick/tick"

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "boot-check-")))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const IDENT = {
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_AUTHOR_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
}

const git = (cwd: string, ...args: string[]): string => {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: { ...process.env, ...IDENT },
    stderr: "pipe",
  })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}

const commit = (cwd: string, name: string) => {
  writeFileSync(join(cwd, name), `${name}\n`)
  git(cwd, "add", name)
  git(cwd, "commit", "-q", "-m", name)
  return git(cwd, "rev-parse", "HEAD")
}

// A main checkout with a detached worktree under .claude/worktrees, two commits on it past the checkout's own.
const store = (tree: string) => {
  const root = mkdtempSync(join(scratch, "case-"))
  const repo = join(root, "repo")
  mkdirSync(repo)
  git(repo, "init", "-q")
  commit(repo, "one")
  const path = join(repo, ".claude", "worktrees", tree)
  git(repo, "worktree", "add", "-q", "--detach", path)
  const good = commit(path, "two")
  const head = commit(path, "three")
  const ops = join(root, "data", "ops")
  mkdirSync(ops, { recursive: true })
  writeFileSync(
    join(ops, "run-slot.sh"),
    '#!/bin/bash\nwhile [ "$1" != "--" ]; do shift; done\nshift\necho "run-slot.sh: stub holds run-slot" >&2\nexec "$@"\n',
  )
  chmodSync(join(ops, "run-slot.sh"), 0o755)
  return { data: join(root, "data"), good, head, ops, path, repo }
}

// A loose object cut short, as the power cut left one: an empty file, or its first bytes alone.
const tear = (repo: string, sha: string, keep = 0) => {
  const file = join(repo, ".git", "objects", sha.slice(0, 2), sha.slice(2))
  chmodSync(file, 0o644)
  writeFileSync(file, readFileSync(file).subarray(0, keep))
  return file
}

const kern = (ms: number) =>
  `{ sec = ${Math.floor(ms / 1000)}, usec = 0 } Tue Nov 17 10:01:45 2026\n`

// ctx.run on the real git and the stub run-slot, with sysctl answering the boot (and the wake when asked for it, as macOS does) and bun run ask recording each alert.
const context = (s: ReturnType<typeof store>, boot: number, now: Date, wake?: number) => {
  const runs: string[][] = []
  const asks: string[] = []
  const run: Context["run"] = async (argv, timeoutMs = 120_000, stdin) => {
    runs.push(argv)
    if (argv[0] === "sysctl")
      return {
        code: 0,
        out: kern(boot) + (wake && argv.includes("kern.waketime") ? kern(wake) : ""),
      }
    if (argv[0] === "bun" && argv.includes("ask")) {
      asks.push(stdin ?? "")
      return { code: 0, out: "0b6f1c62-6a9e-4bb4-9c1e-2b1b3a4f5d6e\n" }
    }
    const proc = Bun.spawn(argv, {
      env: { ...process.env, ...IDENT },
      stderr: "pipe",
      stdout: "pipe",
      timeout: timeoutMs,
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code: await proc.exited, out: out + err }
  }
  const ctx: Context = { now, ops: s.ops, repo: s.repo, run, send: async () => true }
  const told = () =>
    existsSync(join(s.ops, "outbox", "ops-stuck-alert.jsonl"))
      ? readFileSync(join(s.ops, "outbox", "ops-stuck-alert.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).text as string)
      : []
  const fscks = () => runs.filter((argv) => argv.includes("fsck")).length
  return { asks, ctx, fscks, told }
}

const lockAt = (data: string, pr: string, ms: number) => {
  const lock = join(data, "merge.lock")
  mkdirSync(lock)
  writeFileSync(join(lock, "pr"), `${pr}\n`)
  utimesSync(join(lock, "pr"), ms / 1000, ms / 1000)
  return lock
}

describe("boot-check", () => {
  const now = new Date()
  // sysctl names the boot to the second
  const boot = Math.floor((now.getTime() - 60_000) / 1000) * 1000

  test("runs every minute and names merge-types as the gate's worktree", () => {
    expect(BEATS.find((b) => b.name === "boot-check")?.cron).toBe("* * * * *")
    expect(GATE_WORKTREES).toEqual(["merge-types"])
  })

  test("a torn HEAD in merge-types, its last reflog line torn too, is re-pointed to the last good commit and its object moved aside", async () => {
    const s = store("merge-types")
    const file = tear(s.repo, s.head)
    const log = join(s.repo, ".git", "worktrees", "merge-types", "logs", "HEAD")
    const text = readFileSync(log, "utf8")
    writeFileSync(log, text.slice(0, text.length - 30))
    const c = context(s, boot, now)
    await bootCheck(s.data)(c.ctx)
    expect(git(s.path, "rev-parse", "HEAD")).toBe(s.good)
    expect(existsSync(file)).toBe(false)
    const aside = readdirSync(join(s.ops, "git-torn"))
    expect(aside).toEqual([expect.stringMatching(new RegExp(`^${s.head}-\\d+$`))])
    expect(readFileSync(join(s.ops, "git-torn", aside[0]!)).length).toBe(0)
    expect(git(s.repo, "fsck", "--no-dangling", "--no-progress")).toBe("")
    expect(c.told()).toEqual([expect.stringContaining(`repaired ${s.path}`)])
    expect(c.told()[0]).toContain(`HEAD re-pointed to ${s.good}`)
    expect(c.asks).toEqual([])
    expect(existsSync(join(s.data, "merge.lock"))).toBe(false)
    expect(readdirSync(join(s.data, "merge-locks"))).toEqual([
      expect.stringMatching(/^boot-check-\d+-/),
    ])
    expect(JSON.parse(readFileSync(join(s.ops, "tick", "boot-check.json"), "utf8")).boot).toBe(boot)
  })

  test("the reflog line a moved-aside object leaves keeps the next boot quiet, and the same boot runs no second fsck", async () => {
    const s = store("merge-types")
    tear(s.repo, s.head, 10)
    const first = context(s, boot, now)
    await bootCheck(s.data)(first.ctx)
    expect(git(s.path, "rev-parse", "HEAD")).toBe(s.good)
    expect(first.fscks()).toBe(2)
    const again = context(s, boot, now)
    await bootCheck(s.data)(again.ctx)
    expect(again.fscks()).toBe(0)
    const next = context(s, boot + 1000, now)
    await bootCheck(s.data)(next.ctx)
    expect(next.fscks()).toBe(1)
    expect(next.told()).toHaveLength(1)
    expect(next.asks).toEqual([])
  })

  test("a torn HEAD in any other worktree is told to Ops and alerted, and nothing changes", async () => {
    const s = store("PG-1-other")
    const file = tear(s.repo, s.head)
    const c = context(s, boot, now)
    await bootCheck(s.data)(c.ctx)
    expect(git(s.path, "rev-parse", "HEAD")).toBe(s.head)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(join(s.ops, "git-torn"))).toBe(false)
    expect(c.told()).toEqual([expect.stringContaining(`${file} is torn, named by ${s.path}`)])
    expect(c.asks).toHaveLength(1)
    expect(JSON.parse(c.asks[0]!).preview.text).toContain(file)
  })

  test("a clean store runs quietly", async () => {
    const s = store("merge-types")
    const c = context(s, boot, now)
    await bootCheck(s.data)(c.ctx)
    expect(c.fscks()).toBe(1)
    expect(c.told()).toEqual([])
    expect(c.asks).toEqual([])
  })

  test("a torn object only merge-types' reflog names is moved aside, and its HEAD stays", async () => {
    const s = store("merge-types")
    git(s.path, "checkout", "-q", "--detach", s.good)
    const file = tear(s.repo, s.head)
    const c = context(s, boot, now)
    await bootCheck(s.data)(c.ctx)
    expect(git(s.path, "rev-parse", "HEAD")).toBe(s.good)
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(join(s.ops, "git-torn"))).toEqual([
      expect.stringMatching(new RegExp(`^${s.head}-\\d+$`)),
    ])
    expect(c.told()).toEqual([expect.stringContaining("HEAD was another commit and stays")])
    expect(c.fscks()).toBe(2)
    expect(c.asks).toEqual([])
  })

  test("a wake is no boot: a merge lock taken before a sleep stays, and no fsck runs", async () => {
    const s = store("merge-types")
    const slept = now.getTime() - 2 * 60 * 60_000
    lockAt(s.data, "2610", now.getTime() - 30 * 60_000)
    const c = context(s, Math.floor(slept / 1000) * 1000, now, boot)
    await bootCheck(s.data)(c.ctx)
    expect(readFileSync(join(s.data, "merge.lock", "pr"), "utf8")).toBe("2610\n")
    expect(c.fscks()).toBe(0)
    expect(c.told()).toEqual([])
  })

  test("a check still unfinished when the boot window ends is one line to Ops, then quiet", async () => {
    const s = store("merge-types")
    tear(s.repo, s.head)
    lockAt(s.data, "2600", boot + 30_000)
    await bootCheck(s.data)(context(s, boot, now).ctx)
    const late = context(s, boot, new Date(boot + 11 * 60_000))
    await bootCheck(s.data)(late.ctx)
    expect(late.told()).toEqual([expect.stringContaining("did not finish inside its window")])
    expect(late.told()[0]).toContain("a live merge held the merge lock")
    expect(late.fscks()).toBe(0)
    expect(late.asks).toHaveLength(1)
    expect(JSON.parse(late.asks[0]!).preview.text).toContain("did not finish inside its window")
    await bootCheck(s.data)(late.ctx)
    expect(late.told()).toHaveLength(1)
    expect(late.asks).toHaveLength(1)
  })

  test("past the boot window it runs no fsck", async () => {
    const s = store("merge-types")
    tear(s.repo, s.head)
    const c = context(s, now.getTime() - 11 * 60_000, now)
    await bootCheck(s.data)(c.ctx)
    expect(c.fscks()).toBe(0)
    expect(git(s.path, "rev-parse", "HEAD")).toBe(s.head)
  })

  test("while a live merge holds the lock the repair waits for the next minute", async () => {
    const s = store("merge-types")
    tear(s.repo, s.head)
    const lock = lockAt(s.data, "2600", boot + 30_000)
    const c = context(s, boot, now)
    await bootCheck(s.data)(c.ctx)
    expect(git(s.path, "rev-parse", "HEAD")).toBe(s.head)
    expect(readFileSync(join(lock, "pr"), "utf8")).toBe("2600\n")
    expect(JSON.parse(readFileSync(join(s.ops, "tick", "boot-check.json"), "utf8")).boot).not.toBe(
      boot,
    )
    rmSync(lock, { recursive: true })
    await bootCheck(s.data)(c.ctx)
    expect(git(s.path, "rev-parse", "HEAD")).toBe(s.good)
  })

  test("a merge lock taken before the boot is moved into merge-locks tagged boot, and one taken after stays", async () => {
    const s = store("merge-types")
    lockAt(s.data, "2593", boot - 9 * 60_000)
    const c = context(s, boot, now)
    await bootCheck(s.data)(c.ctx)
    expect(existsSync(join(s.data, "merge.lock"))).toBe(false)
    const moved = readdirSync(join(s.data, "merge-locks"))
    expect(moved).toEqual([expect.stringMatching(/^2593-\d+-boot$/)])
    expect(readFileSync(join(s.data, "merge-locks", moved[0]!, "pr"), "utf8")).toBe("2593\n")
    expect(c.told()).toEqual([expect.stringContaining("the merge lock for 2593")])
    const t = store("merge-types")
    lockAt(t.data, "2607", boot + 30_000)
    const d = context(t, boot, now)
    await bootCheck(t.data)(d.ctx)
    expect(readFileSync(join(t.data, "merge.lock", "pr"), "utf8")).toBe("2607\n")
    expect(d.told()).toEqual([])
  })
})
