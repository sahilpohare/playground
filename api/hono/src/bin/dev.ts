import "@packages/env/aliases"
import { existsSync } from "node:fs"
import { join } from "node:path"

import {
  DASHBOARD_RULES,
  dropFixture,
  fixtureDir,
  markLaunched,
  writeFixture,
} from "@/lib/dashboard/fixture"
import {
  apiSettings,
  type ApiSettings,
  checkoutOf,
  dashboardAliasPairs,
  dashboardEnv,
  devEnv,
  envGaps,
  fixtureStackEnv,
  isDryRun,
  mainCheckoutOf,
  preflight,
  setNextDevAside,
  type SettingsRead,
  syncAliases,
} from "@/lib/dev/launch"
import {
  FALLBACK_PORT,
  fallbackDir,
  portlessDir,
  prefixOf,
  proxyDown,
  proxySetup,
  serviceDir,
  shareCa,
  startFallback,
} from "@/lib/dev/proxy"
import {
  claimRecord,
  clearRecord,
  pgidOf,
  readRecord,
  recordHeld,
  recordLiveGroups,
  recordPath,
  startOf,
} from "@/lib/dev/stop"
import { discard, trashRoots } from "@/lib/trash"

// `bun run dev` runs this with --no-env-file, so it sees the shell's environment as turbo did before it; the apps still read .env themselves. Arguments pass through to `turbo run dev` (`bun run dev --ui stream`). DEV_TURBO_BIN lets a test stand in for turbo's dev run.
const ROOT = join(import.meta.dir, "../../../..")
const TURBO = join(ROOT, "node_modules/.bin/turbo")
// The checkout whose .env files the checks read, this one unless a test names a scratch one of its own; the modules that read them always come from this checkout's build.
const ENV_ROOT = process.env.DEV_ENV_ROOT || ROOT
const ENV_DIST = join(ROOT, "packages/env/dist")

const head = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
  cwd: ROOT,
  stderr: "ignore",
  stdin: "ignore",
})
// `bun run dev:stop` proves a recorded launcher by its working directory, so it runs from the checkout's root however it was started.
process.chdir(ROOT)
// --serve runs the apps' serve task, the production build the live dashboard's supervisor made (PLAYGROUND_BUILD), where dev runs their dev servers; every check before it is the same
const serving = process.argv.includes("--serve")
const args = process.argv.slice(2).filter((arg) => arg !== "--serve")
const { env, notes } = devEnv(process.env, head.exitCode === 0 ? head.stdout.toString().trim() : "")
for (const note of notes) console.error(`dev: ${note}`)

// The API's settings as read, kept for the fixture's folder, which the API takes from .env as well as the shell.
let settings: ApiSettings = {}

// @packages/env's loader is what reads the API's settings, so it is built first, once the branch has passed.
const readSettings = (): SettingsRead => {
  if (!existsSync(TURBO)) {
    return {
      error: "node_modules/.bin/turbo is missing; run `bun install` first",
      ok: false,
    } as const
  }
  const build = Bun.spawnSync([TURBO, "run", "build", "--filter=@packages/env"], {
    cwd: ROOT,
    env,
    stdin: "ignore",
  })
  if (build.exitCode !== 0) {
    process.stderr.write(build.stdout)
    process.stderr.write(build.stderr)
    return { error: "building @packages/env failed", ok: false } as const
  }
  // The keys the schemas require, named here rather than left to fail in check-types or the web tests far from the cause.
  const gaps = envGaps(ENV_ROOT, env, join(ENV_DIST, "gaps.mjs"))
  if (!gaps.ok) return gaps
  if (gaps.missing.length > 0 || gaps.empty.length > 0) {
    return { error: gaps.refusal, ok: false } as const
  }
  const read = apiSettings(ENV_ROOT, env, join(ENV_DIST, "load-dotenv.mjs"))
  if (read.ok) settings = read.settings
  return read
}

