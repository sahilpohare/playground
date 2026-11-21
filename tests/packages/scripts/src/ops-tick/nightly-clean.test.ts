import { afterAll, describe, expect, test } from "bun:test"
import {
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
import { basename, dirname, join } from "node:path"

import { makeScratch, restore } from "../../../../../packages/safe-delete/src"
import {
  bytesOf,
  discardable,
  isCopy,
  issueOf,
  nightlyClean,
  type NightDeps,
  type Pr,
  type Prs,
  pruneRehearsals,
  pruneTurbo,
  readPrs,
  rootsOf,
  staleBranches,
  staleContainers,
  staleVolumes,
  staleWorktrees,
  tempFolders,
  trashIdOf,
  trashSince,
  workIn,
  worktreesIn,
} from "../../../../../packages/scripts/src/ops-tick/nightly-clean"
import { CWDS } from "../../../../../packages/scripts/src/ops-tick/orphans"
import { BEATS, type Context } from "../../../../../packages/scripts/src/ops-tick/tick"
import { cardOf } from "../../../../../packages/scripts/src/ops-tick/unused-card"
import type { CleanupDeps } from "../../../../../scripts/ops/optimizer/auto_end"
import { type Answers, fakeRun, ghErrors } from "./fake-run"

const CARD = "11111111-2222-3333-4444-555555555555"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})
const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nightly-clean-")))
  dirs.push(root)
  return root
}

const pr = (state: Pr["state"], headRefOid = "h1", n = 1): Pr => ({
  headRefOid,
  state,
  url: `https://github.com/acme/app/pull/${n}`,
})
const prsOf = (byBranch: Record<string, Pr>, byNumber: Record<number, Pr> = {}): Prs => ({
  byBranch: new Map(Object.entries(byBranch)),
  byNumber: new Map(Object.entries(byNumber).map(([n, p]) => [Number(n), p])),
})
const live = (c: string) => c === "playground-dashboard-db" || c === "playground-dashboard-db-sY08"

test("the beat runs nightly at 3:00 am machine time, and the weekly turbo prune is gone", () => {
  expect(BEATS.find((b) => b.name === "nightly-clean")?.cron).toBe("0 3 * * *")
  expect(BEATS.find((b) => b.name === "turbo-prune")).toBeUndefined()
})

test("docker's sizes read as bytes, the first figure alone", () => {
  expect(bytesOf("63B (virtual 300MB)")).toBe(63)
  expect(bytesOf("1.5GB")).toBe(1.5e9)
  expect(bytesOf("512kB")).toBe(512e3)
  expect(bytesOf("N/A")).toBe(0)
})

describe("worktrees", () => {
  const main = "/m"
  const at = (name: string) => `/m/.claude/worktrees/${name}`
  const porcelain = [
    "worktree /m\nHEAD a\nbranch refs/heads/main",
    `worktree ${at("pg-1")}\nHEAD b\nbranch refs/heads/PG-1-merged`,
    `worktree ${at("pg-2")}\nHEAD c\nbranch refs/heads/PG-2-open`,
    `worktree ${at("pg-3")}\nHEAD d\nbranch refs/heads/PG-3-nopr`,
    `worktree ${at("review-12")}\nHEAD e\ndetached`,
    `worktree ${at("review-13")}\nHEAD f\ndetached`,
    "worktree /elsewhere/x\nHEAD g\nbranch refs/heads/PG-1-merged",
  ].join("\n\n")

  test("only those directly in .claude/worktrees are read, each with its branch or none", () => {
    expect(worktreesIn(porcelain, main).map((w) => [w.path, w.branch])).toEqual([
      [at("pg-1"), "PG-1-merged"],
      [at("pg-2"), "PG-2-open"],
      [at("pg-3"), "PG-3-nopr"],
      [at("review-12"), null],
      [at("review-13"), null],
    ])
  })

  test("a worktree whose PR merged or closed is stale, by its branch or a review clone's number; an open PR's or one with none stays", () => {
    const prs = prsOf(
      { "PG-1-merged": pr("MERGED"), "PG-2-open": pr("OPEN") },
      { 12: pr("CLOSED"), 13: pr("OPEN") },
    )
    expect(staleWorktrees(worktreesIn(porcelain, main), prs).map((w) => w.path)).toEqual([
      at("pg-1"),
      at("review-12"),
    ])
  })

  // A reviewer reuses a free review clone by moving it to review-<n> before it checks out PR n, since a detached clone's PR is read from its folder's name alone.
  test("a reused clone moved to review-<n> stays while PR n is open, and goes once PR n merges", () => {
    const moved = worktreesIn(`worktree ${at("review-20")}\nHEAD h\ndetached`, main)
    expect(staleWorktrees(moved, prsOf({}, { 19: pr("MERGED"), 20: pr("OPEN") }))).toEqual([])
    expect(
      staleWorktrees(moved, prsOf({}, { 19: pr("MERGED"), 20: pr("MERGED") })).map((w) => w.path),
    ).toEqual([at("review-20")])
  })

  test("a reused clone left at its old, merged number goes, though it serves an open PR", () => {
    const unmoved = worktreesIn(`worktree ${at("review-19")}\nHEAD h\ndetached`, main)
    expect(
      staleWorktrees(unmoved, prsOf({}, { 19: pr("MERGED"), 20: pr("OPEN") })).map((w) => w.path),
    ).toEqual([at("review-19")])
  })

  // PG-2144: a tester's before clone sits detached at canary, so its PR is read from its folder's name too
  test("a tester's test-<n>-before clone goes once PR n merges, and stays while PR n is open", () => {
    const clones = worktreesIn(
      [
        `worktree ${at("test-21")}\nHEAD i\ndetached`,
        `worktree ${at("test-21-before")}\nHEAD j\ndetached`,
      ].join("\n\n"),
      main,
    )
    expect(staleWorktrees(clones, prsOf({}, { 21: pr("MERGED") })).map((w) => w.path)).toEqual([
      at("test-21"),
      at("test-21-before"),
    ])
    expect(staleWorktrees(clones, prsOf({}, { 21: pr("OPEN") }))).toEqual([])
  })

  test("a kept line is trashed under the standing approval only for work it may drop", () => {
    expect(discardable("kept /w: uncommitted work")).toBe(true)
    expect(discardable("kept /w: unpushed commits")).toBe(true)
    expect(discardable("kept /w: could not count its unpushed commits")).toBe(false)
    expect(
      discardable(
        "kept /w: /w's HEAD holds work not landed on origin/canary or on any remote branch (fetch origin if it merged or was pushed since): playground rm --worktree /w --discard removes it anyway, its commits no remote holds kept first in a git bundle beside it in the trash",
      ),
    ).toBe(true)
    expect(
      discardable("kept /w: /w is held by abc123-worker, which the roster lists as working"),
    ).toBe(false)
    expect(discardable("kept /w: the live dashboard's checkout")).toBe(false)
  })
})

test("branches: merged ones and a done PR's still at its head go, the rest are archived or kept", () => {
  const plan = staleBranches({
    checkedOut: new Set(["PG-6-out"]),
    keep: new Set(["canary", "main", "live/dashboard"]),
    local: [
      { name: "canary", sha: "c" },
      { name: "live/dashboard", sha: "l" },
      { name: "PG-1-merged", sha: "a" },
      { name: "PG-2-squashed", sha: "h2" },
      { name: "PG-3-ahead", sha: "x" },
      { name: "PG-4-open", sha: "o" },
      { name: "scratch", sha: "s" },
      { name: "PG-6-out", sha: "z" },
    ],
    merged: new Set(["canary", "PG-1-merged"]),
    prs: new Map([
      ["PG-2-squashed", pr("MERGED", "h2")],
      ["PG-3-ahead", pr("CLOSED", "h3")],
      ["PG-4-open", pr("OPEN", "o")],
      ["PG-7-remote", pr("MERGED", "r7")],
      ["PG-8-moved", pr("MERGED", "r8")],
    ]),
    remote: [
      { name: "canary", sha: "c" },
      { name: "PG-7-remote", sha: "r7" },
      { name: "PG-8-moved", sha: "other" },
      { name: "no-pr", sha: "n" },
    ],
  })
  expect(plan).toEqual({
    archive: ["PG-3-ahead", "scratch"],
    bundle: [],
    local: ["PG-1-merged", "PG-2-squashed"],
    remote: ["PG-7-remote"],
  })
})

// #i446's 33 branches as the card of 6 Nov listed them: each name, its newest subject, and the branch whose head it shares (rule 4); the issues they name and their PRs as GitHub read them.
const I446: { name: string; same?: string; subject: string }[] = [
  { name: "PG-448-glob-rule-1", subject: "fix(PG-448): no-extensions-write reads a glob rule" },
  { name: "PG-461-sed-reader", subject: "fix(PG-461): a read-only sed with a glob passes" },
  { name: "PG-539-cwd-history", subject: "fix(PG-539): run-slot reads a --cwd path once" },
  {
    name: "PG-652-sudo-abbrev",
    subject: "fix(PG-652): the shell reader reads sudo's abbreviations",
  },
  { name: "PG-664-d3-on-reads", subject: "refactor(PG-664): the dashboard reads herdr alone" },
  { name: "PG-665-delete-cmux", subject: "refactor(PG-665): delete the cmux code" },
  { name: "PG-780-after", subject: "fix(PG-780): the after shots" },
  { name: "PG-892-yard-hour-cap", subject: "test(PG-892): the hour's cap test" },
  { name: "pr-104", subject: "fix: pr 104's head" },
  { name: "pr-116", subject: "fix: pr 116's head" },
  { name: "k4vt2m-t104", same: "pr-104", subject: "" },
  { name: "k4vt2m-t116", same: "pr-116", subject: "" },
  { name: "pg435-backup", subject: "wip: 435 backup" },
  { name: "pg435-backup2", subject: "wip: 435 backup 2" },
  { name: "pg452-backup-54f56539", subject: "wip: 452 backup a" },
  { name: "pg452-backup-8dcdc866", subject: "wip: 452 backup b" },
  { name: "pg452-backup-e21fbd40", subject: "wip: 452 backup c" },
  { name: "pg501-backup-131a43c3", subject: "wip: 501 backup a" },
  { name: "pg501-backup-e4e2c606", subject: "wip: 501 backup b" },
  { name: "pg505-backup-041b3a84", subject: "wip: 505 backup a" },
  { name: "pg505-backup-d41179c2", subject: "wip: 505 backup b" },
  { name: "qz282w-after", subject: "fix: after shots" },
  { name: "review-358", subject: "fix: review of 358" },
  { name: "review-798", subject: "fix: review of 798" },
  { name: "test-54", subject: "test: 54" },
  { name: "test-64", subject: "test: 64" },
  { name: "test-65", subject: "test: 65" },
  { name: "test-79", subject: "test: 79" },
  { name: "trial-411f", subject: "trial: 411f" },
  { name: "trial-quiet-commit", subject: "trial: a quiet commit" },
  { name: "wip-501-own", subject: "wip: 501 own" },
  { name: "xf45ns-test-886", subject: "test: 886" },
  {
    name: "PG-493-spec-inline",
    subject: "fix(PG-493): code-review reads a spec by scratchpad path",
  },
]
const I446_ISSUES = new Map<number, "CLOSED" | "OPEN">([
  ...[448, 461, 539, 652, 664, 665, 892].map((n) => [n, "CLOSED"] as const),
  [493, "OPEN"],
  [780, "OPEN"],
])
const I446_PRS = {
  "PG-652-sudo-abbrev": pr("MERGED", "squashed-681", 681),
  "PG-665-delete-cmux": pr("MERGED", "squashed-1096", 1096),
}

// #1332
test("a branch name marks a copy by a backup, trial, wip or test word, a review- or pr-<n> start, or an -after or -before end", () => {
  for (const b of I446.filter((b) => !b.same && !/^PG-\d+-(?!after$)/.test(b.name)))
    expect([b.name, isCopy(b.name)]).toEqual([b.name, true])
  for (const name of ["PG-1-x-before", "PG-2-wip", "PG-3-test"]) expect(isCopy(name)).toBe(true)
  for (const name of [
    "PG-493-spec-inline",
    "PG-448-glob-rule-1",
    "k4vt2m-t104",
    "PG-1200-latest-fix",
    "PG-12-tests-flake",
    "preview-1",
    "scratch",
  ])
    expect([name, isCopy(name)]).toEqual([name, false])
})

