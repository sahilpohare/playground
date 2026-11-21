// a factory session that gets stuck tells its manager at once, so no stuck session goes unseen. The session-state hook calls alertFor() the moment it writes a stuck or failed record, ops-session-resume calls it for a session working with no tool call, and ops-unstick asks `manager <name> [transcript]` for the backstop it reads off a screen. It imports by relative source path alone, as the hooks do, so it loads from the main checkout with no build.
import { appendFile, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"

import {
  dispatcherOf,
  isManagerKind,
  managerOf,
  placedKindOf,
  ROSTER_ROLE_OF_KIND,
} from "../../config/src/kinds"
import { configDirOf, dataDir } from "../../env/src/data-dir"

type Environment = Record<string, string | undefined>
type Agent = {
  kind?: unknown
  name?: unknown
  reportsTo?: unknown
  task?: unknown
  worker?: unknown
}

// The outbox file the relay sends from (ADR 0010), ops-<job>.jsonl.
export const ALERT_JOB = "stuck-alert"

// spawn.sh's first prompt names who a session reports to.
const REPORTS_TO = /Report to ([a-z0-9-]+) with SendMessage/

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 256 * 1024
const CLIP = 300

const clip = (text: string, size = CLIP): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > size ? `${flat.slice(0, size - 1)}…` : flat
}

// Pure: the session a stuck session's alert goes to, or null when none does (a session outside the factory, or a dispatcher's own, which the owner may be answering). A checker's goes to its worker's lead, by kind; a worker's, runner's or probe's to the session its brief reports to, else its kind's manager; an orchestrator's (another manager kind, the Assistant's) to the session its roster row reports to; a manager's own to the primary dispatcher, as is any whose manager is not live.
export function managerFor(
  name: string,
  agents: Agent[],
  briefReportsTo: string | undefined,
  live: ReadonlySet<string>,
): string | null {
  const agent = agents.find((entry) => entry?.name === name)
  const kind = placedKindOf(name, agent?.kind)
  if (!kind || kind === "dispatcher") return null
  const primary = dispatcherOf(agents, 1)
  let to: string
  if (isManagerKind(kind)) to = primary
  else if (ROSTER_ROLE_OF_KIND[kind] === "manager")
    to = typeof agent?.reportsTo === "string" && agent.reportsTo ? agent.reportsTo : primary
  else if (kind === "reviewer" || kind === "tester") {
    const worker = typeof agent?.worker === "string" ? agent.worker : ""
    const workerKind = placedKindOf(worker, agents.find((entry) => entry?.name === worker)?.kind)
    to = managerOf(agents, workerKind === "ops" ? "ops" : "builder")
  } else
    to =
      briefReportsTo ??
      managerOf(agents, kind === "runner" ? "ops" : kind === "researcher" ? "planner" : "builder")
  return to !== name && live.has(to) ? to : primary
}

// A tool input's fields that say how a call runs, not what it does.
const META = new Set(["description", "run_in_background", "timeout"])

// Pure: what a tool call does, whole: its command, file or URL alone when nothing but META sits beside it, else its whole input as JSON, so no field the manager has not read rides along.
export function callOf(input: unknown): string {
  const tool = (input ?? {}) as Record<string, unknown>
  const field = ["command", "file_path", "url"].find((name) => typeof tool[name] === "string")
  const alone = field && Object.keys(tool).every((name) => name === field || META.has(name))
  return alone ? (tool[field] as string) : JSON.stringify(tool)
}

// Pure: the picker's allow and deny lines for one call.
export const pickerLines = (name: string, key: string): string =>
  `Allow it if it is needed: playground picker ${name} allow ${key}. Else deny it with a simpler shape: playground picker ${name} deny ${key} "<the simpler shape>".`

// Pure: the key a permission alert gives its call, so `playground picker` answers only the call its manager read: the first 8 hex of the call's sha256.
export const callKey = (input: unknown): string =>
  new Bun.CryptoHasher("sha256").update(callOf(input)).digest("hex").slice(0, 8)

