import { join } from "node:path"

import {
  checkSetting,
  GUARD_SETTING_KEYS,
  loginOf,
  resolveKey,
  setSetting,
  settingFields,
  settingRows,
  shownValue,
} from "@packages/settings"

import { valueOf } from "../playground/store"
import { keptMessage, wordHashes, wordKey } from "./alert-set"
import { readOwn, writeOwn } from "./habits"
import { seedAlert } from "./seed"

// confirm.json, ops-wa's alone: the one setting a guarded key waits to apply on, until the owner's yes within CONFIRM_MS (ADR 0035); a session's proposal waits there too, its id the question's own (ADR 0041)
export const confirmFile = (dir: string) => join(dir, "confirm.json")
export const CONFIRM_MS = 10 * 60_000
// lines: the ids of ops-wa's own lines about a proposal after its question, which a plain yes counts as the proposal's
type Pending = {
  at: number
  id: string
  key: string
  lines?: string[]
  proposed?: true
  value: string
}

// sent.json, the sender's chain's: each new message ops-wa sent the owner, by its id and time, the last 50, so a plain answer to a proposal can tell whether the proposal's own messages are all he got since his previous typed one (ADR 0041); an edit, a delete, a reaction and a pin add no message, so none is kept
export const sentFile = (dir: string) => join(dir, "sent.json")
export type NewMessage = { at: number; id: string }

// What the bridge knows of an owner's answer: the id of the message it quotes, and the time of his message before it
export type Answered = { quoted?: string; since?: number }

// One step at a time for every read and write of confirm.json, so two asks that land together cannot both find no confirm waiting
let chain: Promise<unknown> = Promise.resolve()
const serial = <T>(step: () => Promise<T>): Promise<T> => {
  const run = chain.then(step)
  chain = run.catch(() => {})
  return run
}

// The keys that name the channel which proves the owner, which never change through that channel (ADR 0035)
const CHANNEL_KEYS = new Set(["wa.device", "wa.owner"])

// Whether a key is one a guard reads, which waits for the owner's confirm on WhatsApp: a guard key or any ops job's jobs.<name>.
export const guarded = (key: string) => {
  const name = resolveKey(key) ?? key
  return (GUARD_SETTING_KEYS as readonly string[]).includes(name) || name.startsWith("jobs.")
}

// Whether the value's words stand in a row in the message's words, so a value the owner did not write is refused.
export const holds = (words: string[], value: string, key: Buffer) => {
  const want = wordHashes(value, key)
  if (!want.length) return false
  for (let i = 0; i + want.length <= words.length; i++)
    if (want.every((hash, k) => words[i + k] === hash)) return true
  return false
}

const quoted = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`
// A value as the owner reads it: a string as it stands, masked to its last 4 where the setting is masked, anything else as JSON.
const shown = (key: string, value: unknown) => {
  const seen = shownValue(key, value) ?? null
  return typeof seen === "string" ? seen : JSON.stringify(seen)
}

// Sets a key at the login's scope as the owner's act, as the Inbox's Approve writes it, and gives the undo: the old value's set, or a reset when the scope held none; id is the owner's message that held the value, or, for a proposal, the question his yes answered.
export function applyOwnerSetting(
  data: string,
  key: string,
  text: string,
  id: string,
  proposed = false,
) {
  const scope = loginOf(data)
  const name = resolveKey(key) ?? key
  const old = settingRows(data).find(
    (row) => row.scope === scope && (resolveKey(row.key) ?? row.key) === name,
  )
  const reason = proposed
    ? `the owner's WhatsApp yes to the question ${id} confirmed it`
    : `the owner's WhatsApp message ${id} asked for it`
  const set = setSetting(
    data,
    { key, scope, value: valueOf(text) },
    { actor: "ops-wa", author: "owner", inboxRef: null, reason },
  )
  if (!set.ok) throw new Error(set.message)
  if (set.key === "wa.alert" && set.value) seedAlert(data, String(set.value), Date.now())
  const why = `--reason ${quoted(`undo of the owner's WhatsApp ${proposed ? "yes to the question" : "message"} ${id}`)}`
  const undo = old
    ? `playground settings set ${set.key} ${quoted(JSON.stringify(old.value))} ${why}`
    : `playground settings reset ${set.key} ${why}`
  return {
    log: `ops-wa: ${set.key} set ${proposed ? "on the owner's yes to the question" : "from the owner's message"} ${id}; it was ${old ? shown(set.key, old.value) : "unset"}`,
    undo,
  }
}