// The stack's record, which `bun run dev:stop` reads to end it once the session that started it has gone. It is claimed before the checks, so a second start in the checkout refuses while this one runs, and cleared on every way out that leaves no recorded group holding a checkout process, which the next start or dev:stop then ends or names; a dry run starts no stack and leaves any record alone. A fixture stack's scratch copy goes with it, so its next start begins from the fixture again.
const record = recordPath(ROOT)
const dry = isDryRun(args)
const pgid = dry ? null : pgidOf(process.pid)
const started = dry ? null : startOf(process.pid)
if (pgid && started) {
  const claim = claimRecord(record, ROOT, { pgid, pid: process.pid, started })
  if (!claim.ok) {
    console.error(`dev: refusing to start: ${claim.reason}`)
    process.exit(1)
  }
  if (claim.warning) console.error(`dev: ${claim.warning}`)
}
let wrote: string | null = null
let aliasPairs: [string, string][] = []
let aliasFailed = ""
let reconcile: ReturnType<typeof setInterval> | null = null
function leave(code: number): never {
  if (reconcile) clearInterval(reconcile)
  if (wrote) {
    try {
      dropFixture(wrote, trashRoots(ROOT))
    } catch (error) {
      console.error(`dev: ${error instanceof Error ? error.message : error}`)
    }
  }
  // a task that outlives turbo stays on record, so dev:stop and the next start can still end or name it
  const held = pgid ? readRecord(record) : null
  const keeps = held?.pid === process.pid && recordHeld(held, ROOT)
  if (pgid && !keeps) clearRecord(record, process.pid)
  process.exit(code)
}
if (!dry) {
  const checkout = checkoutOf(ROOT)
  const checked = await preflight(checkout, readSettings, { root: ROOT })
  if (!checked.ok) {
    console.error(`dev: refusing to start: ${checked.refusal}`)
    leave(1)
  }
  try {
    const aside = setNextDevAside(ROOT, { ...checkout, serving })
    if (aside)
      console.error(`dev: the web's dev cache moved aside to ${aside}, so next dev starts fresh`)
  } catch (error) {
    console.error(`dev: refusing to start: ${error instanceof Error ? error.message : error}`)
    leave(1)
  }
  const portlessOwn = serviceDir(env.PORTLESS_STATE_DIR || portlessDir())
  const down = await proxyDown(env, portlessOwn)
  if (down !== null) {
    const state = fallbackDir(portlessOwn)
    const shared = shareCa(portlessOwn, state, (path) =>
      discard(
        path,
        { reason: "the 1355 proxy's leaves of a CA it replaced", session: "dev" },
        trashRoots(ROOT),
      ),
    )
    const failed = await startFallback(join(ROOT, "node_modules/.bin/portless"), {
      ...env,
      PORTLESS_STATE_DIR: state,
    })
    if (failed) {
      console.error(`dev: refusing to start: ${proxySetup(down)} (on ${FALLBACK_PORT}: ${failed})`)
      leave(1)
    }
    env.PORTLESS_PORT = String(FALLBACK_PORT)
    // process.env too, so this launcher's own route and alias writes reach the 1355 proxy's folder
    env.PORTLESS_STATE_DIR = process.env.PORTLESS_STATE_DIR = state
    console.error(
      `dev: portless's proxy is not running on port ${down}, which needs your Mac's password, so it runs on ${FALLBACK_PORT}, which needs none; Settings' Things to fix sets up the web address on ${down}${shared ? "" : `, and until then your browser warns that the certificate on ${FALLBACK_PORT} is not trusted, once on the web's address and once on the API's`}`,
    )
  }
  console.error(`dev: database ${checked.proof}`)
  if (checked.warning) console.error(`dev: ${checked.warning}`)
  // The live dashboard takes the bare names beside its own: the reconcile tick below points them at the ports its stack bound.
  const dashboard = dashboardEnv(checkout)
  if (Object.keys(dashboard).length > 0 && checkout.branch) {
    Object.assign(env, dashboard)
    aliasPairs = dashboardAliasPairs(prefixOf(checkout.branch) ?? "")
  }
  if (checked.dashboard.kind === "hosted") {
    console.error(
      "dev: the hosted build (PLAYGROUND_HOSTED): the API mounts only sign-in, health and Yard, and reads no machine",
    )
  } else if (checked.dashboard.kind === "fixture") {
    console.error(`dev: dashboard source matched ${DASHBOARD_RULES[checked.dashboard.rule]}`)
    const scratch = fixtureDir({ PLAYGROUND_FIXTURE_DIR: settings.PLAYGROUND_FIXTURE_DIR })
    try {
      writeFixture(checked.dashboard.fixture, scratch, trashRoots(ROOT))
      markLaunched(scratch, process.pid, started)
      wrote = scratch
    } catch (error) {
      console.error(`dev: refusing to start: ${error instanceof Error ? error.message : error}`)
      leave(1)
    }
    console.error(
      `dev: dashboard reads the fixture written to ${scratch}, test data: no ~/.claude; its writes land there and go when the stack stops, Inbox files among them, so a card an earlier start kept in the database shows its file as missing`,
    )
  } else {
    console.error(`dev: dashboard source matched ${DASHBOARD_RULES[checked.dashboard.rule]}`)
    console.error(
      "dev: dashboard reads this machine's own sessions from herdr, every real one included: take no screenshots of this stack",
    )
    // The live dashboard and a person's own clone bring the herdr servers up when they are down, so restarting the app alone brings the factory back; a test stack with PLAYGROUND_LIVE_READS never does. It runs the main checkout's job, never this checkout's: the live dashboard runs the latest head of the branch its main checkout sits on, so there the pin and config change only once they reach that checkout; a person's own clone is its own main checkout, on whatever branch it holds. A failure is named and the stack starts anyway.
    const main = mainCheckoutOf(ROOT)
    if (main && (checked.dashboard.rule === "live-branch" || checked.dashboard.rule === "own")) {
      const herdr = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          join(main, "packages/scripts/src/ops-herdr/cli.ts"),
          "start",
        ],
        { cwd: main, stdin: "ignore", timeout: 30_000 },
      )
      const said = (herdr.stdout.toString() + herdr.stderr.toString()).trim()
      console.error(
        `dev: ${herdr.exitedDueToTimeout ? `ops-herdr start did not finish in 30s ${said}` : said}`.trim(),
      )
    }
  }
}

