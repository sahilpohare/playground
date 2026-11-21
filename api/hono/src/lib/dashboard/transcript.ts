// Relative rather than @/: the web's tests import this file, and they cannot resolve the API's @/ paths.
import { attachmentIdOf, splitAttachments, type EntryAttachment } from "./attachments"

// One step of a Claude Code session, read from its transcript (~/.claude/projects/<cwd>/<session>.jsonl): what a person or a peer session said to it, what it said and thought, each tool it called and what each call returned. A person's message the dashboard sent with files carries them as `attachments`, lifted out of its text. A tool call carries its id and its input; a result names the call it answers, whether it failed, and for a subagent's run, the subagent's id.
export type Entry = {
  agentId?: string
  at: string
  attachments?: EntryAttachment[]
  // the last step of a line Claude Code wrote with stop_reason end_turn: the reply has stopped
  endsTurn?: true
  from: string | null
  id: string
  input?: string
  isError?: boolean
  kind: "assistant" | "human" | "peer" | "reasoning" | "result" | "tool"
  text: string
  tool: string | null
  toolUseId?: string
}

export const TEXT_LIMIT = 4000
const SUMMARY_LIMIT = 300
// A tool's input and its result put more of the transcript on screen than its one-line summary, so each is clipped tighter than a message.
const DETAIL_LIMIT = 2000

// Tool inputs worth a one-line summary, most telling first.
const SUMMARY_KEYS = [
  "description",
  "command",
  "file_path",
  "pattern",
  "url",
  "query",
  "skill",
  "prompt",
] as const

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === "string" ? value : "")

export const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? ""

export const toolSummary = (name: string, input: unknown): string => {
  if (!isRecord(input)) return ""
  if (name === "SendMessage") return `to ${str(input.to)}: ${firstLine(str(input.message))}`
  for (const key of SUMMARY_KEYS) {
    const value = str(input[key])
    if (value.trim()) return firstLine(value)
  }
  return ""
}

const entry = (fields: Omit<Entry, "from" | "tool"> & Partial<Entry>): Entry => ({
  from: null,
  tool: null,
  ...fields,
})

const peer = (origin: Json, at: string, id: string, fallback: string): Entry =>
  entry({
    at,
    from: str(origin.name) || str(origin.from) || null,
    id,
    kind: "peer",
    text: clip(str(origin.body) || fallback, TEXT_LIMIT),
  })

// A slash command is written as a user line of tags (`<command-name>/linear</command-name><command-args>QA</command-args>`), read back as the command it ran. Its output, `!` shell input and their caveats are tagged too, and are bookkeeping. Only a line that starts with a tag is one: a prompt can quote a tag partway through.
const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
export const COMMAND_TAG = /^\s*<(?:bash|command|local-command)-[a-z-]+>/

export const commandOf = (text: string): string | null => {
  if (!COMMAND_TAG.test(text)) return null
  const name = COMMAND_NAME.exec(text)?.[1]?.trim()
  return name ? `${name} ${COMMAND_ARGS.exec(text)?.[1]?.trim() ?? ""}`.trim() : null
}

// Claude Code records a long paste wrapped in these tags, its id on both.
const PASTED = /<pasted_content id="([^"]*)">\n([\s\S]*?)\n<\/pasted_content id="\1">/g

// A person's words as they typed them: the slash command they ran, or their text with any long paste's tags lifted.
export const typedOf = (text: string): string =>
  commandOf(text) ?? text.replace(PASTED, "$2").trim()

// A person's message: its words, or the slash command it ran, and any files the dashboard attached to it. `images` names the images Claude Code took in from pasted paths, in order, from the source lines read beside it; they name its images only when they are as many.
const human = (at: string, id: string, raw: string, images: string[] = []): Entry[] => {
  const split = splitAttachments(typedOf(raw))
  const { text } = split
  const unnamed = split.attachments.filter((file) => file.id === null).length
  const named = [...images]
  const attachments =
    unnamed && unnamed === images.length
      ? split.attachments.map((file) =>
          file.id === null ? { id: named.shift()!, kind: file.kind } : file,
        )
      : split.attachments
  if (!text && !attachments.length) return []
  return [
    entry({
      at,
      id,
      kind: "human",
      text: clip(text, TEXT_LIMIT),
      ...(attachments.length ? { attachments } : {}),
    }),
  ]
}

