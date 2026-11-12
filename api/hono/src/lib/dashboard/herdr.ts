import "@packages/env/aliases"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { envValue } from "@packages/config/org"
import {
  parseSessionState,
  sessionStateDir,
  stateNow,
  type SessionState,
} from "@packages/config/session-state"
import { dataDirOf } from "@packages/env/data-dir"
import { readPin } from "@packages/settings"
import { z } from "zod"

import {
  currentSource,
  fixtureHerdrInput,
  fixtureHerdrPane,
  FixtureHerdrRefusal,
  fixtureHerdrScreen,
  readFixtureHerdr,
  readsLive,
} from "@/lib/dashboard/fixture"
import type { Registry } from "@/lib/dashboard/peers"
import type { UsageLimit } from "@/lib/dashboard/unstick"
import { ApiError } from "@/lib/error"
import { claudeDir, dataDir, transcriptPath } from "@/lib/sessions/paths"

// The dashboard's herdr provider (C4), the one file that speaks herdr v0.9.5's socket API (herdr.test.ts holds that boundary): it lists, reads and messages the Claude sessions in herdr's servers, and since a server answers one request per connection in about a millisecond (measured at 30 panes: session.snapshot p50 1.2 ms, pane.process_info p50 0.2 ms, the whole server p50 4 ms), every board reads every server afresh, with no cache and no pacing, herdr's events only telling the hub when to read again, so a server that went away is read again on the next board.

type Json = Record<string, unknown>

// The servers Playground runs: PLAYGROUND_HERDR_SESSIONS names them (playground and playground-probes, plus the folder's other server sockets while it is blank), each serving its socket at <PLAYGROUND_HERDR_DIR>/<name>.sock, the dir herdr in the data folder, ~/.playground, unless set, following HOME and never CLAUDE_CONFIG_DIR or PLAYGROUND_DATA_DIR as ops-herdr serves them, so a session on another login reads the same servers. A fixture stack reads the fixture's own playground server alone (FIXTURE_SOCKET), and a hosted or refused one reads none.
export type HerdrServer = { name: string; socket: string }

const SERVER_NAME = /^[a-z0-9][a-z0-9_-]*$/

export const herdrServers = (
  env: Record<string, string | undefined> = process.env,
): HerdrServer[] => {
  if (!readsLive()) {
    return currentSource().kind === "fixture"
      ? [{ name: "playground", socket: FIXTURE_SOCKET }]
      : []
  }
  const dir =
    envValue(env, "PLAYGROUND_HERDR_DIR") || join(dataDirOf({}, env.HOME || homedir()), "herdr")
  const named = envValue(env, "PLAYGROUND_HERDR_SESSIONS")
  const names = (named || "playground,playground-probes").split(",").map((name) => name.trim())
  if (!named) names.push(...leftOver(dir).filter((name) => !names.includes(name)))
  return names
    .filter((name) => SERVER_NAME.test(name))
    .map((name) => ({ name, socket: join(dir, `${name}.sock`) }))
}

// A restore has 5 minutes from its owe to write its first run's lines, so a server whose start or restore never runs gives Start back; a restored dispatcher has 2 minutes for its pane to read live.
const RESTORE_RUN_MS = 5 * 60_000
const RESTORED_MS = 2 * 60_000

const RESTORE_LINE = /^(restored|skipped|waiting|not restored) (\S+?)(?::|$)/

// Pure: whether a server's owed restore can still bring the dispatcher back, from the owe's time and its newest run's lines (spawn.sh restore's, which tries the dispatcher first): before a run that names any session, for up to RESTORE_RUN_MS; while that run's line for the dispatcher reads waiting; or restored, for RESTORED_MS. A line that skipped or failed it, or none, is a restore that will not, whatever else still waits.
export const bringsBack = ({
  dispatcher,
  log,
  logAt,
  now,
  owedAt,
}: {
  dispatcher: string
  log: string
  logAt: number | null
  now: number
  owedAt: number
}): boolean => {
  const lines =
    logAt === null || logAt < owedAt
      ? []
      : log.split("\n").flatMap((line) => {
          const read = RESTORE_LINE.exec(line)
          return read ? [{ kind: read[1], name: read[2] }] : []
        })
  if (lines.length === 0) return now - owedAt < RESTORE_RUN_MS
  const kind = lines.find((line) => line.name === dispatcher)?.kind
  return kind === "waiting" || (kind === "restored" && now - (logAt ?? 0) < RESTORED_MS)
}

const mtimeOf = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

// Whether a restore can still bring the dispatcher back: ops-herdr keeps <server>.restore beside a server's socket (owedFile) from the server's start until no session its restore owes waits on a gate or focus, and writes each run's lines to <server>.restore.log beside it (bringsBack reads both); a fixture stack reads its herdr.json's restoring instead.
export const restoring = ({
  dispatcher,
  fixtureDir,
  now = Date.now(),
  servers = herdrServers(),
}: {
  dispatcher: string
  fixtureDir?: string
  now?: number
  servers?: HerdrServer[]
}): boolean =>
  servers.some(({ name, socket }) => {
    if (socket === FIXTURE_SOCKET) return Boolean(readFixtureHerdr(fixtureDir).restoring)
    const owedAt = mtimeOf(join(dirname(socket), `${name}.restore`))
    if (owedAt === null) return false
    const path = join(dirname(socket), `${name}.restore.log`)
    const logAt = mtimeOf(path)
    const log = logAt === null ? "" : readFileSync(path, "utf8")
    return bringsBack({ dispatcher, log, logAt, now, owedAt })
  })

