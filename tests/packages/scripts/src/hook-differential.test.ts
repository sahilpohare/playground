import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"

import {
  calls,
  canaryTree,
  checkOf,
  cwdsOf,
  envOf,
  GLM_BASE_URL,
  keyOf,
  linesOf,
  loadedTree,
  parse,
  replay,
  resultPath,
  ROOT_READS,
  routed,
  scratchData,
  sessionRoles,
  store,
  stored,
  sweep,
  TAKES_MAIN,
  type Check,
  unloaded,
} from "../../../../packages/scripts/src/hook-differential"
import { scratchEnv } from "../../../scratch-env"

const SCRIPT = join(import.meta.dir, "../../../../packages/scripts/src/hook-differential.ts")
const SETTING = join(import.meta.dir, "../../../../packages/scripts/src/playground/setting.ts")
const DIR = mkdtempSync(join(tmpdir(), "hook-differential-"))

afterAll(() => rmSync(DIR, { force: true, recursive: true }))

// a home whose run-slot.sh stand-in logs each ticket it is asked for and answers `room` with 7 waiters
const home = (name: string) => {
  const at = join(DIR, name)
  mkdirSync(join(at, ".playground", "ops"), { recursive: true })
  const runSlot = join(at, ".playground", "ops", "run-slot.sh")
  writeFileSync(
    runSlot,
    `#!/bin/bash\nif [ "$1" = room ]; then echo "4 4 0 7"; exit 0; fi\necho "$*" >> "${at}/tickets"\n`,
  )
  chmodSync(runSlot, 0o755)
  return at
}

const start = (at: string, env: Record<string, string> = {}) => {
  return Bun.spawnSync(["bun", SCRIPT, "replay", "--canary", "HEAD", "--hook", "no-such-hook"], {
    cwd: join(import.meta.dir, "../../../.."),
    env: scratchEnv(at, env),
    stderr: "pipe",
    stdout: "pipe",
  })
}

describe("a start of hook-differential", () => {
  test("a bare start of the replay takes a run-slot ticket and says so on stderr with the queue's depth", () => {
    const at = home("bare")
    const run = start(at)
    expect(readFileSync(join(at, "tickets"), "utf8")).toContain(
      `-- bun ${SCRIPT} replay --canary HEAD --hook no-such-hook`,
    )
    expect(run.stderr.toString()).toContain("queued through run-slot behind 7 waiting")
  })

  test("a start inside a run-slot ticket takes no second one", () => {
    const at = home("inside")
    start(at, { RUN_SLOT_NICE: "10" })
    expect(existsSync(join(at, "tickets"))).toBe(false)
  })

  test.each([
    ["a sweep with no --forms", ["sweep"]],
    ["a replay over hours that are not a positive number", ["replay", "--hours", "abc"]],
  ])("%s prints the usage and ends with 2", (_, mode) => {
    const run = Bun.spawnSync(
      ["bun", SCRIPT, ...mode, "--canary", "HEAD", "--hook", "no-extensions-write"],
      { env: { ...process.env, RUN_SLOT_NICE: "10" }, stderr: "pipe", stdout: "pipe" },
    )
    expect(run.exitCode).toBe(2)
    expect(run.stderr.toString()).toContain("usage: bun run hooks:differential")
  })
})

describe("canaryTree", () => {
  const recorder =
    (steps: string[], failing = "", onInstall = () => {}) =>
    (argv: string[], cwd: string) => {
      steps.push(`${cwd} :: ${argv.join(" ")}`)
      if (argv[0] === "bun") onInstall()
      return { exitCode: argv[0] === failing ? 1 : 0, stdout: new Uint8Array() }
    }

  test("unpacks the sha's whole tree into a folder of its own, installs it from its own lockfile with no install scripts, then renames it to the sha, once", () => {
    const base = join(DIR, "trees")
    const steps: string[] = []
    const dir = canaryTree({ base, root: "/repo", run: recorder(steps), sha: "abc" })
    expect(dir).toBe(join(base, "abc"))
    const build = steps[1]!.split(" :: ")[0]!
    expect(build).toStartWith(join(base, "abc."))
    expect(steps).toEqual([
      "/repo :: git archive abc",
      `${build} :: tar -x -C ${build}`,
      `${build} :: bun install --frozen-lockfile --ignore-scripts`,
    ])
    expect(existsSync(join(dir, ".installed"))).toBe(true)
    canaryTree({ base, root: "/repo", run: recorder(steps), sha: "abc" })
    expect(steps).toHaveLength(3)
  })

  test("a run whose sha another run installed first takes that tree", () => {
    const base = join(DIR, "race")
    const other = join(base, "abc")
    const finishFirst = () => {
      mkdirSync(other, { recursive: true })
      writeFileSync(join(other, ".installed"), "")
      writeFileSync(join(other, "other"), "")
    }
    const steps: string[] = []
    expect(
      canaryTree({ base, root: "/repo", run: recorder(steps, "", finishFirst), sha: "abc" }),
    ).toBe(other)
    expect(steps[2]).not.toStartWith(`${other} ::`)
    expect(existsSync(join(other, "other"))).toBe(true)
  })

  test("a failed install throws and leaves the tree to be installed again", () => {
    const base = join(DIR, "failed")
    const steps: string[] = []
    expect(() =>
      canaryTree({ base, root: "/repo", run: recorder(steps, "bun"), sha: "abc" }),
    ).toThrow("could not install abc")
    canaryTree({ base, root: "/repo", run: recorder(steps), sha: "abc" })
    expect(steps).toHaveLength(6)
  })
})

describe("a canary tree the temp cleaner emptied", () => {
  // a tree as canaryTree leaves it: guards loads no-extensions-write, whose settings import zod, and the hook starts its worker module; emptied, zod keeps its folders and loses every file, as macOS's temp cleaner leaves an installed package by its age
  const tree = (name: string, emptied: boolean) => {
    const at = join(DIR, name)
    const hooks = join(at, "scripts", "hooks")
    const zod = join(at, "packages", "settings", "node_modules", "zod")
    mkdirSync(hooks, { recursive: true })
    mkdirSync(join(at, "packages", "settings", "src"), { recursive: true })
    mkdirSync(join(zod, "v4"), { recursive: true })
    writeFileSync(join(at, ".installed"), "")
    writeFileSync(
      join(at, "packages", "settings", "src", "settings.ts"),
      'import { z } from "zod"\nexport const field = z.string()\n',
    )
    writeFileSync(
      join(hooks, "no-extensions-write.ts"),
      'import "../../packages/settings/src/settings"\nexport const check = () => undefined\n',
    )
    writeFileSync(
      join(hooks, "no-extensions-write-worker.ts"),
      'import "./no-extensions-write"\nself.onmessage = () => {}\n',
    )
    writeFileSync(
      join(hooks, "guards.ts"),
      'import "./no-extensions-write"\nexport const check = () => undefined\n',
    )
    if (!emptied) {
      writeFileSync(join(zod, "package.json"), '{ "name": "zod", "main": "index.js" }')
      writeFileSync(join(zod, "index.js"), "module.exports = { z: { string: () => ({}) } }\n")
    }
    return at
  }

  test("guards and its Worker module load in a whole tree, and an emptied one names the package they cannot find", async () => {
    expect(await unloaded(tree("whole", false), ["guards"])).toBeUndefined()
    expect(await unloaded(tree("emptied", true), ["guards"])).toContain("Cannot find package 'zod'")
    expect(await unloaded(tree("emptied", true), [])).toContain("no-extensions-write-worker.ts")
  })

  test("an emptied tree is moved aside and built again, and one that stays emptied fails the run", async () => {
    const emptied = tree("rebuilt", true)
    const builds: string[] = []
    const built = await loadedTree(() => {
      builds.push(emptied)
      if (builds.length === 2) tree("rebuilt", false)
      return emptied
    }, ["guards"])
    expect(built).toBe(emptied)
    expect(builds).toHaveLength(2)
    expect(readdirSync(DIR).filter((n) => n.startsWith("rebuilt.pruned-"))).toHaveLength(1)
    const stays = tree("stays", true)
    await expect(
      loadedTree(() => (existsSync(stays) ? stays : tree("stays", true)), ["guards"]),
    ).rejects.toThrow("Cannot find package 'zod'")
  })
})