// A tool result's content: a string, or blocks whose text parts count (an image a tool returned is left out).
const resultText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((block): block is Json => isRecord(block) && block.type === "text")
          .map((block) => str(block.text))
          .join("\n")
      : ""

// The subagent an Agent call ran: Claude Code names it in the call's toolUseResult, and in the result's text, which is all the database keeps.
const AGENT_ID = /\bagentId: ([0-9a-z]+)/
const AGENT_LINE = /^agentId: [0-9a-z]+\b.*$/gm

// A user line of tool results: one result step per call it answers.
const results = (d: Json, content: unknown[], at: string, id: string): Entry[] => {
  const meta = isRecord(d.toolUseResult) ? d.toolUseResult : {}
  return content.flatMap((block, i): Entry[] => {
    if (!isRecord(block) || block.type !== "tool_result" || !str(block.tool_use_id)) return []
    const raw = resultText(block.content)
    const agentId = str(meta.agentId) || AGENT_ID.exec(raw)?.[1] || ""
    // the line naming the subagent is Claude Code's note to the session, not the subagent's report
    const text = agentId ? raw.replace(AGENT_LINE, "").trimEnd() : raw
    return [
      entry({
        at,
        id: `${id}:${i}`,
        kind: "result",
        text: clip(text, DETAIL_LIMIT),
        toolUseId: str(block.tool_use_id),
        ...(block.is_error === true ? { isError: true } : {}),
        ...(agentId ? { agentId } : {}),
      }),
    ]
  })
}

const userText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  if (content.some((block) => isRecord(block) && block.type === "tool_result")) return ""
  return content
    .filter((block): block is Json => isRecord(block) && block.type === "text")
    .map((block) => str(block.text))
    .join("\n")
}

// A tool call's input as the Tool step shows it, indented JSON, clipped.
const inputOf = (input: unknown): string => {
  if (!isRecord(input) || Object.keys(input).length === 0) return ""
  return clip(JSON.stringify(input, null, 2), DETAIL_LIMIT)
}

// A transcript line becomes zero or more entries: an assistant line can hold thinking, text and several tool calls, and a user line the results of several. Bookkeeping lines are left out, and so are a subagent's own (sidechain) lines unless the transcript read is that subagent's (sidechain: true).
export function parseLine(
  line: string,
  {
    images = new Map(),
    sidechain = false,
  }: { images?: Map<string, string[]>; sidechain?: boolean } = {},
): Entry[] {
  let d: unknown
  try {
    d = JSON.parse(line)
  } catch {
    return []
  }
  if (!isRecord(d) || (d.isSidechain === true && !sidechain)) return []
  const at = str(d.timestamp)
  const id = str(d.uuid)
  const message = isRecord(d.message) ? d.message : {}

  if (d.type === "user" && Array.isArray(message.content)) {
    if (message.content.some((block) => isRecord(block) && block.type === "tool_result")) {
      return results(d, message.content, at, id)
    }
  }

  if (d.type === "user") {
    const origin = isRecord(d.origin) ? d.origin : {}
    if (origin.kind === "peer") return [peer(origin, at, id, userText(message.content))]
    if (origin.kind !== "human") return []
    return human(at, id, userText(message.content), images.get(str(d.promptId)))
  }

  if (d.type === "attachment" && isRecord(d.attachment)) {
    const attachment = d.attachment
    const origin = isRecord(attachment.origin) ? attachment.origin : {}
    if (attachment.type !== "queued_command") return []
    if (origin.kind === "peer") return [peer(origin, at, id, userText(attachment.prompt))]
    if (origin.kind !== "human") return []
    return human(at, id, userText(attachment.prompt))
  }

  if (d.type === "assistant" && Array.isArray(message.content)) {
    const entries = message.content.flatMap((block, i): Entry[] => {
      if (!isRecord(block)) return []
      const blockId = `${id}:${i}`
      if (block.type === "text" && str(block.text).trim()) {
        return [
          entry({ at, id: blockId, kind: "assistant", text: clip(str(block.text), TEXT_LIMIT) }),
        ]
      }
      // Thinking is mostly redacted to an empty block, but some carries its text.
      if (block.type === "thinking" && str(block.thinking).trim()) {
        return [
          entry({
            at,
            id: blockId,
            kind: "reasoning",
            text: clip(str(block.thinking), TEXT_LIMIT),
          }),
        ]
      }
      if (block.type === "tool_use") {
        const tool = str(block.name)
        const text = clip(toolSummary(tool, block.input), SUMMARY_LIMIT)
        const input = inputOf(block.input)
        return [
          entry({
            at,
            id: blockId,
            kind: "tool",
            text,
            tool,
            ...(input ? { input } : {}),
            ...(str(block.id) ? { toolUseId: str(block.id) } : {}),
          }),
        ]
      }
      return []
    })
    const last = entries.at(-1)
    if (last && message.stop_reason === "end_turn") last.endsTurn = true
    return entries
  }

  return []
}

