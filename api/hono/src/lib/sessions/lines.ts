import { basename, relative, sep } from "node:path"

import { splitAttachments } from "@/lib/dashboard/attachments"
import { clip, COMMAND_TAG, commandOf, toolSummary, typedOf } from "@/lib/dashboard/transcript"

// How a Claude Code transcript lands in the dashboard's database: every line with a uuid becomes one claude_entry row, and any line can carry a fact about its session (its name, title, cost, PRs, and where and on what it ran).

export const ENTRY_KINDS = [
  "assistant",
  "attachment",
  "human",
  "meta",
  "peer",
  "prompt",
  "result",
  "system",
  "thinking",
  "tool",
] as const

export type EntryKind = (typeof ENTRY_KINDS)[number]

export const SESSION_KINDS = ["fork", "headless", "interactive", "subagent"] as const

export type Json = Record<string, unknown>

export type EntryRow = {
  at: Date | null
  cacheCreationTokens: number | null
  cacheReadTokens: number | null
  inputTokens: number | null
  kind: EntryKind
  messageId: string | null
  model: string | null
  outputTokens: number | null
  parentUuid: string | null
  raw: Json
  sender: string | null
  seq: number
  text: string
  tool: string | null
  toolUseId: string | null
  type: string
  uuid: string
}

export type SessionFacts = {
  aiTitle: string | null
  costs: Record<string, number>
  cwd: string | null
  entrypoint: string | null
  forkParent: string | null
  gitBranch: string | null
  model: string | null
  name: string | null
  prUrls: string[]
  task: string | null
  version: string | null
}

export type SessionKind = (typeof SESSION_KINDS)[number]

export type TranscriptFile = {
  id: string
  parentId: string | null
  projectDir: string
  subagent: boolean
}

// In characters (UTF-16 code units), not bytes.
export const TEXT_LIMIT = 256 * 1024

export const TASK_LIMIT = 300

const NEWLINE = 0x0a

export const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const str = (value: unknown): string => (typeof value === "string" ? value : "")

export const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : [])

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

// Postgres refuses a NUL and a lone surrogate (half an emoji, as a cut can leave) in text and in jsonb, and one bad line would stop the importer at it.
export const storable = (text: string): string =>
  (text.includes("\u0000") ? text.replaceAll("\u0000", "\uFFFD") : text).toWellFormed()

export const clipText = (text: string): string =>
  storable(text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text)

export type Line = { seq: number; text: string }

// The complete lines in bytes read from offset base, each with the byte offset it starts at: a last line still being written waits for its newline, and consumed is how far the next read starts.
export function splitLines(bytes: Uint8Array, base: number): { consumed: number; lines: Line[] } {
  const decoder = new TextDecoder()
  const lines: Line[] = []
  let start = 0
  for (let end = bytes.indexOf(NEWLINE); end !== -1; end = bytes.indexOf(NEWLINE, start)) {
    const text = decoder.decode(bytes.subarray(start, end))
    if (text.trim()) lines.push({ seq: base + start, text })
    start = end + 1
  }
  return { consumed: start, lines }
}

