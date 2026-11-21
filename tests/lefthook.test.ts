import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
// run through bun, since node_modules/.bin/lefthook is an npm wrapper whose shebang wants node
const LEFTHOOK_BIN = "node_modules/.bin/lefthook"
const OWN_LEFTHOOK = `bun ${LEFTHOOK_BIN}`
// what a hook prints in a worktree with no lefthook installed, as AGENTS.md quotes it
const NO_LEFTHOOK = `error: Script not found "${LEFTHOOK_BIN}"`

// Of the hooks a checkout runs, git writes to stdin only for these. Anywhere else use_stdin reads nothing under git, but a hand-run `lefthook run <hook>` reads the caller's stdin to its end, so from an agent's shell, whose stdin never closes, it hangs.
const FED_BY_GIT = new Set(["post-rewrite", "pre-push", "reference-transaction"])

// Every path under a hook's config (commands, scripts, jobs, nested groups) that sets use_stdin.
const readingStdin = (node: unknown, path: string): string[] => {
  if (Array.isArray(node)) return node.flatMap((item, i) => readingStdin(item, `${path}[${i}]`))
  if (typeof node !== "object" || node === null) return []
  return Object.entries(node).flatMap(([key, value]) =>
    key === "use_stdin" && value === true ? [path] : readingStdin(value, `${path}.${key}`),
  )
}

test("only a hook git feeds on stdin reads it", async () => {
  // every YAML name lefthook reads its config and its local overrides from; this repo writes no TOML or JSON one
  const files = ["", "."]
    .flatMap((dot) =>
      ["yml", "yaml"].flatMap((ext) => [`${dot}lefthook.${ext}`, `${dot}lefthook-local.${ext}`]),
    )
    .map((name) => Bun.file(join(import.meta.dir, "..", name)))
  const reading: string[] = []
  for (const file of files) {
    if (!(await file.exists())) continue
    const config = (Bun.YAML.parse(await file.text()) ?? {}) as Record<string, unknown>
    for (const [hook, body] of Object.entries(config)) {
      if (!FED_BY_GIT.has(hook)) reading.push(...readingStdin(body, hook))
    }
  }
  expect(reading).toEqual([])
})

test("readingStdin finds use_stdin in commands, scripts and nested jobs", () => {
  expect(
    readingStdin(
      {
        commands: { build: { run: "x", use_stdin: true } },
        jobs: [{ group: { jobs: [{ run: "y", use_stdin: true }] } }],
        scripts: { "a.sh": { use_stdin: true }, "b.sh": { use_stdin: false } },
      },
      "pre-commit",
    ),
  ).toEqual([
    "pre-commit.commands.build",
    "pre-commit.jobs[0].group.jobs[0]",
    "pre-commit.scripts.a.sh",
  ])
})

test("the hooks run the committing worktree's own lefthook", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    lefthook?: string
  }
  expect(config.lefthook).toBe(OWN_LEFTHOOK)
})

// nothing from this machine's git or lefthook settings: git exports GIT_DIR into hooks, a global core.hooksPath stops the install, commit signing would reach for a real key, and LEFTHOOK=0 skips hooks
const SCRATCH_ENV: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !/^(GIT_|LEFTHOOK)/.test(entry[0]),
    ),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
}

// lefthook itself, in a scratch repo of its own with linked worktrees: hooks installed from one that is then removed still run in another with node_modules, and fail loudly in one without.
test("hooks outlive the worktree that installed them, and fail loudly without a lefthook", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lefthook-"))
  const run = (cwd: string, argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd, env: SCRATCH_ENV, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const git = (cwd: string, ...args: string[]) =>
    run(cwd, ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args])
  // a staged file, since lefthook skips a command when nothing is staged
  const commit = async (cwd: string, message: string) => {
    await Bun.write(join(cwd, `${message}.txt`), message)
    expect(git(cwd, "add", `${message}.txt`)).toMatchObject({ code: 0 })
    return git(cwd, "commit", "-q", "-m", message)
  }
  const withLefthook = (cwd: string) => {
    mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true })
    symlinkSync(join(ROOT, LEFTHOOK_BIN), join(cwd, LEFTHOOK_BIN))
  }
  const [main, a, b, c] = ["main", "a", "b", "c"].map((name) => join(dir, name)) as [
    string,
    string,
    string,
    string,
  ]
  try {
    mkdirSync(main)
    expect(git(main, "init", "-q")).toMatchObject({ code: 0 })
    await Bun.write(
      join(main, "lefthook.yml"),
      `lefthook: ${OWN_LEFTHOOK}\npre-commit:\n  commands:\n    mark:\n      run: echo hook-ran\n`,
    )
    expect(git(main, "add", "lefthook.yml")).toMatchObject({ code: 0 })
    expect(git(main, "commit", "-q", "-m", "config")).toMatchObject({ code: 0 })
    for (const [path, branch] of [
      [a, "a"],
      [b, "b"],
      [c, "c"],
    ] as const) {
      expect(git(main, "worktree", "add", "-q", "-b", branch, path)).toMatchObject({ code: 0 })
    }
    withLefthook(a)
    withLefthook(c)

    expect(run(a, ["bun", join(a, LEFTHOOK_BIN), "install"])).toMatchObject({ code: 0 })
    const hook = await Bun.file(join(main, ".git/hooks/pre-commit")).text()
    expect(hook).toContain(`${OWN_LEFTHOOK} "$@"`)
    expect(git(main, "worktree", "remove", "--force", a)).toMatchObject({ code: 0 })

    const own = await commit(c, "own")
    expect(own).toMatchObject({ code: 0 })
    expect(own.out).toContain("hook-ran")

    // the hook's fallback binary is the one A's link resolves to, in this checkout, so it outlives A; B stopping anyway proves the hook never falls back to another checkout's lefthook
    const none = await commit(b, "none")
    expect(none.code).not.toBe(0)
    expect(none.out).toContain(NO_LEFTHOOK)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// lefthook on this repo's own pre-commit build step, its run swapped for an echo, in a scratch repo: docs and Python tests alone skip the build, anything else builds
test("the pre-commit build skips a commit of docs and Python tests alone", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: { build: Record<string, unknown> } }
  }
  const build = { ...config["pre-commit"].commands.build, run: "echo build-ran" }
  const dir = mkdtempSync(join(tmpdir(), "lefthook-build-"))
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: dir, env: SCRATCH_ENV, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const buildsWith = async (files: string[]) => {
    expect(run(["git", "rm", "-q", "-r", "--cached", "--ignore-unmatch", "."])).toMatchObject({
      code: 0,
    })
    for (const file of files) await Bun.write(join(dir, file), file)
    expect(run(["git", "add", ...files])).toMatchObject({ code: 0 })
    const hook = run(["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-commit"])
    expect(hook).toMatchObject({ code: 0 })
    return hook.out.includes("build-ran")
  }
  try {
    expect(run(["git", "init", "-q"])).toMatchObject({ code: 0 })
    // JSON is YAML, so the step goes in as lefthook read it
    await Bun.write(
      join(dir, "lefthook.yml"),
      JSON.stringify({ "pre-commit": { commands: { build } } }),
    )
    const skipping = ["README.md", "docs/playground/x.md", "skills/a/SKILL.md", "tests/test_x.py"]
    expect(await buildsWith(skipping)).toBe(false)
    // lefthook's * crosses folders: nested Markdown alone and a nested Python test alone skip too
    expect(await buildsWith(["skills/playground/x/SKILL.md", "docs/playground/x.md"])).toBe(false)
    expect(await buildsWith(["tests/scripts/hooks/x.py"])).toBe(false)
    expect(await buildsWith(["docs/playground/x.md", "api/hono/src/x.ts"])).toBe(true)
    expect(await buildsWith(["api/hono/src/x.ts"])).toBe(true)
    expect(await buildsWith(["package.json"])).toBe(true)
    expect(await buildsWith([...skipping, "web/next/src/y.tsx"])).toBe(true)
    expect(await buildsWith(["tests/api/x.test.ts"])).toBe(true)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// lefthook on this repo's own type-check steps, through this checkout's commit-slot.ts and tsc, in a scratch repo holding a minimal tests/ and packages/scripts: a staged type error in either tree fails the commit, as CI's check-types does, and a commit staging neither runs neither, whatever the working tree holds
test("the pre-commit type checks fail a staged type error in a test or a packages/scripts file", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, Record<string, unknown>>; piped?: boolean }
  }
  const { "check-types-scripts": scripts, "check-types-tests": tests } =
    config["pre-commit"].commands
  const own = (step: Record<string, unknown> | undefined) => ({
    ...step,
    run: String(step?.run).replaceAll(
      "packages/scripts/src/",
      `${join(ROOT, "packages/scripts/src")}/`,
    ),
  })
  const manifest = async (path: string) =>
    (await Bun.file(join(ROOT, path)).json()) as { scripts: Record<string, string> }
  const dir = mkdtempSync(join(tmpdir(), "lefthook-types-"))
  const env = { ...SCRATCH_ENV, PATH: `${join(ROOT, "node_modules/.bin")}:${SCRATCH_ENV.PATH}` }
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: dir, env, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const tsconfig = JSON.stringify({
    compilerOptions: { module: "ESNext", noEmit: true, strict: true, target: "ESNext", types: [] },
  })
  const commitWith = async (files: Record<string, string>) => {
    expect(run(["git", "rm", "-q", "-r", "--cached", "-f", "--ignore-unmatch", "."])).toMatchObject(
      {
        code: 0,
      },
    )
    for (const [file, text] of Object.entries(files)) await Bun.write(join(dir, file), text)
    expect(run(["git", "add", ...Object.keys(files)])).toMatchObject({ code: 0 })
    return run(["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-commit"])
  }
  try {
    expect(run(["git", "init", "-q"])).toMatchObject({ code: 0 })
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          "check-types:tests": (await manifest("package.json")).scripts[
            "check-types:tests"
          ]!.replaceAll("packages/scripts/src/", `${join(ROOT, "packages/scripts/src")}/`),
        },
      }),
    )
    await Bun.write(
      join(dir, "packages/scripts/package.json"),
      JSON.stringify({
        scripts: {
          "check-types": (await manifest("packages/scripts/package.json")).scripts["check-types"],
        },
      }),
    )
    await Bun.write(join(dir, "packages/scripts/tsconfig.json"), tsconfig)
    await Bun.write(join(dir, "tests/tsconfig.json"), tsconfig)
    // JSON is YAML, so the steps go in as lefthook read them
    await Bun.write(
      join(dir, "lefthook.yml"),
      JSON.stringify({
        "pre-commit": {
          commands: { "check-types-scripts": own(scripts), "check-types-tests": own(tests) },
          piped: config["pre-commit"].piped,
        },
      }),
    )
    const broken = await commitWith({ "tests/a.test.ts": 'export const n: number = "one"\n' })
    expect(broken.code).not.toBe(0)
    expect(broken.out).toContain("TS2322")
    // TS1375: a top-level await in a file with no import or export, which reached CI alone on 3 Nov
    const script = await commitWith({
      "packages/scripts/src/x.ts": "await Promise.resolve()\n",
      "tests/a.test.ts": "export const n: number = 1\n",
    })
    expect(script.code).not.toBe(0)
    expect(script.out).toContain("TS1375")
    expect(
      await commitWith({
        "packages/scripts/src/x.ts": "export const x = await Promise.resolve(1)\n",
        "tests/a.test.ts": "export const n: number = 1\n",
      }),
    ).toMatchObject({ code: 0 })
    // both trees broken on disk but neither staged: the commit runs neither check
    await Bun.write(join(dir, "packages/scripts/src/x.ts"), "await Promise.resolve()\n")
    await Bun.write(join(dir, "tests/a.test.ts"), 'export const n: number = "one"\n')
    const neither = await commitWith({ "api/hono/src/y.ts": "export {}\n", "README.md": "x\n" })
    expect(neither).toMatchObject({ code: 0 })
    expect(neither.out).not.toContain("tsc")
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 120_000)