// Every other server socket in the folder, by ops-herdr's socketServers rule (a <name>.sock, never a client's <name>-client.sock nor herdr's default), so a session on a server an older Playground started under another name, factory or probes before the rename, still shows while that server runs, as the CLI's Start already counts it.
const leftOver = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".sock") && !file.endsWith("-client.sock"))
      .map((file) => file.slice(0, -".sock".length))
      .filter((name) => name !== "default")
      .toSorted()
  } catch {
    return []
  }
}

// A herdr session's surface on the board, `herdr:<server>:<pane id>` (herdr:playground:w2:p1; herdr numbers past 9 in letters, wA:p1), since pane ids repeat across servers. A pane's id changes when it moves, and every board reads it afresh, so the surface always names where the session is now.
const PANE_ID = "w[0-9A-Za-z]+:p[0-9A-Za-z]+"
const SURFACE = new RegExp(`^herdr:([a-z0-9][a-z0-9_-]*):(${PANE_ID})$`)

export const herdrSurface = (server: string, pane: string): string => `herdr:${server}:${pane}`

export const isHerdrSurface = (surface: string): boolean => SURFACE.test(surface)

const paneAt = (surface: string): { pane: string; server: HerdrServer } => {
  const [, name, pane] = SURFACE.exec(surface) ?? []
  const server = herdrServers().find((s) => s.name === name)
  if (!server || !pane) throw new ApiError(404, "NOT_FOUND", `No herdr server holds ${surface}.`)
  return { pane, server }
}

// The server is not running: its socket is missing, or refuses (a crash can leave the file behind). Nothing was sent.
export class HerdrDown extends ApiError {
  constructor(detail: string) {
    super(503, "SESSIONS_UNAVAILABLE", `herdr is not running: ${detail}`)
  }
}

// herdr answered with an error (`reason` is its error.code: agent_blocked, not_found, timeout, ...).
export class HerdrRefused extends ApiError {
  constructor(
    method: string,
    readonly reason: string,
    message: string,
  ) {
    super(
      502,
      "SESSIONS_FAILED",
      `herdr ${method} failed: ${reason}${message ? `, ${message}` : ""}`,
    )
  }
}

// No answer: the request timed out, or the connection closed after the request went out. A prompt given up this way may have been typed anyway.
export class HerdrTimedOut extends ApiError {
  constructor(method: string) {
    super(502, "SESSIONS_FAILED", `herdr ${method} failed: no answer from herdr`)
  }
}

// A session's herdr state as this process last read it: since when (the read that found it, after a pause in reads), when it was last read, and whether this process saw that state begin (it read the pane in another state within SEEN_SLACK_MS before) or found it already there, as after a pause in reads, since the hub reads only while a Dashboard is open.
type Change = { at: string; read: string; seen: boolean; server: string; status: string }

const SEEN_SLACK_MS = 30_000

// What this process keeps of herdr, on globalThis as attachments.ts and sdk.ts keep theirs, so a `bun --hot` reload keeps it: the request ids, when each session's state last changed, and what the last read could not read.
const STATE = Symbol.for("playground.dashboard.herdr.state")
const kept = globalThis as {
  [STATE]?: {
    changed: Map<string, Change>
    ids: number
    problems: string[]
  }
}
const state = (kept[STATE] ??= { changed: new Map(), ids: 0, problems: [] })

// One line onto a socket, whole: a unix socket on macOS takes at most 8192 bytes a write (net.local.stream.sendspace) and Bun keeps none of the rest, so what it did not take goes out each time it drains.
type Writable = { write: (bytes: Uint8Array) => number }
const lineWriter = (line: string) => {
  let left = new TextEncoder().encode(`${line}\n`)
  return (socket: Writable) => {
    while (left.length) {
      const wrote = socket.write(left)
      if (wrote <= 0) return
      left = left.subarray(wrote)
    }
  }
}

// A fixture stack's herdr server, on no socket: each request is answered from the fixture's herdr.json (fixture.ts) in the shape herdr's own answer takes, so every read and write in this file runs on it as it is.
export const FIXTURE_SOCKET = "fixture:herdr"

const fixtureAnswer = (method: string, params: Json): Json => {
  const pane = String(params.pane_id ?? params.target ?? "")
  try {
    switch (method) {
      case "session.snapshot": {
        const { panes, workspaces } = readFixtureHerdr()
        return { snapshot: { panes, workspaces } }
      }
      case "pane.process_info":
        return { process_info: { foreground_processes: fixtureHerdrPane(pane).processes } }
      case "pane.get":
        return { pane: fixtureHerdrPane(pane) }
      case "pane.read": {
        const rows = fixtureHerdrScreen(pane).split("\n")
        return { read: { text: rows.slice(-Number(params.lines || rows.length)).join("\n") } }
      }
      case "agent.prompt":
        fixtureHerdrInput(pane, { prompt: String(params.text ?? "") })
        return {}
      case "pane.send_keys":
        fixtureHerdrInput(pane, { keys: (params.keys as string[] | undefined) ?? [] })
        return {}
      case "pane.send_text":
        fixtureHerdrInput(pane, { text: String(params.text ?? "") })
        return {}
    }
  } catch (error) {
    if (error instanceof FixtureHerdrRefusal)
      throw new HerdrRefused(method, error.code, error.message)
    throw error
  }
  throw new HerdrRefused(method, "unknown_method", "the fixture holds no answer to it")
}

