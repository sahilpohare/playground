import { afterAll, expect, spyOn, test } from "bun:test"
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
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import { MARKER } from "../../../../packages/safe-delete/src"
import {
  commitExt,
  deriveHooks,
  deriveRoot,
  extensionsDir,
  extLog,
  GUARD_LISTS,
  lockPath,
  mustGit,
  relockRoot,
  rootLocked,
  scopeDir,
  scopesIn,
  setRootLock,
  type Who,
  withLock,
  writeFiles,
  writeTree,
} from "../../../../packages/settings/src"
import { judgeItem, putItem } from "../../../../packages/settings/src/items"

// The extensions root's file lock: macOS's user immutable flag on the root and everything under it, which withLock alone lifts; a machine with no chflags (Linux) has no lock, so the locked cases run on macOS alone.
const CHFLAGS = Bun.which("chflags")
const scratch = mkdtempSync(join(tmpdir(), "ext-folder-"))
// The locked-root cases below leave their roots locked, so the flag comes off before the folder goes.
afterAll(() => {
  if (CHFLAGS) Bun.spawnSync([CHFLAGS, "-R", "nouchg", scratch])
  rmSync(scratch, { force: true, recursive: true })
})

const data = (name: string) => join(scratch, name)
const folder = join(import.meta.dir, "../../../../packages/settings/src/folder.ts")

test("a write lands as one commit in its scope, its author who asked, its message the reason, with its trailers", () => {
  const sha = writeFiles(
    data("one"),
    "tester",
    new Map([["settings.json", '{"a":1}\n']]),
    { author: "worker-x", reason: "turn a on", trailers: [["Setting", "a"]] },
    new Map([["policy.json", "{}"]]),
  )
  const dir = scopeDir(data("one"), "tester")
  expect(mustGit(dir, ["rev-parse", "HEAD"])).toBe(sha!)
  expect(mustGit(dir, ["log", "-1", "--format=%an|%s"])).toBe("worker-x|turn a on")
  expect(readFileSync(join(extensionsDir(data("one")), "policy.json"), "utf8")).toBe("{}")
  expect(scopesIn(data("one"))).toEqual(["tester"])
  expect(extLog(data("one"), "tester", ["Setting", "a"])).toEqual([
    {
      at: expect.any(String),
      author: "worker-x",
      reason: "turn a on",
      sha: sha!,
      trailers: [["Setting", "a"]],
    },
  ])
})

test("why reads only its scope's commits whose trailer matches the line exactly, newest first", () => {
  const write = (scope: string, text: string, key: string) =>
    writeFiles(data("log"), scope, new Map([["settings.json", text]]), {
      author: "owner",
      reason: `set ${key}`,
      trailers: [["Setting", key]],
    })
  const first = write("tester", "1", "ui.theme")
  write("tester", "2", "ui.themeDark")
  write("acme", "2", "ui.theme")
  const third = write("tester", "3", "ui.theme")
  expect(extLog(data("log"), "tester", ["Setting", "ui.theme"]).map((e) => e.sha)).toEqual([
    third!,
    first!,
  ])
  expect(extLog(data("none"), "tester", ["Setting", "ui.theme"])).toEqual([])
})

test("a write that changes nothing makes no commit, unless it asks for an empty one", () => {
  const files = new Map([["a.md", "a"]])
  const commit = { author: "owner", reason: "a" }
  expect(writeFiles(data("same"), "tester", files, commit)).toBeString()
  expect(writeFiles(data("same"), "tester", files, commit)).toBeUndefined()
  const empty = commitExt(
    data("same"),
    "tester",
    { ...commit, allowEmpty: true, reason: "score 4" },
    () => {},
  )
  expect(mustGit(scopeDir(data("same"), "tester"), ["log", "-1", "--format=%H %s"])).toBe(
    `${empty} score 4`,
  )
})

test("core is refused, since it ships with the checkout", () => {
  expect(() =>
    writeFiles(data("core"), "core", new Map([["a.md", "a"]]), { author: "o", reason: "r" }),
  ).toThrow("core is Playground's own")
})

test("a null removes its file and the folders it leaves empty", () => {
  const commit = { author: "owner", reason: "r" }
  writeFiles(
    data("rm"),
    "tester",
    new Map([
      ["rules/a.md", "a"],
      ["b.md", "b"],
    ]),
    commit,
  )
  writeFiles(data("rm"), "tester", new Map([["rules/a.md", null]]), commit)
  expect(existsSync(join(scopeDir(data("rm"), "tester"), "rules"))).toBe(false)
  expect(readFileSync(join(scopeDir(data("rm"), "tester"), "b.md"), "utf8")).toBe("b")
})

