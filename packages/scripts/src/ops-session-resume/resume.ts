import "@packages/env/aliases"
import { appendFile, mkdir, readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { dispatcherOf, isManagerKind, managerOf } from "@packages/config/kinds"
import {
  parseSessionState,
  type SessionState,
  sessionStateDir,
  stateNow,
} from "@packages/config/session-state"
import { dataDirOf } from "@packages/env/data-dir"

import { roleOfName } from "../../../../scripts/hooks/role"
import { escalateMs, leadOf } from "../ops-tick/tick"
import {
  alertText,
  callKey,
  callOf,
  lastWords,
  managerFor,
  pendingCalls,
  pickerLines,
  reportsToOf,
  tailOf,
  transcriptPathOf,
} from "../stuck-alert"
import { writeAtomic } from "../write-atomic"

// ops-session-resume: a session whose turn ended on a usage limit sits idle after its reset, since nothing wakes it (GLM's, and a claude.ai limit Claude Code does not continue itself). Each cycle this job reads the state files the session-state hook writes and queues one resume line for each session past its reset, in the ops outbox the relay sends with SendMessage (ADR 0010), so the line arrives from a session and never as keys typed into the pane.
export const CYCLE_SECONDS = 60

// A provider's window can lag its printed reset by a few seconds; a line sent too early fails on the limit again.
export const GRACE_MS = 60_000

export const resumeLine = (resetsAt: string): string =>
  `Your usage limit reset at ${resetsAt}. Carry on with your task from where you stopped.`

const keyOf = (record: SessionState): string => `${record.sessionId} ${record.resetsAt}`

// A restart (herdr's or the machine's) loses the turn in flight, and a restore that resumes a session with no first prompt leaves it idle. `spawn.sh resume` gives every resume a first prompt, whose turn writes a newer record, so the wait lets that land first.
export const RESTART_GRACE_MS = 120_000

export const restartLine = (startedAt: number): string =>
  `You were restarted at ${new Date(startedAt).toISOString().replace(/\.\d{3}Z$/, "Z")} in the middle of a turn, which was lost. Carry on with your task from where you stopped.`

const restartKey = (sessionId: string, startedAt: number): string =>
  `${sessionId} restart ${startedAt}`

// Pure: whether a session's newest record says it was mid-turn before its process started, so the turn was lost, and no line has gone for that start.
export const lostTurn = (
  record: SessionState,
  startedAt: number | undefined,
  sent: Set<string>,
  now: Date,
): boolean =>
  record.state === "working" &&
  startedAt !== undefined &&
  Date.parse(record.at) < startedAt &&
  startedAt + RESTART_GRACE_MS <= now.getTime() &&
  !sent.has(restartKey(record.sessionId, startedAt))

// A turn that ended on an API error (the hook's `failed`: a server error, a lost connection) leaves the session idle with nothing on its screen to answer. Its next pass sends one carry-on line; a later pass that finds the same record still standing, or a new failure within FAILED_WINDOW_MS of the line, tells its lead and the dispatcher once.
export const FAILED_WINDOW_MS = 30 * 60_000

// Claude Code's autocompact thrashing stops a turn as `invalid_request`; redoing the step that filled the context fills it again, so its line and alert name their own fix, as ops-unstick's did.
const THRASH = "Autocompact is thrashing"

// Pure: whether the transcript's newest API error line is autocompact thrashing.
export function thrashed(transcript: string): boolean {
  for (const line of transcript.split("\n").reverse()) {
    try {
      const entry = JSON.parse(line) as {
        isApiErrorMessage?: unknown
        message?: { content?: unknown }
      }
      if (entry.isApiErrorMessage !== true) continue
      const content = entry.message?.content
      return (
        Array.isArray(content) &&
        content.some(
          (part: { text?: unknown }) =>
            typeof part?.text === "string" && part.text.startsWith(THRASH),
        )
      )
    } catch {}
  }
  return false
}

export const failedLine = (reason: string | undefined, thrash: boolean): string =>
  thrash
    ? "Your last turn stopped on autocompact thrashing: a read or a tool output was too large for your context. Carry on with small reads (Read with offset and limit, grep, head; Explore for a large one), and leave the output that filled it unread."
    : `Your last turn ended on an API error (${reason ?? "unknown"}). Carry on with your task from where you stopped: redo the step that failed.`

export const failedAlert = (
  name: string,
  record: SessionState,
  now: Date,
  thrash: boolean,
  again: boolean,
): string =>
  `${name} stopped on ${thrash ? "autocompact thrashing" : `an API error (${record.reason ?? "unknown"})`} ${again ? "again " : ""}at ${record.at.replace(/\.\d{3}Z$/, "Z")}, ${again ? `within ${FAILED_WINDOW_MS / 60_000}m of its last carry-on line` : `and has stood ${Math.round((now.getTime() - Date.parse(record.at)) / 60_000)}m since, a pass after its carry-on line was queued`}. ${thrash ? "Start it fresh from its brief." : "Resume it by SendMessage or respawn it from its brief."}`

const failedKey = (record: SessionState, step: "alert" | "line"): string =>
  `${record.sessionId} failed-${step} ${record.at}`

// Claude Code continues some claude.ai limits by itself and says so right after the limit line ("Usage limit reached · continuing automatically at 12:50am · esc to cancel": 128 of 150 limits in this machine's transcripts, none of the 9 on 2.1.302), so a limit it announced gets no second line, nor one after a person cancels that continue with Esc.
const CONTINUE_NOTICE = /continuing automatically at/
const TAIL_BYTES = 256 * 1024

// Pure: whether Claude Code announced its own continue for the limit that resets at resetsAt. A notice speaks for the limit line just before it, so an earlier limit's notice never covers a later one (an account switch can bring a new limit with none). A message queued during the limit writes the same limit line again with no second notice, so walking back from the end, a limit line with this reset (quotaLimits or apiErrorParams.rate_limit_info, epoch seconds) keeps the walk going until a notice, and any other ends it.
export function continuesItself(transcript: string, resetsAt: string): boolean {
  let notice = false
  for (const line of transcript.split("\n").reverse()) {
    try {
      const entry = JSON.parse(line) as {
        apiErrorParams?: { rate_limit_info?: { resetsAt?: unknown } }
        content?: unknown
        isApiErrorMessage?: unknown
        quotaLimits?: { resetsAt?: unknown }
        type?: unknown
      }
      if (entry.isApiErrorMessage === true) {
        const at = entry.quotaLimits?.resetsAt ?? entry.apiErrorParams?.rate_limit_info?.resetsAt
        const same = typeof at === "number" && at * 1000 === Date.parse(resetsAt)
        if (notice || !same) return same
        continue
      }
      if (
        entry.type === "system" &&
        typeof entry.content === "string" &&
        CONTINUE_NOTICE.test(entry.content)
      )
        notice = true
    } catch {}
  }
  return false
}

// An Escape fires no hook, so a turn a person stopped mid-tool keeps its `working` record; its one mark is this line (a probe, 19 Oct: 70 of 70 interrupt lines in this machine's transcripts take this shape).
const INTERRUPTED = "[Request interrupted by user"

// Pure: whether the transcript holds a person's interrupt written after `at`, so the turn ended by their hand, not a restart's.
export function interruptedAfter(transcript: string, at: string): boolean {
  const since = Date.parse(at)
  for (const line of transcript.split("\n").reverse()) {
    try {
      const entry = JSON.parse(line) as {
        message?: { content?: unknown }
        timestamp?: unknown
        type?: unknown
      }
      if (entry.type !== "user" || typeof entry.timestamp !== "string") continue
      if (Date.parse(entry.timestamp) <= since) return false
      const content = entry.message?.content
      if (
        Array.isArray(content) &&
        content.some(
          (part: { text?: unknown }) =>
            typeof part?.text === "string" && part.text.startsWith(INTERRUPTED),
        )
      )
        return true
    } catch {}
  }
  return false
}

export async function transcriptTail(configDir: string, sessionId: string): Promise<string> {
  const path = await transcriptPathOf(configDir, sessionId)
  if (!path) return ""
  const file = Bun.file(path)
  return file.slice(Math.max(0, file.size - TAIL_BYTES)).text()
}

// The transcript tail a stuck record's call sits in: the subagent's its record names, else the session's own.
async function callsTail(configDir: string, record: SessionState): Promise<string> {
  const path = await transcriptPathOf(configDir, record.sessionId)
  if (!path || !record.agentId || !/^[\w-]+$/.test(record.agentId)) return tailOf(path)
  return tailOf(join(path.replace(/\.jsonl$/, ""), "subagents", `agent-${record.agentId}.jsonl`))
}

// a stuck session its manager has not answered in unstick.escalateMinutes goes to the primary dispatcher, who posts to the owner's Inbox only when it cannot resolve it; a session reading working whose transcript has not moved in QUIET_MS (no tool call) goes to its manager.
const QUIET_MS = 15 * 60_000
// /metrics counts requests, not sessions, so the local model's busy read holds a quiet local session's line back this long at most, and a stuck one is still flagged while others are served.
const SERVED_MS = 45 * 60_000

// A permission prompt's escalation carries its waiting call and the call's key, so the dispatcher can answer it with playground picker.
export const stuckEscalation = (
  name: string,
  record: SessionState,
  now: Date,
  call?: Record<string, unknown>,
): string => {
  const head = `${name} has been stuck on a ${record.reason ? `${record.reason} ` : ""}prompt${record.tool ? ` (${record.tool})` : ""} for ${Math.round((now.getTime() - Date.parse(record.at)) / 60_000)}m, since ${record.at.replace(/\.\d{3}Z$/, "Z")}, and its manager has not answered.`
  const tail = "Resolve it; post it to the owner's Inbox only if you cannot."
  if (record.reason !== "permission" || !call) return `${head} ${tail}`
  return `${head} It waits on:\n${callOf(call)}\n${pickerLines(name, callKey(call))} ${tail}`
}

// Pure: the time of the transcript's newest user or assistant entry, which stateNow() reads a stuck record against.
export function newestTurnAt(transcript: string): string | null {
  for (const line of transcript.split("\n").reverse()) {
    try {
      const entry = JSON.parse(line) as { timestamp?: unknown; type?: unknown }
      if (
        (entry.type === "user" || entry.type === "assistant") &&
        typeof entry.timestamp === "string"
      )
        return entry.timestamp
    } catch {}
  }
  return null
}

// When a session last wrote: its transcript's mtime, or a later one of a subagent's transcript beside it, since a foreground subagent writes there alone.
async function newestWrite(path: string): Promise<number | undefined> {
  const own = (await stat(path).catch(() => null))?.mtimeMs
  const dir = join(path.replace(/\.jsonl$/, ""), "subagents")
  const theirs = await Promise.all(
    (await readdir(dir).catch(() => [] as string[])).map(
      async (file) => (await stat(join(dir, file)).catch(() => null))?.mtimeMs ?? 0,
    ),
  )
  return own === undefined ? undefined : Math.max(own, ...theirs)
}

// Pure: what a failed record is due on this pass: its carry-on line first, its alert on a later pass once the line went, then nothing; a record that follows the session's last line within the window is due its alert at once ("again").
function failedStep(record: SessionState, sent: Set<string>): "again" | "alert" | "line" | null {
  if (record.state !== "failed" || sent.has(failedKey(record, "alert"))) return null
  if (sent.has(failedKey(record, "line"))) return "alert"
  const at = Date.parse(record.at)
  const again = [...sent].some((key) => {
    const [sessionId, step, lineAt] = key.split(" ")
    const since = at - Date.parse(lineAt ?? "")
    return (
      sessionId === record.sessionId &&
      step === "failed-line" &&
      since > 0 &&
      since <= FAILED_WINDOW_MS
    )
  })
  return again ? "again" : "line"
}

// Pure: the usage-limited records past their reset and the grace, not yet sent a line for that reset.
export function due(records: SessionState[], sent: Set<string>, now: Date): SessionState[] {
  return records.filter(
    (record) =>
      record.state === "usage-limit" &&
      record.resetsAt !== undefined &&
      Date.parse(record.resetsAt) + GRACE_MS <= now.getTime() &&
      !sent.has(keyOf(record)),
  )
}

// Each session's record, in session id order, since readdir's order is the filesystem's own (APFS, ext4 and tmpfs each list a folder differently) and the lines a pass queues follow it.
async function records(dir: string): Promise<SessionState[]> {
  const files = await readdir(dir).catch(() => [] as string[])
  const read = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .toSorted()
      .map((file) =>
        Bun.file(join(dir, file))
          .text()
          .then(parseSessionState, () => null),
      ),
  )
  return read.filter((record): record is SessionState => record !== null)
}

