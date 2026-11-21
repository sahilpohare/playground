import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { configDirOf, dataDirOf } from "../../../../../packages/env/src/data-dir"
import {
  assistantOf,
  busyOf,
  handOn,
  type Stuck,
  stuckOf,
} from "../../../../../packages/scripts/src/ops-job/dispatcher"
import { sendAs } from "../../../../../packages/scripts/src/ops-job/job"
import { writeAtomic } from "../../../../../packages/scripts/src/write-atomic"
import { readPolicy, slackSettings } from "../../../../../packages/settings/src"
import { history, ownerMessages, PLAYGROUND, readSent, type Slack, slackOf, tokenOf } from "./slack"

const STATE = "dm-watch.json"
// How far back each pass reads; a first pass hands on only the last 2 minutes, so a new install replays no history.
const WINDOW_S = 3600
const FIRST_S = 120

// bravo marks a message past its hand-on, sent to the assistant seat or logged as kept with the dispatcher, so neither happens twice; the name is kept from when the second dispatcher was the backup, so a file written before reads the same.
type Handed = { at: number; bravo?: true; text: string; ts: string }
type State = { handed: Handed[]; stuckTold?: string }
type Io = {
  assistant: () => Promise<string | undefined>
  busy: () => Promise<boolean>
  channel: string
  dir: string
  log: (line: string) => void
  now: number
  owner: string
  send: (to: string, text: string) => Promise<unknown>
  slack: Slack
  stuck: () => Promise<Stuck>
  tellOps: (text: string) => Promise<unknown>
}

const reply = "Answer through playground dm send <file>."

// One pass: each new owner message to the dispatcher in full; one with no reply (a post of ours after it, other than the lone PLAYGROUND line a mid-send repair leaves) in 3 minutes while the dispatcher is not mid-turn (busy), or any while it has read stuck or failed for 3 minutes, to the session in the assistant seat as well (else logged once as kept with the dispatcher), and Ops told of the stuck dispatcher once per record.
export async function watch(io: Io) {
  const { assistant, busy, channel, dir, log, now, owner, send, slack, stuck, tellOps } = io
  const path = join(dir, STATE)
  await mkdir(dir, { recursive: true })
  const state: State = await Bun.file(path)
    .json()
    .catch(() => ({ handed: [] }))
  const first = !(await Bun.file(path).exists())
  const oldest = now - (first ? FIRST_S : WINDOW_S)
  const read = await history(slack, { channel, limit: "200", oldest: String(oldest) })
  const known = new Set(state.handed.map((h) => h.ts))
  const sent = await readSent(dir)
  for (const m of ownerMessages(read, owner, sent)) {
    if (known.has(m.ts)) continue
    await send("dispatcher", `The owner's DM at ${m.ts} reads: ${m.text ?? ""}\n${reply}`)
    state.handed.push({ at: now, text: m.text ?? "", ts: m.ts })
  }
  const blocked = await stuck()
  const replied = (ts: string) =>
    read.some((m) => sent.has(m.ts) && m.text !== PLAYGROUND && Number(m.ts) > Number(ts))
  const waiting = state.handed.filter((h) => !h.bravo && !replied(h.ts))
  const working = !blocked && waiting.length > 0 && (await busy())
  const { due, why } = handOn(waiting, (h) => now - h.at, blocked, working)
  const to = due.length > 0 ? await assistant() : undefined
  for (const h of due) {
    h.bravo = true
    if (!to) {
      log(
        `no live session holds the assistant seat, so the owner's DM at ${h.ts} stays with the dispatcher alone`,
      )
      continue
    }
    await send(to, `The owner's DM at ${h.ts}, handed on since ${why}: ${h.text}\n${reply}`)
  }
  if (blocked && due.length > 0 && state.stuckTold !== blocked.at) {
    const after = to
      ? `go to ${to} too`
      : "have no one else to go to, since no live session holds the assistant seat"
    await tellOps(
      `dispatcher has read ${blocked.state} since ${blocked.at}, so the owner's DM messages ${after}; unstick dispatcher.`,
    )
    state.stuckTold = blocked.at
  }
  state.handed = state.handed.filter((h) => Number(h.ts) >= now - WINDOW_S)
  await writeAtomic(path, JSON.stringify(state))
}

// The owner's DM words reach the dispatcher whole and stay out of alerts.log, which names the line's length alone, as ops-wa's and Yard's lines do.
export const relay = sendAs("dm-watch", true, true)

// one pass, no retry: its errors as one plain line, which the beat's failure alert reads
const main = async () => {
  const token = await tokenOf()
  const dir = dataDirOf(process.env)
  const policy = await readPolicy(dir)
  if (policy.refusal !== undefined) throw new Error(`the settings refuse: ${policy.refusal}`)
  const channel = slackSettings.get(policy.settings, "slack.dmChannel")
  const owner = slackSettings.get(policy.settings, "slack.dmOwner")
  const now = Math.floor(Date.now() / 1000)
  await watch({
    assistant: () => assistantOf(dir),
    busy: () => busyOf("dispatcher", dir, configDirOf(process.env), now),
    channel,
    dir,
    log: (line) => console.log(line),
    now,
    owner,
    send: relay,
    slack: slackOf(token),
    stuck: () => stuckOf("dispatcher", dir, configDirOf(process.env), now),
    tellOps: (text) => sendAs("unstick", true)("ops", text),
  })
}

if (import.meta.main)
  await main().catch((error: Error) => {
    console.error(`error: ${error.message}`)
    process.exit(1)
  })
