import { lstat, realpath } from "node:fs/promises"
import { basename, extname, join, sep } from "node:path"

import type { AnyMessageContent, proto } from "baileys"

// The one folder wa send takes a file from, beside the media folder and outside whatsapp/, so a file goes over WhatsApp only once a session has put it there (ADR 0036).
export const outboxDir = (data: string) => join(data, "wa", "outbox")

type Kind = "audio" | "document" | "image" | "video"
// Each file type wa send takes, by its extension, and the mime WhatsApp is told; a text document is read for a token shape as a body is, and any other type is refused.
const TYPES: Record<string, { kind: Kind; mimetype: string; text?: true }> = {
  csv: { kind: "document", mimetype: "text/csv", text: true },
  jpeg: { kind: "image", mimetype: "image/jpeg" },
  jpg: { kind: "image", mimetype: "image/jpeg" },
  json: { kind: "document", mimetype: "application/json", text: true },
  md: { kind: "document", mimetype: "text/markdown", text: true },
  mp4: { kind: "video", mimetype: "video/mp4" },
  ogg: { kind: "audio", mimetype: "audio/ogg; codecs=opus" },
  opus: { kind: "audio", mimetype: "audio/ogg; codecs=opus" },
  pdf: { kind: "document", mimetype: "application/pdf" },
  png: { kind: "image", mimetype: "image/png" },
  txt: { kind: "document", mimetype: "text/plain", text: true },
}
const TYPE_NAMES = Object.keys(TYPES).join(", ")

// One of our own sent messages, by the key an edit, a delete or a pin names.
export type OwnKey = { fromMe: true; id: string; remoteJid: string }
// A kept message a reply quotes: its id, its sender's chat and its words.
export type Quoted = { id: string; jid: string; text: string }

// What ops-wa sends, each shape one Baileys takes (Fits checks it): text, a quoted reply, a location, an edit or a delete of our own message, an image, a video or a document with its caption, an audio file as a voice note, which takes none, a poll of one choice, whose secret ops-wa makes itself so it can read the owner's vote, a reaction on a kept message, or a pin of our own message, or its removal.
type Fits<T extends AnyMessageContent> = T
export type Content = Fits<
  | { linkPreview: null; text: string }
  | {
      contextInfo: {
        participant: string
        quotedMessage: { conversation: string }
        stanzaId: string
      }
      linkPreview: null
      text: string
    }
  | { location: { degreesLatitude: number; degreesLongitude: number; name?: string } }
  | { edit: OwnKey; linkPreview: null; text: string }
  | { delete: OwnKey }
  | { caption?: string; image: Buffer; mimetype: string }
  | { caption?: string; mimetype: string; video: Buffer }
  | { caption?: string; document: Buffer; fileName: string; mimetype: string }
  | { audio: Buffer; mimetype: string; ptt: true }
  | { poll: { messageSecret: Uint8Array; name: string; selectableCount: 1; values: string[] } }
  | { react: { key: { fromMe: false; id: string; remoteJid: string }; text: string } }
  | { pin: OwnKey; time?: typeof PIN_SECONDS; type: proto.PinInChat.Type }
>

// A pin lasts 7 days, one of the three spans WhatsApp offers.
export const PIN_SECONDS = 604_800
// proto.PinInChat.Type's two values, written here so the build reads baileys' types alone.
const PIN_FOR_ALL = 1 as proto.PinInChat.Type
const UNPIN_FOR_ALL = 2 as proto.PinInChat.Type

// Pure: the pin of our own message in its chat for 7 days, or with off its removal.
export const pinOf = (key: OwnKey, off = false): Content =>
  off ? { pin: key, type: UNPIN_FOR_ALL } : { pin: key, time: PIN_SECONDS, type: PIN_FOR_ALL }

export type Outbound = { bytes: Buffer; kind: Kind; mimetype: string; name: string; text?: string }