export type SettingSetIo = {
  // sets the key as the owner's act, its log line and undo back
  apply: (
    key: string,
    value: string,
    id: string,
    proposed?: boolean,
  ) => { log: string; undo: string }
  dir: string
  log: (line: string) => void
  now: () => number
  // one line to the owner's WhatsApp, the id of the message it sent back
  question: (line: string) => Promise<string | undefined>
  // one line to the owner's WhatsApp
  // the ids of the messages the line went out as, where the sender gives them
  tell: (line: string) => Promise<readonly string[] | void>
}

async function applied(io: SettingSetIo, key: string, value: string, id: string, proposed = false) {
  const { log, undo } = io.apply(key, value, id, proposed)
  io.log(log)
  await io
    .tell(`set ${key} ${proposed ? "on your yes" : "from your message"}. to undo: ${undo}`)
    .catch((error: Error) => io.log(`ops-wa: the set line: ${error.message}`))
  return `set ${key} from the owner's message ${id}; to undo: ${undo}`
}

// The confirm that waits now, or undefined once it is settled or its 10 minutes have passed.
async function waiting(io: SettingSetIo) {
  const pending = await readOwn<Partial<Pending>>(confirmFile(io.dir), {})
  return pending.key && io.now() - (pending.at ?? 0) < CONFIRM_MS ? pending : undefined
}

// One line naming the confirm that waits, so a second ask is refused in words the session can act on.
const stillWaits = (open: Partial<Pending>) =>
  `the question on ${open.key} (${open.proposed ? "a session's proposal" : "the owner's own message"}) still waits for the owner's yes or no until ${new Date((open.at ?? 0) + CONFIRM_MS).toISOString().slice(11, 16)}Z, so ask again once it is settled`

const refuseChannelKey = (name: string) => {
  if (CHANNEL_KEYS.has(name))
    throw new Error(
      `${name} names the WhatsApp that proves the owner, so set ${name} on this Mac by the Inbox card or your own terminal`,
    )
}

// settings set --from-owner-msg: the owner's own kept message of that id must hold the value; a guarded key then waits for the owner's yes on WhatsApp, and any other key applies at once.
export const settingSet = (io: SettingSetIo, id: string, key: string, value: string) =>
  serial(() => askFromMessage(io, id, key, value))

async function askFromMessage(io: SettingSetIo, id: string, key: string, value: string) {
  const name = resolveKey(key) ?? key
  refuseChannelKey(name)
  const hit = await keptMessage(io.dir, id, io.now())
  if (!hit) throw new Error(`no message of the owner's in the last 24 hours has the id ${id}`)
  const secret = await wordKey(io.dir)
  if (!secret) throw new Error("ops-wa has no word key, so no message can be matched")
  if (!holds(hit.words, value, secret))
    throw new Error(`the owner's message ${id} does not hold the value`)
  if (!guarded(key)) return applied(io, key, value, id)
  const earlier = await waiting(io)
  // a session's proposal holds until the owner settles it, so the owner's own ask never replaces the question his yes may be on its way to
  if (earlier?.proposed) throw new Error(stillWaits(earlier))
  if (earlier) await io.tell(`the question on ${earlier.key} no longer waits.`)
  await io.tell(`set ${key} to ${shown(key, valueOf(value))}? yes or no`)
  await writeOwn(confirmFile(io.dir), { at: io.now(), id, key, value } satisfies Pending)
  return `${key} is a key a guard reads: asked the owner on WhatsApp to confirm, and it applies on their yes within ${CONFIRM_MS / 60_000} minutes`
}

// settings set --propose: a session's value for a guarded key, which ops-wa puts to the owner as its confirm question and applies on his yes alone, with the question's id as its reason (ADR 0041). A masked key's question would show its last 4 alone, so his yes could not vouch for the rest, and it goes to an Inbox secret ask instead.
export const settingPropose = (io: SettingSetIo, key: string, value: string) =>
  serial(() => propose(io, key, value))