const turbo = Bun.spawn(
  [process.env.DEV_TURBO_BIN || TURBO, "run", serving ? "serve" : "dev", ...args],
  {
    cwd: ROOT,
    env: wrote ? fixtureStackEnv(env, wrote) : env,
    stdio: ["inherit", "inherit", "inherit"],
  },
)
// The launcher re-records the stack's task groups every few seconds while it runs, by parentage alone: a launcher killed with no stop leaves them behind, and dev:stop and the next start's claim end or name them by the record. The stack's first seconds may hold no task yet, so the tick rewrites as tasks appear.
if (!dry) {
  reconcile = setInterval(() => {
    try {
      recordLiveGroups(record, ROOT, process.pid)
    } catch {
      // the next tick retries
    }
    if (aliasPairs.length === 0) return
    try {
      const synced = syncAliases(aliasPairs)
      for (const line of synced.wrote) console.error(`dev: portless alias ${line}`)
      const failed = synced.failed.join("; ")
      if (failed && failed !== aliasFailed) console.error(`dev: portless alias failed: ${failed}`)
      aliasFailed = failed
    } catch (error) {
      console.error(`dev: portless alias failed: ${error instanceof Error ? error.message : error}`)
    }
  }, 2_000)
}
// Ctrl+C reaches turbo from the terminal's process group, so a SIGINT sent to this process alone is ignored, as turbo's own wrapper ignores one. SIGHUP and SIGTERM end the stack: both go on as SIGTERM, since turbo's node wrapper dies on SIGHUP without passing it on and would orphan the native turbo and its tasks.
process.on("SIGINT", () => {})
for (const signal of ["SIGHUP", "SIGTERM"] as const) process.on(signal, () => turbo.kill("SIGTERM"))

leave(await turbo.exited)
