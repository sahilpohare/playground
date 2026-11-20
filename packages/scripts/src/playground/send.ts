// playground send <name> <text>: one line for a session on another machine, which SendMessage does not reach. It goes to the outbox's ops-peer.jsonl, which ops-peer-relay copies to the other machine, where that session's alerts-wait prints it.
import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

export const PEER_QUEUE = "ops-peer.jsonl"

// A line past this size is refused by send and passed over by the relay, so one line never holds up a pipe or the job.
export const MAX_LINE_BYTES = 16 * 1024

// A peer line as send writes it; a copy the relay makes also carries relayedAt, its arrival, which alerts-wait's backlog skip reads in place of at.
export type PeerLine = {
  at: string
  from: string
  id: string
  relayedAt?: string
  text: string
  to: string
}

const NAME = /^[a-z0-9][a-z0-9-]*$/

export const isoSeconds = (now: Date): string => now.toISOString().replace(/\.\d{3}Z$/, "Z")

// Pure: the line for to, or why it is refused: to is a session name, the text one line that is not blank, the line within MAX_LINE_BYTES.
export const peerLine = (
  to: string,
  text: string,
  from: string,
  now: Date,
  id: string,
): PeerLine | { error: string } => {
  if (!NAME.test(to))
    return { error: `${to} is not a session name: lower-case letters, digits and hyphens` }
  const line = text.replace(/[\r\n]+/g, " ").trim()
  if (!line) return { error: "the text is blank" }
  const out = { at: isoSeconds(now), from, id, text: line, to }
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_LINE_BYTES)
    return {
      error: `the line is over ${MAX_LINE_BYTES / 1024} KB: send the path of a file that holds the text`,
    }
  return out
}

// Appends the line whole in one write, as notify.sh's lines are, so a line another writer appends at once never splits it.
export async function sendPeer(outbox: string, line: PeerLine): Promise<void> {
  await mkdir(outbox, { recursive: true })
  await appendFile(join(outbox, PEER_QUEUE), `${JSON.stringify(line)}\n`)
}
