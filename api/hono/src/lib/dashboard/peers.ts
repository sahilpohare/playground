import { join } from "node:path"

import { folderName } from "@packages/config/console"

import { claudeDir } from "@/lib/sessions/paths"
import { inRecordedForm, TICKS } from "@/lib/sessions/proc-start"
import { probe } from "@/lib/system/probe"

// Claude Code keeps one registry file per live session at <config>/sessions/<pid>.json, naming the session and the socket its peers message it on. Only those .json files are read: the .key files beside them hold secrets and are never opened.
export const sessionsDir = (): string => join(claudeDir(), "sessions")

export const REGISTRY_FILE = /^\d+\.json$/

const str = (value: unknown): string => (typeof value === "string" ? value : "")

// One registry file: the pid its name gives, and its text, or null when it is there but could not be read.
export type RegistryFile = { pid: number; text: string | null }

// Every <pid>.json in the registry, read once for every reader below; null when the folder cannot be read at all, so a caller can tell an unreadable registry from an empty one. A file gone between the listing and its read belonged to a session that has just exited, so it is left out.
export async function readRegistry(dir = sessionsDir()): Promise<RegistryFile[] | null> {
  let names: string[]
  try {
    names = await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dir, onlyFiles: true }))
  } catch {
    return null
  }
  const files = await Promise.all(
    names
      .filter((name) => REGISTRY_FILE.test(name))
      .map(async (name): Promise<RegistryFile | null> => {
        const pid = Number(name.slice(0, -".json".length))
        try {
          return { pid, text: await Bun.file(join(dir, name)).text() }
        } catch (err) {
          return (err as { code?: string }).code === "ENOENT" ? null : { pid, text: null }
        }
      }),
  )
  return files.filter((file): file is RegistryFile => file !== null)
}

// Pure: one registry file's text as the address a message to it is sent to (`uds:<socket>`) and the session's name, or null when it names neither.
export function peerOf(text: string): { address: string; name: string } | null {
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof record !== "object" || record === null) return null
  const fields = record as Record<string, unknown>
  const socket = str(fields.messagingSocketPath)
  const name = str(fields.name).trim()
  return socket && name ? { address: `uds:${socket}`, name } : null
}

// Pure: every live session's peer address by the name it goes by, A to Z by address; a registry that is missing or unreadable names none.
export function socketNamesOf(files: RegistryFile[] | null): Record<string, string> {
  const peers = (files ?? []).flatMap((file) => {
    const peer = file.text === null ? null : peerOf(file.text)
    return peer ? [[peer.address, peer.name] as const] : []
  })
  return Object.fromEntries(peers.sort(([a], [b]) => a.localeCompare(b)))
}

export const socketNames = async (dir = sessionsDir()): Promise<Record<string, string>> =>
  socketNamesOf(await readRegistry(dir))

export type Registered = {
  name: string
  pid: number
  procStart?: string
  sessionId: string
  status?: string
}

// Pure: one registry file's text as the session's process, id, name and status, and when its process started (procStart) where the file gives it in one of the two shapes a start is compared in (sessions/proc-start.ts): `ps -o lstart=` under C, as macOS writes it, or clock ticks since boot, as Linux writes it. A procStart in any other shape is dropped, so a change to how Claude writes it leaves the session id to decide rather than reading every session as ended. null when it lacks a pid or an id.
export function registeredOf(text: string): Registered | null {
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof record !== "object" || record === null) return null
  const fields = record as Record<string, unknown>
  const pid = fields.pid
  const sessionId = str(fields.sessionId)
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || !sessionId) return null
  const procStart = startOf(str(fields.procStart))
  const status = str(fields.status)
  return {
    name:
      str(fields.name).trim() || folderName(str(fields.cwd)) || `session ${sessionId.slice(0, 8)}`,
    pid,
    ...(LSTART.test(procStart) || TICKS.test(procStart) ? { procStart } : {}),
    sessionId,
    ...(status ? { status } : {}),
  }
}

// Pure: every live session's claude process, as its registry file names it, by pid; a registry that is missing or unreadable names none.
export const registeredSessionsOf = (files: RegistryFile[] | null): Registered[] =>
  (files ?? [])
    .flatMap((file) => {
      const session = file.text === null ? null : registeredOf(file.text)
      return session ? [session] : []
    })
    .sort((a, b) => a.pid - b.pid)

export const registeredSessions = async (dir = sessionsDir()): Promise<Registered[]> =>
  registeredSessionsOf(await readRegistry(dir))

// What the registry says of each pid it has a file for: the session that file names and when its process started, or null when the file is there but does not read whole. Claude rewrites the file in place, so a read can land mid-write; such a pid is unknown rather than ended. The map is null when the registry cannot be read at all.
export type Registry = Map<number, { procStart: string | null; sessionId: string } | null> | null

// Pure: the registry as each pid's entry.
export function registryOf(files: RegistryFile[] | null): Registry {
  if (files === null) return null
  const registry: NonNullable<Registry> = new Map()
  for (const file of files) {
    const session = file.text === null ? null : registeredOf(file.text)
    if (session) {
      registry.set(session.pid, {
        procStart: session.procStart ?? null,
        sessionId: session.sessionId,
      })
    } else if (!registry.has(file.pid)) registry.set(file.pid, null)
  }
  return registry
}

// Pure: a start time as `ps -o lstart=` prints it (`Mon Oct  5 23:37:23 2026`), its runs of spaces made one so two prints of one time compare equal.
export const startOf = (text: string): string => text.trim().replace(/\s+/g, " ")

// A start as `ps -o lstart=` prints it under C, once startOf has made its spaces one.
const LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/

// Pure: `ps -o pid=,lstart=` output as each pid's start time.
export function startsOf(out: string): Map<number, string> {
  const starts = new Map<number, string>()
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line)
    if (match) starts.set(Number(match[1]), startOf(match[2] ?? ""))
  }
  return starts
}

// When each pid's process started, as the machine says now; a pid no process holds is absent. null when ps could not be run, so a caller can fall back rather than read every pid as gone.
export async function processStarts(pids: number[]): Promise<Map<number, string> | null> {
  if (pids.length === 0) return new Map()
  return probe("starts", pids).then(startsOf, () => null)
}

// When each registered pid's process started, in the form its file records it (inRecordedForm in sessions/proc-start.ts); null when ps could not be run.
export async function registeredStarts(
  sessions: { pid: number; procStart?: string | null }[],
): Promise<Map<number, string> | null> {
  const starts = await processStarts(sessions.map((session) => session.pid))
  return starts && inRecordedForm(starts, sessions)
}