// Claude Code names each image it took in from a pasted path on a meta line of the same prompt, written after the message (measured on 2.1.304): `[Image: source: <path>]`.
const SOURCE = /^\[Image: source: (.+)\]$/

// The attachment ids those lines name, by prompt, in order; a path outside the attachments folder names nothing.
export const imageSources = (lines: string[]): Map<string, string[]> => {
  const sources = new Map<string, string[]>()
  for (const line of lines) {
    if (!line.includes("[Image: source: ")) continue
    let d: unknown
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(d) || d.isMeta !== true || d.type !== "user" || !str(d.promptId)) continue
    const content = isRecord(d.message) ? d.message.content : null
    for (const text of userText(content).split("\n")) {
      const path = SOURCE.exec(text)?.[1]
      const id = path ? attachmentIdOf(path) : null
      if (id) sources.set(str(d.promptId), [...(sources.get(str(d.promptId)) ?? []), id])
    }
  }
  return sources
}

// A person's message line with an image no source line has named yet, since none was read beside it.
export const awaitsSource = (line: string): boolean =>
  parseLine(line).some(
    (e) => e.kind === "human" && Boolean(e.attachments?.some((f) => f.id === null)),
  )

export const parseLines = (text: string, options?: { sidechain?: boolean }): Entry[] => {
  const lines = text.split("\n").filter((line) => line.trim())
  const images = imageSources(lines)
  return lines.flatMap((line) => parseLine(line, { ...options, images }))
}

// What the session was asked to do: the first thing a person or a peer said to it in words.
export const taskOf = (entries: Entry[]): string | null => {
  const first = entries.find((e) => (e.kind === "human" || e.kind === "peer") && e.text)
  return first ? clip(firstLine(first.text), SUMMARY_LIMIT) : null
}

export const TAIL_BYTES = 512 * 1024
// How far back readTail reaches for a step when its first window holds none.
export const TAIL_CEILING = 8 * 1024 * 1024
export const HEAD_BYTES = 256 * 1024
export const NEWLINE = 0x0a

// The bytes up to and including the last newline, decoded: a line still being written waits for its end, and an offset never lands inside a multi-byte character.
export const completeLines = (bytes: Uint8Array): { consumed: number; text: string } => {
  const consumed = bytes.lastIndexOf(NEWLINE) + 1
  return { consumed, text: new TextDecoder().decode(bytes.subarray(0, consumed)) }
}

// The last `limit` entries, read from the file's end so a long session costs a bounded read: its last TAIL_BYTES, and when they hold no whole step (a last line longer than that, such as a screenshot's result, or bookkeeping lines alone) twice as far back each time, reading only the new bytes, until a step shows, the file starts or TAIL_CEILING is reached.
export async function readTail(
  path: string,
  limit: number,
  options?: { sidechain?: boolean },
): Promise<Entry[]> {
  const file = Bun.file(path)
  if (!(await file.exists())) return []
  const size = file.size
  let start = size
  let bytes = new Uint8Array(0)
  for (let window = TAIL_BYTES; ; window *= 2) {
    const from = Math.max(0, size - Math.min(window, TAIL_CEILING))
    bytes = Buffer.concat([new Uint8Array(await file.slice(from, start).arrayBuffer()), bytes])
    start = from
    let text = new TextDecoder().decode(bytes)
    if (start > 0) text = text.slice(text.indexOf("\n") + 1)
    const entries = parseLines(text, options)
    if (entries.length > 0 || start === 0 || window >= TAIL_CEILING) return entries.slice(-limit)
  }
}

