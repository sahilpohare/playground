import { realpathSync } from "node:fs"
import { appendFile, mkdir } from "node:fs/promises"
import { constants } from "node:os"
import { dirname, join, resolve } from "node:path"

import { dataDirOf } from "@packages/env/data-dir"

import {
  beat,
  type Beat,
  type Context,
  cycle,
  CYCLE_SECONDS,
  resultOf,
  runner,
} from "../ops-tick/tick"
import { dashboardCheckout } from "../playground/probe"

// The ops jobs that were runner sessions: a held command (hold) or a few timed beats (scheduled), each with its own heartbeat, so up.py starts it and the Dashboard shows its row.
export const opsDir = () => join(dataDirOf(process.env), "ops")
export const REPO = join(import.meta.dir, "..", "..", "..", "..")

const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

// The data folder a ported engine writes under: the one --data names, else the real one only when it runs from the live dashboard's checkout; from any other checkout with no --data it is refused, so a hand run in a worktree never writes the live folder.
export const engineDataOf = (
  argv: string[],
  repo = REPO,
  env: Record<string, string | undefined> = process.env,
): { data: string } | { refusal: string } => {
  const at = argv.indexOf("--data")
  if (at !== -1)
    return argv[at + 1] ? { data: resolve(argv[at + 1]!) } : { refusal: "--data needs a folder" }
  const live = dashboardCheckout(repo)
  if (live && real(live) === real(repo)) return { data: dataDirOf(env) }
  return {
    refusal: `${repo} is not the live dashboard's checkout, so this run writes nowhere until --data <folder> names where`,
  }
}

// engineDataOf for a job's own command line: its data folder, or the refusal on stderr and exit 2.
export const engineData = (job: string, argv = process.argv): string => {
  const found = engineDataOf(argv)
  if ("data" in found) return found.data
  console.error(`${job}: ${found.refusal}`)
  process.exit(2)
}

// A script's stdout and stderr together, fed stdin when given; one past its time is killed by its own handle, its exit code non-zero.
export const run: Context["run"] = async (argv, timeoutMs = 120_000, stdin) => {
  const proc = Bun.spawn(argv, {
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    timeout: timeoutMs,
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out: out + err }
}

// One line through the ops relay: notify.sh queues it under the job's name for the seat or session named, and the relay sends it with SendMessage; notify.sh adds the `ops-` itself, cuts the line at 400 characters unless whole, and logs only its length when private.
export const sendAs =
  (job: string, whole = false, quiet = false): Context["send"] =>
  async (to, text) => {
    const name = job.replace(/^ops-/, "")
    const proc = Bun.spawn(["bash", join(REPO, "scripts", "ops", "notify.sh"), name, text], {
      env: {
        ...process.env,
        NOTIFY_TO: to,
        ...(whole && { NOTIFY_WHOLE: "1" }),
        ...(quiet && { NOTIFY_PRIVATE: "1" }),
      },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "ignore",
      timeout: 30_000,
    })
    const err = await new Response(proc.stderr).text()
    if ((await proc.exited) !== 0)
      throw new Error(`notify.sh to ${to}: ${err.trim().slice(0, 200)}`)
    return true
  }

// Holds one long-lived command as its child, beating ok while it lives; its exit, or a signal that stops it by its handle, is the beat's last word (run.sh's) and the wrapper's exit code, so up.py and ops-sweep see a Down row.
export async function hold(
  job: string,
  argv: string[],
  ops = opsDir(),
  beatMs = CYCLE_SECONDS * 1000,
): Promise<number> {
  const path = join(ops, `${job}.json`)
  const startedAt = new Date()
  let last = Promise.resolve()
  const write = (result: string) => {
    last = last.then(() => beat(path, startedAt, new Date(), result, job)).catch(console.error)
    return last
  }
  const child = Bun.spawn(argv, { stderr: "inherit", stdin: "ignore", stdout: "inherit" })
  let signal: "SIGHUP" | "SIGINT" | "SIGTERM" | undefined
  const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const
  const stops = signals.map((s) => () => {
    signal ??= s
    child.kill(s)
  })
  signals.forEach((s, i) => process.on(s, stops[i]!))
  void write("ok")
  const timer = setInterval(() => void write("ok"), beatMs)
  const code = await child.exited
  clearInterval(timer)
  signals.forEach((s, i) => process.off(s, stops[i]!))
  await write(signal ? `loop exited: ${signal.slice(3)}` : `loop exited ${code}`)
  return signal ? 128 + constants.signals[signal] : code
}

// Runs the beats at their crons, as ops-tick runs its own, under the job's own heartbeat.
export function scheduled(job: string, beats: Beat[], ops = opsDir()) {
  const path = join(ops, `${job}.json`)
  const startedAt = new Date()
  const state = runner()
  const send = sendAs(job)
  const pulse = () =>
    beat(path, startedAt, new Date(), resultOf(state), job).catch((err) => console.error(err))
  void pulse()
  setInterval(
    () => void cycle({ now: new Date(), ops, repo: REPO, run, send }, state, beats),
    20_000,
  )
  setInterval(() => void pulse(), CYCLE_SECONDS * 1000)
}

// sysctl's `{ 1m 5m 15m }` load line, then the memory pressure level (4 is critical).
export const gateOf = (out: string) => {
  const [loads = "", pressure = ""] = out.split("\n")
  return {
    load5: Number(loads.replace(/[{}]/g, "").trim().split(/\s+/)[1]),
    pressure: Number(pressure.trim()),
  }
}

// The run's first error line, then the end of the log's last 5 lines, inside notify.sh's 400-character cut once the label leads it.
export const failureOf = (out: string, log: string) => {
  const tail = log.trimEnd().split("\n").slice(-5).join(" | ")
  const error = out
    .split("\n")
    .find((line) => /error|invalid/i.test(line))
    ?.trim()
    .slice(0, 150)
  if (!error || tail.includes(error)) return tail.slice(-340)
  return `${error} | ${tail.slice(-(337 - error.length))}`
}

// A dashboard script run as the old cron ran it: skipped with a line to ops under load, skipped quietly while busy matches a running command, its output appended to the log, and a failure sent to ops with its first error line and the log's last 5 lines.
export const dashboardRun =
  (label: string, args: string[], log: string, busy?: RegExp) => async (ctx: Context) => {
    const { load5, pressure } = gateOf(
      (await ctx.run(["sysctl", "-n", "vm.loadavg", "kern.memorystatus_vm_pressure_level"])).out,
    )
    if (load5 > 12 || pressure === 4) {
      await ctx.send("ops", `${label} skipped: load5 ${load5}, pressure ${pressure}`)
      return
    }
    if (busy?.test((await ctx.run(["ps", "-xo", "command"])).out)) return
    const { code, out } = await ctx.run(
      [process.execPath, "run", "--cwd", ctx.repo, ...args],
      600_000,
    )
    await mkdir(dirname(log), { recursive: true })
    await appendFile(log, out)
    if (code === 0) return
    await ctx.send(
      "ops",
      `${label} failed (exit ${code}): ${failureOf(out, await Bun.file(log).text())}`,
    )
    throw new Error(`exit ${code}`)
  }