// lefthook on this repo's own build and type-check steps, each run swapped for an echo, in a scratch repo: the type checks read the build's dist, so they run after it
test("the pre-commit type checks run after the build", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, Record<string, unknown>>; piped?: boolean }
  }
  const {
    build,
    "check-types-scripts": scripts,
    "check-types-tests": tests,
  } = config["pre-commit"].commands
  const dir = mkdtempSync(join(tmpdir(), "lefthook-types-order-"))
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: dir, env: SCRATCH_ENV, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  try {
    expect(run(["git", "init", "-q"])).toMatchObject({ code: 0 })
    await Bun.write(
      join(dir, "lefthook.yml"),
      JSON.stringify({
        "pre-commit": {
          commands: {
            build: { ...build, run: "echo build-ran" },
            "check-types-scripts": { ...scripts, run: "echo scripts-ran" },
            "check-types-tests": { ...tests, run: "echo tests-ran" },
          },
          piped: config["pre-commit"].piped,
        },
      }),
    )
    for (const file of ["packages/scripts/src/x.ts", "tests/a.test.ts"])
      await Bun.write(join(dir, file), "x")
    expect(run(["git", "add", "."])).toMatchObject({ code: 0 })
    const hook = run(["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-commit"])
    expect(hook).toMatchObject({ code: 0 })
    const [built, ...checked] = ["build-ran", "scripts-ran", "tests-ran"].map((mark) =>
      hook.out.indexOf(mark),
    )
    expect(built).toBeGreaterThanOrEqual(0)
    for (const at of checked) expect(at).toBeGreaterThan(built!)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// lefthook on this repo's own conflict-marker step, its script run from this checkout, beside lint-staged (run swapped for an echo), in a scratch repo: a staged marker refuses the commit before the formatter can rewrite it
test("the pre-commit marker check refuses a staged conflict marker before lint-staged runs", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, Record<string, unknown>>; piped?: boolean }
  }
  const { "conflict-markers": markers, "lint-staged": lint } = config["pre-commit"].commands
  expect(markers).toBeDefined()
  expect(markers!.priority as number).toBeLessThan(lint!.priority as number)
  const dir = mkdtempSync(join(tmpdir(), "lefthook-markers-"))
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: dir, env: SCRATCH_ENV, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const hookWith = async (text: string) => {
    await Bun.write(join(dir, "notes.md"), text)
    expect(run(["git", "add", "notes.md"])).toMatchObject({ code: 0 })
    const hook = run(["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-commit"])
    return { ...hook, linted: hook.out.includes("lint-ran") }
  }
  try {
    expect(run(["git", "init", "-q"])).toMatchObject({ code: 0 })
    // JSON is YAML, so the steps go in as lefthook read them
    await Bun.write(
      join(dir, "lefthook.yml"),
      JSON.stringify({
        "pre-commit": {
          commands: {
            "conflict-markers": {
              ...markers,
              run: String(markers!.run).replace("packages/", `${ROOT}/packages/`),
            },
            "lint-staged": { ...lint, run: "echo lint-ran" },
          },
          piped: config["pre-commit"].piped,
        },
      }),
    )
    const refused = await hookWith("one\n<<<<<<< HEAD\ntwo\n=======\nthree\n>>>>>>> canary\n")
    expect(refused).toMatchObject({ linted: false })
    expect(refused.code).not.toBe(0)
    expect(refused.out).toContain("notes.md:2, notes.md:6")
    expect(await hookWith("one\ntwo\nthree\n")).toMatchObject({ code: 0, linted: true })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// pre-push's jobs that read the pushed refs on stdin run as scripts, since lefthook 2.2.2 skips every pre-push command and job while the checked-out branch has nothing new against its upstream, and runs a script on every push
const PUSH_SCRIPTS = {
  "commit-trailer.sh": 'bun --no-env-file packages/scripts/src/commit-trailer.ts --push "$1"',
  "conflict-markers.sh": "bun --no-env-file packages/scripts/src/conflict-markers.ts --push",
  "keeps-canary.sh": "bun --no-env-file packages/scripts/src/pr-merge/prepush.ts",
}

type PrePush = {
  commands?: Record<string, Record<string, unknown>>
  scripts?: Record<string, Record<string, unknown>>
}

const prePushConfig = async () =>
  (
    Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
      "pre-push": PrePush
    }
  )["pre-push"]

// a pre-push script's text, its paths pointed at this checkout so it runs from a scratch repo
const pushScript = async (name: string) =>
  (await Bun.file(join(ROOT, ".lefthook/pre-push", name)).text()).replaceAll(
    " packages/",
    ` ${ROOT}/packages/`,
  )

// a ZeroStarter sync overlays lefthook.yml with the starter's, which holds neither script, so this row goes red until each is restored
test("pre-push runs its stdin jobs as scripts, each execing its check", async () => {
  const prePush = await prePushConfig()
  for (const [name, command] of Object.entries(PUSH_SCRIPTS)) {
    expect(prePush.scripts?.[name]).toEqual({ runner: "bash", use_stdin: true })
    expect(prePush.commands?.[name.replace(/\.sh$/, "")]).toBeUndefined()
    const script = Bun.file(join(ROOT, ".lefthook/pre-push", name))
    expect(await script.exists()).toBe(true)
    expect(await script.text()).toContain(`\nexec ${command}\n`)
    // lefthook makes a script executable as it runs it, so a script committed without the bit leaves every checkout's tree changed after its first push
    const index = Bun.spawnSync(["git", "ls-files", "-s", `.lefthook/pre-push/${name}`], {
      cwd: ROOT,
    })
    expect(index.stdout.toString()).toStartWith("100755 ")
  }
})