test("a tree replaces every file of its scope but those it keeps", () => {
  const commit = { author: "owner", reason: "r" }
  writeTree(
    data("tree"),
    "tester",
    new Map([
      ["a.md", "a"],
      ["proposed/b.md", "b"],
    ]),
    commit,
  )
  writeTree(data("tree"), "tester", new Map([["c.md", "c"]]), commit, (path) =>
    path.startsWith("proposed/"),
  )
  expect(mustGit(scopeDir(data("tree"), "tester"), ["ls-files"]).split("\n")).toEqual([
    "c.md",
    "proposed/b.md",
  ])
})

test("each guard's list derives from the login's lists, and one it lacks is removed and named", () => {
  const lists = new Map(GUARD_LISTS.slice(1).map((name) => [`lists/${name}.json`, `["${name}"]`]))
  writeFiles(data("hooks"), "tester", lists, { author: "o", reason: "lists" })
  expect(
    deriveHooks(data("hooks"), "tester", extensionsDir(data("hooks")), data("hooks-core")),
  ).toEqual([GUARD_LISTS[0]])
  const root = extensionsDir(data("hooks"))
  expect(readFileSync(join(root, `hooks/${GUARD_LISTS[1]}.json`), "utf8")).toBe(
    `["${GUARD_LISTS[1]}"]`,
  )
  expect(existsSync(join(root, `hooks/${GUARD_LISTS[0]}.json`))).toBe(false)
})

test("a guard's list is the union of the login's, each org's and core's, so a login list and a core list both reach it", () => {
  const [name, other] = GUARD_LISTS
  const core = data("union-core")
  mkdirSync(join(core, "lists"), { recursive: true })
  writeFileSync(join(core, "lists", `${name}.json`), '["core-term","shared"]')
  writeFileSync(join(core, "lists", `${other}.json`), '{"a":["core"],"b":["core"]}')
  const commit = { author: "o", reason: "lists" }
  writeFiles(
    data("union"),
    "tester",
    new Map([[`lists/${name}.json`, '["login-term","shared"]']]),
    commit,
  )
  writeFiles(data("union"), "tester", new Map([[`lists/${other}.json`, '{"a":["login"]}']]), commit)
  writeFiles(data("union"), "acme", new Map([[`lists/${name}.json`, '["org-term"]']]), commit)
  deriveHooks(data("union"), "tester", extensionsDir(data("union")), core)
  const hook = (list: string) =>
    JSON.parse(readFileSync(join(extensionsDir(data("union")), `hooks/${list}.json`), "utf8"))
  expect(hook(name!)).toEqual(["login-term", "shared", "org-term", "core-term"])
  expect(hook(other!)).toEqual({ a: ["login", "core"], b: ["core"] })
})

test("a lock left behind by a write that died goes once stale", () => {
  mkdirSync(lockPath(data("locked")), { recursive: true })
  writeFileSync(join(lockPath(data("locked")), MARKER), "")
  const old = new Date(Date.now() - 10 * 60_000)
  utimesSync(lockPath(data("locked")), old, old)
  expect(
    writeFiles(data("locked"), "tester", new Map([["a.md", "a"]]), { author: "o", reason: "r" }),
  ).toBeString()
  expect(existsSync(lockPath(data("locked")))).toBe(false)
})

test("a write's lock carries makeScratch's marker while it runs, and is gone after (#545)", () => {
  const lock = lockPath(data("marked"))
  expect(withLock(data("marked"), () => existsSync(join(lock, MARKER)))).toBe(true)
  expect(existsSync(lock)).toBe(false)
  expect(readdirSync(dirname(lock)).filter((name) => name.startsWith(basename(lock)))).toEqual([])
})

test("an unmarked lock left behind goes aside once stale, and stays there with its refusal logged (#545)", () => {
  const lock = lockPath(data("unmarked"))
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, "left"), "")
  const old = new Date(Date.now() - 10 * 60_000)
  utimesSync(lock, old, old)
  const said = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(withLock(data("unmarked"), () => "ran", { wait: 1_000 })).toBe("ran")
    const left = readdirSync(dirname(lock)).filter((name) => name.startsWith(basename(lock)))
    expect(left).toHaveLength(1)
    expect(left[0]).toStartWith(`${basename(lock)}.stale-`)
    expect(String(said.mock.calls[0]?.[0])).toContain(`has no ${MARKER} marker`)
  } finally {
    said.mockRestore()
  }
})

