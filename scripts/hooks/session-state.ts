// Notification, PermissionDenied, PermissionRequest, PostToolUse, PostToolUseFailure, SessionEnd, Stop, StopFailure and UserPromptSubmit hook: writes the session's state to the file ops-session-resume reads and the Dashboard is to read, the data folder's session-state/<session id>.json, in the shape packages/config/src/session-state.ts checks, and inside herdr reports it as herdr's own state, handing the pane back when the session ends. A stuck or failed record also queues one alert to the session's manager (packages/scripts/src/stuck-alert.ts). Every session writes it, the owner's own included, since the Dashboard is to show them all. It never blocks: whatever fails, the hook exits 0. The file also holds the caller check the shell-pane launcher runs (sessionAbove, callerRefusal).
import { readFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { basename, join } from "node:path"

import type { SessionState } from "../../packages/config/src/session-state"
import { dataDir } from "../../packages/env/src/data-dir"
import { alertFor } from "../../packages/scripts/src/stuck-alert"
import { writeAtomic } from "../../packages/scripts/src/write-atomic"
import { input } from "./input"
import { loadNames } from "./role"

type Environment = Record<string, string | undefined>
type Input = Record<string, unknown>

// zod cannot load here (bun keeps it in the packages that depend on it), so the folder is spelled out and a test holds it to sessionStateDir.
export const statePath = (environment: Environment, sessionId: string): string =>
  join(dataDir(environment), "session-state", `${sessionId}.json`)

const PROMPTS: Record<string, string> = { AskUserQuestion: "question", ExitPlanMode: "plan" }
const NOTICES: Record<string, Pick<SessionState, "reason" | "state">> = {
  elicitation_dialog: { reason: "elicitation", state: "stuck" },
  idle_prompt: { state: "idle" },
  permission_prompt: { reason: "permission", state: "stuck" },
}
const USAGE_LIMIT = /usage limit reached|hit your [\w -]*limit|limit will reset/i
// Z.ai's empty balance (31 Oct: "429 · [1113][Insufficient balance or no resource package. Please recharge.]"), which its quota endpoint never reports, so the zai usage job reads it from this record.
const GLM_BALANCE = /\[1113\]/
// GLM prints its reset in UTC+8 (16 Oct: "reset at 2026-10-16 19:00:02" still printed at 10:09Z, on a 5-hour window).
const GLM_RESET = /limit will reset at (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/
const TAIL_BYTES = 256 * 1024
// The events that end a tool call: it ran, it failed once it ran, or its permission was denied.
const TOOL_ENDS = new Set(["PermissionDenied", "PostToolUse", "PostToolUseFailure"])

const text = (value: unknown): string => (typeof value === "string" ? value : "")

// Claude's own limit line in the transcript carries the reset as epoch seconds, on quotaLimits or apiErrorParams.rate_limit_info.
async function transcriptReset(path: string): Promise<string | undefined> {
  const file = await open(path, "r").catch(() => null)
  if (!file) return undefined
  try {
    const { size } = await file.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const { buffer, bytesRead } = await file.read(
      Buffer.alloc(size - start),
      0,
      size - start,
      start,
    )
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n").reverse()
    for (const line of lines) {
      if (!line.includes('"isApiErrorMessage":true')) continue
      try {
        const entry = JSON.parse(line) as {
          apiErrorParams?: { rate_limit_info?: { resetsAt?: unknown } }
          quotaLimits?: { resetsAt?: unknown }
        }
        const at = entry.quotaLimits?.resetsAt ?? entry.apiErrorParams?.rate_limit_info?.resetsAt
        if (typeof at === "number") return new Date(at * 1000).toISOString()
      } catch {}
      return undefined
    }
  } finally {
    await file.close()
  }
}

async function resetOf(input: Input): Promise<string | undefined> {
  const glm = GLM_RESET.exec(text(input.last_assistant_message))
  if (glm) {
    const at = Date.parse(`${glm[1]}T${glm[2]}+08:00`)
    return Number.isNaN(at) ? undefined : new Date(at).toISOString()
  }
  return transcriptReset(text(input.transcript_path))
}

async function failureOf(
  input: Input,
): Promise<Pick<SessionState, "reason" | "resetsAt" | "state">> {
  const error = text(input.error) || "unknown"
  if (error === "authentication_failed") return { reason: "login", state: "stuck" }
  if (error === "rate_limit" && GLM_BALANCE.test(text(input.last_assistant_message)))
    return { reason: "balance", state: "failed" }
  if (error === "rate_limit" && USAGE_LIMIT.test(text(input.last_assistant_message))) {
    const resetsAt = await resetOf(input)
    return { reason: error, ...(resetsAt ? { resetsAt } : {}), state: "usage-limit" }
  }
  return { reason: error, state: "failed" }
}

// The record an event writes, or null for one that says nothing about the session's state.
export async function recordOf(input: Input, now = new Date()): Promise<SessionState | null> {
  const sessionId = text(input.session_id)
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null
  const event = text(input.hook_event_name)
  const head = { at: now.toISOString(), event, sessionId }
  const agentId = text(input.agent_id)
  const agent = agentId ? { agentId } : {}
  switch (event) {
    case "UserPromptSubmit":
      return { ...head, state: "working" }
    case "PermissionDenied":
    case "PostToolUse":
    case "PostToolUseFailure": {
      const tool = text(input.tool_name)
      return { ...head, ...agent, state: "working", ...(tool ? { tool } : {}) }
    }
    case "Stop":
      return { ...head, state: "idle" }
    case "PermissionRequest": {
      const tool = text(input.tool_name)
      return {
        ...head,
        ...agent,
        reason: PROMPTS[tool] ?? "permission",
        state: "stuck",
        ...(tool ? { tool } : {}),
      }
    }
    case "Notification": {
      const notice = NOTICES[text(input.notification_type)]
      return notice ? { ...head, ...agent, ...notice } : null
    }
    case "StopFailure":
      return { ...head, ...(await failureOf(input)) }
    default:
      return null
  }
}

const HERDR_STATE: Record<SessionState["state"], string> = {
  failed: "blocked",
  idle: "idle",
  stuck: "blocked",
  "usage-limit": "blocked",
  working: "working",
}

// herdr's documented route for a custom reporter (Add Herdr support § Report state): a source of our own and a seq that only rises, or herdr drops the report. The agent is claude, the kind the pane runs, though the docs ask a reporter for its own name: a reporter's agent outranks the process herdr detects, and agent.prompt types only into a kind it knows, so a name of our own left every session unpromptable (agent_not_ready). With no record the session has ended, and release-agent hands the pane back to herdr's own detection of claude, which keeps reading it while claude runs and clears it once claude exits, so a pane that outlives claude never keeps our last report.
export function herdrArgs(
  record: SessionState | null,
  environment: Environment,
  seq: number,
): string[] | null {
  const { HERDR_BIN_PATH: bin, HERDR_ENV: inside, HERDR_PANE_ID: pane } = environment
  if (inside !== "1" || !bin || !pane) return null
  const source = ["--source", "custom:playground", "--agent", "claude"]
  return record
    ? [
        bin,
        "pane",
        "report-agent",
        pane,
        ...source,
        "--state",
        HERDR_STATE[record.state],
        "--seq",
        String(seq),
      ]
    : [bin, "pane", "release-agent", pane, ...source, "--seq", String(seq)]
}

// A detached child sends the report with a 2s timeout, so herdr never holds the session up.
function report(args: string[] | null): void {
  if (args)
    Bun.spawn([process.execPath, import.meta.path, "--report", ...args], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    }).unref()
}

// Microseconds of the wall clock, which every hook process shares, so two reports in one millisecond still rise.
const seqNow = (): number => Math.floor((performance.timeOrigin + performance.now()) * 1000)

const HELD = new Set<string>(["failed", "stuck", "usage-limit"])

// Pure: whether a record replaces the one the session's file holds. A tool that ran, failed once it ran, or was denied ends the prompt it waited on, one asked by the same agent about the same tool (PermissionRequest carries no tool_use_id, and a picker's PostToolUse input adds the answers), and a main-agent tool after a Stop or a StopFailure means the turn went on (a Stop hook continued it: the inbox gate, the ticket skill's keep-going; or a line the session was sent), so it reads working again, while a login stays stuck until a prompt; a subagent's tool after a Stop is a background run, the session itself still idle. Otherwise it writes nothing, so the hook that runs after every tool stays one file read, and one write per continued turn. A notice only restates what an event already wrote: the permission notice lands about 6s after the PermissionRequest that names the prompt's tool, so after that prompt's tool has run too, and the idle notice 60s after a turn ends, a turn on a usage limit included. So a notice never replaces a record that says why the session waits, and the permission notice never replaces the record of the tool that ran.
export function replaces(record: SessionState, held: Partial<SessionState> | null): boolean {
  if (TOOL_ENDS.has(record.event))
    return (
      (!record.agentId &&
        (held?.state === "idle" || held?.state === "failed" || held?.state === "usage-limit")) ||
      (held?.state === "stuck" &&
        held.reason !== "login" &&
        held.agentId === record.agentId &&
        (!held.tool || held.tool === record.tool))
    )
  if (record.event === "Notification")
    return (
      !(held?.state && HELD.has(held.state)) &&
      !(record.reason === "permission" && TOOL_ENDS.has(held?.event ?? ""))
    )
  return true
}

export async function run(
  raw: string,
  environment: Environment = process.env,
  now = new Date(),
): Promise<void> {
  try {
    const input = JSON.parse(raw) as Input
    if (input.hook_event_name === "SessionEnd")
      return report(herdrArgs(null, environment, seqNow()))
    const record = await recordOf(input, now)
    if (!record) return
    const path = statePath(environment, record.sessionId)
    if (record.event === "Notification" || TOOL_ENDS.has(record.event)) {
      const held = (await Bun.file(path)
        .json()
        .catch(() => null)) as Partial<SessionState> | null
      if (!replaces(record, held)) return
    }
    await writeAtomic(path, `${JSON.stringify(record)}\n`)
    report(herdrArgs(record, environment, seqNow()))
    if (record.state === "stuck" || record.state === "failed") {
      await loadNames(environment)
      await alertFor(input, record, environment, now)
    }
  } catch {}
}

// How many parent processes the launcher climbs looking for its claude process: a Bash call's shell sits one or two below it.
const HOPS = 32

// A process as the kernel reports it, which no prefix on a Bash call reaches: its parent, its executable's name, and, for a claude process alone, the environment it was started with.
export type Proc = { comm: string; env: Environment; ppid: number }

const isClaude = (comm: string) => basename(comm) === "claude"

// An environment's KEY=value entries in one line, as ps -E prints them after the arguments; a value that holds a space and a KEY= reads as two entries.
const entriesOf = (line: string): Environment => {
  const env: Environment = {}
  const keys = [...line.matchAll(/(?:^| )([A-Za-z_][A-Za-z0-9_]*)=/g)]
  keys.forEach((key, i) => {
    env[key[1]!] = line.slice(key.index + key[0].length, keys[i + 1]?.index ?? line.length)
  })
  return env
}

// A process read through /proc on Linux, or through ps by its absolute path on macOS, so a PATH the caller sets names no other ps; undefined when the process is gone.
export function procOf(pid: number): Proc | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim()
      const env = isClaude(comm)
        ? Object.fromEntries(
            readFileSync(`/proc/${pid}/environ`, "utf8")
              .split("\0")
              .filter((entry) => entry.includes("="))
              .map((entry) => [
                entry.slice(0, entry.indexOf("=")),
                entry.slice(entry.indexOf("=") + 1),
              ]),
          )
        : {}
      return { comm, env, ppid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || 0 }
    } catch {
      return undefined
    }
  }
  const ps = (field: string, ...flags: string[]) =>
    Bun.spawnSync(["/bin/ps", ...flags, "-ww", "-o", `${field}=`, "-p", String(pid)], {
      stderr: "ignore",
    })
      .stdout.toString()
      .replace(/\n$/, "")
  const comm = ps("comm").trim()
  if (!comm) return undefined
  const claude = isClaude(comm)
  const args = claude ? ps("command") : ""
  const full = claude ? ps("command", "-E") : ""
  const env = full.startsWith(args) ? entriesOf(full.slice(args.length).trim()) : {}
  return { comm, env, ppid: Number(ps("ppid").trim()) || 0 }
}

