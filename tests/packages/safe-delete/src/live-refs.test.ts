import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { heldBy, withLiveBudget } from "../../../../packages/safe-delete/src/live-refs"

const git = (cwd: string, ...args: string[]) => {
  const proc = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}

// a repo with a fast remote, a local bare repo holding its commit, and three hung ones: ssh remotes whose ssh, the repo's core.sshCommand, logs its arguments as it starts, then sleeps past every budget
describe("a hook call's live reads share one budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-refs-"))
  const repo = join(dir, "repo")
  const HUNG = ["h1", "h2", "h3"]
  const log = join(dir, "ssh.log")
  let sha = ""

  beforeAll(() => {
    git(dir, "init", "-q", "--bare", "-b", "main", "fast.git")
    git(dir, "init", "-q", "-b", "main", "repo")
    git(repo, "commit", "-q", "--allow-empty", "-m", "base")
    sha = git(repo, "rev-parse", "HEAD")
    git(repo, "remote", "add", "fast", join(dir, "fast.git"))
    git(repo, "push", "-q", "fast", "main")
    const ssh = join(dir, "hung-ssh")
    writeFileSync(ssh, `#!/bin/sh\necho "$*" >> '${log}'\nexec sleep 8\n`)
    chmodSync(ssh, 0o755)
    writeFileSync(log, "")
    git(repo, "config", "core.sshCommand", ssh)
    // a set variant skips git's ssh -G probe, so each read starts the fake once, naming its remote's path
    git(repo, "config", "ssh.variant", "ssh")
    // the test sandbox's git refuses ssh, so the repo allows it for this fake alone
    git(repo, "config", "protocol.ssh.allow", "always")
    for (const name of HUNG)
      git(repo, "remote", "add", name, `ssh://git@example.invalid/${name}.git`)
  })

  afterAll(() => rmSync(dir, { force: true, recursive: true }))

  // the first read spends the budget, so the other two start no read and each scan reads every commit
  test("three scans on hung remotes end within the budget, each scanning every commit", () => {
    const held = withLiveBudget(() => HUNG.map((remote) => heldBy(repo, remote)), 1_500)
    expect(held).toEqual([[], [], []])
    const started = readFileSync(log, "utf8")
    expect(started).toContain("/h1.git")
    expect(started).not.toContain("/h2.git")
    expect(started).not.toContain("/h3.git")
  }, 12_000)

  test("a scan on a fast remote under the budget keeps its live read", () => {
    expect(withLiveBudget(() => heldBy(repo, "fast"), 1_500)).toEqual([sha])
  })

  test("a remote read once in a call is read from that read after", () => {
    const [first, again] = withLiveBudget(() => {
      const before = heldBy(repo, "fast")
      git(join(dir, "fast.git"), "update-ref", "-d", "refs/heads/main")
      return [before, heldBy(repo, "fast")]
    }, 1_500)
    expect(first).toEqual([sha])
    expect(again).toEqual([sha])
    expect(heldBy(repo, "fast")).toEqual([])
  })
})
