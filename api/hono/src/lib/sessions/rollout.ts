import { existsSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"

import { Glob } from "bun"

import { clip, toolSummary } from "@/lib/dashboard/transcript"
import {
  atOf,
  clipText,
  type EntryRow,
  isRecord,
  type Json,
  list,
  type SessionFacts,
  storable,
  str,
  stripRaw,
  TASK_LIMIT,
  type TranscriptFile,
} from "@/lib/sessions/lines"

// How a Codex rollout lands in the same tables as a Claude Code transcript: every line becomes one claude_entry row, kinded as the chat shows it, and its session_meta and turn_context lines carry its session's facts. Line shapes are Codex's at rust-v0.167.1: a RolloutLine is `{timestamp, type, payload}` (codex-rs/history/src/lib.rs), a response_item's payload a ResponseItem (codex-rs/protocol/src/models.rs).

// Codex writes `rollout-<time>-<thread>.jsonl` under sessions/YYYY/MM/DD, and may compress one to `.jsonl.zst` beside it (codex-rs/rollout/src/compression.rs).
const ROLLOUT = /^rollout-.+\.jsonl(\.zst)?$/

export const isRollout = (sessions: string, path: string): boolean =>
  !relative(sessions, path).startsWith("..") && ROLLOUT.test(basename(path))

export const isCompressed = (path: string): boolean => path.endsWith(".zst")

// Every rollout under sessions, plain and compressed; none before Codex's first session makes the folder.
export async function rolloutPaths(sessions: string): Promise<string[]> {
  if (!existsSync(sessions)) return []
  const scan = async (pattern: string) =>
    (await Array.fromAsync(new Glob(pattern).scan({ cwd: sessions, onlyFiles: true }))).map((rel) =>
      join(sessions, rel),
    )
  return [...(await scan("**/rollout-*.jsonl")), ...(await scan("**/rollout-*.jsonl.zst"))].sort()
}

// The session a rollout holds is its thread, which its session_meta line names, so a compressed or moved copy stays one session.
export const threadOf = (line: Json): string | null =>
  line.type === "session_meta" && isRecord(line.payload) ? str(line.payload.id) || null : null

// A rollout is filed as a session of its own, under the day folder it sits in.
export const rolloutFile = (sessions: string, path: string, id: string): TranscriptFile => ({
  id,
  parentId: null,
  projectDir: relative(sessions, dirname(path)),
  subagent: false,
})

type Shape = Pick<EntryRow, "kind" | "text"> & Partial<EntryRow>

const textOf = (content: unknown): string =>
  list(content)
    .map((item) => str(item.text))
    .filter(Boolean)
    .join("\n")

// A tool's output is a string, or content items whose text parts are its words.
const outputOf = (output: unknown): string => (typeof output === "string" ? output : textOf(output))

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// What a tool call asked, as its first line: a shell's command words, else the summary a Claude Code tool of the same input gets.
const askOf = (name: string, input: unknown): string => {
  if (typeof input === "string") return input.split("\n")[0] ?? ""
  if (isRecord(input) && Array.isArray(input.command)) return input.command.join(" ")
  return toolSummary(name, input)
}

function shapeOf(line: Json): Shape {
  const item = isRecord(line.payload) ? line.payload : {}
  if (line.type !== "response_item") return { kind: "meta", text: "" }
  if (item.type === "message") {
    const text = textOf(item.content)
    if (item.role === "assistant") return { kind: "assistant", text }
    // Codex sends its context (the environment, the instructions files) as user messages in tags, which are bookkeeping, not the person's words.
    if (item.role === "user" && !text.trimStart().startsWith("<")) return { kind: "human", text }
    return { kind: "meta", text }
  }
  if (item.type === "reasoning") {
    const text = textOf(item.summary)
    return { kind: text.trim() ? "thinking" : "meta", text }
  }
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    const name = str(item.name)
    const raw = item.type === "function_call" ? str(item.arguments) : str(item.input)
    return {
      kind: "tool",
      text: [askOf(name, parsed(raw)), raw].filter(Boolean).join("\n"),
      tool: name || null,
      toolUseId: str(item.call_id) || null,
    }
  }
  if (item.type === "local_shell_call") {
    const action = isRecord(item.action) ? item.action : {}
    return {
      kind: "tool",
      text: [askOf("shell", action), JSON.stringify(action)].join("\n"),
      tool: "shell",
      toolUseId: str(item.call_id) || null,
    }
  }
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    return { kind: "result", text: outputOf(item.output), toolUseId: str(item.call_id) || null }
  }
  return { kind: "meta", text: "" }
}

// A rollout line has no uuid, so its byte offset in the plain text names it: the same in a .jsonl and in its .jsonl.zst, so the two never store a line twice.
export function rolloutEntry(line: Json, seq: number): EntryRow {
  const shape = shapeOf(line)
  return {
    at: atOf(line.timestamp),
    cacheCreationTokens: null,
    cacheReadTokens: null,
    inputTokens: null,
    messageId: null,
    model: null,
    outputTokens: null,
    parentUuid: null,
    raw: stripRaw(line),
    sender: null,
    seq,
    tool: null,
    toolUseId: null,
    type: str(line.type),
    uuid: `rollout:${seq}`,
    ...shape,
    text: clipText(shape.text),
  }
}

// Folded in file order, as a transcript's facts are: session_meta gives the launch directory, branch and Codex's version, a turn_context the model in use, and the first thing the person asked is the task.
export function addRolloutFacts(facts: SessionFacts, line: Json): SessionFacts {
  const next = { ...facts }
  const item = isRecord(line.payload) ? line.payload : {}
  if (line.type === "session_meta") {
    next.cwd ??= str(item.cwd) || null
    next.entrypoint ??= "codex"
    if (str(item.cli_version)) next.version = str(item.cli_version)
    const git = isRecord(item.git) ? item.git : {}
    if (str(git.branch)) next.gitBranch = str(git.branch)
  }
  if (line.type === "turn_context" && str(item.model)) next.model = str(item.model)
  if (!facts.task) {
    const shape = shapeOf(line)
    const ask = shape.kind === "human" ? (shape.text.trim().split("\n")[0] ?? "") : ""
    if (ask) next.task = clip(storable(ask), TASK_LIMIT)
  }
  return next
}
