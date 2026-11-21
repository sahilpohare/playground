// The suite's runner: runs `bun test` in sandbox.ts's sandbox, so no test can start a real session or read the real config by accident (a self-removal test once started two). The env is set before bun starts, since os.homedir() and the spawn PATH lookup read the boot environment, not a later mutation. The folder goes when the run does.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { availableParallelism, constants } from "node:os"
import { basename, isAbsolute, join, relative } from "node:path"

import { removeScratch } from "@packages/safe-delete"

import { CLOCK_EXEMPT, clockExempt } from "./clock-exempt"
import { sandbox } from "./sandbox"
import { py } from "./test-skills"
import { isMainCheckout, prebuildTests } from "./verify/prebuild"

const TIMINGS = "tests/timings.json"

// Files that run one at a time after the parallel pass: dev.test.ts and launch.test.ts move packages/env/dist/gaps.mjs aside, and dev.test.ts's launcher rebuilds @packages/env, whose dist the other workers import; check-types-env.test.ts runs the root check-types script in the checkout, whose env values hash build keys other workers' dist was not built under, so a worker beside it would read a dist rebuilt mid-pass; this pass runs its files in one process, which loads a shared helper once, so no spawn*.test.ts or ops/run-slot*.test.ts file joins it, since each needs its fake afresh
const SERIAL = [
  "tests/api/hono/src/bin/dev.test.ts",
  "tests/api/hono/src/lib/dev/launch.test.ts",
  "tests/check-types-env.test.ts",
]

const { env, scratch, wrap } = sandbox()
// a worktree .env set for a hosted stack would turn the hosted build's gates on in every test, and bun test fills only a key its env leaves unset, so both flags go in empty, which the env schemas read as unset; a test that wants the hosted build sets the flag itself
Object.assign(env, { NEXT_PUBLIC_PLAYGROUND_HOSTED: "", PLAYGROUND_HOSTED: "" })
const dropScratch = () => {
  const refused = removeScratch(scratch)
  if (refused) console.error(`test-sandbox: ${refused}`)
}
// CI's clock-ahead pass: with CLOCK_AHEAD_DAYS set, every test file reads a clock that many days on, so a test that mixes a fixed clock with the real one fails on its own PR rather than on the day the real clock reaches it
const ahead = Boolean(process.env.CLOCK_AHEAD_DAYS)
const clock = ahead ? [`--preload=${join(import.meta.dir, "../../../tests/clock-ahead.ts")}`] : []
// bun's own test timeout cannot stop a test blocked in sync code (a spawnSync that never returns held a worker 29 minutes once), so the parallel pass has a deadline: each worker marks the file it holds through a preload that runs once per test file, and a pass past the deadline is killed as a group and fails naming the files still marked
const DEADLINE_MS = Number(process.env.TEST_PARALLEL_DEADLINE_MS) || 20 * 60_000
const running = join(scratch, "running")
mkdirSync(running)
const preload = join(scratch, "running.ts")
writeFileSync(
  preload,
  `import { afterAll } from "bun:test"\nimport { rmSync, writeFileSync } from "node:fs"\nconst mark = ${JSON.stringify(running)} + "/" + process.pid\nwriteFileSync(mark, Bun.main)\nafterAll(() => rmSync(mark, { force: true }))\n`,
)
const held = () =>
  readdirSync(running).flatMap((pid) => {
    try {
      return [relative(process.cwd(), readFileSync(join(running, pid), "utf8"))]
    } catch {
      return []
    }
  })
