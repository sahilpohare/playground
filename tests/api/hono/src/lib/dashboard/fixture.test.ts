import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"

import {
  checkoutRoot,
  configDir,
  dashboardSource,
  DASHBOARD_RULES,
  dropFixture,
  ensureFixture,
  type Fixture,
  fixtureDir,
  fixtureHerdrInput,
  launcherRuns,
  loadFixture,
  markLaunched,
  readFixtureHerdr,
  writeFixture,
} from "../../../../../../api/hono/src/lib/dashboard/fixture"
import { parseLines } from "../../../../../../api/hono/src/lib/dashboard/transcript"
import { livePair } from "../../../../../../api/hono/src/lib/dev/live-dashboard"
import { priceOf } from "../../../../../../api/hono/src/lib/usage/prices"
import { listTrash } from "../../../../../../packages/safe-delete/src"
import {
  cleanGitShims,
  gitShim,
  inFixture,
  onLiveDashboard,
  throughShim,
} from "../../../../../dashboard-fixture"

const LIVE_DASHBOARD_BRANCH = livePair().branch

const ROOT = "/checkout"
const dirs: string[] = []
const scratch = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  dirs.push(dir)
  return dir
}
// The folders a fixture's move into the trash starts from, on a mkdtemp root of the test's own that holds no fixture: a test that moves one takes its own, so no test meets another's 3-a-minute tripwire.
const freshRoots = () => {
  const root = scratch("fixture-roots")
  return { home: join(root, "home"), main: join(root, "main"), trash: join(root, "data", "trash") }
}
const ROOTS = freshRoots()
const trashed = (roots: { trash: string }) => listTrash(roots.trash).map((entry) => entry.path)

afterAll(() => {
  cleanGitShims()
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
})

const shipped = (): Fixture => {
  const loaded = loadFixture(null)
  if (!loaded.ok) throw new Error(loaded.error)
  return loaded.fixture
}

// A made-up herdr server of two panes in one workspace: one idle at its input box, its messages going to a transcript, and one blocked on a picker.
const HERDR_SESSION = "11111111-1111-4111-8111-0000000000a1"
const HERDR_TRANSCRIPT = `projects/-fixture-playground/${HERDR_SESSION}.jsonl`
const withHerdr = (): Fixture => {
  const base = shipped()
  const pane = (id: string, status: string, pid: number) => ({
    agent_session: { kind: "id", value: HERDR_SESSION },
    agent_status: status,
    pane_id: id,
    processes: [{ argv: ["claude", "-n", "ada"], cwd: "/fixture/playground", pid }],
    scroll: { offset_from_bottom: 0 },
    terminal_id: `t-${id}`,
    workspace_id: "w1",
  })
  return {
    ...base,
    files: { ...base.files, [HERDR_TRANSCRIPT]: [] },
    herdr: {
      panes: [
        {
          ...pane("w1:p1", "idle", 910001),
          session_id: HERDR_SESSION,
          transcript_path: `$CONFIG/${HERDR_TRANSCRIPT}`,
        },
        pane("w1:p2", "blocked", 910002),
      ],
      prompts: { "w1:p2": "Which colour?\n❯ 1. Teal\n  2. Plum\n  3. Type something." },
      screens: { "w1:p1": "● Done.", "w1:p2": "● Asking." },
      workspaces: [{ label: "Builder", workspace_id: "w1" }],
    },
  }
}