export type LiveSession = { cwd?: string; name: string; pid?: number; startedAt?: number }

// The job's ops folder in the data folder, PLAYGROUND_DATA_DIR included, which its ledger and its heartbeat (cli.ts) share, so one job keeps to one folder.
export const opsDirOf = (env: Record<string, string | undefined> = process.env): string =>
  join(dataDirOf(env), "ops")

// Each live session by its id, from Claude Code's registry: a file naming a session whose pid still runs, with that pid, its folder and when that process started (`startedAt`, epoch ms) when the file gives them.
export async function liveSessions(configDir: string): Promise<Map<string, LiveSession>> {
  const dir = join(configDir, "sessions")
  const live = new Map<string, LiveSession>()
  for (const file of await readdir(dir).catch(() => [] as string[])) {
    if (!file.endsWith(".json")) continue
    try {
      const entry = JSON.parse(await Bun.file(join(dir, file)).text()) as {
        cwd?: unknown
        name?: unknown
        pid?: unknown
        sessionId?: unknown
        startedAt?: unknown
      }
      if (typeof entry.sessionId !== "string" || typeof entry.name !== "string") continue
      if (typeof entry.pid !== "number") continue
      process.kill(entry.pid, 0)
      live.set(entry.sessionId, {
        ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
        name: entry.name,
        pid: entry.pid,
        ...(typeof entry.startedAt === "number" ? { startedAt: entry.startedAt } : {}),
      })
    } catch {}
  }
  return live
}

