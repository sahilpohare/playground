import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { seatOf } from "@packages/config/kinds"
import {
  parseSessionState,
  type SessionState,
  type SessionStateName,
  sessionStateDir,
  stateNow,
} from "@packages/config/session-state"

import { liveSessions, newestTurnAt, transcriptTail } from "../ops-session-resume/resume"

// The dispatcher's state as a relay of the owner's messages reads it (Slack mode's DM watch, ops-wa): whether it is mid-turn or stuck, and who holds the assistant seat it fails over to.

// How long an owner message waits for our reply, and a dispatcher's stuck or failed record stands, before the assistant hears it too.
export const WAIT_S = 180

export type Stuck = { at: string; state: string } | null

// Pure: the hand-on step both relays share, the WhatsApp bridge and the Slack DM watch, so its why reads the same on both ("no reply has gone out"): the waiting messages due for the assistant seat, any while the dispatcher reads stuck or failed, else each unanswered for WAIT_S while it is not mid-turn.
export function handOn<T>(
  waiting: T[],
  waitedS: (message: T) => number,
  blocked: Stuck,
  working: boolean,
): { due: T[]; why: string } {
  return {
    due: waiting.filter((m) => blocked !== null || (waitedS(m) >= WAIT_S && !working)),
    why: blocked
      ? `the dispatcher has read ${blocked.state} since ${blocked.at}`
      : `no reply has gone out in ${WAIT_S / 60} minutes`,
  }
}

// The session in the assistant seat, by the roster as roster.ts who assistant reads it; undefined while none holds it or the roster does not read.
export async function assistantOf(data: string): Promise<string | undefined> {
  const roster = await Bun.file(join(data, "roster.json"))
    .json()
    .catch(() => null)
  return seatOf(roster?.agents, "assistant")
}

// The session-state record of each live session under the name, with the state stateNow() reads it as, as ops-session-resume reads it, so a newer turn ends a stuck one.
async function recordsOf(name: string, data: string, configDir: string) {
  const live = await liveSessions(configDir)
  const dir = sessionStateDir(data)
  const files = new Set(await readdir(dir).catch(() => [] as string[]))
  const found: { record: SessionState; state: SessionStateName | null }[] = []
  for (const [id, session] of live) {
    if (session.name !== name || !files.has(`${id}.json`)) continue
    const record = parseSessionState(await Bun.file(join(dir, `${id}.json`)).text())
    if (record)
      found.push({
        record,
        state: stateNow(record, newestTurnAt(await transcriptTail(configDir, id))),
      })
  }
  return found
}

// The dispatcher's record when it has read stuck or failed for over 3 minutes.
export async function stuckOf(
  name: string,
  data: string,
  configDir: string,
  now: number,
): Promise<Stuck> {
  for (const { record, state } of await recordsOf(name, data, configDir))
    if ((state === "stuck" || state === "failed") && now - Date.parse(record.at) / 1000 > WAIT_S)
      return { at: record.at, state: record.state }
  return null
}

// Whether the dispatcher is mid-turn: a working record written in the last 3 minutes, since each tool call rewrites it.
export async function busyOf(
  name: string,
  data: string,
  configDir: string,
  now: number,
): Promise<boolean> {
  return (await recordsOf(name, data, configDir)).some(
    ({ record, state }) => state === "working" && now - Date.parse(record.at) / 1000 <= WAIT_S,
  )
}
