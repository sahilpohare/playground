import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dir, "../../../../packages/scripts/src/test-sandbox.ts")
const DIR = mkdtempSync(join(tmpdir(), "test-sandbox-test-"))
// 2711: the suite runner has no uv on PATH, so each Python row sets PATH to this stub first, which runs the file with python3
const uvBin = join(DIR, "uv-bin")
mkdirSync(uvBin)
writeFileSync(join(uvBin, "uv"), '#!/bin/sh\nfor a; do f=$a; done; exec python3 "$f"\n')
chmodSync(join(uvBin, "uv"), 0o755)

// removing DIR also ends the looping child's loop, even when bun drops a timed-out test's body before its finally
afterAll(() => rmSync(DIR, { force: true, recursive: true }))

test("CLOCK_AHEAD_DAYS moves a running clock that many days ahead, and leaves out a named exempt file", async () => {
  const dir = join(DIR, "clock")
  mkdirSync(join(dir, "tests/scripts"), { recursive: true })
  // the OS stamps a new file's mtime on the real clock, which the preload never moves
  writeFileSync(
    join(dir, "ahead.test.ts"),
    `import { expect, test } from "bun:test"\nimport { statSync, writeFileSync } from "node:fs"\ntest("ahead", async () => { writeFileSync("stamp", ""); const days = (Date.now() - statSync("stamp").mtimeMs) / 86_400_000; expect(statSync("stamp").mtime instanceof Date).toBe(true); expect(structuredClone(new Date()) instanceof Date).toBe(true); expect(days).toBeGreaterThan(29.9); expect(days).toBeLessThan(30.1); const a = Date.now(); await Bun.sleep(50); expect(Date.now() - a).toBeGreaterThanOrEqual(40) })\n`,
  )
  writeFileSync(
    join(dir, "tests/scripts/roster.test.ts"),
    'import { expect, test } from "bun:test"\ntest("exempt", () => expect(1).toBe(2))\n',
  )
  const files = ["./ahead.test.ts", "tests/scripts/roster.test.ts"]
  const { CLOCK_AHEAD_DAYS: _, ...real } = process.env
  const runs = await Promise.all(
    [{ ...real, CLOCK_AHEAD_DAYS: "30" }, real].map(async (env) => {
      const run = Bun.spawn(["bun", SCRIPT, ...files], {
        cwd: dir,
        env,
        stderr: "pipe",
        stdout: "ignore",
      })
      return { code: await run.exited, stderr: await new Response(run.stderr).text() }
    }),
  )
  expect(runs[0]!.code).toBe(0)
  expect(runs[0]!.stderr).toMatch(/\b1 pass\b/)
  expect(runs[0]!.stderr).toContain("the clock-ahead pass leaves out tests/scripts/roster.test.ts")
  expect(runs[0]!.stderr).not.toContain("exempt")
  expect(runs[1]!.code).not.toBe(0)
  expect(runs[1]!.stderr).toContain("(fail) ahead")
  expect(runs[1]!.stderr).toContain("(fail) exempt")
}, 60_000)

test("a parallel pass past its deadline fails, naming the file still running", async () => {
  writeFileSync(
    join(DIR, "quick.test.ts"),
    'import { test } from "bun:test"\ntest("quick", () => {})\n',
  )
  writeFileSync(
    join(DIR, "stuck.test.ts"),
    'import { test } from "bun:test"\ntest("stuck", () => { Bun.sleepSync(20_000) }, 60_000)\n',
  )
  const started = Date.now()
  const run = Bun.spawn(["bun", SCRIPT, "./quick.test.ts", "./stuck.test.ts"], {
    cwd: DIR,
    env: { ...process.env, TEST_PARALLEL_DEADLINE_MS: "5000" },
    stderr: "pipe",
    stdout: "ignore",
    timeout: 10_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(run.signalCode).toBeNull()
  expect(code).not.toBe(0)
  expect(stderr).toContain("parallel pass passed its deadline")
  expect(stderr).toContain("stuck.test.ts")
  expect(stderr).not.toMatch(/still running:.*quick\.test\.ts/)
  expect(Date.now() - started).toBeLessThan(10_000)
}, 20_000)

// A stub's subshell that loops writing (a bare wait did so on GitHub's runner, 31 Oct) outlives bun's own kill of its test, so only the deadline's stop of the whole group ends it
test("the deadline also stops a child a stuck test leaves looping, so the run ends and the loop stops writing", async () => {
  const beat = join(DIR, "beat")
  const live = join(DIR, "live")
  writeFileSync(live, "")
  writeFileSync(
    join(DIR, "looping.test.ts"),
    `import { test } from "bun:test"\ntest("looping", async () => { Bun.spawn(["bash", "-c", "f() { for i in $(seq 600); do [ -e ${live} ] || break; echo $i > ${beat}; echo loop >&2; sleep 0.05; done; }; x=$(f)"]); await Bun.sleep(60_000) }, 60_000)\n`,
  )
  const started = Date.now()
  try {
    const run = Bun.spawn(["bun", SCRIPT, "./looping.test.ts"], {
      cwd: DIR,
      env: { ...process.env, TEST_PARALLEL_DEADLINE_MS: "5000" },
      stderr: "pipe",
      stdout: "ignore",
      timeout: 12_000,
    })
    const [stderr] = await Promise.all([new Response(run.stderr).text(), run.exited])
    expect(run.signalCode).toBeNull()
    expect(stderr).toContain("still running: looping.test.ts")
    expect(Date.now() - started).toBeLessThan(12_000)
    const last = await Bun.file(beat).text()
    await Bun.sleep(500)
    expect(await Bun.file(beat).text()).toBe(last)
  } finally {
    rmSync(live, { force: true })
  }
}, 20_000)

// read by its command as well as its pid, since a loaded Mac can hand a dead child's pid to a new process within a second
const alive = (pid: number, mark: string) =>
  Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)])
    .stdout.toString()
    .includes(mark)