// One request on its own connection: the server writes one JSON line back and closes it.
export async function request(
  socket: string,
  method: string,
  params: Json,
  timeoutMs = 2000,
): Promise<Json> {
  if (socket === FIXTURE_SOCKET) return fixtureAnswer(method, params)
  let buffered = ""
  let settle: (value: unknown) => void = () => {}
  const answered = new Promise<unknown>((resolve) => (settle = resolve))
  const decoder = new TextDecoder()
  const flush = lineWriter(
    JSON.stringify({ id: `dashboard:${process.pid}:${++state.ids}`, method, params }),
  )
  let conn: Awaited<ReturnType<typeof Bun.connect>>
  try {
    conn = await Bun.connect({
      socket: {
        close: () => settle(new HerdrTimedOut(method)),
        data: (_socket, chunk) => {
          buffered += decoder.decode(chunk, { stream: true })
          const end = buffered.indexOf("\n")
          if (end < 0) return
          try {
            settle(JSON.parse(buffered.slice(0, end)))
          } catch {
            settle(new HerdrRefused(method, "malformed", "an answer that is not JSON"))
          }
        },
        drain: flush,
        error: () => settle(new HerdrTimedOut(method)),
      },
      unix: socket,
    })
  } catch (error) {
    throw new HerdrDown(error instanceof Error ? error.message : String(error))
  }
  flush(conn)
  const timer = setTimeout(() => settle(new HerdrTimedOut(method)), timeoutMs)
  const result = await answered
  clearTimeout(timer)
  conn.end()
  if (result instanceof Error) throw result
  const answer = responseSchema.safeParse(result)
  if (!answer.success) throw new HerdrRefused(method, "malformed", "an answer of another shape")
  if (answer.data.error) {
    throw new HerdrRefused(method, answer.data.error.code, answer.data.error.message)
  }
  return answer.data.result ?? {}
}

// The parts of herdr's answers the dashboard reads, checked against the pinned binary's own `herdr api schema --json` (herdr.test.ts). Fields the dashboard does not read are dropped, so a newer herdr's additions change nothing (Socket API § Protocol stability).
const responseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
})

const STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const

export const paneSchema = z.object({
  agent_session: z.object({ kind: z.string(), value: z.string() }).nullish(),
  agent_status: z.enum(STATUSES).catch("unknown"),
  label: z.string().nullish(),
  pane_id: z.string().regex(new RegExp(`^${PANE_ID}$`)),
  scroll: z.object({ offset_from_bottom: z.number() }).nullish(),
  terminal_id: z.string(),
  workspace_id: z.string(),
})

export const workspaceSchema = z.object({ label: z.string(), workspace_id: z.string() })

export const processSchema = z.object({
  argv: z.array(z.string()).nullish(),
  cwd: z.string().nullish(),
  pid: z.number().int(),
})

const snapshotSchema = z.object({
  snapshot: z.object({ panes: z.array(z.unknown()), workspaces: z.array(z.unknown()) }),
})

const processInfoSchema = z.object({
  process_info: z.object({ foreground_processes: z.array(z.unknown()).nullish() }),
})

const paneInfoSchema = z.object({ pane: paneSchema })

const readSchema = z.object({ read: z.object({ text: z.string() }) })

// Each entry checked on its own, so one herdr cannot describe leaves the rest.
const each = <T>(schema: z.ZodType<T>, values: unknown[]): T[] =>
  values.flatMap((value) => {
    const parsed = schema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })

export type Pane = z.infer<typeof paneSchema> & { processes: z.infer<typeof processSchema>[] }
// partial: a pane's processes, or the whole server, did not answer whole, so a session missing from this read may still be live.
export type ServerRead = {
  panes: Pane[]
  partial?: true
  server: string
  workspaces: z.infer<typeof workspaceSchema>[]
}

const SERVER_READ_MS = 3000