test("a lock taken over as stale during a write keeps the write's result and leaves the new holder's lock (#545)", () => {
  const at = data("taken-over")
  const lock = lockPath(at)
  const said = spyOn(console, "error").mockImplementation(() => {})
  try {
    const result = withLock(at, () => {
      renameSync(lock, `${lock}.stale-test`)
      mkdirSync(lock)
      writeFileSync(join(lock, "owner"), "another")
      return "wrote"
    })
    expect(result).toBe("wrote")
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("another")
    expect(String(said.mock.calls[0]?.[0])).toContain("was taken over as stale")
  } finally {
    said.mockRestore()
  }
})

test("a lock taken after a wait reads as just taken, so its stale bound starts at the take (#545)", async () => {
  const at = data("waited")
  const lock = lockPath(at)
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { withLock } from ${JSON.stringify(folder)}\nwithLock(${JSON.stringify(at)}, () => { console.log("held"); Bun.sleepSync(1_500) })`,
    ],
    { stdout: "pipe" },
  )
  const reader = holder.stdout.getReader()
  await reader.read()
  const age = withLock(at, () => Date.now() - statSync(lock).mtimeMs)
  await holder.exited
  expect(age).toBeLessThan(500)
})

test("two processes writing at once both land, one commit each", async () => {
  const at = data("race")
  writeFiles(at, "tester", new Map([["seed.md", "seed"]]), { author: "o", reason: "seed" })
  const script = (name: string) =>
    `import { writeFiles } from ${JSON.stringify(folder)}
for (let i = 0; i < 5; i++) writeFiles(${JSON.stringify(at)}, "tester", new Map([["${name}-" + i + ".md", "x"]]), { author: "${name}", reason: "${name} " + i })`
  const runs = ["api", "cli"].map((name) =>
    Bun.spawn([process.execPath, "-e", script(name)], { stderr: "pipe" }),
  )
  const codes = await Promise.all(runs.map((run) => run.exited))
  expect(codes).toEqual([0, 0])
  const dir = scopeDir(at, "tester")
  expect(mustGit(dir, ["rev-list", "--count", "HEAD"])).toBe("11")
  expect(mustGit(dir, ["ls-files"]).split("\n")).toHaveLength(11)
  expect(mustGit(dir, ["status", "--porcelain"])).toBe("")
})

const ME = "made-up-me"
const OWNER: Who = { actor: "cli", author: "owner", inboxRef: null, reason: "seeded" }
const WORKER: Who = { ...OWNER, author: "made-up-worker", reason: "a new version" }
const REVIEWER: Who = { ...OWNER, author: "made-up-reviewer", reason: "judged" }
const ref = { key: "relay", kind: "script" as const, scope: ME }
const files = (version: string) => ({
  attachments: [],
  body: null,
  files: { "cli.ts": `console.log("${version}")` },
  value: null,
})
const revOf = (outcome: ReturnType<typeof putItem>) => {
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.rev
}

// A data folder holding one accepted item, its root then locked as playground ext lock locks it.
const lockedData = (name: string) => {
  const data = join(scratch, name)
  revOf(putItem(data, ref, files("v1"), OWNER, true))
  setRootLock(data, true)
  return data
}
// The error code a plain write of the path meets, or null when it lands.
const writeCode = (path: string) => {
  try {
    writeFileSync(path, "x")
    return null
  } catch (error) {
    return (error as NodeJS.ErrnoException).code
  }
}

test.skipIf(!CHFLAGS)(
  "a locked root takes a put and a judge, logs each lift and relock, and stays locked",
  () => {
    const data = lockedData("put-judge")
    const said = spyOn(console, "error")
    try {
      const v2 = revOf(putItem(data, ref, files("v2"), WORKER, false))
      revOf(judgeItem(data, ref, v2, { kind: "score", score: 3 }, REVIEWER))
      const lines = said.mock.calls.map((call) => String(call[0]))
      expect(
        lines.filter((line) => /^extensions' lock: lifted and relocked .+ in \d+ ms$/.test(line)),
      ).toHaveLength(2)
    } finally {
      said.mockRestore()
    }
    expect(rootLocked(extensionsDir(data))).toBe(true)
    expect(writeCode(join(scopeDir(data, ME), "new.json"))).toBe("EPERM")
  },
)

// One ops/log/ext-lock.log line per lift: its time, the trees it lifted (joined by ", "), the lift and relock's duration, load5 and the caller.
const LIFT_LINE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z lifted (.+?) in \d+ ms load5 \d+\.\d{2} by \S+/
const liftLines = (data: string) => {
  const log = join(data, "ops", "log", "ext-lock.log")
  return existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []
}

test.skipIf(!CHFLAGS)(
  "each lift of a locked root appends one line to ops/log/ext-lock.log, naming the scope folder it lifted",
  () => {
    const data = lockedData("lift-log")
    const v2 = revOf(putItem(data, ref, files("v2"), WORKER, false))
    revOf(judgeItem(data, ref, v2, { kind: "score", score: 3 }, REVIEWER))
    const lines = liftLines(data)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(LIFT_LINE.exec(line)?.[1]).toBe(scopeDir(data, ME))
  },
)

test.skipIf(!CHFLAGS)("a failed write still relocks the root and logs its lift", () => {
  const data = lockedData("lift-fail")
  expect(() =>
    withLock(data, () => {
      throw new Error("made-up failure")
    }),
  ).toThrow("made-up failure")
  expect(rootLocked(extensionsDir(data))).toBe(true)
  expect(liftLines(data)).toHaveLength(1)
  expect(liftLines(data)[0]).toMatch(LIFT_LINE)
})

test.skipIf(!CHFLAGS)(
  "a plain write into a locked root meets EPERM at its top, in a scope and in a scope's .git",
  () => {
    const data = lockedData("plain")
    const root = extensionsDir(data)
    const scope = scopeDir(data, ME)
    expect(
      [join(root, "new.json"), join(scope, "new.json"), join(scope, ".git", "new")].map(writeCode),
    ).toEqual(["EPERM", "EPERM", "EPERM"])
  },
)

test.skipIf(!CHFLAGS)("deriveRoot under withLock leaves a locked root locked", () => {
  const data = lockedData("derive")
  withLock(data, () => deriveRoot(data, ME))
  expect(rootLocked(extensionsDir(data))).toBe(true)
  expect(writeCode(join(extensionsDir(data), "new.json"))).toBe("EPERM")
})

test.skipIf(!CHFLAGS)("ext unlock clears the lock, and ext lock sets it again", () => {
  const data = lockedData("unlock")
  setRootLock(data, false)
  expect(rootLocked(extensionsDir(data))).toBe(false)
  expect(writeCode(join(scopeDir(data, ME), "new.json"))).toBeNull()
  setRootLock(data, true)
  expect(rootLocked(extensionsDir(data))).toBe(true)
})

// Every machine, Linux's test job included: a root with no lock takes its writes with no flag call.
test("an unlocked root sees no flag call", () => {
  const bin = join(scratch, "bin")
  const calls = join(scratch, "chflags.calls")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, "chflags"), `#!/bin/sh\necho "$@" >> '${calls}'\n`)
  chmodSync(join(bin, "chflags"), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const data = join(scratch, "unlocked")
    const v1 = revOf(putItem(data, ref, files("v1"), OWNER, false))
    revOf(judgeItem(data, ref, v1, { kind: "score", score: 3 }, REVIEWER))
    expect(rootLocked(extensionsDir(data))).toBe(false)
    expect(liftLines(data)).toEqual([])
  } finally {
    process.env.PATH = path
  }
  expect(existsSync(calls)).toBe(false)
})