// #2177: a stub checkout's hook outlived its test with parent pid 1 and spun until a reboot, so each pass ends its whole process group as it ends: a child a test left behind goes with it, whether the test passed or bun timed it out
test.each([
  ["a test that passes", "", ""],
  ["a test bun times out", " await Bun.sleep(60_000)", ", 1_000"],
])(
  "a child %s leaves running with parent pid 1 ends with its pass",
  async (name, wait, timeout) => {
    const slug = timeout ? "timed-out" : "passed"
    const pidFile = join(DIR, `${slug}.pid`)
    const mark = `left-by-${slug}-${process.pid}`
    writeFileSync(
      join(DIR, `${slug}.test.ts`),
      `import { test } from "bun:test"\nimport { existsSync } from "node:fs"\ntest(${JSON.stringify(name)}, async () => { Bun.spawn(["bash", "-c", ${JSON.stringify(`bun -e "setInterval(() => {}, 1000) // ${mark}" & echo $! > ${pidFile}`)}]); while (!existsSync(${JSON.stringify(pidFile)})) await Bun.sleep(20);${wait} }${timeout})\n`,
    )
    let pid = 0
    try {
      const run = Bun.spawn(["bun", SCRIPT, `./${slug}.test.ts`], {
        cwd: DIR,
        stderr: "ignore",
        stdout: "ignore",
        timeout: 15_000,
      })
      const code = await run.exited
      pid = Number(readFileSync(pidFile, "utf8"))
      expect(code === 0).toBe(!timeout)
      for (let i = 0; i < 40 && alive(pid, mark); i++) await Bun.sleep(50)
      expect(alive(pid, mark)).toBe(false)
    } finally {
      if (pid && alive(pid, mark)) process.kill(pid, "SIGKILL")
    }
  },
  20_000,
)

// a background child (bash's cmd &) ignores SIGINT, so only the trap that keeps sh alive through a forwarded Ctrl-C lets it reach kill 0
test("a forwarded interrupt still ends a child the test left in the background, which ignores it", async () => {
  const pidFile = join(DIR, "int.pid")
  const mark = `left-by-int-${process.pid}`
  writeFileSync(
    join(DIR, "int.test.ts"),
    `import { test } from "bun:test"\nimport { existsSync } from "node:fs"\ntest("int", async () => { Bun.spawn(["bash", "-c", ${JSON.stringify(`bun -e "setInterval(() => {}, 1000) // ${mark}" & echo $! > ${pidFile}`)}]); while (!existsSync(${JSON.stringify(pidFile)})) await Bun.sleep(20); await Bun.sleep(8_000) }, 20_000)\n`,
  )
  let pid = 0
  try {
    const run = Bun.spawn(["bun", SCRIPT, "./int.test.ts"], {
      cwd: DIR,
      stderr: "ignore",
      stdout: "ignore",
      timeout: 15_000,
    })
    while (!existsSync(pidFile)) await Bun.sleep(50)
    await Bun.sleep(300)
    pid = Number(readFileSync(pidFile, "utf8"))
    run.kill("SIGINT")
    expect(await run.exited).toBe(130)
    for (let i = 0; i < 40 && alive(pid, mark); i++) await Bun.sleep(50)
    expect(alive(pid, mark)).toBe(false)
  } finally {
    if (pid && alive(pid, mark)) process.kill(pid, "SIGKILL")
  }
}, 20_000)

test("a test in the parallel pass runs past bun's 5s default", async () => {
  writeFileSync(
    join(DIR, "busy.test.ts"),
    'import { test } from "bun:test"\ntest("busy", async () => { await Bun.sleep(6_000) })\n',
  )
  const run = Bun.spawn(["bun", SCRIPT, "./busy.test.ts"], {
    cwd: DIR,
    stderr: "ignore",
    stdout: "ignore",
    timeout: 15_000,
  })
  expect(await run.exited).toBe(0)
}, 20_000)

