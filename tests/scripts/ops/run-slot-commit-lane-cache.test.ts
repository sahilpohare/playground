import { describe, expect, setDefaultTimeout, test } from "bun:test"

import { log, repo, turbo } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang
setDefaultTimeout(60_000)

const commit = (root: string) => ["git", "-C", root, "commit", "-m", "x"]

// 5 Nov: a lone commit waited up to 4,054 s as a big run; under run-slot, commit-slot.ts runs the build bare inside the commit's own slot, so only a build turbo replays whole from its cache, which runs in seconds, leaves the queue
describe("a commit whose next build turbo replays from its cache", () => {
  test("takes run-slot-commit beside a big run", async () => {
    const m = repo({ idle: 30 }, ["web/next/src/app/page.tsx"])
    turbo(m, "HIT")
    m.hold("run-slot", 3, "big")
    expect(await m.start("worker-x", {}, undefined, commit(m.root)).ran()).toBe(true)
    expect(log(m)).toMatch(/ start worker-x \d+ run-slot-commit waited=/)
    expect(log(m)).toMatch(/ why worker-x \d+ build-tasks=0\n/)
  })

  // 5 Nov: its pre-commit tsc over packages/scripts then runs bare in the commit's slot, which ran at most 8 s in 32 runs (run-slot.runs.log, 5 Nov), as a bare commit's runs on run-slot-commit too
  test("staging a packages/scripts file takes run-slot-commit beside a big run, its type check with it", async () => {
    const m = repo({ idle: 30 }, ["packages/scripts/src/pr-merge/cli.ts"])
    turbo(m, "HIT")
    m.hold("run-slot", 3, "big")
    expect(await m.start("worker-x", {}, undefined, commit(m.root)).ran()).toBe(true)
    expect(log(m)).toMatch(/ start worker-x \d+ run-slot-commit waited=/)
  })
})

// 17 Nov: each commit build that waited 17 to 27 minutes held 3 to 9 tasks to run, web/next's among them, and ran 8 to 23 s, and 3 whole rebuilds of 11 tasks ran 13 to 19 s
describe("a commit whose build holds tasks to run", () => {
  for (const [what, staged, count, hits] of [
    ["a packages-only build", "packages/safe-delete/src/index.ts", 2, 1],
    ["a build with web/next's", "web/next/src/app/page.tsx", 3, 1],
    ["a whole rebuild, every task to run", "package.json", 11, 0],
  ] as const)
    test(`takes run-slot-commit beside a big run for ${what}, its count in the runs log`, async () => {
      const m = repo({ idle: 30 }, [staged])
      turbo(m, "MISS", count, hits)
      m.hold("run-slot", 3, "big")
      expect(await m.start("worker-x", {}, undefined, commit(m.root)).ran()).toBe(true)
      expect(log(m)).toMatch(/ start worker-x \d+ run-slot-commit waited=/)
      expect(log(m)).toMatch(new RegExp(` why worker-x \\d+ build-tasks=${count}\\n`))
    })

  for (const [what, status, count, tasks] of [
    ["a dry run that fails", null, 1, "unread"],
    ["a dry run that cannot be read", "unreadable", 1, "unread"],
    ["a dry run past 10 s", "slow", 1, "unread"],
  ] as const)
    test(`but with ${what} still waits as a big run`, async () => {
      const m = repo({ idle: 30 }, ["packages/config/src/org.ts"])
      turbo(m, status, count)
      m.hold("run-slot", 3, "big")
      expect(await m.start("worker-x", {}, undefined, commit(m.root)).waits()).toBe(true)
      expect(log(m)).not.toContain("run-slot-commit")
      expect(log(m)).toMatch(new RegExp(` why worker-x \\d+ build-tasks=${tasks}\\n`))
    })
})