// Pure: what a stuck session waits on, from its hook input: a command, a file or a URL whole, else a picker's questions, a plan, a notice's words or an error, on one line.
export function detailOf(input: Record<string, unknown>): string {
  const tool = (input.tool_input ?? {}) as Record<string, unknown>
  const questions = Array.isArray(tool.questions)
    ? tool.questions
        .map((q: { question?: unknown }) => (typeof q?.question === "string" ? q.question : ""))
        .filter(Boolean)
        .join(" / ")
    : ""
  const call = [tool.command, tool.file_path, tool.url].find(
    (value) => typeof value === "string" && value.trim(),
  )
  if (typeof call === "string") return call.trim()
  const found = [questions, tool.plan, input.message].find(
    (value) => typeof value === "string" && value.trim(),
  )
  return clip(typeof found === "string" ? found : "")
}

// Pure: the newest words the session wrote, its last assistant text in the transcript's tail.
export function lastWords(transcript: string): string {
  for (const line of transcript.split("\n").reverse()) {
    try {
      const entry = JSON.parse(line) as { message?: { content?: unknown }; type?: unknown }
      if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue
      const text = entry.message.content
        .map((part: { text?: unknown; type?: unknown }) =>
          part?.type === "text" && typeof part.text === "string" ? part.text : "",
        )
        .join(" ")
      if (text.trim()) return clip(text)
    } catch {}
  }
  return ""
}

export type Stuck = {
  detail: string
  key?: string
  last: string
  name: string
  reason: string
  state: string
  task: string
  tool?: string
}

// Pure: the alert's one line, the session first, then what it waits on, its task, its last words and the way to answer.
export function alertText(stuck: Stuck): string {
  const { detail, key, last, name, reason, state, task, tool } = stuck
  const what =
    state === "failed"
      ? `${name} stopped on an error (${reason})`
      : state === "quiet"
        ? `${name} has made no tool call for ${reason}`
        : `${name} is stuck on a ${reason} prompt${tool ? ` (${tool})` : ""}`
  const answer = key ? pickerLines(name, key) : "Resolve it; if you cannot, tell dispatcher."
  const rest = [
    task ? `Task: ${clip(task, 120)}.` : "",
    last ? `Its last message: "${last}"` : "",
    answer,
  ]
    .filter(Boolean)
    .join(" ")
  return key && detail
    ? `${what}:\n${detail}\n${rest}`
    : `${what}${detail ? `: ${detail.replace(/[.!?]$/, "")}.` : "."} ${rest}`
}

const readSlice = (path: string, from: "head" | "tail"): Promise<string> => {
  const file = Bun.file(path)
  return (
    from === "head" ? file.slice(0, HEAD_BYTES) : file.slice(Math.max(0, file.size - TAIL_BYTES))
  )
    .text()
    .catch(() => "")
}

// The session its brief reports to, read from its transcript's head.
export const reportsToOf = async (transcript: string): Promise<string | undefined> =>
  transcript ? REPORTS_TO.exec(await readSlice(transcript, "head"))?.[1] : undefined

export const tailOf = async (transcript: string): Promise<string> =>
  transcript ? readSlice(transcript, "tail") : ""

// The transcript file of a session, by its id, under the config folder's projects; "" when none is found.
export async function transcriptPathOf(configDir: string, sessionId: string): Promise<string> {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return ""
  const projects = join(configDir, "projects")
  const files = await Array.fromAsync(
    new Bun.Glob(`*/${sessionId}.jsonl`).scan({ cwd: projects }),
  ).catch(() => [] as string[])
  return files[0] ? join(projects, files[0]) : ""
}

// The tail of a session's transcript and of its SUBAGENTS newest subagents' (subagents/agent-<id>.jsonl), since a subagent's prompt is a call only its own transcript holds.
const SUBAGENTS = 8
export async function transcriptOf(configDir: string, sessionId: string): Promise<string> {
  const path = await transcriptPathOf(configDir, sessionId)
  if (!path) return ""
  const dir = join(path.replace(/\.jsonl$/, ""), "subagents")
  const agents = (await readdir(dir).catch(() => [] as string[]))
    .filter((file) => /^agent-[\w-]+\.jsonl$/.test(file))
    .map((file) => join(dir, file))
    .sort((a, b) => Bun.file(b).lastModified - Bun.file(a).lastModified)
    .slice(0, SUBAGENTS)
  const tails = await Promise.all([path, ...agents].map(tailOf))
  return tails.filter(Boolean).join("\n")
}