let interrupted: NodeJS.Signals | undefined
// each pass runs bun test in a process group of its own, which ends whole as the pass ends: a child a test left running, after it passed or bun timed it out, once spun with parent pid 1 until a reboot; sh leads the group and ends it from inside with kill 0 once bun test exits, so the signal reaches this group alone, where a pid already reaped can name a new process within a second; its trap outlives a forwarded Ctrl-C, which bun test takes, so the group still ends; on Linux the group is bwrap's, outside the pid view, so a forwarded signal ends bwrap and --die-with-parent ends the whole view at once, bun test and the trap included
let passes = 0
const runPass = async (argv: string[], deadline?: number) => {
  const status = join(scratch, `pass-${++passes}`)
  const child = Bun.spawn(
    wrap([
      "sh",
      "-c",
      'f=$1; shift; trap : INT TERM; bun test "$@"; echo $? > "$f"; kill -KILL 0',
      "sh",
      status,
      ...clock,
      ...argv,
    ]),
    { detached: true, env, stdio: ["inherit", "inherit", "inherit"] },
  )
  const stop = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, signal)
    } catch {}
  }
  // a detached group misses the terminal's Ctrl-C, so pass it on
  const forward = (signal: NodeJS.Signals) => {
    interrupted = signal
    stop(signal)
  }
  process.on("SIGINT", forward)
  process.on("SIGTERM", forward)
  let timer: Timer | undefined
  const late = new Promise<"late">((done) => {
    if (deadline) timer = setTimeout(() => done("late"), deadline)
  })
  const code = await Promise.race([child.exited, late])
  clearTimeout(timer)
  process.off("SIGINT", forward)
  process.off("SIGTERM", forward)
  if (code !== "late") return existsSync(status) ? Number(readFileSync(status, "utf8")) : code
  const files = held()
  stop("SIGKILL")
  await child.exited
  console.error(
    `test-sandbox: parallel pass passed its deadline (${Math.round(DEADLINE_MS / 1000)}s), still running: ${files.join(", ") || "no file named"}`,
  )
  return 124
}

// cores - 1 workers, at most 4; tests/timings.json starts the slowest files first, and a missing one only loses that order
const workers = Math.min(4, Math.max(1, availableParallelism() - 1))
// a test beside other workers runs slower than alone, so the parallel pass gives each test 30s where bun gives 5s: four tests that spawn a process or read every test file passed their 5s on GitHub's 4-core runner, and on the loaded runner box two failed at 15s, so 30s is twice that
const TIMEOUT_MS = 30_000
const update = process.env.TEST_TIMINGS_UPDATE === "1"
const readable = () => {
  try {
    JSON.parse(readFileSync(TIMINGS, "utf8"))
    return true
  } catch {
    return false
  }
}
const timings = update || readable() ? [`--timings=${TIMINGS}`] : []
// bun flags whose value may follow as its own word (`bun test --help`), A to Z; each is joined to its value here, as `bun test` reads `flag=value`, so no later step reads the value as a path or a name filter
const takesValue = new Set([
  "--coverage-dir",
  "--coverage-reporter",
  "--max-concurrency",
  "--parallel-delay",
  "--path-ignore-patterns",
  "--reporter",
  "--reporter-outfile",
  "--rerun-each",
  "--retry",
  "--seed",
  "--shard",
  "--test-name-pattern",
  "--timeout",
  "--timings",
  "-t",
])
const args: string[] = []
for (const arg of process.argv.slice(2)) {
  const flag = args.at(-1)
  if (flag !== undefined && takesValue.has(flag) && !arg.startsWith("-"))
    args[args.length - 1] = `${flag}=${arg}`
  else args.push(arg)
}
const paths = args.length > 0 ? args : ["tests"]
// compared without a leading ./ or a trailing /, and passed to bun as given, since bun reads ./name as a path and name as a filter
const bare = (path: string) => path.replace(/^(\.\/)+/, "").replace(/\/+$/, "") || "."
// a background task starts in the factory's main checkout, which follows main, so a relative path or a filter there names main's copy and would read green on code the branch never changed; which worktree it meant cannot be told, so the run stops, before the missing-file check, which a test file new on the branch would hit there
const relativeHere = isMainCheckout(process.cwd(), process.env.PLAYGROUND_REPO)
  ? args.filter((arg) => !arg.startsWith("-") && !isAbsolute(arg))
  : []
