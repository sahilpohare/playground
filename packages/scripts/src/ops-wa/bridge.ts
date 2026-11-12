import { appendFile } from "node:fs/promises"
import { join } from "node:path"

import { secretIn } from "@packages/settings"

import { handOn, type Stuck } from "../ops-job/dispatcher"
import {
  answered,
  answerOf,
  type Card,
  cardOf,
  goesOut,
  NO_ID,
  noRow,
  notAnswered,
  notSent,
  type Reply,
  replyOf,
  type Sent,
  type Terms,
  waitingLine,
} from "./cards"
import { HOUR, OWNER_WINDOW_MS, ownFolder, readOwn, SEND, writeOwn } from "./habits"
import { keep } from "./media"

type Key = {
  fromMe?: boolean | null
  participant?: string | null
  remoteJid?: string | null
  remoteJidAlt?: string | null
}
export type Incoming = { key: Key; message?: Record<string, unknown> | null }
export type Upsert = { messages: Incoming[]; type: string }
export type Call = { from: string; status: string }
type Events = { call: Call[]; "messages.upsert": Upsert }
// The calls ops-wa makes on a Baileys socket, so a test hands it a fake one.
export type Sock = {
  ev: { on<K extends keyof Events>(name: K, fn: (arg: Events[K]) => void): void }
  sendMessage(jid: string, content: { linkPreview: null; text: string }): Promise<unknown>
}
export type Io = {
  // <data>/whatsapp
  dir: string
  now: () => number
  // the owner's number in E.164, the allowlist of one
  owner: string
  // a line to a session by its name, through the ops relay
  relay: (to: string, text: string) => Promise<unknown>
  sleep: (ms: number) => Promise<void>
}
// WhatsApp mode's reads, and the reply it sends while it is off, so a test hands in fakes.
export type Mode = {
  assistant: () => Promise<string | undefined>
  busy: () => Promise<boolean>
  log: (line: string) => void
  // whether WhatsApp mode is on: the bundled whatsapp extension's switch in Settings, Extensions
  on: () => Promise<boolean>
  reply: (body: string) => Promise<string>
  stuck: () => Promise<Stuck>
  // the Inbox, for its cards on WhatsApp; a bridge with none sends none
  inbox?: Inbox
  // where a photo or voice note is kept and how it is read; a bridge with none names only its kind
  media?: Media
}
export type Media = {
  // <data>/wa/media
  dir: string
  download: (m: Incoming) => Promise<Uint8Array>
  // a voice note's words, or undefined when it cannot be read on this Mac
  transcribe: (path: string) => Promise<string | undefined>
}
export type Inbox = {
  // the answer recorded through the Inbox's own route, or why not
  answer: (
    id: string,
    answer: { action: "approve" | "deny"; option?: number },
  ) => Promise<string | undefined>
  open: () => Promise<Card[]>
  // undefined while no-public-leak's list cannot be read, so no card goes out
  terms: () => Promise<Terms | undefined>
}
// Door 2: what goes back over WhatsApp is factory status alone.
export const REPLY =
  "Answer with factory status alone, no org work, secret or customer data, through playground wa send <file>."

// A number's chat id, as Baileys names a phone number's 1:1 chat.
export const jidOf = (e164: string) => `${e164.replace(/^\+/, "")}@s.whatsapp.net`

export const OFF =
  "WhatsApp mode is off, so this message goes no further. Turn it on in Playground's Settings, under Extensions."
export const UPDATE = `WhatsApp mode: send the owner an update on the factory's work now. ${REPLY}`
export const UPDATE_MS = 15 * 60_000

// Each state file has one writer: owner.json and handed.json the bridge's queue, sends.json the sender's chain, so no write drops another's.
const ownerFile = (dir: string) => join(dir, "owner.json")
const sendsFile = (dir: string) => join(dir, "sends.json")
const handedFile = (dir: string) => join(dir, "handed.json")
// cards.json, the bridge's queue's too: each card sent by its ref, and the ids the last waiting line counted
const cardsFile = (dir: string) => join(dir, "cards.json")
type Cards = { held?: string; sent?: Record<string, Sent> }
const CARD_KEEP_MS = 30 * 24 * HOUR
// bravo marks a message past its hand-on to the assistant seat, so it goes once.
type Handed = { at: number; bravo?: true; line: string }
type Watch = { handed?: Handed[]; offAt?: number; updateAt?: number }