const OTHER = "made-up-org"
// A locked root holding two scopes: the accepted item's, and another scope's settings.
const twoScopes = (name: string) => {
  const data = join(scratch, name)
  revOf(putItem(data, ref, files("v1"), OWNER, true))
  writeFiles(data, OTHER, new Map([["settings.json", "{}\n"]]), { author: "o", reason: "r" })
  setRootLock(data, true)
  return data
}
// chflags on PATH as the body given, which can call the real one at $REAL; the run's result, with PATH put back after.
const withChflags = <T>(name: string, body: string, run: () => T): T => {
  const bin = join(scratch, `bin-${name}`)
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, "chflags"), `#!/bin/sh\nREAL='${CHFLAGS}'\n${body}\n`)
  chmodSync(join(bin, "chflags"), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    return run()
  } finally {
    process.env.PATH = path
  }
}
// The real chflags, then a line of its words and the other scope's settings file's flags as it left them.
const logged = (calls: string, probe: string) =>
  `"$REAL" "$@"; c=$?\necho "$*|$(stat -f %Sf '${probe}')" >> '${calls}'\nexit $c`
const callsIn = (calls: string) =>
  readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("|"))
const allLocked = (data: string) =>
  [extensionsDir(data), scopeDir(data, ME), scopeDir(data, OTHER)].map(rootLocked)