// A file wa send names, read whole: refused unless its real path is a regular file in the outbox, of a type TYPES names.
export async function readOutbound(outbox: string, path: string): Promise<Outbound> {
  const type = TYPES[extname(path).slice(1).toLowerCase()]
  if (!type) throw new Error(`wa send takes a file of these types alone: ${TYPE_NAMES}`)
  const [real, root] = await Promise.all([
    realpath(path).catch(() => ""),
    realpath(outbox).catch(() => ""),
  ])
  if (!real || !root || !real.startsWith(root + sep))
    throw new Error(`wa send takes a file from ${outbox} alone`)
  if (!(await lstat(real)).isFile()) throw new Error("wa send takes a regular file alone")
  const bytes = Buffer.from(await Bun.file(real).arrayBuffer())
  const name = basename(real)
  const { kind, mimetype } = type
  return { bytes, kind, mimetype, name, ...(type.text && { text: bytes.toString("utf8") }) }
}

// What a send carries beside its body, one at most, a quote beside text alone: a file from the outbox, a location, a kept message it quotes, an edit or a delete of one of our own messages, each by its id, or the mark that it is the live status (bridge.ts).
export type Extra = {
  delete?: string
  edit?: string
  file?: string
  location?: { lat: number; lon: number }
  quote?: string
  status?: true
}

// Pure: why a send's extra cannot go with its body, or undefined.
export const extraRefusal = (extra: Extra, body: string): string | undefined => {
  const { delete: gone, edit, file, location, quote, status } = extra
  if (status && (gone ?? edit ?? file ?? location ?? quote) !== undefined)
    return "a status is text alone"
  if (status && !body.trim()) return "a status takes a body"
  if ([gone, edit, file, location].filter((x) => x !== undefined).length > 1)
    return "a send takes one of a file, a location, an edit and a delete"
  if (quote !== undefined && (gone ?? edit ?? file ?? location) !== undefined)
    return "a quoted reply is text alone"
  if (gone !== undefined && body.trim()) return "a delete takes no body"
  if ((edit !== undefined || quote !== undefined) && !body.trim())
    return "an edit or a quoted reply takes a body"
  if (location && !(Math.abs(location.lat) <= 90 && Math.abs(location.lon) <= 180))
    return "a location takes a latitude from -90 to 90 and a longitude from -180 to 180"
}

// What messagesOf builds beside the body's parts, each resolved by the sender.
export type Shape = {
  delete?: OwnKey
  edit?: OwnKey
  file?: Outbound
  location?: { lat: number; lon: number }
  quote?: Quoted
}

// The messages one send is, in order: a delete alone; an edit, the whole body its new text; a location, the body its name; else the body's parts as text, the first quoting a kept message when the send names one; a file with a caption goes first, carrying the body's first part as it, and the rest follow as text; a voice note takes no caption, so the body goes before it as text.
export const messagesOf = (parts: string[], shape: Shape = {}): Content[] => {
  const words = parts.filter(Boolean)
  if (shape.delete) return [{ delete: shape.delete }]
  if (shape.edit) return [{ edit: shape.edit, linkPreview: null, text: words.join("\n\n") }]
  if (shape.location) {
    const { lat, lon } = shape.location
    const name = words.join("\n\n")
    return [{ location: { degreesLatitude: lat, degreesLongitude: lon, ...(name && { name }) } }]
  }
  const text = words.map((part): Content => ({ linkPreview: null, text: part }))
  const { file, quote } = shape
  if (quote && text[0])
    text[0] = {
      contextInfo: {
        participant: quote.jid,
        quotedMessage: { conversation: quote.text },
        stanzaId: quote.id,
      },
      linkPreview: null,
      text: words[0]!,
    }
  if (!file) return text
  const { bytes, mimetype } = file
  if (file.kind === "audio") return [...text, { audio: bytes, mimetype, ptt: true }]
  const caption = parts.find(Boolean)
  const media: Content =
    file.kind === "image"
      ? { caption, image: bytes, mimetype }
      : file.kind === "video"
        ? { caption, mimetype, video: bytes }
        : { caption, document: bytes, fileName: file.name, mimetype }
  return [media, ...text.slice(caption === undefined ? 0 : 1)]
}
