import { readdir, unlink } from "node:fs/promises"
import { join } from "node:path"

import { ownFolder, readOwn, writeOwn } from "./habits"

// An urgent alert that reached the owner first and goes to the second number at due unless handled (ADR 0034): its body, the ids of the owner's copy, which a reaction names, and the opaque source a checker reads.
export type Pending = { at: number; body: string; due: number; ids: string[]; source?: string }

// pending/, one 0600 file per alert by its send time, so a restart keeps each alert and its deadline: the sender writes a file, and the bridge's queue alone removes one.
export const pendingDir = (dir: string) => join(dir, "pending")
export const DEFAULT_DELAY_MINUTES = 3

// last-alert.json, 0600, the bridge's queue's: the last pending alert's send time, its outcome and the outcome's time, which wa status prints with no body and no number
export type Last = { at: number; outcome: string; when: number }
export const lastFile = (dir: string) => join(dir, "last-alert.json")
const keepLast = (dir: string, last: Last) => writeOwn(lastFile(dir), last)
// alert-sent.json, 0600, the sender's chain's: the same for the last alert that never went pending, a --now-both one or one that reached one number alone, its outcome kept as it went
export const alertSentFile = (dir: string) => join(dir, "alert-sent.json")
export const keepSent = (dir: string, last: Last) => writeOwn(alertSentFile(dir), last)
// a failure's reason with any run of 6 or more digits masked, so no number reaches wa status
export const masked = (reason: string) => reason.replace(/\d{6,}/g, "<number>")
export const CHECK_TIMEOUT_MS = 20_000

export async function keepPending(dir: string, pending: Pending) {
  await ownFolder(pendingDir(dir))
  await writeOwn(join(pendingDir(dir), `${pending.at}.json`), pending)
}

export async function pendingOf(dir: string): Promise<{ file: string; pending: Pending }[]> {
  const names = await readdir(pendingDir(dir)).catch(() => [] as string[])
  const all = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const file = join(pendingDir(dir), name)
        return { file, pending: await readOwn<Pending | null>(file, null) }
      }),
  )
  return all
    .filter((p): p is { file: string; pending: Pending } => p.pending !== null)
    .sort((a, b) => a.pending.at - b.pending.at)
}

// The owner's reaction on any part of a pending alert handles it; true when one was.
export async function reacted(
  dir: string,
  id: string,
  now: number,
  log: (line: string) => void,
): Promise<boolean> {
  const hit = (await pendingOf(dir)).filter(({ pending }) => pending.ids.includes(id))
  for (const { file } of hit) await unlink(file).catch(() => {})
  const latest = hit.at(-1)
  if (latest)
    await keepLast(dir, {
      at: latest.pending.at,
      outcome: "handled by the owner's reaction",
      when: now,
    }).catch((error: Error) => log(`ops-wa: the last alert's outcome: ${error.message}`))
  return hit.length > 0
}

// The checker a setting names: handled only on exit 0 within the timeout; any other code, a crash or the timeout reads as not handled, since a missed alert costs more than a second message.
export async function runCheck(
  path: string,
  source: string,
  at: number,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const child = Bun.spawn([process.execPath, path, source, new Date(at).toISOString()], {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    const code = await child.exited
    clearTimeout(timer)
    return code === 0 && child.signalCode === null
  } catch {
    return false
  }
}

export type EscalateIo = {
  // whether the alert's source was handled elsewhere, by the checker wa.alertCheck names; none set reads as not handled
  check?: (source: string, at: number) => Promise<boolean>
  dir: string
  escalate: (body: string) => Promise<string>
  log: (line: string) => void
  now: () => number
}

// One pass over the pending alerts: each one past its due is dropped once its source reads handled, else sent to the second number once, and dropped either way.
export async function escalations(io: EscalateIo) {
  for (const { file, pending } of await pendingOf(io.dir)) {
    if (pending.due > io.now()) continue
    const sent = new Date(pending.at).toISOString()
    const handled =
      pending.source !== undefined && io.check
        ? await io.check(pending.source, pending.at).catch(() => false)
        : false
    let outcome = "handled at its source"
    if (handled)
      io.log(`ops-wa: the alert of ${sent} was handled at its source, so it stays with the owner`)
    else
      outcome = await io.escalate(pending.body).then(
        (said) => {
          io.log(`ops-wa: the alert of ${sent} went to the second number: ${said}`)
          return "sent to the second number"
        },
        (error: Error) => {
          io.log(`ops-wa: the alert of ${sent} did not reach the second number: ${error.message}`)
          return `send to the second number failed: ${masked(error.message)}`
        },
      )
    await unlink(file).catch(() => {})
    // written after the unlink, so a failed write never sends the alert again
    await keepLast(io.dir, { at: pending.at, outcome, when: io.now() }).catch((error: Error) =>
      io.log(`ops-wa: the last alert's outcome: ${error.message}`),
    )
  }
}

// wa status's line for the newest alert's outcome, by its send time from either file, none before the first
export const lastLines = async (dir: string): Promise<string[]> => {
  const [settled, sent] = await Promise.all([
    readOwn<Last | null>(lastFile(dir), null),
    readOwn<Last | null>(alertSentFile(dir), null),
  ])
  const last = [settled, sent].filter((l): l is Last => l !== null).sort((a, b) => b.at - a.at)[0]
  return last
    ? [
        `last alert: the alert of ${new Date(last.at).toISOString()}, at ${new Date(last.when).toISOString()}: ${last.outcome}`,
      ]
    : []
}

// wa status's lines for the pending alerts.
export const pendingLines = async (dir: string): Promise<string[]> =>
  (await pendingOf(dir)).map(
    ({ pending }) =>
      `pending: the alert of ${new Date(pending.at).toISOString()} goes to the second number at ${new Date(pending.due).toISOString()} unless handled${pending.source ? ` (source ${pending.source})` : ""}`,
  )