// The hook runs in every session that loads this checkout's project settings, the owner's own included, so only a factory session gets a line, and never a probe, whose spawner answers it, as ops-unstick does.
const resumable = (name: string): boolean => !["", "probe"].includes(roleOfName(name))

// The lead told of a failed turn, by tick.ts's leadOf over the roster beside the ops folder: the builder's seat, else the primary dispatcher (dispatcherOf), whose own goes to the builder's.
export async function leadName(ops: string, name: string): Promise<string> {
  const agents = await rosterAgents(ops)
  const agent = agents?.find((entry) => entry?.name === name)
  const primary = dispatcherOf(agents, 1)
  const kind = name === primary ? "builder" : leadOf(name, agent?.worker, agent?.kind)
  return isManagerKind(kind) ? managerOf(agents, kind) : primary
}

// The primary dispatcher's live name, by the roster beside the ops folder (dispatcherOf), else the default.
export const primaryDispatcher = async (ops: string): Promise<string> =>
  dispatcherOf(await rosterAgents(ops), 1)

const rosterAgents = async (ops: string) => {
  const roster = (await Bun.file(join(ops, "..", "roster.json"))
    .json()
    .catch(() => null)) as {
    agents?: { kind?: unknown; name?: unknown; task?: unknown; worker?: unknown }[]
  } | null
  return Array.isArray(roster?.agents) ? roster.agents : undefined
}