// this repo's pre-push marker job, its script run from this checkout, in a scratch repo whose commits go in with hooks off, fed git's pre-push lines: each pushed ref is read from its remote sha when this clone has it, else from its merge-base with origin/canary, and a delete reads nothing
test("the pre-push marker check refuses a pushed conflict marker a hooks-off commit let through", async () => {
  const markers = await pushScript("conflict-markers.sh")
  const dir = mkdtempSync(join(tmpdir(), "lefthook-push-markers-"))
  const run = (argv: string[], stdin?: string) => {
    const result = Bun.spawnSync(argv, {
      cwd: dir,
      env: SCRATCH_ENV,
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const git = (...args: string[]) =>
    run([
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ])
  const commit = async (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    await Bun.write(join(dir, path), text)
    expect(git("add", path)).toMatchObject({ code: 0 })
    expect(git("commit", "-q", "-m", path)).toMatchObject({ code: 0 })
    return git("rev-parse", "HEAD").out.trim()
  }
  const ZERO = "0".repeat(40)
  const push = (local: string, remote: string) =>
    run(["bash", "-c", markers], `refs/heads/b ${local} refs/heads/b ${remote}\n`)
  try {
    expect(git("init", "-q")).toMatchObject({ code: 0 })
    const base = await commit("notes.md", "one\n")
    expect(git("update-ref", "refs/remotes/origin/canary", base)).toMatchObject({ code: 0 })
    const clean = await commit("notes.md", "one\ntwo\n")
    expect(push(clean, base)).toMatchObject({ code: 0 })
    // trailing whitespace, and a setext heading underlined with exactly seven `=`, which git's --check would flag
    const spaced = await commit("notes.md", "one  \ntwo\n\nTitle\n=======\n")
    expect(push(spaced, clean)).toMatchObject({ code: 0 })
    const block = "a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> origin/canary\n"
    const marked = await commit("scripts/hooks/bundled/guard.js", block)
    const refused = push(marked, spaced)
    expect(refused.code).not.toBe(0)
    expect(refused.out).toContain(
      "scripts/hooks/bundled/guard.js:2, scripts/hooks/bundled/guard.js:6",
    )
    // a remote branch that already holds the marker, pushed again with a clean commit on top: read from the remote sha, the push adds no marker
    const after = await commit("notes.md", "one\ntwo\nthree\n")
    expect(push(after, marked)).toMatchObject({ code: 0 })
    // a remote sha this clone lacks, as after another clone's push: read from the merge-base, which holds the marker
    const lacked = push(after, "f".repeat(40))
    expect(lacked.code).not.toBe(0)
    expect(lacked.out).toContain("scripts/hooks/bundled/guard.js:2")
    const branch = push(marked, ZERO)
    expect(branch.code).not.toBe(0)
    expect(branch.out).toContain("scripts/hooks/bundled/guard.js:2")
    expect(push(ZERO, marked)).toEqual({ code: 0, out: "" })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// this repo's pre-push trailer job, its script run from this checkout, in a scratch repo whose commits go in with --no-verify, the route that once let a Co-Authored-By trailer past commit-msg: a pushed commit that no live branch of the remote it pushes to holds yet is refused when its message holds the trailer, naming the amend that drops it, and that amend, run with commit-msg's step, clears the push
test("the pre-push trailer check refuses a pushed commit a --no-verify commit let a Co-authored-by trailer into", async () => {
  const trailer = await pushScript("commit-trailer.sh")
  const dir = mkdtempSync(join(tmpdir(), "lefthook-push-trailer-"))
  const hooks = join(dir, ".hooks")
  const run = (argv: string[], stdin?: string) => {
    const result = Bun.spawnSync(argv, {
      cwd: dir,
      env: SCRATCH_ENV,
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const git = (...args: string[]) =>
    run([
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      `core.hooksPath=${hooks}`,
      ...args,
    ])
  const commit = async (path: string, message: string) => {
    await Bun.write(join(dir, path), message)
    await Bun.write(join(dir, ".msg"), message)
    expect(git("add", path)).toMatchObject({ code: 0 })
    expect(git("commit", "-q", "--no-verify", "-F", ".msg")).toMatchObject({ code: 0 })
    return git("rev-parse", "HEAD").out.trim()
  }
  const ZERO = "0".repeat(40)
  // pre-push's first argument names the remote it pushes to, whose live branches hold what it leaves out
  const push = (local: string) =>
    run(
      ["bash", "-c", trailer, "pre-push", "origin"],
      `refs/heads/b ${local} refs/heads/b ${ZERO}\n`,
    )
  try {
    expect(git("init", "-q")).toMatchObject({ code: 0 })
    expect(git("init", "-q", "--bare", ".origin")).toMatchObject({ code: 0 })
    expect(git("remote", "add", "origin", join(dir, ".origin"))).toMatchObject({ code: 0 })
    // commit-msg's step alone, run by its path in this checkout, as lefthook would run it
    mkdirSync(hooks)
    await Bun.write(
      join(hooks, "commit-msg"),
      `#!/usr/bin/env bash\nexec bun --no-env-file ${ROOT}/packages/scripts/src/commit-trailer.ts "$1"\n`,
    )
    chmodSync(join(hooks, "commit-msg"), 0o755)
    const base = await commit("a.txt", "chore: base\n\nCo-Authored-By: A <a@b.c>\n")
    expect(git("push", "-q", "--no-verify", "origin", `${base}:refs/heads/canary`)).toMatchObject({
      code: 0,
    })
    // a commit every remote already holds is not read, the trailer on canary's base included
    expect(push(base)).toEqual({ code: 0, out: "" })
    const mention = await commit(
      "b.txt",
      "fix: a change\n\nThe hook drops a Co-authored-by trailer.\n",
    )
    expect(push(mention)).toMatchObject({ code: 0 })
    const tip = await commit(
      "c.txt",
      "build: rebuild\n\nCo-Authored-By: Claude <noreply@example.com>\n",
    )
    const last = push(tip)
    expect(last.code).not.toBe(0)
    expect(last.out).toContain(`${tip.slice(0, 9)} build: rebuild`)
    expect(last.out).toContain("git commit --amend --no-edit")
    const top = await commit("d.txt", "fix: after\n")
    const older = push(top)
    expect(older.code).not.toBe(0)
    expect(older.out).toContain(`${tip.slice(0, 9)} build: rebuild`)
    expect(older.out).toContain(
      `git rebase --rebase-merges --exec 'git commit --amend --no-edit' ${tip.slice(0, 9)}^`,
    )
    expect(push(ZERO)).toEqual({ code: 0, out: "" })
    // the amend the refusal names, with commit-msg's step on, drops the trailer and clears the push
    expect(
      git(
        "rebase",
        "-q",
        "--rebase-merges",
        "--exec",
        "git commit -q --amend --no-edit",
        `${tip}^`,
      ),
    ).toMatchObject({ code: 0 })
    const fixed = git("rev-parse", "HEAD").out.trim()
    expect(git("log", "-1", "--format=%B", "HEAD^").out).not.toContain("Co-Authored-By")
    expect(push(fixed)).toMatchObject({ code: 0 })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// the trailer check leaves out only what the remote it pushes to holds now, read live; each test builds on the one before
describe("the pre-push trailer check reads the remote's live branches, not its tracking refs", () => {
  const dir = mkdtempSync(join(tmpdir(), "lefthook-push-live-"))
  const work = join(dir, "work")
  const run = (argv: string[], stdin?: string, cwd = work) => {
    const result = Bun.spawnSync(argv, {
      cwd,
      env: SCRATCH_ENV,
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const git = (cwd: string, ...args: string[]) =>
    run(
      [
        "git",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      undefined,
      cwd,
    )
  const commit = (cwd: string, path: string, message: string) => {
    writeFileSync(join(cwd, path), message)
    expect(git(cwd, "add", path)).toMatchObject({ code: 0 })
    expect(git(cwd, "commit", "-q", "-m", message)).toMatchObject({ code: 0 })
    return git(cwd, "rev-parse", "HEAD").out.trim()
  }
  const ZERO = "0".repeat(40)
  const TRAILER = "\n\nCo-Authored-By: A <a@b.c>\n"
  let trailer = ""
  let held = ""
  const push = (local: string, remote = "origin") =>
    run(["bash", "-c", trailer, "pre-push", remote], `refs/heads/n ${local} refs/heads/n ${ZERO}\n`)

  beforeAll(async () => {
    trailer = await pushScript("commit-trailer.sh")
    expect(git(dir, "init", "-q", "--bare", "-b", "main", "origin.git")).toMatchObject({ code: 0 })
    expect(git(dir, "clone", "-q", join(dir, "origin.git"), "work")).toMatchObject({ code: 0 })
    held = commit(work, "a.txt", `chore: held${TRAILER}`)
    expect(git(work, "push", "-q", "origin", "HEAD:refs/heads/main")).toMatchObject({ code: 0 })
  })

  afterAll(() => rmSync(dir, { force: true, recursive: true }))

  test("a commit a live branch holds stays out", () => {
    expect(push(held)).toEqual({ code: 0, out: "" })
  })

  test("a remote it cannot read leaves every commit in", () => {
    const unread = push(held, join(dir, "nowhere.git"))
    expect(unread.code).not.toBe(0)
    expect(unread.out).toContain(`${held.slice(0, 9)} chore: held`)
  })

  test("a commit only a stale tracking ref holds, its branch deleted on the remote, is read", () => {
    const gone = commit(work, "b.txt", `chore: gone${TRAILER}`)
    expect(git(work, "push", "-q", "origin", "HEAD:refs/heads/gone")).toMatchObject({ code: 0 })
    expect(git(join(dir, "origin.git"), "branch", "-D", "gone")).toMatchObject({ code: 0 })
    expect(git(work, "rev-parse", "-q", "--verify", "refs/remotes/origin/gone").out.trim()).toBe(
      gone,
    )
    const stale = push(gone)
    expect(stale.code).not.toBe(0)
    expect(stale.out).toContain(`${gone.slice(0, 9)} chore: gone`)
    expect(stale.out).not.toContain(`${held.slice(0, 9)} chore: held`)
  })

  // a live branch's tip this repo has not fetched stands in by its own tracking ref, a stale read kept narrow on purpose: it misses a commit that branch dropped in a force-push this repo has not fetched
  test("a live branch whose new tip this repo lacks stands in by its tracking ref", () => {
    const other = join(dir, "other")
    expect(git(dir, "clone", "-q", "-b", "main", join(dir, "origin.git"), "other")).toMatchObject({
      code: 0,
    })
    commit(other, "c.txt", "chore: ahead")
    expect(git(other, "push", "-q", "origin", "HEAD:refs/heads/main")).toMatchObject({ code: 0 })
    expect(push(held)).toEqual({ code: 0, out: "" })
    // the residual: the branch force-pushed back past held, which this repo has not fetched, still stands in
    expect(git(other, "checkout", "-q", "--orphan", "fresh")).toMatchObject({ code: 0 })
    commit(other, "d.txt", "chore: rewritten")
    expect(git(other, "push", "-q", "-f", "origin", "HEAD:refs/heads/main")).toMatchObject({
      code: 0,
    })
    expect(push(held)).toEqual({ code: 0, out: "" })
  })
})

// the same pre-push job reads each new commit's message and the pushed branch or tag name against no-public-leak's list, a made-up one in a scratch data folder here, so a --no-verify commit holding a list term is refused before it reaches the remote; the refusal names the sha and the kind, never the term
test("the pre-push list check refuses a pushed commit message or branch or tag name holding a list term", async () => {
  const trailer = await pushScript("commit-trailer.sh")
  const dir = mkdtempSync(join(tmpdir(), "lefthook-push-lists-"))
  const data = join(dir, ".data")
  mkdirSync(join(data, "extensions", "hooks"), { recursive: true })
  const LIST = {
    companies: ["Vantorix"],
    handles: ["qmarsh"],
    linearKeys: ["MADEVX"],
    names: ["Quilla Marsh"],
    slackIds: ["C0MADE0401"],
  }
  writeFileSync(join(data, "extensions", "hooks", "no-public-leak.json"), JSON.stringify(LIST))
  const run = (
    argv: string[],
    stdin?: string,
    env = { ...SCRATCH_ENV, PLAYGROUND_DATA_DIR: data },
  ) => {
    const result = Bun.spawnSync(argv, {
      cwd: dir,
      env,
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const git = (...args: string[]) =>
    run([
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ])
  const commit = (path: string, message: string) => {
    writeFileSync(join(dir, path), message)
    expect(git("add", path)).toMatchObject({ code: 0 })
    expect(git("commit", "-q", "--no-verify", "-m", message)).toMatchObject({ code: 0 })
    return git("rev-parse", "HEAD").out.trim()
  }
  const ZERO = "0".repeat(40)
  const push = (local: string, branch = "b") =>
    run(
      ["bash", "-c", trailer, "pre-push", "origin"],
      `refs/heads/${branch} ${local} refs/heads/${branch} ${ZERO}\n`,
    )
  const printsNoTerm = (out: string) =>
    expect(
      ["vantorix", "qmarsh", "quilla"].filter((term) => out.toLowerCase().includes(term)),
    ).toEqual([])
  try {
    expect(git("init", "-q")).toMatchObject({ code: 0 })
    expect(git("init", "-q", "--bare", ".origin")).toMatchObject({ code: 0 })
    expect(git("remote", "add", "origin", join(dir, ".origin"))).toMatchObject({ code: 0 })
    const base = commit("a.txt", "chore: base for Vantorix")
    expect(git("push", "-q", "origin", `${base}:refs/heads/canary`)).toMatchObject({ code: 0 })
    // a commit a remote already holds is not read
    expect(push(base)).toEqual({ code: 0, out: "" })
    const clean = commit("b.txt", "fix: a plain change")
    expect(push(clean)).toEqual({ code: 0, out: "" })
    const named = push(clean, "fix-qmarsh-page")
    expect(named.code).not.toBe(0)
    expect(named.out).toContain("the pushed ref's name holds a handles term")
    printsNoTerm(named.out)
    // a tag's name is read as a branch's is
    const tag = run(
      ["bash", "-c", trailer, "pre-push", "origin"],
      `refs/tags/v1-qmarsh ${clean} refs/tags/v1-qmarsh ${ZERO}\n`,
    )
    expect(tag.code).not.toBe(0)
    expect(tag.out).toContain("the pushed ref's name holds a handles term")
    printsNoTerm(tag.out)
    const term = commit("c.txt", "fix: thanks Quilla Marsh")
    const refused = push(term)
    expect(refused.code).not.toBe(0)
    expect(refused.out).toContain(`${term.slice(0, 9)}'s message holds a names term`)
    printsNoTerm(refused.out)
    // a delete reads nothing
    expect(push(ZERO)).toEqual({ code: 0, out: "" })
    // a list file that is not the list is refused by its path, as the commit step refuses it
    writeFileSync(join(data, "extensions", "hooks", "no-public-leak.json"), "{")
    const broken = push(clean)
    expect(broken.code).not.toBe(0)
    expect(broken.out).toContain("is not no-public-leak's list")
    // with no list in the data folder the push passes
    rmSync(join(data, "extensions", "hooks", "no-public-leak.json"))
    expect(push(term)).toEqual({ code: 0, out: "" })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// the real lefthook on this repo's pre-push stdin scripts, their paths pointed at this checkout, in a scratch clone whose commits go in with hooks off: with main level with origin/main, a push of another branch is still read, and keeps-canary refuses a normal push as before
test("pre-push reads a pushed branch while the checked-out one has nothing new", async () => {
  const prePush = await prePushConfig()
  const dir = mkdtempSync(join(tmpdir(), "lefthook-push-other-"))
  const work = join(dir, "work")
  const run = (cwd: string, argv: string[], stdin?: string) => {
    const result = Bun.spawnSync(argv, {
      cwd,
      env: SCRATCH_ENV,
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const git = (...args: string[]) => {
    const result = run(work, [
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ])
    expect(result).toMatchObject({ code: 0 })
    return result.out.trim()
  }
  const commit = async (path: string, text: string) => {
    mkdirSync(join(work, path, ".."), { recursive: true })
    await Bun.write(join(work, path), text)
    git("add", path)
    git("commit", "-q", "-m", path)
    return git("rev-parse", "HEAD")
  }
  const remote = join(dir, "remote.git")
  const ZERO = "0".repeat(40)
  const push = (branch: string) =>
    run(
      work,
      ["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-push", "origin", remote],
      branch
        ? `refs/heads/${branch} ${git("rev-parse", branch)} refs/heads/${branch} ${ZERO}\n`
        : "",
    )
  try {
    const seed = join(dir, "seed")
    mkdirSync(seed)
    await Bun.write(join(seed, "a.ts"), "one\n")
    for (const argv of [
      ["git", "init", "-q", "-b", "main"],
      ["git", "add", "a.ts"],
      ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"],
      ["git", "branch", "canary"],
    ])
      expect(run(seed, argv)).toMatchObject({ code: 0 })
    expect(run(dir, ["git", "clone", "-q", "--bare", seed, remote])).toMatchObject({ code: 0 })
    expect(run(dir, ["git", "clone", "-q", remote, work])).toMatchObject({ code: 0 })
    // this checkout's stdin scripts alone: audit reaches the network, and ensure-branches reads no pushed ref
    const scripts: Record<string, unknown> = {}
    mkdirSync(join(work, ".lefthook/pre-push"), { recursive: true })
    for (const name of Object.keys(PUSH_SCRIPTS)) {
      scripts[name] = prePush.scripts?.[name]
      await Bun.write(join(work, ".lefthook/pre-push", name), await pushScript(name))
    }
    // JSON is YAML, so the jobs go in as lefthook read them
    await Bun.write(join(work, "lefthook.yml"), JSON.stringify({ "pre-push": { scripts } }))

    git("checkout", "-q", "--no-track", "-b", "marked", "origin/canary")
    await commit(
      "scripts/hooks/bundled/guard.js",
      "a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> origin/canary\n",
    )
    git("checkout", "-q", "--no-track", "-b", "tidy", "origin/canary")
    await commit("notes.md", "one\n")
    // canary gains a line, and a branch's merge of it drops that line in a file git merges clean
    git("checkout", "-q", "--no-track", "-b", "dropped", "origin/canary")
    await commit("b.ts", "two\n")
    git("checkout", "-q", "--no-track", "-b", "next", "origin/canary")
    await commit("a.ts", "one\ncanary\n")
    git("push", "-q", "origin", "next:canary")
    git("checkout", "-q", "dropped")
    git("merge", "-q", "--no-commit", "origin/canary")
    await Bun.write(join(work, "a.ts"), "one\n")
    git("add", "a.ts")
    git("commit", "-q", "--no-edit")
    git("checkout", "-q", "main")
    expect(git("rev-parse", "HEAD")).toBe(git("rev-parse", "origin/main"))

    const marked = push("marked")
    expect(marked.code).not.toBe(0)
    expect(marked.out).toContain(
      "scripts/hooks/bundled/guard.js:2, scripts/hooks/bundled/guard.js:6",
    )
    const dropped = push("dropped")
    expect(dropped.code).not.toBe(0)
    expect(dropped.out).toContain("a.ts (dropped in")
    expect(push("tidy")).toMatchObject({ code: 0 })
    expect(push("")).toMatchObject({ code: 0 })
    // a normal push, from the branch itself, which keeps-canary refused as a command too
    git("checkout", "-q", "dropped")
    const normal = push("dropped")
    expect(normal.code).not.toBe(0)
    expect(normal.out).toContain("a.ts (dropped in")
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// two tests scan the tracked tree's text, so a commit anywhere can break them, and with no hook to run them a break went red in CI minutes after its push
const TREE_TEXT_TESTS = ["tests/cmux.test.ts", "tests/shell-read-redirect.test.ts"]

test("one pre-commit job runs both whole-tree text tests, beside trace-count", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, { priority?: number; run: string }> }
  }
  const { commands } = config["pre-commit"]
  const running = Object.entries(commands).filter(([, job]) =>
    TREE_TEXT_TESTS.some((file) => job.run.includes(file)),
  )
  expect(running.map(([name]) => name)).toEqual(["text-tests"])
  const job = running[0]![1]
  expect(job.run).toStartWith("bun run test:file ")
  for (const file of TREE_TEXT_TESTS) expect(job.run.split(/\s+/)).toContain(file)
  expect(job.priority).toBe(commands["trace-count"]!.priority)
})

// lefthook 2.2.2 picks a job's files from its files: command only through a {files} in its run; without one it filters the staged files, so files: can only skip the job (measured)
const filesWithoutTemplate = (node: unknown, path: string): string[] => {
  if (Array.isArray(node))
    return node.flatMap((item, i) => filesWithoutTemplate(item, `${path}[${i}]`))
  if (typeof node !== "object" || node === null) return []
  const job = node as Record<string, unknown>
  const own =
    "files" in job && typeof job.run === "string" && !job.run.includes("{files}") ? [path] : []
  return [
    ...own,
    ...Object.entries(job).flatMap(([key, value]) => filesWithoutTemplate(value, `${path}.${key}`)),
  ]
}

// YAML reads a space and # in a plain scalar as a comment, so an unquoted run drops the rest of its line, a {files} there included
const unquotedHashRuns = (text: string, name: string): string[] =>
  text.split("\n").flatMap((line, i) => {
    const value = line.match(/^\s*(?:-\s+)?run:\s+(.*)$/)?.[1]
    return value !== undefined && !/^["'>|]/.test(value) && /\s#/.test(value)
      ? [`${name}:${i + 1}`]
      : []
  })

const COMMENTED_FILES =
  "pre-commit:\n  commands:\n    probe:\n      files: git ls-files\n      run: echo # {files}\n"

test("every job with files: names {files} in its run", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text())
  expect(filesWithoutTemplate(config, "lefthook.yml")).toEqual([])
  expect(filesWithoutTemplate(Bun.YAML.parse(COMMENTED_FILES), "sample")).toEqual([
    "sample.pre-commit.commands.probe",
  ])
  expect(
    filesWithoutTemplate(
      Bun.YAML.parse(COMMENTED_FILES.replace("echo # {files}", '"echo # {files}"')),
      "sample",
    ),
  ).toEqual([])
})

test("every run holding a space and # is quoted", async () => {
  expect(
    unquotedHashRuns(await Bun.file(join(ROOT, "lefthook.yml")).text(), "lefthook.yml"),
  ).toEqual([])
  expect(unquotedHashRuns(COMMENTED_FILES, "sample")).toEqual(["sample:5"])
  expect(
    unquotedHashRuns(COMMENTED_FILES.replace("echo # {files}", '"echo # {files}"'), "sample"),
  ).toEqual([])
})

// every worktree of a checkout shares one stash list, so the pre-commit's lint-staged keeps no backup there (PG-715)
test("the pre-commit's lint-staged runs with --no-stash", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, { run: string }> }
  }
  expect(config["pre-commit"].commands["lint-staged"]!.run).toMatch(
    /\blint-staged\b.*\s--no-stash\b/,
  )
})

// lefthook on this repo's own lint-staged step (bunx swapped for this checkout's binary, the formatter this checkout's oxfmt), in a scratch repo holding one stash entry of its own: the commit's run leaves the stash list as it was, stages the formatted line and keeps a partially staged file's unstaged line
test("a commit through the pre-commit's lint-staged leaves the stash list as it was and keeps unstaged lines", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, Record<string, unknown>>; piped?: boolean }
  }
  const lint = config["pre-commit"].commands["lint-staged"]!
  const linter = String(lint.run).replace(
    "bunx lint-staged",
    join(ROOT, "node_modules/.bin/lint-staged"),
  )
  expect(linter).not.toBe(String(lint.run))
  const dir = mkdtempSync(join(tmpdir(), "lefthook-no-stash-"))
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: dir, env: SCRATCH_ENV, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const lines = [
    "const a = 1;",
    ...Array.from({ length: 12 }, (_, i) => `const k${i} = ${i};`),
    "const z = 1;",
  ]
  try {
    for (const argv of [
      ["git", "init", "-q"],
      ["git", "config", "user.email", "t@t"],
      ["git", "config", "user.name", "t"],
    ])
      expect(run(argv)).toMatchObject({ code: 0 })
    await Bun.write(
      join(dir, ".lintstagedrc.json"),
      JSON.stringify({ "*.ts": [join(ROOT, "node_modules/.bin/oxfmt")] }),
    )
    await Bun.write(
      join(dir, "lefthook.yml"),
      JSON.stringify({
        "pre-commit": {
          commands: {
            "lint-staged": {
              ...lint,
              run: linter,
            },
          },
          piped: config["pre-commit"].piped,
        },
      }),
    )
    await Bun.write(join(dir, "a.ts"), `${lines.join("\n")}\n`)
    expect(run(["git", "add", "-A"])).toMatchObject({ code: 0 })
    expect(run(["git", "commit", "-qm", "init"])).toMatchObject({ code: 0 })
    await Bun.write(join(dir, "seed.txt"), "seed\n")
    expect(run(["git", "stash", "push", "-u", "-m", "seed"])).toMatchObject({ code: 0 })
    const before = run(["git", "stash", "list"]).out
    await Bun.write(join(dir, "a.ts"), `${["const   a   =   10", ...lines.slice(1)].join("\n")}\n`)
    expect(run(["git", "add", "a.ts"])).toMatchObject({ code: 0 })
    await Bun.write(
      join(dir, "a.ts"),
      `${["const   a   =   10", ...lines.slice(1, -1), "const z = 20; // unstaged"].join("\n")}\n`,
    )
    const hook = run(["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-commit"])
    expect(hook).toMatchObject({ code: 0 })
    expect(hook.out).toContain("Skipping backup because `--no-stash` was used")
    expect(run(["git", "stash", "list"]).out).toBe(before)
    const staged = run(["git", "show", ":a.ts"]).out.trimEnd().split("\n")
    expect([staged[0], staged.at(-1)]).toEqual(["const a = 10;", "const z = 1;"])
    const working = (await Bun.file(join(dir, "a.ts")).text()).trimEnd().split("\n")
    expect(working.at(-1)).toBe("const z = 20; // unstaged")
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// lefthook on this repo's own env-keys and build steps (each run swapped for an echo, env-keys's failing or passing), in a scratch repo: a .env with gaps stops the commit at env-keys, named in one step, before the build fails on its first missing key
test("the pre-commit env-keys step runs before the build and stops it on a short .env", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, Record<string, unknown>>; piped?: boolean }
  }
  const { build, "dev-stack": devStack, "env-keys": envKeys } = config["pre-commit"].commands
  expect(envKeys).toBeDefined()
  expect(String(envKeys!.run)).toEndWith("bun packages/scripts/src/env-keys.ts POSTGRES_URL")
  // after the dev-stack guard, since its own build of @packages/env would rebuild dist under a running stack
  expect(envKeys!.priority as number).toBeGreaterThan(devStack!.priority as number)
  expect(envKeys!.exclude).toEqual(build!.exclude)
  const dir = mkdtempSync(join(tmpdir(), "lefthook-env-"))
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: dir, env: SCRATCH_ENV, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const hookWith = async (envKeysRun: string) => {
    await Bun.write(
      join(dir, "lefthook.yml"),
      JSON.stringify({
        "pre-commit": {
          commands: {
            build: { ...build, run: "echo build-ran" },
            "env-keys": { ...envKeys, run: envKeysRun },
          },
          piped: config["pre-commit"].piped,
        },
      }),
    )
    const hook = run(["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-commit"])
    return { built: hook.out.includes("build-ran"), code: hook.code, out: hook.out }
  }
  try {
    expect(run(["git", "init", "-q"])).toMatchObject({ code: 0 })
    await Bun.write(join(dir, "x.ts"), "export {}\n")
    expect(run(["git", "add", "x.ts"])).toMatchObject({ code: 0 })
    const short = await hookWith("echo env-keys-named && exit 1")
    expect(short).toMatchObject({ built: false })
    expect(short.code).not.toBe(0)
    expect(short.out).toContain("env-keys-named")
    expect(await hookWith("echo env-keys-named")).toMatchObject({ built: true, code: 0 })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// lefthook on this repo's own rule-test step, beside its build step (run swapped for an echo), in a scratch repo holding the rules and their test: a change to a rule file runs the test even when only Markdown is staged, a broken pin refuses the commit, and other Markdown skips it
test("the pre-commit rule test runs when the rules change, and a broken pin refuses the commit", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, Record<string, unknown>>; piped?: boolean }
  }
  const { build, "agents-rules": rules } = config["pre-commit"].commands
  expect(rules).toBeDefined()
  const dir = mkdtempSync(join(tmpdir(), "lefthook-rules-"))
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: dir, env: SCRATCH_ENV, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const git = (...args: string[]) =>
    run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args])
  const topics = [...new Bun.Glob(".agents/dashboard/*.md").scanSync({ cwd: ROOT, dot: true })]
  const files = [
    ".agents/shipping.md",
    ".claude/settings.json",
    "AGENTS.md",
    "tests/AGENTS.test.ts",
    ...topics,
  ]
  // stage these edits, run the hook, then put the tree back
  const hookWith = async (edits: Record<string, (text: string) => string>) => {
    for (const [file, edit] of Object.entries(edits)) {
      const path = join(dir, file)
      await Bun.write(
        path,
        edit((await Bun.file(path).exists()) ? await Bun.file(path).text() : ""),
      )
    }
    expect(git("add", ...Object.keys(edits))).toMatchObject({ code: 0 })
    const hook = run(["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-commit"])
    expect(git("reset", "-q", "--hard")).toMatchObject({ code: 0 })
    expect(git("clean", "-q", "-fd")).toMatchObject({ code: 0 })
    return {
      ...hook,
      built: hook.out.includes("build-ran"),
      skipped: hook.out.includes("agents-rules (skip)"),
    }
  }
  const unpin = (text: string) =>
    text.replace("- ALWAYS: Do every change in its", "- ALWAYS: Do each change in its")
  const addLine = (text: string) => `${text}\nOne more plain line.\n`
  // a same-length edit, so an AGENTS.md just under the limit still passes
  const sameLength = (text: string) => text.replace("AI coding agents", "AI-coding agents")
  try {
    expect(git("init", "-q")).toMatchObject({ code: 0 })
    for (const file of files) await Bun.write(join(dir, file), Bun.file(join(ROOT, file)))
    // AGENTS.md sits one character under tests/AGENTS.test.ts's limit, MARGIN of BUDGET, the most a commit may leave it at
    const rule = await Bun.file(join(ROOT, "tests/AGENTS.test.ts")).text()
    const budget = Number(/const BUDGET = ([\d_]+)/.exec(rule)![1]!.replaceAll("_", ""))
    const limit = Math.floor(budget * Number(/const MARGIN = ([\d.]+)/.exec(rule)![1]!))
    const agents = await Bun.file(join(dir, "AGENTS.md")).text()
    const room = limit - 1 - agents.length
    expect(
      room >= 0
        ? ""
        : `AGENTS.md holds ${agents.length} chars, over the limit of ${limit} from BUDGET ${budget}`,
    ).toBe("")
    await Bun.write(join(dir, "AGENTS.md"), `${agents}${"x".repeat(room)}`)
    // CLAUDE.md is a link to AGENTS.md, as in the repo, so a commit stages AGENTS.md alone
    symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"))
    // the rule test runs through bun run test:file, so the scratch repo takes that script, pointed at this repo's sandbox
    const scripts = (await Bun.file(join(ROOT, "package.json")).json()).scripts
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          "test:file": scripts["test:file"].replace(
            "packages/scripts/src/test-sandbox.ts",
            join(ROOT, "packages/scripts/src/test-sandbox.ts"),
          ),
        },
      }),
    )
    // JSON is YAML, so the steps go in as lefthook read them
    await Bun.write(
      join(dir, "lefthook.yml"),
      JSON.stringify({
        "pre-commit": {
          commands: { "agents-rules": rules, build: { ...build, run: "echo build-ran" } },
          piped: config["pre-commit"].piped,
        },
      }),
    )
    expect(git("add", ".")).toMatchObject({ code: 0 })
    expect(git("commit", "-q", "--no-verify", "-m", "base")).toMatchObject({ code: 0 })

    const fine = await hookWith({ "AGENTS.md": sameLength })
    expect(fine).toMatchObject({ built: false, code: 0, skipped: false })
    expect(fine.out).toContain("agents-rules")

    const broken = await hookWith({ "AGENTS.md": unpin })
    expect(broken.code).not.toBe(0)
    expect(broken.out).toContain("Do every change in its")

    const topic = topics.find((file) => file.endsWith("stack.md"))!
    const brokenTopic = await hookWith({
      [topic]: (text) =>
        text.replace("- ALWAYS: Start it (`bun run dev`)", "- ALWAYS: Run it (`bun run dev`)"),
    })
    expect(brokenTopic.code).not.toBe(0)
    expect(brokenTopic.out).toContain("Run it (`bun run dev`)")

    // the test itself staged alone, with a pin no rule holds, runs and refuses too
    const pinned = await hookWith({
      "tests/AGENTS.test.ts": (text) =>
        text.replace("const ALWAYS = [", 'const ALWAYS = [\n  "No rule opens with these words",'),
    })
    expect(pinned.code).not.toBe(0)
    expect(pinned.out).toContain("No rule opens with these words")

    expect(await hookWith({ "docs/playground/x.md": addLine })).toMatchObject({
      code: 0,
      skipped: true,
    })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// The trace ratchet's test counts the whole tree against counts.json, so it runs in a clone of this repo at its head, with this checkout's installs, and lefthook gets the step as lefthook.yml has it.
test("the pre-commit trace count refuses a commit that raises a count or holds a key on this machine's list, and a commit of images alone skips it", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, Record<string, unknown>>; piped?: boolean }
  }
  const step = config["pre-commit"].commands["trace-count"]
  expect(step).toBeDefined()
  const dir = mkdtempSync(join(tmpdir(), "lefthook-trace-"))
  // a made-up list in a data folder of its own, which the sandbox's scratch home lacks, so only the rows that name it read one
  const data = mkdtempSync(join(tmpdir(), "lefthook-trace-data-"))
  const run = (argv: string[], env = SCRATCH_ENV) => {
    const result = Bun.spawnSync(argv, { cwd: dir, env, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const git = (...args: string[]) =>
    run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args])
  const hookWith = async (files: Record<string, string>, env = SCRATCH_ENV) => {
    for (const [file, text] of Object.entries(files)) await Bun.write(join(dir, file), text)
    expect(git("add", ...Object.keys(files))).toMatchObject({ code: 0 })
    const hook = run(["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-commit"], env)
    expect(git("reset", "-q", "--hard")).toMatchObject({ code: 0 })
    expect(git("clean", "-q", "-fd")).toMatchObject({ code: 0 })
    return { ...hook, skipped: hook.out.includes("trace-count (skip)") }
  }
  try {
    const head = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "HEAD"]).stdout.toString().trim()
    expect(run(["git", "clone", "-q", "--shared", "--no-checkout", ROOT, "."])).toMatchObject({
      code: 0,
    })
    expect(git("checkout", "-q", head)).toMatchObject({ code: 0 })
    // the install is isolated, so each workspace keeps its own node_modules beside the root's
    const installs = new Bun.Glob("{api,packages,web}/*/node_modules").scanSync({
      cwd: ROOT,
      onlyFiles: false,
    })
    for (const install of ["node_modules", ...installs])
      symlinkSync(join(ROOT, install), join(dir, install))
    // .gitignore's node_modules/ matches a folder alone, so each link is kept out of git clean by name
    await Bun.write(join(dir, ".git/info/exclude"), "node_modules\n")
    // JSON is YAML, so the step goes in as lefthook read it
    await Bun.write(
      join(dir, "lefthook.yml"),
      JSON.stringify({
        "pre-commit": { commands: { "trace-count": step }, piped: config["pre-commit"].piped },
      }),
    )
    expect(git("commit", "-q", "--no-verify", "-am", "the step alone")).toMatchObject({ code: 0 })

    const fine = await hookWith({ "docs/trace-scratch.md": "A line in plain words.\n" })
    expect(fine).toMatchObject({ code: 0, skipped: false })

    const raised = await hookWith({ "docs/trace-scratch.md": "Fixed in #4242.\n" })
    expect(raised.code).not.toBe(0)
    expect(raised.out).toContain("issueRefs")

    expect(await hookWith({ "docs/trace-scratch.png": "not text" })).toMatchObject({
      code: 0,
      skipped: true,
    })

    // the list step reads the data folder's list: a staged file holding a listed key fails, and another made-up key passes
    const listed = { ...SCRATCH_ENV, PLAYGROUND_DATA_DIR: data }
    mkdirSync(join(data, "extensions", "hooks"), { recursive: true })
    await Bun.write(
      join(data, "extensions", "hooks", "no-public-leak.json"),
      JSON.stringify({ companies: [], handles: [], linearKeys: ["QZX"], names: [], slackIds: [] }),
    )
    const held = await hookWith(
      { "docs/trace-scratch.md": `Filed as ${["QZX", "12"].join("-")}.\n` },
      listed,
    )
    expect(held.code).not.toBe(0)
    expect(held.out).toContain("linearKeys: 1 in the tree")
    expect(
      await hookWith(
        { "docs/trace-scratch.md": `Filed as ${["MADE", "12"].join("-")}.\n` },
        listed,
      ),
    ).toMatchObject({ code: 0, skipped: false })
  } finally {
    rmSync(dir, { force: true, recursive: true })
    rmSync(data, { force: true, recursive: true })
  }
}, 120_000)

// lefthook on this repo's own commit-msg steps, commitlint and its config included, in a scratch repo: a ticket scope in either case passes, a Co-authored-by trailer in any case is dropped from the message with one line saying so, and a body that only mentions it passes as written
test("commit-msg takes a ticket scope in either case and drops a Co-authored-by trailer in any case", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "commit-msg": unknown
  }
  const dir = mkdtempSync(join(tmpdir(), "lefthook-msg-"))
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: dir, env: SCRATCH_ENV, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  // each message in a file of its own, so the runs can go at once
  const hookWith = async (message: string) => {
    const msg = join(dir, `MSG-${crypto.randomUUID()}`)
    await Bun.write(msg, message)
    const proc = Bun.spawn(["bun", join(ROOT, LEFTHOOK_BIN), "run", "commit-msg", msg], {
      cwd: dir,
      env: SCRATCH_ENV,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, message: await Bun.file(msg).text(), out: out + err }
  }
  try {
    expect(run(["git", "init", "-q"])).toMatchObject({ code: 0 })
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"))
    // the pg-scope step runs packages/scripts/src/commit-scope.ts by its path in the checkout
    symlinkSync(join(ROOT, "packages"), join(dir, "packages"))
    const { commitlint } = await Bun.file(join(ROOT, "package.json")).json()
    await Bun.write(join(dir, "package.json"), JSON.stringify({ commitlint }))
    // JSON is YAML, so the steps go in as lefthook read them
    await Bun.write(
      join(dir, "lefthook.yml"),
      JSON.stringify({ "commit-msg": config["commit-msg"] }),
    )
    // commitlint runs here too, so a pass below is the whole hook's; the first run alone, since lefthook syncs its hooks on its first run in a repo
    expect((await hookWith("Fix: A change\n")).code).not.toBe(0)
    // the rest at once: each starts commitlint, whose start grows with the machine's load, and seven in a row took 60s on a loaded runner
    const trailers = ["Co-authored-by", "Co-Authored-By", "co-authored-by"]
    const mention = "fix: a change\n\nThe hook drops a Co-authored-by trailer.\n"
    // a trailer past commitlint's 100-character footer line, which commitlint would refuse were it read before the drop
    const long = `Co-Authored-By: ${"A".repeat(90)} <a@b.c>`
    const [upper, lower, kept, ...dropped] = await Promise.all(
      [
        "feat(PG-1): x\n",
        "feat(pg-1): x\n",
        mention,
        ...[...trailers.map((trailer) => `${trailer}: A <a@b.c>`), long].map(
          (trailer) => `fix: a change\n\nWhy it changed.\n\n${trailer}\n`,
        ),
      ].map(hookWith),
    )
    expect([upper, lower, kept]).toMatchObject([{ code: 0 }, { code: 0 }, { code: 0 }])
    expect(kept!.message).toBe(mention)
    expect(kept!.out).not.toContain("dropped")
    for (const result of dropped) {
      expect(result.code).toBe(0)
      expect(result.message).toBe("fix: a change\n\nWhy it changed.\n\n")
      expect(result.out.match(/commit-trailer: dropped the Co-authored-by trailer/g)).toHaveLength(
        1,
      )
    }
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// docs:wrap's pre-commit step reads the docs as committed, so it runs after lint-staged's formatter and on every file the tool holds to one sentence per line
test("the pre-commit docs-wrap step covers every docs:wrap file and runs after lint-staged", async () => {
  const { PATTERNS } = await import("../packages/scripts/src/docs-wrap/cli")
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, Record<string, unknown>> }
  }
  const { "docs-wrap": wrap, "lint-staged": lint } = config["pre-commit"].commands
  expect(wrap).toBeDefined()
  expect(wrap!.glob as string[]).toEqual(expect.arrayContaining(PATTERNS))
  expect(wrap!.priority as number).toBeGreaterThan(lint!.priority as number)
})

// the pre-commit build, next build included, goes through commit-slot.ts, which takes the commit slot in a worktree when turbo finds a build task with work to do; env-keys' build of @packages/env stays bare, since it ran 8s after a 829s queue wait (measured); both share one turbo cache outside every checkout
test("the pre-commit build goes through commit-slot, which slots a build with work to do, env-keys' small build does not, and both share the turbo cache", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, Record<string, unknown>> }
  }
  const { build, "env-keys": envKeys } = config["pre-commit"].commands
  const CACHE = 'TURBO_CACHE_DIR="${TURBO_CACHE_DIR:-$HOME/.cache/turbo/playground}" '
  const SLOT = "bun --no-env-file packages/scripts/src/commit-slot.ts "
  expect(String(build!.run)).toBe(`${CACHE}${SLOT}bun run build`)
  expect(String(envKeys!.run)).toStartWith(`${CACHE}bunx turbo run build `)
})

// lefthook on this repo's own main-checkout step, in scratch repos under a scratch HOME: a commit in the factory's main checkout (where link-skills.sh's run-slot.sh link points) is refused whatever command made it, while one in its worktree, a plain clone of a person's own or a clone beside it goes through
test("the pre-commit main-checkout step refuses a commit in the factory's main checkout alone", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, Record<string, unknown>> }
  }
  const {
    "conflict-markers": markers,
    "main-checkout": main,
    "skills-manager": skills,
  } = config["pre-commit"].commands
  expect(main).toBeDefined()
  // alone first, since lefthook runs a tie in any order and skills-manager writes skills/zerostarter/README.md
  expect(main!.priority as number).toBeLessThan(markers!.priority as number)
  expect(main!.priority as number).toBeLessThan(skills!.priority as number)
  expect(skills!.run).toBe(
    "bun packages/scripts/src/skills-manager.ts && git add skills/zerostarter/README.md",
  )
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lefthook-main-")))
  const [factory, home, clone] = ["playground", "home", "clone"].map((name) => join(dir, name)) as [
    string,
    string,
    string,
  ]
  const worktree = join(factory, ".claude/worktrees/w")
  const run = (cwd: string, argv: string[], linked = true) => {
    const env = { ...SCRATCH_ENV, HOME: linked ? home : join(dir, "nohome") }
    const result = Bun.spawnSync(argv, { cwd, env, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const git = (cwd: string, ...args: string[]) =>
    run(cwd, ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args])
  // a staged file, since lefthook skips a command when nothing is staged
  const hook = async (cwd: string, linked = true) => {
    await Bun.write(join(cwd, "x.txt"), "x")
    expect(git(cwd, "add", "x.txt")).toMatchObject({ code: 0 })
    return run(cwd, ["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-commit"], linked)
  }
  const repo = async (path: string) => {
    mkdirSync(join(path, "scripts/ops"), { recursive: true })
    expect(git(path, "init", "-q", "-b", "main")).toMatchObject({ code: 0 })
    await Bun.write(join(path, "scripts/ops/run-slot.sh"), "")
    await Bun.write(
      join(path, "lefthook.yml"),
      JSON.stringify({ "pre-commit": { commands: { "main-checkout": main } } }),
    )
    expect(git(path, "add", ".")).toMatchObject({ code: 0 })
    expect(git(path, "commit", "-q", "--no-verify", "-m", "config")).toMatchObject({ code: 0 })
  }
  try {
    await repo(factory)
    await repo(clone)
    expect(git(factory, "worktree", "add", "-q", "-b", "w", worktree)).toMatchObject({ code: 0 })
    // link-skills.sh's link, which names the factory's main checkout
    mkdirSync(join(home, ".playground/ops"), { recursive: true })
    symlinkSync(join(factory, "scripts/ops/run-slot.sh"), join(home, ".playground/ops/run-slot.sh"))

    const refused = await hook(factory)
    expect(refused.code).not.toBe(0)
    expect(refused.out).toContain("the factory's main checkout")
    mkdirSync(join(factory, "sub"))
    expect((await hook(join(factory, "sub"))).code).not.toBe(0)

    expect(await hook(worktree)).toMatchObject({ code: 0 })
    expect(await hook(clone)).toMatchObject({ code: 0 })
    expect(await hook(factory, false)).toMatchObject({ code: 0 })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// the install's prepare as package.json gives it, run in a scratch repo, a script it names read from this checkout
const preparer = async () => {
  const { scripts } = (await Bun.file(join(ROOT, "package.json")).json()) as {
    scripts: { prepare: string }
  }
  const command = scripts.prepare.replaceAll(
    "packages/scripts/",
    `${join(ROOT, "packages/scripts")}/`,
  )
  return (dir: string) => {
    const result = Bun.spawnSync(["sh", "-c", command], {
      cwd: dir,
      env: SCRATCH_ENV,
      stdin: "ignore",
    })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
}

// a scratch repo with this checkout's lefthook and a config of one pre-commit command
const scratchRepo = async (dir: string) => {
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: SCRATCH_ENV }).exitCode).toBe(0)
  mkdirSync(join(dir, "node_modules/.bin"), { recursive: true })
  symlinkSync(join(ROOT, LEFTHOOK_BIN), join(dir, LEFTHOOK_BIN))
  const config = `lefthook: ${OWN_LEFTHOOK}\npre-commit:\n  commands:\n    mark:\n      run: echo hook-ran\n`
  await Bun.write(join(dir, "lefthook.yml"), config)
  return config
}

// the install's prepare script in a scratch repo whose hooks folder it may not write, as Claude Code's sandbox refuses .git/hooks: hooks that match pass with no write, and a config that names a new hook still fails loudly
test("the install's prepare writes no hook while the installed ones match", async () => {
  const prepare = await preparer()
  const dir = mkdtempSync(join(tmpdir(), "lefthook-prepare-"))
  const hooks = join(dir, ".git/hooks")
  try {
    const config = await scratchRepo(dir)
    expect(prepare(dir)).toMatchObject({ code: 0 })
    chmodSync(hooks, 0o555)
    expect(prepare(dir)).toMatchObject({ code: 0 })
    await Bun.write(
      join(dir, "lefthook.yml"),
      `${config}pre-push:\n  commands:\n    mark:\n      run: echo push-ran\n`,
    )
    // lefthook reads its hooks as matching while the config's mtime, in seconds, equals the one it installed from, so a rewrite in that same second is moved on
    const later = Date.now() / 1000 + 10
    utimesSync(join(dir, "lefthook.yml"), later, later)
    expect(prepare(dir).code).not.toBe(0)
  } finally {
    if (existsSync(hooks)) chmodSync(hooks, 0o755)
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// lefthook's check-install reads its config's checksum alone, never the hooks, so a hook gone or replaced while the config still matches is the prepare's own check to catch
test("the install's prepare puts back a hook that was deleted or replaced while the config still matches", async () => {
  const prepare = await preparer()
  const dir = mkdtempSync(join(tmpdir(), "lefthook-prepare-"))
  const hook = join(dir, ".git/hooks/pre-commit")
  try {
    await scratchRepo(dir)
    expect(prepare(dir)).toMatchObject({ code: 0 })
    const installed = await Bun.file(hook).text()
    unlinkSync(hook)
    expect(prepare(dir)).toMatchObject({ code: 0 })
    expect(existsSync(hook) ? await Bun.file(hook).text() : "deleted").toBe(installed)
    await Bun.write(hook, "#!/bin/sh\necho foreign\n")
    expect(prepare(dir)).toMatchObject({ code: 0 })
    expect(await Bun.file(hook).text()).toBe(installed)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// Two fast tests turned four branches red in CI on 5 Nov while pre-commit never ran them: each now runs when a file it reads is staged, checked here on lefthook itself with each run swapped for an echo
test("pre-commit runs the native-title and dashboard-map tests when a file they read is staged, and skips them otherwise", async () => {
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, { glob?: string[]; run?: string }>; piped?: boolean }
  }
  const { "dashboard-map": map, "native-title": title } = config["pre-commit"].commands
  expect(title?.run).toBe("bun run test:file tests/web/next/src/native-title.test.ts")
  expect(map?.run).toBe("bun run test:file tests/packages/scripts/src/verify/dashboard-map.test.ts")
  const dir = mkdtempSync(join(tmpdir(), "lefthook-fast-tests-"))
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: dir, env: SCRATCH_ENV, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const git = (...args: string[]) =>
    run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args])
  // stage one file, run the hook, then put the tree back
  const ran = async (file: string) => {
    await Bun.write(join(dir, file), "staged\n")
    expect(git("add", file)).toMatchObject({ code: 0 })
    const hook = run(["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-commit"])
    expect(git("reset", "-q", "--hard")).toMatchObject({ code: 0 })
    expect(git("clean", "-q", "-fd")).toMatchObject({ code: 0 })
    expect(hook.code).toBe(0)
    return { map: hook.out.includes("map-ran"), title: hook.out.includes("title-ran") }
  }
  try {
    expect(git("init", "-q")).toMatchObject({ code: 0 })
    // JSON is YAML, so the steps go in as lefthook read them
    await Bun.write(
      join(dir, "lefthook.yml"),
      JSON.stringify({
        "pre-commit": {
          commands: {
            "dashboard-map": { ...map, run: "echo map-ran" },
            "native-title": { ...title, run: "echo title-ran" },
          },
          piped: config["pre-commit"].piped,
        },
      }),
    )
    expect(git("add", ".")).toMatchObject({ code: 0 })
    expect(git("commit", "-q", "--no-verify", "-m", "base")).toMatchObject({ code: 0 })

    expect(await ran("web/next/src/components/hint.tsx")).toEqual({ map: true, title: true })
    expect(await ran("web/next/src/app/(protected)/dashboard/page.tsx")).toEqual({
      map: true,
      title: true,
    })
    expect(await ran("api/hono/src/routers/inbox.ts")).toEqual({ map: true, title: false })
    expect(await ran("api/hono/src/plugins/changelog/router.ts")).toEqual({
      map: true,
      title: false,
    })
    expect(await ran("packages/scripts/src/verify/dashboard-map.json")).toEqual({
      map: true,
      title: false,
    })
    expect(await ran("tests/web/next/src/native-title.test.ts")).toEqual({
      map: false,
      title: true,
    })
    expect(await ran("tests/packages/scripts/src/verify/dashboard-map.test.ts")).toEqual({
      map: true,
      title: false,
    })
    expect(await ran("docs/playground/x.md")).toEqual({ map: false, title: false })
    expect(await ran("packages/scripts/src/pr-merge/held.ts")).toEqual({ map: false, title: false })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// Two text tests went red only in CI after a push on 14 Nov: no-raw-delete reads every tracked file, as text-tests' tests do, and workflow-runners reads the workflows; checked on lefthook itself with each run swapped for an echo
test("pre-commit runs the no-raw-delete test on any text commit and the workflow-runners test on a workflow commit", async () => {
  type Job = { exclude?: string[]; glob?: string[]; run?: string }
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-commit": { commands: Record<string, Job>; piped?: boolean }
  }
  const {
    "no-raw-delete": del,
    "text-tests": text,
    "workflow-runners": workflows,
  } = config["pre-commit"].commands
  expect(del?.run).toBe("bun run test:file tests/no-raw-delete.test.ts")
  expect(del?.glob).toBeUndefined()
  expect(del?.exclude).toEqual(text!.exclude)
  expect(workflows?.run).toBe(
    "bun run test:file tests/packages/scripts/src/workflow-runners.test.ts",
  )
  expect(workflows?.glob).toEqual([
    ".github/workflows/*",
    "packages/scripts/src/workflow-runners.ts",
    "tests/packages/scripts/src/workflow-runners.test.ts",
  ])
  const dir = mkdtempSync(join(tmpdir(), "lefthook-delete-runners-"))
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: dir, env: SCRATCH_ENV, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const git = (...args: string[]) =>
    run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args])
  // stage one file, run the hook, then put the tree back
  const ran = async (file: string) => {
    await Bun.write(join(dir, file), "staged\n")
    expect(git("add", file)).toMatchObject({ code: 0 })
    const hook = run(["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-commit"])
    expect(git("reset", "-q", "--hard")).toMatchObject({ code: 0 })
    expect(git("clean", "-q", "-fd")).toMatchObject({ code: 0 })
    expect(hook.code).toBe(0)
    return { del: hook.out.includes("delete-ran"), workflows: hook.out.includes("workflows-ran") }
  }
  try {
    expect(git("init", "-q")).toMatchObject({ code: 0 })
    // JSON is YAML, so the steps go in as lefthook read them
    await Bun.write(
      join(dir, "lefthook.yml"),
      JSON.stringify({
        "pre-commit": {
          commands: {
            "no-raw-delete": { ...del, run: "echo delete-ran" },
            "workflow-runners": { ...workflows, run: "echo workflows-ran" },
          },
          piped: config["pre-commit"].piped,
        },
      }),
    )
    expect(git("add", ".")).toMatchObject({ code: 0 })
    expect(git("commit", "-q", "--no-verify", "-m", "base")).toMatchObject({ code: 0 })

    expect(await ran(".github/workflows/auto-test.yml")).toEqual({ del: true, workflows: true })
    expect(await ran("packages/scripts/src/workflow-runners.ts")).toEqual({
      del: true,
      workflows: true,
    })
    expect(await ran("tests/packages/scripts/src/workflow-runners.test.ts")).toEqual({
      del: true,
      workflows: true,
    })
    expect(await ran("scripts/ops/clean.sh")).toEqual({ del: true, workflows: false })
    expect(await ran("docs/playground/x.md")).toEqual({ del: true, workflows: false })
    expect(await ran("web/next/public/logo.png")).toEqual({ del: false, workflows: false })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 60_000)

// The hooks-bundle job of a lefthook stage, as lefthook.yml holds it.
const hooksBundleJob = async (stage: "pre-commit" | "pre-push" = "pre-commit") =>
  (
    Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as Record<
      string,
      { commands: Record<string, Record<string, unknown> | undefined> }
    >
  )[stage]!.commands["hooks-bundle"]

test("a pre-commit job runs hooks-bundle --check, which reads the index, after lint-staged, skipped in a merge", async () => {
  expect(await hooksBundleJob()).toMatchObject({
    priority: 4,
    run: "bun --no-env-file packages/scripts/src/hooks-bundle.ts --check",
    skip: ["merge"],
  })
})

// a canary change to a bundle input can stale a head whose own bundles are fresh, as CI's merge ref builds them (#1365)
test("a pre-push job checks the bundles of the head merged with origin/canary, over the files the branch changed since canary, on the pre-commit job's glob, merges included", async () => {
  const push = await hooksBundleJob("pre-push")
  expect(push).toMatchObject({
    files: "git diff --name-only origin/canary...HEAD",
    glob: (await hooksBundleJob())?.glob,
    run: expect.stringMatching(
      /bun --no-env-file packages\/scripts\/src\/hooks-bundle\.ts --check --merged origin\/canary # \{files\}$/,
    ),
  })
  expect(push?.glob).toContain("bun.lock")
  expect(push).not.toHaveProperty("skip")
})

// CI's test check runs test:skills, which went red on 16 Nov after a branch changed the sandbox its steps run in while no local run caught it; checked on lefthook itself with the run swapped for an echo, over every file a step names, read from test-skills.ts, so a new step's file fails here until the glob holds it
test("pre-push runs test:skills through the commit slot when the branch changed a file its steps read since origin/canary, and skips it otherwise", async () => {
  const { steps } = await import("../packages/scripts/src/test-skills")
  const config = Bun.YAML.parse(await Bun.file(join(ROOT, "lefthook.yml")).text()) as {
    "pre-push": { commands: Record<string, Record<string, unknown>> }
  }
  const job = config["pre-push"].commands["test-skills"]
  expect(job).toMatchObject({
    files: "git diff --name-only origin/canary...HEAD",
    run: "bun --no-env-file packages/scripts/src/commit-slot.ts bun run test:skills # {files}",
  })
  const named = steps.flatMap(([, argv]) =>
    argv.filter((arg) => /^(extensions|packages|scripts|tests)\/.+\.(py|sh|ts)$/.test(arg)),
  )
  expect(named).toContain("tests/test_ops_jobs.py")
  const dir = mkdtempSync(join(tmpdir(), "lefthook-test-skills-"))
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: dir, env: SCRATCH_ENV, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const git = (...args: string[]) =>
    run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args])
  // commit one file on the branch, run the hook, then put the branch back at canary
  const ran = async (file: string) => {
    await Bun.write(join(dir, file), "changed\n")
    expect(git("add", file)).toMatchObject({ code: 0 })
    expect(git("commit", "-q", "--no-verify", "-m", file)).toMatchObject({ code: 0 })
    const hook = run(["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-push"])
    expect(git("reset", "-q", "--hard", "origin/canary")).toMatchObject({ code: 0 })
    expect(git("clean", "-q", "-fd")).toMatchObject({ code: 0 })
    expect(hook.code).toBe(0)
    return hook.out.includes("skills-ran")
  }
  try {
    expect(git("init", "-q", "-b", "work")).toMatchObject({ code: 0 })
    // JSON is YAML, so the job goes in as lefthook read it
    await Bun.write(
      join(dir, "lefthook.yml"),
      JSON.stringify({
        "pre-push": { commands: { "test-skills": { ...job, run: "echo skills-ran # {files}" } } },
      }),
    )
    expect(git("add", ".")).toMatchObject({ code: 0 })
    expect(git("commit", "-q", "--no-verify", "-m", "base")).toMatchObject({ code: 0 })
    expect(git("update-ref", "refs/remotes/origin/canary", "HEAD")).toMatchObject({ code: 0 })

    for (const file of [
      ...named,
      "extensions/core/skills/playbook/SKILL.md",
      // what a step's entry file loads first: the sandbox's scratch folders, test-sandbox's helpers, state.test.ts's gates and the ops jobs test's renderers
      "packages/config/src/kinds.ts",
      "packages/env/src/data-dir.ts",
      "packages/safe-delete/src/index.ts",
      "packages/scripts/src/clock-exempt.ts",
      "packages/scripts/src/pr-merge/gates.ts",
      "packages/scripts/src/sandbox.ts",
      "packages/scripts/src/test-sandbox.ts",
      "packages/scripts/src/test-skills.ts",
      "packages/scripts/src/verify/prebuild.ts",
      "packages/settings/src/folder.ts",
      "packages/settings/src/rendered.ts",
      "tests/scripts/hooks/render-set.ts",
      "tests/session-names.ts",
      "scripts/factory-settings.json",
      "scripts/hooks/bundled/guards.js",
      "scripts/hooks/no-raw-delete.ts",
      "scripts/ops/run-slot.sh",
      "scripts/spawn.sh",
      "skills/zerostarter/dev/SKILL.md",
    ])
      expect({ file, ran: await ran(file) }).toEqual({ file, ran: true })
    for (const file of [
      "api/hono/src/index.ts",
      "docs/playground/playbook.md",
      "extensions/core/skills/playbook/SESSIONS.md",
      "packages/scripts/src/pr-merge/held.ts",
      "scripts/README.md",
      "scripts/briefs/brief-rush.md",
    ])
      expect({ file, ran: await ran(file) }).toEqual({ file, ran: false })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}, 120_000)

// Each committed bundle names every module it holds in a `// <path>` comment, so the folders the job must watch are read from the bundles themselves: a guard that starts importing another folder fails here until the glob holds it.
test("the hooks-bundle job's glob holds every folder a committed bundle imports", async () => {
  const glob = ((await hooksBundleJob())?.glob ?? []) as string[]
  const bundled = join(ROOT, "scripts", "hooks", "bundled")
  const inputs = new Set<string>()
  for (const name of readdirSync(bundled).filter((n) => n.endsWith(".js")))
    for (const [, path] of (await Bun.file(join(bundled, name)).text()).matchAll(
      /^\/\/ (\S+\.[cm]?[jt]sx?)$/gm,
    )) {
      const pkg = /^(packages\/[^/]+\/src)\//.exec(path!)
      if (path!.startsWith("node_modules/")) inputs.add("bun.lock")
      else if (pkg) inputs.add(`${pkg[1]}/*`)
      else if (/^scripts\/hooks\/[^/]+\.ts$/.test(path!)) inputs.add("scripts/hooks/*.ts")
      else inputs.add(path!)
    }
  expect(inputs).toContain("scripts/hooks/*.ts")
  // an edit to a bundle alone, which no source comment names, runs the job too
  expect(glob).toContain("scripts/hooks/bundled/*")
  expect([...inputs].filter((input) => !glob.includes(input)).sort()).toEqual([])
})

// A scratch repo for lefthook's hooks-bundle job at a stage, as lefthook.yml holds it: this checkout's hooks-bundle.ts and what it imports, one guard, role.ts, importing lib.ts beside it, its bundle committed; a mkdtemp root the test removes
const scratch = async (stage: "pre-commit" | "pre-push") => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `lefthook-${stage}-`)))
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { cwd: dir, env: SCRATCH_ENV, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
  }
  const git = (...args: string[]) =>
    expect(run(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args])).toMatchObject({
      code: 0,
    })
  for (const file of ["hooks-bundle.ts", "ops-tick/guard-probe.ts", "write-atomic.ts"]) {
    const to = join(dir, "packages", "scripts", "src", file)
    mkdirSync(join(to, ".."), { recursive: true })
    copyFileSync(join(ROOT, "packages", "scripts", "src", file), to)
  }
  const hooks = join(dir, "scripts", "hooks")
  mkdirSync(hooks, { recursive: true })
  writeFileSync(
    join(dir, "scripts", "factory-settings.json"),
    `${JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "bun scripts/hooks/bundled/role.js" }] }] } })}\n`,
  )
  writeFileSync(join(hooks, "role.ts"), 'import { lib } from "./lib"\n\nconsole.log("a", lib)\n')
  writeFileSync(join(hooks, "lib.ts"), 'export const lib = "one"\n')
  writeFileSync(join(hooks, "no-extensions-write-worker.ts"), "export {}\n")
  // JSON is YAML, so the job goes in as lefthook read it
  writeFileSync(
    join(dir, "lefthook.yml"),
    JSON.stringify({ [stage]: { commands: { "hooks-bundle": await hooksBundleJob(stage) } } }),
  )
  const bundle = () =>
    expect(
      run(["bun", "--no-env-file", join(dir, "packages", "scripts", "src", "hooks-bundle.ts")]),
    ).toMatchObject({ code: 0 })
  const commit = (message: string) => {
    git("add", "-A")
    git("commit", "-q", "--no-verify", "-m", message)
  }
  bundle()
  git("init", "-q", "-b", "main")
  commit("start")
  const hook = () => run(["bun", join(ROOT, LEFTHOOK_BIN), "run", stage])
  const edit = () =>
    writeFileSync(join(hooks, "role.ts"), 'import { lib } from "./lib"\n\nconsole.log("b", lib)\n')
  return { bundle, commit, dir, edit, git, hook, hooks, run }
}

describe("the pre-commit hooks-bundle job", () => {
  test("refuses a commit of a guard whose bundle is stale or left unstaged, naming the fix, and skips one that touches no input", async () => {
    const { bundle, dir, edit, git, hook } = await scratch("pre-commit")
    try {
      edit()
      writeFileSync(join(dir, "README.md"), "docs\n")
      git("add", "README.md")
      expect(hook().code).toBe(0)
      git("add", "scripts/hooks/role.ts")
      const stale = hook()
      expect(stale.code).not.toBe(0)
      expect(stale.out).toContain("hooks-bundle: stale in scripts/hooks/bundled: role.js")
      expect(stale.out).toContain("run `bun run hooks:bundle` and commit scripts/hooks/bundled")
      bundle()
      // the rebuilt bundle left unstaged: the commit would carry the old one, which --check, reading the index, names
      const unstaged = hook()
      expect(unstaged.code).not.toBe(0)
      expect(unstaged.out).toContain("hooks-bundle: stale in scripts/hooks/bundled: role.js")
      git("add", "-A")
      expect(hook()).toMatchObject({ code: 0 })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  }, 60_000)

  test("leaves a commit that stages no input alone while a bundle change sits unstaged, and refuses one that stages a guard", async () => {
    const { dir, git, hook } = await scratch("pre-commit")
    try {
      writeFileSync(join(dir, "scripts", "hooks", "bundled", "role.js"), "edited\n")
      writeFileSync(join(dir, "README.md"), "docs\n")
      git("add", "README.md")
      expect(hook()).toMatchObject({ code: 0 })
      writeFileSync(join(dir, "scripts", "hooks", "role.ts"), 'console.log("b")\n')
      git("add", "scripts/hooks/role.ts")
      const refused = hook()
      expect(refused.code).not.toBe(0)
      expect(refused.out).toContain("hooks-bundle: stale in scripts/hooks/bundled: role.js")
      // an untracked file there is no part of the commit, so a commit staging a glob input whose bundles stay fresh, a module no guard imports, runs the job and passes beside it
      git("reset", "-q")
      git("checkout", "--", "scripts/hooks")
      writeFileSync(join(dir, "scripts", "hooks", "bundled", "extra.js"), "new\n")
      writeFileSync(join(dir, "scripts", "hooks", "notes.ts"), "export const notes = 1\n")
      git("add", "scripts/hooks/notes.ts")
      const fresh = hook()
      expect(fresh).toMatchObject({ code: 0 })
      expect(fresh.out).toContain("hooks-bundle")
      expect(fresh.out).not.toContain("hooks-bundle (skip)")
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  }, 60_000)

  test("runs the job on a commit staging a glob input beside an unstaged guard edit, and passes it, since the index holds no edit", async () => {
    const { dir, edit, git, hook, hooks } = await scratch("pre-commit")
    try {
      edit()
      writeFileSync(join(hooks, "notes.ts"), "export const notes = 1\n")
      git("add", "scripts/hooks/notes.ts")
      const ran = hook()
      expect(ran).toMatchObject({ code: 0 })
      expect(ran.out).toContain("hooks-bundle")
      expect(ran.out).not.toContain("hooks-bundle (skip)")
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  }, 60_000)

  test("passes a merge commit with a stale bundle, which hooks-merge-canary rebuilds in a commit of its own", async () => {
    const { dir, edit, git, hook } = await scratch("pre-commit")
    try {
      git("checkout", "-q", "-b", "side")
      writeFileSync(join(dir, "side.txt"), "side\n")
      git("add", "side.txt")
      git("commit", "-q", "--no-verify", "-m", "side")
      git("checkout", "-q", "main")
      git("merge", "-q", "--no-commit", "--no-ff", "side")
      edit()
      git("add", "scripts/hooks/role.ts")
      expect(hook().code).toBe(0)
      // the same stale bundle, once the merge is committed, is refused on the next commit
      git("commit", "-q", "--no-verify", "--no-edit")
      writeFileSync(join(dir, "scripts", "hooks", "role.ts"), 'console.log("c")\n')
      git("add", "scripts/hooks/role.ts")
      expect(hook().code).not.toBe(0)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  }, 60_000)
})

// the pre-push job, in a scratch repo pushed to a bare scratch remote that holds canary, both roots mkdtemp folders
describe("the pre-push hooks-bundle job", () => {
  test("runs on a docs-only push of a branch that changed a guard once canary moves that guard's input, and names the stale bundle (#1365)", async () => {
    const { bundle, commit, dir, git, hooks, run } = await scratch("pre-push")
    const remote = realpathSync(mkdtempSync(join(tmpdir(), "lefthook-push-remote-")))
    try {
      expect(run(["git", "init", "-q", "--bare", remote]).code).toBe(0)
      git("remote", "add", "origin", remote)
      git("push", "-q", "--no-verify", "origin", "main:canary")
      // the branch's first push changed the guard, its bundle rebuilt
      git("checkout", "-q", "-b", "work")
      writeFileSync(
        join(hooks, "role.ts"),
        'import { lib } from "./lib"\n\nconst helper = 3\nconsole.log("b", lib, helper)\n',
      )
      bundle()
      commit("the guard")
      git("push", "-q", "--no-verify", "-u", "origin", "work")
      // canary then names a helper in the guard's input as the guard names its own, so the merge is clean but Bun renames one in the merged bundle
      git("checkout", "-q", "main")
      writeFileSync(
        join(hooks, "lib.ts"),
        'const helper = (x: string) => x + "!"\nexport const lib = helper("two")\n',
      )
      bundle()
      commit("canary")
      git("push", "-q", "--no-verify", "origin", "main:canary")
      git("fetch", "-q", "origin")
      // the next push holds docs alone
      git("checkout", "-q", "work")
      writeFileSync(join(dir, "README.md"), "docs\n")
      commit("docs")
      const push = run(["bun", join(ROOT, LEFTHOOK_BIN), "run", "pre-push"])
      expect(push.out).not.toContain("hooks-bundle (skip)")
      expect(push.out).toContain("role.js once merged with origin/canary")
      expect(push.code).not.toBe(0)
    } finally {
      rmSync(dir, { force: true, recursive: true })
      rmSync(remote, { force: true, recursive: true })
    }
  }, 60_000)
})