// The claude process a Bash call runs under, the nearest at or above `pid` whose executable is claude: the role it was started with, and the session id Claude Code's registry holds for it (<config>/sessions/<pid>.json, whose pid is that process's), the config folder named by that process's own CLAUDE_CONFIG_DIR, else its own HOME's .claude, so a prefix that drops PLAYGROUND_ROLE or moves CLAUDE_CONFIG_DIR or HOME changes nothing it reads. A claude process whose environment reads back empty is returned with no role and no session id, so callerRefusal refuses it. Its reader: callerRefusal, below, refuses when it finds none.
export async function sessionAbove(
  pid: number = process.ppid,
  procs: (pid: number) => Proc | undefined = procOf,
): Promise<{ pid: number; role: string; sessionId?: string } | undefined> {
  const above = await claudeAbove(pid, procs)
  if (!above) return undefined
  const { config: _config, env: _env, ...session } = above
  return session
}

// sessionAbove's walk with the claude process's own environment and the config folder its registry was read from, for a reader that reads every folder from that process rather than its caller (ship:yard's launch).
export async function claudeAbove(
  pid: number = process.ppid,
  procs: (pid: number) => Proc | undefined = procOf,
): Promise<
  { config?: string; env: Environment; pid: number; role: string; sessionId?: string } | undefined