test("an interrupt during the parallel pass ends the run with 128 plus its number, and the serial pass never starts", async () => {
  const started = join(DIR, "slow-started")
  const serialRan = join(DIR, "serial-ran")
  writeFileSync(
    join(DIR, "slow.test.ts"),
    `import { test } from "bun:test"\nimport { writeFileSync } from "node:fs"\ntest("slow", async () => { writeFileSync(${JSON.stringify(started)}, ""); await Bun.sleep(8_000) }, 20_000)\n`,
  )
  const serial = join(DIR, "tests/api/hono/src/bin")
  mkdirSync(serial, { recursive: true })
  writeFileSync(
    join(serial, "dev.test.ts"),
    `import { test } from "bun:test"\nimport { writeFileSync } from "node:fs"\ntest("serial", () => writeFileSync(${JSON.stringify(serialRan)}, ""))\n`,
  )
  const tmp = join(DIR, "tmp-interrupt")
  mkdirSync(tmp)
  const run = Bun.spawn(["bun", SCRIPT, "./slow.test.ts", "./tests/api/hono/src/bin/dev.test.ts"], {
    cwd: DIR,
    env: { ...process.env, TMPDIR: tmp },
    stderr: "ignore",
    stdout: "ignore",
    timeout: 15_000,
  })
  while (!existsSync(started)) await Bun.sleep(50)
  run.kill("SIGINT")
  expect(await run.exited).toBe(130)
  expect(existsSync(serialRan)).toBe(false)
  expect(readdirSync(tmp).filter((name) => name.startsWith("test-sandbox-"))).toEqual([])
}, 20_000)

test.each([
  ["--only-failures", ["--only-failures"]],
  ["--timeout 5000", ["--timeout", "5000"]],
])(
  "a serial file named with a flag runs alone: the parallel pass, left with the flag and no path, runs nothing (%s)",
  async (_, flags) => {
    const dir = mkdtempSync(join(DIR, "serial-flag-"))
    const serialRan = join(dir, "serial-ran")
    const otherRan = join(dir, "other-ran")
    writeFileSync(
      join(dir, "other.test.ts"),
      `import { test } from "bun:test"\nimport { writeFileSync } from "node:fs"\ntest("other", () => writeFileSync(${JSON.stringify(otherRan)}, ""))\n`,
    )
    mkdirSync(join(dir, "tests/api/hono/src/bin"), { recursive: true })
    writeFileSync(
      join(dir, "tests/api/hono/src/bin/dev.test.ts"),
      `import { test } from "bun:test"\nimport { writeFileSync } from "node:fs"\ntest("serial", () => writeFileSync(${JSON.stringify(serialRan)}, ""))\n`,
    )
    const run = Bun.spawn(["bun", SCRIPT, "tests/api/hono/src/bin/dev.test.ts", ...flags], {
      cwd: dir,
      stderr: "ignore",
      stdout: "ignore",
      timeout: 15_000,
    })
    expect(await run.exited).toBe(0)
    expect(existsSync(serialRan)).toBe(true)
    expect(existsSync(otherRan)).toBe(false)
  },
  20_000,
)

test("its sandbox is a marked scratch folder, gone once the run ends (#545)", async () => {
  const tmp = join(DIR, "tmp-scratch")
  const seen = join(DIR, "scratch-seen")
  mkdirSync(tmp)
  writeFileSync(
    join(DIR, "scratch.test.ts"),
    `import { test } from "bun:test"\nimport { existsSync, writeFileSync } from "node:fs"\nconst home = process.env.TEST_SANDBOX_HOME!\ntest("sees", () => writeFileSync(${JSON.stringify(seen)}, home + " " + existsSync(home + "/.safe-delete-scratch")))\n`,
  )
  const run = Bun.spawn(["bun", SCRIPT, "./scratch.test.ts"], {
    cwd: DIR,
    env: { ...process.env, TMPDIR: tmp },
    stderr: "ignore",
    stdout: "ignore",
    timeout: 15_000,
  })
  expect(await run.exited).toBe(0)
  const [home, marked] = readFileSync(seen, "utf8").split(" ")
  expect(marked).toBe("true")
  expect(existsSync(home!)).toBe(false)
  expect(readdirSync(tmp).filter((name) => name.startsWith("test-sandbox-"))).toEqual([])
}, 20_000)

// issue 1306: tests that made mkdtempSync(tmpdir()) folders and never removed them left 24,008 entries in the caller's temp folder, which macOS's cleaner took about 1.5 cores to scan
test("a test's temp folders go with the sandbox, so the caller's temp folder is left as it was", async () => {
  const tmp = join(DIR, "tmp-leaks")
  mkdirSync(tmp)
  writeFileSync(
    join(DIR, "leaks.test.ts"),
    `import { test } from "bun:test"\nimport { mkdtempSync } from "node:fs"\nimport { tmpdir } from "node:os"\nimport { join } from "node:path"\ntest("leaks", () => { mkdtempSync(join(tmpdir(), "leak-")); mkdtempSync(join(tmpdir(), "leak-")) })\n`,
  )
  const run = Bun.spawn(["bun", SCRIPT, "./leaks.test.ts"], {
    cwd: DIR,
    env: { ...process.env, TMPDIR: tmp },
    stderr: "ignore",
    stdout: "ignore",
    timeout: 15_000,
  })
  expect(await run.exited).toBe(0)
  expect(readdirSync(tmp)).toEqual([])
}, 20_000)

