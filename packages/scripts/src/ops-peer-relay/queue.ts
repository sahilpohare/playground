// The ops-peer queue as the relay and its agent read and write it, on either machine.
import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import { isoSeconds, MAX_LINE_BYTES, type PeerLine } from "../playground/send"

// The protocol the relay and the agent speak, which the agent's first line names, so a far checkout from before it, or of another version, reads as one plain down line.
export const HELLO = { hello: "ops-peer-relay", version: 1 } as const

export type Read = { end: number; line: PeerLine }

export const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const isPeerLine = (value: unknown): value is PeerLine => {
  const row = value as Record<string, unknown> | null
  return (
    !!row &&
    typeof row === "object" &&
    ["at", "from", "id", "text", "to"].every((key) => typeof row[key] === "string" && row[key]) &&
    Buffer.byteLength(JSON.stringify(row)) <= MAX_LINE_BYTES
  )
}

// The whole peer lines past the byte offset, each with its end offset; a cut-off last line waits for its newline, and a line over MAX_LINE_BYTES or not a peer line is passed over and counted in skipped, its end still moving the offset.
export async function linesFrom(
  path: string,
  from: number,
): Promise<{ end: number; reads: Read[]; skipped: number }> {
  const file = Bun.file(path)
  const size = file.size
  if (size < from) from = 0
  if (size <= from) return { end: from, reads: [], skipped: 0 }
  const bytes = new Uint8Array(await file.slice(from, size).arrayBuffer())
  const whole = bytes.lastIndexOf(10) + 1
  const reads: Read[] = []
  let end = from
  let skipped = 0
  for (const text of new TextDecoder().decode(bytes.subarray(0, whole)).split("\n").slice(0, -1)) {
    const length = Buffer.byteLength(text)
    end += length + 1
    const line = length > MAX_LINE_BYTES ? undefined : parsed(text)
    if (isPeerLine(line)) reads.push({ end, line })
    else if (text.trim()) skipped++
  }
  return { end, reads, skipped }
}

// Appends a line another machine sent unless its id is already in the queue, stamped with relayedAt, its arrival here, which alerts-wait's backlog skip reads; its at stays the sender's.
export async function appendOnce(path: string, line: PeerLine, now = new Date()): Promise<boolean> {
  const { reads } = await linesFrom(path, 0)
  if (reads.some((read) => read.line.id === line.id)) return false
  await mkdir(dirname(path), { recursive: true })
  const { at, from, id, text, to } = line
  await appendFile(
    path,
    `${JSON.stringify({ at, from, id, relayedAt: isoSeconds(now), text, to })}\n`,
  )
  return true
}