// One run: "ok" with the count of lines queued, else why not; it queues each due line (a limit's reset, a turn a restart lost, a turn an API error ended and its alert), recording it in the job's ledger (kept to the sessions with a file, and a failed turn's keys to its newest record or the window, so it never grows) before the next run reads it.
export async function cycle(options: {
  configDir: string
  live: () => Promise<Map<string, LiveSession>>
  // whether the local model serves the session and reads busy, so its quiet flag is held back
  localBusy?: (name: string) => Promise<boolean>
  now?: Date
}): Promise<{ result: string; resumed: number }> {
  const { configDir, now = new Date() } = options
  let resumed = 0
  try {
    const ops = opsDirOf()
    const ledgerPath = join(ops, "session-resume", "sent.json")
    const all = await records(sessionStateDir(dataDirOf(process.env)))
    const sent = new Set<string>(
      JSON.parse(
        await Bun.file(ledgerPath)
          .text()
          .catch(() => "[]"),
      ) as string[],
    )
    const sessions = await options.live()
    const queue = async (to: string | undefined, text: string): Promise<boolean> => {
      if (!to || !/^[a-z0-9-]+$/.test(to) || !resumable(to)) return false
      await mkdir(join(ops, "outbox"), { recursive: true })
      const line = {
        at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
        job: "session-resume",
        text,
        to,
      }
      await appendFile(join(ops, "outbox", "ops-session-resume.jsonl"), `${JSON.stringify(line)}\n`)
      resumed++
      return true
    }
    for (const record of due(all, sent, now)) {
      if (continuesItself(await transcriptTail(configDir, record.sessionId), record.resetsAt!)) {
        sent.add(keyOf(record))
        continue
      }
      if (await queue(sessions.get(record.sessionId)?.name, resumeLine(record.resetsAt!)))
        sent.add(keyOf(record))
    }
    for (const record of all) {
      const session = sessions.get(record.sessionId)
      if (!session || !lostTurn(record, session.startedAt, sent, now)) continue
      const key = restartKey(record.sessionId, session.startedAt!)
      if (interruptedAfter(await transcriptTail(configDir, record.sessionId), record.at))
        sent.add(key)
      else if (await queue(session.name, restartLine(session.startedAt!))) sent.add(key)
    }
    for (const record of all) {
      const session = sessions.get(record.sessionId)
      const step = session && failedStep(record, sent)
      if (!session || !step) continue
      const thrash = thrashed(await transcriptTail(configDir, record.sessionId))
      if (step === "line") {
        if (await queue(session.name, failedLine(record.reason, thrash)))
          sent.add(failedKey(record, "line"))
        continue
      }
      const to = new Set([await leadName(ops, session.name), await primaryDispatcher(ops)])
      to.delete(session.name)
      let told = false
      for (const name of to)
        if (await queue(name, failedAlert(session.name, record, now, thrash, step === "again")))
          told = true
      if (told) sent.add(failedKey(record, "alert"))
    }
    const agents = (await rosterAgents(ops)) ?? []
    const dispatcher = dispatcherOf(agents, 1)
    const names = new Set([...sessions.values()].map((session) => session.name))
    const quiet = new Set<string>()
    const escalateAfter = await escalateMs(dataDirOf(process.env))
    for (const record of all) {
      const session = sessions.get(record.sessionId)
      if (!session || session.name === dispatcher) continue
      const since = now.getTime() - Date.parse(record.at)
      if (record.state === "stuck" && since >= escalateAfter) {
        const key = `${record.sessionId} stuck-escalate ${record.at}`
        const tail = await transcriptTail(configDir, record.sessionId)
        if (sent.has(key) || stateNow(record, newestTurnAt(tail)) !== "stuck") continue
        if (!managerFor(session.name, agents, undefined, names)) continue
        const call = pendingCalls(
          await callsTail(configDir, record),
          record.tool ? (tool) => tool === record.tool : undefined,
        ).at(-1)
        if (await queue(dispatcher, stuckEscalation(session.name, record, now, call))) sent.add(key)
      }
      if (record.state !== "working" || since < QUIET_MS) continue
      const path = await transcriptPathOf(configDir, record.sessionId)
      const moved = path ? await newestWrite(path) : undefined
      if (moved === undefined || now.getTime() - moved < QUIET_MS) continue
      // held back while localBusy reads true, for the first 45 minutes of quiet only (SERVED_MS)
      if (now.getTime() - moved < SERVED_MS && (await options.localBusy?.(session.name))) continue
      const key = `${record.sessionId} quiet ${new Date(moved).toISOString()}`
      quiet.add(key)
      const tail = await transcriptTail(configDir, record.sessionId)
      if (sent.has(key) || interruptedAfter(tail, record.at)) continue
      const to = managerFor(session.name, agents, await reportsToOf(path), names)
      const task = agents.find((entry) => entry?.name === session.name)?.task
      const text = alertText({
        detail: "",
        last: lastWords(tail),
        name: session.name,
        reason: `${Math.round((now.getTime() - moved) / 60_000)} minutes`,
        state: "quiet",
        task: typeof task === "string" ? task : "",
      })
      if (to && (await queue(to, text))) sent.add(key)
    }
    const current = new Map(all.map((record) => [record.sessionId, record.at]))
    const kept = (key: string): boolean => {
      const [sessionId, step, at] = key.split(" ")
      if (!current.has(sessionId!)) return false
      if (step === "quiet") return quiet.has(key)
      if (step === "stuck-escalate") return at === current.get(sessionId!)
      if (!step?.startsWith("failed-") || at === current.get(sessionId!)) return true
      return now.getTime() - Date.parse(at ?? "") <= FAILED_WINDOW_MS
    }
    await writeAtomic(ledgerPath, `${JSON.stringify([...sent].filter(kept))}\n`)
    return { result: "ok", resumed }
  } catch (err) {
    return { result: err instanceof Error ? err.message : String(err), resumed }
  }
}

// The heartbeat api/hono/src/lib/dashboard/ops.ts reads.
export const beat = (path: string, startedAt: Date, now: Date, lastResult: string) =>
  writeAtomic(
    path,
    `${JSON.stringify({
      cycleSeconds: CYCLE_SECONDS,
      job: "ops-session-resume",
      lastBeatAt: now.toISOString(),
      lastResult,
      pid: process.pid,
      startedAt: startedAt.toISOString(),
    })}\n`,
  )