const ENV_DIST = join(import.meta.dir, "../../../../packages/env/dist")
const REQUIRED = [
  "BETTER_AUTH_SECRET",
  "HONO_APP_URL",
  "HONO_TRUSTED_ORIGINS",
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_APP_URL",
  "POSTGRES_URL",
]
// a .env that sets every key the apps' schemas require, each to a value they take
const FULL = {
  BETTER_AUTH_SECRET: "0".repeat(64),
  HONO_APP_URL: "http://localhost:4000",
  HONO_TRUSTED_ORIGINS: "http://localhost:3000",
  NEXT_PUBLIC_API_URL: "http://localhost:4000",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  POSTGRES_URL: "postgres://user:pw@127.0.0.1:5432/db",
}
const dotenv = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("")

// runs one test that imports an env schema (api-hono's, or the one named) in a fresh folder holding the given files, each empty or with the given text, with the caller's env lacking every required key
const validates = async (
  files: (string | [string, string])[],
  extra: Record<string, string> = {},
  schema = "api-hono",
) => {
  const folder = mkdtempSync(join(tmpdir(), "test-sandbox-env-"))
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: "test", ...extra }
  for (const key of [...REQUIRED, "SKIP_ENV_VALIDATION"]) if (!(key in extra)) delete env[key]
  writeFileSync(
    join(folder, "validates.test.ts"),
    `import { test } from "bun:test"\nimport ${JSON.stringify(join(ENV_DIST, `${schema}.mjs`))}\ntest("imports", () => {})\n`,
  )
  for (const file of files) {
    const [name, text] = typeof file === "string" ? [file, ""] : file
    writeFileSync(join(folder, name), text)
  }
  try {
    const child = Bun.spawn(["bun", SCRIPT, "./validates.test.ts"], {
      cwd: folder,
      env,
      stderr: "pipe",
      stdout: "ignore",
      timeout: 15_000,
    })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    return { code, invalid: stderr.includes("Invalid environment variables") }
  } finally {
    rmSync(folder, { force: true, recursive: true })
  }
}

const refused = dotenv({ ...FULL, HONO_APP_URL: "not-a-url" })

test("a folder with no .env, or an empty one, runs a test whose import validates the environment, and a .env with every required key set leaves it validated", async () => {
  expect(await validates([])).toEqual({ code: 0, invalid: false })
  expect(await validates([".env"])).toEqual({ code: 0, invalid: false })
  const validated = await validates([[".env", refused]])
  expect(validated.invalid).toBe(true)
  expect(validated.code).not.toBe(0)
}, 40_000)

// 5 Nov: a fresh worktree's .env, copied from .env.example for the commit hook, left POSTGRES_URL empty, and 8 test files importing @packages/env/db failed on "Invalid environment variables: POSTGRES_URL"
test("a .env that leaves a required key empty, as a fresh copy of .env.example leaves POSTGRES_URL, runs a test importing the database's env", async () => {
  expect(await validates([[".env", dotenv({ ...FULL, POSTGRES_URL: "" })]], {}, "db")).toEqual({
    code: 0,
    invalid: false,
  })
}, 20_000)

test("every env file bun test loads counts as one, and .env.local, which it skips, does not (#1859)", async () => {
  for (const file of [".env.test", ".env.test.local"])
    expect((await validates([[file, refused]])).invalid).toBe(true)
  expect(await validates([[".env.local", refused]])).toEqual({ code: 0, invalid: false })
}, 40_000)

test("a SKIP_ENV_VALIDATION the caller set stays as set in a folder with no .env (#1859)", async () => {
  expect((await validates([], { SKIP_ENV_VALIDATION: "false" })).invalid).toBe(true)
}, 20_000)

// A git hook exports GIT_DIR and GIT_INDEX_FILE, and a test's scratch git init once took them and set the real repository's core.bare (3 Nov), so the sandbox hands its tests none
test("a test's scratch git init, run under a hook's GIT_DIR and GIT_INDEX_FILE, leaves them untouched", () => {
  const decoy = join(DIR, "decoy-git")
  const repo = join(DIR, "scratch-repo")
  writeFileSync(
    join(DIR, "git-init.test.ts"),
    `import { expect, test } from "bun:test"\ntest("git init", () => { expect(Bun.spawnSync(["git", "init", "-q", ${JSON.stringify(repo)}]).exitCode).toBe(0) })\n`,
  )
  const run = Bun.spawnSync(["bun", SCRIPT, "./git-init.test.ts"], {
    cwd: DIR,
    env: { ...process.env, GIT_DIR: decoy, GIT_INDEX_FILE: join(decoy, "index") },
    stderr: "pipe",
    stdout: "ignore",
  })
  expect(existsSync(decoy)).toBe(false)
  expect(existsSync(join(repo, ".git"))).toBe(true)
  expect(run.exitCode).toBe(0)
}, 30_000)