if (relativeHere.length > 0) {
  console.error(
    `test-sandbox: ${relativeHere.join(", ")} is relative or a filter, and this run is in the factory's main checkout, which follows main, so it would test main's copy; run it from your worktree: bun run --cwd <your worktree> test:file ${args.join(" ")}`,
  )
  dropScratch()
  process.exit(1)
}
// bun reads a path it cannot find as a name filter that matches nothing, so a test path bun cannot run would read green on the other files. A bun test file, a Python test, or a folder holding a test is run; a path that is none of these, or a name filter selecting nothing, stops the run before bun, naming each. The run stops, so a broken test or a typo is heard now, not swallowed.
// a bun test file is any .test.ts or .test.tsx named path
const isBunTest = (path: string) => /\.test\.tsx?$/.test(path)
// a Python test is any test_*.py, matched by its stem so a nested one, tests/x/test_x.py, still names a test
const isPyTest = (path: string) => /^test_[^/]+\.py$/.test(basename(path))
// a folder scanned depth-first, skipping its build and VCS folders, returns its bun and Python test files, as full paths
const IGNORED = new Set(["node_modules", ".git", "dist", ".next"])
const scanFolder = (dir: string): { bun: string[]; py: string[] } => {
  const bun: string[] = []
  const py: string[] = []
  const one = (folder: string) => {
    for (const entry of readdirSync(folder)) {
      if (IGNORED.has(entry)) continue
      try {
        const full = join(folder, entry)
        if (statSync(full).isDirectory()) one(full)
        else if (isBunTest(entry)) bun.push(full)
        else if (isPyTest(entry)) py.push(full)
      } catch {
        continue
      }
    }
  }
  one(dir)
  return { bun, py }
}
// a bare name filter selects a test when any test file of the run's, found depth-first from here, carries it in its whole path, so the run's set of test files decides, and bun still gets the filter to run it
const filterMatches = (filter: string): boolean => {
  let found = false
  const one = (folder: string) => {
    if (found) return
    for (const entry of readdirSync(folder)) {
      if (found) break
      if (IGNORED.has(entry)) continue
      try {
        const full = join(folder, entry)
        if (statSync(full).isDirectory()) one(full)
        else if ((isBunTest(entry) || isPyTest(entry)) && full.includes(filter)) found = true
      } catch {
        continue
      }
    }
  }
  one(".")
  return found
}
// a .py path that is not a test, and any other path that is not a test or a folder holding one, is passed to bun only as a filter, so bun would read green on the other files; these are rejected here, before bun
const bunTargets: string[] = []
const pyTargets: [label: string, file: string][] = []
const unrunnable: [label: string, reason: string][] = []
// each Python test keyed by its real path, so a linked folder and its real one, as macOS's /var and /private/var, name one file once (issue 2858)
const seenPy = new Set<string>()
for (const arg of paths) {
  if (arg.startsWith("-")) {
    bunTargets.push(arg)
    continue
  }
  const b = bare(arg)
  if (isBunTest(b)) {
    if (!existsSync(b)) unrunnable.push([arg, "no test file at"])
    else bunTargets.push(arg)
  } else if (isPyTest(b)) {
    if (!existsSync(b)) unrunnable.push([arg, "no Python test at"])
    else if (!seenPy.has(realpathSync(b))) {
      seenPy.add(realpathSync(b))
      pyTargets.push([arg, relative("tests", b)])
    }
  } else if (existsSync(b)) {
    try {
      if (statSync(b).isDirectory()) {
        const { bun, py } = scanFolder(b)
        if (py.length > 0 && bun.length === 0) {
          for (const full of py)
            if (!seenPy.has(realpathSync(full))) {
              seenPy.add(realpathSync(full))
              pyTargets.push([full, relative("tests", full)])
            }
        } else if (bun.length > 0) {
          bunTargets.push(arg)
        } else unrunnable.push([arg, "no test in folder at"])
      } else unrunnable.push([arg, "no test file at"])
    } catch {
      unrunnable.push([arg, "no test file at"])
    }
  } else if (filterMatches(b)) bunTargets.push(arg)
  else unrunnable.push([arg, "no test matching"])
}
if (unrunnable.length > 0) {
  console.error(
    `test-sandbox: ${unrunnable.map(([label, reason]) => `${reason} ${label}`).join(", ")}; check the path and run again`,
  )
  dropScratch()
  process.exit(1)
}
// a worktree whose node_modules came from a clone has no dist, and a test importing an unbuilt package fails on a missing module, which hides the failure it reproduces, so the packages these files import, and every shared package whose dist is missing, are built first
const built = await prebuildTests(paths.filter((path) => !path.startsWith("-")))
if (built !== 0) {
  dropScratch()
  process.exit(built)
}
// a worktree with none of the env files bun test loads (a skill-only chore; it skips .env.local), or whose files leave a key the apps' schemas require empty (a fresh copy of .env.example leaves POSTGRES_URL so), has no values for those schemas, so a test that imports one would fail its validation, unless the caller set the flag; a key set to a value the schema refuses stays validated
const skipValidation = async (): Promise<boolean> => {
  if (![".env", ".env.test", ".env.test.local"].some((file) => existsSync(file))) return true
  try {
    const { requiredKeys } = await import("@packages/env/gaps")
    return [...requiredKeys().keys()].some((key) => !process.env[key])
  } catch {
    return false
  }
}
if (await skipValidation())
  Object.assign(env, { SKIP_ENV_VALIDATION: process.env.SKIP_ENV_VALIDATION ?? "true" })
