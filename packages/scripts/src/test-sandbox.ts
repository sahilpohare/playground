// The suite's runner: runs `bun test` in sandbox.ts's sandbox, so no test can start a real session or read the real config by accident (a self-removal test once started two). The env is set before bun starts, since os.homedir() and the spawn PATH lookup read the boot environment, not a later mutation. The folder goes when the run does.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { availableParallelism, constants } from "node:os"
import { join, relative } from "node:path"

import { removeScratch } from "@packages/safe-delete"

import { CLOCK_EXEMPT, clockExempt } from "./clock-exempt"
import { sandbox } from "./sandbox"
import { prebuildTests } from "./verify/prebuild"

const TIMINGS = "tests/timings.json"

// Files that run one at a time after the parallel pass: dev.test.ts and launch.test.ts move packages/env/dist/gaps.mjs aside, and dev.test.ts's launcher rebuilds @packages/env, whose dist the other workers import; check-types-env.test.ts runs the root check-types script in the checkout, whose env values hash build keys other workers' dist was not built under, so a worker beside it would read a dist rebuilt mid-pass; this pass runs its files in one process, which loads a shared helper once, so no spawn*.test.ts or ops/run-slot*.test.ts file joins it, since each needs its fake afresh
const SERIAL = [
  "tests/api/hono/src/bin/dev.test.ts",
  "tests/api/hono/src/lib/dev/launch.test.ts",
  "tests/check-types-env.test.ts",
]

const { env, scratch } = sandbox()
// a git hook (pre-commit runs tests) exports GIT_DIR and GIT_INDEX_FILE, which turn a test's scratch git init or commit onto the real repository: one set its core.bare (3 Nov); a test that needs a GIT_ variable sets it on its own git call
for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name]
// a worktree .env set for a hosted stack would turn the hosted build's gates on in every test, and bun test fills only a key its env leaves unset, so both flags go in empty, which the env schemas read as unset; a test that wants the hosted build sets the flag itself
Object.assign(env, { NEXT_PUBLIC_PLAYGROUND_HOSTED: "", PLAYGROUND_HOSTED: "" })
const dropScratch = () => {
  const refused = removeScratch(scratch)
  if (refused) console.error(`test-sandbox: ${refused}`)
}
// CI's clock-ahead pass: with CLOCK_AHEAD_DAYS set, every test file reads a clock that many days on, so a test that mixes a fixed clock with the real one fails on its own PR rather than on the day the real clock reaches it
const ahead = Boolean(process.env.CLOCK_AHEAD_DAYS)
const clock = ahead ? [`--preload=${join(import.meta.dir, "../../../tests/clock-ahead.ts")}`] : []
const run = (argv: string[]) =>
  Bun.spawnSync(["bun", "test", ...clock, ...argv], {
    env,
    stdio: ["inherit", "inherit", "inherit"],
  }).exitCode ?? 1

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
const runParallel = async (argv: string[]) => {
  const child = Bun.spawn(["bun", "test", `--preload=${preload}`, ...clock, ...argv], {
    detached: true,
    env,
    stdio: ["inherit", "inherit", "inherit"],
  })
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
  const late = new Promise<"late">((done) => (timer = setTimeout(() => done("late"), DEADLINE_MS)))
  const code = await Promise.race([child.exited, late])
  clearTimeout(timer)
  process.off("SIGINT", forward)
  process.off("SIGTERM", forward)
  if (code !== "late") return code
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
const args = process.argv.slice(2)
const paths = args.length > 0 ? args : ["tests"]
// compared without a leading ./ or a trailing /, and passed to bun as given, since bun reads ./name as a path and name as a filter
const bare = (path: string) => path.replace(/^(\.\/)+/, "").replace(/\/+$/, "") || "."
// bun reads a path it cannot find as a name filter that matches nothing, so the run would pass on the other files: a test path names a file or the run stops
const missing = args.filter((arg) => /\.test\.tsx?$/.test(arg) && !existsSync(bare(arg)))
if (missing.length > 0) {
  console.error(`test-sandbox: no test file at ${missing.join(", ")}; check the path and run again`)
  dropScratch()
  process.exit(1)
}
// a worktree whose node_modules came from a clone has no dist, and a test importing an unbuilt package fails on a missing module, which hides the failure it reproduces, so the packages these files import are built first
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
  paths.map(bare).some((path) => path === "." || file === path || file.startsWith(`${path}/`)),
)
// a shard names its files, which no ignore pattern drops, so the clock-ahead pass drops its exempt ones here
const left = ahead ? paths.filter((path) => clockExempt(bare(path))) : []
const rest = paths.filter((path) => !SERIAL.includes(bare(path)) && !left.includes(path))
if (left.length > 0)
  console.error(`test-sandbox: the clock-ahead pass leaves out ${left.join(", ")}`)

console.error(
  `test-sandbox: ${workers} workers with a ${Math.round(DEADLINE_MS / 1000)}s deadline, then ${serial.length} serial files`,
)
const parallel =
  rest.length > 0
    ? await runParallel([
        `--parallel=${workers}`,
        `--timeout=${TIMEOUT_MS}`,
        ...timings,
        ...(update ? ["--update-timings"] : []),
        ...SERIAL.map((file) => `--path-ignore-patterns=${file}`),
        ...(ahead ? CLOCK_EXEMPT.map(([pattern]) => `--path-ignore-patterns=${pattern}`) : []),
        ...rest,
      ])
    : 0
if (interrupted) {
  console.error(`test-sandbox: parallel pass interrupted by ${interrupted}, serial pass skipped`)
  dropScratch()
  process.exit(128 + constants.signals[interrupted])
}
const alone = serial.length > 0 ? run(serial) : 0
console.error(
  `test-sandbox: parallel pass ${parallel === 0 ? "passed" : `failed (exit ${parallel})`}, serial pass ${alone === 0 ? "passed" : `failed (exit ${alone})`}`,
)
dropScratch()
process.exit(parallel || alone)