// One server as it is now: its panes, each with the processes in its foreground, and its workspaces. The panes are asked one after another, since herdr answers 30 asked at once in about 100 ms and one after another in 6 (measured), and the whole read has one deadline, so a server that answers its snapshot and then hangs is given up in deadlineMs rather than 2 s a pane, well inside the hub's 8 s for a board.
export async function readServer(
  server: HerdrServer,
  deadlineMs = SERVER_READ_MS,
): Promise<ServerRead> {
  const until = Date.now() + deadlineMs
  const left = () => {
    const ms = until - Date.now()
    if (ms <= 0) throw new HerdrTimedOut("session read")
    return Math.min(ms, 2000)
  }
  const parsed = snapshotSchema.safeParse(
    await request(server.socket, "session.snapshot", {}, left()),
  )
  if (!parsed.success) throw new HerdrRefused("session.snapshot", "malformed", "no snapshot")
  const panes: Pane[] = []
  let partial = false
  for (const pane of each(paneSchema, parsed.data.snapshot.panes)) {
    const info = await request(
      server.socket,
      "pane.process_info",
      { pane_id: pane.pane_id },
      left(),
    )
      .then((result) => processInfoSchema.safeParse(result))
      .catch(() => null)
    if (!info?.success) partial = true
    const listed = info?.success ? (info.data.process_info.foreground_processes ?? []) : []
    panes.push({ ...pane, processes: each(processSchema, listed) })
  }
  return {
    panes,
    ...(partial && { partial: true }),
    server: server.name,
    workspaces: each(workspaceSchema, parsed.data.snapshot.workspaces),
  }
}

// What the last read of every server could not read, for the System report; a server that is down is not a fault, since none may be set up here.
export const herdrProblem = (): string | null =>
  state.problems.length ? state.problems.join("; ") : null

export async function readHerdr(
  servers = herdrServers(),
  deadlineMs = SERVER_READ_MS,
): Promise<ServerRead[]> {
  const reads = await Promise.all(
    servers.map((server) =>
      readServer(server, deadlineMs).then(
        (read) => ({ read }),
        (error: unknown) => ({ error, server }),
      ),
    ),
  )
  state.problems = reads.flatMap((r) =>
    "error" in r && !(r.error instanceof HerdrDown)
      ? [`herdr's ${r.server.name} server could not be read: ${(r.error as Error).message}`]
      : [],
  )
  // a server that is up but did not answer stays in the list, empty and partial, so a reader can tell its sessions from ended ones
  return reads.flatMap((r) =>
    "read" in r
      ? [r.read]
      : r.error instanceof HerdrDown
        ? []
        : [{ panes: [], partial: true as const, server: r.server.name, workspaces: [] }],
  )
}

// herdr's agent status as the lifecycle words lightOf() reads: blocked waits on a person, working runs, idle and done wait for input (the dashboard never tells done from idle, so it never calls focus, the one call that turns done into idle).
const LIFECYCLE: Record<(typeof STATUSES)[number], string> = {
  blocked: "needsInput",
  done: "idle",
  idle: "idle",
  unknown: "unknown",
  working: "running",
}

// The C5 hooks' states in the same words.
const FILED: Record<SessionState["state"], string> = {
  failed: "idle",
  idle: "idle",
  stuck: "needsInput",
  "usage-limit": "needsInput",
  working: "running",
}

// Pure: the program an argv runs is codex, run directly or as npm's launcher under node.
const runsCodex = (argv: string[]) => {
  const program = /(^|\/)node$/.test(argv[0] ?? "") ? argv[1] : argv[0]
  return /(^|\/)codex$/.test(program ?? "")
}

// The session a pane holds, its agent and the process that runs it, or null. A Codex session writes no Claude registry file, so its pane holds it when the pane's label has a Codex launch record (codexLaunches) and a codex process runs in its foreground.
function paneSession(
  pane: Pane,
  registry: Registry,
  codex: CodexLaunches,
): { agent: "claude" | "codex"; proc: Pane["processes"][number]; sessionId: string } | null {
  const thread = pane.label ? codex.get(pane.label) : undefined
  const codexProc = thread ? pane.processes.find((p) => runsCodex(p.argv ?? [])) : undefined
  if (thread && codexProc) return { agent: "codex", proc: codexProc, sessionId: thread }
  const registered = pane.processes.find((p) => registry?.get(p.pid))
  const registeredId = registered && registry?.get(registered.pid)?.sessionId
  if (registered)
    return registeredId ? { agent: "claude", proc: registered, sessionId: registeredId } : null
  const unread = pane.processes.find((p) => registry === null || registry.get(p.pid) === null)
  return unread && pane.agent_session?.kind === "id" && pane.agent_session.value
    ? { agent: "claude", proc: unread, sessionId: pane.agent_session.value }
    : null
}