// A subagent's id as Claude Code writes it, which names its transcript file; anything else could walk out of the folder.
export const AGENT_ID_PATTERN = /^[0-9a-z]{1,64}$/

// A subagent's transcript sits beside its session's: `<dir>/<session>.jsonl` starts `<dir>/<session>/subagents/agent-<id>.jsonl`.
export const subagentPath = (sessionPath: string, agentId: string): string | null =>
  AGENT_ID_PATTERN.test(agentId)
    ? `${sessionPath.replace(/\.jsonl$/, "")}/subagents/agent-${agentId}.jsonl`
    : null

const NAME_MARK = '"type":"agent-name"'
const SEND_MARK = '"SendMessage"'

// SendMessage takes a peer's name, optionally with its ` [ref]`, or the uds address its message came from.
export const recipientOf = (to: string): string => to.trim().replace(/\s*\[[^\]]*\]$/, "")

export type Sent = { at: string | null; text: string; to: string }

const parseRecord = (line: string): Json | null => {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

// Pure: what one transcript line sent with SendMessage, each message with its recipient (as recipientOf reads it) and the line's time. A subagent's line (isSidechain) sends for that subagent, so it counts for nothing here.
export function sentIn(line: string): Sent[] {
  if (!line.includes(SEND_MARK)) return []
  const d = parseRecord(line)
  if (!d || d.type !== "assistant" || d.isSidechain === true) return []
  const content = isRecord(d.message) ? d.message.content : null
  if (!Array.isArray(content)) return []
  const at = str(d.timestamp) || null
  return content.flatMap((block): Sent[] => {
    if (!isRecord(block) || block.type !== "tool_use" || block.name !== "SendMessage") return []
    const input = isRecord(block.input) ? block.input : {}
    const to = recipientOf(str(input.to))
    return to ? [{ at, text: str(input.message).trim(), to }] : []
  })
}

// Pure: the newest name a session was given (`claude -n`, or `/rename` while it runs), from the agent-name lines Claude Code keeps appending to its transcript; null when the text holds none. Only a whole line counts.
export function lastAgentName(text: string): string | null {
  for (
    let at = text.lastIndexOf(NAME_MARK);
    at !== -1;
    at = at > 0 ? text.lastIndexOf(NAME_MARK, at - 1) : -1
  ) {
    const end = text.indexOf("\n", at)
    if (end === -1) continue
    try {
      const d: unknown = JSON.parse(text.slice(text.lastIndexOf("\n", at) + 1, end))
      if (isRecord(d) && d.type === "agent-name" && str(d.agentName).trim()) {
        return str(d.agentName).trim()
      }
    } catch {
      continue
    }
  }
  return null
}

// One subagent (an Agent tool run) or background process (a Bash run_in_background) a session started, as its row's dropdown lists it. id is the tool call's id; taskId the id Claude Code gave it once it went to the background, which its notifications and TaskStop name. A subagent that runs in the foreground is done when its result arrives; a background one when its notification says so. A process is labelled by its Bash call's description, else its command's first line, else Process; command is that first line, and job (its working directory and command) names it across restarts.
export type SessionTask = {
  command?: string
  endedAt: string | null
  id: string
  job?: string
  kind: "agent" | "process"
  label: string
  startedAt: string
  state: "done" | "failed" | "running" | "stopped"
  taskId: string | null
}

// A finished subagent stays listed this long after it ends, and a session lists at most this many, the running first.
export const TASK_KEEP_MS = 30 * 60 * 1000
export const TASK_LIMIT = 12

// A session's pickers (its AskUserQuestion calls): the ones still waiting on an answer, by tool call id, when the newest answer landed, and whether the owner interrupted the turn after it (Esc on a picker), which leaves the session at its prompt with no Stop hook to say so. A picker stays open until the turn ends, so the board reads these to clear one the owner has already answered.
export type Pickers = { answeredAt: string | null; interrupted: boolean; open: string[] }

const INTERRUPTED = "[Request interrupted by user"

// A tool call still waiting on its result: what a herdr session's card shows of the prompt it raised (herdrFeed in workers.ts), herdr having no Feed. A subagent's call is its Agent call's business, so neither is kept.
export type OpenCall = { at: string; id: string; input: unknown; name: string }

// A session keeps at most this many open calls, the newest, so calls a crash left open never pile up.
const OPEN_CALLS = 8

// What the board reads from a session's assistant lines and task bookkeeping: the newest model and effort it ran with, whether its newest reply is an API error, its open calls, its pickers, and its tasks by tool call id.
export type SessionFacts = {
  // its tool calls with no result yet, oldest first
  calls: OpenCall[]
  effort: string | null
  // its newest reply is Claude Code's API error line (isApiErrorMessage): the turn ended in an error, not a question
  failed: boolean
  // that error says the session's Claude login has expired, which only a new account or a fresh login clears
  loginExpired: boolean
  model: string | null
  pickers: Pickers
  tasks: Record<string, SessionTask>
  // when its newest user or assistant line was written, which ends a hook's stuck record an Escape left behind (stateNow in @packages/config/session-state)
  turnAt: string | null
}

export const NO_FACTS: SessionFacts = {
  calls: [],
  effort: null,
  failed: false,
  loginExpired: false,
  model: null,
  pickers: { answeredAt: null, interrupted: false, open: [] },
  tasks: {},
  turnAt: null,
}

const TASK_STATE: Record<string, SessionTask["state"]> = {
  completed: "done",
  failed: "failed",
  killed: "stopped",
  stopped: "stopped",
}

const tagOf = (text: string, tag: string): string | null =>
  new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(text)?.[1]?.trim() || null

const findTask = (tasks: Record<string, SessionTask>, key: string | null): SessionTask | null =>
  key ? (tasks[key] ?? Object.values(tasks).find((task) => task.taskId === key) ?? null) : null

const ended = (task: SessionTask, state: SessionTask["state"], at: string): SessionTask =>
  task.state === "running" ? { ...task, endedAt: at || null, state } : task

// Claude Code's words when a session's login no longer works, as its API error line or its pane shows them.
export const LOGIN_EXPIRED =
  /Login expired|Please run \/login|OAuth token (has )?expired|Invalid API key/i

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : (Array.isArray(content) ? content : [])
        .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
        .join("\n")

// Pure: one transcript line folded into what earlier lines said. A subagent's own lines (isSidechain) are its parent's business only through the Agent call and its result, so they count for nothing here.
export function factsIn(line: string, into: SessionFacts): SessionFacts {
  const d = parseRecord(line)
  if (!d || d.isSidechain === true) return into
  const at = str(d.timestamp)
  const message = isRecord(d.message) ? d.message : {}
  const content = message.content
  let { calls, effort, failed, loginExpired, model, pickers, turnAt } = into
  const tasks = { ...into.tasks }
  if ((d.type === "user" || d.type === "assistant") && at) turnAt = at
  if (d.type === "assistant") {
    failed = d.isApiErrorMessage === true
    loginExpired = failed && LOGIN_EXPIRED.test(textOf(content))
    if (str(message.model) && str(message.model) !== "<synthetic>") model = str(message.model)
    if (str(d.effort)) effort = str(d.effort)
    for (const block of Array.isArray(content) ? content : []) {
      if (!isRecord(block) || block.type !== "tool_use" || !str(block.id)) continue
      const input = isRecord(block.input) ? block.input : {}
      const id = str(block.id)
      const base = { endedAt: null, id, startedAt: at, state: "running" as const, taskId: null }
      if (block.name !== "Agent" && block.name !== "Task" && !calls.some((c) => c.id === id)) {
        calls = [...calls, { at, id, input: block.input, name: str(block.name) }].slice(-OPEN_CALLS)
      }
      if (block.name === "AskUserQuestion" && !pickers.open.includes(id)) {
        pickers = { ...pickers, interrupted: false, open: [...pickers.open, id] }
      }
      if (block.name === "Agent" || block.name === "Task") {
        const label = firstLine(str(input.description)) || str(input.subagent_type) || "Subagent"
        tasks[id] = { ...base, kind: "agent", label: clip(label, SUMMARY_LIMIT) }
      } else if (block.name === "Bash" && input.run_in_background === true) {
        const command = firstLine(str(input.command))
        const label = firstLine(str(input.description)) || command || "Process"
        const job = command ? `${str(d.cwd)}\n${command}` : undefined
        tasks[id] = {
          ...base,
          ...(command ? { command: clip(command, SUMMARY_LIMIT) } : {}),
          job,
          kind: "process",
          label: clip(label, SUMMARY_LIMIT),
        }
      } else if (block.name === "TaskStop") {
        const task = findTask(tasks, str(input.task_id) || str(input.shell_id))
        if (task) tasks[task.id] = ended(task, "stopped", at)
      }
    }
  }
  if (d.type === "user" && Array.isArray(content)) {
    const result = isRecord(d.toolUseResult) ? d.toolUseResult : {}
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") continue
      calls = calls.filter((call) => call.id !== block.tool_use_id)
      if (pickers.open.includes(str(block.tool_use_id))) {
        pickers = {
          answeredAt: at || null,
          interrupted: false,
          open: pickers.open.filter((id) => id !== block.tool_use_id),
        }
      }
      const task = tasks[str(block.tool_use_id)]
      if (!task || task.state !== "running") continue
      const taskId = str(result.backgroundTaskId) || str(result.agentId) || null
      if (block.is_error === true) tasks[task.id] = ended(task, "failed", at)
      else if (str(result.backgroundTaskId) || result.isAsync === true)
        tasks[task.id] = { ...task, taskId }
      else if (task.kind === "agent") tasks[task.id] = ended(task, "done", at)
    }
  }
  const said = Array.isArray(content)
    ? content.map((block) => (isRecord(block) && block.type === "text" ? str(block.text) : ""))
    : [str(content)]
  if (d.type === "user" && said.some((text) => text.startsWith(INTERRUPTED))) {
    pickers = { ...pickers, interrupted: true }
  }
  const notice =
    d.type === "user" && typeof content === "string"
      ? content
      : d.type === "attachment" && isRecord(d.attachment) && d.attachment.type === "queued_command"
        ? str(d.attachment.prompt)
        : ""
  if (notice.trimStart().startsWith("<task-notification>")) {
    const task =
      findTask(tasks, tagOf(notice, "tool-use-id")) ?? findTask(tasks, tagOf(notice, "task-id"))
    const state = TASK_STATE[tagOf(notice, "status") ?? ""]
    if (task && state) tasks[task.id] = ended(task, state, at)
  }
  if (d.type === "attachment" && isRecord(d.attachment) && d.attachment.type === "task_status") {
    const a = d.attachment
    const task = findTask(tasks, str(a.taskId))
    const state = TASK_STATE[str(a.status)]
    if (task && state) tasks[task.id] = ended(task, state, at)
  }
  return { calls, effort, failed, loginExpired, model, pickers, tasks, turnAt }
}

