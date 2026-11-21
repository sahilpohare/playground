import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { configDirOf } from "@packages/env/data-dir"

import { opsDir } from "../ops-job/job"
import { PEER_QUEUE } from "../playground/send"
import { writeAtomic } from "../write-atomic"

export type Queued = { at: string; from?: string; job: string; text: string; to: string }

// A queue file's job, from its name alone (ops-<job>.jsonl), never from a line it holds.
export const jobOf = (file: string): string => file.slice("ops-".length, -".jsonl".length)

// A line as a session reads it, led by its queue file's job, so the line's own words never name the job that sent it.
export const tagged = (file: string, text: string): string => `[ops-${jobOf(file)}] ${text}`

// A line's words, led by its sender's name when it has one, as a playground send's has.
export const said = (entry: { from?: string; text?: string }): string =>
  `${entry.from ? `${entry.from}: ` : ""}${entry.text ?? ""}`

// The names of this machine's sessions, from Claude Code's registry ({name, sessionId} files, as scripts/hooks/role.ts reads it), an unreadable one naming none.
export async function localNames(configDir = configDirOf(process.env)): Promise<Set<string>> {
  const dir = join(configDir, "sessions")
  const names = new Set<string>()
  for (const file of await readdir(dir).catch(() => [])) {
    if (!file.endsWith(".json")) continue
    const entry = (await Bun.file(join(dir, file))
      .json()
      .catch(() => null)) as { name?: unknown } | null
    if (typeof entry?.name === "string") names.add(entry.name)
  }
  return names
}

// The outbox lines notify.sh queued since the last drain, oldest first, for Ops' sweep to send whole (a script cannot SendMessage, ADR 0010), each its job and its text's lead tag read from its queue file (`tagged`); cursor.json holds each queue's byte offset, and is rewritten only when it moved, the move relay-watch in ops-tick reads; a first run starts it at every queue's end. An ops-peer line goes out only when its to is one of this machine's sessions, the backstop for one with no alerts-wait running; every other one stays in its file, read on the other machine, and the cursor moves past it.
export async function drain(outbox: string, here?: Set<string>): Promise<Queued[]> {
  if (await Bun.file(join(outbox, "relay.py")).exists())
    throw new Error(`${outbox}/relay.py owns cursor.json here: its relay sends these lines`)
  const cursorPath = join(outbox, "cursor.json")
  const raw = await Bun.file(cursorPath)
    .text()
    .catch(() => null)
  const cursor: Record<string, number> = raw ? JSON.parse(raw) : {}
  const queues = (await readdir(outbox).catch(() => []))
    .filter((f) => /^ops-.+\.jsonl$/.test(f))
    .sort()
  const next = { ...cursor }
  const out: Queued[] = []
  for (const file of queues) {
    const bytes = new Uint8Array(await Bun.file(join(outbox, file)).arrayBuffer())
    if (raw === null) {
      next[file] = bytes.length
      continue
    }
    const from = (cursor[file] ?? 0) > bytes.length ? 0 : (cursor[file] ?? 0)
    const end = bytes.lastIndexOf(10) + 1
    if (end <= from) continue
    for (const line of new TextDecoder()
      .decode(bytes.subarray(from, end))
      .split("\n")
      .filter(Boolean)) {
      let queued: Queued
      try {
        queued = JSON.parse(line) as Queued
      } catch {
        throw new Error(`${file}: unreadable line at byte ${from}: ${line.slice(0, 120)}`)
      }
      if (file === PEER_QUEUE && !(here ??= await localNames()).has(queued.to)) continue
      out.push({ ...queued, job: jobOf(file), text: tagged(file, said(queued)) })
    }
    next[file] = end
  }
  if (raw === null || queues.some((file) => next[file] !== cursor[file]))
    await writeAtomic(cursorPath, JSON.stringify(next))
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

// The queues holding a whole line past cursor.json's offset, which the next drain would send, read without moving the cursor. Before a first drain, which starts every queue at its end, a relay that has never run: the queues holding a line stamped at or after `since`, none without it.
export async function pending(outbox: string, since?: string): Promise<string[]> {
  const raw = await Bun.file(join(outbox, "cursor.json"))
    .text()
    .catch(() => null)
  if (raw === null && !since) return []
  const cursor: Record<string, number> = raw ? JSON.parse(raw) : {}
  const waiting: string[] = []
  for (const file of (await readdir(outbox).catch(() => []))
    .filter((f) => /^ops-.+\.jsonl$/.test(f))
    .sort()) {
    const bytes = new Uint8Array(await Bun.file(join(outbox, file)).arrayBuffer())
    if (raw === null) {
      if (newerLine(new TextDecoder().decode(bytes), Date.parse(since!))) waiting.push(file)
      continue
    }
    const from = (cursor[file] ?? 0) > bytes.length ? 0 : (cursor[file] ?? 0)
    if (bytes.lastIndexOf(10) + 1 > from) waiting.push(file)
  }
  return waiting
}

// Whether a queue's whole lines hold one whose `at` is at or after `since`, an unreadable line counting as none.
const newerLine = (text: string, since: number): boolean =>
  text
    .split("\n")
    .slice(0, -1)
    .some((line) => {
      try {
        return Date.parse((JSON.parse(line) as Queued).at) >= since
      } catch {
        return false
      }
    })

if (import.meta.main)
  for (const q of await drain(join(opsDir(), "outbox"))) console.log(JSON.stringify(q))