// The kind of chat a message came from that is no 1:1 chat, which ops-wa drops.
const chatKind = (jid: string): string | undefined => {
  if (jid.endsWith("@g.us")) return "group"
  if (jid === "status@broadcast") return "status"
  if (jid.endsWith("@broadcast")) return "broadcast"
  if (jid.endsWith("@newsletter")) return "newsletter"
}

// What the dispatcher hears of a message with no text: its kind alone, never its content.
const MEDIA: Record<string, string> = {
  audioMessage: "a voice note",
  contactMessage: "a contact",
  documentMessage: "a document",
  imageMessage: "an image",
  locationMessage: "a location",
  stickerMessage: "a sticker",
  videoMessage: "a video",
}

const textOf = (message: Record<string, unknown>): string | undefined => {
  if (typeof message.conversation === "string" && message.conversation) return message.conversation
  const extended = message.extendedTextMessage as { text?: unknown } | undefined
  if (typeof extended?.text === "string" && extended.text) return extended.text
}

// One line in dropped.log: the time, the kind and the sender's last 4 digits, never the words or the whole number.
async function drop(io: Io, kind: string, from: string) {
  await ownFolder(io.dir)
  const digits = (from.split("@")[0] ?? "").split(":")[0]!.replace(/\D/g, "")
  await appendFile(
    join(io.dir, "dropped.log"),
    `${new Date(io.now()).toISOString()} ${kind} ...${digits.slice(-4)}\n`,
    { mode: 0o600 },
  )
}

async function inbound(io: Io & Mode, m: Incoming) {
  const { fromMe, participant, remoteJid, remoteJidAlt } = m.key
  if (fromMe || !remoteJid) return
  const kind = chatKind(remoteJid)
  if (kind) return drop(io, kind, participant ?? remoteJid)
  const owner = jidOf(io.owner)
  if (remoteJid !== owner && remoteJidAlt !== owner) return drop(io, "stranger", remoteJid)
  const message = m.message ?? {}
  const text = textOf(message)
  const media = Object.keys(message)
    .map((k) => MEDIA[k])
    .find(Boolean)
  if (!text && !media) return
  const at = io.now()
  await ownFolder(io.dir)
  await writeOwn(ownerFile(io.dir), { ownerAt: at })
  const watch = await readOwn<Watch>(handedFile(io.dir), {})
  if (!(await io.on())) {
    // one reply an hour at most, so a run of messages while it is off gets one answer; offAt is written first, so a failed reply waits out the hour too
    if (at - (watch.offAt ?? 0) < HOUR) return
    await writeOwn(handedFile(io.dir), { ...watch, offAt: at })
    await io.reply(OFF).catch((error: Error) => io.log(`ops-wa: the off reply: ${error.message}`))
    return
  }
  const reply = io.inbox && text ? replyOf(text) : null
  if (reply && (bare(reply) ? await rowsWait(io, io.inbox!) : true))
    return answerCard(io, io.inbox!, reply)
  const when = new Date(at).toISOString()
  const line = text
    ? `The owner's WhatsApp at ${when} reads: ${text}\n${REPLY}`
    : `The owner's WhatsApp at ${when} ${(await saved(io, m, message, at)) ?? `holds ${media}, which ops-wa does not read yet: say so to the owner.`}\n${REPLY}`
  await io.relay("dispatcher", line)
  await writeOwn(handedFile(io.dir), { ...watch, handed: [...(watch.handed ?? []), { at, line }] })
}

// A photo or voice note kept in the media folder, and what the dispatcher hears of it: the path, a photo's caption, a voice note's words or that it was not transcribed; undefined for any other kind, or when it could not be kept.
async function saved(io: Io & Mode, m: Incoming, message: Record<string, unknown>, at: number) {
  const kind = message.imageMessage ? "image" : message.audioMessage ? "audio" : undefined
  if (!io.media || !kind) return undefined
  const part = (message.imageMessage ?? message.audioMessage) as {
    caption?: unknown
    mimetype?: string
  }
  let path: string
  try {
    path = await keep(io.media.dir, at, part.mimetype, await io.media.download(m))
  } catch (error) {
    io.log(`ops-wa: a photo or voice note was not kept: ${(error as Error).message}`)
    return undefined
  }
  if (kind === "image")
    return typeof part.caption === "string" && part.caption
      ? `holds a photo, kept at ${path}, with the words: ${part.caption}`
      : `holds a photo, kept at ${path}`
  const words = await io.media.transcribe(path).catch(() => undefined)
  return words
    ? `holds a voice note, kept at ${path}, which says: ${words}`
    : `holds a voice note, not transcribed, kept at ${path}`
}