// Pure: the transcript's tool calls still waiting on a result, newest first, each by its input, of the tools `keep` takes when given.
export function pendingCalls(
  transcript: string,
  keep?: (tool: unknown) => boolean,
): Record<string, unknown>[] {
  const calls: { id: unknown; input: Record<string, unknown>; name: unknown }[] = []
  const done = new Set<unknown>()
  for (const line of transcript.split("\n")) {
    try {
      const entry = JSON.parse(line) as { message?: { content?: unknown }; type?: unknown }
      if (!Array.isArray(entry.message?.content)) continue
      for (const part of entry.message.content as {
        id?: unknown
        input?: Record<string, unknown>
        name?: unknown
        tool_use_id?: unknown
        type?: unknown
      }[]) {
        if (entry.type === "assistant" && part?.type === "tool_use")
          calls.push({ id: part.id, input: part.input ?? {}, name: part.name })
        if (entry.type === "user" && part?.type === "tool_result") done.add(part.tool_use_id)
      }
    } catch {}
  }
  return calls
    .filter((call) => !done.has(call.id) && (!keep || keep(call.name)))
    .map((call) => call.input)
    .reverse()
}

export const rosterAgents = async (environment: Environment): Promise<Agent[]> => {
  const roster = (await Bun.file(join(dataDir(environment), "roster.json"))
    .json()
    .catch(() => null)) as { agents?: unknown } | null
  return Array.isArray(roster?.agents) ? (roster.agents as Agent[]) : []
}

// Each live session's pid and id by its name, from Claude Code's registry: a file whose pid still runs.
export async function liveNames(
  environment: Environment,
): Promise<Map<string, { pid: number; sessionId: string }>> {
  const dir = join(configDirOf(environment), "sessions")
  const live = new Map<string, { pid: number; sessionId: string }>()
  for (const file of await readdir(dir).catch(() => [] as string[])) {
    if (!file.endsWith(".json")) continue
    try {
      const entry = (await Bun.file(join(dir, file)).json()) as {
        name?: unknown
        pid?: unknown
        sessionId?: unknown
      }
      if (typeof entry.name !== "string" || typeof entry.sessionId !== "string") continue
      if (typeof entry.pid !== "number") continue
      process.kill(entry.pid, 0)
      live.set(entry.name, { pid: entry.pid, sessionId: entry.sessionId })
    } catch {}
  }
  return live
}

// Queues one line in the ops outbox, where the relay sends it by SendMessage.
export async function queueLine(
  environment: Environment,
  job: string,
  to: string,
  text: string,
  now = new Date(),
): Promise<void> {
  const outbox = join(dataDir(environment), "ops", "outbox")
  await mkdir(outbox, { recursive: true })
  const at = now.toISOString().replace(/\.\d{3}Z$/, "Z")
  await appendFile(join(outbox, `ops-${job}.jsonl`), `${JSON.stringify({ at, job, text, to })}\n`)
}

// The file a manager's alerts-wait holds its pid in while it waits.
export const waiterPidPath = (outbox: string, name: string): string =>
  join(outbox, "alerts-wait", `${name}.pid`)

// A waiter that handed its manager an alert this recently counts as live, since the manager starts it again as it reads the alert; a waiter skips an alert queued this long before it began, since a prompt times out in 120s.
export const WAITER_GRACE_MS = 5 * 60_000