async function propose(io: SettingSetIo, key: string, value: string) {
  const name = resolveKey(key) ?? key
  refuseChannelKey(name)
  if (settingFields().find((row) => row.key === name)?.field.masked)
    throw new Error(
      `${name} is masked, so the owner's question would show its last 4 alone and his yes could not vouch for the rest: ask for it with an Inbox secret ask`,
    )
  if (!guarded(key))
    throw new Error(
      `${name} is no key a guard reads, so no yes is needed: set it with playground settings set ${name} <value> --reason <why>`,
    )
  // a key the schema knows is checked now, so the owner is never asked about a value the set would refuse, and is shown the value as it would be stored; an org's jobs.<name> row is checked by the set itself
  let stored = valueOf(value)
  if (resolveKey(key)) {
    const checked = checkSetting(key, stored)
    if (!checked.ok) throw new Error(checked.message)
    stored = checked.value
  }
  const open = await waiting(io)
  if (open) throw new Error(stillWaits(open))
  const id = await io.question(`set ${name} to ${shown(name, stored)}? Reply yes or no`)
  if (!id)
    throw new Error("ops-wa sent the question but WhatsApp gave it no id, so no yes can name it")
  await writeOwn(confirmFile(io.dir), {
    at: io.now(),
    id,
    key: name,
    proposed: true,
    value,
  } satisfies Pending)
  return `asked the owner on WhatsApp to confirm ${name}; it applies on their yes within ${CONFIRM_MS / 60_000} minutes, and a no, any other typed message from the owner, or ${CONFIRM_MS / 60_000} minutes passing clears it`
}

// The owner's answers to the question: these apply, "no" drops it, and so does any other message
const YES = new Set(["1", "y", "yes", "yes do it"])
const answer = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "")

// Whether the proposal's own messages, its question and the lines about it, are all ops-wa sent the owner since his previous typed message, so a plain yes can only be answering it.
async function onlyQuestion(io: SettingSetIo, own: string[], since: number) {
  const { messages = [] } = await readOwn<{ messages?: NewMessage[] }>(sentFile(io.dir), {})
  return messages.every((sent) => sent.at <= since || own.includes(sent.id))
}

// The owner's next message after the question settles it: a yes within 10 minutes applies the waiting setting, and anything else, or a yes after 10 minutes, drops it; true when the message was a yes or a no, which goes no further, and false for any other, which goes on as before.
// A proposal's yes or no settles it only when it quotes the question or a line about it, or quotes nothing while its question and lines are all he got since his previous typed message; any other yes or no settles nothing, leaves it waiting and goes on to the dispatcher (ADR 0041).
export const confirm = (
  io: SettingSetIo,
  text: string,
  reaction?: string,
  answered: Answered = {},
) => serial(() => settle(io, text, reaction, answered))

// The owner's settings as ops-wa wires them, the socket's set and propose and the bridge's confirm, each passing every argument on, so cli.ts and the tests run one wiring
export const ownerSettings = (io: SettingSetIo) => ({
  confirm: (text: string, reaction?: string, answered?: Answered) =>
    confirm(io, text, reaction, answered),
  propose: (key: string, value: string) => settingPropose(io, key, value),
  set: (id: string, key: string, value: string) => settingSet(io, id, key, value),
})

async function settle(
  io: SettingSetIo,
  text: string,
  reaction: string | undefined,
  answered: Answered,
): Promise<boolean> {
  const pending = await readOwn<Partial<Pending>>(confirmFile(io.dir), {})
  if (!pending.key || !pending.id || pending.value === undefined) return false
  // a reaction is no typed yes, so the question still waits, and an emoji, a 👍 meant as yes included, gets one line saying so; a proposal keeps that line's ids as its own, so it is no other message to a plain yes
  if (reaction !== undefined) {
    if (reaction && io.now() - (pending.at ?? 0) < CONFIRM_MS) {
      const ids = await io
        .tell(`not set: reply yes to set ${pending.key}`)
        .catch((error: Error) => void io.log(`ops-wa: the reaction line: ${error.message}`))
      if (pending.proposed && ids?.length)
        await writeOwn(confirmFile(io.dir), {
          ...pending,
          lines: [...(pending.lines ?? []), ...ids],
        })
    }
    return false
  }
  const said = answer(text)
  const late = io.now() - (pending.at ?? 0) >= CONFIRM_MS
  if (pending.proposed && !late && (YES.has(said) || said === "no")) {
    const own = [pending.id, ...(pending.lines ?? [])]
    const plain =
      answered.quoted === undefined && (await onlyQuestion(io, own, answered.since ?? 0))
    const quotedOwn = answered.quoted !== undefined && own.includes(answered.quoted)
    if (!quotedOwn && !plain) return false
  }
  await writeOwn(confirmFile(io.dir), {})
  if (late || (!YES.has(said) && said !== "no")) return false
  if (said === "no") {
    await io
      .tell(`left ${pending.key} as it was.`)
      .catch((error: Error) => io.log(`ops-wa: the no line: ${error.message}`))
    return true
  }
  await applied(io, pending.key, pending.value, pending.id, pending.proposed).catch(
    (error: Error) =>
      io
        .tell(`did not set ${pending.key}: ${error.message}`)
        .catch(() => io.log(`ops-wa: ${pending.key} was not set: ${error.message}`)),
  )
  return true
}