test("a branch's issue is the PG-<n> its name leads with, else its newest subject's scope", () => {
  expect(issueOf({ name: "PG-493-spec-inline", sha: "s" })).toBe(493)
  expect(issueOf({ name: "pg-12", sha: "s" })).toBe(12)
  expect(issueOf({ name: "k9-fix", sha: "s", subject: "fix(PG-51): a thing" })).toBe(51)
  expect(issueOf({ name: "k9-fix", sha: "s", subject: "feat!(PG-52): a thing" })).toBe(52)
  expect(issueOf({ name: "pg435-backup", sha: "s", subject: "wip: 435 backup" })).toBeUndefined()
  expect(issueOf({ name: "scratch", sha: "s", subject: "see PG-9" })).toBeUndefined()
})

// #1332: #i446's 33 branches, of which the owner's rules judge 32 not useful and keep one
test("branches: #i446's 33 go to the bundle list but PG-493-spec-inline, whose issue is open and which is no copy, and none to the archive list", () => {
  const plan = staleBranches({
    checkedOut: new Set(),
    issues: I446_ISSUES,
    keep: new Set(["canary", "main"]),
    local: I446.map((b) => ({ name: b.name, sha: `s-${b.same ?? b.name}`, subject: b.subject })),
    merged: new Set(),
    prs: new Map(Object.entries(I446_PRS)),
    remote: [],
  })
  expect(plan.bundle).toHaveLength(32)
  expect(plan.bundle).not.toContain("PG-493-spec-inline")
  expect(plan.bundle).toContain("k4vt2m-t104")
  expect(plan.archive).toEqual([])
  expect(plan.local).toEqual([])
})

test("branches: a superseded subject, a closed issue a subject names, and a merged branch's head each mark one not useful; an open issue keeps one, and one no rule judges is archived", () => {
  const plan = staleBranches({
    checkedOut: new Set(),
    issues: new Map([
      [51, "CLOSED"],
      [53, "OPEN"],
    ]),
    keep: new Set(["canary"]),
    local: [
      { name: "PG-50-old", sha: "a", subject: "chore(PG-50): superseded by #60" },
      { name: "k9-fix", sha: "b", subject: "fix(PG-51): a thing" },
      { name: "PG-52-done", sha: "c" },
      { name: "copy-of-52", sha: "c" },
      { name: "PG-53-live", sha: "d", subject: "fix(PG-53): live work" },
      { name: "PG-54-unread", sha: "e" },
      { name: "scratch", sha: "f" },
    ],
    merged: new Set(["PG-52-done"]),
    prs: new Map(),
    remote: [],
  })
  expect(plan).toEqual({
    archive: ["PG-54-unread", "scratch"],
    bundle: ["PG-50-old", "k9-fix", "copy-of-52"],
    local: ["PG-52-done"],
    remote: [],
  })
})

test("branches: a branch whose issue is open and which is no copy stays, though its subject says superseded or its head is a merged branch's; a copy of it still goes", () => {
  const plan = staleBranches({
    checkedOut: new Set(),
    issues: new Map([[70, "OPEN"]]),
    keep: new Set(["canary"]),
    local: [
      { name: "PG-70-old", sha: "a", subject: "chore(PG-70): superseded by #71" },
      { name: "PG-70-done", sha: "b" },
      { name: "PG-70-same", sha: "b" },
      { name: "PG-70-backup", sha: "c" },
    ],
    merged: new Set(["PG-70-done"]),
    prs: new Map(),
    remote: [],
  })
  expect(plan).toEqual({ archive: [], bundle: ["PG-70-backup"], local: ["PG-70-done"], remote: [] })
})

test("containers: an exited worktree container whose folder is gone goes; the live dashboard's, first run's, a Vibeground copy, a running one and one whose folder stands stay", () => {
  const small = 100
  const plan = staleContainers(
    [
      { name: "playground-pg-9-db", size: small, state: "exited" },
      { name: "playground-pg-9-redis", size: small, state: "exited" },
      { name: "playground-pg-1-db", size: small, state: "exited" },
      { name: "playground-pg-5-db", size: small, state: "running" },
      { name: "playground-dashboard-db", size: small, state: "exited" },
      { name: "playground-dashboard-db-sY08", size: small, state: "exited" },
      { name: "playground-vibe-pg-9-ab12cd34-db", size: small, state: "exited" },
      { name: "playground-db", size: small, state: "exited" },
      { name: "someone-else", size: 2e9, state: "exited" },
      { name: "playground-dashboard-db-big", size: 2e9, state: "running" },
    ],
    ["PG-1", "pg-5"],
    live,
  )
  expect(plan).toEqual({
    keep: ["someone-else", "playground-dashboard-db-big"],
    remove: ["playground-pg-9-db", "playground-pg-9-redis"],
  })
})

test("volumes no container uses that hold over 1 GB are named as kept, and an unreadable df names none", () => {
  const df = JSON.stringify({
    Volumes: [
      { Links: "0", Name: "big-unused", Size: "2.5GB" },
      { Links: "1", Name: "big-used", Size: "9GB" },
      { Links: "0", Name: "small", Size: "20MB" },
    ],
  })
  expect(staleVolumes(df)).toEqual(["big-unused"])
  expect(staleVolumes("not json")).toEqual([])
})

test("gh's PR answer reads from its stdout alone, a number that is no PR skipped and its errors and stderr line no bar", async () => {
  const prs = prsOf({})
  const { out } = await fakeRun({
    graphql: ghErrors(
      {
        b0: {
          nodes: [{ headRefOid: "h1", state: "MERGED", url: "https://github.com/acme/app/pull/7" }],
        },
        b1: { nodes: [] },
        n0: null,
        n1: { headRefOid: "h2", state: "CLOSED", url: "https://github.com/acme/app/pull/12" },
      },
      ["Could not resolve to a PullRequest with the number of 939."],
    ),
  }).run(["gh", "api", "graphql", "-f", "query=..."])
  expect(readPrs(out, ["PG-1-a", "no-pr"], [939, 12], prs)).toBe(true)
  expect([...prs.byBranch]).toEqual([
    ["PG-1-a", { headRefOid: "h1", state: "MERGED", url: "https://github.com/acme/app/pull/7" }],
  ])
  expect([...prs.byNumber]).toEqual([
    [12, { headRefOid: "h2", state: "CLOSED", url: "https://github.com/acme/app/pull/12" }],
  ])
  expect(readPrs("gh: HTTP 502", [], [], prsOf({}))).toBe(false)
})

test("gh's answer reads each issue's state by its i<n> alias, a number that is no issue skipped", async () => {
  const prs = prsOf({})
  const { out } = await fakeRun({
    graphql: ghErrors({ i0: { state: "CLOSED" }, i1: null, i2: { state: "OPEN" } }, [
      "Could not resolve to an Issue with the number of 681.",
    ]),
  }).run(["gh", "api", "graphql", "-f", "query=..."])
  expect(readPrs(out, [], [], prs, [652, 681, 493])).toBe(true)
  expect([...(prs.byIssue ?? [])]).toEqual([
    [652, "CLOSED"],
    [493, "OPEN"],
  ])
})

test("the trash count adds each purge line's batches after the last run", () => {
  const log = [
    "2026-11-03T10:17:00Z removed 4 (a, b, c, d)",
    "2026-11-04T10:17:00Z removed 2 (e, f)",
    "2026-11-04T11:17:00Z removed 0",
  ].join("\n")
  expect(trashSince(log, Date.parse("2026-11-04T00:00:00Z"))).toBe(2)
  expect(trashSince("", 0)).toBe(0)
})

test("the trash id reads from playground rm's own line alone, and it is the one --restore takes", () => {
  const out =
    "Moved to the trash as 20261108T030000Z-shell/1 (3 files); playground rm --restore 20261108T030000Z-shell/1 brings it back"
  expect(trashIdOf(out)).toBe("20261108T030000Z-shell/1")
  expect(trashIdOf("kept /w: held by a session")).toBeUndefined()
  expect(trashIdOf("11111111-2222-3333-4444-555555555555")).toBeUndefined()
})

describe("the turbo cache", () => {
  test("a 3-day-old entry goes, a 1-day-old entry and a folder stay", async () => {
    const cache = join(scratch(), "turbo")
    mkdirSync(join(cache, "sub"), { recursive: true })
    const now = new Date("2026-11-05T03:00:00Z")
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000)
    writeFileSync(join(cache, "old.tar.zst"), "x".repeat(3 * 1_048_576))
    utimesSync(join(cache, "old.tar.zst"), days(3), days(3))
    writeFileSync(join(cache, "new.tar.zst"), "y")
    utimesSync(join(cache, "new.tar.zst"), days(1), days(1))
    writeFileSync(join(cache, "sub", "inner"), "z")
    utimesSync(join(cache, "sub", "inner"), days(30), days(30))
    expect(await pruneTurbo(cache, now)).toBe("removed 1, kept 1, freed 3 MB")
    expect(existsSync(join(cache, "old.tar.zst"))).toBe(false)
    expect(existsSync(join(cache, "new.tar.zst"))).toBe(true)
    expect(existsSync(join(cache, "sub", "inner"))).toBe(true)
  })

  test("a missing folder and one it cannot read are named, and nothing throws", async () => {
    const root = scratch()
    expect(await pruneTurbo(join(root, "none"), new Date())).toBe(`no folder ${join(root, "none")}`)
    writeFileSync(join(root, "file"), "")
    expect(await pruneTurbo(join(root, "file"), new Date())).toBe(
      `unreadable ${join(root, "file")}: ENOTDIR`,
    )
  })
})

describe("the rehearsal backstop", () => {
  const now = new Date("2026-11-17T03:00:00Z")
  const hours = (n: number) => new Date(now.getTime() - n * 3_600_000)
  const aged = (dir: string, h: number) => {
    utimesSync(dir, hours(h), hours(h))
    return dir
  }

  test("a marked ops-r folder over a day old goes; a younger one, an unmarked one and another prefix stay", () => {
    const a = join(scratch(), "a")
    const b = join(scratch(), "b")
    mkdirSync(a)
    mkdirSync(b)
    const old = makeScratch("ops-r", a)
    writeFileSync(join(old, "cache.bin"), "x".repeat(2 * 1_048_576))
    aged(old, 25)
    const otherTemp = aged(makeScratch("ops-r", b), 30)
    const young = aged(makeScratch("ops-r", a), 1)
    mkdirSync(join(a, "ops-r130b"))
    const unmarked = aged(join(a, "ops-r130b"), 25)
    const rehearse = aged(makeScratch("rehearse", a), 25)
    const sandbox = aged(makeScratch("test-sandbox-", a), 25)
    const pruned = pruneRehearsals([a, b], now)
    expect(pruned.gone.sort()).toEqual([old, otherTemp].sort())
    expect(pruned.line).toBe("removed 2 (0.0 GB)")
    for (const dir of [old, otherTemp]) expect(existsSync(dir)).toBe(false)
    for (const dir of [young, unmarked, rehearse, sandbox]) expect(existsSync(dir)).toBe(true)
  })

  test("a temp folder that is gone removes nothing and throws nothing", () => {
    expect(pruneRehearsals([join(scratch(), "none")], now)).toEqual({
      gone: [],
      line: "removed 0 (0.0 GB)",
    })
  })

  // round 1 of the review: the Linux read of each session's /tmp/playground-<name>.<suffix>, which spawn.sh makes per launch; macOS reads getconf's one folder instead
  test.skipIf(process.platform === "darwin")(
    "on Linux the temp folders are each playground-<name>.<suffix> folder in tmp, and nothing else",
    () => {
      const tmp = scratch()
      for (const dir of [
        "playground-5tr36f-worker.SGfErz",
        "playground-ops.XpWpMU",
        "playground-x",
        "other.abc",
      ])
        mkdirSync(join(tmp, dir))
      writeFileSync(join(tmp, "playground-file.abc"), "")
      expect(tempFolders(tmp).sort()).toEqual(
        [join(tmp, "playground-5tr36f-worker.SGfErz"), join(tmp, "playground-ops.XpWpMU")].sort(),
      )
    },
  )
})