describe("dashboardSource", () => {
  // A person's own clone, outside any factory folder; FACTORY is a worker's worktree.
  const OWN = "/home/me/dispatcher"
  const FACTORY = "/home/me/dispatcher/.claude/worktrees/pg-1"
  const source = (branch: string | null, env: Record<string, string> = {}, root: string = ROOT) =>
    dashboardSource({ branch, env, root })

  test("rule 0: a hosted build reads no machine, whatever else is set", () => {
    const anything: Record<string, string>[] = [
      {},
      { PLAYGROUND_LIVE_READS: "1" },
      { PLAYGROUND_FIXTURE: "mine.json" },
      { PLAYGROUND_ROLE: "worker" },
      { NODE_ENV: "test" },
      { CLAUDECODE: "1" },
    ]
    for (const env of anything) {
      for (const branch of [LIVE_DASHBOARD_BRANCH, "feat/a", null]) {
        expect(source(branch, { ...env, PLAYGROUND_HOSTED: "1" }, OWN)).toEqual({ kind: "hosted" })
        expect(source(branch, { ...env, PLAYGROUND_HOSTED: "true" }, FACTORY)).toEqual({
          kind: "hosted",
        })
      }
    }
    expect(source("feat/a", { PLAYGROUND_HOSTED: "0" }, OWN)).toEqual({ kind: "live", rule: "own" })
    expect(() => ensureFixture({ kind: "hosted" })).toThrow("reads no machine")
  })

  test("rule 1: the live dashboard's checkout reads the live machine, and never a fixture", () => {
    expect(source(LIVE_DASHBOARD_BRANCH)).toEqual({ kind: "live", rule: "live-branch" })
    expect(source(LIVE_DASHBOARD_BRANCH, { PLAYGROUND_LIVE_READS: "1" })).toEqual({
      kind: "live",
      rule: "live-branch",
    })
    // as today, whatever else is set: a worktree path, a role, a test run, Claude Code
    const others: Record<string, string>[] = [
      { PLAYGROUND_ROLE: "runner" },
      { NODE_ENV: "test" },
      { NODE_ENV: "test", PLAYGROUND_FIXTURE: "mine.json" },
      { CLAUDECODE: "1" },
    ]
    for (const env of others) {
      expect(source(LIVE_DASHBOARD_BRANCH, env, FACTORY)).toEqual({
        kind: "live",
        rule: "live-branch",
      })
    }
    const refused = source(LIVE_DASHBOARD_BRANCH, { PLAYGROUND_FIXTURE: "mine.json" })
    expect(refused.kind).toBe("refused")
  })

  test("rule 2: PLAYGROUND_LIVE_READS opts in to the live machine anywhere, and refuses a fixture beside it", () => {
    for (const value of ["1", "true", "TRUE"]) {
      expect(source("feat/a", { PLAYGROUND_LIVE_READS: value })).toEqual({
        kind: "live",
        rule: "live-reads",
      })
    }
    // a probe test of a dashboard write runs from a worker's worktree, with its role set
    expect(
      source("feat/a", { PLAYGROUND_LIVE_READS: "1", PLAYGROUND_ROLE: "worker" }, FACTORY),
    ).toEqual({
      kind: "live",
      rule: "live-reads",
    })
    expect(
      source("feat/a", { PLAYGROUND_FIXTURE: "x.json", PLAYGROUND_LIVE_READS: "1" }).kind,
    ).toBe("refused")
    // a live-reads test keeps reading the live paths when a dev fixture is left in .env (backlog 162)
    expect(
      source("feat/a", {
        PLAYGROUND_FIXTURE: "x.json",
        PLAYGROUND_LIVE_READS: "1",
        NODE_ENV: "test",
      }),
    ).toEqual({ kind: "live", rule: "live-reads" })
  })

  test("rule 3: a test run reads the shipped fixture, ignoring the worktree's PLAYGROUND_FIXTURE", () => {
    expect(source("feat/a", { NODE_ENV: "test" }, OWN)).toEqual({
      file: null,
      kind: "fixture",
      rule: "test",
    })
    expect(source("feat/a", { CLAUDECODE: "1", NODE_ENV: "test" }, OWN).kind).toBe("fixture")
    // a dev stack's fixture named in .env never reaches the suite, which reads only the shipped one (backlog 162)
    expect(
      source("feat/a", { NODE_ENV: "test", PLAYGROUND_FIXTURE: "dashboard-custom.json" }, OWN),
    ).toEqual({
      file: null,
      kind: "fixture",
      rule: "test",
    })
  })

  test("rule 4: PLAYGROUND_FIXTURE names another fixture, relative to the checkout or absolute, or the shipped one", () => {
    expect(source("feat/a", { PLAYGROUND_FIXTURE: "fixtures/mine.json" })).toEqual({
      file: "/checkout/fixtures/mine.json",
      kind: "fixture",
      rule: "fixture",
    })
    expect(source("feat/a", { PLAYGROUND_FIXTURE: "/elsewhere/mine.json" })).toEqual({
      file: "/elsewhere/mine.json",
      kind: "fixture",
      rule: "fixture",
    })
    expect(source("feat/a", { PLAYGROUND_FIXTURE: "shipped" }, OWN)).toEqual({
      file: null,
      kind: "fixture",
      rule: "fixture",
    })
  })

  test("rule 5: a checkout under .claude/worktrees/, or a session with PLAYGROUND_ROLE, reads the fixture on any branch", () => {
    for (const branch of ["fix/dashboard-fixture", "main", null]) {
      expect(source(branch, {}, FACTORY)).toEqual({ file: null, kind: "fixture", rule: "factory" })
      expect(source(branch, { PLAYGROUND_ROLE: "worker" }, OWN)).toEqual({
        file: null,
        kind: "fixture",
        rule: "factory",
      })
    }
    // a scratch config folder never makes a factory stack read live, nor does Claude Code
    expect(
      source("feat/a", { CLAUDE_CONFIG_DIR: "/tmp/scratch", CLAUDECODE: "1" }, FACTORY),
    ).toEqual({ file: null, kind: "fixture", rule: "factory" })
    expect(source("feat/a", { PLAYGROUND_LIVE_READS: "0" }, FACTORY)).toEqual({
      file: null,
      kind: "fixture",
      rule: "factory",
    })
    // a folder that only looks like one is not
    expect(source("feat/a", {}, "/home/me/claude/worktrees/x").kind).toBe("live")
    expect(source("feat/a", {}, "/home/me/.claude/worktrees").kind).toBe("live")
    expect(source("feat/a", { PLAYGROUND_ROLE: " " }, OWN).kind).toBe("live")
  })

  test("rule 6: anything else, a person's own clone on any branch, reads their own machine", () => {
    for (const branch of ["main", "feat/a", null]) {
      expect(source(branch, {}, OWN)).toEqual({ kind: "live", rule: "own" })
    }
    expect(source("main", { NODE_ENV: "local" }, OWN)).toEqual({ kind: "live", rule: "own" })
  })

  test("rule 6 refuses under Claude Code with no role: an agent's stack never reads the live machine by default", () => {
    const refused = source("main", { CLAUDECODE: "1" }, OWN)
    expect(refused.kind).toBe("refused")
    if (refused.kind === "refused") {
      expect(refused.reason).toContain("Claude Code")
      expect(refused.reason).toContain("PLAYGROUND_FIXTURE=shipped")
    }
  })

  test("every rule has its words, for the launcher's printout", () => {
    for (const rule of [
      "factory",
      "fixture",
      "live-branch",
      "live-reads",
      "own",
      "test",
    ] as const) {
      expect(DASHBOARD_RULES[rule].length).toBeGreaterThan(0)
    }
  })
})

describe("branchOf's git read (#1367)", () => {
  const helper = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "..",
    "..",
    "api",
    "hono",
    "src",
    "lib",
    "dashboard",
    "fixture.ts",
  )

  test("gives up on a git that never answers, in seconds, and reads as no branch", async () => {
    const bin = await gitShim("exec sleep 30")
    const { ms, r } = await throughShim(bin, helper, "m.branchOf(process.env.ROOT)", {
      ROOT: scratch("branch-root"),
    })
    expect(r).toBe(null)
    expect(ms).toBeLessThan(10_000)
  })

  test("a git that answers after a pause still names the branch", async () => {
    const bin = await gitShim("sleep 1\necho live/dashboard")
    const { r } = await throughShim(bin, helper, "m.branchOf(process.env.ROOT)", {
      ROOT: scratch("branch-root"),
    })
    expect(r).toBe("live/dashboard")
  })

  // a wedged read answers as no branch but must not sit in the cache, so one slow git at startup cannot hide the live dashboard until restart
  test("a read that gave up is not cached: the next currentSource asks git again", async () => {
    const marker = join(scratch("branch-cache"), "asked")
    const bin = await gitShim(
      `if [ -f "$MARKER" ]; then echo live/dashboard; else touch "$MARKER"; exec sleep 30; fi`,
    )
    const { r } = await throughShim(bin, helper, "[m.currentSource(), m.currentSource()]", {
      MARKER: marker,
    })
    expect(r).toEqual([
      { file: null, kind: "fixture", rule: "test" },
      { kind: "live", rule: "live-branch" },
    ])
  })
})

