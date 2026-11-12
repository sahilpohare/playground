import { join } from "node:path"

import type { Schedule } from "@packages/config/schedule"
import { z } from "zod"

import { processStarts } from "@/lib/dashboard/peers"
import { dataDir } from "@/lib/sessions/paths"

// The ops jobs Ops runs as scripts in its own terminals, with no Claude session behind them: each writes a heartbeat, ops/<job>.json under Claude Code's config folder, every beat (atomically, through ops/beat.py), and the dashboard only reads it. The board lists the jobs so what keeps the app running shows even with no runner session up: every ops-*.json there is a job, so a new one shows with no change here, the ops-report job (ops-report.json) among them; report.json and alerts.log beside them are not.
const HEARTBEAT_FILES = "ops-*.json"
const JOB_NAME = /^ops-[\w-]+$/

// Ops' list of every job beside the heartbeats: one marked `disabled` is paused on purpose, so the sidebar leaves it out rather than calling it down, a deliberate pause not being a fault; and one listed but never beaten is down.
export const JOBS_FILE = "jobs.json"

// What each job core's registry holds does, in one line for its row's hover; any other job, an org's, shows its own jobs.json description, which its jobs setting gives, else NO_DESCRIPTION.
export const OPS_DOES: Record<string, string> = {
  "ops-awake": "Keeps this Mac awake on power and on battery",
  "ops-changelog": "Adds new merges to the Changelog",
  "ops-dashboard": "Keeps the Dashboard on its branch's latest head",
  "ops-dm-watch": "Passes your DM messages to Playground in Slack mode",
  "ops-ext-sync": "Syncs each extension with its private repo each night",
  "ops-flow": "Tells the leads when a run slot is held too long",
  "ops-herdr": "Keeps the herdr terminal servers up",
  "ops-machine": "Saves this Mac's load and memory",
  "ops-merge-train": "Merges ready pull requests together",
  "ops-restore": "Puts a lost main checkout back once its guards are gone",
  "ops-session-resume": "Tells each session to carry on once its usage limit resets",
  "ops-sweep": "Checks runners, probes, asks and heartbeats",
  "ops-tick": "Runs the timed checks and passes on what they find",
  "ops-unstick": "Finds stuck sessions no hook reported, and clears the usage-limit dialog",
  "ops-usage": "Reads Claude's 5-hour and week usage",
  "ops-wa": "Passes your WhatsApp messages to Playground and sends its replies",
  "ops-zai-usage": "Reads GLM's 5-hour and week usage",
}

// Each registry job's shown name, in plain words with no "ops" in it; its id shows on hover alone.
export const RUNNER_NAMES: Record<string, string> = {
  "ops-awake": "Keep Mac awake",
  "ops-changelog": "Changelog",
  "ops-dashboard": "Dashboard updates",
  "ops-dm-watch": "Your DM watcher",
  "ops-ext-sync": "Extensions sync",
  "ops-flow": "Run slot alarm",
  "ops-herdr": "Herdr servers",
  "ops-machine": "Machine readings",
  "ops-merge-train": "Merge train",
  "ops-restore": "Checkout restore",
  "ops-session-resume": "Usage-limit resumes",
  "ops-sweep": "Cleanup sweep",
  "ops-tick": "Timed checks",
  "ops-unstick": "Stuck session watcher",
  "ops-usage": "Claude usage readings",
  "ops-wa": "WhatsApp link",
  "ops-zai-usage": "GLM usage readings",
}

// The hover line of a job outside the registry whose own setting gives no description.
export const NO_DESCRIPTION = "No description in this job's settings"