describe("one night's run against a fixture data folder", () => {
  const ID = "11111111-2222-3333-4444-555555555555"
  const OLD = "99999999-2222-3333-4444-555555555555"
  // A data folder with ops and a roster, a main checkout with worktrees pg-1 (merged, held by a live session), pg-2 (merged, dirty) and pg-3 (open), each command's output by a word of its argv.
  const night = (
    outputs: Answers = {},
    state?: (wt: (name: string) => string) => object,
    grow = 0.6,
    finished: CleanupDeps["finished"] = async () => false,
  ) => {
    const root = scratch()
    const data = join(root, "data")
    const ops = join(data, "ops")
    const main = join(root, "main")
    for (const name of ["pg-1", "pg-2", "pg-3"])
      mkdirSync(join(main, ".claude", "worktrees", name), { recursive: true })
    mkdirSync(join(ops, "log"), { recursive: true })
    writeFileSync(join(data, "roster.json"), JSON.stringify({ agents: [] }))
    const wt = (name: string) => join(main, ".claude", "worktrees", name)
    if (state) {
      mkdirSync(join(ops, "tick"), { recursive: true })
      writeFileSync(join(ops, "tick", "nightly-clean.json"), JSON.stringify(state(wt)))
    }
    const porcelain = [
      `worktree ${main}\nHEAD a\nbranch refs/heads/main`,
      `worktree ${wt("pg-1")}\nHEAD b\nbranch refs/heads/PG-1-a`,
      `worktree ${wt("pg-2")}\nHEAD c\nbranch refs/heads/PG-2-b`,
      `worktree ${wt("pg-3")}\nHEAD d\nbranch refs/heads/PG-3-c`,
    ].join("\n\n")
    const all: Answers = {
      "docker ps": "playground-gone-db\texited\t10B\nplayground-dashboard-db\trunning\t10B",
      "docker system df": JSON.stringify({ Volumes: [] }),
      "branch --merged": "PG-9-done",
      "for-each-ref refs/heads": "main m\nPG-9-done h9",
      "for-each-ref refs/remotes/origin": "HEAD x\nPG-8-gone r8",
      "worktree list": porcelain,
      // playground rm's trash move, whose printed id playground rm --restore takes
      "--reason nightly-clean":
        "Moved to the trash as 20261108T030000Z-shell/1 (3 files); playground rm --restore 20261108T030000Z-shell/1 brings it back",
      ...outputs,
    }
    const { inputs, run, runs } = fakeRun(all)
    const sent: { text: string; to: string }[] = []
    const ctx: Context = {
      now: new Date("2026-11-05T03:00:00Z"),
      ops,
      repo: main,
      run,
      send: async (to, text) => {
        sent.push({ text, to })
        return true
      },
    }
    const cleanup: CleanupDeps = {
      containers: async () => [],
      devStop: async () => ({ ok: true, out: "" }),
      finished,
      git: async (dir, args) => {
        if (args[0] === "rev-parse") return `${dir}/.git\n${main}/.git`
        if (args[0] === "symbolic-ref") return `PG-${dir.slice(-1)}`
        if (args[0] === "status") return dir.endsWith("pg-2") ? " M wip.ts" : ""
        if (args[0] === "rev-list") return args.includes("h1") ? "0" : "3"
        return ""
      },
      held: async (path) =>
        path.endsWith("pg-1")
          ? `${path} is held by k3m9px-worker, which the roster lists as working`
          : null,
      live,
      liveBranch: "live/dashboard",
      main,
      removeContainer: async () => true,
      rm: async () => ({ ok: true, out: "" }),
    }
    let free = 100 * 1024 ** 3
    const deps: NightDeps = {
      cleanup: async () => cleanup,
      free: () => (free += grow * 1024 ** 3),
      live: async () => [],
      now: () => Date.now(),
      prs: async () => ({
        ...prsOf({
          "PG-1-a": pr("MERGED"),
          "PG-2-b": pr("MERGED", "h1", 2),
          "PG-3-c": pr("OPEN"),
          "PG-8-gone": pr("MERGED", "r8"),
        }),
        repo: "https://github.com/acme/app",
      }),
      roots: async () => [],
      sleep: async () => {},
      temps: () => [],
      trashRoots: () => ({ home: "/nowhere", main: "/nowhere", trash: "/nowhere" }),
      turbo: join(root, "turbo"),
      unused: async () => [],
    }
    return { ctx, deps, inputs, ops, runs, sent, wt }
  }

  // #1515 items 3 to 5: one fixture container per kept class, two orphans, and an unused volume over 1 GB
  const leftovers = (more: Answers = {}): Answers => ({
    "docker ps": [
      "playground-gone-db\texited\t10B",
      "playground-gone-redis\texited\t10B",
      "playground-dashboard-db\trunning\t10B",
      "playground-dashboard-db-sY08\texited\t10B",
      "playground-vibe-pg-9-ab12cd34-db\texited\t10B",
      "playground-pg-1-db\texited\t10B",
      "playground-lost-db\trunning\t10B",
      "someone-else\texited\t2GB",
    ].join("\n"),
    "docker system df": JSON.stringify({
      Volumes: [{ Links: "0", Name: "big-unused", Size: "2.5GB" }],
    }),
    ...more,
  })

  test("the two orphans go with -fv and are named, every other container and the volume stay, the ones over 1 GB named, and no decision is asked", async () => {
    const { ctx, deps, inputs, ops, runs, sent } = night(leftovers())
    await nightlyClean(deps)(ctx)
    const removals = runs
      .filter((r) => r[0] === "docker" && (r[1] === "rm" || r[1] === "volume"))
      .map((r) => r.join(" "))
    expect(removals).toEqual([
      "docker rm -fv playground-gone-db",
      "docker rm -fv playground-gone-redis",
    ])
    expect(inputs).toEqual([])
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    const line = sent.find((s) => s.to === "ops")?.text ?? ""
    for (const text of [log, line]) {
      expect(text).toContain("container playground-gone-db")
      expect(text).toContain("container playground-gone-redis")
      expect(text).toContain("container someone-else kept: over 1 GB, no rule removes it")
      expect(text).toContain("volume big-unused kept: unused and over 1 GB, no rule removes it")
    }
    expect(line).not.toContain("playground-dashboard-db")
    expect(line).not.toContain("playground-lost-db")
  })

  test("a rehearsal folder over a day old is removed and named in the log and to ops", async () => {
    const { ctx, deps, ops, sent } = night(leftovers())
    const temp = join(scratch(), "temp")
    mkdirSync(temp)
    const old = makeScratch("ops-r", temp)
    const day = new Date(ctx.now.getTime() - 25 * 3_600_000)
    utimesSync(old, day, day)
    deps.temps = () => [temp]
    await nightlyClean(deps)(ctx)
    expect(existsSync(old)).toBe(false)
    expect(readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")).toContain(
      "rehearsals: removed 1 (0.0 GB)",
    )
    expect(sent.find((s) => s.to === "ops")?.text ?? "").toContain(`rehearsal ${old}`)
  })

  test("a container removal that fails is named as kept", async () => {
    const { ctx, deps, ops, sent } = night(
      leftovers({
        "docker rm -fv playground-gone-db": { code: 1, err: "Error response from daemon\n" },
      }),
    )
    await nightlyClean(deps)(ctx)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    const line = sent.find((s) => s.to === "ops")?.text ?? ""
    for (const text of [log, line]) {
      expect(text).toContain("container playground-gone-db kept: its removal failed")
      expect(text).toContain("container playground-gone-redis")
    }
  })

  test("a state file an older run left with a decision and denied keys loads, and nothing reads or asks them", async () => {
    const { ctx, deps, inputs, ops, runs } = night(leftovers(), () => ({
      at: "2026-11-04T03:00:00.000Z",
      decision: { id: OLD, targets: [{ kind: "container", name: "someone-else" }] },
      denied: ["volume big-unused"],
    }))
    await nightlyClean(deps)(ctx)
    expect(runs.some((r) => r.includes("ask") && r.includes(OLD))).toBe(false)
    expect(inputs).toEqual([])
    expect(JSON.parse(readFileSync(join(ops, "tick", "nightly-clean.json"), "utf8"))).toEqual({
      at: "2026-11-05T03:00:00.000Z",
    })
  })

  test("a live session's worktree stays, the gone worktree's container goes, and the log line is written", async () => {
    const { ctx, deps, inputs, ops, runs, wt } = night()
    await nightlyClean(deps)(ctx)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toStartWith("2026-11-05T03:00:00Z free 100.6 GB, now ")
    expect(log).toContain(`kept ${wt("pg-1")}: ${wt("pg-1")} is held by k3m9px-worker`)
    expect(log).not.toContain(wt("pg-3"))
    expect(runs.map((r) => r.join(" "))).toContain("docker rm -fv playground-gone-db")
    expect(runs.map((r) => r.join(" "))).toContain(`git -C ${ctx.repo} branch -D PG-9-done`)
    expect(runs.map((r) => r.join(" "))).toContain(
      `git -C ${ctx.repo} push -q origin --delete PG-8-gone`,
    )
    expect(log).toContain("branches: deleted 1 local, 1 remote; none to archive")
    expect(runs.map((r) => r.join(" "))).not.toContain("docker rm -fv playground-dashboard-db")
    expect(inputs).toEqual([])
    expect(JSON.parse(readFileSync(join(ops, "tick", "nightly-clean.json"), "utf8"))).toEqual({
      at: "2026-11-05T03:00:00.000Z",
    })
  })

  // #2539 item 1
  test("each machine's unused space is the log line's total and the outbox line's items, and nothing removes it", async () => {
    const { ctx, deps, ops, runs, sent } = night({ "ask new": `${CARD}\n` })
    const gguf = "/home/me/probe-local-model/gguf/x.gguf"
    deps.unused = async () => [
      {
        items: [{ bytes: 38 * 1024 ** 3, kind: "weights", path: gguf, recorded: true }],
        machine: "spark-9dfb",
      },
      { machine: "spark-a566", why: "exit 255" },
    ]
    await nightlyClean(deps)(ctx)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain(
      `unused: spark-9dfb unused 38.0 GB (weights 38.0 GB); spark-a566 not read; card ${CARD} posted, 1 items (`,
    )
    expect(JSON.parse(readFileSync(join(ops, "tick", "nightly-clean.json"), "utf8")).card).toEqual({
      id: CARD,
      items: [
        {
          bytes: 38 * 1024 ** 3,
          kind: "weights",
          machine: "spark-9dfb",
          path: gguf,
          recorded: true,
        },
      ],
    })
    expect(sent.at(-1)?.text).toEndWith(
      `; spark-9dfb unused: weights ${gguf} 38.0 GB recorded; spark-a566: not read: exit 255`,
    )
    expect(runs.flat()).not.toContain(gguf)
  })

  test("an answered card's Remove on this machine goes through playground rm --card, a peer's goes to Ops as its command, and the card closes", async () => {
    const rehearsal = "/home/me/.playground/scratchpad/ops/rehearse142"
    const items = [
      { bytes: 2 * 1024 ** 3, kind: "rehearsal" as const, machine: "spark-a566", path: rehearsal },
      {
        bytes: 1024 ** 3,
        id: "sha256:ccc",
        kind: "image" as const,
        machine: "spark-9dfb",
        path: "docker image peer:1",
      },
    ]
    const answered = {
      ...cardOf(items),
      answer: { at: "2026-11-17T09:00:00.000Z", choice: "approve", options: [0, 0] },
      from: "ops",
      status: "approved",
    }
    const { ctx, deps, ops, runs, sent } = night(
      { "ask get": JSON.stringify(answered), "tag -l": "v0.0.142\n" },
      () => ({ card: { at: "2026-11-17T03:00:00.000Z", id: CARD, items } }),
    )
    deps.unused = async () => [
      {
        items: [{ bytes: 2 * 1024 ** 3, kind: "rehearsal", path: rehearsal, recorded: true }],
        machine: "spark-a566",
      },
      {
        items: [
          {
            bytes: 1024 ** 3,
            id: "sha256:ccc",
            kind: "image",
            path: "docker image peer:1",
            recorded: false,
          },
        ],
        machine: "spark-9dfb",
      },
    ]
    await nightlyClean(deps)(ctx)
    expect(runs.filter((argv) => argv.includes("--card"))).toEqual([
      [
        "bun",
        "--no-env-file",
        join(ctx.repo, "packages", "scripts", "src", "playground", "cli.ts"),
        "rm",
        rehearsal,
        "--card",
        CARD,
        "--reason",
        "nightly-clean",
      ],
    ])
    expect(runs.some((argv) => argv.join(" ").includes("docker image rm"))).toBe(false)
    expect(sent.map((s) => s.text)).toContain(
      `card ${CARD} approved on spark-9dfb: docker image rm sha256:ccc`,
    )
    expect(runs.find((argv) => argv.includes("ack"))?.slice(-4)).toEqual([
      "ack",
      CARD,
      "--no-link",
      "nightly-clean removed 1 and sent 1 to Ops",
    ])
    expect(
      JSON.parse(readFileSync(join(ops, "tick", "nightly-clean.json"), "utf8")).card,
    ).toBeUndefined()
  })

  test("an image of unknown age is kept off the night's lines, its first night written to the state file for the next run", async () => {
    const { ctx, deps, ops, sent } = night()
    const path = "docker image pulled:1"
    deps.unused = async () => [
      {
        items: [{ bytes: 2 * 1024 ** 3, kind: "image", path, recorded: false, unknownAge: true }],
        machine: "spark-9dfb",
      },
    ]
    await nightlyClean(deps)(ctx)
    expect(readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")).toContain(
      "unused: spark-9dfb unused 0.0 GB (",
    )
    expect(sent.map((s) => s.text).join("\n")).not.toContain(path)
    expect(JSON.parse(readFileSync(join(ops, "tick", "nightly-clean.json"), "utf8"))).toEqual({
      at: "2026-11-05T03:00:00.000Z",
      imagesSeen: { [`spark-9dfb ${path}`]: "2026-11-05T03:00:00.000Z" },
    })
  })

  // #1515
  test("a stale unmerged worktree goes through playground rm with no decision, and its trash id is logged", async () => {
    const { ctx, deps, inputs, ops, runs, sent, wt } = night()
    await nightlyClean(deps)(ctx)
    const ran = runs.map((r) => r.join(" "))
    expect(ran).toContain(
      `bun --no-env-file ${join(ctx.repo, "packages", "scripts", "src", "playground", "cli.ts")} rm --worktree ${wt("pg-2")} --discard --reason nightly-clean`,
    )
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain(
      `trashed ${wt("pg-2")} as 20261108T030000Z-shell/1, restorable with playground rm --restore 20261108T030000Z-shell/1`,
    )
    expect(log).not.toContain(`decision ${ID}`)
    expect(inputs).toEqual([])
    const line = sent.find((s) => s.to === "ops")
    expect(line?.text).toContain(
      `worktree ${wt("pg-2")} as trash 20261108T030000Z-shell/1 (playground rm --restore 20261108T030000Z-shell/1)`,
    )
  })

  // issue 1554: rm refuses the 4th trash move in a minute ("refused a 4th removal: <session> moved 3 paths in the last minute, the most one session may"), and the beat counted that refusal as done, so 7 of 10 stale worktrees stayed behind with no line naming them for the next run; the beat paces under the cap, waiting out the minute on the injected sleep, under a total-wait bound, and names anything the bound leaves
  test("the beat finishes its stale worktrees under rm's 3-a-minute cap", async () => {
    const root = scratch()
    const data = join(root, "data")
    const ops = join(data, "ops")
    const main = join(root, "main")
    const names = Array.from({ length: 10 }, (_, i) => `pg-${i + 1}`)
    for (const name of names)
      mkdirSync(join(main, ".claude", "worktrees", name), { recursive: true })
    mkdirSync(join(ops, "log"), { recursive: true })
    writeFileSync(join(data, "roster.json"), JSON.stringify({ agents: [] }))
    const wt = (name: string) => join(main, ".claude", "worktrees", name)
    const porcelain = [
      `worktree ${main}\nHEAD a\nbranch refs/heads/main`,
      ...names.map(
        (name, i) =>
          `worktree ${wt(name)}\nHEAD ${"abcdefghij"[i]}\nbranch refs/heads/PG-${i + 1}-x`,
      ),
    ].join("\n\n")
    const answers: Answers = {
      "docker ps": "playground-dashboard-db\trunning\t10B",
      "docker system df": JSON.stringify({ Volumes: [] }),
      "for-each-ref refs/heads": [...names.map((_, i) => `PG-${i + 1}-x h${i + 1}`), "main m"].join(
        "\n",
      ),
      "for-each-ref refs/remotes/origin": "HEAD x",
      "branch --merged": names.map((_, i) => `PG-${i + 1}-x`).join("\n"),
      "worktree list": porcelain,
      "--reason nightly-clean":
        "Moved to the trash as 20261108T030000Z-shell/1 (3 files); playground rm --restore 20261108T030000Z-shell/1 brings it back",
    }
    const base = fakeRun(answers)
    const accepted: number[] = []
    let refusals = 0
    let t = 0
    const waits: number[] = []
    const run: Context["run"] = async (argv, timeoutMs, stdin) => {
      if (argv.join(" ").includes("rm --worktree")) {
        if (accepted.filter((at) => t - at < 60_000).length >= 3) {
          refusals++
          return {
            code: 1,
            out: "refused a 4th removal: nightly-clean moved 3 paths in the last minute, the most one session may\n",
          }
        }
        accepted.push(t)
      }
      return base.run(argv, timeoutMs, stdin)
    }
    const sleep = async (ms: number) => {
      waits.push(ms)
      t += ms
    }
    const sent: { text: string; to: string }[] = []
    const ctx: Context = {
      now: new Date("2026-11-05T03:00:00Z"),
      ops,
      repo: main,
      run,
      send: async (to, text) => {
        sent.push({ text, to })
        return true
      },
    }
    const deps: NightDeps = {
      cleanup: async () => ({
        containers: async () => [],
        devStop: async () => ({ ok: true, out: "" }),
        finished: async () => false,
        git: async (dir, args) =>
          args[0] === "rev-parse"
            ? `${dir}/.git\n${main}/.git`
            : args[0] === "status"
              ? " M wip.ts"
              : "",
        held: async () => null,
        live,
        liveBranch: "live/dashboard",
        main,
        removeContainer: async () => true,
        rm: async () => ({ ok: true, out: "" }),
      }),
      free: () => 100 * 1024 ** 3,
      live: async () => [],
      now: () => t,
      prs: async () => ({
        ...prsOf(
          Object.fromEntries(
            names.map((_, i) => [`PG-${i + 1}-x`, pr("MERGED", `h${i + 1}`, i + 1)]),
          ),
        ),
        repo: "https://github.com/acme/app",
      }),
      roots: async () => [],
      sleep,
      temps: () => [],
      trashRoots: () => ({ home: "/nowhere", main: "/nowhere", trash: "/nowhere" }),
      turbo: join(root, "turbo"),
      unused: async () => [],
    }
    await nightlyClean(deps)(ctx)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log.match(/trashed /g)).toHaveLength(10)
    expect(refusals).toBe(0)
    expect(waits).toEqual([60_000, 60_000, 60_000])
    expect(log).not.toContain("its trash move failed")
    expect(log).not.toMatch(/left .*? for the next run/)
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(600_000)
  })

  // #1710: cleanWorktree moves a saved worktree through rm itself, so its moves count toward the cap too
  test("the beat paces cleanWorktree's own moves under rm's cap, so no try is refused", async () => {
    const root = scratch()
    const data = join(root, "data")
    const ops = join(data, "ops")
    const main = join(root, "main")
    const names = Array.from({ length: 10 }, (_, i) => `pg-${i + 1}`)
    for (const name of names)
      mkdirSync(join(main, ".claude", "worktrees", name), { recursive: true })
    mkdirSync(join(ops, "log"), { recursive: true })
    writeFileSync(join(data, "roster.json"), JSON.stringify({ agents: [] }))
    const wt = (name: string) => join(main, ".claude", "worktrees", name)
    const porcelain = [
      `worktree ${main}\nHEAD a\nbranch refs/heads/main`,
      ...names.map(
        (name, i) => `worktree ${wt(name)}\nHEAD h${i + 1}\nbranch refs/heads/PG-${i + 1}-x`,
      ),
    ].join("\n\n")
    const { run } = fakeRun({
      "docker ps": "playground-dashboard-db\trunning\t10B",
      "docker system df": JSON.stringify({ Volumes: [] }),
      "for-each-ref refs/heads": "main m",
      "for-each-ref refs/remotes/origin": "HEAD x",
      "worktree list": porcelain,
    })
    let t = 0
    const accepted: number[] = []
    let refusals = 0
    const waits: number[] = []
    const ctx: Context = {
      now: new Date("2026-11-05T03:00:00Z"),
      ops,
      repo: main,
      run,
      send: async () => true,
    }
    const deps: NightDeps = {
      cleanup: async () => ({
        containers: async () => [],
        devStop: async () => ({ ok: true, out: "" }),
        finished: async () => true,
        git: async (dir, args) =>
          args[0] === "rev-parse" ? `${dir}/.git\n${main}/.git` : args[0] === "rev-list" ? "0" : "",
        held: async () => null,
        live,
        liveBranch: "live/dashboard",
        main,
        removeContainer: async () => true,
        rm: async () => {
          if (accepted.filter((at) => t - at < 60_000).length >= 3) {
            refusals++
            return {
              ok: false,
              out: "playground: refused a 4th removal: shell moved 3 paths in the last minute, the most one session may",
            }
          }
          accepted.push(t)
          return { ok: true, out: "" }
        },
      }),
      free: () => 100 * 1024 ** 3,
      live: async () => [],
      now: () => t,
      prs: async () => ({
        ...prsOf(
          Object.fromEntries(
            names.map((_, i) => [`PG-${i + 1}-x`, pr("MERGED", `h${i + 1}`, i + 1)]),
          ),
        ),
        repo: "https://github.com/acme/app",
      }),
      roots: async () => [],
      sleep: async (ms) => {
        waits.push(ms)
        t += ms
      },
      temps: () => [],
      trashRoots: () => ({ home: "/nowhere", main: "/nowhere", trash: "/nowhere" }),
      turbo: join(root, "turbo"),
      unused: async () => [],
    }
    await nightlyClean(deps)(ctx)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(refusals).toBe(0)
    expect(log.match(/removed \/[^;]*pg-\d+/g)).toHaveLength(10)
    expect(waits).toEqual([60_000, 60_000, 60_000])
    expect(log).not.toContain("quarantined")
  })

  // the bound: with rm refusing forever, the beat still ends inside its 10-minute wait budget, and each worktree it leaves is named for the next run
  test("the beat ends within its wait bound when rm refuses every move, naming each one left", async () => {
    const root = scratch()
    const data = join(root, "data")
    const ops = join(data, "ops")
    const main = join(root, "main")
    const names = Array.from({ length: 10 }, (_, i) => `pg-${i + 1}`)
    for (const name of names)
      mkdirSync(join(main, ".claude", "worktrees", name), { recursive: true })
    mkdirSync(join(ops, "log"), { recursive: true })
    writeFileSync(join(data, "roster.json"), JSON.stringify({ agents: [] }))
    const wt = (name: string) => join(main, ".claude", "worktrees", name)
    const porcelain = [
      `worktree ${main}\nHEAD a\nbranch refs/heads/main`,
      ...names.map(
        (name, i) =>
          `worktree ${wt(name)}\nHEAD ${"abcdefghij"[i]}\nbranch refs/heads/PG-${i + 1}-x`,
      ),
    ].join("\n\n")
    const answers: Answers = {
      "docker ps": "playground-dashboard-db\trunning\t10B",
      "docker system df": JSON.stringify({ Volumes: [] }),
      "for-each-ref refs/heads": [...names.map((_, i) => `PG-${i + 1}-x h${i + 1}`), "main m"].join(
        "\n",
      ),
      "for-each-ref refs/remotes/origin": "HEAD x",
      "branch --merged": names.map((_, i) => `PG-${i + 1}-x`).join("\n"),
      "worktree list": porcelain,
      "--reason nightly-clean": {
        code: 1,
        err: "refused a 4th removal: nightly-clean moved 3 paths in the last minute, the most one session may\n",
      },
    }
    const { run } = fakeRun(answers)
    const waits: number[] = []
    const sleep = async (ms: number) => {
      waits.push(ms)
    }
    const ctx: Context = {
      now: new Date("2026-11-05T03:00:00Z"),
      ops,
      repo: main,
      run,
      send: async () => true,
    }
    const deps: NightDeps = {
      cleanup: async () => ({
        containers: async () => [],
        devStop: async () => ({ ok: true, out: "" }),
        finished: async () => false,
        git: async (dir, args) =>
          args[0] === "rev-parse"
            ? `${dir}/.git\n${main}/.git`
            : args[0] === "status"
              ? " M wip.ts"
              : "",
        held: async () => null,
        live,
        liveBranch: "live/dashboard",
        main,
        removeContainer: async () => true,
        rm: async () => ({ ok: true, out: "" }),
      }),
      free: () => 100 * 1024 ** 3,
      live: async () => [],
      now: () => 0,
      prs: async () => ({
        ...prsOf(
          Object.fromEntries(
            names.map((_, i) => [`PG-${i + 1}-x`, pr("MERGED", `h${i + 1}`, i + 1)]),
          ),
        ),
        repo: "https://github.com/acme/app",
      }),
      roots: async () => [],
      sleep,
      temps: () => [],
      trashRoots: () => ({ home: "/nowhere", main: "/nowhere", trash: "/nowhere" }),
      turbo: join(root, "turbo"),
      unused: async () => [],
    }
    await nightlyClean(deps)(ctx)
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(600_000)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log.match(/left .*? for the next run/g)).toHaveLength(10)
    expect(log).not.toContain("trashed ")
  })

  // the bound on the pace itself: with 40 stale worktrees the pre-call pauses would spend 780s, so the bound stops them at 600s and each worktree past it is named for the next run without rm being called
  test("the pace itself ends at the bound, naming the rest for the next run without calling rm", async () => {
    const root = scratch()
    const data = join(root, "data")
    const ops = join(data, "ops")
    const main = join(root, "main")
    const names = Array.from({ length: 40 }, (_, i) => `pg-${i + 1}`)
    for (const name of names)
      mkdirSync(join(main, ".claude", "worktrees", name), { recursive: true })
    mkdirSync(join(ops, "log"), { recursive: true })
    writeFileSync(join(data, "roster.json"), JSON.stringify({ agents: [] }))
    const wt = (name: string) => join(main, ".claude", "worktrees", name)
    const porcelain = [
      `worktree ${main}\nHEAD a\nbranch refs/heads/main`,
      ...names.map(
        (name, i) =>
          `worktree ${wt(name)}\nHEAD ${"abcdefghijklmnopqrstuvwxyz0123"[i]}\nbranch refs/heads/PG-${i + 1}-x`,
      ),
    ].join("\n\n")
    const answers: Answers = {
      "docker ps": "playground-dashboard-db\trunning\t10B",
      "docker system df": JSON.stringify({ Volumes: [] }),
      "for-each-ref refs/heads": [...names.map((_, i) => `PG-${i + 1}-x h${i + 1}`), "main m"].join(
        "\n",
      ),
      "for-each-ref refs/remotes/origin": "HEAD x",
      "branch --merged": names.map((_, i) => `PG-${i + 1}-x`).join("\n"),
      "worktree list": porcelain,
      "--reason nightly-clean":
        "Moved to the trash as 20261108T030000Z-shell/1 (3 files); playground rm --restore 20261108T030000Z-shell/1 brings it back",
    }
    const base = fakeRun(answers)
    const rmCalls: string[] = []
    let t = 0
    const waits: number[] = []
    const run: Context["run"] = async (argv, timeoutMs, stdin) => {
      const line = argv.join(" ")
      if (line.includes("rm --worktree")) rmCalls.push(line.split(" ").at(-4) ?? "")
      return base.run(argv, timeoutMs, stdin)
    }
    const sleep = async (ms: number) => {
      waits.push(ms)
      t += ms
    }
    const ctx: Context = {
      now: new Date("2026-11-05T03:00:00Z"),
      ops,
      repo: main,
      run,
      send: async () => true,
    }
    const deps: NightDeps = {
      cleanup: async () => ({
        containers: async () => [],
        devStop: async () => ({ ok: true, out: "" }),
        finished: async () => false,
        git: async (dir, args) =>
          args[0] === "rev-parse"
            ? `${dir}/.git\n${main}/.git`
            : args[0] === "status"
              ? " M wip.ts"
              : "",
        held: async () => null,
        live,
        liveBranch: "live/dashboard",
        main,
        removeContainer: async () => true,
        rm: async () => ({ ok: true, out: "" }),
      }),
      free: () => 100 * 1024 ** 3,
      live: async () => [],
      now: () => t,
      prs: async () => ({
        ...prsOf(
          Object.fromEntries(
            names.map((_, i) => [`PG-${i + 1}-x`, pr("MERGED", `h${i + 1}`, i + 1)]),
          ),
        ),
        repo: "https://github.com/acme/app",
      }),
      roots: async () => [],
      sleep,
      temps: () => [],
      trashRoots: () => ({ home: "/nowhere", main: "/nowhere", trash: "/nowhere" }),
      turbo: join(root, "turbo"),
      unused: async () => [],
    }
    await nightlyClean(deps)(ctx)
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(600_000)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log.match(/trashed /g)).toHaveLength(33)
    expect(log.match(/left .*? for the next run/g)).toHaveLength(7)
    for (const name of names.slice(33))
      expect(rmCalls.some((called) => called.endsWith(wt(name)))).toBe(false)
  })

  // #1515
  test("an unmerged branch on origin is archived as a tag before any delete, then deleted on origin and locally, and no ask new names a decision", async () => {
    const { ctx, deps, inputs, ops, runs, sent } = night({
      "for-each-ref refs/heads": "main m\nPG-9-done h9\nscratch s",
      "for-each-ref refs/remotes/origin": "HEAD x\nPG-8-gone r8\nscratch s",
    })
    await nightlyClean(deps)(ctx)
    const ran = runs.map((r) => r.join(" "))
    const tag = ran.findIndex((r) => r.includes("git/refs") && r.includes("archive/scratch"))
    const push = ran.findIndex((r) => r.includes("--delete scratch"))
    const local = ran.findIndex((r) => r.endsWith("branch -D scratch"))
    expect(tag).toBeGreaterThanOrEqual(0)
    expect(push).toBeGreaterThan(tag)
    expect(local).toBeGreaterThan(tag)
    expect(ran[tag]).toContain("repos/acme/app/git/refs")
    expect(ran[tag]).toContain("ref=refs/tags/archive/scratch")
    expect(ran[tag]).toContain("-f sha=s")
    expect(inputs.map((i) => JSON.parse(i).kind)).not.toContain("decision")
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain("archived scratch as archive/scratch at s, deleted on origin and locally")
    const line = sent.find((s) => s.to === "ops")
    expect(line?.text).toContain("branch scratch as tag archive/scratch at s")
  })

  // #1710: a branch never pushed has a head GitHub does not hold, which the refs API refuses
  const unknown = { code: 1, err: "gh: Object does not exist (HTTP 422)" }
  test.each([
    ["a head GitHub does not hold stays, with a local archive tag alone", unknown, false],
    ["a pushed head is still archived on origin, then deleted", {}, true],
  ])("%s", async (_, answer, archived) => {
    const { ctx, deps, ops, runs, sent } = night({
      "git/refs": answer,
      "for-each-ref refs/heads": "main m\nPG-9-done h9\nscratch s",
    })
    await nightlyClean(deps)(ctx)
    const ran = runs.map((r) => r.join(" "))
    expect(
      ran.some((r) => r.includes("git/refs") && r.includes("ref=refs/tags/archive/scratch")),
    ).toBe(true)
    expect(ran.some((r) => r.endsWith("tag -f archive/scratch s"))).toBe(!archived)
    expect(ran.some((r) => r.includes("push") && r.includes("archive/scratch"))).toBe(false)
    expect(ran.some((r) => r.endsWith("branch -D scratch"))).toBe(archived)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    const line = sent.find((s) => s.to === "ops")?.text ?? ""
    if (archived) {
      expect(log).toContain("archived scratch as archive/scratch at s, deleted locally")
      expect(line).toContain("branch scratch as tag archive/scratch at s")
    } else {
      expect(log).toContain(
        "kept scratch: its head s is not on GitHub, so it is tagged archive/scratch locally alone",
      )
      expect(line).toContain(
        "branch scratch kept: its head s is not on GitHub, so it is tagged archive/scratch locally alone",
      )
    }
  })

  test("a head GitHub does not hold, already tagged locally at that head, is named on no later night", async () => {
    const { ctx, deps, ops, runs, sent } = night({
      "git/refs": unknown,
      "refs/tags/archive/scratch": "s",
      "for-each-ref refs/heads": "main m\nPG-9-done h9\nscratch s",
    })
    await nightlyClean(deps)(ctx)
    const ran = runs.map((r) => r.join(" "))
    expect(ran.some((r) => r.endsWith("tag -f archive/scratch s"))).toBe(false)
    expect(ran.some((r) => r.endsWith("branch -D scratch"))).toBe(false)
    // the branch's own forms in the log and the outbox line, since a temp folder's path can hold the bare word
    const named = /(?:kept|archived|branch) scratch\b|archive\/scratch/
    expect(readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")).not.toMatch(named)
    expect(sent.find((s) => s.to === "ops")?.text ?? "").not.toMatch(named)
  })

  test("a local archive tag at another head is re-pointed to the branch's head and named with both", async () => {
    const { ctx, deps, ops, runs, sent } = night({
      "git/refs": unknown,
      "refs/tags/archive/scratch": "older",
      "for-each-ref refs/heads": "main m\nPG-9-done h9\nscratch s",
    })
    await nightlyClean(deps)(ctx)
    const ran = runs.map((r) => r.join(" "))
    expect(ran.some((r) => r.endsWith("tag -f archive/scratch s"))).toBe(true)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain("kept scratch: its local archive/scratch tag held older, now holds s")
    const line = sent.find((s) => s.to === "ops")
    expect(line?.text).toContain(
      "branch scratch kept: its local archive/scratch tag held older, now holds s",
    )
  })

  test("a re-point whose old head is no ancestor of the new one keeps the old head at its own tag", async () => {
    const { ctx, deps, ops, runs, sent } = night({
      "git/refs": unknown,
      "refs/tags/archive/scratch": "older",
      "for-each-ref refs/heads": "main m\nPG-9-done h9\nscratch s",
      "merge-base --is-ancestor": { code: 1, err: "" },
    })
    await nightlyClean(deps)(ctx)
    const ran = runs.map((r) => r.join(" "))
    expect(ran.some((r) => r.endsWith("tag archive/scratch-older older"))).toBe(true)
    expect(ran.some((r) => r.endsWith("tag -f archive/scratch s"))).toBe(true)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain(
      "kept scratch: its local archive/scratch tag held older, now holds s, the old head kept at archive/scratch-older",
    )
    const line = sent.find((s) => s.to === "ops")
    expect(line?.text).toContain("the old head kept at archive/scratch-older")
  })

  test("a rescue whose tag fails leaves the old tag where it is, skips the re-point, and names the failure", async () => {
    const { ctx, deps, ops, runs, sent } = night({
      "git/refs": unknown,
      "refs/tags/archive/scratch": "older",
      "for-each-ref refs/heads": "main m\nPG-9-done h9\nscratch s",
      "merge-base --is-ancestor": { code: 1, err: "" },
      "tag archive/scratch-older": { code: 1, err: "fatal: tag archive/scratch-older failed\n" },
    })
    await nightlyClean(deps)(ctx)
    const ran = runs.map((r) => r.join(" "))
    expect(ran.some((r) => r.endsWith("tag -f archive/scratch s"))).toBe(false)
    expect(ran.some((r) => r.endsWith("branch -D scratch"))).toBe(false)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain(
      "kept scratch: its local archive/scratch tag held older, and keeping it at archive/scratch-older failed: fatal: tag archive/scratch-older failed",
    )
    const line = sent.find((s) => s.to === "ops")
    expect(line?.text).toContain("branch scratch kept: its local archive/scratch tag held older")
  })

  // #1515
  test("a tag that fails keeps the branch, on origin and locally, and names it in the log", async () => {
    const { ctx, deps, ops, runs, sent } = night({
      "for-each-ref refs/heads": "main m\nPG-9-done h9\nscratch s",
      "for-each-ref refs/remotes/origin": "HEAD x\nPG-8-gone r8\nscratch s",
      "git/refs": { code: 1, err: "gh: Reference already exists" },
    })
    await nightlyClean(deps)(ctx)
    const ran = runs.map((r) => r.join(" "))
    expect(ran.some((r) => r.includes("archive/scratch"))).toBe(true)
    expect(ran.some((r) => r.includes("--delete scratch"))).toBe(false)
    expect(ran.some((r) => r.endsWith("branch -D scratch"))).toBe(false)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain(
      "kept scratch: its archive/scratch tag failed: gh: Reference already exists",
    )
    const line = sent.find((s) => s.to === "ops")
    expect(line?.text).toContain("branch scratch kept: its archive/scratch tag failed")
  })

  // #1515
  test("a branch whose origin head is not the local head the tag would hold stays whole, named with both shas", async () => {
    const { ctx, deps, ops, runs, sent } = night({
      "for-each-ref refs/heads": "main m\nPG-9-done h9\nscratch s",
      "for-each-ref refs/remotes/origin": "HEAD x\nPG-8-gone r8\nscratch s-newer",
    })
    await nightlyClean(deps)(ctx)
    const ran = runs.map((r) => r.join(" "))
    expect(ran.some((r) => r.includes("archive/scratch"))).toBe(false)
    expect(ran.some((r) => r.includes("--delete scratch"))).toBe(false)
    expect(ran.some((r) => r.endsWith("branch -D scratch"))).toBe(false)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain("kept scratch: origin's head is s-newer, not the local head s")
    const line = sent.find((s) => s.to === "ops")
    expect(line?.text).toContain("branch scratch kept: origin's head is s-newer")
  })

  // #1515
  test("a tag already at the tagged head holds it, so the deletes go on", async () => {
    const { ctx, deps, inputs, ops, runs } = night({
      "for-each-ref refs/heads": "main m\nPG-9-done h9\nscratch s",
      "for-each-ref refs/remotes/origin": "HEAD x\nPG-8-gone r8\nscratch s",
      "git/refs": { code: 1, err: "gh: Reference already exists" },
      "ls-remote": "s\trefs/tags/archive/scratch",
    })
    await nightlyClean(deps)(ctx)
    const ran = runs.map((r) => r.join(" "))
    expect(ran.some((r) => r.includes("--delete scratch"))).toBe(true)
    expect(ran.some((r) => r.endsWith("branch -D scratch"))).toBe(true)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain("archived scratch as archive/scratch at s, deleted on origin and locally")
    expect(inputs.map((i) => JSON.parse(i).kind)).not.toContain("decision")
  })

  // #1515
  test("a failed origin delete keeps the branch for the next night's retry, its tag holding the head", async () => {
    const { ctx, deps, ops, runs, sent } = night({
      "for-each-ref refs/heads": "main m\nPG-9-done h9\nscratch s",
      "for-each-ref refs/remotes/origin": "HEAD x\nPG-8-gone r8\nscratch s",
      "--delete scratch": { code: 1, err: "remote rejected" },
    })
    await nightlyClean(deps)(ctx)
    const ran = runs.map((r) => r.join(" "))
    expect(ran.some((r) => r.includes("archive/scratch"))).toBe(true)
    expect(ran.some((r) => r.endsWith("branch -D scratch"))).toBe(false)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain(
      "kept scratch: its origin delete failed, its archive/scratch tag holds the head",
    )
    const line = sent.find((s) => s.to === "ops")
    expect(line?.text).toContain("branch scratch kept: its origin delete failed")
  })

  // #1515
  test("an unmerged branch with no origin copy is tagged and deleted locally alone", async () => {
    const { ctx, deps, inputs, ops, runs, sent } = night({
      "for-each-ref refs/heads": "main m\nPG-9-done h9\nscratch s",
    })
    await nightlyClean(deps)(ctx)
    const ran = runs.map((r) => r.join(" "))
    expect(ran.some((r) => r.includes("--delete scratch"))).toBe(false)
    expect(ran.some((r) => r.endsWith("branch -D scratch"))).toBe(true)
    expect(
      ran.some((r) => r.includes("ref=refs/tags/archive/scratch") && r.includes("-f sha=s")),
    ).toBe(true)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain("archived scratch as archive/scratch at s, deleted locally")
    const line = sent.find((s) => s.to === "ops")
    expect(line?.text).toContain("branch scratch as tag archive/scratch at s")
    expect(inputs.map((i) => JSON.parse(i).kind)).not.toContain("decision")
  })

  // #1332 and #1348: the night's branch step on a real repo holding #i446's 33 branches, git run for real but its pushes, every other command answered by night()'s fakes
  test("#i446's 33 branches: 32 go into one bundle in the trash and are deleted, PG-493-spec-inline stays, no decision is asked, and the bundle brings one back at its old sha", async () => {
    const { ctx, deps, inputs, ops, runs, sent } = night()
    const main = ctx.repo
    const sh = (...args: string[]) => {
      const run = Bun.spawnSync([
        "git",
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "-C",
        main,
        ...args,
      ])
      if (run.exitCode !== 0) throw new Error(run.stderr.toString())
      return run.stdout.toString().trim()
    }
    sh("init", "-q", "-b", "main")
    sh("commit", "-q", "--allow-empty", "-m", "base")
    const base = sh("rev-parse", "HEAD")
    sh("update-ref", "refs/remotes/origin/canary", base)
    const tree = sh("rev-parse", "HEAD^{tree}")
    const shas = new Map<string, string>()
    for (const b of I446) {
      const sha = b.same
        ? shas.get(b.same)!
        : sh("commit-tree", tree, "-p", base, "-m", b.subject || b.name)
      shas.set(b.name, sha)
      sh("update-ref", `refs/heads/${b.name}`, sha)
    }
    // test-54's origin copy is at the head the bundle holds, so it goes on origin too; review-358's is at another head, so it stays there
    sh("update-ref", "refs/remotes/origin/test-54", shas.get("test-54")!)
    sh("update-ref", "refs/remotes/origin/review-358", base)
    const fake = ctx.run
    ctx.run = async (argv, timeout, stdin) => {
      if (argv[0] !== "git" || argv.includes("push")) return fake(argv, timeout, stdin)
      runs.push(argv)
      const run = Bun.spawnSync(argv, { stderr: "pipe", stdout: "pipe" })
      return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() }
    }
    const trash = join(dirname(ops), "trash")
    deps.trashRoots = () => ({ home: "/nowhere", main: "/nowhere", trash })
    deps.prs = async () => ({
      ...prsOf(I446_PRS),
      byIssue: I446_ISSUES,
      repo: "https://github.com/acme/app",
    })
    await nightlyClean(deps)(ctx)
    expect(sh("for-each-ref", "refs/heads", "--format=%(refname:short)").split("\n")).toEqual([
      "PG-493-spec-inline",
      "main",
    ])
    const ran = runs.map((r) => r.join(" "))
    expect(ran.filter((r) => r.includes("push"))).toEqual([
      `git -C ${main} push -q origin --delete test-54`,
    ])
    expect(ran.some((r) => r.includes("git/refs"))).toBe(false)
    expect(inputs.map((i) => JSON.parse(i).kind)).not.toContain("decision")
    const bundle = join(trash, "20261105T030000Z-nightly-clean", "branches.bundle")
    expect(readFileSync(join(dirname(bundle), "branches.shas"), "utf8").split("\n")).toHaveLength(
      33,
    )
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain(
      `bundled 32 not useful at ${bundle}, each brought back by git -C ${main} fetch ${bundle} refs/heads/<branch>:refs/heads/<branch>`,
    )
    const line = sent.find((s) => s.to === "ops")?.text ?? ""
    expect(line).toContain(`branch k4vt2m-t104 at ${shas.get("k4vt2m-t104")} in bundle ${bundle}`)
    expect(line).toContain(
      `branch review-358 at ${shas.get("review-358")} in bundle ${bundle}, origin's ${base} kept`,
    )
    expect(line).not.toContain("PG-493-spec-inline")
    sh("fetch", "-q", bundle, "refs/heads/k4vt2m-t104:refs/heads/k4vt2m-t104")
    expect(sh("rev-parse", "k4vt2m-t104")).toBe(shas.get("k4vt2m-t104")!)
  })

  test("a bundle that cannot be written keeps every branch it would hold, named in the ops line", async () => {
    const { ctx, deps, ops, runs, sent } = night({
      "for-each-ref refs/heads": "main m\ntest-54 t54",
    })
    deps.trashRoots = () => ({
      home: "/nowhere",
      main: "/nowhere",
      trash: join(dirname(ops), "trash"),
    })
    await nightlyClean(deps)(ctx)
    expect(runs.some((r) => r.join(" ").endsWith("branch -D test-54"))).toBe(false)
    expect(sent.find((s) => s.to === "ops")?.text).toContain(
      "branch test-54 kept: its bundle failed",
    )
  })

  // #1515
  test("a failed trash move keeps the worktree, named in the log and the outbox line", async () => {
    const { ctx, deps, inputs, ops, runs, sent, wt } = night({
      "--reason nightly-clean": { code: 1, err: "playground: the roster cannot be read" },
    })
    await nightlyClean(deps)(ctx)
    const ran = runs.map((r) => r.join(" "))
    expect(ran.some((r) => r.includes(`rm --worktree ${wt("pg-2")}`))).toBe(true)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain(
      `kept ${wt("pg-2")}: its trash move failed: playground: the roster cannot be read`,
    )
    expect(log).not.toContain(`trashed ${wt("pg-2")}`)
    expect(inputs).toEqual([])
    const line = sent.find((s) => s.to === "ops")
    expect(line?.text).toContain(`worktree ${wt("pg-2")} kept: its trash move failed`)
    expect(line?.text).toContain("removed 1, kept 1: container playground-gone-db; ")
  })

  // PG-1165
  test("a dirty worktree whose PR merged goes through --discard, so no decision names it", async () => {
    const asked: (string | undefined)[] = []
    const { ctx, deps, inputs, ops, wt } = night({}, undefined, 0.6, async (path, pr) => {
      asked.push(`${path} ${pr}`)
      return true
    })
    await nightlyClean(deps)(ctx)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain(`removed ${wt("pg-2")}`)
    expect(asked).toEqual([`${wt("pg-2")} https://github.com/acme/app/pull/2`])
    expect(inputs).toEqual([])
  })

  // PG-2221: free disk shows on the System page, so a night that frees 18 GB posts no Inbox item, and its outbox line to ops and its log line stay
  test("a night that frees 18 GB posts no Inbox item, and still sends ops its line and writes its log line", async () => {
    const { ctx, deps, inputs, ops, runs, sent } = night(leftovers())
    let reads = 0
    deps.free = () => (reads++ === 0 ? 100 : 118) * 1024 ** 3
    await nightlyClean(deps)(ctx)
    expect(runs.some((r) => r.includes("ask"))).toBe(false)
    expect(inputs).toEqual([])
    const lines = sent.filter((s) => s.to === "ops").map((s) => s.text)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith("nightly-clean removed 3, kept 2: ")
    expect(readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")).toStartWith(
      "2026-11-05T03:00:00Z free 100.0 GB, now 118.0 GB; ",
    )
  })

  // #1346: a factory script left with parent pid 1 after its worktree went is ended by its own pid, TERM then KILL past the grace, and logged; the signals are fakeRun's, so nothing real is signalled
  test("an orphan of a gone worktree's script is ended by its pid, logged with pid, age and command, and no decision is asked", async () => {
    const { ctx, deps, inputs, ops, runs, sent, wt } = night()
    const orphan = `bash ${wt("review-947")}/scripts/ops/run-slot.sh worker-a -- sleep 5`
    const listed = [
      `58523     1  1-04:05:06 ${orphan}`,
      `58524     1    00:10:00 bash ${wt("pg-3")}/scripts/ops/run-slot.sh w -- sleep 5`,
      `58525 58000    00:10:00 bash ${wt("review-948")}/scripts/ops/run-slot.sh w -- sleep 5`,
    ].join("\n")
    const fake = ctx.run
    let reads = 0
    ctx.run = async (argv, timeoutMs, stdin) =>
      argv[0] === "ps" && reads++ === 0 ? { code: 0, out: listed } : fake(argv, timeoutMs, stdin)
    const waits: number[] = []
    deps.sleep = async (ms) => {
      waits.push(ms)
    }
    await nightlyClean(deps)(ctx)
    expect(runs.filter((r) => r[0] === "kill").map((r) => r.join(" "))).toEqual([
      "kill -TERM 58523",
    ])
    expect(waits).toContain(5000)
    const said = `orphan pid 58523 ended by TERM (age 1-04:05:06, its worktree ${wt("review-947")} gone): ${orphan}`
    expect(readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")).toContain(
      `orphans: ${said}`,
    )
    expect(sent.find((s) => s.to === "ops")?.text).toContain(said)
    expect(inputs).toEqual([])
  })
  // #2177: a test's child left with parent pid 1 runs a relative script, so only its working folder, read from lsof for the parent-pid-1 rows alone, names the removed sandbox it ran in
  test("a test's child under a removed sandbox is ended by its pid, its working folder read from lsof for the parent-pid-1 rows alone", async () => {
    const { ctx, deps, ops, runs } = night()
    // a made-up path, since this test's own temp folder sits under its session's, which the roster here never lists
    const sandbox = "/tmp/orphans-fixture.T/test-sandbox-ended1"
    const listed = [
      "60001     1    02:00:00 bun --no-env-file scripts/hooks/guards.ts",
      "60002 59000    02:00:00 bun --no-env-file scripts/hooks/guards.ts",
    ].join("\n")
    const fake = ctx.run
    let reads = 0
    ctx.run = async (argv, timeoutMs, stdin) => {
      if (argv[0] === "ps" && reads++ === 0) return { code: 0, out: listed }
      if (argv.join(" ") === `${CWDS.join(" ")} 60001`)
        return { code: 0, out: `p60001\nfcwd\nn${sandbox}/t/hooks-x/stuck\n` }
      return fake(argv, timeoutMs, stdin)
    }
    deps.sleep = async () => {}
    await nightlyClean(deps)(ctx)
    expect(runs.filter((r) => r[0] === "kill").map((r) => r.join(" "))).toEqual([
      "kill -TERM 60001",
    ])
    expect(readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")).toContain(
      `orphans: orphan pid 60001 ended by TERM (age 02:00:00, its test sandbox ${sandbox} gone): bun --no-env-file scripts/hooks/guards.ts`,
    )
  })
  // #2402: the 16 Nov shape on Linux: the user's systemd --user adopts the orphans, which pid 1 alone never matched, and only the ended session's loop goes; a live session's double-forked daemon stays, and so does every user unit's main process, which the manager parents too
  test("an orphan of the user's systemd --user under an ended session's removed sandbox is ended; a live session's, and the user units, are kept", async () => {
    const { ctx, deps, ops, runs, wt } = night()
    const main = dirname(dirname(dirname(wt("pg-3"))))
    writeFileSync(
      join(dirname(ops), "roster.json"),
      JSON.stringify({
        agents: [
          { name: "42fmjw-reviewer", status: "ended" },
          { name: "ab12cd-worker", status: "working" },
        ],
      }),
    )
    const loop = `bash -c touch "$0"; trap "" TERM; while :; do sleep 0.2; done`
    const listed = [
      "    1     0  9-00:00:00 /sbin/init",
      " 1500     1  9-00:00:00 /usr/lib/systemd/systemd --user",
      ` ${process.pid}  1500    00:00:05 bun packages/scripts/src/ops-tick/cli.ts`,
      `61001  1500    04:00:00 ${loop}`,
      `61002  1500    04:00:00 ${loop}`,
      `61003 61000    04:00:00 ${loop}`,
      "61004  1500  9-00:00:00 /home/u/.local/bin/herdr server",
      `61005  1500  9-00:00:00 bash ${main}/scripts/ops/ops-dashboard/run.sh`,
    ].join("\n")
    // made-up session folders, outside this test's own temp folder, which sits under its session's
    const cwd = (name: string) => `/tmp/playground-${name}.qZ9xW1/test-sandbox-Ab1/t/run-slot-x`
    const fake = ctx.run
    const folders: [number, string][] = [
      [process.pid, main],
      [61001, cwd("42fmjw-reviewer")],
      [61002, cwd("ab12cd-worker")],
      [61004, wt("pg-3")],
      [61005, main],
    ]
    let reads = 0
    let read = ""
    ctx.run = async (argv, timeoutMs, stdin) => {
      if (argv[0] === "ps" && reads++ === 0) return { code: 0, out: listed }
      if (argv.slice(0, CWDS.length).join(" ") !== CWDS.join(" "))
        return fake(argv, timeoutMs, stdin)
      read = argv.at(-1)!
      return { code: 0, out: folders.map(([pid, dir]) => `p${pid}\nfcwd\nn${dir}\n`).join("") }
    }
    deps.sleep = async () => {}
    await nightlyClean(deps)(ctx)
    expect(read).toBe(`1500,${process.pid},61001,61002,61004,61005`)
    expect(runs.filter((r) => r[0] === "kill").map((r) => r.join(" "))).toEqual([
      "kill -TERM 61001",
    ])
    expect(readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")).toContain(
      `orphans: orphan pid 61001 ended by TERM (age 04:00:00, its test sandbox ${dirname(dirname(cwd("42fmjw-reviewer")))} gone): ${loop} (reapers: 1,1500)`,
    )
  })
})