// Pure but for the change times (state.changed: when each session's herdr state last changed, as this process saw it, by its terminal and session, which a move does not change; herdr keeps no such time, and answeredSince() compares a picker's answer with it): every server's panes as the session records liveRecords() and composeWorkers() read. A pane holds a session when a process in its foreground has a registry file naming one, so a pane whose Claude has exited, or one never registered, is no session (St3); a file mid-rewrite leaves herdr's own agent_session, when it has one.
export function herdrRecords(
  reads: ServerRead[],
  registry: Registry,
  now: string,
  codex: CodexLaunches = new Map(),
): Json[] {
  const changes = new Map<string, Change>()
  const records = reads.flatMap((read) =>
    read.panes.flatMap((pane) => {
      const held = paneSession(pane, registry, codex)
      if (!held) return []
      const { agent, proc, sessionId } = held
      const key = `${read.server}:${pane.terminal_id}:${sessionId}`
      const known = state.changed.get(key)
      // a read more than SEEN_SLACK_MS after the last can hide a change and back (a picker answered, then a permission raised), so its state began at some time unknown, as on a fresh process
      const recent =
        known !== undefined && Date.parse(now) - Date.parse(known.read) <= SEEN_SLACK_MS
      const same = recent && known.status === pane.agent_status
      const at = same ? known.at : now
      const seen = same ? known.seen : recent
      changes.set(key, { at, read: now, seen, server: read.server, status: pane.agent_status })
      const cwd = proc.cwd ?? ""
      return [
        {
          agent,
          agent_lifecycle: LIFECYCLE[pane.agent_status],
          cwd,
          herdr_seen_at: seen ? at : null,
          herdr_status: pane.agent_status,
          launch_arguments: proc.argv ?? [],
          launch_backed: true,
          pid: proc.pid,
          session_id: sessionId,
          started_at: null,
          stored_pid_exists: true,
          surface_id: herdrSurface(read.server, pane.pane_id),
          transcript_path:
            agent === "claude" && cwd ? transcriptPath(claudeDir(), cwd, sessionId) : "",
          updated_at: at,
          workspace_id: herdrSurface(read.server, pane.workspace_id),
        },
      ]
    }),
  )
  // a board that did not read a server whole (a failed or partial read) keeps that server's times for every session it did not see
  const whole = new Set(reads.filter((read) => !read.partial).map((read) => read.server))
  for (const [key, change] of state.changed)
    if (!whole.has(change.server) && !changes.has(key)) changes.set(key, change)
  state.changed = changes
  return records
}

// The sessions spawn.sh started in Codex, by name: each one whose backend pin names the codex harness, with the thread its resume record's exec line names (spawn.sh resume <name> <folder> <thread>).
export type CodexLaunches = Map<string, string>

export function codexLaunches(data = dataDir()): CodexLaunches {
  const out: CodexLaunches = new Map()
  let names: string[] = []
  try {
    names = readdirSync(join(data, "backends"))
  } catch {
    return out
  }
  for (const name of names) {
    try {
      if (readPin(readFileSync(join(data, "backends", name), "utf8"))?.harness !== "codex") continue
      const exec = readFileSync(join(data, "resume", `${name}.sh`), "utf8")
        .split("\n")
        .find((line) => line.startsWith("exec "))
      // spawn.sh writes the line with %q, so a folder may hold an escaped space: the name follows resume, and the thread ends the line
      const words = exec?.match(/ resume (\S+) .* ([0-9a-f-]{36})$/)
      if (words?.[1] === name && words[2]) out.set(name, words[2])
    } catch {}
  }
  return out
}

// Pure: every server's workspaces in the board's workspace list, each id its ref too.
export const herdrWorkspaces = (reads: ServerRead[]): Json[] =>
  reads.flatMap((read) =>
    read.workspaces.map((w) => {
      const id = herdrSurface(read.server, w.workspace_id)
      return { custom_title: null, id, ref: id, title: w.label || null }
    }),
  )

// What a herdr session's prompt is, as its own hooks' stuck record names it: the subagent that asked (agentId), the kind (reason: permission, question, plan, elicitation, login) and the tool a permission is for. herdrFeed() in workers.ts builds its card from it.
export type HerdrWait = { agentId: string | null; reason: string | null; tool: string | null }

// Pure: a herdr session's lifecycle, its usage limit and, while it waits on a prompt its hooks named, that prompt (wait). herdr's own state comes first, since C5's hooks report every state to it (a probe); the hooks' own file (C5) speaks where herdr has none (unknown), and for what herdr's state cannot say: a usage limit and its reset. A stuck record the transcript has moved past (an Escape on a prompt fires no hook, measured) also ends the blocked state the same hook reported to herdr, which herdr keeps until the next prompt or stop, but only while it is the prompt herdr shows: written no earlier than the blocked state this process saw begin (`seenAt`), less the time a board takes to see it, since a session resumed without its settings runs without its hooks and its file keeps an older record; with no start seen (the dashboard started, or its reads paused, after the prompt), any stuck record is taken as that prompt, so a stale one can read a restored session's new prompt as idle until its next.
export function herdrState(
  status: string,
  file: SessionState | null,
  newestTurnAt: string | null,
  seenAt: string | null = null,
): { lifecycle: string; usageLimit: UsageLimit | null; wait: HerdrWait | null } {
  const filed = file ? stateNow(file, newestTurnAt) : null
  const usageLimit =
    filed === "usage-limit" ? { resets: null, resetsAt: file?.resetsAt ?? null } : null
  const showing =
    file?.state === "stuck" &&
    (!seenAt || Date.parse(file.at) >= Date.parse(seenAt) - SEEN_SLACK_MS)
  if (status === "blocked" && showing && filed === null)
    return { lifecycle: "idle", usageLimit, wait: null }
  const own = LIFECYCLE[status as (typeof STATUSES)[number]] ?? "unknown"
  const lifecycle = own !== "unknown" ? own : filed ? FILED[filed] : "unknown"
  const wait =
    lifecycle === "needsInput" && showing && filed === "stuck" && file
      ? { agentId: file.agentId ?? null, reason: file.reason ?? null, tool: file.tool ?? null }
      : null
  return { lifecycle, usageLimit, wait }
}