export const parseJson = (text: string): Json | null => {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

// The line as stored: base64 media keeps its type and length but not its bytes, a thinking block loses its opaque signature, a Codex rollout item its opaque encrypted_content, and the toolUseResult that repeats a tool result's content is dropped.
function stripValue(value: unknown): unknown {
  if (typeof value === "string") return storable(value)
  if (Array.isArray(value)) return value.map(stripValue)
  if (!isRecord(value)) return value
  const out: Json = {}
  for (const [key, inner] of Object.entries(value)) {
    if (key === "signature" && value.type === "thinking") continue
    if (key === "encrypted_content") continue
    if (key === "data" && (value.type === "base64" || value.type === "redacted_thinking")) {
      out.omittedLength = str(inner).length
      continue
    }
    out[storable(key)] = stripValue(inner)
  }
  return out
}

export const stripRaw = (line: Json): Json => {
  const rest = { ...line }
  delete rest.toolUseResult
  return stripValue(rest) as Json
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  return list(content)
    .filter((block) => block.type === "text")
    .map((block) => str(block.text))
    .join("\n")
}

const toolText = (block: Json): string =>
  [toolSummary(str(block.name), block.input), JSON.stringify(block.input ?? {})]
    .filter(Boolean)
    .join("\n")

const attachmentText = (attachment: Json): string => {
  const content = isRecord(attachment.content) ? attachment.content : {}
  const blocking = isRecord(attachment.blockingError) ? attachment.blockingError : {}
  return (
    str(attachment.content) ||
    strings(attachment.content).join("\n") ||
    (isRecord(content.file) ? str(content.file.content) : "") ||
    str(blocking.blockingError) ||
    str(attachment.text) ||
    [str(attachment.stdout), str(attachment.stderr)].filter(Boolean).join("\n") ||
    textOf(attachment.prompt) ||
    str(attachment.snippet)
  )
}

// A stop hook's summary line says why the turn could not stop: its hooks' errors and the context they added.
const systemText = (line: Json): string =>
  str(line.content) ||
  [...strings(line.hookErrors), ...strings(line.hookAdditionalContext), str(line.stopReason)]
    .filter(Boolean)
    .join("\n") ||
  str(line.subtype)

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null

// Claude Code marks an interrupted turn with a user line of its own.
const INTERRUPTED = /^\s*\[Request interrupted by user/

// Skill-forked subagents start with the skill's body, which names its directory first.
const SKILL_BODY = /^Base directory for this skill: (\S+)/

const skillOf = (text: string): string | null => {
  const dir = SKILL_BODY.exec(text)?.[1]
  return dir ? `/${basename(dir)}` : null
}

export const atOf = (value: unknown): Date | null => {
  const at = new Date(str(value))
  return Number.isNaN(at.getTime()) ? null : at
}

type Shape = Pick<EntryRow, "kind" | "text"> & Partial<EntryRow>

function shapeOf(line: Json): Shape {
  const message = isRecord(line.message) ? line.message : {}
  const origin = isRecord(line.origin) ? line.origin : {}

  if (line.type === "user") {
    const results = list(message.content).filter((block) => block.type === "tool_result")
    if (results.length > 0) {
      const text = [textOf(message.content), ...results.map((block) => textOf(block.content))]
      return {
        kind: "result",
        text: text.filter(Boolean).join("\n"),
        toolUseId: str(results[0]?.tool_use_id) || null,
      }
    }
    const text = textOf(message.content)
    if (origin.kind === "peer") {
      return {
        kind: "peer",
        sender: str(origin.name) || str(origin.from) || null,
        text: str(origin.body) || text,
      }
    }
    // A message SendMessage'd to a subagent by the session that started it.
    if (origin.kind === "coordinator") return { kind: "peer", text }
    if (origin.kind === "human") return { kind: "human", text: typedOf(text) }
    if (origin.kind === undefined && line.isMeta !== true) {
      const command = commandOf(text)
      if (command) return { kind: "prompt", text: command }
    }
    // What a headless `claude -p` run or a subagent was launched with: no origin, not marked meta.
    const prompt =
      origin.kind === undefined &&
      line.isMeta !== true &&
      line.isCompactSummary !== true &&
      text.trim() !== "" &&
      !COMMAND_TAG.test(text) &&
      !INTERRUPTED.test(text)
    return { kind: prompt ? "prompt" : "meta", text }
  }

  if (line.type === "assistant") {
    const blocks = list(message.content)
    const tools = blocks.filter((block) => block.type === "tool_use")
    const texts = blocks.filter((block) => block.type === "text").map((block) => str(block.text))
    const usage = isRecord(message.usage) ? message.usage : {}
    const shared = {
      cacheCreationTokens: count(usage.cache_creation_input_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      inputTokens: count(usage.input_tokens),
      messageId: str(message.id) || null,
      model: str(message.model) || null,
      outputTokens: count(usage.output_tokens),
    }
    if (tools.length > 0) {
      return {
        ...shared,
        kind: "tool",
        text: [...texts, ...tools.map(toolText)].filter(Boolean).join("\n"),
        tool: str(tools[0]?.name) || null,
        toolUseId: str(tools[0]?.id) || null,
      }
    }
    const text = texts.join("\n")
    if (text.trim()) return { ...shared, kind: "assistant", text }
    // Thinking is mostly redacted to an empty block, but some carries its text.
    const thought = blocks
      .filter((block) => block.type === "thinking")
      .map((block) => str(block.thinking))
      .join("\n")
    return { ...shared, kind: thought.trim() ? "thinking" : "meta", text: thought }
  }

  if (line.type === "system") return { kind: "system", text: systemText(line) }

  if (line.type === "attachment" && isRecord(line.attachment)) {
    const attachment = line.attachment
    if (attachment.type === "queued_command") {
      const queued = isRecord(attachment.origin) ? attachment.origin : {}
      const text = textOf(attachment.prompt)
      if (queued.kind === "peer") {
        return {
          kind: "peer",
          sender: str(queued.name) || str(queued.from) || null,
          text: str(queued.body) || text,
        }
      }
      if (queued.kind === "coordinator") return { kind: "peer", text }
      if (queued.kind === "human") return { kind: "human", text: typedOf(text) }
      return { kind: "meta", text }
    }
    return { kind: "attachment", text: attachmentText(attachment) }
  }

  return { kind: "meta", text: "" }
}

// A line without a uuid (a name, a title, a cost, a PR link, bookkeeping) is no entry; its facts still count.
export function toEntry(line: Json, seq: number): EntryRow | null {
  const uuid = str(line.uuid)
  if (!uuid) return null
  const shape = shapeOf(line)
  return {
    at: atOf(line.timestamp),
    cacheCreationTokens: null,
    cacheReadTokens: null,
    inputTokens: null,
    messageId: null,
    model: null,
    outputTokens: null,
    parentUuid: str(line.parentUuid) || null,
    raw: stripRaw(line),
    sender: null,
    seq,
    tool: null,
    toolUseId: null,
    type: str(line.type),
    uuid,
    ...shape,
    text: clipText(shape.text),
  }
}

export const emptyFacts = (): SessionFacts => ({
  aiTitle: null,
  costs: {},
  cwd: null,
  entrypoint: null,
  forkParent: null,
  gitBranch: null,
  model: null,
  name: null,
  prUrls: [],
  task: null,
  version: null,
})

const TASK_KINDS = new Set<EntryKind>(["human", "peer", "prompt"])

// Lines are folded in file order: the launch directory, entrypoint and task (the first thing a person, a peer, a launch prompt or a slash command asked, or the skill a forked subagent was started with) are the first seen, everything else the latest. `-n` and /rename both write an agent-name line, so the last one is the session's name now. A cost-state line reports Claude Code's running cost total, keyed by the startTime it carries (a resumed session continues the same key), so the highest per key is the cost.
export function addFacts(facts: SessionFacts, line: Json): SessionFacts {
  const next = { ...facts }
  if (line.type === "agent-name" && str(line.agentName).trim())
    next.name = str(line.agentName).trim()
  if (line.type === "ai-title" && str(line.aiTitle).trim()) next.aiTitle = str(line.aiTitle).trim()
  if (line.type === "fork-context-ref" && str(line.parentSessionId)) {
    next.forkParent = str(line.parentSessionId)
  }
  if (line.type === "pr-link" && str(line.prUrl) && !facts.prUrls.includes(str(line.prUrl))) {
    next.prUrls = [...facts.prUrls, str(line.prUrl)]
  }
  if (
    line.type === "cost-state" &&
    typeof line.startTime === "number" &&
    typeof line.totalCostUSD === "number"
  ) {
    const start = String(line.startTime)
    next.costs = { ...facts.costs, [start]: Math.max(facts.costs[start] ?? 0, line.totalCostUSD) }
  }
  if (line.type === "assistant" && isRecord(line.message)) {
    const model = str(line.message.model)
    if (model && !model.startsWith("<")) next.model = model
  }
  if (!facts.task && str(line.uuid)) {
    const shape = shapeOf(line)
    // A person's message the dashboard sent with files is asked by its words alone, so a message of files alone sets no task.
    const words = shape.kind === "human" ? splitAttachments(shape.text.trim()).text : shape.text
    const ask = TASK_KINDS.has(shape.kind)
      ? (words.trim().split("\n")[0] ?? "")
      : line.type === "user" && shape.kind === "meta"
        ? (skillOf(shape.text.trim()) ?? "")
        : ""
    if (ask) next.task = clip(storable(ask), TASK_LIMIT)
  }
  next.cwd ??= str(line.cwd) || null
  next.entrypoint ??= str(line.entrypoint) || null
  if (str(line.gitBranch)) next.gitBranch = str(line.gitBranch)
  if (str(line.version)) next.version = str(line.version)
  return next
}

export const costOf = (costs: Record<string, number>): number | null => {
  const runs = Object.values(costs)
  return runs.length > 0 ? runs.reduce((sum, cost) => sum + cost, 0) : null
}

// `<projects>/<dir>/<id>.jsonl` is a session; `<projects>/<dir>/<id>/subagents/agent-<aid>.jsonl` is one of its subagents, stored under its agent id. Anything else under projects is not a transcript.
export function transcriptFile(projects: string, path: string): TranscriptFile | null {
  const parts = relative(projects, path).split(sep)
  const [projectDir, second, third, fourth] = parts
  if (!projectDir || projectDir.startsWith("..")) return null
  if (parts.length === 2 && second?.endsWith(".jsonl")) {
    return { id: basename(second, ".jsonl"), parentId: null, projectDir, subagent: false }
  }
  if (parts.length === 4 && second && third === "subagents" && fourth?.startsWith("agent-")) {
    if (!fourth.endsWith(".jsonl")) return null
    return {
      id: basename(fourth, ".jsonl").slice("agent-".length),
      parentId: second,
      projectDir,
      subagent: true,
    }
  }
  return null
}

export type SubagentMeta = {
  agentType: string | null
  description: string | null
  isFork: boolean
  parentAgentId: string | null
}

// A subagent's agent-<id>.meta.json says what kind of agent it was, what it was sent to do, whether it is a fork, and which subagent started it when another one did.
export const subagentMeta = (meta: unknown): SubagentMeta => {
  const fields = isRecord(meta) ? meta : {}
  return {
    agentType: str(fields.agentType) || null,
    description: str(fields.description) || null,
    isFork: fields.isFork === true,
    parentAgentId: str(fields.parentAgentId) || null,
  }
}

export const kindOf = (
  file: TranscriptFile,
  facts: SessionFacts,
  meta: SubagentMeta | null = null,
): SessionKind | null => {
  if (file.subagent) return meta?.isFork || facts.forkParent ? "fork" : "subagent"
  if (!facts.entrypoint) return null
  return facts.entrypoint.startsWith("sdk") ? "headless" : "interactive"
}

const SCRATCHPAD =
  /\/claude-\d+\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/scratchpad(?:\/|$)/

// A subagent's parent is the subagent that started it, else the session its directory sits under. A session launched from inside another session's scratchpad (a headless probe or skill trial) counts as that session's child.
export const parentOf = (
  file: TranscriptFile,
  facts: SessionFacts,
  meta: SubagentMeta | null = null,
): string | null => {
  if (file.parentId) return meta?.parentAgentId ?? file.parentId
  const launcher = SCRATCHPAD.exec(facts.cwd ?? "")?.[1] ?? null
  return launcher && launcher !== file.id ? launcher : null
}