// Whether a manager's alerts-wait is waiting now: a process runs under the pid its file holds.
export async function waiterRunning(outbox: string, name: string): Promise<boolean> {
  const pid = Number(
    await Bun.file(waiterPidPath(outbox, name))
      .text()
      .catch(() => ""),
  )
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Whether a manager's alerts-wait is waiting now, or handed it an alert at or after since (ms), when it wrote its cursor and exited.
export async function waiterSince(outbox: string, name: string, since: number): Promise<boolean> {
  if (await waiterRunning(outbox, name)) return true
  const cursor = Bun.file(join(outbox, "alerts-wait", name))
  return (await cursor.exists()) && cursor.lastModified >= since
}

// Whether a manager's alerts-wait is waiting now, or handed it an alert in the last 5 minutes.
export const waiterLive = (outbox: string, name: string, now = new Date()): Promise<boolean> =>
  waiterSince(outbox, name, now.getTime() - WAITER_GRACE_MS)

// Pure: the restart hint a manager whose waiter is not live reads under its alert.
const restartHint = (name: string): string =>
  `\nYour playground alerts-wait is not running, so this alert reached you late: start it again with playground alerts-wait ${name}.`

// Pure: the line that sends a message on to a manager whose waiter is down: Ops sends it by SendMessage, and Ops' own goes by the dispatcher.
export const forwardLine = (to: string, text: string): { text: string; to: string } => ({
  text: `${to} has no playground alerts-wait running, so it hears this only from the relay: send it to ${to} by SendMessage now.\n${text}`,
  to: to === "ops" ? "dispatcher" : "ops",
})

// Pure: the lines one alert queues. A manager with no live waiter hears it only from the relay, minutes past a built-in prompt's 120s timeout, so Ops is told at once to send it on; that copy is fast only while Ops' own waiter runs, so Ops reads the same hint while its waiter is not live.
export function alertLines(
  to: string,
  text: string,
  live: boolean,
  opsLive: boolean,
): { text: string; to: string }[] {
  if (live) return [{ text, to }]
  if (to === "ops") return [{ text: `${text}${restartHint(to)}`, to }]
  return [
    { text: `${text}${restartHint(to)}`, to },
    { text: `${forwardLine(to, text).text}${opsLive ? "" : restartHint("ops")}`, to: "ops" },
  ]
}

// The hook's alert: the session's manager hears what it waits on, once per stuck or failed record. Returns who was told, or null.
export async function alertFor(
  input: Record<string, unknown>,
  record: { reason?: string; sessionId: string; state: string; tool?: string },
  environment: Environment,
  now = new Date(),
): Promise<string | null> {
  const live = await liveNames(environment)
  const name = [...live].find(([, entry]) => entry.sessionId === record.sessionId)?.[0]
  if (!name) return null
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path : ""
  const agents = await rosterAgents(environment)
  const to = managerFor(name, agents, await reportsToOf(transcript), new Set(live.keys()))
  if (!to) return null
  const task = agents.find((entry) => entry?.name === name)?.task
  const key =
    record.reason === "permission" && input.tool_input ? callKey(input.tool_input) : undefined
  const text = alertText({
    detail: key
      ? callOf(input.tool_input)
      : detailOf(input) || clip(typeof input.error === "string" ? input.error : ""),
    ...(key ? { key } : {}),
    last: clip(
      typeof input.last_assistant_message === "string"
        ? input.last_assistant_message
        : lastWords(await tailOf(transcript)),
    ),
    name,
    reason: record.reason ?? record.state,
    state: record.state,
    task: typeof task === "string" ? task : "",
    ...(record.tool ? { tool: record.tool } : {}),
  })
  // only a manager keeps a waiter (playbook SESSIONS.md), so a worker a probe reports to gets its one line
  const outbox = join(dataDir(environment), "ops", "outbox")
  const toKind = placedKindOf(to, agents.find((entry) => entry?.name === to)?.kind)
  const waiting =
    !toKind || ROSTER_ROLE_OF_KIND[toKind] !== "manager" || (await waiterLive(outbox, to, now))
  const opsLive = waiting || (await waiterLive(outbox, "ops", now))
  for (const line of alertLines(to, text, waiting, opsLive))
    await queueLine(environment, ALERT_JOB, line.to, line.text, now)
  return to
}

// `bun stuck-alert.ts manager <name> [transcript]`: prints the manager a session's block goes to, for ops-unstick's screen backstop; prints nothing for none.
if (import.meta.main && process.argv[2] === "manager") {
  // Imported here, since session-state imports this file in a hook, where @packages/settings cannot load.
  const { loadSessionNames } = await import("./playground/setting")
  loadSessionNames()
  const [name = "", transcript = ""] = process.argv.slice(3)
  const live = await liveNames(process.env)
  const to = managerFor(
    name,
    await rosterAgents(process.env),
    await reportsToOf(transcript),
    new Set(live.keys()),
  )
  if (to) console.log(to)
}