// Pure: the whole lines of text folded into what earlier text said, quickly passing lines that hold nothing these facts read.
export function factsOf(text: string, into: SessionFacts = NO_FACTS): SessionFacts {
  let facts = into
  for (const line of text.split("\n")) {
    if (
      line.includes('"type":"assistant"') ||
      line.includes('"type":"user"') ||
      line.includes('"tool_result"') ||
      line.includes("<task-notification>") ||
      line.includes(INTERRUPTED) ||
      line.includes('"task_status"')
    ) {
      facts = factsIn(line, facts)
    }
  }
  return facts
}

// Pure: a session's tasks as its row lists them, newest first, at most TASK_LIMIT: running subagents, then those that ended within TASK_KEEP_MS, and processes only while they run (an ended one is no use on the board), each job once, so a job restarted again and again is one row.
export function shownTasks(tasks: Record<string, SessionTask>, now: number): SessionTask[] {
  const rank = (task: SessionTask) => (task.state === "running" ? 0 : 1)
  const seen = new Set<string>()
  return Object.values(tasks)
    .filter((task) =>
      task.kind === "process"
        ? task.state === "running"
        : task.state === "running" ||
          now - Date.parse(task.endedAt ?? task.startedAt) <= TASK_KEEP_MS,
    )
    .toSorted((a, b) => rank(a) - rank(b) || b.startedAt.localeCompare(a.startedAt))
    .filter((task) => {
      const key = task.job ?? task.id
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, TASK_LIMIT)
}

// Pure: the tasks worth carrying to the next read: every running one, and the newest that ended, so a long session's record stays small.
const keptTasks = (tasks: Record<string, SessionTask>): Record<string, SessionTask> => {
  const all = Object.values(tasks)
  const finished = all
    .filter((task) => task.state !== "running")
    .toSorted((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))
    .slice(0, TASK_LIMIT)
  return Object.fromEntries(
    [...all.filter((task) => task.state === "running"), ...finished].map((task) => [task.id, task]),
  )
}

// What the board keeps reading from a session's transcript: its live name, its model, effort and tasks, and how far the file has been read.
export type SessionRead = SessionFacts & {
  name: string | null
  offset: number
  path: string
}

const NAME_CHUNK = 1024 * 1024
const NAME_SCAN_BYTES = 8 * 1024 * 1024
const NAME_OVERLAP = 4096

// The newest name within the last 8MB of the file, walking back from the end a megabyte at a time (each step overlapping the next so a line split by a step boundary is still whole in one of them), the facts in the last megabyte, and the offset after the file's last whole line.
async function scanBack(
  path: string,
  size: number,
): Promise<SessionFacts & { name: string | null; offset: number }> {
  const file = Bun.file(path)
  const tailStart = Math.max(0, size - NAME_CHUNK)
  const tail = completeLines(await file.slice(tailStart, size).bytes())
  let name = lastAgentName(tail.text)
  for (
    let end = tailStart;
    name === null && end > 0 && size - end < NAME_SCAN_BYTES;
    end -= NAME_CHUNK
  ) {
    const chunk = await file.slice(Math.max(0, end - NAME_CHUNK), end + NAME_OVERLAP).text()
    name = lastAgentName(chunk)
  }
  return {
    ...factsOf(tail.text),
    name,
    offset: tailStart + tail.consumed,
  }
}

// A session's live name and facts, and how far its transcript has been read for them. The first read scans back from the end; later reads take only the whole lines appended since, and keep the name they had when those hold none, so a long turn never flips it back. A gap past the scan's reach (the dashboard closed for hours while sessions ran) is scanned back over instead of read whole, and a moved or shrunk transcript is read afresh.
export async function readSession(path: string, from: SessionRead | null): Promise<SessionRead> {
  const size = Bun.file(path).size
  const known = from && from.path === path && size >= from.offset ? from : null
  if (known && size === known.offset) return known
  if (known && size - known.offset <= NAME_SCAN_BYTES) {
    const appended = await Bun.file(path).slice(known.offset, size).bytes()
    const { consumed, text } = completeLines(appended)
    const facts = factsOf(text, known)
    return {
      ...facts,
      name: lastAgentName(text) ?? known.name,
      offset: known.offset + consumed,
      path,
      tasks: keptTasks(facts.tasks),
    }
  }
  const scan = await scanBack(path, size)
  return {
    calls: scan.calls,
    effort: scan.effort ?? known?.effort ?? null,
    failed: scan.failed,
    loginExpired: scan.loginExpired,
    model: scan.model ?? known?.model ?? null,
    name: scan.name ?? known?.name ?? null,
    pickers: scan.pickers,
    offset: scan.offset,
    path,
    tasks: keptTasks({ ...known?.tasks, ...scan.tasks }),
    turnAt: scan.turnAt ?? known?.turnAt ?? null,
  }
}

export async function readTask(path: string): Promise<string | null> {
  const text = await Bun.file(path).slice(0, HEAD_BYTES).text()
  const complete = text.slice(0, text.lastIndexOf("\n") + 1)
  return taskOf(parseLines(complete))
}