// Each herdr session's C5 file, null when it has none or it does not read.
export const readStates = async (sessionIds: string[]): Promise<Map<string, SessionState | null>> =>
  new Map(
    await Promise.all(
      sessionIds.map(
        async (id) =>
          [
            id,
            await Bun.file(join(sessionStateDir(dataDir()), `${id}.json`))
              .text()
              .then(parseSessionState, () => null),
          ] as const,
      ),
    ),
  )

// Pure: the herdr records with herdrState() applied, each one's lifecycle, the prompt its hooks named (`herdr_wait`, which composeWorkers() builds its card from) and, while the usage limit alone holds it, `usage_limit`, which composeWorkers() reads as Worker.usageLimit. A record without herdr's status passes as it is.
export const withHerdrState = <T extends { sessions: Json[] }>(
  records: T,
  files: Map<string, SessionState | null>,
  turnAt: (sessionId: string) => string | null,
): T => ({
  ...records,
  sessions: records.sessions.map((record) => {
    if (typeof record.herdr_status !== "string") return record
    const id = String(record.session_id)
    const { lifecycle, usageLimit, wait } = herdrState(
      record.herdr_status,
      files.get(id) ?? null,
      turnAt(id),
      typeof record.herdr_seen_at === "string" ? record.herdr_seen_at : null,
    )
    return { ...record, agent_lifecycle: lifecycle, herdr_wait: wait, usage_limit: usageLimit }
  }),
})

// One session's screen, the newest `lines` rows as they show now (`visible`, never `recent`, which past the screen scrolls the session; Agent automation § Alternate-screen history reads). A pane scrolled up shows its history rather than its input box, so it is refused.
export async function readScreen(surface: string, lines: number): Promise<string> {
  const { pane, server } = paneAt(surface)
  const info = paneInfoSchema.safeParse(await request(server.socket, "pane.get", { pane_id: pane }))
  if (!info.success) throw new HerdrRefused("pane.get", "malformed", "no pane")
  const offset = info.data.pane.scroll?.offset_from_bottom ?? 0
  if (offset > 0) {
    throw new HerdrRefused("pane.read", "scrolled", `${surface} is scrolled up ${offset} lines`)
  }
  const read = readSchema.safeParse(
    await request(server.socket, "pane.read", { lines, pane_id: pane, source: "visible" }),
  )
  if (!read.success) throw new HerdrRefused("pane.read", "malformed", "no text")
  return read.data.read.text
}

// A message into one session as one ordered submission, the text by bracketed paste and then Enter (`agent prompt`, Agent automation § Choose the control surface). herdr has no draft guard, so deliver() and compactIdle() read the input first. It sends only for deliver.ts and idle-compact.ts's `/compact` (herdr.test.ts's "who prompts").
export async function prompt(surface: string, text: string): Promise<void> {
  const { pane, server } = paneAt(surface)
  await request(server.socket, "agent.prompt", { target: pane, text }, 10_000)
}

// One Enter into one session, for a message prompt() pasted whose own Enter did not land. It sends only for deliver.ts, after it has read the box holding that message (herdr.test.ts's "who prompts").
export async function pressEnter(surface: string): Promise<void> {
  const { pane, server } = paneAt(surface)
  await request(server.socket, "pane.send_keys", { keys: ["enter"], pane_id: pane })
}

// What a failed prompt left behind, for deliver(): `typed` when it may have gone (a timeout, a prompt herdr saw stall, a connection dropped after the request, or an answer that does not read, since herdr had the request), `picker` when herdr refused before sending because the session waits on a prompt, `gone` when no Claude holds the pane any more, and `unsent` for any other refusal, which typed nothing.
export const promptOutcome = (error: unknown): "gone" | "picker" | "typed" | "unsent" => {
  if (error instanceof HerdrTimedOut) return "typed"
  if (!(error instanceof HerdrRefused)) return "unsent"
  if (["agent_prompt_stalled", "malformed", "timeout"].includes(error.reason)) return "typed"
  if (error.reason === "agent_blocked") return "picker"
  return /not_found|not_running/.test(error.reason) ? "gone" : "unsent"
}

// A picker Claude Code draws in a pane, as answerKeys() reads it: the words above its options, flattened to single spaces, and the rows the cursor (❯) moves over, in order, each with its number, its words, whether the cursor stands on it, and a multi-select's box, checked or not (null with none). A multi-select's Submit row has no number (0). No numbered list from 1 on the screen is no prompt (`options` empty).
export type ScreenOption = { checked: boolean | null; label: string; number: number; on: boolean }
export type ScreenPrompt = { options: ScreenOption[]; text: string }

const OPTION_LINE = /^\s*([❯›>])?\s*(\d{1,2})\.\s+(?:\[([ xX✔✓])\]\s*)?(.*?)\s*$/
const SUBMIT_LINE = /^\s*([❯›>])?\s*(Submit|Next)\s*$/
const flat = (text: string): string => text.replace(/\s+/g, " ").trim()

