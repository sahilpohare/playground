import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import {
  bytesOf,
  discardable,
  nightlyClean,
  type NightDeps,
  type Pr,
  type Prs,
  pruneTurbo,
  readPrs,
  rootsOf,
  staleBranches,
  staleContainers,
  staleVolumes,
  staleWorktrees,
  trashIdOf,
  trashSince,
  workIn,
  worktreesIn,
} from "../../../../../packages/scripts/src/ops-tick/nightly-clean"
import { BEATS, type Context } from "../../../../../packages/scripts/src/ops-tick/tick"
import type { CleanupDeps } from "../../../../../scripts/ops/optimizer/auto_end"
import { type Answers, fakeRun, ghErrors } from "./fake-run"

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

  test("a kept line is trashed under the standing approval only for work it may drop", () => {
    expect(discardable("kept /w: uncommitted work")).toBe(true)
    expect(discardable("kept /w: unpushed commits")).toBe(true)
    expect(discardable("kept /w: could not count its unpushed commits")).toBe(false)
    expect(
      discardable(
        "kept /w: /w's HEAD holds work not landed on origin/canary (fetch origin canary if it merged since): playground rm --worktree /w --discard removes it anyway, which a session runs as it is once the worktree's PR has merged or closed, else with --decision <id> once an Inbox delete decision naming it is approved",
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
    local: ["PG-1-merged", "PG-2-squashed"],
    remote: ["PG-7-remote"],
  })
})

test("containers: an exited worktree container whose folder is gone goes; the live dashboard's, pglaunch's, a Vibeground copy, a running one and one whose folder stands stay", () => {
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
      "ask new": ID,
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
      trashRoots: () => ({ home: "/nowhere", main: "/nowhere", trash: "/nowhere" }),
      turbo: join(root, "turbo"),
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
    expect(inputs.map((i) => JSON.parse(i).kind)).toEqual(["update"])
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
    expect(inputs.map((i) => JSON.parse(i).kind)).toEqual(["update"])
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
    expect(inputs.map((i) => JSON.parse(i).kind)).toEqual(["update"])
    expect(JSON.parse(readFileSync(join(ops, "tick", "nightly-clean.json"), "utf8"))).toEqual({
      at: "2026-11-05T03:00:00.000Z",
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
    expect(inputs.map((i) => JSON.parse(i).kind)).toEqual(["update"])
    const line = sent.find((s) => s.to === "ops")
    expect(line?.text).toContain(
      `worktree ${wt("pg-2")} as trash 20261108T030000Z-shell/1 (playground rm --restore 20261108T030000Z-shell/1)`,
    )
  })

  // issue 1554: rm refuses the 4th trash move in a minute ("quarantined 3 paths in the last minute, the most one session may"), and the beat counted that refusal as done, so 7 of 10 stale worktrees stayed behind with no line naming them for the next run; the beat paces under the cap, waiting out the minute on the injected sleep, under a total-wait bound, and names anything the bound leaves
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
            out: "nightly-clean quarantined 3 paths in the last minute, the most one session may\n",
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
      trashRoots: () => ({ home: "/nowhere", main: "/nowhere", trash: "/nowhere" }),
      turbo: join(root, "turbo"),
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
              out: "playground: shell quarantined 3 paths in the last minute, the most one session may",
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
      trashRoots: () => ({ home: "/nowhere", main: "/nowhere", trash: "/nowhere" }),
      turbo: join(root, "turbo"),
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
        err: "nightly-clean quarantined 3 paths in the last minute, the most one session may\n",
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
      trashRoots: () => ({ home: "/nowhere", main: "/nowhere", trash: "/nowhere" }),
      turbo: join(root, "turbo"),
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
      trashRoots: () => ({ home: "/nowhere", main: "/nowhere", trash: "/nowhere" }),
      turbo: join(root, "turbo"),
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
    expect(readFileSync(join(ops, "log", "nightly-clean.log"), "utf8")).not.toContain("scratch")
    expect(sent.find((s) => s.to === "ops")?.text ?? "").not.toContain("scratch")
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
    expect(inputs.map((i) => JSON.parse(i).kind)).toEqual(["update"])
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
    expect(inputs.map((i) => JSON.parse(i).kind)).toEqual(["update"])
  })

  test("a night that frees under 1 GB posts no update", async () => {
    const { ctx, deps, inputs } = night(leftovers(), undefined, 0.01)
    await nightlyClean(deps)(ctx)
    expect(inputs).toEqual([])
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
    }
    mkdirSync(join(w.done, "node_modules", "x"), { recursive: true })
    writeFileSync(join(w.done, ".env.local"), "A=1\n")
    writeFileSync(join(w.dirty, "a.ts"), "changed\n")
    writeFileSync(join(w.ignored, "notes.txt"), "mine\n")
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
      trashRoots: () => ({ home: root, main, trash: join(root, "trash") }),
      turbo: join(root, "turbo"),
    } as NightDeps
    return { ctx, data, deps, lost, main, ops, runs, sent, w }
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
      [w.unpushed, "it has no PR and a commit no remote holds"],
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

// #1778's add: a gone session's scratch folder in the data folder, through safe-delete's quarantine with that session's own-scratch route, no carve-out
test("a scratch folder no live session and no roster row but an ended one names goes to the trash; a live session's and a working row's stay", async () => {
  const root = scratch()
  const home = join(root, "home")
  const data = join(home, ".playground")
  const ops = join(data, "ops")
  const main = join(root, "main")
  mkdirSync(join(ops, "log"), { recursive: true })
  mkdirSync(join(data, "trash"), { recursive: true })
  mkdirSync(main, { recursive: true })
  const pad = (name: string) => {
    const path = join(data, "scratch", name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, "notes.md"), "x\n")
    return path
  }
  const gone = pad("qq1zzz-1700")
  const alive = pad("aa2bbb-1701")
  const rostered = pad("cc3ddd")
  const ended = pad("ee4fff-1702")
  writeFileSync(
    join(data, "roster.json"),
    JSON.stringify({
      agents: [
        { name: "cc3ddd-worker", status: "working" },
        { name: "ee4fff-worker", status: "ended" },
      ],
    }),
  )
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
    live: async () => ["aa2bbb-worker"],
    now: () => Date.now(),
    prs: async () => prsOf({}),
    roots: async () => [],
    sleep: async () => {},
    trashRoots: () => ({ home, main, trash: join(data, "trash") }),
    turbo: join(root, "turbo"),
  } as NightDeps
  await nightlyClean(deps)(ctx)
  expect(existsSync(gone)).toBe(false)
  expect(existsSync(ended)).toBe(false)
  expect(existsSync(alive)).toBe(true)
  expect(existsSync(rostered)).toBe(true)
  const line = sent.find((s) => s.to === "ops")?.text ?? ""
  expect(line).toMatch(new RegExp(`scratch ${gone} as trash \\d{8}T\\d{6}Z-qq1zzz-1700/1 `))
  expect(line).not.toContain(alive)
  expect(line).not.toContain(rostered)
})