// Pure: a job's shown name: RUNNER_NAMES's, else its id without the prefix, in words (ops-new-thing reads New thing), so a new job never shows "ops".
export const jobName = (job: string): string => {
  const named = RUNNER_NAMES[job]
  if (named) return named
  const words = job.replace(/^ops-/, "").replaceAll("-", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const opsDir = (): string => join(dataDir(), "ops")

const isoTime = z.iso.datetime({ offset: true })

export const heartbeatSchema = z.object({
  cycleSeconds: z.number().int().positive(),
  job: z.string().min(1),
  lastBeatAt: isoTime,
  lastResult: z.string(),
  pid: z.number().int().positive(),
  startedAt: isoTime,
})

export type Heartbeat = z.infer<typeof heartbeatSchema>

export type OpsStatus = "down" | "failing" | "running" | "waiting"

// One job as its row shows it: its plain name, whether it calls a model and which, what it does, its status, the reason when it is not running, when it last beat, whether jobs.json pauses it, its schedule from jobs.json, and a problem when that schedule and its heartbeat disagree.
export type OpsRow = {
  callsModel: boolean
  // the job's last refusal of its config, as its heartbeat's configRefused says, which Settings > Jobs' card shows beside the config; absent while it holds none
  configRefused?: string
  does: string | null
  job: string
  lastBeatAt: string | null
  model: string | null
  name: string
  paused: boolean
  problem: string | null
  reason: string | null
  schedule: Schedule | null
  status: OpsStatus
}

// A beat older than this many cycles means the job's loop has stopped.
export const STALE_CYCLES = 3

const EXITED = /^(supervisor exited|loop exited)/

// What jobs.json says a job calls, beside its pause mark.
export type JobCalls = { callsModel: boolean; model: string | null }

// Pure: a job's row from its heartbeat file's text (null when the file is missing) and whether its pid is still running (null when that could not be read). Down when the file is missing, does not read or names another job, the loop has exited, the pid is gone or the last beat is older than STALE_CYCLES cycles; Waiting when the last result starts `waiting: ` (a job with nothing to read yet, the reason after it); Failing when it is anything else but ok; else Running.
export function opsRowOf(
  job: string,
  text: string | null,
  alive: boolean | null,
  now: number,
  paused = false,
  calls: JobCalls = { callsModel: false, model: null },
  schedule: Schedule | null = null,
  description: string | null = null,
): OpsRow {
  const row = {
    ...calls,
    does: OPS_DOES[job] ?? description ?? NO_DESCRIPTION,
    job,
    name: jobName(job),
    paused,
    problem: null,
    schedule,
  }
  if (text === null)
    return { ...row, lastBeatAt: null, reason: "No heartbeat file", status: "down" }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ...row, lastBeatAt: null, reason: "Heartbeat file does not parse", status: "down" }
  }
  const parsed = heartbeatSchema.safeParse(json)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") || "file"
    return { ...row, lastBeatAt: null, reason: `Heartbeat ${field} is malformed`, status: "down" }
  }
  const beat = parsed.data
  // a file copied from another job's would read as this one
  if (beat.job !== job) {
    return { ...row, lastBeatAt: null, reason: `Heartbeat names ${beat.job}`, status: "down" }
  }
  const lastBeatAt = new Date(beat.lastBeatAt).toISOString()
  const refused = (json as { configRefused?: unknown }).configRefused
  const withRefused =
    typeof refused === "string" && refused ? { ...row, configRefused: refused } : row
  // the heartbeat's cycle is the Down clock, so a schedule saying another pace is named rather than left to drift
  const problem =
    schedule?.every && schedule.every !== beat.cycleSeconds
      ? `Its schedule says every ${schedule.every}s, its heartbeat every ${beat.cycleSeconds}s`
      : null
  const down = (reason: string): OpsRow => ({
    ...withRefused,
    lastBeatAt,
    problem,
    reason,
    status: "down",
  })
  if (EXITED.test(beat.lastResult)) return down(beat.lastResult)
  if (alive === false) return down(`Process ${beat.pid} is gone`)
  if (now - Date.parse(beat.lastBeatAt) > STALE_CYCLES * beat.cycleSeconds * 1000) {
    return down(`No beat for over ${STALE_CYCLES * beat.cycleSeconds}s`)
  }
  const waiting = /^waiting: (.+)/.exec(beat.lastResult)?.[1]
  if (waiting) return { ...withRefused, lastBeatAt, problem, reason: waiting, status: "waiting" }
  if (beat.lastResult !== "ok") {
    return {
      ...withRefused,
      lastBeatAt,
      problem,
      reason: beat.lastResult || "No result",
      status: "failing",
    }
  }
  return { ...withRefused, lastBeatAt, problem, reason: null, status: "running" }
}

const pidOf = (text: string | null): number | null => {
  try {
    const parsed = heartbeatSchema.safeParse(JSON.parse(text ?? ""))
    return parsed.success ? parsed.data.pid : null
  } catch {
    return null
  }
}

