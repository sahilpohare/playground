import { loadavg } from "node:os"
import { join } from "node:path"

import { configDirOf, dataDirOf } from "@packages/env/data-dir"

import { ghSkipped } from "../gh-read"
import { mainCheckout } from "../main-checkout"
import { herdrDir, serverEnv } from "../ops-herdr/herdr"
import { herdrPath } from "../ops-herdr/pin"
import { loadSessionNames } from "../playground/setting"
import { beat, type Context, forecast, pass, type Run } from "./sweep"

const INTERVAL = Number(process.env.SWEEP_INTERVAL || 300)
const cfg = configDirOf()
const data = dataDirOf(process.env)
const ops = join(data, "ops")
loadSessionNames()
const main = mainCheckout()

// stdout and stderr apart, in the folder and env given; one past its time is killed by its own handle, one that cannot start reads as exit 127, and gh is skipped while ghSkipped names why, so a broken gh is never flooded.
const run: Run = async (argv, { cwd, env, timeoutMs = 120_000 } = {}) => {
  const skipped = argv[0] === "gh" ? ghSkipped() : null
  if (skipped) return { code: 1, err: skipped, out: "" }
  try {
    const proc = Bun.spawn(argv, {
      cwd,
      env,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
      timeout: timeoutMs,
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code: await proc.exited, err, out }
  } catch (err) {
    return { code: 127, err: err instanceof Error ? err.message : String(err), out: "" }
  }
}

const ctx: Context = {
  cfg,
  data,
  dashboard: join(main, ".claude", "worktrees", "desk"),
  herdr: async (server, args) =>
    (
      await run([process.env.HERDR_BIN_PATH || herdrPath(process.env), ...args], {
        env: serverEnv(process.env, herdrDir(process.env), server),
        timeoutMs: 30_000,
      })
    ).out,
  load: () => loadavg()[0] ?? 0,
  main,
  now: () => Date.now(),
  ops,
  repo: join(import.meta.dir, "..", "..", "..", ".."),
  run,
}

const args = process.argv.slice(2)
if (args.length === 1 && args[0] === "--forecast") {
  console.log(JSON.stringify(await forecast(ctx)))
  process.exit(0)
}

// Each word given is a finding known at start, active from the first pass and never told (ops-sweep's job passes no-headroom).
const known = new Set(args)
const startedAt = new Date()
let active = new Set(known)
let lastResult = "ok"
let sweeping = false

const pulse = (result: string) =>
  beat(join(ops, "ops-sweep.json"), startedAt, new Date(), INTERVAL, result).catch((err) =>
    console.error(err),
  )

const sweep = async () => {
  if (sweeping) return
  sweeping = true
  const swept = await pass(ctx, active, known).finally(() => {
    sweeping = false
  })
  active = swept.active
  lastResult = swept.result
  await pulse(lastResult)
}

// The beat runs on its own timer, so a pass that hangs still beats, as failing, and never runs beside the next.
void sweep()
setInterval(() => {
  void pulse(sweeping ? "still sweeping from the last pass" : lastResult)
  void sweep()
}, INTERVAL * 1000)