// A reply with no card id or no number is a card's only while some open card that went out waits on its rows, so the owner's "2" to the dispatcher's own question reaches the dispatcher.
const bare = (reply: Reply) => reply.ref === undefined || reply.number === undefined
async function rowsWait(io: Io & Mode, inbox: Inbox): Promise<boolean> {
  const sent = (await readOwn<Cards>(cardsFile(io.dir), {})).sent ?? {}
  const open = await inbox.open().catch(() => [])
  return open.some((card) => sent[card.ref]?.id === card.id && sent[card.ref]!.rows.length > 0)
}

// An owner's reply naming a card: it answers the card only when the card went out here and the number is one of its rows, else one line back says why it answers nothing.
async function answerCard(io: Io & Mode, inbox: Inbox, reply: Reply) {
  const say = (line: string) =>
    io.reply(line).catch((error: Error) => io.log(`ops-wa: a card reply's line: ${error.message}`))
  if (reply.ref === undefined) return say(NO_ID)
  const card = (await readOwn<Cards>(cardsFile(io.dir), {})).sent?.[reply.ref]
  if (!card) return say(notSent(reply.ref))
  const n = reply.number ?? 0
  if (n < 1 || n > card.rows.length) return say(noRow(reply.ref, card.rows.length))
  const why = await inbox
    .answer(card.id, answerOf(card.rows, n - 1))
    .catch((error: Error) => error.message)
  return say(
    why === undefined ? answered(reply.ref, card.rows[n - 1]!.label) : notAnswered(reply.ref, why),
  )
}

// The cards step of a pass: each open card on the allowlist goes out once, and the rest stand as one waiting line, sent when the cards it counts change.
async function cards(io: Io & Mode, inbox: Inbox) {
  const now = io.now()
  const state = await readOwn<Cards>(cardsFile(io.dir), {})
  const sent = Object.fromEntries(
    Object.entries(state.sent ?? {}).filter(([, s]) => now - s.at < CARD_KEEP_MS),
  )
  let held = state.held
  try {
    const [open, terms] = await Promise.all([inbox.open(), inbox.terms()])
    const kept: string[] = []
    for (const card of open) {
      if (!terms || !goesOut(card, terms)) kept.push(card.id)
      else if (!sent[card.ref]) {
        const { rows, text } = cardOf(card, terms)
        await io.reply(text)
        sent[card.ref] = { at: io.now(), id: card.id, rows }
      }
    }
    const key = kept.sort().join(",")
    if (kept.length > 0 && key !== held) await io.reply(waitingLine(kept.length))
    held = key
  } finally {
    await writeOwn(cardsFile(io.dir), { held, sent })
  }
}

// One pass while WhatsApp mode is on: the failover to the assistant seat (handOn), the 15-minute update and the Inbox's cards, the last two only while the owner has written in the last 24 hours, since ops-wa never starts a chat.
async function pass(io: Io & Mode) {
  const now = io.now()
  const watch = await readOwn<Watch>(handedFile(io.dir), {})
  const handed = (watch.handed ?? []).filter((h) => now - h.at < HOUR)
  // the file is written however the pass ends, so a relay that throws keeps the marks of those sent before it
  try {
    if (await io.on()) {
      const sends = (await readOwn<{ sends?: number[] }>(sendsFile(io.dir), {})).sends ?? []
      const waiting = handed.filter((h) => !h.bravo && !sends.some((at) => at >= h.at))
      const blocked = waiting.length > 0 ? await io.stuck() : null
      const working = !blocked && waiting.length > 0 && (await io.busy())
      const { due, why } = handOn(waiting, (h) => (now - h.at) / 1000, blocked, working)
      const to = due.length > 0 ? await io.assistant() : undefined
      for (const h of due) {
        if (!to) {
          io.log(
            `ops-wa: no live session holds the assistant seat, so the owner's WhatsApp at ${new Date(h.at).toISOString()} stays with the dispatcher alone`,
          )
        } else await io.relay(to, `Handed on since ${why}. ${h.line}`)
        h.bravo = true
      }
      const { ownerAt } = await readOwn<{ ownerAt?: number }>(ownerFile(io.dir), {})
      if (
        ownerAt !== undefined &&
        now - ownerAt <= OWNER_WINDOW_MS &&
        now - Math.max(watch.updateAt ?? 0, ownerAt) >= UPDATE_MS
      ) {
        await io.relay("dispatcher", UPDATE)
        watch.updateAt = now
      }
      if (io.inbox && ownerAt !== undefined && now - ownerAt <= OWNER_WINDOW_MS)
        await cards(io, io.inbox).catch((error: Error) =>
          io.log(`ops-wa: the Inbox's cards: ${error.message}`),
        )
    }
  } finally {
    await ownFolder(io.dir)
    await writeOwn(handedFile(io.dir), { ...watch, handed })
  }
}

