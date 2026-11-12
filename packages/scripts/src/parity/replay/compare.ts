// What "the same" means for each replay: each signature is a string, so runs compare by equality and a majority is a count, triage's one count per read and per refusal.

type Json = Record<string, unknown>

const parse = (line: string): Json | null => {
  try {
    const value = JSON.parse(line)
    return typeof value === "object" && value !== null ? (value as Json) : null
  } catch {
    return null
  }
}

const TARGET_KEYS = [
  "id",
  "issueId",
  "pullNumber",
  "channel_id",
  "channel",
  "user_id",
  "user",
  "assignee",
]

const toolUses = (lines: string[]) =>
  lines
    .map(parse)
    .filter((e): e is Json => e?.type === "assistant")
    .flatMap((e) => {
      const content = (e.message as Json | undefined)?.content
      return Array.isArray(content) ? (content as Json[]).filter((b) => b.type === "tool_use") : []
    })

const resultEvent = (lines: string[]): Json | undefined =>
  lines.map(parse).find((e): e is Json => e?.type === "result")

// A call that reaches a system: an MCP tool by its name, a gh command by its first two words (`Bash(gh search)`); the harness's own tools (Read, Glob, ToolSearch and the rest) and other shell commands are how a run finds its way, so they never count.
const systemCall = (name: unknown, input: unknown): string | null => {
  const command = String((input as Json | undefined)?.command ?? "").trim()
  if (String(name).startsWith("mcp__")) return String(name)
  return name === "Bash" && command.startsWith("gh ")
    ? `Bash(${command.split(/\s+/).slice(0, 2).join(" ")})`
    : null
}

// Triage: the distinct reads, A to Z, and every write dontAsk refused, with the ids it aimed at; a read's order, repeats and arguments are free, since the model issues parallel reads in any order.
export const triageSignature = (lines: string[]): string => {
  const refused = (resultEvent(lines)?.permission_denials as Json[] | undefined) ?? []
  const denied = new Set(refused.map((d) => String(d.tool_use_id)))
  const denials = refused.flatMap((d) => {
    const call = systemCall(d.tool_name, d.tool_input)
    const input = (d.tool_input as Json | undefined) ?? {}
    const targets = TARGET_KEYS.filter((k) => input[k] !== undefined).map((k) => String(input[k]))
    return call ? [[call, ...targets].join(" ")] : []
  })
  const reads = toolUses(lines)
    .filter((u) => !denied.has(String(u.id)))
    .map((u) => systemCall(u.name, u.input))
    .filter((r): r is string => r !== null)
  return JSON.stringify({ denials: denials.sort(), reads: [...new Set(reads)].sort() })
}

// The run's last message, the report a scope's own comparators sign.
export const finalText = (lines: string[]): string => String(resultEvent(lines)?.result ?? "")

// The signature more than half the runs share, or null.
export const majority = (signatures: string[]): string | null => {
  const counts = new Map<string, number>()
  for (const s of signatures) counts.set(s, (counts.get(s) ?? 0) + 1)
  return [...counts].find(([, n]) => n * 2 > signatures.length)?.[0] ?? null
}

// Triage's majority, item by item: each read and each refused write more than half the runs make, so an optional read the model takes in about half its runs leaves the side's signature alone.
export const triageMajority = (signatures: string[]): string => {
  const runs = signatures.map((s) => JSON.parse(s) as { denials: string[]; reads: string[] })
  const most = (key: "denials" | "reads") => {
    const counts = new Map<string, number>()
    for (const run of runs)
      for (const item of new Set(run[key])) counts.set(item, (counts.get(item) ?? 0) + 1)
    return [...counts]
      .filter(([, n]) => n * 2 > runs.length)
      .map(([item]) => item)
      .sort()
  }
  return JSON.stringify({ denials: most("denials"), reads: most("reads") })
}

export type Verdict = {
  after: string | null
  before: string | null
  outcome: "changed" | "noisy" | "same"
}

// Changed only when both sides have a majority and the two differ; a side with no majority is noisy, so a skill the model runs two ways never reads as a regression.
export const verdict = (
  before: string[],
  after: string[],
  majorityOf: (signatures: string[]) => string | null = majority,
): Verdict => {
  const b = majorityOf(before)
  const a = majorityOf(after)
  return {
    after: a,
    before: b,
    outcome: b === null || a === null ? "noisy" : a === b ? "same" : "changed",
  }
}