> {
  for (let at = pid, hop = 0; at > 1 && hop < HOPS; hop++) {
    const proc = procs(at)
    if (!proc) return undefined
    if (isClaude(proc.comm)) {
      if (!Object.keys(proc.env).length) return { env: {}, pid: at, role: "" }
      const config =
        proc.env.CLAUDE_CONFIG_DIR || (proc.env.HOME ? join(proc.env.HOME, ".claude") : "")
      const entry = (
        config
          ? await Bun.file(join(config, "sessions", `${at}.json`))
              .json()
              .catch(() => null)
          : null
      ) as { pid?: unknown; sessionId?: unknown } | null
      const sessionId =
        entry?.pid === at && typeof entry.sessionId === "string" ? entry.sessionId : undefined
      return {
        config: config || undefined,
        env: proc.env,
        pid: at,
        role: proc.env.PLAYGROUND_ROLE ?? "",
        sessionId,
      }
    }
    at = proc.ppid
  }
}

// Why the shell-pane launcher refuses a caller whose environment names a session id or role other than its claude process's (sessionAbove); undefined when both match.
export async function callerRefusal(
  environment: Environment = process.env,
  pid: number = process.ppid,
  procs: (pid: number) => Proc | undefined = procOf,
): Promise<string | undefined> {
  const above = await sessionAbove(pid, procs)
  if (!above)
    return "shell-pane refuses: no Claude Code session runs above it, so it cannot check the session id and role its environment names"
  if (!above.sessionId)
    return `shell-pane refuses: Claude Code's registry names no session for the claude process above it (${above.pid})`
  const named = environment.CLAUDE_CODE_SESSION_ID
  if (named !== above.sessionId)
    return `shell-pane refuses: its CLAUDE_CODE_SESSION_ID (${named ?? "unset"}) is not the session it runs under (${above.sessionId})`
  const role = environment.PLAYGROUND_ROLE ?? ""
  if (role !== above.role)
    return `shell-pane refuses: its PLAYGROUND_ROLE (${role || "unset"}) is not the role its claude process was started with (${above.role || "unset"})`
}

if (import.meta.main) {
  if (process.argv[2] === "--report") {
    const [bin = "", ...rest] = process.argv.slice(3)
    const child = Bun.spawn([bin, ...rest], { stderr: "ignore", stdout: "ignore", timeout: 2000 })
    await child.exited
  } else await run(await input("session-state", "recorder"))
}