const serial = SERIAL.filter((file) =>
  bunTargets.map(bare).some((path) => path === "." || file === path || file.startsWith(`${path}/`)),
)
// a shard names its files, which no ignore pattern drops, so the clock-ahead pass drops its exempt ones here
const left = ahead ? bunTargets.filter((path) => clockExempt(bare(path))) : []
const rest = bunTargets.filter((path) => !SERIAL.includes(bare(path)) && !left.includes(path))
if (left.length > 0)
  console.error(`test-sandbox: the clock-ahead pass leaves out ${left.join(", ")}`)

console.error(
  `test-sandbox: ${workers} workers with a ${Math.round(DEADLINE_MS / 1000)}s deadline, then ${serial.length} serial files`,
)
// a flag left alone in `rest` (every path named was serial) would have bun test run the whole suite
const named = (list: string[]) => list.some((path) => !path.startsWith("-"))
const parallel =
  named(rest) || (rest.length > 0 && !named(paths))
    ? await runPass(
        [
          `--preload=${preload}`,
          `--parallel=${workers}`,
          `--timeout=${TIMEOUT_MS}`,
          ...timings,
          ...(update ? ["--update-timings"] : []),
          ...SERIAL.map((file) => `--path-ignore-patterns=${file}`),
          ...(ahead ? CLOCK_EXEMPT.map(([pattern]) => `--path-ignore-patterns=${pattern}`) : []),
          ...rest,
        ],
        DEADLINE_MS,
      )
    : 0
if (interrupted) {
  console.error(`test-sandbox: parallel pass interrupted by ${interrupted}, serial pass skipped`)
  dropScratch()
  process.exit(128 + constants.signals[interrupted])
}
const alone = serial.length > 0 ? await runPass(serial) : 0
// the Python tests run in one step each, the same uv run test-skills uses, only when bun's pass finished without a failure, so a broken bun does not wait out the slow Docker and kill tests; each one that fails is named, and the summary reads them as skipped when bun failed
const pyFailed: string[] = []
const pyRan = parallel === 0 && alone === 0
if (pyRan) {
  for (const [label, file] of pyTargets) {
    console.error(`test-sandbox: running Python test ${label}`)
    const step = Bun.spawn(wrap(py(file)), {
      env: { ...env, PYTHONUNBUFFERED: "1" },
      stdout: "pipe",
      stderr: "inherit",
    })
    const out: Uint8Array[] = []
    for await (const chunk of step.stdout) out.push(chunk)
    if ((await step.exited) !== 0) {
      const fail = Buffer.concat(out)
        .toString()
        .split("\n")
        .find((line) => /^FAIL\b/.test(line))
      console.error(`test-sandbox: Python test ${label} failed${fail ? `: ${fail.trim()}` : ""}`)
      pyFailed.push(label)
    }
  }
}
// a run with no Python path printed a Python line, so the summary only names the count when there is one
const pyClause =
  pyTargets.length > 0
    ? `, ${pyTargets.length} ${pyTargets.length === 1 ? "Python test" : "Python tests"} ${
        !pyRan ? "skipped" : pyFailed.length ? "failed" : "passed"
      }`
    : ""
console.error(
  `test-sandbox: parallel pass ${parallel === 0 ? "passed" : `failed (exit ${parallel})`}, serial pass ${
    alone === 0 ? "passed" : `failed (exit ${alone})`
  }${pyClause}`,
)
dropScratch()
process.exit(parallel || alone || pyFailed.length)