// A worktree .env set for a hosted stack turned config.hosted on inside test:file, and 14 Inbox render tests read the hosted build's gates (#1055)
test("a hosted .env and a hosted caller leave both hosted flags empty in a test, and a flag the test sets itself reaches its child", () => {
  const folder = mkdtempSync(join(DIR, "hosted-"))
  const seen = join(folder, "seen.json")
  writeFileSync(join(folder, ".env"), "NEXT_PUBLIC_PLAYGROUND_HOSTED=1\nPLAYGROUND_HOSTED=1\n")
  writeFileSync(
    join(folder, "hosted.test.ts"),
    `import { test } from "bun:test"
import { writeFileSync } from "node:fs"
test("reads", () => {
  const read = [process.env.NEXT_PUBLIC_PLAYGROUND_HOSTED, process.env.PLAYGROUND_HOSTED]
  process.env.PLAYGROUND_HOSTED = "1"
  const child = Bun.spawnSync(["bun", "-e", "process.stdout.write(process.env.PLAYGROUND_HOSTED ?? 'unset')"], { env: process.env }).stdout.toString()
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ child, read }))
})
`,
  )
  const run = Bun.spawnSync(["bun", SCRIPT, "./hosted.test.ts"], {
    cwd: folder,
    env: { ...process.env, NEXT_PUBLIC_PLAYGROUND_HOSTED: "1", PLAYGROUND_HOSTED: "1" },
    stderr: "pipe",
    stdout: "ignore",
  })
  expect(run.exitCode).toBe(0)
  expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({ child: "1", read: ["", ""] })
}, 30_000)