const jobEntry = z.object({
  callsModel: z.boolean().optional(),
  description: z.string().min(1).optional(),
  disabled: z.boolean().optional(),
  heartbeat: z.string().optional(),
  model: z.string().optional(),
  name: z.string(),
  schedule: z.unknown().optional(),
})

// A job's schedule as Ops writes it: every so many seconds, a 5-field cron, or always running.
const scheduleSchema = z.union([
  z.strictObject({ always: z.literal(true) }),
  z.strictObject({ every: z.number().int().positive() }),
  z.strictObject({ cron: z.string().min(1) }),
])

// Pure: what jobs.json lists, by heartbeat name: the jobs it pauses, the ones it expects to run, each job's callsModel mark with its model, its description and its schedule. Each entry is read on its own, so one off its shape drops alone, and a schedule off its shape drops while its job stays; a file that is missing or does not read lists nothing and pauses nothing.
export function jobsListed(text: string | null): {
  calls: Map<string, JobCalls>
  descriptions: Map<string, string>
  enabled: string[]
  paused: Set<string>
  schedules: Map<string, Schedule>
} {
  const calls = new Map<string, JobCalls>()
  const descriptions = new Map<string, string>()
  const enabled: string[] = []
  const paused = new Set<string>()
  const schedules = new Map<string, Schedule>()
  let jobs: unknown
  try {
    jobs = (JSON.parse(text ?? "") as { jobs?: unknown })?.jobs
  } catch {
    return { calls, descriptions, enabled, paused, schedules }
  }
  for (const entry of Array.isArray(jobs) ? jobs : []) {
    const parsed = jobEntry.safeParse(entry)
    if (!parsed.success) continue
    const job = parsed.data.heartbeat ?? parsed.data.name
    if (!JOB_NAME.test(job)) continue
    calls.set(job, {
      callsModel: parsed.data.callsModel === true,
      model: parsed.data.model ?? null,
    })
    if (parsed.data.description) descriptions.set(job, parsed.data.description)
    if (parsed.data.disabled === true) paused.add(job)
    else enabled.push(job)
    const schedule = scheduleSchema.safeParse(parsed.data.schedule)
    if (schedule.success) schedules.set(job, schedule.data)
  }
  return { calls, descriptions, enabled, paused, schedules }
}

const readText = async (path: string): Promise<string | null> => {
  const file = Bun.file(path)
  return (await file.exists()) ? file.text() : null
}

// The jobs whose heartbeat files sit in dir, A to Z; none when the folder is missing or cannot be read.
export async function opsJobs(dir = opsDir()): Promise<string[]> {
  const jobs: string[] = []
  try {
    for await (const file of new Bun.Glob(HEARTBEAT_FILES).scan({ cwd: dir, onlyFiles: true })) {
      const job = file.slice(0, -".json".length)
      if (JOB_NAME.test(job)) jobs.push(job)
    }
  } catch {
    return []
  }
  return jobs.toSorted()
}

// Every ops job's row, A to Z: each heartbeat file's, and each job jobs.json lists that has none, paused ones included, so the Scripts count and the Paused table hold them. A file that cannot be read reads as missing; whether each pid runs comes from the same ps read that proves a session live.
export async function readOps(dir = opsDir(), now = Date.now()): Promise<OpsRow[]> {
  const listed = jobsListed(await readText(join(dir, JOBS_FILE)).catch(() => null))
  const jobs = [
    ...new Set([...(await opsJobs(dir)), ...listed.enabled, ...listed.paused]),
  ].toSorted()
  const texts = await Promise.all(
    jobs.map((job) => readText(join(dir, `${job}.json`)).catch(() => null)),
  )
  const pids = texts.map(pidOf)
  // ps exits 1 when no pid it is given runs, which would read as ps failing; the API's own pid always runs, so a null here means ps itself could not be read
  const starts = await processStarts([
    ...pids.filter((pid): pid is number => pid !== null),
    process.pid,
  ])
  return jobs.map((job, i) => {
    const pid = pids[i] ?? null
    const alive = pid === null || starts === null ? null : starts.has(pid)
    return opsRowOf(
      job,
      texts[i] ?? null,
      alive,
      now,
      listed.paused.has(job),
      listed.calls.get(job),
      listed.schedules.get(job) ?? null,
      listed.descriptions.get(job) ?? null,
    )
  })
}