// Pure: the last numbered list on the screen that counts up from 1 (a description, a rule or a multi-select's Submit row may sit between two options), and the words above it.
export function promptOnScreen(screen: string): ScreenPrompt {
  const lines = screen.split("\n")
  let start = -1
  let options: ScreenOption[] = []
  let last = 0
  for (const [i, line] of lines.entries()) {
    const [, submitOn, submit] = SUBMIT_LINE.exec(line) ?? []
    if (submit && start >= 0) {
      options.push({ checked: null, label: submit, number: 0, on: Boolean(submitOn) })
      continue
    }
    const [, cursor, number, box, label] = OPTION_LINE.exec(line) ?? []
    if (!number) continue
    const option = {
      checked: box === undefined ? null : box !== " ",
      label: flat(label ?? ""),
      number: Number(number),
      on: Boolean(cursor),
    }
    if (option.number === 1) {
      start = i
      options = [option]
      last = 1
    } else if (option.number === last + 1) {
      options.push(option)
      last = option.number
    }
  }
  return start < 0
    ? { options: [], text: "" }
    : { options, text: flat(lines.slice(0, start).join(" ")) }
}

// One key a request, by herdr's key names, or words typed as they are (`pane.send_text`).
export type KeyStep = { key: "down" | "enter" | "space" | "up" | `${number}` } | { text: string }

// One answer to a picker's one question as the keys see it: its option labels in order, and the labels picked or the person's own words.
export type Ask = {
  choices: string[]
  labels: string[]
  multiSelect: boolean
  prompt: string
  text: string | null
}

const OWN_WORDS = /^Type something\b/i

// Pure: whether the pane shows the question an answer is for, its words over its option labels in order. answerKeys() types nothing unless it does, and answerHerdr() reads the question as answered once it does not.
export const showsAsk = (screen: ScreenPrompt, ask: Ask): boolean =>
  screen.options.length > 0 &&
  screen.text.includes(flat(ask.prompt)) &&
  ask.labels.every((label, i) => screen.options[i]?.label === flat(label))

// Pure: a multi-select, or a picker of several questions, ends on a review whose Submit answers option sends them; its keys, or null when the pane shows none.
export const submitKeys = (screen: ScreenPrompt): KeyStep[] | null => {
  const submit = screen.options.find((o) => /^Submit answers?\b/i.test(o.label))
  return submit ? [{ key: `${submit.number}` }] : null
}

type Keys = { keys: KeyStep[]; ok: true } | { ok: false; reason: string }

const moves = (from: number, to: number): KeyStep[] =>
  Array.from({ length: Math.abs(to - from) }, () => ({
    key: to > from ? "down" : "up",
  }))

// Pure: the keys that give one answer to the question the pane shows, or why that question is not the one asked (showsAsk() fails, no cursor shows, or a row the answer needs is missing), so nothing is typed: the arrows move the cursor and Enter picks, Space first ticks a multi-select's boxes and it ends on its Submit row, and the person's own words go in its "Type something" row.
export function answerKeys(screen: ScreenPrompt, ask: Ask): Keys {
  const { options } = screen
  const refuse = (reason: string): Keys => ({ ok: false, reason })
  if (!showsAsk(screen, ask) || options.length <= ask.labels.length) {
    return refuse(`the pane does not show "${flat(ask.prompt)}" with its options`)
  }
  const cursor = options.findIndex((o) => o.on)
  if (cursor < 0) return refuse("the pane shows no cursor on the options")
  if (ask.text) {
    const own = ask.labels.length
    if (!OWN_WORDS.test(options[own]?.label ?? "")) {
      return refuse("the pane shows no row for your own words after the options")
    }
    return { keys: [...moves(cursor, own), { text: ask.text }, { key: "enter" }], ok: true }
  }
  const picked = ask.choices.map((c) => ask.labels.indexOf(c))
  if (!ask.multiSelect) {
    return { keys: [...moves(cursor, picked[0] ?? 0), { key: "enter" }], ok: true }
  }
  if (ask.labels.some((_, i) => options[i]?.checked === null)) {
    return refuse("the pane shows no boxes to tick")
  }
  const submit = options.findIndex(
    (o, i) => i >= ask.labels.length && /^(?:Submit|Next)\b/i.test(o.label),
  )
  if (submit < 0) return refuse("the pane shows no Submit row")
  const keys: KeyStep[] = []
  let at = cursor
  for (const [i] of ask.labels.entries()) {
    if (options[i]?.checked === picked.includes(i)) continue
    keys.push(...moves(at, i), { key: "space" })
    at = i
  }
  return { keys: [...keys, ...moves(at, submit), { key: "enter" }], ok: true }
}

// The gap between two keys, so Claude Code reads each as its own press rather than one chunk of input.
const KEY_GAP_MS = 40

// Answers a prompt with the keys answerKeys() gave, one request each (`pane.send_keys`, words by `pane.send_text`), in order. It types only for answerHerdr() in feed.ts, the owner's own Submit on the prompt's card (herdr.test.ts's "herdr's pane writes").
export async function typeKeys(surface: string, steps: KeyStep[]): Promise<void> {
  const { pane, server } = paneAt(surface)
  for (const [i, step] of steps.entries()) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, KEY_GAP_MS))
    if ("key" in step) {
      await request(server.socket, "pane.send_keys", {
        keys: [step.key],
        pane_id: pane,
      })
    } else {
      await request(server.socket, "pane.send_text", {
        pane_id: pane,
        text: step.text,
      })
    }
  }
}