// bun reads a path it cannot find as a name filter that matches nothing, so a mistyped path once let a run pass on its other files (2 Nov)
test("a test path that names no file fails the run, naming it, and runs nothing (#627)", async () => {
  const ran = join(DIR, "real-ran")
  writeFileSync(
    join(DIR, "real.test.ts"),
    `import { test } from "bun:test"\nimport { writeFileSync } from "node:fs"\ntest("real", () => writeFileSync(${JSON.stringify(ran)}, ""))\n`,
  )
  const run = Bun.spawn(["bun", SCRIPT, "./real.test.ts", "fixtures/missing.test.ts"], {
    cwd: DIR,
    stderr: "pipe",
    stdout: "ignore",
    timeout: 15_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(code).not.toBe(0)
  expect(stderr).toContain("fixtures/missing.test.ts")
  expect(existsSync(ran)).toBe(false)
}, 20_000)

test.each([
  ["a path with a leading ./", "./filtered.test.ts"],
  ["a path with none", "filtered.test.ts"],
  ["a filter with no test suffix", "filtered"],
])(
  "%s runs as before (#627)",
  async (_, arg) => {
    writeFileSync(
      join(DIR, "filtered.test.ts"),
      'import { test } from "bun:test"\ntest("filtered", () => {})\n',
    )
    const run = Bun.spawn(["bun", SCRIPT, arg], {
      cwd: DIR,
      stderr: "pipe",
      stdout: "ignore",
      timeout: 15_000,
    })
    const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
    expect(code).toBe(0)
    expect(stderr).toContain("1 pass")
  },
  20_000,
)

// a background task starts in the factory's main checkout, which follows main, so a relative path there names main's copy of the file, not the worker's branch
describe("a relative path in the factory's main checkout", () => {
  const main = join(DIR, "main-checkout")
  const ran = join(DIR, "main-ran")
  mkdirSync(join(main, "tests"), { recursive: true })
  writeFileSync(
    join(main, "tests", "here.test.ts"),
    `import { test } from "bun:test"\nimport { writeFileSync } from "node:fs"\ntest("here", () => writeFileSync(${JSON.stringify(ran)}, ""))\n`,
  )
  const runIn = async (repo: string, arg: string) => {
    rmSync(ran, { force: true })
    const run = Bun.spawn(["bun", SCRIPT, arg], {
      cwd: main,
      env: { ...process.env, PLAYGROUND_REPO: repo },
      stderr: "pipe",
      stdout: "ignore",
      timeout: 15_000,
    })
    const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
    return { code, ran: existsSync(ran), stderr }
  }

  // a test file new on the branch is absent from the main checkout, so it gets the same --cwd form, not the missing-file one
  test.each([
    ["a file there", "tests/here.test.ts"],
    ["a test file new on the branch, absent there", "tests/new-on-branch.test.ts"],
  ])(
    "refuses %s before any test runs, naming the path and the --cwd form",
    async (_, arg) => {
      const { code, ran, stderr } = await runIn(main, arg)
      expect(code).toBe(1)
      expect(ran).toBe(false)
      expect(stderr).not.toContain("no test file")
      expect(stderr).toContain(`bun run --cwd <your worktree> test:file ${arg}`)
    },
    20_000,
  )

  test.each([
    ["an absolute path in the main checkout", "main", join(main, "tests", "here.test.ts")],
    ["a relative path where PLAYGROUND_REPO names another checkout", "other", "tests/here.test.ts"],
  ])(
    "%s runs as before",
    async (_, repo, arg) => {
      const other = join(DIR, "other-checkout")
      mkdirSync(other, { recursive: true })
      const { code, ran, stderr } = await runIn(repo === "main" ? main : other, arg)
      expect(code).toBe(0)
      expect(ran).toBe(true)
      expect(stderr).toContain("1 pass")
    },
    20_000,
  )
})

// 2711: a Python test is one of the paths test:file runs, so one that fails exits the run naming it, one that passes is reported as run, and a diff that only adds a docs line still lists a repo-walking Python test through touchedTests. A .py test bun cannot run would read green on the other files, so each row is one bun would read green, and none is allowed to.
test("a failing Python test exits the run, naming it, like a failing bun test (#2711)", async () => {
  const dir = join(DIR, "py-fail")
  mkdirSync(join(dir, "tests", "x"), { recursive: true })
  // a .py bun would read a .py path as a name filter matching nothing, so green on the other files; one that exits 1 is the failing case, and its FAIL line names it, as test:file's grep reads
  writeFileSync(
    join(dir, "tests", "x", "test_fail.py"),
    'import sys\nprint("FAIL boom", flush=True)\nsys.exit(1)\n',
  )
  const run = Bun.spawn(["bun", SCRIPT, "tests/x/test_fail.py"], {
    cwd: dir,
    env: { ...process.env, PATH: `${uvBin}:${process.env.PATH}` },
    stderr: "pipe",
    stdout: "ignore",
    timeout: 120_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(code).not.toBe(0)
  expect(stderr).toContain("tests/x/test_fail.py")
  expect(stderr).toMatch(/Python test .* failed/)
}, 180_000)

test("a passing Python test exits 0, and is reported as run, not read green (#2711)", async () => {
  const dir = join(DIR, "py-ok")
  mkdirSync(join(dir, "tests", "x"), { recursive: true })
  writeFileSync(join(dir, "tests", "x", "test_ok.py"), 'import sys\nprint("ok", flush=True)\n')
  const run = Bun.spawn(["bun", SCRIPT, "tests/x/test_ok.py"], {
    cwd: dir,
    env: { ...process.env, PATH: `${uvBin}:${process.env.PATH}` },
    stderr: "pipe",
    stdout: "ignore",
    timeout: 120_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(code).toBe(0)
  expect(stderr).toContain("running Python test tests/x/test_ok.py")
  expect(stderr).toContain("1 Python test passed")
}, 180_000)

test("a diff that only adds a docs line still lists a repo-walking Python test, and test:file over that list runs it (#2711)", async () => {
  const dir = join(DIR, "py-repo")
  mkdirSync(dir, { recursive: true })
  const git = (...a: string[]) => {
    const out = Bun.spawnSync(["git", "-C", dir, ...a], { stdout: "pipe", stderr: "pipe" })
    if (out.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${out.stderr.toString()}`)
  }
  git("init", "-q", "-b", "canary")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  mkdirSync(join(dir, "tests", "walk"), { recursive: true })
  mkdirSync(join(dir, "docs"), { recursive: true })
  // a test that walks the repo, so touchedTests lists it whenever the diff adds text, though only docs changed
  writeFileSync(join(dir, "docs", "a.md"), "# a\n\nfirst line\n")
  writeFileSync(
    join(dir, "tests", "walk", "test_walks.py"),
    "import os\nn = 0\nfor root, dirs, names in os.walk('.'):\n    n += len(names)\nassert n >= 0\n",
  )
  git("add", ".")
  git("commit", "-qm", "base")
  // canary keeps the base commit; the docs line lands on the next branch, so canary (base) and HEAD (tip) differ and the diff adds text
  git("checkout", "-q", "-b", "feature")
  // a change that adds a docs line only, so the diff adds text without touching a test
  writeFileSync(join(dir, "docs", "a.md"), "# a\n\nfirst line\nsecond line\n")
  git("commit", "-qam", "add a docs line")
  const { touchedTests } =
    await import("../../../../extensions/core/skills/code-review-loop/scripts/state")
  const listed = touchedTests(dir, "canary", "HEAD")
  expect(listed).toContain("tests/walk/test_walks.py")
  // test:file over the list routes the Python test to uv, so the run passes, as it could not over the docs-only diff before
  const run = Bun.spawn(["bun", SCRIPT, ...listed], {
    cwd: dir,
    env: { ...process.env, PATH: `${uvBin}:${process.env.PATH}` },
    stderr: "pipe",
    stdout: "ignore",
    timeout: 120_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(code).toBe(0)
  expect(stderr).toContain("tests/walk/test_walks.py")
  expect(stderr).toContain("1 Python test passed")
}, 180_000)

test.each([
  ["a .json path that is not a test", "package.json"],
  ["a folder that holds no test", "empty"],
  ["a name filter that matches nothing", "no-such-filter-xyz"],
])(
  "stops the run on %s, naming it, since bun would read green on the other files (#2711)",
  async (_, arg) => {
    const dir = join(DIR, "stop")
    mkdirSync(join(dir, "tests", "scripts"), { recursive: true })
    mkdirSync(join(dir, "empty"), { recursive: true })
    // a folder that holds no test, and a .json that is not a test, reach bun only as a filter, so bun reads green on the one real test; the classifier stops them before bun, naming them
    writeFileSync(
      join(dir, "tests", "scripts", "ok.test.ts"),
      'import { test } from "bun:test"\ntest("ok", () => {})\n',
    )
    writeFileSync(join(dir, "package.json"), "{}\n")
    const run = Bun.spawn(["bun", SCRIPT, arg, "tests/scripts/ok.test.ts"], {
      cwd: dir,
      stderr: "pipe",
      stdout: "ignore",
      timeout: 15_000,
    })
    const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
    expect(code).not.toBe(0)
    expect(stderr).toContain(arg)
    expect(stderr).toContain("check the path and run again")
  },
  20_000,
)

// a run's own red test, so a pass that never ran reads as the false green it is
const redTest = 'import { expect, test } from "bun:test"\ntest("red", () => expect(1).toBe(2))\n'

test("a run given no path runs the tests folder, so `bun run test` still runs the suite (#2711)", async () => {
  const dir = join(DIR, "no-args")
  mkdirSync(join(dir, "tests", "x"), { recursive: true })
  writeFileSync(join(dir, "tests", "x", "red.test.ts"), redTest)
  const run = Bun.spawn(["bun", SCRIPT], {
    cwd: dir,
    stderr: "pipe",
    stdout: "ignore",
    timeout: 120_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(code).not.toBe(0)
  expect(stderr).toContain("parallel pass failed")
}, 180_000)

test("a flag given beside a path reaches bun test (#2711)", async () => {
  const dir = join(DIR, "flag")
  mkdirSync(join(dir, "tests", "x"), { recursive: true })
  writeFileSync(
    join(dir, "tests", "x", "two.test.ts"),
    `${redTest}test("only", () => expect(1).toBe(1))\n`,
  )
  const run = Bun.spawn(["bun", SCRIPT, "tests/x/two.test.ts", "--test-name-pattern=only"], {
    cwd: dir,
    stderr: "pipe",
    stdout: "ignore",
    timeout: 120_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(stderr).toContain("parallel pass passed")
  expect(code).toBe(0)
}, 180_000)

test("a Python test named by its absolute path runs, as the main checkout's rule asks (#2711)", async () => {
  const dir = join(DIR, "py-absolute")
  mkdirSync(join(dir, "tests", "x"), { recursive: true })
  writeFileSync(join(dir, "tests", "x", "test_ok.py"), 'print("ok", flush=True)\n')
  const run = Bun.spawn(["bun", SCRIPT, join(dir, "tests", "x", "test_ok.py")], {
    cwd: dir,
    env: { ...process.env, PATH: `${uvBin}:${process.env.PATH}` },
    stderr: "pipe",
    stdout: "ignore",
    timeout: 120_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(stderr).toContain("1 Python test passed")
  expect(code).toBe(0)
}, 180_000)

test("a Python test a red bun pass leaves unrun is reported as skipped, not passed (#2711)", async () => {
  const dir = join(DIR, "py-skipped")
  mkdirSync(join(dir, "tests", "x"), { recursive: true })
  writeFileSync(join(dir, "tests", "x", "red.test.ts"), redTest)
  writeFileSync(join(dir, "tests", "x", "test_ok.py"), 'print("ok", flush=True)\n')
  const run = Bun.spawn(["bun", SCRIPT, "tests/x/red.test.ts", "tests/x/test_ok.py"], {
    cwd: dir,
    env: { ...process.env, PATH: `${uvBin}:${process.env.PATH}` },
    stderr: "pipe",
    stdout: "ignore",
    timeout: 120_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(code).not.toBe(0)
  expect(stderr).toContain("1 Python test skipped")
  expect(stderr).not.toContain("Python test passed")
}, 180_000)

// 2770: a flag that takes a value, like `-t name` or `--timeout 5000`, was read as a name filter and stopped the run; the flag and its value now go to bun together
test.each([
  ["-t name", "-t", "select"],
  ["--test-name-pattern name", "--test-name-pattern", "select"],
  ["--timeout 5000", "--timeout", "5000"],
])(
  "passes a flag that takes a value through to bun: %s",
  async (_, flag, value) => {
    const dir = join(DIR, `flag-val-${flag.replace(/[^a-z0-9]/g, "-")}`)
    mkdirSync(join(dir, "tests", "x"), { recursive: true })
    writeFileSync(
      join(dir, "tests", "x", "flag.test.ts"),
      `import { test } from "bun:test"\ntest("keep", () => {})\ntest("select", () => {})\n`,
    )
    const run = Bun.spawn(["bun", SCRIPT, "tests/x/flag.test.ts", flag, value], {
      cwd: dir,
      stderr: "pipe",
      stdout: "ignore",
      timeout: 120_000,
    })
    const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
    expect(code).toBe(0)
    expect(stderr).toContain("parallel pass passed")
  },
  180_000,
)

// 2770: a name filter matched a test file's base name, so a folder name matched nothing and stopped the run, though bun matches the whole path; the filter now matches the whole relative path
test("a name filter matches on the whole path, so a folder name runs the test under it, like bun (#2770)", async () => {
  const dir = join(DIR, "filter-path")
  mkdirSync(join(dir, "tests", "hooks", "guards"), { recursive: true })
  writeFileSync(
    join(dir, "tests", "hooks", "guards", "guard.test.ts"),
    'import { test } from "bun:test"\ntest("guard", () => {})\n',
  )
  const run = Bun.spawn(["bun", SCRIPT, "hooks/guards"], {
    cwd: dir,
    stderr: "pipe",
    stdout: "ignore",
    timeout: 120_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(code).toBe(0)
  expect(stderr).toContain("1 pass")
}, 180_000)

// 2770: a folder whose only tests are Python went to bun and failed; it now runs through the Python runner
test("a folder holding only Python tests runs them as Python tests, not through bun (#2770)", async () => {
  const dir = join(DIR, "py-only-folder")
  mkdirSync(join(dir, "tests", "pyonly"), { recursive: true })
  writeFileSync(join(dir, "tests", "pyonly", "test_x.py"), 'print("ok", flush=True)\n')
  const run = Bun.spawn(["bun", SCRIPT, "tests/pyonly"], {
    cwd: dir,
    env: { ...process.env, PATH: `${uvBin}:${process.env.PATH}` },
    stderr: "pipe",
    stdout: "ignore",
    timeout: 120_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(code).toBe(0)
  expect(stderr).toContain("running Python test tests/pyonly")
  expect(stderr).toContain("1 Python test passed")
}, 180_000)

// 2770: seenPy was keyed by the path as given, so one Python file named by both its absolute and relative path ran twice; it is now deduped by its real path (#2858)
test("one Python test named by both relative and absolute path runs once (#2770)", async () => {
  const dir = join(DIR, "py-twice")
  mkdirSync(join(dir, "tests", "x"), { recursive: true })
  const file = join(dir, "tests", "x", "test_ok.py")
  writeFileSync(file, 'print("ok", flush=True)\n')
  const run = Bun.spawn(["bun", SCRIPT, "tests/x/test_ok.py", file], {
    cwd: dir,
    env: { ...process.env, PATH: `${uvBin}:${process.env.PATH}` },
    stderr: "pipe",
    stdout: "ignore",
    timeout: 120_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(code).toBe(0)
  expect(stderr).toContain("1 Python test passed")
  expect(stderr).not.toContain("2 Python test")
}, 180_000)

// 2858: seenPy keyed a path by resolve(), so a file named through a linked folder and through its real one ran twice, as macOS's /var and /private/var name one file; it is now keyed by its real path
test("one Python test named through a linked folder and its real folder runs once (#2858)", async () => {
  const dir = join(DIR, "py-linked")
  mkdirSync(join(dir, "tests", "x"), { recursive: true })
  writeFileSync(join(dir, "tests", "x", "test_ok.py"), 'print("ok", flush=True)\n')
  symlinkSync(join(dir, "tests", "x"), join(dir, "tests", "linked"))
  const run = Bun.spawn(
    [
      "bun",
      SCRIPT,
      join(dir, "tests", "x", "test_ok.py"),
      join(dir, "tests", "linked", "test_ok.py"),
    ],
    {
      cwd: dir,
      env: { ...process.env, PATH: `${uvBin}:${process.env.PATH}` },
      stderr: "pipe",
      stdout: "ignore",
      timeout: 120_000,
    },
  )
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(code).toBe(0)
  expect(stderr).toContain("1 Python test passed")
  expect(stderr).not.toContain("2 Python test")
}, 180_000)

// 2770: a run with no Python path printed `0 Python tests passed`; the summary now prints no Python line when there are none
test("a run with no Python path prints no Python test line (#2770)", async () => {
  const dir = join(DIR, "no-py-line")
  mkdirSync(join(dir, "tests", "x"), { recursive: true })
  writeFileSync(
    join(dir, "tests", "x", "ok.test.ts"),
    'import { test } from "bun:test"\ntest("ok", () => {})\n',
  )
  const run = Bun.spawn(["bun", SCRIPT, "tests/x/ok.test.ts"], {
    cwd: dir,
    stderr: "pipe",
    stdout: "ignore",
    timeout: 120_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(code).toBe(0)
  expect(stderr).not.toContain("Python test")
}, 180_000)

test("a flag whose value bun takes only after `=` leaves the next word a path: `--bail <Python test>` runs it as a Python test (#2770)", async () => {
  const dir = join(DIR, "bail-py")
  mkdirSync(join(dir, "tests", "x"), { recursive: true })
  writeFileSync(join(dir, "tests", "x", "test_ok.py"), 'print("ok", flush=True)\n')
  const run = Bun.spawn(["bun", SCRIPT, "--bail", "tests/x/test_ok.py"], {
    cwd: dir,
    env: { ...process.env, PATH: `${uvBin}:${process.env.PATH}` },
    stderr: "pipe",
    stdout: "ignore",
    timeout: 120_000,
  })
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  expect(code).toBe(0)
  expect(stderr).toContain("1 Python test passed")
}, 180_000)