describe("routed", () => {
  const at = (env: Record<string, string | undefined>, runnable = true) =>
    routed({
      argv: ["bun", "x.ts"],
      cwd: "/r/.claude/worktrees/pg 1",
      env,
      executable: () => runnable,
      home: "/h",
    })

  test("a bare start takes a ticket named for its worktree", () => {
    expect(at({})).toEqual(["/h/.playground/ops/run-slot.sh", "hooks-pg-1", "--", "bun", "x.ts"])
  })

  test("a start inside a ticket, or with no executable run-slot.sh, runs as it is", () => {
    expect(at({ RUN_SLOT_NICE: "10" })).toEqual(["bun", "x.ts"])
    expect(at({}, false)).toEqual(["bun", "x.ts"])
  })
})

describe("linesOf", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`)

  test("20 changed lines print whole, and the 21st is cut to one line naming it, unless --all", () => {
    expect(linesOf("x", lines(20), false)).toEqual(lines(20).map((l) => `x: ${l}`))
    expect(linesOf("x", lines(21), false)).toEqual([
      ...lines(20).map((l) => `x: ${l}`),
      "x: 1 more changed lines not shown (--all prints them)",
    ])
    expect(linesOf("x", lines(21), true)).toEqual(lines(21).map((l) => `x: ${l}`))
  })
})

describe("sweep and replay", () => {
  // a hook that records every input it is given and allows a command only when it holds ALLOW
  const recorder =
    (seen: string[]): Check =>
    (raw) => {
      seen.push(raw)
      return JSON.parse(raw).tool_input.command.includes(" ALLOW") ? undefined : "refused"
    }
  const ran = join(DIR, "ran")
  const forms = [
    { command: `touch ${ran} ALLOW`, inClass: true },
    { command: `touch ${ran}`, inClass: false },
  ]

  test("each form reaches each hook only as data through check(), from the home, the data folder and a worktree, and none runs", async () => {
    const before: string[] = []
    const after: string[] = []
    const { counts } = await sweep(recorder(before), recorder(after), forms, "/h")
    expect(after.map((raw) => JSON.parse(raw))).toEqual(
      forms.flatMap(({ command }) =>
        cwdsOf("/h").map((cwd) => ({
          cwd,
          hook_event_name: "PreToolUse",
          tool_input: { command },
          tool_name: "Bash",
        })),
      ),
    )
    expect(counts).toEqual({
      cases: 6,
      forms: 2,
      "newly allowed": { inClass: 0, outClass: 0 },
      "newly refused": { inClass: 0, outClass: 0 },
      same: 6,
    })
    expect(existsSync(ran)).toBe(false)
  })

  test("a form the head allows and canary refuses counts by its class", async () => {
    const refuseAll: Check = () => "refused"
    const { changed, counts } = await sweep(refuseAll, recorder([]), forms, "/h")
    expect(counts["newly allowed"]).toEqual({ inClass: 3, outClass: 0 })
    expect(changed).toEqual([])
  })

  test("a hook that refuses only in its PreToolUse branch is reached there, as Claude Code's input names the event", async () => {
    const allowAll: Check = () => undefined
    const preToolUse: Check = (raw) =>
      JSON.parse(raw).hook_event_name === "PreToolUse" ? "refused" : undefined
    const { counts } = await sweep(allowAll, preToolUse, forms, "/h")
    expect(counts["newly refused"]).toEqual({ inClass: 3, outClass: 3 })
  })

  test("the replay reads each made-up Bash call of the day's transcripts once, a sub-agent's included, and only as data", async () => {
    const projects = join(DIR, "projects")
    mkdirSync(join(projects, "p", "s", "subagents"), { recursive: true })
    const line = (command: string, timestamp: string, cwd = "/h/w") =>
      JSON.stringify({
        cwd,
        message: { content: [{ input: { command }, name: "Bash", type: "tool_use" }] },
        timestamp,
      })
    const now = new Date().toISOString()
    writeFileSync(
      join(projects, "p", "s.jsonl"),
      [
        line(`touch ${ran} ALLOW`, now),
        line(`touch ${ran} ALLOW`, now),
        line(`touch ${ran}`, "2000-01-01T00:00:00Z"),
        "not json",
      ].join("\n"),
    )
    writeFileSync(
      join(projects, "p", "s", "subagents", "a.jsonl"),
      line(`touch ${ran} ALLOW`, now, "/h/sub"),
    )
    const list = await calls(projects, Date.now() - 3600_000)
    expect(list.toSorted((x, y) => x.cwd.localeCompare(y.cwd))).toEqual([
      { command: `touch ${ran} ALLOW`, cwd: "/h/sub" },
      { command: `touch ${ran} ALLOW`, cwd: "/h/w" },
    ])
    const { counts } = await replay(() => "refused", recorder([]), list, "/h")
    expect(counts).toEqual({ calls: 2, "newly allowed": 2, "newly refused": 0, same: 0 })
  })

  test("check() gets the caller's PATH beside the home, so a hook that runs a program finds it", async () => {
    const seen: Record<string, string | undefined>[] = []
    const record: Check = (_raw, env) => {
      seen.push(env)
      return undefined
    }
    await replay(record, record, [{ command: "ls", cwd: "/h" }], "/h")
    await sweep(record, record, [{ command: "ls" }], "/h")
    expect(seen.length).toBe(8)
    for (const env of seen) expect(env).toEqual({ HOME: "/h", PATH: process.env.PATH })
  })
})

describe("a run under a role", () => {
  test("--role takes a role for a sweep or a replay, and session for a replay alone", () => {
    const base = ["--canary", "HEAD", "--hook", "x"]
    expect(parse(["replay", ...base, "--role", "worker"])?.role).toBe("worker")
    expect(parse(["replay", ...base, "--role", "session"])?.role).toBe("session")
    expect(parse(["sweep", "--forms", "f.ts", ...base, "--role", "lead"])?.role).toBe("lead")
    expect(parse(["replay", ...base])?.role).toBeUndefined()
    expect(parse(["replay", ...base, "--role"])).toBeUndefined()
    expect(parse(["replay", ...base, "--role", "--all"])).toBeUndefined()
    expect(parse(["sweep", "--forms", "f.ts", ...base, "--role", "session"])).toBeUndefined()
  })

  test("a call's env holds the scratch data folder and --role's role, or with session its own session's role, and a name the roster lacks keeps the default", () => {
    const call = { command: "ls", cwd: "/h", name: "abc-worker", session: "s1" }
    const path = process.env.PATH
    expect(envOf({ data: "/d", home: "/h" })(call)).toEqual({
      HOME: "/h",
      PATH: path,
      PLAYGROUND_DATA_DIR: "/d",
    })
    expect(envOf({ data: "/d", home: "/h", role: "worker" })(call)).toMatchObject({
      PLAYGROUND_ROLE: "worker",
    })
    const roles = new Map([
      ["abc-worker", "worker"],
      ["stranger", ""],
    ])
    const session = envOf({ config: "/c", data: "/d", home: "/h", role: "session", roles })
    expect(session(call)).toEqual({
      CLAUDE_CONFIG_DIR: "/c",
      HOME: "/h",
      PATH: path,
      PLAYGROUND_DATA_DIR: "/d",
      PLAYGROUND_ROLE: "worker",
    })
    expect(session({ ...call, name: "stranger" })).not.toHaveProperty("PLAYGROUND_ROLE")
    expect(session({ ...call, name: undefined })).not.toHaveProperty("PLAYGROUND_ROLE")
  })

  // a made-up data folder with the entries the guards read or protect, and the writing-first marks a check() writes
  const realData = (name: string) => {
    const real = join(DIR, name)
    for (const dir of ["extensions", "ops/dashboard", "session-state", "ticket-approvals"])
      mkdirSync(join(real, dir), { recursive: true })
    mkdirSync(join(real, "writing-first"), { recursive: true })
    writeFileSync(join(real, "writing-first", "s1"), "")
    writeFileSync(join(real, "roster.json"), "{}")
    return real
  }

  test("the scratch data folder copies the roster, starts writing-first's marks empty, and links every other entry of the real one", () => {
    const real = realData("real-data")
    const data = scratchData(real, DIR)
    expect(data).not.toBe(real)
    for (const own of ["roster.json", "writing-first"])
      expect(lstatSync(join(data, own)).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(data, "roster.json"), "utf8")).toBe("{}")
    expect(readdirSync(join(data, "writing-first"))).toEqual([])
    expect(existsSync(join(data, "writing-first", "s1"))).toBe(false)
    expect(existsSync(join(scratchData(join(DIR, "no-such-data"), DIR), "writing-first"))).toBe(
      true,
    )
    for (const linked of ["extensions", "ops", "session-state", "ticket-approvals"]) {
      expect(lstatSync(join(data, linked)).isSymbolicLink()).toBe(true)
      expect(realpathSync(join(data, linked))).toBe(realpathSync(join(real, linked)))
    }
  })

  test("a guard that protects a data-folder path decides a call in the scratch folder as it does in the real one", async () => {
    const real = realData("guarded-data")
    const raw = JSON.stringify({
      cwd: DIR,
      tool_input: { command: `cp ${join(DIR, "made-up")} ${join(real, "ticket-approvals", "x")}` },
      tool_name: "Bash",
    })
    const as = (data: string) => ({
      HOME: DIR,
      PLAYGROUND_DATA_DIR: data,
      PLAYGROUND_ROLE: "worker",
    })
    const linear = (await import("../../../../scripts/hooks/no-linear-ticket")).check as Check
    expect(await linear(raw, as(real))).toBeString()
    expect(await linear(raw, as(scratchData(real, DIR)))).toBeString()
  })

  test("a replay of every hook's check() through the scratch folder leaves the real data folder as it was, so no hook writes through a link", async () => {
    const real = realData("untouched-data")
    const snapshot = () =>
      readdirSync(real, { recursive: true })
        .map(String)
        .toSorted()
        .map((entry) => {
          const stat = lstatSync(join(real, entry))
          return `${entry} ${stat.isFile() ? readFileSync(join(real, entry), "utf8") : "dir"} ${stat.mtimeMs}`
        })
    const before = snapshot()
    const scratch = scratchData(real, DIR)
    const env = envOf({ data: scratch, home: DIR, role: "worker" })
    const list = [
      `echo x > ${join(real, "ticket-approvals", "a")}`,
      `cp ${join(DIR, "made-up")} ${join(real, "session-state", "s1.json")}`,
      `touch ${join(real, "ops", "dashboard", "x")}`,
      "git commit -m made-up",
      "ls",
    ].map((command) => ({ command, cwd: DIR, name: "abc-worker", session: "s1" }))
    const hooks = join(import.meta.dir, "../../../../scripts/hooks")
    let checked = 0
    for (const file of new Bun.Glob("*.ts").scanSync(hooks)) {
      const check = (await import(join(hooks, file))).check
      if (typeof check !== "function") continue
      checked++
      await replay(check, check, list, DIR, undefined, undefined, env)
    }
    expect(checked).toBeGreaterThan(20)
    expect(snapshot()).toEqual(before)
    // a write through a link reaches the real folder, so the snapshot would show one a hook made
    writeFileSync(join(scratch, "ticket-approvals", "probe"), "")
    expect(snapshot()).not.toEqual(before)
  })

  test("a session's role comes from the roster by its transcript name, and its registry entry names it", async () => {
    const real = join(DIR, "roles-data")
    mkdirSync(real, { recursive: true })
    const own = join(DIR, "roles-config")
    mkdirSync(join(own, "skills"), { recursive: true })
    mkdirSync(join(own, "plugins"), { recursive: true })
    writeFileSync(join(own, "settings.json"), "{}")
    writeFileSync(
      join(real, "roster.json"),
      JSON.stringify({ agents: [{ kind: "worker", name: "abc-worker", status: "working" }] }),
    )
    const { config, roles } = await sessionRoles(
      [
        { command: "ls", cwd: "/h", name: "abc-worker", session: "s1" },
        { command: "ls", cwd: "/h", name: "stranger", session: "s2" },
        { command: "ls", cwd: "/h", session: "s3" },
      ],
      { CLAUDE_CONFIG_DIR: own, HOME: DIR, PLAYGROUND_DATA_DIR: real },
      DIR,
    )
    // the installed skills and plugins a hook reads (writing-first's installed()) resolve to the real config's
    for (const entry of ["plugins", "settings.json", "skills"])
      expect(realpathSync(join(config, entry))).toBe(realpathSync(join(own, entry)))
    // an entry the real config lacks stays absent
    const bare = join(DIR, "roles-bare-config")
    mkdirSync(join(bare, "skills"), { recursive: true })
    const { config: partial } = await sessionRoles([], { CLAUDE_CONFIG_DIR: bare, HOME: DIR }, DIR)
    expect(existsSync(join(partial, "skills"))).toBe(true)
    expect(existsSync(join(partial, "plugins"))).toBe(false)
    expect(existsSync(join(partial, "settings.json"))).toBe(false)
    expect([...roles]).toEqual([
      ["abc-worker", "worker"],
      ["stranger", ""],
    ])
    expect(JSON.parse(readFileSync(join(config, "sessions", "s1.json"), "utf8"))).toEqual({
      name: "abc-worker",
      sessionId: "s1",
    })
    expect(existsSync(join(config, "sessions", "s3.json"))).toBe(false)
  })

  test("writing-first gives a session's call the same answer under the scratch registry as under the real config, since it reads the real installed skills", async () => {
    const own = join(DIR, "writing-config")
    mkdirSync(join(own, "skills", "writing-for-agents"), { recursive: true })
    writeFileSync(join(own, "skills", "writing-for-agents", "SKILL.md"), "x")
    const repo = join(DIR, "writing-repo")
    mkdirSync(join(repo, ".git"), { recursive: true })
    mkdirSync(join(repo, "extensions", "core", "skills", "playbook"), { recursive: true })
    writeFileSync(join(repo, "extensions", "core", "skills", "playbook", "SKILL.md"), "x")
    const data = join(DIR, "writing-data")
    mkdirSync(data, { recursive: true })
    const { config } = await sessionRoles(
      [{ command: "ls", cwd: repo, name: "abc-worker", session: "s1" }],
      { CLAUDE_CONFIG_DIR: own, HOME: DIR, PLAYGROUND_DATA_DIR: data },
      DIR,
    )
    const writing = (await import("../../../../scripts/hooks/writing-first")).check as Check
    const raw = JSON.stringify({
      cwd: repo,
      hook_event_name: "PreToolUse",
      session_id: "s1",
      tool_input: { content: "x", file_path: join(repo, "AGENTS.md") },
      tool_name: "Write",
    })
    const as = (dir: string) => ({ CLAUDE_CONFIG_DIR: dir, HOME: DIR, PLAYGROUND_DATA_DIR: data })
    const real = await writing(raw, as(own))
    expect(real).toContain("writing-first hook refuses")
    expect(await writing(raw, as(config))).toBe(real)
  })

  test("by session the replay keeps one call per session, each with its session and the name its transcript gave it", async () => {
    const projects = join(DIR, "named-projects")
    mkdirSync(join(projects, "p", "s1", "subagents"), { recursive: true })
    const now = new Date().toISOString()
    const bash = (session: string) =>
      JSON.stringify({
        cwd: "/h",
        message: { content: [{ input: { command: "ls" }, name: "Bash", type: "tool_use" }] },
        sessionId: session,
        timestamp: now,
      })
    const named = (session: string, name: string) =>
      JSON.stringify({ agentName: name, sessionId: session, type: "agent-name" })
    writeFileSync(
      join(projects, "p", "s1.jsonl"),
      [named("s1", "first-name"), bash("s1"), named("s1", "abc-worker")].join("\n"),
    )
    writeFileSync(join(projects, "p", "s1", "subagents", "a.jsonl"), bash("s1"))
    writeFileSync(join(projects, "p", "s2.jsonl"), bash("s2"))
    expect(await calls(projects, Date.now() - 3600_000)).toEqual([{ command: "ls", cwd: "/h" }])
    const list = await calls(projects, Date.now() - 3600_000, true)
    expect(list.toSorted((x, y) => x.session!.localeCompare(y.session!))).toEqual([
      { command: "ls", cwd: "/h", loaded: false, name: "abc-worker", session: "s1" },
      { command: "ls", cwd: "/h", loaded: false, session: "s2" },
    ])
  })
})

// A transcript's lines as Claude Code writes them: a Bash or Skill call, a typed prompt and a compaction
const bashLine = (
  command: string,
  session: string,
  cwd = "/h",
  timestamp = new Date().toISOString(),
) =>
  JSON.stringify({
    cwd,
    message: { content: [{ input: { command }, name: "Bash", type: "tool_use" }] },
    sessionId: session,
    timestamp,
    type: "assistant",
  })
const skillLine = (skill: string, session: string, timestamp = new Date().toISOString()) =>
  JSON.stringify({
    cwd: "/h",
    message: { content: [{ input: { skill }, name: "Skill", type: "tool_use" }] },
    sessionId: session,
    timestamp,
    type: "assistant",
  })
const typedLine = (content: unknown, session: string) =>
  JSON.stringify({ message: { content, role: "user" }, sessionId: session, type: "user" })
const compactLine = (session: string) =>
  JSON.stringify({ sessionId: session, subtype: "compact_boundary", type: "system" })

describe("a replay of a mark-reading hook", () => {
  test("by session each call says whether its transcript loaded writing-for-agents since its last compaction, a load before the window included", async () => {
    const projects = join(DIR, "loaded-projects")
    mkdirSync(join(projects, "p", "s1", "subagents"), { recursive: true })
    const old = "2000-01-01T00:00:00Z"
    writeFileSync(
      join(projects, "p", "s1.jsonl"),
      [
        bashLine("echo a", "s1", "/h", old),
        skillLine("writing-for-agents", "s1", old),
        bashLine("echo b", "s1"),
        compactLine("s1"),
        bashLine("echo b", "s1"),
        bashLine("echo c", "s1"),
        typedLine("<command-name>/ws-home:writing-for-agents</command-name>", "s1"),
        bashLine("echo d", "s1"),
        compactLine("s1"),
        typedLine([{ text: "/writing-for-agents", type: "text" }], "s1"),
        bashLine("echo e", "s1"),
        compactLine("s1"),
        skillLine("writing-for-agents-draft", "s1"),
        typedLine(
          [{ content: "/writing-for-agents", tool_use_id: "t", type: "tool_result" }],
          "s1",
        ),
        bashLine("echo f", "s1"),
      ].join("\n"),
    )
    writeFileSync(join(projects, "p", "s1", "subagents", "a.jsonl"), bashLine("echo g", "s1"))
    const since = Date.now() - 3600_000
    const list = await calls(projects, since, true)
    expect(list.map(({ command, loaded }) => [command, loaded]).toSorted()).toEqual([
      ["echo b", false],
      ["echo b", true],
      ["echo c", false],
      ["echo d", true],
      ["echo e", true],
      ["echo f", false],
      ["echo g", false],
    ])
    for (const call of await calls(projects, since)) expect(call).not.toHaveProperty("loaded")
  })

  test("a compaction's summary that quotes a typed load is no load, since writing-first clears the mark at the compaction", async () => {
    const projects = join(DIR, "summary-projects")
    mkdirSync(join(projects, "p"), { recursive: true })
    const summary = JSON.stringify({
      isCompactSummary: true,
      message: {
        content:
          "Summary: earlier the session ran <command-name>/writing-for-agents</command-name>.",
        role: "user",
      },
      sessionId: "s1",
      type: "user",
    })
    writeFileSync(
      join(projects, "p", "s1.jsonl"),
      [
        typedLine("<command-name>/writing-for-agents</command-name>", "s1"),
        bashLine("echo a", "s1"),
        compactLine("s1"),
        summary,
        bashLine("echo b", "s1"),
      ].join("\n"),
    )
    const list = await calls(projects, Date.now() - 3600_000, true)
    expect(list.map(({ command, loaded }) => [command, loaded]).toSorted()).toEqual([
      ["echo a", true],
      ["echo b", false],
    ])
  })

  // a factory checkout (its .git and core's playbook), a config with writing-for-agents installed, and one transcript that writes AGENTS.md before a load, after it and after a compaction
  const writingFixture = (name: string) => {
    const own = join(DIR, `${name}-config`)
    mkdirSync(join(own, "skills", "writing-for-agents"), { recursive: true })
    writeFileSync(join(own, "skills", "writing-for-agents", "SKILL.md"), "x")
    const repo = join(DIR, `${name}-repo`)
    mkdirSync(join(repo, ".git"), { recursive: true })
    mkdirSync(join(repo, "extensions", "core", "skills", "playbook"), { recursive: true })
    writeFileSync(join(repo, "extensions", "core", "skills", "playbook", "SKILL.md"), "x")
    const projects = join(DIR, `${name}-projects`)
    mkdirSync(join(projects, "p"), { recursive: true })
    writeFileSync(
      join(projects, "p", "s1.jsonl"),
      [
        bashLine("echo a > AGENTS.md", "s1", repo),
        skillLine("ws-home:writing-for-agents", "s1"),
        bashLine("echo b > AGENTS.md", "s1", repo),
        compactLine("s1"),
        bashLine("echo c > AGENTS.md", "s1", repo),
      ].join("\n"),
    )
    return { own, projects }
  }

  test("writing-first refuses the call before a load and the one after a compaction and lets the one after a load pass, whatever marks the real data folder holds", async () => {
    const { own, projects } = writingFixture("rebuilt")
    const list = await calls(projects, Date.now() - 3600_000, true)
    const writing = (await import("../../../../scripts/hooks/writing-first")).check as Check
    const allowAll: Check = () => undefined
    for (const marked of [true, false]) {
      const real = join(DIR, `rebuilt-data-${marked}`)
      mkdirSync(join(real, "writing-first"), { recursive: true })
      if (marked) writeFileSync(join(real, "writing-first", "s1"), "")
      const realEnv = { CLAUDE_CONFIG_DIR: own, HOME: DIR, PLAYGROUND_DATA_DIR: real }
      const { config, roles } = await sessionRoles(list, realEnv, DIR)
      const env = envOf({ config, data: scratchData(real, DIR), home: DIR, role: "session", roles })
      const { changed, counts } = await replay(
        allowAll,
        writing,
        list,
        DIR,
        undefined,
        undefined,
        env,
      )
      expect(counts).toEqual({ calls: 3, "newly allowed": 0, "newly refused": 2, same: 1 })
      expect(changed.map((line) => line.split(" :: ")[1]).toSorted()).toEqual([
        "echo a > AGENTS.md",
        "echo c > AGENTS.md",
      ])
      expect(readdirSync(join(real, "writing-first"))).toEqual(marked ? ["s1"] : [])
    }
  })
})

describe("a GLM replay", () => {
  test("--glm takes a replay alone, and its env points ANTHROPIC_BASE_URL where no-glm-heavy-path reads a GLM session", async () => {
    const base = ["--canary", "HEAD", "--hook", "x"]
    expect(parse(["replay", ...base, "--glm"])?.glm).toBe(true)
    expect(parse(["replay", ...base])?.glm).toBe(false)
    expect(parse(["sweep", "--forms", "f.ts", ...base, "--glm"])).toBeUndefined()
    const call = { command: "ls", cwd: "/h" }
    const glm = envOf({ data: "/d", glm: true, home: "/h" })(call)
    expect(glm).toEqual({
      ANTHROPIC_BASE_URL: GLM_BASE_URL,
      HOME: "/h",
      PATH: process.env.PATH,
      PLAYGROUND_DATA_DIR: "/d",
    })
    const { onGlm } = await import("../../../../scripts/hooks/no-glm-heavy-path")
    const raw = JSON.stringify({ session_id: "s1" })
    expect(await onGlm(raw, glm)).toBe(true)
    expect(await onGlm(raw, envOf({ data: "/d", home: "/h" })(call))).toBe(false)
  })

  test("--glm keeps each Bash call a GLM model made, by the call's own model, from every transcript on disk whatever its age", async () => {
    const projects = join(DIR, "glm-projects")
    mkdirSync(join(projects, "p"), { recursive: true })
    const modelLine = (command: string, model: string, timestamp = new Date().toISOString()) =>
      JSON.stringify({
        cwd: "/h",
        message: { content: [{ input: { command }, name: "Bash", type: "tool_use" }], model },
        timestamp,
        type: "assistant",
      })
    writeFileSync(join(projects, "p", "claude.jsonl"), modelLine("echo a", "claude-opus-5-5"))
    const old = join(projects, "p", "old-glm.jsonl")
    writeFileSync(old, modelLine("echo b", "glm-5.3", "2000-01-01T00:00:00Z"))
    utimesSync(old, 1_000, 1_000)
    writeFileSync(
      join(projects, "p", "mixed.jsonl"),
      [modelLine("echo c", "glm-5.3-flash"), modelLine("echo d", "claude-sonnet-5-5")].join("\n"),
    )
    const since = Date.now() - 3600_000
    const commands = (list: { command: string }[]) => list.map((c) => c.command).toSorted()
    expect(commands(await calls(projects, since, false, true))).toEqual(["echo b", "echo c"])
    expect(commands(await calls(projects, since))).toEqual(["echo a", "echo c", "echo d"])
  })
})

// A hook whose check() takes the main checkout reads it from its own folder when none is given, and canary's unpacked tree is no checkout of the repository, so the differential hands both sides the head's (PG-996)
describe("a hook that takes the main checkout", () => {
  // refuses a command that names its main checkout; with none given, main is the folder it would read from its own tree
  const guard =
    (fallback: string): Check =>
    (raw, _env, main = fallback) =>
      JSON.parse(raw).tool_input.command.includes(`${main}/`) ? "refused" : undefined
  const canary = guard("/tmp/hook-differential/abc")
  const head = guard("/main")
  const forms = [{ command: "echo x > /main/f", inClass: false }]

  test("reads the head's main checkout on both sides, so a sweep and a replay count the same verdict as the same", async () => {
    const { changed, counts } = await sweep(canary, head, forms, "/h", "/main")
    expect(counts).toMatchObject({
      cases: 3,
      "newly allowed": { inClass: 0, outClass: 0 },
      "newly refused": { inClass: 0, outClass: 0 },
      same: 3,
    })
    expect(changed).toEqual([])
    const call = { command: "echo x > /main/f", cwd: "/h" }
    expect((await replay(canary, head, [call], "/h", "/main")).counts).toMatchObject({
      "newly refused": 0,
      same: 1,
    })
  })

  test("guards gives its main-checkout guards the head's main checkout on both sides, so a form naming it reads the same", async () => {
    // a side's guards runs its GUARDS, whose no-main-checkout reads its own tree as main unless given one, as the real hook's default does
    const side = (name: string) => {
      const hooks = join(DIR, "guards-main", name, "scripts", "hooks")
      mkdirSync(hooks, { recursive: true })
      writeFileSync(
        join(hooks, "no-main-checkout.ts"),
        'export const check = (raw: string, _env: unknown, main = import.meta.dir) => JSON.parse(raw).tool_input.command.includes(`${main}/`) ? "refused" : undefined\n',
      )
      writeFileSync(
        join(hooks, "guards.ts"),
        'import { check as mainCheckout } from "./no-main-checkout"\nexport const GUARDS = [{ factory: true, name: "no-main-checkout", run: (raw: string, env: unknown) => mainCheckout(raw, env) }]\nexport const check = async (raw: string, env: unknown, guards = GUARDS) => (await Promise.all(guards.map((g) => g.run(raw, env)))).find(Boolean)\n',
      )
      return join(hooks, "guards.ts")
    }
    const command = `echo x > ${join(DIR, "guards-main", "head", "scripts", "hooks")}/f`
    const raw = JSON.stringify({ tool_input: { command } })
    const main = join(DIR, "guards-main", "head", "scripts", "hooks")
    const canary = await checkOf(side("canary"), "guards", main)
    const head = await checkOf(side("head"), "guards", main)
    expect(await head(raw, {})).toBe("refused")
    expect(await canary(raw, {})).toBe("refused")
  })

  test("TAKES_MAIN names every hook whose check() takes the main checkout, and only those", async () => {
    const hooks = join(import.meta.dir, "../../../../scripts/hooks")
    const taking: string[] = []
    for await (const file of new Bun.Glob("*.ts").scan(hooks)) {
      const signature =
        /export (?:async )?function check\(([\s\S]*?)\)\s*:\s*(?:Promise|string)/.exec(
          await Bun.file(join(hooks, file)).text(),
        )?.[1]
      if (signature?.includes("main: string = mainCheckout("))
        taking.push(file.replace(/\.ts$/, ""))
    }
    expect(taking.length).toBeGreaterThan(0)
    expect([...TAKES_MAIN].sort()).toEqual(taking.sort())
  })
})

describe("a hook that reads beside its own copy", () => {
  // finds its checkout as packages/scripts/src/main-checkout.ts does: PLAYGROUND_REPO, else the folder above its own folder's git common dir, else its own folder
  const STUB = `import { dirname } from "node:path"
export const check = (raw) => {
  const git = Bun.spawnSync(["git", "-C", import.meta.dir, "rev-parse", "--path-format=absolute", "--git-common-dir"])
  const root = process.env.PLAYGROUND_REPO || (git.exitCode === 0 ? dirname(git.stdout.toString().trim()) : import.meta.dir)
  return JSON.parse(raw).tool_input.command.includes(root + "/") ? "refused" : undefined
}
`
  const copy = async (at: string) => {
    mkdirSync(join(at, "scripts", "hooks"), { recursive: true })
    writeFileSync(join(at, "scripts", "hooks", "stub.ts"), STUB)
    return (await import(join(at, "scripts", "hooks", "stub.ts"))).check as Check
  }

  test("reads the head's main checkout through PLAYGROUND_REPO on both sides, and the caller's value comes back after", async () => {
    const headRoot = realpathSync(mkdtempSync(join(DIR, "own-head-")))
    expect(Bun.spawnSync(["git", "init", "-q", headRoot]).exitCode).toBe(0)
    const head = await copy(headRoot)
    const canary = await copy(realpathSync(mkdtempSync(join(DIR, "own-canary-"))))
    const command = `echo x > ${headRoot}/f`
    const was = process.env.PLAYGROUND_REPO
    try {
      delete process.env.PLAYGROUND_REPO
      const swept = await sweep(
        canary,
        head,
        [{ command, inClass: false }],
        "/h",
        undefined,
        headRoot,
      )
      expect(swept.counts).toMatchObject({ "newly refused": { inClass: 0, outClass: 0 }, same: 3 })
      expect(swept.changed).toEqual([])
      expect(process.env.PLAYGROUND_REPO).toBeUndefined()
      process.env.PLAYGROUND_REPO = "/elsewhere"
      const replayed = await replay(
        canary,
        head,
        [{ command, cwd: "/h" }],
        "/h",
        undefined,
        headRoot,
      )
      expect(replayed.counts).toMatchObject({ "newly refused": 0, same: 1 })
      expect(process.env.PLAYGROUND_REPO).toBe("/elsewhere")
    } finally {
      if (was === undefined) delete process.env.PLAYGROUND_REPO
      else process.env.PLAYGROUND_REPO = was
    }
  })

  test("ROOT_READS names every file in the hooks' import graph that reads a path from its own folder, and only those", () => {
    const repo = join(import.meta.dir, "../../../..")
    const SPEC =
      /(?:^|\n)\s*(?:import|export)\b[^"'`]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g
    const OWN = /import\.meta\.(?:dir|dirname|filename|path|url)\b/
    const file = (base: string) =>
      [base, `${base}.ts`, join(base, "index.ts")].find(
        (c) => existsSync(c) && statSync(c).isFile(),
      )
    // a relative path from the importer, `@packages/<name>[/<sub>]` by its package's bun export else `src/<sub>`, and a package's own `@/<path>` under its `src`
    const target = (importer: string, spec: string): string | undefined => {
      if (spec.startsWith(".")) return file(resolve(dirname(importer), spec))
      const pkg = /^@packages\/([^/]+)(?:\/(.+))?$/.exec(spec)
      if (pkg) {
        const at = join(repo, "packages", pkg[1]!)
        const json = JSON.parse(readFileSync(join(at, "package.json"), "utf8")) as {
          exports?: Record<string, { bun?: string } | string>
        }
        const entry = json.exports?.[pkg[2] ? `./${pkg[2]}` : "."]
        const bun = typeof entry === "object" ? entry.bun : undefined
        return (bun && file(join(at, bun))) || file(join(at, "src", pkg[2] ?? "index"))
      }
      const own = /^@\/(.+)$/.exec(spec)
      const home = /^(.*\/packages\/[^/]+)\//.exec(importer)?.[1]
      return own && home ? file(join(home, "src", own[1]!)) : undefined
    }
    const seen = new Set<string>()
    const visit = (path: string) => {
      if (seen.has(path)) return
      seen.add(path)
      for (const m of readFileSync(path, "utf8").matchAll(SPEC)) {
        const found = target(path, (m[1] ?? m[2] ?? m[3])!)
        if (found) visit(found)
      }
    }
    const hooks = join(repo, "scripts", "hooks")
    for (const file of new Bun.Glob("*.ts").scanSync(hooks)) visit(join(hooks, file))
    const reading = [...seen]
      .filter((p) => OWN.test(readFileSync(p, "utf8")))
      .map((p) => relative(repo, p))
    expect(reading.length).toBeGreaterThan(0)
    expect(Object.keys(ROOT_READS).sort()).toEqual(reading.sort())
    for (const why of Object.values(ROOT_READS)) expect(why.length).toBeGreaterThan(0)
  })
})