// #1778: the stale worktrees of every other repo the factory works in, each a real git checkout under a fake code root and org folder, PRs, lsof and the roster faked
describe("other repos' worktrees", () => {
  const git = (cwd: string, ...args: string[]) => {
    const proc = Bun.spawnSync(
      ["git", "-c", "user.email=t@example.com", "-c", "user.name=t", "-C", cwd, ...args],
      { stderr: "pipe", stdout: "pipe" },
    )
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
    return proc.stdout.toString()
  }
  // A checkout at <dir> with a bare origin beside it, one pushed commit on main, and a .gitignore for build output and *.txt
  const repoAt = (dir: string) => {
    mkdirSync(dir, { recursive: true })
    git(dirname(dir), "init", "-q", "--bare", `${basename(dir)}-origin.git`)
    git(dir, "init", "-q", "-b", "main")
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env*\n*.txt\n")
    writeFileSync(join(dir, "a.ts"), "a\n")
    git(dir, "add", ".")
    git(dir, "commit", "-qm", "one")
    git(dir, "remote", "add", "origin", join(dirname(dir), `${basename(dir)}-origin.git`))
    git(dir, "push", "-q", "origin", "main")
    return dir
  }
  // A worktree of repo at .claude/worktrees/<name> on branch <name>, with a commit of its own that is pushed or not
  const worktreeOf = (repo: string, name: string, pushed: boolean) => {
    const path = join(repo, ".claude", "worktrees", name)
    git(repo, "worktree", "add", "-q", path, "-b", name)
    writeFileSync(join(path, `${name}.ts`), "b\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", name)
    if (pushed) git(path, "push", "-q", "origin", name)
    return path
  }

  const night = (answers: Record<string, string> = {}) => {
    const root = scratch()
    const data = join(root, "data")
    const ops = join(data, "ops")
    mkdirSync(join(ops, "log"), { recursive: true })
    const code = join(root, "code")
    const orgs = join(root, "home", "acme")
    const main = join(code, "playground")
    mkdirSync(join(main, ".git"), { recursive: true })
    mkdirSync(join(main, ".claude", "worktrees", "own"), { recursive: true })
    const app = repoAt(join(code, "app"))
    const site = repoAt(join(orgs, "site"))
    const lost = repoAt(join(root, "elsewhere", "lost"))
    const w = {
      branched: worktreeOf(app, "branched", true),
      done: worktreeOf(app, "done", true),
      dirty: worktreeOf(app, "dirty", true),
      held: worktreeOf(app, "held", true),
      ignored: worktreeOf(app, "ignored", true),
      lost: worktreeOf(lost, "lost", true),
      open: worktreeOf(app, "open", true),
      pushed: worktreeOf(site, "pushed", true),
      rostered: worktreeOf(app, "rostered", true),
      unpushed: worktreeOf(site, "unpushed", false),
      untracked: worktreeOf(app, "untracked", true),
    }
    mkdirSync(join(w.done, "node_modules", "x"), { recursive: true })
    writeFileSync(join(w.done, ".env.local"), "A=1\n")
    writeFileSync(join(w.dirty, "a.ts"), "changed\n")
    writeFileSync(join(w.ignored, "notes.txt"), "mine\n")
    writeFileSync(join(w.untracked, "new.ts"), "c\n")
    writeFileSync(
      join(data, "roster.json"),
      JSON.stringify({
        agents: [
          { name: "abc123-worker", worktree: w.rostered },
          { name: "def456-worker", branch: "branched" },
        ],
      }),
    )
    const fake = fakeRun({
      "docker ps": "",
      "docker system df": JSON.stringify({ Volumes: [] }),
      lsof: `p1\nfcwd\nn${root}\np2\nfcwd\nn${join(w.held, "src")}\n`,
      "worktree list": `worktree ${main}\nHEAD a\nbranch refs/heads/main`,
      ...answers,
    })
    // git runs for real in every scratch checkout but Playground's own, whose reads the fakes answer as the other rows do
    const runs: string[][] = []
    const run: Context["run"] = async (argv, timeoutMs, stdin) => {
      runs.push(argv)
      if (argv[0] !== "git" || argv[1] !== "-C" || !argv[2]!.startsWith(root) || argv[2] === main)
        return fake.run(argv, timeoutMs, stdin)
      const proc = Bun.spawnSync(argv, { stderr: "pipe", stdout: "pipe" })
      return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() }
    }
    const sent: { text: string; to: string }[] = []
    const ctx: Context = {
      now: new Date("2026-11-11T03:00:00Z"),
      ops,
      repo: main,
      run,
      send: async (to, text) => {
        sent.push({ text, to })
        return true
      },
    }
    const cleanup: CleanupDeps = {
      containers: async () => [],
      devStop: async () => ({ ok: true, out: "" }),
      finished: async () => false,
      git: async () => "",
      held: async () => null,
      live,
      liveBranch: "live/dashboard",
      main,
      removeContainer: async () => true,
      rm: async () => ({ ok: true, out: "" }),
    }
    const prsByRepo: Record<string, Prs> = {
      [app]: prsOf({
        branched: pr("MERGED"),
        dirty: pr("MERGED"),
        done: pr("MERGED"),
        held: pr("MERGED"),
        ignored: pr("CLOSED"),
        open: pr("OPEN"),
        rostered: pr("MERGED"),
        untracked: pr("MERGED"),
      }),
      [site]: prsOf({}),
    }
    const deps = {
      cleanup: async () => cleanup,
      free: () => 100 * 1024 ** 3,
      now: () => Date.now(),
      prs: async (_ctx: Context, _branches: string[], _numbers: number[], dir?: string) =>
        (dir && prsByRepo[dir]) || prsOf({}),
      live: async () => [],
      roots: async () => [code, orgs],
      sleep: async () => {},
      temps: () => [],
      trashRoots: () => ({ home: root, main, trash: join(root, "trash") }),
      turbo: join(root, "turbo"),
      unused: async () => [],
    } as NightDeps
    return { ctx, data, deps, lost, main, ops, runs, sent, site, w }
  }
  const outbox = (sent: { text: string; to: string }[]) =>
    sent.find((s) => s.to === "ops")?.text ?? ""

  test("a worktree that passes all three tests is removed by git worktree remove, its branch kept", async () => {
    const { ctx, deps, runs, sent, w } = night()
    await nightlyClean(deps)(ctx)
    for (const path of [w.done, w.pushed]) {
      expect(existsSync(path)).toBe(false)
      expect(outbox(sent)).toContain(`worktree ${path} by git worktree remove`)
    }
    expect(git(dirname(dirname(dirname(w.done))), "branch", "--list", "done")).toContain("done")
    expect(runs.some((r) => r.includes("--force"))).toBe(false)
  })

  test("a worktree that fails a test is kept, its reason in the outbox line", async () => {
    const { ctx, deps, sent, w } = night()
    await nightlyClean(deps)(ctx)
    const kept: [string, string][] = [
      [w.open, "its PR is open"],
      [w.untracked, "uncommitted work"],
      [w.dirty, "uncommitted work"],
      [w.ignored, "ignored files outside build output: notes.txt"],
      [w.held, "a live process works in it"],
      [w.rostered, "the roster names it"],
    ]
    for (const [path, why] of kept) {
      expect(existsSync(path)).toBe(true)
      expect(outbox(sent)).toContain(`worktree ${path} kept: ${why}`)
    }
  })

  // A commit of its own in a worktree, holding the file <name>
  const commitIn = (path: string, name: string) => {
    writeFileSync(join(path, name), "c\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", name)
  }
  const unlanded = (path: string) =>
    git(path, "rev-list", "HEAD", "--not", "--remotes").trim().split("\n")
  // The archive folder of a worktree of site at its HEAD, and the commit each of its patches' From line names
  const archiveOf = (data: string, path: string) =>
    join(
      data,
      "scratchpad",
      "archive",
      "site",
      `${basename(path)}-${unlanded(path)[0]!.slice(0, 7)}`,
    )
  const patchesIn = (dir: string) =>
    readdirSync(dir).map((f) => /^From ([0-9a-f]+) /.exec(readFileSync(join(dir, f), "utf8"))?.[1])

  // #1962
  test("a worktree with no PR and commits no remote holds is archived by git format-patch under the data folder's scratchpad/archive, then removed with its branch kept", async () => {
    const { ctx, data, deps, sent, site, w } = night()
    commitIn(w.unpushed, "more.ts")
    const shas = unlanded(w.unpushed)
    expect(shas).toHaveLength(2)
    const archive = archiveOf(data, w.unpushed)
    const wip = worktreeOf(site, "wip", false)
    writeFileSync(join(wip, "new.ts"), "c\n")
    // the controls: an open PR's tree and a live session's, each with a commit no remote holds
    for (const path of [w.open, w.held, w.rostered]) commitIn(path, "local.ts")
    await nightlyClean(deps)(ctx)
    expect(existsSync(w.unpushed)).toBe(false)
    expect(patchesIn(archive).sort()).toEqual([...shas].sort())
    expect(outbox(sent)).toContain(
      `worktree ${w.unpushed} by git worktree remove, its branch unpushed kept, its 2 commits no remote holds archived at ${archive}`,
    )
    expect(git(site, "branch", "--list", "unpushed")).toContain("unpushed")
    expect(existsSync(wip)).toBe(true)
    expect(outbox(sent)).toContain(`worktree ${wip} kept: uncommitted work`)
    expect(existsSync(archiveOf(data, wip))).toBe(false)
    for (const [path, why] of [
      [w.open, "its PR is open"],
      [w.held, "a live process works in it"],
      [w.rostered, "the roster names it"],
    ] as const) {
      expect(existsSync(path)).toBe(true)
      expect(outbox(sent)).toContain(`worktree ${path} kept: ${why}`)
    }
    expect(readdirSync(join(data, "scratchpad", "archive", "site"))).toEqual([basename(archive)])
    expect(existsSync(join(data, "scratchpad", "archive", "app"))).toBe(false)
  })

  // #1962
  test("a worktree whose archive fails to write, or holds patches other than its commits no remote holds, is kept, the outbox line naming why", async () => {
    const failed = night()
    mkdirSync(join(failed.data, "scratchpad"), { recursive: true })
    writeFileSync(join(failed.data, "scratchpad", "archive"), "")
    await nightlyClean(failed.deps)(failed.ctx)
    expect(existsSync(failed.w.unpushed)).toBe(true)
    expect(outbox(failed.sent)).toContain(
      `worktree ${failed.w.unpushed} kept: it has no PR and a commit no remote holds, and its archive at ${archiveOf(failed.data, failed.w.unpushed)} failed to write`,
    )

    const { ctx, data, deps, sent, site, w } = night()
    // a merge commit, which git format-patch writes no patch for
    const side = git(site, "commit-tree", "-p", "main", "-m", "side", "main^{tree}").trim()
    git(w.unpushed, "merge", "-q", "--no-ff", "-m", "merge", side)
    const merged = archiveOf(data, w.unpushed)
    // archive folders already there, one short of the tree's commits and one of another commit, which the step reads and never writes over
    const stale = worktreeOf(site, "stale", false)
    commitIn(stale, "two.ts")
    const short = archiveOf(data, stale)
    mkdirSync(short, { recursive: true })
    writeFileSync(
      join(short, "0001-one.patch"),
      `From ${unlanded(stale)[1]} Mon Sep 17 00:00:00 2001\n`,
    )
    const other = worktreeOf(site, "other", false)
    const wrong = archiveOf(data, other)
    mkdirSync(wrong, { recursive: true })
    writeFileSync(
      join(wrong, "0001-other.patch"),
      `From ${"0".repeat(40)} Mon Sep 17 00:00:00 2001\n`,
    )
    await nightlyClean(deps)(ctx)
    expect(existsSync(w.unpushed)).toBe(true)
    expect(outbox(sent)).toContain(
      `worktree ${w.unpushed} kept: it has no PR and a commit no remote holds, and its archive at ${merged} holds 2 patches, 2 of its 3 commits no remote holds`,
    )
    expect(existsSync(stale)).toBe(true)
    expect(outbox(sent)).toContain(
      `worktree ${stale} kept: it has no PR and a commit no remote holds, and its archive at ${short} holds 1 patch, 1 of its 2 commits no remote holds`,
    )
    expect(existsSync(other)).toBe(true)
    expect(outbox(sent)).toContain(
      `worktree ${other} kept: it has no PR and a commit no remote holds, and its archive at ${wrong} holds 1 patch, 0 of its 1 commit no remote holds`,
    )
    expect(readdirSync(short)).toEqual(["0001-one.patch"])
    expect(readdirSync(wrong)).toEqual(["0001-other.patch"])
  })

  // #2132: a remote-tracking ref is the remote's branch as last fetched, so the step reads the remote itself
  test("a worktree with no PR whose remote branch was deleted since, its tracking ref kept, has its commit archived before it goes", async () => {
    const { ctx, data, deps, sent, site, w } = night()
    const head = git(w.pushed, "rev-parse", "HEAD").trim()
    git(
      dirname(site),
      "--git-dir",
      join(dirname(site), "site-origin.git"),
      "branch",
      "-D",
      "pushed",
    )
    expect(git(w.pushed, "rev-parse", "refs/remotes/origin/pushed").trim()).toBe(head)
    const archive = join(data, "scratchpad", "archive", "site", `pushed-${head.slice(0, 7)}`)
    await nightlyClean(deps)(ctx)
    expect(existsSync(w.pushed)).toBe(false)
    expect(patchesIn(archive)).toEqual([head])
    expect(outbox(sent)).toContain(
      `worktree ${w.pushed} by git worktree remove, its branch pushed kept, its 1 commit no remote holds archived at ${archive}`,
    )
  })

  // #2132: a remote the step cannot read tells it nothing, so the tree stays for a night it can
  test("a worktree with no PR whose remote cannot be read is kept, the outbox line naming the remote", async () => {
    const { ctx, data, deps, sent, site, w } = night()
    git(site, "remote", "set-url", "origin", join(dirname(site), "gone.git"))
    await nightlyClean(deps)(ctx)
    expect(existsSync(w.pushed)).toBe(true)
    expect(outbox(sent)).toContain(
      `worktree ${w.pushed} kept: it has no PR and its remote origin cannot be read`,
    )
    expect(existsSync(join(data, "scratchpad", "archive", "site"))).toBe(false)
  })

  test("a worktree whose branch a roster row's branch names is kept, though no roster text holds its path", async () => {
    const { ctx, deps, sent, w } = night()
    await nightlyClean(deps)(ctx)
    expect(existsSync(w.branched)).toBe(true)
    expect(outbox(sent)).toContain(`worktree ${w.branched} kept: the roster names it`)
  })

  test("an lsof the step cannot read names the step's early exit and removes nothing", async () => {
    const { ctx, deps, ops, w } = night({ lsof: "" })
    await nightlyClean(deps)(ctx)
    expect(readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")).toContain(
      "other repos: lsof unreadable, none removed",
    )
    expect(existsSync(w.done)).toBe(true)
    expect(existsSync(w.pushed)).toBe(true)
  })

  test("a roster the step cannot read names the step's early exit and removes nothing", async () => {
    const { ctx, data, deps, ops, w } = night()
    writeFileSync(join(data, "roster.json"), "not json")
    await nightlyClean(deps)(ctx)
    expect(readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")).toContain(
      "other repos: the roster unreadable, none removed",
    )
    expect(existsSync(w.done)).toBe(true)
    expect(existsSync(w.pushed)).toBe(true)
  })

  test("PRs the step cannot read name the repo's early exit and keep its worktrees", async () => {
    const { ctx, deps, ops, w } = night()
    deps.prs = async () => null
    await nightlyClean(deps)(ctx)
    const log = readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")
    expect(log).toContain("GitHub unreadable, none read")
    expect(existsSync(w.done)).toBe(true)
    expect(existsSync(w.pushed)).toBe(true)
  })

  test("a repo outside the code root and the org folders is never read", async () => {
    const { ctx, deps, lost, runs, sent, w } = night()
    await nightlyClean(deps)(ctx)
    expect(existsSync(w.lost)).toBe(true)
    expect(runs.some((r) => r.some((a) => a.startsWith(lost)))).toBe(false)
    expect(outbox(sent)).not.toContain(lost)
  })

  test("Playground's own checkout is never read by the new step", async () => {
    const { ctx, deps, main, runs } = night()
    await nightlyClean(deps)(ctx)
    expect(existsSync(join(main, ".claude", "worktrees", "own"))).toBe(true)
    expect(runs.some((r) => r.some((a) => a.startsWith(join(main, ".claude"))))).toBe(false)
    expect(runs.some((r) => r.includes("remove") && r.includes(main))).toBe(false)
  })
})

