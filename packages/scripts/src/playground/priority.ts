import { appendFile, mkdir, readdir, rename } from "node:fs/promises"
import { basename, join } from "node:path"
import { parseArgs } from "node:util"

// playground priority: the one way to open a priority window, on the owner's or the dispatcher's word alone. While priority-<session>.json stands in the data folder, spawn.sh's --priority start passes the load and slots gates and focus (its priority*.json glob); off, or ops-tick's priority-lapse beat once LAPSE_HOURS pass, moves it aside as .lifted-<ts>, which the glob skips, and every on, off and lapse is a line in ops/priority.log.

// How long a window stands before ops-tick's priority-lapse beat lifts it, LIFECYCLE.md's beat line citing this name
export const LAPSE_HOURS = 2

export type Window = { by: string; reason: string; session: string; since: string }

export type PriorityDeps = { by: () => Promise<string>; data: string; now: () => Date }

const SESSION = /^[a-z0-9]+(-[a-z0-9]+)*$/
const FILE = /^priority-(.+)\.json$/
// priority-start.json is a job's own start file, kept by that job, so this command never writes, lifts or lapses it
const JOB = "start"

export const windowPath = (data: string, session: string) => join(data, `priority-${session}.json`)

const stamp = (at: Date) => `${at.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`

// The record this command wrote at path, undefined when none stands, null when another writer's file stands there
const readWindow = async (path: string): Promise<Window | null | undefined> => {
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  try {
    const w = (await file.json()) as Partial<Window>
    const ours =
      [w.by, w.reason, w.session, w.since].every((v) => typeof v === "string") &&
      w.session !== JOB &&
      basename(path) === `priority-${w.session}.json`
    return ours ? (w as Window) : null
  } catch {
    return null
  }
}

const logLine = async (data: string, line: string) => {
  await mkdir(join(data, "ops"), { recursive: true })
  await appendFile(join(data, "ops", "priority.log"), `${line}\n`)
}

const lift = (path: string, now: Date) => rename(path, `${path}.lifted-${stamp(now)}`)

const fail = (why: string) => {
  console.error(`playground: ${why}`)
  return 2
}

const notOurs = (session: string) =>
  fail(
    `priority-${session}.json stands and playground priority did not write it: its own writer lifts it`,
  )

// The session word and the trimmed reason, or the refusal
const parse = (verb: string, args: string[]): { reason: string; session: string } | string => {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      args,
      options: { reason: { type: "string" } },
    })
    const session = positionals[0] ?? ""
    const reason = (values.reason ?? "").trim()
    if (positionals.length !== 1 || !SESSION.test(session))
      return `priority ${verb} takes one session's name`
    if (session === JOB)
      return `priority-${JOB}.json is a job's own start file: that job writes and lifts it`
    if (!reason) return `priority ${verb} takes --reason "<why>"`
    return { reason, session }
  } catch (error) {
    return (error as Error).message
  }
}

const on = async (args: string[], deps: PriorityDeps): Promise<number> => {
  const parsed = parse("on", args)
  if (typeof parsed === "string") return fail(parsed)
  const { reason, session } = parsed
  const path = windowPath(deps.data, session)
  if ((await readWindow(path)) === null) return notOurs(session)
  const now = deps.now()
  const by = await deps.by()
  const window: Window = { by, reason, session, since: now.toISOString() }
  await Bun.write(path, `${JSON.stringify(window, null, 2)}\n`)
  await logLine(deps.data, `${window.since} on ${session} by ${by}: ${reason}`)
  const lapses = new Date(now.getTime() + LAPSE_HOURS * 3_600_000).toISOString()
  console.log(
    `priority: window open for ${session}: a --priority start passes the load and slots gates and focus until playground priority off ${session}, or its lapse at ${lapses}`,
  )
  return 0
}

const off = async (args: string[], deps: PriorityDeps): Promise<number> => {
  const parsed = parse("off", args)
  if (typeof parsed === "string") return fail(parsed)
  const { reason, session } = parsed
  const path = windowPath(deps.data, session)
  const window = await readWindow(path)
  if (window === null) return notOurs(session)
  if (window === undefined) {
    console.log(`priority: no window stands for ${session}`)
    return 0
  }
  const now = deps.now()
  const by = await deps.by()
  await lift(path, now)
  await logLine(deps.data, `${now.toISOString()} off ${session} by ${by}: ${reason}`)
  console.log(`priority: window lifted for ${session}`)
  return 0
}

// Every priority file in the data folder, with this command's record where it wrote one
const standingFiles = async (data: string) => {
  const names = (await readdir(data).catch(() => [] as string[])).filter((name) =>
    /^priority.*\.json$/.test(name),
  )
  return Promise.all(
    names.sort().map(async (name) => ({
      name,
      window: FILE.test(name) ? await readWindow(join(data, name)) : null,
    })),
  )
}

// ops-tick's priority-lapse beat: lifts each window this command opened once it has stood LAPSE_HOURS, with a line in ops/priority.log, and returns those lines for ops; another writer's file stands whatever its age.
export async function lapse(data: string, now: Date): Promise<string[]> {
  const lines: string[] = []
  for (const { name, window } of await standingFiles(data)) {
    if (!window || now.getTime() - Date.parse(window.since) < LAPSE_HOURS * 3_600_000) continue
    await lift(join(data, name), now)
    const line = `${now.toISOString()} lapsed ${window.session}: stood ${LAPSE_HOURS}h since ${window.since}, opened by ${window.by}: ${window.reason}`
    await logLine(data, line)
    lines.push(line)
  }
  return lines
}

export async function runPriority([verb, ...args]: string[], deps: PriorityDeps): Promise<number> {
  if (verb === "on") return on(args, deps)
  if (verb === "off") return off(args, deps)
  if (verb !== undefined) return fail(`no priority ${verb}; playground priority on, off, or bare`)
  const files = await standingFiles(deps.data)
  for (const { name, window } of files)
    console.log(
      window
        ? `priority: ${window.session} since ${window.since} by ${window.by}: ${window.reason}`
        : `priority: ${name} stands, written by another writer`,
    )
  if (files.length === 0) console.log("priority: none stands")
  return 0
}
