import "@packages/env/aliases"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  query,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { PERMISSION_MODE_LABELS } from "@packages/config/console"
import { SDK_PROBE } from "@packages/config/kinds"
import type { LocalModel } from "@packages/config/org"
import type { ActivityActor, ActivityEvent } from "@packages/db"
import { env } from "@packages/env/api-hono"
import { dataDirOf } from "@packages/env/data-dir"

import { claudeBinary } from "@/lib/claude-binary"
import { withAttachments } from "@/lib/dashboard/attachments"
import {
  deliverDeps,
  deliveryEvent,
  deliveryWords,
  type Delivery,
  type DeliveryResult,
} from "@/lib/dashboard/deliver"
import {
  answerDeps,
  answerSummary,
  canApprove,
  replyFor,
  type FeedAnswering,
  type FeedReply,
  type FeedResult,
} from "@/lib/dashboard/feed"
import { keptLocalModel, startModel, type Started } from "@/lib/dashboard/local-load"
import { type HostedLogin, machineHostedLogin } from "@/lib/dashboard/seat-login"
import {
  settingSummary,
  type HostedSetting,
  type SessionEffort,
  type SessionSetting,
} from "@/lib/dashboard/setting"
import {
  feedItemOf,
  hostSessions,
  type FeedItem,
  type LocalLoad,
  type Worker,
} from "@/lib/dashboard/workers"
import { org } from "@/lib/org"
import { SESSION_FILE } from "@/lib/sessions/own"
import { dataDir, transcriptPath } from "@/lib/sessions/paths"

// The dashboard's second way to reach a session, beside herdr's: a session it hosts itself on the Claude Agent SDK, which runs the installed `claude` on this user's own login. Phase 1 hosts one throwaway session, probe-sdk, in the folder PLAYGROUND_SDK_PROBE_DIR names. A message goes in as a user message on its input stream, never typed into a terminal, and its replies reach the dashboard from its transcript, as every other session's do. What it asks (a tool to run, a picker, a plan) waits on its canUseTool callback, shown as a NeedsYou card and answered by the card's Submit.
export { SDK_PROBE }

export { SESSION_FILE }

// A prompt nobody answers is refused after this long, so the session never hangs on a card no one will answer (a permission or plan card is read-only while PLAYGROUND_APPROVALS_ENABLED is off). The cards say 10 minutes too: the read-only footer in needs-you-card.tsx and both clipped-card lines in needs-you.ts.
export const PROMPT_TIMEOUT_MS = 10 * 60_000

export const TIMED_OUT = "No answer came from the dashboard in time, so this was not allowed."

// The modes the composer's picker offers for the hosted session, as Claude Code's own Shift+Tab cycles them (its auto and dontAsk modes stay out). PLAYGROUND_SDK_PERMISSION_MODE in packages/env names the one it starts in, bypassPermissions as the factory's terminal sessions do.
export const HOSTED_MODES = ["acceptEdits", "bypassPermissions", "default", "plan"] as const

export type HostedMode = (typeof HOSTED_MODES)[number]

const isHostedMode = (mode: unknown): mode is HostedMode =>
  HOSTED_MODES.includes(mode as HostedMode)

type Pending = {
  input: Record<string, unknown>
  item: FeedItem
  settle: (result: PermissionResult) => void
}

// What the hosted session takes from the API's environment: the user's shell basics and Claude Code's config folder, nothing else, plus PLAYGROUND_ROLE=probe, which makes it a factory probe for the factory's hooks, and PLAYGROUND_DATA_DIR naming the stack's own data folder, so a factory script the session runs on a fixture stack writes there, never this machine's. The API's environment holds its .env (the database URL, auth secrets, PLAYGROUND_SDK_PROBE_DIR) and the Claude Code session or terminal it runs under; none of it reaches the session. A cloud start runs on the stored login while ops-usage reads it live, else on the own account's seat token, CLAUDE_CODE_OAUTH_TOKEN added beside this list, by spawn.sh's rule (seat-login.ts).
const HOSTED_ENV = [
  "CLAUDE_CONFIG_DIR",
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
]

// A local model's server and the id it serves the model under, which the hosted session runs on in place of the default endpoint.
export type LocalEndpoint = { id: string; url: string }

// The token a session on a local model sends its server: a fixed word that is no secret, so the login's own token never goes there.
export const LOCAL_TOKEN = "playground-local"

