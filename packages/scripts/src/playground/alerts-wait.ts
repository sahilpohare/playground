// playground alerts-wait <name>: a session's background wait on the outbox, so it wakes within a second or two rather than after the relay's own turn (74s measured on 26 Oct, against the owner's 30s). It reads every job queue in the outbox (ops-<job>.jsonl, where notify.sh and each job queue their lines, a session's own hook its stuck alerts and ops-tick's relay watch its late-stop line), the stuck alerts first, from byte cursors of its own per name, prints the first new line addressed to the name, led by its queue's `[ops-<job>]` tag as the drain's is, and exits; Ops' drain still sends every line from its own cursor.json, as the backstop. It keeps its pid in alerts-wait/<name>.pid while it waits, so stuck-alert can tell a manager with no waiter from one with.
import { mkdir, readdir, unlink } from "node:fs/promises"
import { join } from "node:path"

import { said, tagged } from "../ops-outbox/drain"
import { ALERT_JOB, WAITER_GRACE_MS, waiterPidPath } from "../stuck-alert"

const ALERTS = `ops-${ALERT_JOB}.jsonl`

// The queues in the outbox, the stuck alerts first, since a prompt times out in 120s.
const queues = async (outbox: string): Promise<string[]> =>
  (await readdir(outbox).catch(() => []))
    .filter((f) => /^ops-.+\.jsonl$/.test(f))
    .sort((a, b) => Number(b === ALERTS) - Number(a === ALERTS) || a.localeCompare(b))

// alerts-wait/<name> holds a byte offset per queue, each queue the outbox held when it was written, so a queue it does not name was made since and is read from its start; a bare number, from when the waiter read the stuck alerts alone, is that queue's offset, and the other queues start at their end, as every queue does on a first wait.
const readCursor = async (
  path: string,
): Promise<{ at: Record<string, number>; whole: boolean }> => {
  const raw = await Bun.file(path)
    .text()
    .catch(() => undefined)
  if (raw === undefined) return { at: {}, whole: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim() || "0")
  } catch {}
  if (typeof parsed === "number") return { at: { [ALERTS]: parsed }, whole: false }
  // a cursor that does not read as offsets (cut off, or not JSON) is none, so the wait still runs
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Object.values(parsed).every((n) => typeof n === "number")
  )
    return { at: parsed as Record<string, number>, whole: true }
  return { at: {}, whole: false }
}

// An alert queued WAITER_GRACE_MS before the wait began is past answering, since a prompt times out in 120s: a waiter started after days down skips its backlog rather than replaying it one run at a time (62 alerts on 7 Nov). A line ops-peer-relay copied in counts from its relayedAt, its arrival here, so one sent while the link was down still prints once it arrives.

export async function alertsWait(
  name: string,
  outbox: string,
  pollMs = 1000,
  began = new Date(),
): Promise<string> {
  const cursorPath = join(outbox, "alerts-wait", name)
  await mkdir(join(outbox, "alerts-wait"), { recursive: true })
  await Bun.write(waiterPidPath(outbox, name), String(process.pid))
  const { at, whole } = await readCursor(cursorPath)
  if (!whole)
    for (const file of await queues(outbox)) at[file] ??= Bun.file(join(outbox, file)).size
  let skipped = 0
  for (;;) {
    for (const file of await queues(outbox)) {
      const path = join(outbox, file)
      const size = Bun.file(path).size
      let from = at[file] ?? 0
      if (size < from) from = 0
      if (size <= from) continue
      const chunk = await Bun.file(path).slice(from, size).text()
      const whole = chunk.slice(0, chunk.lastIndexOf("\n") + 1)
      let offset = from
      for (const line of whole.split("\n").slice(0, -1)) {
        offset += Buffer.byteLength(line) + 1
        let entry: { at?: string; from?: string; relayedAt?: string; text?: string; to?: string }
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        if (entry.to !== name) continue
        if (began.getTime() - Date.parse(entry.relayedAt ?? entry.at ?? "") > WAITER_GRACE_MS) {
          skipped++
          continue
        }
        at[file] = offset
        await Bun.write(cursorPath, JSON.stringify(at))
        await unlink(waiterPidPath(outbox, name)).catch(() => {})
        const note = skipped
          ? `(skipped ${skipped} older alert${skipped === 1 ? "" : "s"}, queued over ${WAITER_GRACE_MS / 60_000} minutes before this wait began; the relay sent each) `
          : ""
        return tagged(file, `${note}${entry.at ?? ""} ${said(entry)}`)
      }
      at[file] = offset
      if (skipped) await Bun.write(cursorPath, JSON.stringify(at))
    }
    await Bun.sleep(pollMs)
  }
}