describe("writeFixture", () => {
  const ANCHOR = "2026-01-01T12:00:00.000Z"
  const DAY = 86_400_000
  const small = (): Fixture => ({
    ...shipped(),
    anchor: ANCHOR,
    files: {
      "playground/usage.json": { at: ANCHOR, resets_at: 1_000, where: "$CONFIG/playground" },
      "report.json": { heading: "Linear · $WHEN{2026-01-01T11:30:00.000Z}" },
      "projects/p/s.jsonl": [{ timestamp: "2026-01-01T11:00:00.000Z" }],
    },
  })

  test("moves every time by the gap between the anchor and now, and makes $CONFIG its own folder", () => {
    const dir = join(scratch("fixture-write"), "fixture")
    writeFixture(small(), dir, ROOTS, new Date(Date.parse(ANCHOR) + DAY))
    const usage = JSON.parse(readFileSync(join(dir, "claude/playground/usage.json"), "utf8"))
    expect(usage).toEqual({
      at: "2026-01-02T12:00:00.000Z",
      resets_at: 1_000 + DAY / 1000,
      where: join(dir, "claude/playground"),
    })
    // a time written as prose, as a report's heading gives it, moves too
    expect(JSON.parse(readFileSync(join(dir, "claude/report.json"), "utf8"))).toEqual({
      heading: "Linear · Fri 2 Jan, 11:30 am UTC",
    })
    expect(readFileSync(join(dir, "claude/projects/p/s.jsonl"), "utf8")).toBe(
      '{"timestamp":"2026-01-02T11:00:00.000Z"}\n',
    )
    for (const folder of ["attachments"]) {
      expect(statSync(join(dir, "claude/playground", folder)).mode & 0o777).toBe(0o700)
    }
  })

  test("a relative PLAYGROUND_FIXTURE_DIR sits under the checkout's root, so the launcher and the API, run from different folders, name one folder; else a worktree's sits in its .turbo and a plain clone's in the temp folder, one per clone", () => {
    const root = checkoutRoot()
    if (!root) throw new Error("the tests run from a checkout")
    expect(fixtureDir({ PLAYGROUND_FIXTURE_DIR: "scratch/fx" })).toBe(join(root, "scratch/fx"))
    expect(fixtureDir({ PLAYGROUND_FIXTURE_DIR: "/elsewhere/fx" })).toBe("/elsewhere/fx")
    const worktree = scratch("fixture-worktree")
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere\n")
    expect(fixtureDir({}, worktree)).toBe(join(worktree, ".turbo", "dashboard-fixture"))
    const uid = process.getuid?.() ?? 0
    expect(fixtureDir({}, null, "/tmp-x")).toBe(`/tmp-x/playground-dashboard-fixture-${uid}`)
    const clone = scratch("fixture-plain")
    mkdirSync(join(clone, ".git"))
    expect(fixtureDir({}, clone, "/tmp-x")).toMatch(
      new RegExp(`^/tmp-x/playground-dashboard-fixture-${uid}-[0-9a-f]{8}$`),
    )
    const other = scratch("fixture-other")
    mkdirSync(join(other, ".git"))
    expect(fixtureDir({}, clone, "/tmp-x")).not.toBe(fixtureDir({}, other, "/tmp-x"))
  })

  test("the API the live Dashboard serves runs inside its checkout, so it reads the live machine and finds its migrations, never falling to a Docker image's fixture", () => {
    const root = checkoutRoot()
    if (!root) throw new Error("the tests run from a checkout")
    const script = JSON.parse(readFileSync(join(root, "api/hono/package.json"), "utf8")).scripts[
      "serve:app"
    ] as string
    const entry = (script.match(/(\S+)$/)?.[1] ?? "")
      .replaceAll('"', "")
      .replace("$PLAYGROUND_BUILD", scratch("served-build"))
    expect(checkoutRoot(dirname(resolve(root, "api/hono", entry)))).toBe(root)
  })

  test("a stack the launcher wrote a fixture for never writes it again once it is gone, so a process outliving the stop leaves nothing behind", () => {
    const dir = join(scratch("fixture-launched"), "fixture")
    const saved = {
      dir: process.env.PLAYGROUND_FIXTURE_DIR,
      launched: process.env.PLAYGROUND_FIXTURE_LAUNCHED,
    }
    process.env.PLAYGROUND_FIXTURE_DIR = dir
    try {
      process.env.PLAYGROUND_FIXTURE_LAUNCHED = "1"
      expect(() => ensureFixture({ file: null, kind: "fixture", rule: "factory" })).toThrow(
        "start it again",
      )
      expect(existsSync(dir)).toBe(false)
      delete process.env.PLAYGROUND_FIXTURE_LAUNCHED
      expect(ensureFixture({ file: null, kind: "fixture", rule: "factory" })).toBe(dir)
      expect(existsSync(dir)).toBe(true)
    } finally {
      for (const [key, value] of [
        ["PLAYGROUND_FIXTURE_DIR", saved.dir],
        ["PLAYGROUND_FIXTURE_LAUNCHED", saved.launched],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  // A worker's run on #665 read an old copy: ensureFixture returned once a stamp existed, so an edit to the fixture's source never reached the next run.
  // beside: a CLI in the checkout of a stack whose launcher runs ("live") or has gone ("gone").
  const edited = (launched: boolean, beside?: "gone" | "live") => {
    const root = scratch("fixture-newer")
    const dir = join(root, "fixture")
    const file = join(root, "source.json")
    const source = { file, kind: "fixture", rule: "fixture" } as const
    const saved = {
      dir: process.env.PLAYGROUND_FIXTURE_DIR,
      launched: process.env.PLAYGROUND_FIXTURE_LAUNCHED,
    }
    process.env.PLAYGROUND_FIXTURE_DIR = dir
    delete process.env.PLAYGROUND_FIXTURE_LAUNCHED
    try {
      writeFileSync(file, JSON.stringify({ ...shipped(), origin: "first" }))
      ensureFixture(source)
      const stamp = join(dir, "stamp.json")
      // The stamp goes back from its own mtime, the disk's clock, since the clock-ahead pass moves Date.now() and not the disk's.
      const back = new Date(statSync(stamp).mtimeMs - 60_000)
      utimesSync(stamp, back, back)
      if (beside === "live") markLaunched(dir)
      if (beside === "gone") {
        writeFileSync(
          join(dir, "launcher.json"),
          JSON.stringify({ pid: process.pid, started: "gone" }),
        )
      }
      writeFileSync(file, JSON.stringify({ ...shipped(), origin: "edited" }))
      if (launched) process.env.PLAYGROUND_FIXTURE_LAUNCHED = "1"
      expect(ensureFixture(source)).toBe(dir)
      return JSON.parse(readFileSync(join(dir, "machine.json"), "utf8")).origin
    } finally {
      for (const [key, value] of [
        ["PLAYGROUND_FIXTURE_DIR", saved.dir],
        ["PLAYGROUND_FIXTURE_LAUNCHED", saved.launched],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  test("a source edited after its copy was stamped is written into the copy on the next call", () => {
    expect(edited(false)).toBe("edited")
  })

  test("a launched stack keeps its copy after the same edit, since the launcher owns it", () => {
    expect(edited(true)).toBe("first")
  })

  test("a CLI beside a running stack keeps the stack's copy after the same edit", () => {
    expect(edited(false, "live")).toBe("first")
  })

  test("a copy whose launcher has gone is written again after the same edit", () => {
    expect(edited(false, "gone")).toBe("edited")
  })

  test("a launcher matched once is asked about by its pid alone, so a later read spawns no ps, and one that has ended reads as gone (#1072's nit)", async () => {
    const dir = scratch("launcher-matched")
    const launcher = Bun.spawn(["sleep", "30"])
    try {
      markLaunched(dir, launcher.pid, "then")
      let asked = 0
      const start = () => {
        asked++
        return "then"
      }
      expect([launcherRuns(dir, start), launcherRuns(dir, start)]).toEqual([true, true])
      expect(asked).toBe(1)
      launcher.kill()
      await launcher.exited
      expect(launcherRuns(dir, start)).toBe(false)
      expect(asked).toBe(1)
    } finally {
      launcher.kill()
    }
  })

  test("replaces its own folder whole, so a stack starts from the fixture again", () => {
    const roots = freshRoots()
    const dir = join(scratch("fixture-rewrite"), "fixture")
    writeFixture(small(), dir, roots)
    writeFileSync(join(dir, "claude/playground/attachments/left-over.txt"), "{}")
    writeFixture(small(), dir, roots)
    expect(readdirSync(join(dir, "claude/playground/attachments"))).toEqual([])
    const old = listTrash(roots.trash).find((entry) => entry.path === dir)
    expect(old).toBeDefined()
    expect(
      existsSync(
        join(roots.trash, old!.id, "fixture", "claude/playground/attachments/left-over.txt"),
      ),
    ).toBe(true)
    dropFixture(dir, roots)
    expect(existsSync(dir)).toBe(false)
    expect(trashed(roots).filter((path) => path === dir)).toHaveLength(2)
    expect(readdirSync(dirname(dir))).toEqual([])
  })

  test("a half-written folder a stopped write left behind goes to the trash before the next write", () => {
    const roots = freshRoots()
    const dir = join(scratch("fixture-left"), "fixture")
    mkdirSync(`${dir}.writing-${process.pid}`, { recursive: true })
    writeFileSync(join(`${dir}.writing-${process.pid}`, "half.json"), "{}")
    writeFixture(small(), dir, roots)
    expect(existsSync(`${dir}.writing-${process.pid}`)).toBe(false)
    expect(trashed(roots)).toContain(`${dir}.writing-${process.pid}`)
  })

  test("a fixture folder the trash refuses, as one inside the main checkout, stays, and the refusal is thrown in its words", () => {
    const root = scratch("fixture-protected")
    const dir = join(root, "fixture")
    const roots = { ...ROOTS, main: root }
    writeFixture(small(), dir, roots, new Date(Date.parse(ANCHOR)))
    expect(() => dropFixture(dir, roots)).toThrow("inside the main checkout")
    expect(() => writeFixture(small(), dir, roots, new Date(Date.parse(ANCHOR) + DAY))).toThrow(
      "inside the main checkout",
    )
    // the refusal comes before any write or rename, so the folder is as it was and nothing sits beside it
    expect(JSON.parse(readFileSync(join(dir, "stamp.json"), "utf8")).writtenAt).toBe(ANCHOR)
    expect(readdirSync(root)).toEqual(["fixture"])
  })

  test("a plain clone's fixture sits in the temp folder, so a fixture stack there starts, stops and starts again with nothing left in the clone", () => {
    const clone = scratch("fixture-clone")
    mkdirSync(join(clone, ".git"))
    const tmp = scratch("fixture-tmp")
    const dir = fixtureDir({}, clone, tmp)
    expect(dirname(dir)).toBe(tmp)
    const roots = { ...freshRoots(), main: clone }
    writeFixture(small(), dir, roots)
    dropFixture(dir, roots)
    writeFixture(small(), dir, roots)
    dropFixture(dir, roots)
    expect(readdirSync(clone)).toEqual([".git"])
    expect(readdirSync(tmp)).toEqual([])
    expect(trashed(roots).filter((path) => path === dir)).toHaveLength(2)
  })

  test("a writer whose rename loses the race to another's returns, leaving that complete fixture and no .writing folder (#797)", () => {
    const root = scratch("fixture-race")
    const dir = join(root, "fixture")
    const roots = freshRoots()
    const later = new Date(Date.parse(ANCHOR) + DAY)
    writeFixture(small(), dir, roots, new Date(Date.parse(ANCHOR)), (from, to) => {
      writeFixture(small(), join(root, "winner"), roots, later)
      renameSync(join(root, "winner"), to)
      renameSync(from, to)
    })
    expect(readdirSync(root)).toEqual(["fixture"])
    expect(JSON.parse(readFileSync(join(dir, "stamp.json"), "utf8"))).toEqual({
      writtenAt: later.toISOString(),
    })
  })

  test("a rename that fails another way, or onto a folder that is no fixture's, still throws (#797)", () => {
    const root = scratch("fixture-race-fail")
    const roots = freshRoots()
    const failing = (code: string) => () => {
      throw Object.assign(new Error(`rename failed: ${code}`), { code })
    }
    expect(() =>
      writeFixture(small(), join(root, "a"), roots, undefined, failing("ENOSPC")),
    ).toThrow("rename failed: ENOSPC")
    expect(() =>
      writeFixture(small(), join(root, "b"), roots, undefined, failing("ENOTEMPTY")),
    ).toThrow("rename failed: ENOTEMPTY")
  })

  test("leaves a folder that is not a fixture's alone, a real config folder named by mistake included", () => {
    const dir = scratch("fixture-foreign")
    writeFileSync(join(dir, "roster.json"), "real")
    expect(() => writeFixture(small(), dir, ROOTS)).toThrow("is not a fixture's folder")
    dropFixture(dir, ROOTS)
    expect(readFileSync(join(dir, "roster.json"), "utf8")).toBe("real")
  })

  test("the shipped fixture loads, and a file off its shape is named with the key that fails", () => {
    expect(loadFixture(null).ok).toBe(true)
    const file = join(scratch("fixture-shape"), "bad.json")
    writeFileSync(file, JSON.stringify({ ...shipped(), anchor: "yesterday" }))
    const loaded = loadFixture(file)
    expect(loaded.ok).toBe(false)
    if (!loaded.ok) expect(loaded.error).toContain(`${file} is not a fixture: anchor`)
  })

  test("every transcript sits at files' top level, none nested inside another transcript's entry", () => {
    const transcripts = Object.entries(shipped().files).filter(([path]) => path.endsWith(".jsonl"))
    expect(transcripts.length).toBeGreaterThan(0)
    for (const [, entries] of transcripts) {
      expect(Array.isArray(entries)).toBe(true)
      for (const entry of entries as object[])
        for (const key of Object.keys(entry ?? {})) expect(key.endsWith(".jsonl")).toBe(false)
    }
  })

  test("a session's transcript must sit in the fixture's own folder, since a typed message is appended to it", () => {
    const file = join(scratch("fixture-transcript"), "outside.json")
    const fixture = shipped()
    for (const path of ["/Users/someone/.claude/projects/p/s.jsonl", "$CONFIG/../real.jsonl"]) {
      const panes = fixture.herdr.panes.map((pane, i) =>
        i === 0 ? { ...pane, transcript_path: path } : pane,
      )
      writeFileSync(file, JSON.stringify({ ...fixture, herdr: { ...fixture.herdr, panes } }))
      const loaded = loadFixture(file)
      expect(loaded.ok).toBe(false)
      if (!loaded.ok) expect(loaded.error).toContain("herdr.panes.0.transcript_path")
    }
  })

  test("writes herdr's server into herdr.json, its $CONFIG paths moved into the folder, and a folder written before herdr.json reads as an empty server", () => {
    const dir = join(scratch("fixture-herdr-json"), "fixture")
    writeFixture(withHerdr(), dir, ROOTS)
    const herdr = readFixtureHerdr(dir)
    expect(herdr.inputs).toEqual({})
    expect(herdr.panes.map((p) => p.pane_id)).toEqual(["w1:p1", "w1:p2"])
    expect(herdr.panes[0]?.transcript_path).toBe(join(dir, "claude", HERDR_TRANSCRIPT))
    expect(herdr.prompts["w1:p2"]).toContain("Which colour?")
    rmSync(join(dir, "herdr.json"))
    expect(readFixtureHerdr(dir)).toEqual({
      inputs: {},
      panes: [],
      prompts: {},
      screens: {},
      workspaces: [],
    })
  })

  // herdr pastes a message, and Claude Code takes each image path in as an image; a fixture pane with a transcript stands for one
  test("a prompt into a pane writes a message with an image as Claude Code writes the paste", () => {
    const dir = join(scratch("fixture-paste"), "fixture")
    writeFixture(shipped(), dir, ROOTS)
    const session = readFixtureHerdr(dir).panes.find((p) => p.transcript_path)
    if (!session) throw new Error("the shipped fixture has a pane with a transcript")
    const pane = session.pane_id
    const paste = (text: string) => fixtureHerdrInput(pane, { prompt: text }, dir)
    const files = join(dir, "claude/playground/attachments")
    const png = join(files, "3f0e7a52-1c4b-4d2a-9e6f-0000000000a1.png")
    const pdf = join(files, "3f0e7a52-1c4b-4d2a-9e6f-0000000000a3.pdf")
    const last = (n: number) =>
      readFileSync(String(session.transcript_path), "utf8")
        .trimEnd()
        .split("\n")
        .slice(-n)
        .map((line) => JSON.parse(line))
    paste(`Two files.\n\nAttached: ${png}\nAttached: ${pdf}`)
    const [message, source] = last(2)
    expect(message.message.content).toMatchObject([
      { text: `[Image #1]Two files.\nAttached:\nAttached:\n${pdf}`, type: "text" },
      { source: { media_type: "image/png", type: "base64" }, type: "image" },
    ])
    expect(message.imagePasteIds).toEqual([1])
    expect(source).toMatchObject({
      isMeta: true,
      message: { content: [{ text: `[Image: source: ${png}]` }] },
      promptId: message.promptId,
    })
    expect(source.origin).toBeUndefined()
    // with no image, the paste is kept as it came
    paste(`One file.\n\nAttached: ${pdf}`)
    expect(last(1)[0].message.content).toBe(`One file.\n\nAttached: ${pdf}`)
    // a long paste is wrapped in <pasted_content> tags, its id on both
    const long = `Rameen  [3:53 PM]\n${"words ".repeat(40)}`
    paste(long)
    expect(last(1)[0].message.content).toMatch(
      /^\n\n<pasted_content id="([0-9a-f]{4})">\n[\s\S]*\n<\/pasted_content id="\1">\n$/,
    )
    expect(parseLines(readFileSync(String(session.transcript_path), "utf8")).at(-1)?.text).toBe(
      long.trim(),
    )
  })

  test("types into no transcript outside its own folder, whatever its scratch state names", () => {
    const dir = join(scratch("fixture-outside"), "fixture")
    writeFixture(shipped(), dir, ROOTS)
    const outside = join(scratch("fixture-real"), "real.jsonl")
    writeFileSync(outside, "")
    const state = readFixtureHerdr(dir)
    const pane = state.panes.find((p) => p.transcript_path)
    if (!pane) throw new Error("the shipped fixture has a pane with a transcript")
    pane.transcript_path = outside
    writeFileSync(join(dir, "herdr.json"), JSON.stringify(state))
    fixtureHerdrInput(pane.pane_id, { text: "hello" }, dir)
    expect(() => fixtureHerdrInput(pane.pane_id, { keys: ["enter"] }, dir)).toThrow(
      "outside the fixture's folder",
    )
    expect(readFileSync(outside, "utf8")).toBe("")
  })

  test("the shipped fixture names its own folder, a real path once written, only where the dashboard opens a file: a transcript's path and an attached file", () => {
    const stray: string[] = []
    const walk = (value: unknown, key: string) => {
      if (typeof value === "string") {
        const rest =
          key === "transcript_path"
            ? ""
            : value.replace(
                /^(?:Attached: |\[Image: source: )?\$CONFIG\/playground\/attachments\/[\w.-]+\]?$/gm,
                "",
              )
        if (rest.includes("$CONFIG")) stray.push(value)
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, k)
      }
    }
    walk(shipped(), "")
    expect(stray).toEqual([])
  })

  // An unpriced model would put a problem line on every fixture stack's Usage page and count its calls at $0.
  // Two PRs' merge gave dispatcher-2 and worker-bright-lark one session id, pid and registry file: JSON keeps the last of a repeated key, so a session went missing with no error.
  test("no two of the shipped fixture's panes share an id, and no key repeats", () => {
    const raw = readFileSync(
      join(import.meta.dir, "../../../../../../api/hono/src/fixtures/dashboard.json"),
      "utf8",
    )
    const keys = [...raw.matchAll(/^ {4}"([^"]+)": [[{]/gm)].map((match) => match[1])
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([])
    const { herdr } = shipped()
    const repeated = (values: unknown[]) => values.filter((value, i) => values.indexOf(value) !== i)
    for (const field of ["pane_id", "session_id", "terminal_id"] as const)
      expect([field, repeated(herdr.panes.map((p) => p[field]))]).toEqual([field, []])
    expect(["pid", repeated(herdr.panes.flatMap((p) => p.processes.map((x) => x.pid)))]).toEqual([
      "pid",
      [],
    ])
    expect(repeated(herdr.workspaces.map((w) => w.workspace_id))).toEqual([])
  })

  test("the shipped fixture holds an id-named worker and an id-named checker live, the checker stuck at a prompt (#1592)", () => {
    const { files, herdr } = shipped()
    const nameOf = (pane: (typeof herdr.panes)[number]) => {
      const args = (pane.processes[0]?.argv ?? []) as string[]
      return args[args.indexOf("-n") + 1] ?? ""
    }
    const names = herdr.panes.map(nameOf)
    // an id-named worker live, so its K3m9px-style label shows with no scratch edit
    expect(names).toContain("k3m9px-worker")
    // an id-named reviewer live and stuck at a prompt under the worker, so the sidebar draws the pair; the sinName reading itself is tested on its own
    const checker = herdr.panes.find((p) => nameOf(p) === "q7w8f2-reviewer")
    expect(checker?.agent_status).toBe("blocked")
    // each live session's registry file at its pid, what a live read takes
    expect(files["sessions/900021.json"]).toBeTruthy()
    expect(files["sessions/900022.json"]).toBeTruthy()
    const roster = (
      files["playground/roster.json"] as {
        agents: { name: string; status: string; worker?: string }[]
      }
    ).agents
    expect(roster.find((agent) => agent.name === "q7w8f2-reviewer")?.worker).toBe("k3m9px-worker")
  })

  test("the shipped fixture's 7 threads span 2 pages, one pinned and one archived, each message a line of its own session's transcript, their times moved with the rest", () => {
    const { threads = [], files } = shipped()
    expect(threads).toHaveLength(7)
    expect(threads.filter((t) => t.pinnedAt)).toHaveLength(1)
    expect(threads.filter((t) => t.archivedAt)).toHaveLength(1)
    expect(threads.filter((t) => !t.lastReadAt).length).toBeGreaterThan(1)
    for (const t of threads) {
      const transcript = files[`projects/-fixture-playground/${t.session}.jsonl`] as {
        uuid?: string
      }[]
      const uuids = new Set(transcript.map((line) => line.uuid))
      expect([t.id, t.messages.filter((uuid) => !uuids.has(uuid))]).toEqual([t.id, []])
    }
    const dir = join(scratch("fixture-threads"), "fixture")
    writeFixture(
      { ...shipped(), anchor: "2026-01-01T12:00:00.000Z" },
      dir,
      ROOTS,
      new Date("2026-01-02T12:00:00.000Z"),
    )
    const machine = JSON.parse(readFileSync(join(dir, "machine.json"), "utf8"))
    expect(machine.threads[0].createdAt).toBe(
      new Date(Date.parse(threads[0]!.createdAt) + 86_400_000).toISOString(),
    )
  })

  // The made-up machine's owner is Merritt and its org example.
  test("names no real person, org or team: its owner is Merritt and its org example", () => {
    const raw = readFileSync(
      join(import.meta.dir, "../../../../../../api/hono/src/fixtures/dashboard.json"),
      "utf8",
    )
    expect(raw.match(/.{0,30}(?:acme|acme-owner).{0,30}/gi)).toBeNull()
    expect(raw).toContain('"email": "merritt@example.com"')
  })

  test("every model the shipped fixture's assistant lines name is priced", () => {
    const models = new Set<string>()
    for (const [path, content] of Object.entries(shipped().files)) {
      if (!path.endsWith(".jsonl") || !Array.isArray(content)) continue
      for (const line of content as { message?: { model?: unknown }; type?: unknown }[]) {
        if (line.type === "assistant" && typeof line.message?.model === "string") {
          models.add(line.message.model)
        }
      }
    }
    expect(models.size).toBeGreaterThan(0)
    expect(models).toContain("glm-5.3-flash[1m]")
    expect([...models].filter((model) => !priceOf(model))).toEqual([])
  })
})

// Each binary a dashboard read would run on the live machine, as a spy that logs its call and fails.
const SPIED = ["cmux", "docker", "gh", "lsof", "ps", "sysctl", "vm_stat"]

// Every file under a folder, by path, with its bytes, so a write anywhere in it shows.
const snapshot = (dir: string): Record<string, string> => {
  const files: Record<string, string> = {}
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else files[relative(dir, path)] = readFileSync(path, "base64")
    }
  }
  walk(dir)
  return files
}

const writeAll = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

// Every read the dashboard makes and both of its writes, on a fixture stack's settings, from a process of its own.
const DRIVE = `
const { homedir } = await import("node:os")
const { listLive } = await import(\`\${API}/lib/dashboard/workers\`)
const { dashboardHub } = await import(\`\${API}/lib/dashboard/hub\`)
const { agentsBoard } = await import(\`\${API}/lib/dashboard/agents\`)
const { readScreen } = await import(\`\${API}/lib/dashboard/terminal\`)
const { read } = await import(\`\${API}/lib/system/sampler\`)
const { deliver, deliverDeps } = await import(\`\${API}/lib/dashboard/deliver\`)
const { answerFeed, answerDeps } = await import(\`\${API}/lib/dashboard/feed\`)
const { readFixtureHerdr } = await import(\`\${API}/lib/dashboard/fixture\`)
const { mergedPrs } = await import(\`\${API}/lib/usage/prs\`)
const { readOps } = await import(\`\${API}/lib/dashboard/ops\`)

const live = await listLive()
let off = () => {}
const frame = await new Promise((resolve) => {
  off = dashboardHub.subscribe((f) => f.type === "workers" && resolve(f))
})
off()
const board = await agentsBoard()
const named = (name) => live.workers.find((w) => w.name === name)
const sloth = named("worker-sloth")
const screen = await readScreen(live.surfaces.get(sloth.sessionId), 40)
const readings = await read()
const merged = await mergedPrs(["example/fixture"], 0)
const ops = await readOps()
const opsLater = await readOps(undefined, Date.now() + 20 * 60 * 1000)
const actor = { label: "fixture test" }
const delivered = await deliver(
  { actor, text: "hello from\\nthe fixture test", to: "worker-sloth" },
  { ...deliverDeps, record: async (_event, typing) => typing() },
)
const skills = [...(await deliverDeps.skills(sloth.cwd))]
const greed = named("worker-greed")
const picker = greed.feed.find((item) => item.kind === "question")
const answered = await answerFeed(
  {
    actor,
    answer: { answers: picker.questions.map((q) => ({ choices: [q.options[0].label], text: null })), kind: "question" },
    approver: { role: "owner" },
    requestId: picker.requestId,
    sessionId: greed.sessionId,
  },
  { ...answerDeps, approvals: false, record: async (_event, replying) => replying(), settle: { attempts: 3, delayMs: 20 } },
)
const transcript = await Bun.file(live.transcripts.get(sloth.sessionId)).text()
console.log(JSON.stringify({
  account: readings.account,
  answered,
  board: board.agents.map((a) => [a.name, a.state]),
  rosterPath: board.roster.path,
  delivered,
  skills,
  frame: frame.workers.length,
  home: homedir(),
  merged: merged.prs.map((pr) => [pr.number, pr.rounds]),
  mergedProblems: merged.problems,
  ops: ops.map((row) => [row.job, row.status]),
  opsLater: opsLater.map((row) => [row.job, row.status]),
  names: live.workers.map((w) => w.name),
  paused: named("planner").usageLimit ?? null,
  feed: live.workers.flatMap((w) => w.feed.map((item) => [w.name, item.kind, item.requestId])).sort(),
  pending: Object.keys(readFixtureHerdr().prompts),
  greedPane: live.surfaces.get(greed.sessionId),
  picker: picker.requestId,
  problems: readings.problems,
  pulls: readings.pulls,
  screen,
  sent: transcript.trim().split("\\n").at(-1),
  update: readings.update,
  workers: live.workers.length,
}))
process.exit(0)
`

// A folder of spies, one per binary in SPIED, each logging its call to the returned log and failing.
const spies = (dir: string): { bin: string; log: string } => {
  const bin = join(dir, "bin")
  const log = join(dir, "spied.log")
  mkdirSync(bin)
  for (const name of SPIED) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 1\n`)
    chmodSync(join(bin, name), 0o755)
  }
  return { bin, log }
}

describe.skipIf(onLiveDashboard())("a fixture stack", () => {
  // The control: the same spies catch a process that reads the live machine, so a quiet log below means the fixture held, not a blind spy.
  test("the spies catch a live-reads process probing the machine", async () => {
    const dir = scratch("fixture-control")
    const { bin, log } = spies(dir)
    const { code } = await inFixture(
      `const { read } = await import(\`\${API}/lib/system/sampler\`)\nawait read().catch(() => null)\nconsole.log("{}")\nprocess.exit(0)\n`,
      dir,
      {
        PLAYGROUND_LIVE_READS: "1",
        PATH: `${bin}:${process.env.PATH}`,
      },
    )
    expect(code).toBe(0)
    expect(readFileSync(log, "utf8")).toContain("ps -axo")
  }, 60_000)

  test("never runs cmux or the machine's probes, never connects to cmux's socket, and keeps its writes in its own scratch copy", async () => {
    const dir = scratch("fixture-spy")
    const { bin, log } = spies(dir)
    // the socket cmux would be reached on, as a spy that counts who connects
    const socketPath = join(dir, "cmux.sock")
    let connections = 0
    const socket = Bun.listen({
      socket: {
        data() {},
        open() {
          connections++
        },
      },
      unix: socketPath,
    })
    // a stand-in for the live home, with a session, a roster and the folders a live stack's settings name
    const home = join(dir, "home")
    writeAll(home, {
      ".playground/roster.json": '{"agents":[]}',
      ".claude/projects/live/11111111-1111-4111-8111-000000000005.jsonl": '{"type":"user"}\n',
      ".claude/sessions/900005.json": '{"pid":900005,"sessionId":"live"}',
      "live/actions/FIX-101.json": "{}",
      "live/attachments/kept.txt": "kept",
    })
    // bun keeps its own cache under HOME, so only the folders the dashboard would read are compared
    const dashboard = () => ({
      claude: snapshot(join(home, ".claude")),
      live: snapshot(join(home, "live")),
    })
    const before = dashboard()

    const { code, result, stderr } = await inFixture(DRIVE, dir, {
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CMUX_SOCKET_PATH: socketPath,
      PLAYGROUND_ATTACHMENTS_DIR: join(home, "live/attachments"),
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
    })
    socket.stop(true)
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" })
    const out = result as Record<string, unknown>

    // nothing reached the live machine
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("")
    expect(connections).toBe(0)
    expect(out.home).toBe(home)
    expect(dashboard()).toEqual(before)

    // every read answered from the fixture, the id-named pair and the Codex worker live with the rest
    expect(out.workers).toBe(22)
    expect(out.names).toContain("c4dx7n-worker")
    // the stale record, whose pid another process holds now, is no session
    expect(out.names).not.toContain("gluttony")
    expect(out.frame).toBe(out.workers)
    expect(out.screen as string).toContain("❯")
    expect(out.problems).toEqual([])
    // the made-up origin's pull requests, which the sidebar's GitHub icon links to, read with no git
    expect(out.pulls).toBe("https://github.com/example/fixture/pulls")
    // the made-up login its usage.json was read under, which the user menu shows, never the account in a real .claude.json
    expect(out.account).toEqual({ email: "pat@example.com", name: null })
    // the update the fixture carries, its newest change moved to now as every fixture time is, with nothing fetched
    expect(out.update).toMatchObject({
      behind: 3,
      branch: "canary",
      pulled: false,
      upstream: "canary",
    })
    const newestAge = Date.now() - Date.parse((out.update as { newest: { at: string } }).newest.at)
    expect(newestAge).toBeGreaterThan(60 * 60 * 1000)
    expect(newestAge).toBeLessThan(2 * 60 * 60 * 1000)
    expect(out.board).toContainEqual(["worker-wrath", "down"])
    // ops-unstick's state, written a year ahead so it never reads stale, holds planner on the usage limit alone, so it reads paused, not stuck
    expect(out.paused).toEqual({ resets: "3pm (UTC)", resetsAt: null })
    // the Usage app's merged PRs, which a live stack asks GitHub for
    expect(out.merged).toEqual([[97, 2]])
    expect(out.mergedProblems).toEqual([])
    // the ops jobs, whose heartbeats and pids a live stack reads from the config folder and ps
    // 19 scripts: 11 running, ops-wa waiting on its pairing code, ops-report and ops-sweep failing, and 5 paused with no heartbeat, so the Scripts label counts the 14 it lists
    expect(out.ops).toEqual([
      ["ops-awake", "running"],
      ["ops-changelog", "running"],
      ["ops-checks", "running"],
      ["ops-consultant", "down"],
      ["ops-dashboard", "running"],
      ["ops-dm-watch", "down"],
      ["ops-fixture", "down"],
      ["ops-machine", "running"],
      ["ops-merge-train", "running"],
      ["ops-merge-watch", "running"],
      ["ops-report", "failing"],
      ["ops-slack-watch", "running"],
      ["ops-sweep", "failing"],
      ["ops-tickets", "running"],
      ["ops-unstick", "running"],
      ["ops-usage", "running"],
      ["ops-usage-post", "down"],
      ["ops-wa", "waiting"],
      ["ops-zai-usage", "down"],
    ])
    // a stack that has run a while: its heartbeats were set once, when the fixture was written, and ops-slack-watch's 5-minute cycle is long past
    expect(out.opsLater).toEqual([
      ["ops-awake", "running"],
      ["ops-changelog", "running"],
      ["ops-checks", "running"],
      ["ops-consultant", "down"],
      ["ops-dashboard", "running"],
      ["ops-dm-watch", "down"],
      ["ops-fixture", "down"],
      ["ops-machine", "running"],
      ["ops-merge-train", "running"],
      ["ops-merge-watch", "running"],
      ["ops-report", "failing"],
      ["ops-slack-watch", "down"],
      ["ops-sweep", "failing"],
      ["ops-tickets", "running"],
      ["ops-unstick", "running"],
      ["ops-usage", "running"],
      ["ops-usage-post", "down"],
      ["ops-wa", "waiting"],
      ["ops-zai-usage", "down"],
    ])
    // the Dashboard names the roster's file when it has none, which on a fixture stack would be this machine's checkout path
    expect(out.rosterPath).toBe("<fixture>/playground/roster.json")

    // both writes landed in the scratch copy, as they would on a live session
    expect(out.delivered).toMatchObject({ ok: true })
    expect(JSON.parse(out.sent as string)).toMatchObject({
      message: { content: "hello from\nthe fixture test", role: "user" },
    })
    // the fixture's own made-up skills, so a fixture stack sends /daily-notes as a person would and its / menu runs past its height; notes-index says user-invocable: false
    expect([...(out.skills as string[])].sort()).toEqual([
      "bug-hunt",
      "daily-notes",
      "docs-check",
      "focus-plan",
      "inbox-sweep",
      "meeting-prep",
      "pr-summary",
      "retro-notes",
      "standup-draft",
      "ticket-triage",
      "week-ahead",
      "weekly-review",
    ])
    expect(out.answered).toMatchObject({ ok: true })
    // the answer cleared the picker the question's pane drew, in the scratch copy
    expect(out.pending).not.toContain(String(out.greedPane).split(":").slice(2).join(":"))
    expect(out.picker).toBe("toolu_fixture_prompt_2")
    expect(out.feed).toEqual([
      ["ops", "permission", "toolu_fixture_prompt_1"],
      ["p9c3wx-tester", "plan", "toolu_fixture_prompt_3"],
      ["worker-greed", "question", "toolu_fixture_prompt_2"],
    ])
  }, 60_000)
})

describe("the shipped fixture's pulls", () => {
  type Shipped = {
    files: Record<string, { agents?: { branch?: string; pr?: string; repo?: string }[] }>
    git: Record<string, { branch: string; repo: string }>
    pulls: Record<string, { number: number }>
  }
  const shipped = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../../../api/hono/src/fixtures/dashboard.json"),
      "utf8",
    ),
  ) as Shipped

  test("answer every rostered worker's checkout branch with its pull, as GitHub would, so a merged one reaches the board", () => {
    const branches = new Set(Object.values(shipped.git).map((g) => `${g.repo}#${g.branch}`))
    const agents = shipped.files["playground/roster.json"]?.agents ?? []
    const owed = agents.filter(
      (a) => a.branch && a.repo && a.pr && branches.has(`${a.repo}#${a.branch}`),
    )
    expect(owed.length).toBeGreaterThan(0)
    for (const agent of owed) {
      const key = `${agent.repo}#${agent.branch}`
      expect({ key, number: shipped.pulls[key]?.number }).toEqual({
        key,
        number: Number(agent.pr!.split("/").at(-1)),
      })
    }
  })
})

describe("configDir on a hosted source", () => {
  const keep = ["PLAYGROUND_FIXTURE_DIR", "PLAYGROUND_HOSTED", "PLAYGROUND_LIVE_READS"].map(
    (name) => [name, process.env[name]] as const,
  )
  const scratch = mkdtempSync(join(tmpdir(), "hosted-config-"))
  afterAll(() => {
    for (const [name, value] of keep)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    rmSync(scratch, { force: true, recursive: true })
  })

  test("names the fixture's unwritten folder and writes nothing, live reads asked for or not", () => {
    process.env.PLAYGROUND_FIXTURE_DIR = scratch
    process.env.PLAYGROUND_HOSTED = "1"
    process.env.PLAYGROUND_LIVE_READS = "1"
    expect(configDir()).toBe(join(scratch, "claude"))
    expect(readdirSync(scratch)).toEqual([])
  })
})

// A dispatcher spawn.sh started under inscope registered in ~/.claude/sessions while the board read inscope's own folder, so the board showed it off and Start said it was already running
describe("configDir on a live source", () => {
  const keep = ["CLAUDE_CONFIG_DIR", "INSCOPE_CCD", "PLAYGROUND_LIVE_READS"].map(
    (name) => [name, process.env[name]] as const,
  )
  afterAll(() => {
    for (const [name, value] of keep)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
  })

  test("reads ~/.claude under inscope, where spawn.sh's sessions register, else CLAUDE_CONFIG_DIR", () => {
    const inscope = join(homedir(), ".config", "inscope", "work", "claude")
    process.env.PLAYGROUND_LIVE_READS = "1"
    process.env.CLAUDE_CONFIG_DIR = inscope
    process.env.INSCOPE_CCD = inscope
    expect(configDir()).toBe(join(homedir(), ".claude"))
    delete process.env.INSCOPE_CCD
    expect(configDir()).toBe(inscope)
    delete process.env.CLAUDE_CONFIG_DIR
    expect(configDir()).toBe(join(homedir(), ".claude"))
  })
})

describe.skipIf(onLiveDashboard())("herdr on a fixture stack", () => {
  // every read and write in herdr.ts runs on the fixture's own server, answered from herdr.json, and no socket is reached
  test("reads the fixture's panes and screens, sends a prompt into its transcript, and answers a picker by keys", async () => {
    const dir = scratch("fixture-herdr")
    writeFixture(withHerdr(), join(dir, "fixture"), ROOTS)
    const { code, result, stderr } = await inFixture(
      `const h = await import(\`\${API}/lib/dashboard/herdr\`)
const idle = "herdr:playground:w1:p1"
const blocked = "herdr:playground:w1:p2"
const outcome = (write) => write.then(() => "sent", (error) => h.promptOutcome(error))
const servers = h.herdrServers()
const [before] = await h.readHerdr()
const screen = await h.readScreen(idle, 40)
const picker = await h.readScreen(blocked, 40)
await h.prompt(idle, "hello there")
const onPicker = await outcome(h.prompt(blocked, "hi"))
const noPane = await outcome(h.prompt("herdr:playground:w9:p9", "hi"))
await h.typeKeys(blocked, [{ key: "down" }, { key: "enter" }])
await h.typeKeys(idle, [{ text: "typed" }, { key: "enter" }])
const [after] = await h.readHerdr()
const answered = await h.readScreen(blocked, 40)
const events = h.herdrEvents()
events.kill()
const { fixtureConfigDir } = await import(\`\${API}/lib/dashboard/fixture\`)
const lines = (await Bun.file(\`\${fixtureConfigDir()}/${HERDR_TRANSCRIPT}\`).text()).trim().split("\\n").map((line) => JSON.parse(line).message.content)
console.log(JSON.stringify({ after: after.panes.map((p) => p.agent_status), answered, before: { panes: before.panes.map((p) => [p.pane_id, p.agent_status, p.processes.map((x) => x.pid)]), server: before.server, workspaces: before.workspaces }, lines, noPane, onPicker, picker, screen, servers }))
process.exit(0)
`,
      dir,
    )
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" })
    const out = result as Record<string, unknown>
    expect(out.servers).toEqual([{ name: "playground", socket: "fixture:herdr" }])
    expect(out.before).toEqual({
      panes: [
        ["w1:p1", "idle", [910001]],
        ["w1:p2", "blocked", [910002]],
      ],
      server: "playground",
      workspaces: [{ label: "Builder", workspace_id: "w1" }],
    })
    expect(out.screen as string).toStartWith("● Done.\n")
    expect(out.screen as string).toContain("❯")
    expect(out.picker).toBe("● Asking.\nWhich colour?\n❯ 1. Teal\n  2. Plum\n  3. Type something.")
    // herdr refuses a prompt into a session blocked on a picker, and names a pane it does not hold as gone
    expect([out.onPicker, out.noPane]).toEqual(["picker", "gone"])
    // the prompt and the words typed then sent each reach the transcript, and the answered picker leaves its pane working at its input box
    expect(out.lines).toEqual(["hello there", "typed"])
    expect(out.after).toEqual(["working", "working"])
    expect(out.answered as string).toStartWith("● Asking.\n─")
  }, 60_000)
})