// The events that move the board: a pane opening, closing, exiting, moving or changing, and each pane's agent status, subscribed to pane by pane since that subscription names one pane (Socket API § Event subscriptions).
export const WATCHED = [
  "pane.agent_detected",
  "pane.closed",
  "pane.created",
  "pane.exited",
  "pane.moved",
  "pane.updated",
  "workspace.closed",
  "workspace.created",
  "workspace.renamed",
]

// Events after which the panes subscribed to are not the panes there are, by the names herdr gives an event frame (its EventKind, `pane_created`), not the dotted names a subscription asks for (`herdr api schema --json`).
export const RESUBSCRIBE = new Set(["pane_closed", "pane_created", "pane_exited", "pane_moved"])

const RETRY_MS = 1000
const RETRY_MAX_MS = 10_000

export type HerdrEvents = {
  kill: () => void
  stdout: AsyncIterable<Uint8Array>
}

// The hub's herdr events, every server on one stream that ends only when killed, each event a line movesTheBoard() reads as a move. A subscription that closes, fails or is told `events_lost` is opened again (after RETRY_MS, doubling to RETRY_MAX_MS while its server stays down), and each one that starts is an `ack` line, so the hub reads the board afresh: events are not durable, so what was missed is caught by that read rather than replayed.
export function herdrEvents(servers = herdrServers(), retryMs = RETRY_MS): HerdrEvents {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let killed = false
  const conns = new Set<{ end: () => void }>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const emit = (line: Json) => {
    if (!killed) controller?.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
  }
  const later = (run: () => void, ms: number) => {
    if (killed) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!killed) run()
    }, ms)
    timers.add(timer)
  }
  const watch = (server: HerdrServer) => {
    // the fixture's server has no events: fixture.ts's onFixtureChange moves the hub instead
    if (server.socket === FIXTURE_SOCKET) return
    let current: { end: () => void } | null = null
    let wait = retryMs
    const again = (ms: number) => {
      const closing = current
      current = null
      closing?.end()
      later(() => void open(), ms)
    }
    const backoff = () => {
      again(wait)
      wait = Math.min(wait * 2, RETRY_MAX_MS)
    }
    const open = async () => {
      let panes: unknown[] = []
      try {
        const snapshot = snapshotSchema.safeParse(
          await request(server.socket, "session.snapshot", {}),
        )
        panes = snapshot.success ? snapshot.data.snapshot.panes : []
      } catch {
        return backoff()
      }
      const subscriptions = [
        ...WATCHED.map((type) => ({ type })),
        ...each(paneSchema, panes).map((pane) => ({
          pane_id: pane.pane_id,
          type: "pane.agent_status_changed",
        })),
      ]
      const decoder = new TextDecoder()
      let buffered = ""
      let subscribe: (socket: Writable) => void = () => {}
      let conn: Awaited<ReturnType<typeof Bun.connect>>
      try {
        conn = await Bun.connect({
          socket: {
            drain: (socket) => subscribe(socket),
            close: () => {
              conns.delete(conn)
              if (current === conn) backoff()
            },
            data: (_socket, chunk) => {
              buffered += decoder.decode(chunk, { stream: true })
              const lines = buffered.split("\n")
              buffered = lines.pop() ?? ""
              for (const line of lines) {
                // a subscription given up (a resubscribe earlier in this chunk) says nothing more, so it never opens another
                if (current !== conn) return
                let event: unknown
                try {
                  event = JSON.parse(line)
                } catch {
                  continue
                }
                const parsed = eventSchema.safeParse(event)
                if (!parsed.success) continue
                const { error, event: name, result } = parsed.data
                if (result?.type === "subscription_started") {
                  wait = retryMs
                  emit({ type: "ack" })
                } else if (error) {
                  // events_lost, or a pane gone before the subscription took: subscribe afresh, more slowly each time herdr refuses again, and the ack makes the hub read the board again
                  backoff()
                } else if (name) {
                  emit({ name: `herdr.${name}`, type: "event" })
                  if (RESUBSCRIBE.has(name)) again(0)
                }
              }
            },
            error: () => {},
          },
          unix: server.socket,
        })
      } catch {
        return backoff()
      }
      if (killed) return void conn.end()
      current = conn
      conns.add(conn)
      subscribe = lineWriter(
        JSON.stringify({
          id: `dashboard:events:${++state.ids}`,
          method: "events.subscribe",
          params: { subscriptions },
        }),
      )
      subscribe(conn)
    }
    void open()
  }
  const kill = () => {
    if (killed) return
    killed = true
    for (const timer of timers) clearTimeout(timer)
    for (const conn of conns) conn.end()
    try {
      controller?.close()
    } catch {}
  }
  const stdout = new ReadableStream<Uint8Array>({
    cancel: kill,
    start: (c) => {
      controller = c
      for (const server of servers) watch(server)
    },
  })
  return { kill, stdout }
}

const eventSchema = z.object({
  error: z.object({ code: z.string() }).optional(),
  event: z.string().optional(),
  result: z.object({ type: z.string() }).optional(),
})