test("a worktree's work: a change or untracked file, else an ignored path outside build output", () => {
  expect(
    workIn("!! node_modules/\n!! web/next/.next/\n!! .env.local\n!! __pycache__/\n"),
  ).toBeUndefined()
  expect(workIn(" M a.ts\n!! node_modules/\n")).toBe("uncommitted work")
  expect(workIn("?? new.ts\n")).toBe("uncommitted work")
  expect(workIn("!! dist/\n!! notes.txt\n!! keys/\n")).toBe(
    "ignored files outside build output: notes.txt, keys",
  )
})

test("the folders other repos are read in: the code root, else the checkout's folder, and ~/<org> for each org ext.links guards", () => {
  const settings = (values: Record<string, unknown>) => ({ schemaVersion: 1 as const, values })
  expect(rootsOf(settings({}), "/code/playground", "/home/me")).toEqual(["/code"])
  expect(
    rootsOf(
      settings({ "ext.links": { acme: ["acme", "*"] }, "paths.codeRoot": "/srv/src" }),
      "/code/playground",
      "/home/me",
    ),
  ).toEqual(["/srv/src", "/home/me/acme"])
})

// A data folder in a fake HOME with the given roster rows and live sessions, whose night runs the gone sessions step through safe-delete's real quarantine; run returns the ops line.
const goneNight = (agents: object[], live: string[]) => {
  const root = scratch()
  const home = join(root, "home")
  const data = join(home, ".playground")
  const ops = join(data, "ops")
  const main = join(root, "main")
  mkdirSync(join(ops, "log"), { recursive: true })
  mkdirSync(join(data, "scratch"), { recursive: true })
  mkdirSync(join(data, "trash"), { recursive: true })
  mkdirSync(main, { recursive: true })
  writeFileSync(join(data, "roster.json"), JSON.stringify({ agents }))
  const roots = { home, main, trash: join(data, "trash") }
  const { run } = fakeRun({
    "docker ps": "",
    "docker system df": JSON.stringify({ Volumes: [] }),
  })
  const sent: { text: string; to: string }[] = []
  const ctx: Context = {
    now: new Date("2026-11-11T03:00:00Z"),
    ops,
    repo: main,
    run,
    send: async (to, text) => {
      sent.push({ text, to })
      return true
    },
  }
  const deps = {
    cleanup: async () => null,
    free: () => 100 * 1024 ** 3,
    live: async () => live,
    now: () => Date.now(),
    prs: async () => prsOf({}),
    roots: async () => [],
    sleep: async () => {},
    temps: () => [],
    trashRoots: () => roots,
    turbo: join(root, "turbo"),
    unused: async () => [],
  } as NightDeps
  return {
    roots,
    run: async () => {
      await nightlyClean(deps)(ctx)
      return sent.find((s) => s.to === "ops")?.text ?? ""
    },
    scratch: (name: string) => join(data, "scratch", name),
  }
}