describe("a stored result", () => {
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(
      ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { cwd, stderr: "pipe", stdout: "pipe" },
    )
      .stdout.toString()
      .trim()

  // a repo whose one hook allows a command holding ALLOW, and a forms module outside it
  const repo = (name: string) => {
    const root = join(DIR, name)
    mkdirSync(join(root, "scripts", "hooks"), { recursive: true })
    writeFileSync(join(root, "package.json"), `{"name":"t","private":true}\n`)
    writeFileSync(
      join(root, "scripts", "hooks", "x.ts"),
      `export const check = (raw: string) => (raw.includes("ALLOW") ? undefined : "refused")\n`,
    )
    git(root, "init", "-q")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "init")
    const forms = join(DIR, `${name}-forms.ts`)
    writeFileSync(forms, `export const forms = [{ command: "ls ALLOW", inClass: true }]\n`)
    return {
      forms,
      root,
      sha: git(root, "rev-parse", "HEAD"),
      tree: git(root, "rev-parse", "HEAD^{tree}"),
    }
  }

  const args = (forms: string, ...more: string[]) => [
    "sweep",
    "--forms",
    forms,
    "--canary",
    "HEAD",
    "--hook",
    "x",
    ...more,
  ]

  const run = (at: string, root: string, argv: string[], env: Record<string, string> = {}) => {
    return Bun.spawnSync(["bun", SCRIPT, ...argv], {
      cwd: root,
      env: scratchEnv(at, { TMPDIR: DIR, ...env }),
      stderr: "pipe",
      stdout: "pipe",
    })
  }

  const keyAt = (root: string, argv: string[], canary: string, at = DIR) =>
    keyOf({ canary, options: parse(argv)!, projects: join(at, "projects"), root })?.key

  test("a second run at the same key prints the first run's counts under its reused: line and starts no run-slot job", () => {
    const at = home("reused")
    const { forms, root, sha, tree } = repo("reused-repo")
    const first = run(at, root, args(forms), { RUN_SLOT_NICE: "10" })
    expect(first.exitCode).toBe(0)
    const counts = first.stdout.toString()
    expect(counts).toContain(`"hook":"x","cases":3`)
    const second = run(at, root, args(forms))
    const [line, ...rest] = second.stdout.toString().split("\n")
    const key = keyOf({
      canary: sha,
      options: parse(args(forms))!,
      projects: join(at, ".claude", "projects"),
      root,
    })!.key
    expect(line).toMatch(
      new RegExp(
        `^reused: ${key} from \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z, head ${tree}, canary ${sha}$`,
      ),
    )
    expect(rest.join("\n")).toBe(counts)
    expect(existsSync(join(at, "tickets"))).toBe(false)
  })

  test("a one-byte worktree change, a new canary sha, another forms blob and a newer transcript each move the key", () => {
    const { forms, root, sha } = repo("moved-repo")
    const original = keyAt(root, args(forms), sha)!
    expect(keyAt(root, args(forms), sha)).toBe(original)
    expect(keyAt(root, args(forms), "another")).not.toBe(original)
    const hook = join(root, "scripts", "hooks", "x.ts")
    writeFileSync(hook, `${readFileSync(hook, "utf8")} `)
    expect(keyAt(root, args(forms), sha)).toBeUndefined()
    git(root, "commit", "-qam", "one byte")
    const committed = keyAt(root, args(forms), sha)!
    expect(committed).not.toBe(original)
    writeFileSync(forms, `export const forms = [{ command: "ls ALLOW ", inClass: true }]\n`)
    expect(keyAt(root, args(forms), sha)).not.toBe(committed)
    const replayArgs = ["replay", "--canary", "HEAD", "--hook", "x"]
    const at = join(DIR, "moved")
    mkdirSync(join(at, "projects", "p"), { recursive: true })
    const transcript = join(at, "projects", "p", "s.jsonl")
    writeFileSync(transcript, "")
    utimesSync(transcript, 1_000, 1_000)
    const replayKey = keyAt(root, replayArgs, sha, at)
    expect(replayKey).toBeString()
    utimesSync(transcript, 2_000, 2_000)
    expect(keyAt(root, replayArgs, sha, at)).not.toBe(replayKey)
  })

  test.each([
    ["--fresh", ["--fresh"], new Date().toISOString()],
    ["a result over 24 h old", [], "2000-01-01T00:00:00.000Z"],
  ])("%s runs fresh through a run-slot ticket", async (_, more, iso) => {
    const at = home(`fresh-${more.length}`)
    const { forms, root, sha } = repo(`fresh-${more.length}-repo`)
    const key = keyOf({
      canary: sha,
      options: parse(args(forms))!,
      projects: join(at, ".claude", "projects"),
      root,
    })!
    await store(join(at, ".playground"), key, { changed: [], counts: ["stored"] })
    const path = resultPath(join(at, ".playground"), key.key)
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), at: iso }))
    const second = run(at, root, args(forms, ...more))
    expect(second.stdout.toString()).not.toContain("reused:")
    expect(readFileSync(join(at, "tickets"), "utf8")).toContain(`-- bun ${SCRIPT} sweep`)
  })

  // a repo whose hook x refused every form at canary (HEAD~1) and allows every form at its head, with a forms module of n made-up forms, so each form changes once from each of its three places
  const flipped = (name: string, n: number) => {
    const { root } = repo(name)
    writeFileSync(join(root, "scripts", "hooks", "x.ts"), `export const check = () => "refused"\n`)
    git(root, "commit", "-qam", "canary refuses all")
    writeFileSync(join(root, "scripts", "hooks", "x.ts"), `export const check = () => undefined\n`)
    git(root, "commit", "-qam", "head allows all")
    const forms = join(DIR, `${name}-forms.ts`)
    const list = Array.from({ length: n }, (_, i) => ({
      command: `ls made-up-${i}`,
      inClass: false,
    }))
    writeFileSync(forms, `export const forms = ${JSON.stringify(list)}\n`)
    const argv = (...more: string[]) => [
      "sweep",
      "--forms",
      forms,
      "--canary",
      "HEAD~1",
      "--hook",
      "x",
      ...more,
    ]
    return { argv, forms, root, sha: git(root, "rev-parse", "HEAD~1") }
  }

  const changedOf = (stderr: string) => stderr.split("\n").filter((l) => l.startsWith("x: "))

  test("past 20 changed lines a hook prints one line naming how many more it cut, and --all prints and stores every one", async () => {
    const at = home("cut")
    const { argv, root, sha } = flipped("cut-repo", 9)
    const cut = run(at, root, argv(), { RUN_SLOT_NICE: "10" })
    expect(cut.exitCode).toBe(0)
    expect(changedOf(cut.stderr.toString())).toHaveLength(21)
    expect(changedOf(cut.stderr.toString()).at(-1)).toBe(
      "x: 7 more changed lines not shown (--all prints them)",
    )
    const all = run(at, root, argv("--all"), { RUN_SLOT_NICE: "10" })
    expect(all.exitCode).toBe(0)
    expect(all.stdout.toString()).not.toContain("reused:")
    const lines = changedOf(all.stderr.toString())
    expect([lines.length, lines.some((l) => l.includes("more changed lines"))]).toEqual([27, false])
    const key = keyOf({
      canary: sha,
      options: parse(argv("--all"))!,
      projects: join(at, ".claude", "projects"),
      root,
    })!
    expect((await stored(join(at, ".playground"), key.key))?.changed).toEqual(lines)
  })

  test("a hook with 20 or fewer changed lines prints them all and no line about a cut", () => {
    const at = home("uncut")
    const { argv, root } = flipped("uncut-repo", 6)
    const lines = changedOf(run(at, root, argv(), { RUN_SLOT_NICE: "10" }).stderr.toString())
    expect([lines.length, lines.some((l) => l.includes("more changed lines"))]).toEqual([18, false])
  })

  test("--all moves the key, so a cut result is never reused for it", () => {
    const { argv, root, sha } = flipped("all-key-repo", 1)
    expect(keyAt(root, argv("--all"), sha)).not.toBe(keyAt(root, argv(), sha))
  })

  test("a result is read back while it is under a day old", async () => {
    const data = join(DIR, "data")
    await store(
      data,
      { canary: "c", head: "h", input: "i", key: "k" },
      { changed: [], counts: ["a"] },
    )
    const at = Date.parse((await stored(data, "k"))!.at)
    expect((await stored(data, "k", at + 23 * 3600_000))?.counts).toEqual(["a"])
    expect(await stored(data, "k", at + 24 * 3600_000)).toBeUndefined()
  })

  test("a run after a committed one-byte change runs fresh through a run-slot ticket", () => {
    const at = home("committed")
    const { forms, root } = repo("committed-repo")
    expect(run(at, root, args(forms), { RUN_SLOT_NICE: "10" }).exitCode).toBe(0)
    const hook = join(root, "scripts", "hooks", "x.ts")
    writeFileSync(hook, `${readFileSync(hook, "utf8")} `)
    git(root, "commit", "-qam", "one byte")
    expect(run(at, root, args(forms)).stdout.toString()).not.toContain("reused:")
    expect(readFileSync(join(at, "tickets"), "utf8")).toContain(`-- bun ${SCRIPT} sweep`)
  })

  // a repo whose canary (HEAD~1) has an allow-all hook z and no hook y; at its head y refuses a call holding REFUSE, and z refuses one only under the worker role and writes into the data folder it is given; with a transcript of that call from two sessions, one a roster worker's and one a name the roster lacks
  const gated = (name: string) => {
    const at = home(name)
    const { root } = repo(`${name}-repo`)
    const hooks = join(root, "scripts", "hooks")
    writeFileSync(join(hooks, "z.ts"), `export const check = () => undefined\n`)
    git(root, "add", "-A")
    git(root, "commit", "-qm", "canary")
    writeFileSync(
      join(hooks, "y.ts"),
      `export const check = (raw: string) => (raw.includes("REFUSE") ? "refused" : undefined)\n`,
    )
    writeFileSync(
      join(hooks, "z.ts"),
      `import { writeFileSync } from "node:fs"
export const check = (raw: string, env: Record<string, string | undefined>) => {
  writeFileSync(\`\${env.PLAYGROUND_DATA_DIR}/wrote\`, "")
  return env.PLAYGROUND_ROLE === "worker" && raw.includes("REFUSE") ? "refused" : undefined
}
`,
    )
    git(root, "add", "-A")
    git(root, "commit", "-qm", "head")
    mkdirSync(join(at, ".claude", "projects", "p"), { recursive: true })
    const now = new Date().toISOString()
    for (const [session, agent] of [
      ["s1", "abc-worker"],
      ["s2", "stranger"],
    ])
      writeFileSync(
        join(at, ".claude", "projects", "p", `${session}.jsonl`),
        [
          JSON.stringify({ agentName: agent, sessionId: session, type: "agent-name" }),
          JSON.stringify({
            cwd: join(at, "w"),
            message: {
              content: [{ input: { command: "ls REFUSE" }, name: "Bash", type: "tool_use" }],
            },
            sessionId: session,
            timestamp: now,
          }),
        ].join("\n"),
      )
    writeFileSync(
      join(at, ".playground", "roster.json"),
      JSON.stringify({ agents: [{ kind: "worker", name: "abc-worker", status: "working" }] }),
    )
    const counts = (hook: string, ...more: string[]) => {
      const done = run(at, root, ["replay", "--canary", "HEAD~1", "--hook", hook, ...more], {
        RUN_SLOT_NICE: "10",
      })
      expect(done.exitCode).toBe(0)
      return JSON.parse(done.stdout.toString().trim())
    }
    return { at, counts }
  }

  test("a hook canary lacks replays against an allow-all baseline, its refusals count as newly refused, and its report says so", () => {
    const { counts } = gated("new-hook")
    expect(counts("y")).toEqual({
      hook: "y",
      baseline: "allow-all: canary has no such hook",
      calls: 1,
      "newly allowed": 0,
      "newly refused": 1,
      same: 0,
    })
  })

  test("a role-gated hook finds its refusals under --role, and with --role session each call is judged as its own session, the default counted", () => {
    const { at, counts } = gated("role-gated")
    expect(counts("z")).toMatchObject({ calls: 1, "newly refused": 0, same: 1 })
    expect(counts("z", "--role", "worker")).toEqual({
      hook: "z",
      role: "worker",
      calls: 1,
      "newly allowed": 0,
      "newly refused": 1,
      same: 0,
    })
    expect(counts("z", "--role", "session")).toEqual({
      hook: "z",
      role: "session",
      "default role": 1,
      marked: 0,
      calls: 2,
      "newly allowed": 0,
      "newly refused": 1,
      same: 1,
    })
    expect(existsSync(join(at, ".playground", "wrote"))).toBe(false)
  })

  test("each mark-reading hook replays against the marks its transcripts rebuild alone, so neither the real marks nor an earlier hook's run moves its count", () => {
    const at = home("marks")
    const { root } = repo("marks-repo")
    const hooks = join(root, "scripts", "hooks")
    // refuses a call holding REFUSE while its session has no writing-first mark
    const reader = `import { existsSync } from "node:fs"
export const check = (raw: string, env: Record<string, string | undefined>) =>
  raw.includes("REFUSE") && !existsSync(\`\${env.PLAYGROUND_DATA_DIR}/writing-first/\${JSON.parse(raw).session_id}\`) ? "refused" : undefined
`
    for (const hook of ["m1", "m2"]) writeFileSync(join(hooks, `${hook}.ts`), reader)
    git(root, "add", "-A")
    git(root, "commit", "-qm", "head")
    mkdirSync(join(at, ".claude", "projects", "p"), { recursive: true })
    writeFileSync(
      join(at, ".claude", "projects", "p", "s1.jsonl"),
      [
        bashLine("cat REFUSE", "s1", join(at, "w")),
        skillLine("writing-for-agents", "s1"),
        bashLine("ls REFUSE", "s1", join(at, "w")),
      ].join("\n"),
    )
    // a mark the session holds today, which would let its call from before the load pass
    mkdirSync(join(at, ".playground", "writing-first"), { recursive: true })
    writeFileSync(join(at, ".playground", "writing-first", "s1"), "")
    const done = run(
      at,
      root,
      ["replay", "--canary", "HEAD~1", "--hook", "m1", "--hook", "m2", "--role", "session"],
      { RUN_SLOT_NICE: "10" },
    )
    expect(done.exitCode).toBe(0)
    const lines = done.stdout
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines).toEqual(
      ["m1", "m2"].map((hook) => ({
        hook,
        baseline: "allow-all: canary has no such hook",
        role: "session",
        "default role": 2,
        marked: 1,
        calls: 2,
        "newly allowed": 0,
        "newly refused": 1,
        same: 1,
      })),
    )
    expect(done.stderr.toString()).toContain("refused")
    expect(readdirSync(join(at, ".playground", "writing-first"))).toEqual(["s1"])
  })

  test("a --glm replay reads a GLM session's call from before the window as a GLM session's, and its counts line says so", () => {
    const at = home("glm")
    const { root } = repo("glm-repo")
    // refuses a call holding REFUSE from a session on the GLM endpoint
    writeFileSync(
      join(root, "scripts", "hooks", "g.ts"),
      `export const check = (raw: string, env: Record<string, string | undefined>) =>
  raw.includes("REFUSE") && /api\\.z\\.ai/.test(env.ANTHROPIC_BASE_URL ?? "") ? "refused" : undefined
`,
    )
    git(root, "add", "-A")
    git(root, "commit", "-qm", "head")
    mkdirSync(join(at, ".claude", "projects", "p"), { recursive: true })
    const transcript = join(at, ".claude", "projects", "p", "s1.jsonl")
    writeFileSync(
      transcript,
      JSON.stringify({
        cwd: join(at, "w"),
        message: {
          content: [{ input: { command: "ls REFUSE" }, name: "Bash", type: "tool_use" }],
          model: "glm-5.3",
        },
        sessionId: "s1",
        timestamp: "2000-01-01T00:00:00Z",
        type: "assistant",
      }),
    )
    utimesSync(transcript, 1_000, 1_000)
    const counts = (...more: string[]) => {
      const done = run(at, root, ["replay", "--canary", "HEAD~1", "--hook", "g", ...more], {
        RUN_SLOT_NICE: "10",
      })
      expect(done.exitCode).toBe(0)
      return JSON.parse(done.stdout.toString().trim())
    }
    expect(counts()).toMatchObject({ calls: 0 })
    expect(counts("--glm")).toEqual({
      hook: "g",
      baseline: "allow-all: canary has no such hook",
      glm: true,
      calls: 1,
      "newly allowed": 0,
      "newly refused": 1,
      same: 0,
    })
  })

  test("--glm moves the key, so a result is never reused for the other read", () => {
    const { root, sha } = repo("glm-key-repo")
    const replayArgs = ["replay", "--canary", "HEAD", "--hook", "x"]
    expect(keyAt(root, [...replayArgs, "--glm"], sha)).not.toBe(keyAt(root, replayArgs, sha))
  })

  test("--role moves the key, so a result is never reused for another role", () => {
    const { root, sha } = repo("role-key-repo")
    const replayArgs = ["replay", "--canary", "HEAD", "--hook", "x"]
    expect(keyAt(root, [...replayArgs, "--role", "worker"], sha)).not.toBe(
      keyAt(root, replayArgs, sha),
    )
    expect(keyAt(root, [...replayArgs, "--role", "worker"], sha)).not.toBe(
      keyAt(root, [...replayArgs, "--role", "session"], sha),
    )
  })

  test("a run whose worktree changes while it runs stores nothing, so the next run at the clean head runs fresh", () => {
    const at = home("moved-mid-run")
    const { forms, root } = repo("moved-mid-run-repo")
    const hook = join(root, "scripts", "hooks", "x.ts")
    // canary's hook, imported mid-run, stands in for an edit made while the run is in flight
    writeFileSync(
      hook,
      `import { writeFileSync } from "node:fs"\nif (process.env.RACE_TARGET) writeFileSync(process.env.RACE_TARGET, "export const check = () => undefined\\n")\nexport const check = () => "refused"\n`,
    )
    git(root, "commit", "-qam", "canary")
    writeFileSync(
      hook,
      `export const check = (raw: string) => (raw.includes("ALLOW") ? undefined : "refused")\n`,
    )
    git(root, "commit", "-qam", "head")
    const sweepAt = (...more: string[]) =>
      args(forms, ...more).map((a) => (a === "HEAD" ? "HEAD~1" : a))
    const first = run(at, root, sweepAt(), { RACE_TARGET: hook, RUN_SLOT_NICE: "10" })
    expect(first.exitCode).toBe(0)
    expect(git(root, "status", "--porcelain")).not.toBe("")
    git(root, "checkout", "--", ".")
    expect(existsSync(join(at, ".playground", "hook-differential", "results"))).toBe(false)
    expect(run(at, root, sweepAt()).stdout.toString()).not.toContain("reused:")
    expect(readFileSync(join(at, "tickets"), "utf8")).toContain(`-- bun ${SCRIPT} sweep`)
  })

  // a repo with a made-up GitHub origin whose hook x reads the factory's repository from its own copy's checkout, as no-protected-push's factoryRepo does through setting.ts, and refuses a merge there, or anywhere while it reads none; canary's unpacked tree has no origin of its own (PG-2036)
  test("a hook that reads its own checkout's origin gives the same verdict on both sides, since canary's tree takes the head main checkout's origin", () => {
    const at = home("origin")
    const { root } = repo("origin-repo")
    git(root, "remote", "add", "origin", "git@github.com:acme/made-up.git")
    writeFileSync(
      join(root, "scripts", "hooks", "x.ts"),
      `import { resolve } from "node:path"
import { originRepo } from ${JSON.stringify(SETTING)}
export const check = (raw: string) => {
  const repo = originRepo(resolve(import.meta.dir, "../.."))
  return !repo || raw.includes(\`--repo \${repo} \`) ? "refused" : undefined
}
`,
    )
    git(root, "commit", "-qam", "reads its origin")
    mkdirSync(join(at, ".claude", "projects", "p"), { recursive: true })
    writeFileSync(
      join(at, ".claude", "projects", "p", "s1.jsonl"),
      [
        bashLine("gh pr merge 1 --repo acme/made-up --squash", "s1", join(at, "w")),
        bashLine("gh pr merge 2 --repo other/elsewhere --squash", "s1", join(at, "w")),
      ].join("\n"),
    )
    const done = run(at, root, ["replay", "--canary", "HEAD", "--hook", "x", "--fresh"], {
      RUN_SLOT_NICE: "10",
    })
    expect(done.exitCode).toBe(0)
    expect(JSON.parse(done.stdout.toString().trim())).toEqual({
      hook: "x",
      calls: 2,
      "newly allowed": 0,
      "newly refused": 0,
      same: 2,
    })
  })
})