// One bridge per process, so one queue writes its state files across every reconnect and handles the owner's messages in the order they came.
export function bridge(io: Io & Mode) {
  let chain = Promise.resolve()
  const queue = (job: () => Promise<unknown>) => {
    chain = chain.then(job).then(
      () => {},
      (error: Error) => io.log(`ops-wa: a message was not handed on: ${error.message}`),
    )
  }
  return {
    attach: (sock: Sock) => {
      sock.ev.on("messages.upsert", ({ messages, type }) => {
        if (type !== "notify") return
        for (const m of messages) queue(() => inbound(io, m))
      })
      sock.ev.on("call", (calls) => {
        for (const c of calls) if (c.status === "offer") queue(() => drop(io, "call", c.from))
      })
    },
    idle: () => chain,
    pass: () => queue(() => pass(io)),
  }
}

// Markdown as WhatsApp marks it: headings and bold as *bold*, __x__ as _x_, a link as its text and URL; a fenced block stays as it is.
export const toWhatsApp = (md: string): string =>
  md
    .split(/(```[\s\S]*?```)/)
    .map((piece, i) =>
      i % 2 === 1
        ? piece
        : piece
            .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
            .replace(/\*\*(.+?)\*\*/g, "*$1*")
            .replace(/__(.+?)__/g, "_$1_")
            .replace(/\[([^\]]+)\]\((\S+?)\)/g, "$1 ($2)"),
    )
    .join("")

// A body in parts of at most SEND.partChars, split between paragraphs where it can.
const split = (text: string): string[] => {
  const parts: string[] = []
  for (const para of text.split("\n\n")) {
    const last = parts.at(-1)
    if (last !== undefined && last.length + 2 + para.length <= SEND.partChars)
      parts[parts.length - 1] = `${last}\n\n${para}`
    else
      for (let i = 0; i < Math.max(1, para.length); i += SEND.partChars)
        parts.push(para.slice(i, i + SEND.partChars))
  }
  return parts
}

// Why a body never goes out: a token shape, door 2's last line, behind the cards' redactor (cards.ts).
export const refusalOf = (body: string): string | undefined => {
  const secret = secretIn(body)
  if (secret) return `the body holds ${secret}, which never goes over WhatsApp`
}

// The one send path: to the owner's number alone, paced by habits.ts's SEND, and only within 24 hours of the owner's last message, since ops-wa never starts a chat.
export function sender(io: Omit<Io, "relay"> & { sock: Sock }) {
  let chain: Promise<unknown> = Promise.resolve()
  let last = 0
  const sendNow = async (body: string): Promise<string> => {
    const refusal = refusalOf(body)
    if (refusal) throw new Error(refusal)
    const { ownerAt } = await readOwn<{ ownerAt?: number }>(ownerFile(io.dir), {})
    const now = io.now()
    if (ownerAt === undefined || now - ownerAt > OWNER_WINDOW_MS)
      throw new Error(
        "the owner has not written in the last 24 hours, and ops-wa never starts a chat",
      )
    const parts = split(toWhatsApp(body))
    const kept = await readOwn<{ sends?: number[] }>(sendsFile(io.dir), {})
    const sends = (kept.sends ?? []).filter((at) => now - at < HOUR)
    if (sends.length + parts.length > SEND.perHour) {
      const frees = new Date(Math.min(...sends, now) + HOUR).toISOString().slice(11, 16)
      throw new Error(`the hourly cap of ${SEND.perHour} sends is reached until ${frees}Z`)
    }
    for (const [k, part] of parts.entries()) {
      const wait = last + (k === 0 ? SEND.gapMs : SEND.partGapMs) - io.now()
      if (last > 0 && wait > 0) await io.sleep(wait)
      await io.sock.sendMessage(jidOf(io.owner), { linkPreview: null, text: part })
      last = io.now()
      sends.push(last)
      await writeOwn(sendsFile(io.dir), { sends })
    }
    return "sent"
  }
  return (body: string): Promise<string> => {
    const run = chain.then(() => sendNow(body))
    chain = run.catch(() => {})
    return run
  }
}