test.skipIf(!CHFLAGS)(
  "a write to one scope lifts that scope alone, so every other scope stays locked while it runs",
  () => {
    const data = twoScopes("one-scope")
    const calls = join(scratch, "one-scope.calls")
    const probe = join(scopeDir(data, OTHER), "settings.json")
    withChflags("one-scope", logged(calls, probe), () =>
      revOf(putItem(data, ref, files("v2"), WORKER, false)),
    )
    expect(callsIn(calls)).toEqual([
      [`-R nouchg ${scopeDir(data, ME)}`, "uchg"],
      [`-R uchg ${scopeDir(data, ME)}`, "uchg"],
    ])
    expect(allLocked(data)).toEqual([true, true, true])
  },
)

test.skipIf(!CHFLAGS)("a write that touches the root lifts the whole root", () => {
  const data = twoScopes("root-write")
  const calls = join(scratch, "root-write.calls")
  const probe = join(scopeDir(data, OTHER), "settings.json")
  withChflags("root-write", logged(calls, probe), () =>
    writeFiles(
      data,
      ME,
      new Map([["settings.json", '{"a":1}\n']]),
      { author: "o", reason: "r" },
      new Map([["policy.json", "{}"]]),
    ),
  )
  expect(callsIn(calls)).toEqual([
    [`-R nouchg ${extensionsDir(data)}`, "-"],
    [`-R uchg ${extensionsDir(data)}`, "uchg"],
  ])
  expect(allLocked(data)).toEqual([true, true, true])
})

// git maintenance can remove a file of a scope's .git while the walk runs, which chflags reports as No such file or directory and exits 1.
test.skipIf(!CHFLAGS)(
  "a file gone by the time the walk reaches it is skipped on the lift and the relock",
  () => {
    const data = twoScopes("gone")
    const gone = join(scopeDir(data, ME), ".git", "objects", "maintenance.lock")
    const calls = join(scratch, "gone.calls")
    withChflags("gone", `echo "$*" >> '${calls}'\nexec "$REAL" "$@" '${gone}'`, () =>
      revOf(putItem(data, ref, files("v2"), WORKER, false)),
    )
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2)
    expect(allLocked(data)).toEqual([true, true, true])
  },
)

test.skipIf(!CHFLAGS)("a flag call that fails for any other reason still refuses the write", () => {
  const data = twoScopes("refused")
  const outcome = withChflags(
    "refused",
    `echo "chflags: $3: Operation not permitted" >&2\nexit 1`,
    () => putItem(data, ref, files("v2"), WORKER, false),
  )
  expect(outcome.ok).toBe(false)
  expect(outcome.ok ? "" : outcome.message).toContain("Operation not permitted")
})

// A write killed mid-way leaves its one scope unlocked under a locked root, which the ops tick's relock then locks.
test.skipIf(!CHFLAGS)("the relock locks a scope left unlocked under a locked root", () => {
  const data = twoScopes("half")
  Bun.spawnSync([CHFLAGS!, "-R", "nouchg", scopeDir(data, OTHER)])
  expect(rootLocked(scopeDir(data, OTHER))).toBe(false)
  expect(relockRoot(data)).toBe(true)
  expect(allLocked(data)).toEqual([true, true, true])
})

// Each root-level writer the per-scope lift leaves whole: the walk lifts and relocks the root, with the other scope's file unlocked during it.
const rootLifts = (name: string, write: (data: string) => unknown) => {
  const data = twoScopes(name)
  const calls = join(scratch, `${name}.calls`)
  const probe = join(scopeDir(data, OTHER), "settings.json")
  withChflags(name, logged(calls, probe), () => write(data))
  expect(callsIn(calls)).toEqual([
    [`-R nouchg ${extensionsDir(data)}`, "-"],
    [`-R uchg ${extensionsDir(data)}`, "uchg"],
  ])
  expect(allLocked(data)).toEqual([true, true, true])
}

test.skipIf(!CHFLAGS)("a first write to a scope with no folder yet lifts the whole root", () =>
  rootLifts("new-scope", (data) =>
    writeTree(data, "made-up-two", new Map([["a.md", "a"]]), { author: "o", reason: "r" }),
  ),
)

test.skipIf(!CHFLAGS)(
  "an accepted list's put lifts the whole root, since it can write the root's hooks/",
  () =>
    rootLifts("list-put", (data) =>
      revOf(
        putItem(
          data,
          { key: "no-public-leak", kind: "list", scope: ME },
          { attachments: [], body: null, files: null, value: ["made-up-term"] },
          OWNER,
          true,
        ),
      ),
    ),
)

test.skipIf(!CHFLAGS)("ext lock refuses a root that does not exist", () => {
  expect(() => setRootLock(join(scratch, "no-root"), true)).toThrow("does not exist")
})
