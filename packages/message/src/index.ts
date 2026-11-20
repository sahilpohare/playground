import { z } from "zod"

// What a message is for, so an agent reads it the same way every time.
export const MESSAGE_KINDS = [
  "answer",
  "bug",
  "fix",
  "log",
  "notice",
  "question",
  "steps",
  "text",
] as const

export const MAX_TEXT = 4000

// How long a message is kept before the API's daily sweep deletes it (the owner's #i6); the web says so on an empty channel.
export const RETENTION_DAYS = 90

// A message's state: sent to the channel, or a tier-two post pending its sender's approval, or denied.
export const MESSAGE_STATUSES = ["denied", "pending", "sent"] as const

// The device a post came from: the name of the token it was made with, never the token itself, which starts yard_ and must never travel in a message, or WEB_DEVICE for a post from a signed-in browser.
const device = z
  .string()
  .min(1)
  .max(64)
  .refine((name) => !name.startsWith("yard_"), "a device name, never a token")

export const WEB_DEVICE = "web"

// Where the hosted web approves what waits on you, built in one place for every link to it: a pending message's sender sends or denies it, and the owner opens or denies an invite request.
export const approvePath = (messageId: string) => `/yard/approve/${encodeURIComponent(messageId)}`
export const invitePath = (inviteId: string) => `/yard/invites/${encodeURIComponent(inviteId)}`

// Where the hosted API's relay to the owner's own Mac sits: the hosted web's dashboard reads go to this prefix plus their own path.
export const RELAY_PREFIX = "/api/v1/yard/relay"

// The Inbox cards a relayed answer may reach, by their kind (answerKind), A to Z: each one whose poster carries out the answer. Every other kind stays on the Mac, one added later included: an Approve the Mac carries out itself on its own settings and permissions (an extension accept, an extensions clone, an apps change, a grant, a guard setting, an own account change, a root step), a delete, a secret ask, whose value goes to its sink through its own Submit alone, and a reveal card, whose value shows on the Mac's own click.
export const RELAY_ANSWER_KINDS = [
  "ask",
  "budget",
  "draft",
  "schema",
  "ship",
  "slack",
  "ticket",
  "update",
] as const

export type AnswerCard =
  | { kind: "decision"; preview: { type: string } }
  | { kind: "draft" | "update" }

// Pure: an Inbox card's kind as the relay reads it, the same on the Mac and in the hosted web: a decision's preview type, else draft or update.
export const answerKind = (card: AnswerCard): string =>
  card.kind === "decision" ? card.preview.type : card.kind

// The public half of the browser's paired key, an ECDSA P-256 key as WebCrypto exports it to JWK, kept to the four members that name it.
export const pairKeySchema = z
  .object({
    crv: z.literal("P-256"),
    kty: z.literal("EC"),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .transform(({ crv, kty, x, y }) => ({ crv, kty, x, y }))

export type PairKey = z.infer<typeof pairKeySchema>

// base64url with no padding, written out since the browser has no Buffer
export const base64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")

const sha256 = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))

// The key's id, its RFC 7638 thumbprint, and the short fingerprint the browser and the Mac both show, so the owner can see they name one key.
export async function keyIdOf(key: PairKey): Promise<{ fingerprint: string; id: string }> {
  const digest = await sha256(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }))
  const hex = [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return { fingerprint: hex.match(/.{4}/g)!.join(" "), id: base64url(digest) }
}

// The bytes a relayed write's signature covers: its id, time, login, method and path, and its body's SHA-256, in one JSON array so no field can run into the next.
export async function signedBytes(write: {
  at: string
  body: string
  id: string
  login: string
  method: string
  path: string
}): Promise<Uint8Array<ArrayBuffer>> {
  const { at, id, login, method, path } = write
  const body = base64url(await sha256(write.body))
  return new TextEncoder().encode(JSON.stringify([id, at, login, method, path, body]))
}

// A token's name, which a post made with it carries as from.device, so none may take the browser's name.
export const tokenNameSchema = device.refine(
  (name) => name !== WEB_DEVICE,
  `${WEB_DEVICE} is the browser's name, not a token's`,
)

// A GitHub login as Yard takes one for a DM or an invite, checked alike by the API and the web's forms.
export const githubLoginSchema = z
  .string()
  .trim()
  .regex(/^[a-z\d](?:[a-z\d-]{0,38})$/i, "a GitHub login")

// A bot's name, which also names its Keychain item (playground-yard-bot-<name>), so it keeps to that item's lowercase letters, digits and dashes.
export const botNameSchema = z
  .string()
  .regex(/^[a-z\d][a-z\d-]{0,29}$/, "lowercase letters, digits and dashes, 1 to 30")

// A bot's login, <name>[bot]: no GitHub login holds a bracket, so no GitHub sign-in can claim it, and githubLoginSchema refuses it, so no invite or new DM can name it.
export const botLogin = (name: string) => `${name}[bot]`
export const isBotLogin = (login: string) => login.endsWith("[bot]")

// An invite code as a newcomer types it, the one shape the redeem route takes.
export const inviteCodeSchema = z.string().trim().min(1, "the invite code").max(64)

// One message as the server stores and sends it: the server stamps from and at; channel is the channel's id, parent the message a reply answers, and a message with no status is sent.
export const messageSchema = z.object({
  at: z.iso.datetime(),
  channel: z.string().min(1),
  from: z.object({ device, login: z.string().min(1).max(39) }),
  id: z.string().min(1),
  kind: z.enum(MESSAGE_KINDS),
  links: z
    .array(z.url({ protocol: /^https?$/ }).max(2000))
    .max(10)
    .optional(),
  parent: z.string().min(1).optional(),
  status: z.enum(MESSAGE_STATUSES).optional(),
  text: z.string().min(1).max(MAX_TEXT),
})

export type Message = z.infer<typeof messageSchema>

// One channel or DM as a member sees it: a DM is named dm:<user id>:<user id> and shows as its peer, the other member; unread and mentions count sent messages since the member last read it.
export const channelSchema = z.object({
  id: z.string().min(1),
  joined: z.boolean(),
  kind: z.enum(["channel", "dm"]),
  lastMessageAt: z.iso.datetime().nullable(),
  mentions: z.number().int().min(0),
  name: z.string().min(1),
  peer: z
    .object({ id: z.string(), image: z.string().nullable(), login: z.string(), name: z.string() })
    .nullable(),
  postRule: z.enum(["members", "owner"]),
  topic: z.string().nullable(),
  unread: z.number().int().min(0),
})

export type Channel = z.infer<typeof channelSchema>
