import { type ChoicePreview, choicesOf, FACTORY_SCOPE, factoryAsk } from "@packages/config/inbox"
import { roleOfName } from "@packages/config/kinds"
import { hideSecrets } from "@packages/settings"

import { type Kind, type PublicList, patterns, type Repos } from "../trace-count/kinds"

// An open Inbox item as `ask open --json` prints it, the fields a card on WhatsApp reads.
export type Card = {
  from: string
  id: string
  kind: "decision" | "draft" | "update"
  preview: {
    approve?: string
    attachments?: unknown[]
    deny?: string
    options?: { description?: string; label: string }[]
    questions?: unknown[]
    scope?: string
    text?: string
    type?: string
  }
  ref: number
  status: string
  title: string
}

// What a card that went out keeps, so a reply naming it answers the row the owner read: its id, when it went, and each row's go and label as sent.
export type Sent = { at: number; id: string; rows: { go: boolean; label: string }[] }

// The patterns a card is read with: org, the terms that keep a whole card in the Inbox, and hide, every kind no-public-leak refuses, each written as [hidden] in a card that goes.
export type Terms = { hide: RegExp[]; org: RegExp[] }

const ORG: Kind[] = ["companies", "companyName"]
const HIDE: Kind[] = [
  "archiveLinks",
  "companies",
  "emails",
  "handles",
  "linearKeys",
  "names",
  "slackIds",
]

export const termsOf = (list: PublicList, repos: Repos): Terms => {
  const all = patterns(list, repos)
  const of = (kinds: Kind[]) => all.filter(([kind]) => kinds.includes(kind)).map(([, re]) => re)
  return { hide: of(HIDE), org: of(ORG) }
}

export const HIDDEN = "[hidden]"

const wordsOf = (card: Card): string =>
  [
    card.title,
    card.preview.text ?? "",
    card.preview.approve ?? "",
    card.preview.deny ?? "",
    ...(card.preview.options ?? []).flatMap((o) => [o.label, o.description ?? ""]),
  ].join("\n")

const holds = (text: string, res: RegExp[]) =>
  res.some((re) => {
    re.lastIndex = 0
    return re.test(text)
  })

// Pure: whether a card goes to WhatsApp, door 2's allowlist, failing closed: an open single-question ask decision or an update, posted by a factory session with the factory's scope, holding no org's term; every other card stays in the Inbox.
export const goesOut = (card: Card, terms: Terms): boolean =>
  card.status === "open" &&
  roleOfName(card.from) !== "" &&
  (card.kind === "update" ? card.preview.scope === FACTORY_SCOPE : factoryAsk(card)) &&
  !holds(wordsOf(card), terms.org)

// Pure: the text with every term no-public-leak refuses and every token shape written as [hidden].
export const redact = (text: string, terms: Terms): string =>
  terms.hide.reduce((said, re) => said.replace(re, HIDDEN), hideSecrets(text, HIDDEN))

const tag = (ref: number) => `#i${ref}`

// Pure: a card as WhatsApp shows it, redacted, and the rows a reply picks from: its title, its words, a line for its files, then one numbered line per choice, or for an update that it asks nothing.
export function cardOf(card: Card, terms: Terms): { rows: Sent["rows"]; text: string } {
  const files = card.preview.attachments?.length ?? 0
  const lines = [`*${card.title}*`, card.preview.text ?? ""]
  if (files > 0)
    lines.push(`It holds ${files === 1 ? "a file" : `${files} files`}: open it in the Inbox.`)
  const rows =
    card.kind === "decision"
      ? (choicesOf(card.preview as ChoicePreview)?.rows ?? []).map((row) => ({
          go: row.go,
          label: redact(row.label, terms),
        }))
      : []
  lines.push(
    ...(rows.length
      ? rows.map((row, i) => `Reply ${i + 1} ${tag(card.ref)} to ${row.label}`)
      : [`${tag(card.ref)} is an update: it asks nothing.`]),
  )
  return { rows, text: redact(lines.filter(Boolean).join("\n"), terms) }
}

// Pure: the one line that stands for the cards kept in the Inbox, with no title or detail.
export const waitingLine = (n: number): string =>
  `${n} ${n === 1 ? "card waits" : "cards wait"} in the Inbox.`

// What a message is, read as an answer to a card: a number and a card's id in either order, a number alone, or an id alone; null for any other message, which goes to the dispatcher.
export type Reply = { number?: number; ref?: number }

export const replyOf = (text: string): Reply | null => {
  const t = text.trim()
  const both = /^(\d{1,2})\s*#i(\d{1,9})$/i.exec(t) ?? /^#i(\d{1,9})\s+(\d{1,2})$/i.exec(t)
  if (both) {
    const [a, b] = [Number(both[1]), Number(both[2])]
    return t.startsWith("#") ? { number: b, ref: a } : { number: a, ref: b }
  }
  if (/^\d{1,2}$/.test(t)) return { number: Number(t) }
  const id = /^#i(\d{1,9})$/i.exec(t)
  if (id) return { ref: Number(id[1]) }
  return null
}

// The lines a reply gets back when it answers nothing, and when it answers.
export const NO_ID =
  "That reply names no card, so it answers nothing: reply with the number and the card's id, as 1 #i12."
export const notSent = (ref: number) =>
  `${tag(ref)} is no card I sent here, so this answers nothing: answer it in the Inbox.`
export const noRow = (ref: number, rows: number) =>
  rows === 0
    ? `${tag(ref)} asks nothing, so this answers nothing.`
    : `${tag(ref)} has no choice like that, so this answers nothing: reply with 1 to ${rows} and its id.`
export const answered = (ref: number, label: string) => `Answered ${tag(ref)}: ${label}.`
export const notAnswered = (ref: number, why: string) =>
  `${tag(ref)} was not answered: ${why}. Answer it in the Inbox.`

// Pure: the Inbox answer a row picks: a go row approves, the first of several go rows by its place, a no-go row denies.
export const answerOf = (
  rows: Sent["rows"],
  index: number,
): { action: "approve" | "deny"; option?: number } => {
  const row = rows[index]!
  if (!row.go) return { action: "deny" }
  return rows.filter((r) => r.go).length > 1
    ? { action: "approve", option: index }
    : { action: "approve" }
}
