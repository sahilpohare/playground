import { join } from "node:path"

import type { Pull } from "@/lib/dashboard/agents"
import { dataDir } from "@/lib/sessions/paths"

// The pr:merge gates each open PR fails at its head, as the merge train last read them (packages/scripts/src/pr-merge/gates-file.ts writes it), so Ready reads pr:merge's own gates and a new gate reaches it with no second copy. A missing or unreadable file reads as no read at all, and an entry that does not read costs only itself.
export const gatesPath = (): string => join(dataDir(), "ops", "merge-train", "gates.json")

export type GateEntry = { failed: string[]; head: string }

const isEntry = (value: unknown): value is GateEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as GateEntry).head === "string" &&
  Array.isArray((value as GateEntry).failed) &&
  (value as GateEntry).failed.every((name) => typeof name === "string")

// Pure: the file's text in, each PR's read by `owner/name#number` out.
export function parseGates(raw: string): Map<string, GateEntry> {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return new Map()
  }
  const prs = typeof json === "object" && json !== null && "prs" in json ? json.prs : null
  if (typeof prs !== "object" || prs === null || Array.isArray(prs)) return new Map()
  return new Map(
    Object.entries(prs).filter((entry): entry is [string, GateEntry] => isEntry(entry[1])),
  )
}

export const readGates = (): Promise<Map<string, GateEntry>> =>
  Bun.file(gatesPath())
    .text()
    .then(parseGates, () => new Map())

const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/

// Pure: the gates an open PR fails, from the read taken at its own head; null when the read is at another head, or there is none.
export function gatesAt(gates: ReadonlyMap<string, GateEntry>, pr: Pull): string[] | null {
  const match = pr.state === "open" ? PR_URL_RE.exec(pr.url) : null
  const entry = match ? gates.get(`${match[1]}#${match[2]}`) : undefined
  return entry && pr.head && entry.head === pr.head ? entry.failed : null
}