// What a session on a local model takes beside the allowlist: its server, the token above, the local id under each alias Claude Code asks for (its own background calls ask for haiku), and few retries, so a server that stops answering shows its error in the chat within seconds rather than retrying for minutes.
const localEnv = ({ id, url }: LocalEndpoint): Record<string, string> => ({
  ANTHROPIC_AUTH_TOKEN: LOCAL_TOKEN,
  ANTHROPIC_BASE_URL: url,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: id,
  ANTHROPIC_DEFAULT_OPUS_MODEL: id,
  ANTHROPIC_DEFAULT_SONNET_MODEL: id,
  CLAUDE_CODE_MAX_RETRIES: "2",
})

export const hostedEnv = (
  from: Record<string, string | undefined> = process.env,
  data: string = dataDir(),
  local: LocalEndpoint | null = null,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const key of HOSTED_ENV) {
    const value = from[key]
    if (value !== undefined) env[key] = value
  }
  return {
    ...env,
    PLAYGROUND_DATA_DIR: data,
    PLAYGROUND_ROLE: "probe",
    ...(local && localEnv(local)),
  }
}

// How long the local server has to list its models before a pick reads it as not answering.
export const LOCAL_READ_MS = 5_000

// The model ids the local server serves (vLLM's /v1/models), or null when it does not answer in time.
export async function servedModels(
  url: string,
  timeoutMs = LOCAL_READ_MS,
): Promise<string[] | null> {
  try {
    const response = await fetch(new URL("/v1/models", url), {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { data?: { id?: unknown }[] }
    return (body.data ?? []).flatMap((model) => (typeof model.id === "string" ? [model.id] : []))
  } catch {
    return null
  }
}

export type LocalPlan =
  | { do: "load" }
  | { do: "refuse"; down: boolean; reason: string }
  | { do: "switch" }

// Pure: what a pick of a local model does, given the ids its server serves now (null when it does not answer) and whether a kept model is set to start there: switch when it serves the pick, load when it does not answer and one can start, else refuse in words naming the model loaded and the one picked. The one place a pick's outcome is decided.
export function localPlan(
  picked: LocalModel,
  served: string[] | null,
  models: LocalModel[],
  canStart = false,
): LocalPlan {
  if (served === null && canStart) return { do: "load" }
  if (served === null)
    return {
      do: "refuse",
      down: true,
      reason: `The local model server isn't answering, so the chat stays on its model, not ${picked.label}.`,
    }
  if (served.includes(picked.id)) return { do: "switch" }
  const loaded = served.map((id) => models.find((model) => model.id === id)?.label ?? id)
  return {
    do: "refuse",
    down: false,
    reason: loaded.length
      ? `${loaded.join(" and ")} is loaded on the local model server right now, not ${picked.label}.`
      : `No model is loaded on the local model server right now, so ${picked.label} can't answer.`,
  }
}

// Pure: what the session asks, as the card that shows it. A picker is AskUserQuestion's questions; ExitPlanMode is a plan; anything else is a tool it asks to run, shown with its whole input. Clipping and hidden characters follow the Feed's own rules.
export function askOf(
  tool: string,
  input: Record<string, unknown>,
  requestId: string,
  at: string,
): FeedItem | null {
  const base = { created_at: at, request_id: requestId }
  if (tool === "AskUserQuestion") {
    const questions = Array.isArray(input.questions) ? input.questions : []
    return feedItemOf({
      ...base,
      kind: "question",
      questions: questions.map((q: Record<string, unknown>) => ({
        header: q.header,
        multi_select: q.multiSelect === true,
        options: q.options,
        prompt: q.question,
      })),
    })
  }
  if (tool === "ExitPlanMode") return feedItemOf({ ...base, kind: "exitPlan", plan: input.plan })
  return feedItemOf({ ...base, kind: "permissionRequest", tool_input: input, tool_name: tool })
}

// Pure: the card's answer as the callback's result. A picker is allowed with its answers by question; a tool runs with the input it asked with; a plan starts, or goes back with the note.
export function resultOf(
  item: FeedItem,
  input: Record<string, unknown>,
  reply: FeedReply,
): PermissionResult {
  if (item.kind === "question" && reply.kind === "question") {
    const answers = Object.fromEntries(
      item.questions.map((q, i) => [q.prompt, reply.selections[i] ?? ""]),
    )
    return { behavior: "allow", updatedInput: { ...input, answers } }
  }
  if (reply.kind === "permission" && reply.mode === "once") {
    return { behavior: "allow", updatedInput: input }
  }
  if (reply.kind === "plan" && reply.mode === "manual") {
    return { behavior: "allow", updatedInput: input }
  }
  if (reply.kind === "plan") {
    return {
      behavior: "deny",
      message: reply.feedback ?? "The plan was sent back from the dashboard.",
    }
  }
  return { behavior: "deny", message: "Denied from the dashboard." }
}

// Pure: where Claude Code writes this session's transcript, under the login's own config folder.
export const transcriptOf = (
  cwd: string,
  sessionId: string,
  config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
): string => transcriptPath(config, cwd, sessionId)

// The factory's own settings, which every factory session is started with (its hooks: no-playground-leak, no-stash and the rest), linked by scripts/link-skills.sh.
export const FACTORY_SETTINGS = join(dataDirOf({}), "factory-settings.json")

// The settings the hosted session runs with: the factory's, when this machine has them, and crossSessionInbound "accept", since the factory's sessions run in bypass mode and a peer's SendMessage would otherwise wait for approval here.
export function hostedSettings(path = FACTORY_SETTINGS): Record<string, unknown> {
  const factory = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {}
  return { ...factory, crossSessionInbound: "accept" }
}

export type HostDeps = {
  exists: (path: string) => boolean
  // The login a cloud start runs on (seat-login.ts): the stored one, or the own account's seat token once the stored login reads stale, empty or ended; none reads as the stored one.
  login?: () => HostedLogin
  // The local models the composer's menu offers and their server (org.ts).
  local: { models: LocalModel[]; url: string }
  now: () => Date
  query: typeof query
  timeoutMs: number
}

const hostDeps: HostDeps = {
  exists: existsSync,
  login: () => machineHostedLogin(),
  local: org.local,
  now: () => new Date(),
  query,
  timeoutMs: PROMPT_TIMEOUT_MS,
}

// How long a closed session has to end before a restart starts its successor anyway.
const CLOSE_MS = 10_000

// One hosted session: its input stream, its prompts waiting on a card, and whether a turn is running.
export class SdkHost {
  private inbox: SDKUserMessage[] = []
  // Why its cloud start has no login, the ended stored login's words, shown as its row's expired login; null while it has one.
  private loginCause: string | null = null
  private wake: (() => void) | null = null
  private pending = new Map<string, Pending>()
  private listeners = new Set<() => void>()
  private working = false
  private cwd = ""
  private claude = ""
  private local: LocalEndpoint | null = null
  private reading: Promise<void> = Promise.resolve()
  private restarting = false
  private load: LocalLoad | null = null
  private loadTicket = 0
  private startedAt: string | null = null
  private session: Query | null = null
  private mode: HostedMode = "default"
  private model: string | null = null
  private effort: SessionEffort | null = null
  sessionId: string | null = null
  transcript: string | null = null

  constructor(private readonly deps: HostDeps = hostDeps) {}

  // Starts the session in dir with the installed claude in the given mode, and says whether it picked up a session an earlier run started, resuming the one SESSION_FILE names once it has a transcript: a session writes none until its first message, and resuming an id with none fails, so until then the id starts afresh. Bypass is allowed from the start whatever the mode, so the picker can switch to it later; only changeHostedMode() switches, behind the owner and PLAYGROUND_APPROVALS_ENABLED.
  start(
    dir: string,
    claude: string,
    mode: HostedMode,
    local: LocalEndpoint | null = null,
    model: string | null = null,
  ): { resumed: boolean } {
    const file = join(dir, SESSION_FILE)
    const known = existsSync(file) ? readFileSync(file, "utf8").trim() : ""
    const id = known || randomUUID()
    if (!known) writeFileSync(file, `${id}\n`)
    this.cwd = dir
    this.claude = claude
    this.local = local
    this.sessionId = id
    this.transcript = transcriptOf(dir, id)
    const resume = Boolean(known) && this.deps.exists(this.transcript)
    this.startedAt = this.deps.now().toISOString()
    this.mode = mode
    this.model = model
    this.effort = null
    const login = local ? {} : (this.deps.login?.() ?? {})
    this.loginCause = login.token ? null : (login.cause ?? null)
    if (login.token)
      console.error(
        `${SDK_PROBE} starts on ${login.email}'s seat token: the stored login has no live reading`,
      )
    if (this.loginCause) console.error(`${SDK_PROBE}: ${this.loginCause}`)
    const stream = this.deps.query({
      options: {
        allowDangerouslySkipPermissions: true,
        canUseTool: this.ask,
        cwd: dir,
        env: {
          ...hostedEnv(process.env, dataDir(), local),
          ...(login.token && { CLAUDE_CODE_OAUTH_TOKEN: login.token }),
        },
        extraArgs: { name: SDK_PROBE },
        includePartialMessages: true,
        ...(model && { model }),
        pathToClaudeCodeExecutable: claude,
        permissionMode: mode,
        settingSources: ["user", "project", "local"],
        settings: hostedSettings(),
        systemPrompt: { preset: "claude_code", type: "preset" },
        tools: { preset: "claude_code", type: "preset" },
        ...(resume ? { resume: id } : { sessionId: id }),
      },
      prompt: this.input(),
    })
    this.session = stream
    this.reading = this.read(stream)
    return { resumed: Boolean(known) }
  }

  // Starts the session again on another endpoint, its conversation resumed in the same mode and effort: on a local model's server, or with local null on the default one with a cloud model. Only between turns (busy()), since a close mid-turn cuts its answer off, and one at a time.
  async restart(local: LocalEndpoint | null, model: string): Promise<void> {
    if (!this.restarting) throw new Error(`${SDK_PROBE} switches its model only under claim()`)
    if (!this.session) throw new Error(`${SDK_PROBE} is not running`)
    const effort = this.effort
    this.session.close()
    await Promise.race([this.reading, Bun.sleep(CLOSE_MS)])
    this.start(this.cwd, this.claude, this.mode, local, model)
    if (effort) await this.keepEffort(effort)
    this.changed()
  }

  // Puts the effort picked before a restart back on its successor; one it refuses leaves the row on none, as a fresh start has.
  private async keepEffort(effort: SessionEffort): Promise<void> {
    try {
      await this.session?.applyFlagSettings({ effortLevel: effort })
      this.effort = effort
    } catch (error) {
      console.error(
        `${SDK_PROBE}: could not keep its effort after a restart:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  // Takes the one restart that may run at a time, before the activity row is written, so a second pick from another tab reads BUSY rather than failing mid-switch; false when another holds it. switchTo() lets it go, whichever way the restart ends.
  claim(): boolean {
    if (this.restarting) return false
    this.restarting = true
    return true
  }

  release(): void {
    this.restarting = false
    this.changed()
  }

  // The local model loading for a pick, by its label, or null.
  loading(): string | null {
    return this.load?.state === "loading" ? this.load.label : null
  }

  // Starts showing a load of label on the row, and gives back the ticket that load holds; a later pick's dropLoad() takes it away.
  beginLoad(label: string): number {
    this.load = { label, state: "loading" }
    this.changed()
    return ++this.loadTicket
  }

  // Whether the load ticket names is still the one shown loading.
  holds(ticket: number): boolean {
    return ticket === this.loadTicket && this.load?.state === "loading"
  }

  // Ends the load ticket names: cleared once the switch is done, or shown failed in reason's words; one a later pick dropped stays dropped.
  endLoad(ticket: number, reason?: string): void {
    if (!this.holds(ticket) || !this.load) return
    this.load = reason ? { label: this.load.label, reason, state: "failed" } : null
    this.changed()
  }

  // Drops whatever load the row shows, so the next model pick clears a failed line and a cloud pick cancels a switch still waiting on its server, which goes on starting.
  dropLoad(): void {
    this.loadTicket++
    if (!this.load) return
    this.load = null
    this.changed()
  }

  // Whether a turn runs, a card waits or a restart is under way, when another restart would cut it off.
  busy(): boolean {
    return this.restarting || this.working || this.waiting()
  }

  // The local model the session runs on, or null on the default endpoint.
  localModel(): string | null {
    return this.local?.id ?? null
  }

  localModels(): { models: LocalModel[]; url: string } {
    return this.deps.local
  }

  // Switches the running session's mode as Shift+Tab does in a terminal; the row shows the new mode once the session has taken it.
  async setMode(mode: HostedMode): Promise<void> {
    if (!this.session) throw new Error(`${SDK_PROBE} is not running`)
    await this.session.setPermissionMode(mode)
    this.mode = mode
    this.changed()
  }

  // Sets the running session's model or effort as /model and /effort do in a terminal; the row shows the value set.
  async setSetting(setting: SessionSetting): Promise<void> {
    if (!this.session) throw new Error(`${SDK_PROBE} is not running`)
    if ("model" in setting) {
      await this.session.setModel(setting.model)
      this.model = setting.model
    } else {
      await this.session.applyFlagSettings({ effortLevel: setting.effort })
      this.effort = setting.effort
    }
    this.changed()
  }

  currentMode(): HostedMode {
    return this.mode
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed() {
    for (const listener of this.listeners) listener()
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.inbox.shift()
      if (next) yield next
      else await new Promise<void>((resolve) => (this.wake = resolve))
    }
  }

  // The session's own messages say when a turn runs; its replies reach the dashboard from its transcript. When its process ends, the dashboard lists it no more.
  private async read(stream: Query) {
    try {
      for await (const message of stream) {
        // the session says its mode at each turn's start and when it changes it itself, as leaving plan mode does
        const reported = message.type === "system" && "permissionMode" in message
        if (
          reported &&
          isHostedMode(message.permissionMode) &&
          message.permissionMode !== this.mode
        ) {
          this.mode = message.permissionMode
          this.changed()
        }
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          message.model !== this.model
        ) {
          this.model = message.model
          this.changed()
        }
        if (message.type === "result" && this.working) {
          this.working = false
          this.changed()
        } else if (message.type === "assistant" && !this.working) {
          // a turn the session starts itself (a peer's SendMessage) runs too
          this.working = true
          this.changed()
        }
      }
    } catch (error) {
      console.error(`${SDK_PROBE} stopped:`, error instanceof Error ? error.message : error)
    } finally {
      // a session closed for a restart may end after its successor started, which keeps the host
      if (this.session === stream) {
        this.session = null
        this.sessionId = null
        this.working = false
        this.changed()
      }
    }
  }

  // Puts text on the session's input as the user's own message: its transcript records it as a person's, as it does a prompt typed in a terminal, so the stream shows it as his.
  send(text: string): void {
    this.inbox.push({
      message: { content: text, role: "user" },
      origin: { kind: "human" },
      parent_tool_use_id: null,
      type: "user",
    })
    this.working = true
    this.wake?.()
    this.wake = null
    this.changed()
  }

  readonly ask: CanUseTool = (tool, input, { signal }) => {
    const requestId = randomUUID()
    const item = askOf(tool, input, requestId, this.deps.now().toISOString())
    if (!item)
      return Promise.resolve({ behavior: "deny", message: "The dashboard cannot show this." })
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(
        () => this.settle(requestId, { behavior: "deny", message: TIMED_OUT }),
        this.deps.timeoutMs,
      )
      const settle = (result: PermissionResult) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        this.changed()
        resolve(result)
      }
      this.pending.set(requestId, { input, item, settle })
      signal.addEventListener("abort", () => settle({ behavior: "deny", message: "Cancelled." }))
      this.changed()
    })
  }

  // Whether a card waits on an answer.
  waiting(): boolean {
    return this.pending.size > 0
  }

  pendingItem(requestId: string): Pending | null {
    return this.pending.get(requestId) ?? null
  }

  // Answers one waiting prompt; false when it no longer waits.
  settle(requestId: string, result: PermissionResult): boolean {
    const waiting = this.pending.get(requestId)
    if (!waiting) return false
    waiting.settle(result)
    return true
  }

  // The session as the dashboard lists it. A probe's prompts are its spawner's, so it reads working or idle, never waiting on you; its cards still show in its stream.
  worker(): Worker | null {
    if (!this.sessionId) return null
    const feed = [...this.pending.values()]
      .map((p) => p.item)
      .sort((a, b) => a.at.localeCompare(b.at))
    return {
      cwd: this.cwd,
      effort: this.effort,
      eta: null,
      failed: false,
      feed,
      hosted: true,
      lastActiveAt: null,
      lifecycle: this.working ? "running" : "idle",
      light: this.working ? "working" : "idle",
      ...(this.load && { localLoad: this.load }),
      ...(this.loginCause && { loginExpired: true as const }),
      ...(this.deps.local.models.length > 0 && { localModels: this.deps.local.models }),
      model: this.model,
      name: SDK_PROBE,
      permissionMode: this.mode,
      questions: [],
      role: "other",
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      task: null,
      tasks: [],
      title: null,
      updatedAt: null,
      workspace: null,
    }
  }
}

const HOST = Symbol.for("playground.dashboard.sdk.host")
const held = globalThis as { [HOST]?: SdkHost }

// One host for the process: a reload under bun --hot keeps the running session rather than starting a second one.
export const sdkHost = (held[HOST] ??= new SdkHost())

// Starts the probe when PLAYGROUND_SDK_PROBE_DIR names its folder, in the mode PLAYGROUND_SDK_PERMISSION_MODE names, and only on the installed claude (the SDK would otherwise run a copy of its own); a reload under bun --hot runs this again with the session still running, so the session is listed again and the host kept. A restart that picks up the session an earlier run started puts it back in that mode, whatever was picked before, so the console's activity says so (the pick itself comes back later).
export function startSdkProbe(
  dir = env.PLAYGROUND_SDK_PROBE_DIR,
  host: SdkHost = sdkHost,
  claude = claudeBinary(),
  mode: HostedMode = env.PLAYGROUND_SDK_PERMISSION_MODE,
  record: (event: ActivityEvent) => Promise<void> = (event) =>
    answerDeps.record(event, async () => {}),
): void {
  if (!dir) return
  hostSessions(() => {
    const worker = host.worker()
    return worker ? [{ transcript: host.transcript, worker }] : []
  })
  if (host.sessionId) return
  if (!existsSync(dir)) return void console.error(`PLAYGROUND_SDK_PROBE_DIR ${dir} does not exist`)
  if (!claude) return void console.error(`${SDK_PROBE} needs claude on PATH`)
  // Claude Code names the transcript's folder from the real working folder, so a trailing slash, a relative path or a symlink is resolved first
  const { resumed } = host.start(realpathSync(dir), claude, mode)
  if (!resumed) return
  const event: ActivityEvent = {
    action: "dashboard.mode",
    actor: { label: "Dashboard" },
    summary: `Reset ${SDK_PROBE}'s permission mode to ${PERMISSION_MODE_LABELS[mode]} after a restart`,
  }
  record(event).catch((error) =>
    console.error(
      `${SDK_PROBE}: could not record its mode reset:`,
      error instanceof Error ? error.message : error,
    ),
  )
}

// Whether the dashboard hosts this session itself, so its messages and answers go through here rather than herdr.
export const hosts = (sessionId: string, host: SdkHost = sdkHost): boolean =>
  host.sessionId !== null && host.sessionId === sessionId

export type SendDeps = {
  delivered: (id: string) => Promise<Date | null>
  host: SdkHost
  now: () => Date
  record: (event: ActivityEvent, sending: () => Promise<void>) => Promise<void>
}

const sendDeps: SendDeps = {
  delivered: deliverDeps.delivered,
  host: sdkHost,
  now: () => new Date(),
  record: deliverDeps.record,
}

// The composer's message to the hosted session, never a setting (changeHostedSetting() sets those), judged by the same rules as a typed one (no command, nothing empty or too long, nothing while a card waits) and recorded the same way, its size and never its words, under the composer's id so a retry sends nothing twice. Nothing reads the session's screen: the message joins its input stream, and a session busy with a turn takes it after (from the session's own queue, which goes if the API stops first).
export async function sendToHosted(
  delivery: Delivery,
  deps: SendDeps = sendDeps,
): Promise<DeliveryResult> {
  const sessionId = deps.host.sessionId
  if (delivery.to !== SDK_PROBE || !sessionId) {
    return {
      code: "NOT_FOUND",
      ok: false,
      reason: `The dashboard hosts no session named ${delivery.to}.`,
    }
  }
  const attachments = delivery.attachments ?? []
  const message = { ...delivery, setting: undefined }
  const { refused, words } = deliveryWords(message)
  if (refused) return refused
  const at = delivery.id ? await deps.delivered(delivery.id) : null
  if (at) return { at: at.toISOString(), ok: true, sessionId }
  if (deps.host.waiting()) {
    return {
      code: "ON_PICKER",
      ok: false,
      reason: `${SDK_PROBE} is waiting on a card. Answer that first: the message goes once it is answered.`,
    }
  }
  const event = deliveryEvent(message, SDK_PROBE, words)
  await deps.record(event, async () => deps.host.send(withAttachments(words, attachments)))
  return { at: deps.now().toISOString(), ok: true, sessionId }
}

const GONE = new Error("the prompt stopped waiting")

export type AnswerHostedDeps = Pick<typeof answerDeps, "approvals" | "now" | "record"> & {
  host: SdkHost
}

const answerHostedDeps: AnswerHostedDeps = {
  approvals: answerDeps.approvals,
  host: sdkHost,
  now: answerDeps.now,
  record: answerDeps.record,
}

// A card's answer to a prompt the hosted session waits on, judged as a Feed answer is: canApprove() decides who may answer, permission and plan answers go only while PLAYGROUND_APPROVALS_ENABLED is on, and replyFor() checks the answer fits. The activity row and the answer commit together; the callback hands it straight to the session, so there is nothing to read back.
export async function answerHosted(
  { actor, answer, approver, requestId }: FeedAnswering,
  deps: AnswerHostedDeps = answerHostedDeps,
): Promise<FeedResult> {
  const refused = (code: Extract<FeedResult, { ok: false }>["code"], reason: string) =>
    ({ code, ok: false, reason }) as const
  if (!canApprove(approver)) return refused("FORBIDDEN", "Only the owner answers prompts.")
  if (answer.kind !== "question" && !deps.approvals) {
    return refused("DISABLED", "Answering permission and plan prompts here is off for now.")
  }
  const waiting = deps.host.pendingItem(requestId)
  if (!waiting)
    return refused(
      "NOT_PENDING",
      `No such prompt waits on ${SDK_PROBE}: it may be answered already.`,
    )
  const built = replyFor(waiting.item, answer)
  if ("ok" in built) return built
  const event: ActivityEvent = {
    action: "dashboard.answer",
    actor,
    summary: answerSummary(SDK_PROBE, waiting.item, answer),
  }
  try {
    await deps.record(event, async () => {
      if (!deps.host.settle(requestId, resultOf(waiting.item, waiting.input, built))) throw GONE
    })
  } catch (error) {
    if (error !== GONE) throw error
    return refused(
      "NOT_PENDING",
      `That prompt stopped waiting on ${SDK_PROBE} (it timed out or was cancelled).`,
    )
  }
  return { at: deps.now().toISOString(), ok: true }
}

export type ModeChanging = {
  actor: ActivityActor
  approver: Parameters<typeof canApprove>[0]
  mode: HostedMode
  sessionId: string
}

export type ModeResult =
  | { at: string; mode: HostedMode; ok: true }
  | { code: "DISABLED" | "FORBIDDEN" | "NOT_FOUND"; ok: false; reason: string }

// The owner's pick in the composer's mode picker, judged as a permission answer is, since a mode approves the session's later actions (bypassPermissions all of them): canApprove() decides who may, and it goes only while PLAYGROUND_APPROVALS_ENABLED is on. The activity row names the old and the new mode and commits only once the session has taken the new one; a mode it refuses throws, and nothing is recorded.
export async function changeHostedMode(
  { actor, approver, mode, sessionId }: ModeChanging,
  deps: AnswerHostedDeps = answerHostedDeps,
): Promise<ModeResult> {
  const refused = (code: Extract<ModeResult, { ok: false }>["code"], reason: string) =>
    ({ code, ok: false, reason }) as const
  if (!canApprove(approver)) return refused("FORBIDDEN", "Only the owner changes the mode.")
  if (!deps.approvals) return refused("DISABLED", "Changing the mode here is off for now.")
  if (!hosts(sessionId, deps.host)) {
    return refused("NOT_FOUND", "The dashboard hosts no running session with that id.")
  }
  const event: ActivityEvent = {
    action: "dashboard.mode",
    actor,
    summary: `Changed ${SDK_PROBE}'s permission mode from ${PERMISSION_MODE_LABELS[deps.host.currentMode()]} to ${PERMISSION_MODE_LABELS[mode]}`,
  }
  await deps.record(event, () => deps.host.setMode(mode))
  return { at: deps.now().toISOString(), mode, ok: true }
}

export type SettingChanging = { actor: ActivityActor; sessionId: string; setting: HostedSetting }

export type SettingDeps = Pick<AnswerHostedDeps, "host" | "now" | "record"> & {
  // The model the local server's machine keeps up (localModels.peerModel), which a pick starts when the server is down; empty, none.
  keptModel: () => string
  served: (url: string) => Promise<string[] | null>
  sleep: (ms: number) => Promise<void>
  start: (model: string) => Promise<Started>
}

const settingDeps: SettingDeps = {
  ...answerHostedDeps,
  keptModel: keptLocalModel,
  served: servedModels,
  sleep: (ms) => Bun.sleep(ms),
  start: startModel,
}

// How long a pick waits for the model it started to be served, and how often it reads the server meanwhile.
export const LOAD_WAIT_MS = 15 * 60_000
export const LOAD_POLL_MS = 5_000

// Restarts the session on the local server under the one claim a switch takes, the activity row written as it does.
async function switchTo(
  deps: SettingDeps,
  event: ActivityEvent,
  local: LocalEndpoint | null,
  model: string,
): Promise<boolean> {
  if (!deps.host.claim()) return false
  try {
    await deps.record(event, () => deps.host.restart(local, model))
  } finally {
    deps.host.release()
  }
  return true
}

// A pick's load, run past the request: starts the kept model through `playground model use`, then reads the server until it serves the pick and the chat is between turns, and switches; a refused start, an error, the server answering with another model or LOAD_WAIT_MS passing with no answer shows its plain words on the row instead, the chat left on its model.
export async function loadLocal(
  picked: LocalModel,
  url: string,
  event: ActivityEvent,
  deps: SettingDeps,
): Promise<void> {
  const { host } = deps
  const ticket = host.beginLoad(picked.label)
  const until = deps.now().getTime() + LOAD_WAIT_MS
  try {
    const started = await deps.start(deps.keptModel())
    if (!host.holds(ticket)) return
    if (started.code !== 0)
      return host.endLoad(
        ticket,
        `The local model server couldn't start ${picked.label}, so the chat stays on its model: ${started.line}`,
      )
    for (;;) {
      const served = await deps.served(url)
      if (!host.holds(ticket)) return
      // served, it waits for the turn to end however long; answering with another model ends the load at once, since nothing this load started will change that; not answering waits up to LOAD_WAIT_MS
      if (served?.includes(picked.id)) {
        if (!host.busy() && (await switchTo(deps, event, { id: picked.id, url }, picked.id)))
          return host.endLoad(ticket)
      } else if (served !== null) {
        const plan = localPlan(picked, served, host.localModels().models)
        return host.endLoad(ticket, plan.do === "refuse" ? plan.reason : undefined)
      } else if (deps.now().getTime() >= until) {
        return host.endLoad(
          ticket,
          `${picked.label} didn't come up on the local model server within ${LOAD_WAIT_MS / 60_000} minutes, so the chat stays on its model.`,
        )
      }
      await deps.sleep(LOAD_POLL_MS)
    }
  } catch (error) {
    host.endLoad(
      ticket,
      `${picked.label} couldn't load: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

// The owner's pick in the composer's model and effort menu for the hosted session, set through the SDK rather than typed: the dashboard.setting row commits only once the session has taken it, so a value it refuses throws and records nothing. A local model, or a cloud one while it runs on a local model, restarts it on that endpoint instead, between turns alone, and a local pick its server does not serve now is refused as localPlan() words it.
export async function changeHostedSetting(
  { actor, sessionId, setting }: SettingChanging,
  deps: SettingDeps = settingDeps,
): Promise<DeliveryResult> {
  const refused = (code: Extract<DeliveryResult, { ok: false }>["code"], reason: string) =>
    ({ code, ok: false, reason }) as const
  if (!hosts(sessionId, deps.host)) {
    return refused("NOT_FOUND", "The dashboard hosts no running session with that id.")
  }
  const event: ActivityEvent = {
    action: "dashboard.setting",
    actor,
    summary: settingSummary(SDK_PROBE, setting),
  }
  const done = { at: deps.now().toISOString(), ok: true, sessionId } as const
  const busy = refused("BUSY", "The chat is answering; switch the model once it's done.")
  const loading = () => {
    const label = deps.host.loading()
    return label && refused("BUSY", `${label} is still loading on the local model server.`)
  }
  if ("local" in setting) {
    const { models, url } = deps.host.localModels()
    const picked = models.find((model) => model.id === setting.local)
    if (!picked) return refused("NOT_FOUND", "No local model by that id is set up here.")
    if (deps.host.busy()) return busy
    const held = loading()
    if (held) return held
    const served = await deps.served(url)
    if (deps.host.busy()) return busy
    const plan = localPlan(picked, served, models, deps.keptModel() !== "")
    if (plan.do === "refuse") return refused(plan.down ? "SESSIONS_FAILED" : "BUSY", plan.reason)
    const late = loading()
    if (late) return late
    deps.host.dropLoad()
    if (plan.do === "load") {
      void loadLocal(picked, url, event, deps)
      return done
    }
    if (!(await switchTo(deps, event, { id: picked.id, url }, picked.id))) return busy
  } else if ("model" in setting && deps.host.localModel() !== null) {
    if (deps.host.busy()) return busy
    deps.host.dropLoad()
    if (!(await switchTo(deps, event, null, setting.model))) return busy
  } else {
    if ("model" in setting) deps.host.dropLoad()
    await deps.record(event, () => deps.host.setSetting(setting))
  }
  return done
}
