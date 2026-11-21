import type { Card } from "./cards"

// What a draft that went out keeps, by the id of its WhatsApp message, so the owner's reply to that message answers the Inbox draft it shows: the draft's id and ref, when it went, and seen, the draft's updatedAt as it went, so a reply posts only those words.
export type DraftSent = { at: number; id: string; ref: number; seen?: string }

const tag = (ref: number) => `#i${ref}`

// Pure: an open draft as the owner's own chat shows it: its title, its words, where it goes, and the line that says how a reply answers it.
export const draftOf = (card: Card): string =>
  [
    `*${card.title}*`,
    card.preview.text ?? "",
    `It goes to ${card.preview.to ?? "its thread"}${card.preview.link ? `: ${card.preview.link}` : ""}.`,
    `Reply send to this message to post it as written, or reply to it with your own words to post those instead. ${tag(card.ref)}`,
  ]
    .filter(Boolean)
    .join("\n")

// Pure: the owner's reply to a draft's message, as the Inbox's Send takes it: "send" alone posts the draft as written, and any other words post in its place.
export const draftAnswerOf = (text: string): { text?: string } =>
  /^send[.!]?$/i.test(text.trim()) ? {} : { text: text.trim() }

// The lines a reply to a draft's message gets back.
export const draftSent = (ref: number, own: boolean) =>
  `Sent ${tag(ref)}${own ? " with your words" : " as written"}.`
export const draftAlready = (ref: number) =>
  `${tag(ref)} is already sent or settled in the Inbox, so this posts nothing.`
export const draftNotSent = (ref: number, why: string) =>
  `${tag(ref)} was not sent: ${why}. Send it in the Inbox.`
export const draftChanged = (ref: number) =>
  `${tag(ref)} changed after it came here, so this posts nothing; its new words come next.`
export const DRAFT_FILES = "it holds files, which go only from the Inbox"