// #1778's add: a gone session's scratch folder in the data folder, through safe-delete's quarantine with its gone option, no carve-out
test("a scratch folder no live session and no roster row but an ended one names goes to the trash; a live session's and a working row's stay", async () => {
  const night = goneNight(
    [
      { name: "cc3ddd-worker", status: "working" },
      { name: "ee4fff-worker", status: "ended" },
    ],
    ["aa2bbb-worker"],
  )
  const pad = (name: string) => {
    const path = night.scratch(name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, "notes.md"), "x\n")
    return path
  }
  const gone = pad("qq1zzz-1700")
  const alive = pad("aa2bbb-1701")
  const rostered = pad("cc3ddd")
  const ended = pad("ee4fff-1702")
  const line = await night.run()
  expect(existsSync(gone)).toBe(false)
  expect(existsSync(ended)).toBe(false)
  expect(existsSync(alive)).toBe(true)
  expect(existsSync(rostered)).toBe(true)
  expect(line).toMatch(new RegExp(`scratch ${gone} as trash \\d{8}T\\d{6}Z-qq1zzz-1700/1 `))
  expect(line).not.toContain(alive)
  expect(line).not.toContain(rostered)
})

// #2088: a loose <id>-* file a gone session left in scratch/ goes the same way, restorable; a live session's file and a file with no <id>- lead stay
test("a gone session's loose scratch file goes to the trash and comes back; a live session's file and one with no <id>- lead stay", async () => {
  const night = goneNight([{ name: "cc3ddd-worker", status: "working" }], ["aa2bbb-worker"])
  const loose = (name: string) => {
    const path = night.scratch(name)
    writeFileSync(path, "<html></html>\n")
    return path
  }
  const gone = loose("qq1zzz-page.html")
  const alive = loose("aa2bbb-page.html")
  const rostered = loose("cc3ddd-notes.md")
  const bare = loose("notes.txt")
  const line = await night.run()
  expect(existsSync(gone)).toBe(false)
  for (const path of [alive, rostered, bare]) {
    expect(existsSync(path)).toBe(true)
    expect(line).not.toContain(path)
  }
  const id = new RegExp(`scratch ${gone} as trash (\\S+) `).exec(line)?.[1]
  expect(id).toMatch(/^\d{8}T\d{6}Z-qq1zzz-page-html\/1$/)
  expect(restore(id!, night.roots)).toEqual({ path: gone })
  expect(readFileSync(gone, "utf8")).toBe("<html></html>\n")
})

// #2088's add: a gone session's scratch folder past the 5,000-file tripwire goes whole under the 2 GB cap; a live session's stays
test("a gone session's scratch folder past 5,000 files goes to the trash whole; a live session's stays", async () => {
  const night = goneNight([], ["aa2bbb-worker"])
  const big = (name: string) => {
    const path = night.scratch(name)
    mkdirSync(join(path, "canary"), { recursive: true })
    for (let i = 0; i <= 5000; i++) writeFileSync(join(path, "canary", String(i)), "")
    return path
  }
  const gone = big("qq1zzz-worker")
  const alive = big("aa2bbb-worker")
  const line = await night.run()
  expect(existsSync(gone)).toBe(false)
  expect(existsSync(alive)).toBe(true)
  expect(line).toMatch(new RegExp(`scratch ${gone} as trash \\d{8}T\\d{6}Z-qq1zzz-worker/1 `))
  expect(line).not.toContain(alive)
})
